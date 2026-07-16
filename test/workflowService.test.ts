import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { FakeAgentProvider } from '../src/fakeProvider.js'
import type { FakeProviderScript } from '../src/fakeProvider.js'
import { FileWorkflowStore } from '../src/fileWorkflowStore.js'
import { parseWorkflowSource } from '../src/loadWorkflow.js'
import { WorkflowService, WorkflowServiceError } from '../src/workflowService.js'

async function project(source: string): Promise<{ cwd: string; storeRoot: string }> {
  const cwd = await mkdtemp(join(tmpdir(), 'workflow-project-'))
  const directory = join(cwd, '.claude', 'workflows')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'test.js'), source)
  return { cwd, storeRoot: join(cwd, 'state') }
}

async function terminal(service: WorkflowService, cwd: string, runId: string) {
  for (let index = 0; index < 200; index += 1) {
    const status = await service.status({ cwd }, runId)
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(status.status)) return status
    await new Promise((resolveWait) => setTimeout(resolveWait, 10))
  }
  throw new Error(`Run ${runId} did not become terminal`)
}

const twoPhaseSource = `export const meta = {
  name: 'two-phase', description: 'Two phase service fixture',
  phases: [{ title: 'Find' }, { title: 'Verify' }],
}
phase('Find')
await agent('find it', { label: 'finder', model: 'sonnet' })
phase('Verify')
return await agent('verify it', { label: 'verifier' })`

