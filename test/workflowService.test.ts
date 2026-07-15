import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
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

  it('marks an abandoned queued manifest interrupted on service initialization', async () => {
    const fixture = await project(twoPhaseSource)
    const store = new FileWorkflowStore(fixture.storeRoot)
    await store.initialize()
    await store.createRun({
      runId: 'run_abandoned',
      cwd: fixture.cwd,
      workflow: parseWorkflowSource(twoPhaseSource),
    })
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
