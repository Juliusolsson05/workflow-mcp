import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { FakeAgentProvider } from '../src/fakeProvider.js'
import type { FakeProviderScript } from '../src/fakeProvider.js'
import type { AgentProvider, AgentProviderResult } from '../src/agentProvider.js'
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
    if (['completed', 'completed_with_errors', 'failed', 'cancelled', 'interrupted'].includes(status.status)) return status
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
  it('continues an explicitly abandoned unconfirmed read-only provider execution', async () => {
    const fixture = await project(`export const meta = {
      name: 'continue-read-only', description: 'Manual continuation fixture'
    }
    return await agent('inspect without writing')`)
    let calls = 0
    const provider: AgentProvider = {
      name: 'unconfirmed-read-only',
      terminationBoundary: 'unconfirmed-descendants',
      execute: async (_request, context): Promise<AgentProviderResult> => {
        calls += 1
        if (calls === 1) return new Promise<AgentProviderResult>(() => undefined)
        await context.emit({
          type: 'session.started',
          session: { provider: 'unconfirmed-read-only', id: 'continued-session' },
        })
        return { output: { type: 'text', text: 'continued safely' } }
      },
      terminateAttempt: async () => undefined,
    }
    const service = new WorkflowService({
      store: new FileWorkflowStore(fixture.storeRoot),
      provider,
      sandbox: { mode: 'read-only', approvalPolicy: 'never', network: false },
      limits: { cancellationGraceMs: 2 },
      reliability: {
        maxAttempts: 1,
        startupTimeoutMs: 5,
        hardTerminationGraceMs: 2,
      },
    })
    await service.initialize()

    const first = await service.start({ cwd: fixture.cwd }, { name: 'continue-read-only' })
    await expect(terminal(service, fixture.cwd, first.runId)).resolves.toMatchObject({
      status: 'completed_with_errors',
    })
    await expect(service.resume({ cwd: fixture.cwd }, { runId: first.runId })).rejects.toMatchObject({
      code: 'unsafe-provider-active',
    })

    const resumed = await service.resume({ cwd: fixture.cwd }, {
      runId: first.runId,
      abandonUnconfirmedProvider: true,
    })
    await expect(terminal(service, fixture.cwd, resumed.runId)).resolves.toMatchObject({
      status: 'completed',
    })
    expect(calls).toBe(2)
    await service.stop()
  })

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

  it('rejects inline source before touching a read-only profile project', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'workflow-inline-disabled-'))
    await mkdir(join(cwd, '.git'))
    const service = new WorkflowService({
      store: new FileWorkflowStore(join(cwd, 'state')),
      provider: new FakeAgentProvider([]),
      allowInlineWorkflowAuthoring: false,
    })
    await service.initialize()

    await expect(service.start({ cwd }, {
      script: `export const meta = { name: 'blocked', description: 'Must remain absent' }\nreturn null`,
    })).rejects.toMatchObject({ code: 'authoring-disabled' })
    await expect(access(join(cwd, '.claude'))).rejects.toMatchObject({ code: 'ENOENT' })
    await service.stop()
  })

  it('fences app-owned administrative state with service mutation admission', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'workflow-administrative-mutation-'))
    const service = new WorkflowService({
      store: new FileWorkflowStore(join(cwd, 'state')),
      provider: new FakeAgentProvider([]),
    })
    await service.initialize()
    await expect(service.runAdministrativeMutation(async () => 'committed')).resolves.toBe('committed')
    await service.stop()
    await expect(service.runAdministrativeMutation(async () => 'too-late')).rejects.toMatchObject({
      code: 'service-stopped',
    })
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
    await expect(service.readEvents(
      { cwd: fixture.cwd },
      { runId: run.runId, after: before.cursor + 1, waitMs: 1_000 },
    )).rejects.toMatchObject({ code: 'cursor-ahead' })
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

  it('quiesces active work as interrupted, wakes long polls, and closes mutation admission', async () => {
    const fixture = await project(`export const meta = { name: 'quiesce-me', description: 'Restart fixture' }
      return await agent('wait for host restart')`)
    const store = new FileWorkflowStore(fixture.storeRoot)
    const service = new WorkflowService({
      store,
      provider: new FakeAgentProvider([{ outcome: { type: 'wait-for-abort' } }]),
    })
    await service.initialize()
    const run = await service.start({ cwd: fixture.cwd }, { name: 'quiesce-me' })
    let manifest = await service.status({ cwd: fixture.cwd }, run.runId)
    while (manifest.cursor < 5) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 5))
      manifest = await service.status({ cwd: fixture.cwd }, run.runId)
    }

    const polling = service.readEvents(
      { cwd: fixture.cwd },
      { runId: run.runId, after: manifest.cursor, waitMs: 1_000 },
    )
    // Let the request finish its initial replay and actually register the long-poll waiter. Without
    // this boundary the interruption event can legitimately arrive during the initial page read.
    await new Promise(resolveWait => setTimeout(resolveWait, 20))
    const quiescing = service.quiesce('container replacement')
    expect(service.lifecycleState()).toBe('QUIESCING')
    await expect(polling).rejects.toMatchObject({ code: 'service-stopping' })
    await expect(service.start(
      { cwd: fixture.cwd },
      { name: 'quiesce-me' },
    )).rejects.toMatchObject({ code: 'service-stopping' })
    await quiescing
    expect(service.lifecycleState()).toBe('STOPPED')

    const stopped = await store.getManifest(run.runId)
    expect(stopped?.status).toBe('interrupted')
    const events = await store.readEvents(run.runId, 0, 1_000)
    expect(events.events.some(stored => stored.event.type === 'run.cancellation_requested')).toBe(false)
    expect(events.events.at(-1)?.event).toMatchObject({
      type: 'run.interrupted',
      payload: { reason: 'container replacement' },
    })
  })

  it('drains a start admitted before quiesce and interrupts the run it registers', async () => {
    const fixture = await project(`export const meta = { name: 'admission-race', description: 'Admission fixture' }
      return await agent('wait after registration')`)
    let enterLookup!: () => void
    let releaseLookup!: () => void
    const lookupEntered = new Promise<void>(resolveEntered => { enterLookup = resolveEntered })
    const lookupGate = new Promise<void>(resolveGate => { releaseLookup = resolveGate })
    class GatedStore extends FileWorkflowStore {
      override async findByIdempotencyKey(cwd: string, key: string) {
        enterLookup()
        await lookupGate
        return super.findByIdempotencyKey(cwd, key)
      }
    }
    const store = new GatedStore(fixture.storeRoot)
    const service = new WorkflowService({
      store,
      provider: new FakeAgentProvider([{ outcome: { type: 'wait-for-abort' } }]),
    })
    await service.initialize()

    const starting = service.start(
      { cwd: fixture.cwd },
      { name: 'admission-race', idempotencyKey: 'already-admitted' },
    )
    await lookupEntered
    const quiescing = service.quiesce('admission race restart')
    let quiesceSettled = false
    void quiescing.finally(() => { quiesceSettled = true })
    await new Promise(resolveWait => setTimeout(resolveWait, 10))
    expect(quiesceSettled).toBe(false)

    releaseLookup()
    const run = await starting
    await quiescing
    expect((await store.getManifest(run.runId))?.status).toBe('interrupted')
    expect((await store.readEvents(run.runId, 0, 1_000)).events.at(-1)?.event.type).toBe(
      'run.interrupted',
    )
  })

  it('exposes and reads every byte of a truncated 1,186-line result after service restart', async () => {
    const fixture = await project(`export const meta = { name: 'large-result', description: 'Durable result fixture' }
      return args.result`)
    const expected = Array.from(
      { length: 1_186 },
      (_, index) => `line ${index + 1}: ${'payload'.repeat(3)} 😀`,
    ).join('\n')
    const first = new WorkflowService({
      store: new FileWorkflowStore(fixture.storeRoot),
      provider: new FakeAgentProvider([]),
    })
    await first.initialize()
    const run = await first.start(
      { cwd: fixture.cwd },
      { name: 'large-result', args: { result: expected } },
    )
    const completed = await terminal(first, fixture.cwd, run.runId)
    expect(completed).toMatchObject({
      status: 'completed',
      result: {
        artifactId: expect.stringMatching(/^result_sha256_[a-f0-9]{64}$/),
        mediaType: 'text/plain',
        sizeBytes: Buffer.byteLength(expected),
        lineCount: 1_186,
        truncated: true,
        checksum: { algorithm: 'sha256', value: expect.stringMatching(/^[a-f0-9]{64}$/) },
      },
    })
    expect(completed.result).not.toHaveProperty('content')
    const events = await first.readEvents(
      { cwd: fixture.cwd },
      { runId: run.runId, after: 0, limit: 1_000 },
    )
    const artifactEvent = events.events.find(stored => stored.event.type === 'artifact.created')
    const completionEvent = events.events.find(stored => stored.event.type === 'run.completed')
    expect(artifactEvent?.cursor).toBeLessThan(completionEvent?.cursor ?? 0)
    expect(completionEvent?.event).toMatchObject({
      payload: {
        result: {
          artifactId: completed.result?.artifactId,
          truncated: true,
        },
      },
    })
    await first.stop()

    const reopened = new WorkflowService({
      store: new FileWorkflowStore(fixture.storeRoot),
      provider: new FakeAgentProvider([]),
    })
    await reopened.initialize()
    let cursor: string | undefined
    let reconstructed = ''
    do {
      const page = await reopened.readResult({ cwd: fixture.cwd }, {
        runId: run.runId,
        artifactId: completed.result!.artifactId!,
        maxBytes: 257,
        ...(cursor === undefined ? {} : { cursor }),
      })
      expect(Buffer.byteLength(page.content, 'utf8')).toBeLessThanOrEqual(257)
      reconstructed += page.content
      cursor = page.nextCursor
      if (!page.hasMore) break
      expect(cursor).toEqual(expect.any(String))
    } while (true)
    expect(reconstructed).toBe(expected)
    expect(createHash('sha256').update(reconstructed, 'utf8').digest('hex')).toBe(
      completed.result!.checksum!.value,
    )
    await expect(reopened.readResult({ cwd: join(fixture.cwd, 'other') }, {
      runId: run.runId,
      artifactId: completed.result!.artifactId!,
    })).rejects.toMatchObject({ code: 'scope-forbidden' })

    await unlink(join(
      fixture.storeRoot,
      'runs',
      run.runId,
      'artifacts',
      'workflow-result.data',
    ))
    await expect(reopened.readResult({ cwd: fixture.cwd }, {
      runId: run.runId,
      artifactId: completed.result!.artifactId!,
    })).rejects.toMatchObject({ code: 'result-expired' })
    await reopened.stop()
  })

  it.each([
    ['structured JSON', { nested: { ok: true }, values: [1, null, 'three'] }, 'application/json'],
    ['null', null, 'application/json'],
    ['empty string', '', 'text/plain'],
    ['undefined', undefined, 'text/plain'],
  ] as const)('materializes %s results with explicit media and line semantics', async (_label, value, mediaType) => {
    const fixture = await project(`export const meta = { name: 'typed-result', description: 'Typed result fixture' }
      return args`)
    const service = new WorkflowService({
      store: new FileWorkflowStore(fixture.storeRoot),
      provider: new FakeAgentProvider([]),
    })
    await service.initialize()
    const run = await service.start({ cwd: fixture.cwd }, { name: 'typed-result', args: value })
    const completed = await terminal(service, fixture.cwd, run.runId)
    const page = await service.readResult({ cwd: fixture.cwd }, {
      runId: run.runId,
      artifactId: completed.result!.artifactId!,
      maxBytes: 7,
    })
    let serialized = page.content
    let cursor = page.nextCursor
    while (cursor !== undefined) {
      const next = await service.readResult({ cwd: fixture.cwd }, {
        runId: run.runId,
        artifactId: completed.result!.artifactId!,
        cursor,
        maxBytes: 7,
      })
      serialized += next.content
      cursor = next.nextCursor
    }
    expect(completed.result?.mediaType).toBe(mediaType)
    expect(completed.result?.lineCount).toBe(value === '' ? 0 : serialized.split('\n').length)
    if (mediaType === 'application/json') expect(JSON.parse(serialized)).toEqual(value)
    else expect(serialized).toBe(value === undefined ? 'undefined' : value)
    await service.stop()
  })

  it('rejects result reads for non-terminal and failed runs with stable error codes', async () => {
    const waitingFixture = await project(`export const meta = { name: 'waiting-result', description: 'Waiting result fixture' }
      return await agent('wait')`)
    const waiting = new WorkflowService({
      store: new FileWorkflowStore(waitingFixture.storeRoot),
      provider: new FakeAgentProvider([{ outcome: { type: 'wait-for-abort' } }]),
    })
    await waiting.initialize()
    const active = await waiting.start({ cwd: waitingFixture.cwd }, { name: 'waiting-result' })
    await expect(waiting.readResult({ cwd: waitingFixture.cwd }, {
      runId: active.runId,
      artifactId: 'result_sha256_unknown',
    })).rejects.toMatchObject({ code: 'result-not-ready' })
    await waiting.cancel({ cwd: waitingFixture.cwd }, active.runId, 'finish result readiness test')
    await waiting.stop()

    const failedFixture = await project(`export const meta = { name: 'failed-result', description: 'Failed result fixture' }
      throw new Error('intentional failure')`)
    const failed = new WorkflowService({
      store: new FileWorkflowStore(failedFixture.storeRoot),
      provider: new FakeAgentProvider([]),
    })
    await failed.initialize()
    const run = await failed.start({ cwd: failedFixture.cwd }, { name: 'failed-result' })
    await expect(terminal(failed, failedFixture.cwd, run.runId)).resolves.toMatchObject({ status: 'failed' })
    await expect(failed.readResult({ cwd: failedFixture.cwd }, {
      runId: run.runId,
      artifactId: 'result_sha256_unknown',
    })).rejects.toMatchObject({ code: 'result-unavailable' })
    await failed.stop()
  })

  it('fails the run instead of publishing a completion whose result exceeds storage policy', async () => {
    const fixture = await project(`export const meta = { name: 'oversized-result', description: 'Result cap fixture' }
      return args`)
    const service = new WorkflowService({
      store: new FileWorkflowStore(fixture.storeRoot, { maxResultBytes: 32 }),
      provider: new FakeAgentProvider([]),
    })
    await service.initialize()
    const run = await service.start(
      { cwd: fixture.cwd },
      { name: 'oversized-result', args: 'x'.repeat(33) },
    )
    await expect(terminal(service, fixture.cwd, run.runId)).resolves.toMatchObject({
      status: 'failed',
      error: expect.stringContaining('exceeds 32 UTF-8 bytes'),
    })
    const events = await service.readEvents(
      { cwd: fixture.cwd },
      { runId: run.runId, after: 0, limit: 1_000 },
    )
    expect(events.events.some(stored => stored.event.type === 'run.completed')).toBe(false)
    await service.stop()
  })

  it('keeps legacy completion events readable while reporting their absent artifact explicitly', async () => {
    const fixture = await project(`export const meta = { name: 'legacy-result', description: 'Legacy result fixture' }
      return 'unused'`)
    const seed = new FileWorkflowStore(fixture.storeRoot)
    const lease = await seed.acquireLease('legacy-result-seed')
    await seed.initialize()
    await seed.createRun({
      runId: 'run_legacy_result',
      cwd: fixture.cwd,
      workflow: parseWorkflowSource(`export const meta = { name: 'legacy-result', description: 'Legacy result fixture' }
        return 'unused'`),
    })
    await seed.appendEvent('run_legacy_result', {
      schemaVersion: 1,
      runId: 'run_legacy_result',
      sequence: 1,
      eventId: 'legacy-started',
      timestamp: new Date().toISOString(),
      type: 'run.started',
      payload: { workflow: { name: 'legacy-result', description: 'Legacy result fixture' } },
    })
    await seed.appendEvent('run_legacy_result', {
      schemaVersion: 1,
      runId: 'run_legacy_result',
      sequence: 2,
      eventId: 'legacy-completed',
      timestamp: new Date().toISOString(),
      type: 'run.completed',
      payload: {
        result: {
          preview: 'legacy prefix',
          content: 'legacy prefix',
          lineCount: 12,
          mediaType: 'text/plain',
          truncated: true,
        },
      },
    })
    await lease.release()

    const service = new WorkflowService({
      store: new FileWorkflowStore(fixture.storeRoot),
      provider: new FakeAgentProvider([]),
    })
    await service.initialize()
    await expect(service.status({ cwd: fixture.cwd }, 'run_legacy_result')).resolves.toMatchObject({
      status: 'completed',
      result: { preview: 'legacy prefix', lineCount: 12, truncated: true },
    })
    const events = await service.readEvents(
      { cwd: fixture.cwd },
      { runId: 'run_legacy_result', after: 0, limit: 10 },
    )
    expect(events.events.at(-1)?.event).toMatchObject({
      type: 'run.completed',
      payload: { result: { content: 'legacy prefix' } },
    })
    await expect(service.readResult({ cwd: fixture.cwd }, {
      runId: 'run_legacy_result',
      artifactId: 'result_sha256_missing',
    })).rejects.toMatchObject({ code: 'result-unavailable' })
    await service.stop()
  })
})