describe('WorkflowService', () => {
  it('requires source-hash approval before worker launch and invalidates it after an edit', async () => {
    const fixture = await project(`export const meta = { name: 'approved', description: 'Approval fixture' }
      return null`)
    const approved = new Set<string>()
    const requests: string[] = []
    const service = new WorkflowService({
      store: new FileWorkflowStore(fixture.storeRoot),
      provider: new FakeAgentProvider([]),
      authorizeWorkflowSource: (request) => {
        const key = `${request.canonicalIdentity}:${request.sourceHash}`
        requests.push(key)
        return approved.has(key)
      },
    })
    await service.initialize()

    await expect(service.start({ cwd: fixture.cwd }, { name: 'approved' })).rejects.toMatchObject({
      code: 'source-approval-required',
    })
    approved.add(requests.at(-1)!)
    const accepted = await service.start({ cwd: fixture.cwd }, { name: 'approved' })
    await terminal(service, fixture.cwd, accepted.runId)

    await writeFile(
      join(fixture.cwd, '.claude', 'workflows', 'test.js'),
      `export const meta = { name: 'approved', description: 'Approval fixture edited' }\nreturn null`,
    )
    await expect(service.start({ cwd: fixture.cwd }, { name: 'approved' })).rejects.toMatchObject({
      code: 'source-approval-required',
    })
    expect(requests.at(-1)).not.toBe(requests[1])
    await service.stop()
  })

  it('rejects an absolute external nested script target before child worker launch', async () => {
    const fixture = await project(`export const meta = { name: 'parent', description: 'Nested scope fixture' }
      return await workflow({ scriptPath: args.child })`)
    const external = join(fixture.cwd, '..', `external-child-${Date.now()}.js`)
    await writeFile(external, `export const meta = { name: 'child', description: 'External child' }\nreturn null`)
    const authorizations: string[] = []
    const service = new WorkflowService({
      store: new FileWorkflowStore(fixture.storeRoot),
      provider: new FakeAgentProvider([]),
      authorizeWorkflowSource: (request) => {
        authorizations.push(request.origin)
        return true
      },
    })
    await service.initialize()

    const run = await service.start({ cwd: fixture.cwd }, { name: 'parent', args: { child: external } })
    await expect(terminal(service, fixture.cwd, run.runId)).resolves.toMatchObject({ status: 'failed' })
    expect(authorizations).toEqual(['root'])
    await service.stop()
  })

  it('does not author inline source through a symlinked .claude directory', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'workflow-inline-symlink-'))
    const external = await mkdtemp(join(tmpdir(), 'workflow-inline-external-'))
    await mkdir(join(cwd, '.git'))
    await mkdir(join(external, 'workflows'))
    await symlink(external, join(cwd, '.claude'))
    const service = new WorkflowService({
      store: new FileWorkflowStore(join(cwd, 'state')),
      provider: new FakeAgentProvider([]),
    })
    await service.initialize()

    await expect(service.start({ cwd }, {
      script: `export const meta = { name: 'escaped', description: 'Must not write outside' }\nreturn null`,
    })).rejects.toMatchObject({ code: 'scope-forbidden' })
    await service.stop()
  })

  it('persists inline source in project .claude/workflows and returns its editable path', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'workflow-inline-project-'))
    await mkdir(join(cwd, '.git'))
    const service = new WorkflowService({
      store: new FileWorkflowStore(join(cwd, 'state')),
      provider: new FakeAgentProvider([]),
    })
    await service.initialize()

    const source = `export const meta = { name: 'inline review', description: 'Inline fixture' }
      return args`
    const run = await service.start({ cwd }, { script: source, args: { target: 'src' } })
    expect(run.scriptPath).toBe(join(cwd, '.claude', 'workflows', 'inline-review.js'))
    expect(await service.describe({ cwd }, { name: 'inline review' })).toMatchObject({
      filePath: run.scriptPath,
      source,
      location: 'project',
    })
    await expect(service.start({ cwd }, {
      script: source.replace('return args', 'return null'),
    })).rejects.toMatchObject({ code: 'invalid-request' } satisfies Partial<WorkflowServiceError>)
    await terminal(service, cwd, run.runId)
    await service.stop()
  })

  it('returns immediately, persists events, closes phases honestly, and enforces cwd scope', async () => {
    const fixture = await project(twoPhaseSource)
    const provider = new FakeAgentProvider([
      { outcome: { type: 'result', output: { type: 'text', text: 'found' } } },
      { outcome: { type: 'result', output: { type: 'text', text: 'verified' } } },
    ])
    const service = new WorkflowService({
      store: new FileWorkflowStore(fixture.storeRoot),
      provider,
      modelAliases: { sonnet: null },
    })
    await service.initialize()

    const run = await service.start({ cwd: fixture.cwd }, {
      name: 'two-phase',
      idempotencyKey: 'one',
    })
    expect(['queued', 'running']).toContain(run.status)
    await terminal(service, fixture.cwd, run.runId)

    const snapshot = await service.snapshot({ cwd: fixture.cwd }, run.runId)
    expect(snapshot.state.status).toBe('completed')
    expect(snapshot.state.phases.map((phase) => [phase.title, phase.status])).toEqual([
      ['Find', 'completed'],
      ['Verify', 'completed'],
    ])
    expect(snapshot.state.warnings).toContainEqual(expect.objectContaining({ code: 'model-alias-mapped' }))
    const phaseCompleted = (await service.readEvents(
      { cwd: fixture.cwd },
      { runId: run.runId, after: 0, limit: 1_000 },
    )).events.filter((stored) => stored.event.type === 'phase.completed')
    expect(phaseCompleted).toHaveLength(2)

    await expect(service.start(
      { cwd: fixture.cwd },
      { name: 'two-phase', idempotencyKey: 'one' },
    )).resolves.toMatchObject({ runId: run.runId })
    await expect(service.status({ cwd: join(fixture.cwd, 'other') }, run.runId)).rejects.toMatchObject({
      code: 'scope-forbidden',
    } satisfies Partial<WorkflowServiceError>)
    await service.stop()
  })

  it('coalesces concurrent starts with one idempotency key before provider execution', async () => {
    const fixture = await project(`export const meta = { name: 'once', description: 'Idempotency race' }
      return await agent('execute exactly once')`)
    const provider = new FakeAgentProvider([{
      delayMs: 20,
      outcome: { type: 'result', output: { type: 'text', text: 'once' } },
    }])
    const service = new WorkflowService({
      store: new FileWorkflowStore(fixture.storeRoot),
      provider,
    })
    await service.initialize()

    const [first, second] = await Promise.all([
      service.start({ cwd: fixture.cwd }, { name: 'once', idempotencyKey: 'same-request' }),
      service.start({ cwd: fixture.cwd }, { name: 'once', idempotencyKey: 'same-request' }),
    ])
    expect(second.runId).toBe(first.runId)
    await terminal(service, fixture.cwd, first.runId)
    expect(provider.calls).toHaveLength(1)
    await service.stop()
  })

  it('resumes a cancelled run into a linked run using the durable provider session', async () => {
    const fixture = await project(`export const meta = { name: 'resume-me', description: 'Resume fixture' }
      return await agent('continue me')`)
    const firstProvider = new FakeAgentProvider([{ outcome: { type: 'wait-for-abort' } }])
    const first = new WorkflowService({
      store: new FileWorkflowStore(fixture.storeRoot),
      provider: firstProvider,
    })
    await first.initialize()
    const original = await first.start({ cwd: fixture.cwd }, { name: 'resume-me' })
    // session.started is the durable resume boundary; agent.started alone only proves the provider
    // call was dispatched and may still lack a thread ID if the host stops immediately afterward.
    while ((await first.status({ cwd: fixture.cwd }, original.runId)).cursor < 5) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 5))
    }
    await first.stop('test restart')

    const resumedProvider = new FakeAgentProvider([{
      expect: { sessionId: 'fake-session-1' },
      outcome: { type: 'result', output: { type: 'text', text: 'resumed result' } },
    }])
    const second = new WorkflowService({
      store: new FileWorkflowStore(fixture.storeRoot),
      provider: resumedProvider,
    })
    await second.initialize()
    const resumed = await second.resume({ cwd: fixture.cwd }, { runId: original.runId })
    await terminal(second, fixture.cwd, resumed.runId)

    expect(resumed.resumedFromRunId).toBe(original.runId)
    const snapshot = await second.snapshot({ cwd: fixture.cwd }, resumed.runId)
    expect(snapshot.state.agents[0]?.attempts[0]?.source).toBe('provider-resume')
    expect(snapshot.state.agents[0]?.outcome?.result.content).toBe('resumed result')
    await second.stop()
  })

  it('coalesces different resume idempotency keys onto one live lineage successor', async () => {
    const fixture = await project(`export const meta = { name: 'one-successor', description: 'Lineage uniqueness' }
      return await agent('continue once')`)
    const provider = new FakeAgentProvider([
      { outcome: { type: 'wait-for-abort' } },
      { outcome: { type: 'wait-for-abort' } },
    ])
    const store = new FileWorkflowStore(fixture.storeRoot)
    const service = new WorkflowService({ store, provider })
    await service.initialize()
    const original = await service.start({ cwd: fixture.cwd }, { name: 'one-successor' })
    while ((await service.status({ cwd: fixture.cwd }, original.runId)).cursor < 5) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 5))
    }
    await service.cancel({ cwd: fixture.cwd }, original.runId, 'prepare resume race')

    const [first, second] = await Promise.all([
      service.resume({ cwd: fixture.cwd }, { runId: original.runId, idempotencyKey: 'client-a' }),
      service.resume({ cwd: fixture.cwd }, { runId: original.runId, idempotencyKey: 'client-b' }),
    ])
    expect(second.runId).toBe(first.runId)
    const activeLineage = (await store.listManifests()).filter((manifest) => (
      (manifest.lineageId ?? manifest.runId) === original.runId &&
      !['completed', 'failed', 'cancelled', 'interrupted'].includes(manifest.status)
    ))
    expect(activeLineage).toHaveLength(1)
    await service.cancel({ cwd: fixture.cwd }, first.runId, 'finish uniqueness fixture')
    await service.stop()
  })

  it('marks an abandoned queued manifest interrupted on service initialization', async () => {
    const fixture = await project(twoPhaseSource)
    const store = new FileWorkflowStore(fixture.storeRoot)
    const seedLease = await store.acquireLease('abandoned-seed')
    await store.initialize()
    await store.createRun({
      runId: 'run_abandoned',
      cwd: fixture.cwd,
      workflow: parseWorkflowSource(twoPhaseSource),
    })
    await seedLease.release()
    const service = new WorkflowService({ store, provider: new FakeAgentProvider([]) })
    await service.initialize()

    const snapshot = await service.snapshot({ cwd: fixture.cwd }, 'run_abandoned')
    expect(snapshot.state.status).toBe('interrupted')
    expect(snapshot.manifest.status).toBe('interrupted')
    await service.stop()
  })

  it('bounds cursor pages, times out empty polls, wakes long polls, and persists cancellation', async () => {
    const fixture = await project(`export const meta = { name: 'poll-me', description: 'Poll fixture' }
      return await agent('wait forever')`)
    const service = new WorkflowService({
      store: new FileWorkflowStore(fixture.storeRoot),
      provider: new FakeAgentProvider([{ outcome: { type: 'wait-for-abort' } }]),
    })
    await service.initialize()
    const run = await service.start({ cwd: fixture.cwd }, { name: 'poll-me' })
    while ((await service.status({ cwd: fixture.cwd }, run.runId)).cursor < 5) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 5))
    }

    const firstPage = await service.readEvents(
      { cwd: fixture.cwd },
      { runId: run.runId, after: 0, limit: 2 },
    )
    expect(firstPage).toMatchObject({ fromCursor: 0, toCursor: 2, hasMore: true })
    const before = await service.status({ cwd: fixture.cwd }, run.runId)
    const timeoutStart = Date.now()
    const empty = await service.readEvents(
      { cwd: fixture.cwd },
      { runId: run.runId, after: before.cursor, waitMs: 30 },
    )
    expect(empty.events).toEqual([])
    expect(Date.now() - timeoutStart).toBeGreaterThanOrEqual(20)

    const following = service.readEvents(
      { cwd: fixture.cwd },
      { runId: run.runId, after: before.cursor, waitMs: 1_000 },
    )
    const cancelling = service.cancel({ cwd: fixture.cwd }, run.runId, 'cancel poll fixture')
    const woke = await following
    expect(woke.events[0]?.event.type).toBe('run.cancellation_requested')
    await cancelling

    const all = await service.readEvents(
      { cwd: fixture.cwd },
      { runId: run.runId, after: 0, limit: 1_000 },
    )
    expect(all.events.at(-1)?.event.type).toBe('run.cancelled')
    expect((await service.status({ cwd: fixture.cwd }, run.runId)).status).toBe('cancelled')
    await service.stop()
  })
})
