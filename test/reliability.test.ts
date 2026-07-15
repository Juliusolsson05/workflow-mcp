import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { AgentProviderAbortError } from '../src/agentProvider.js'
import type { AgentProvider, AgentProviderResult } from '../src/agentProvider.js'
import { FakeAgentProvider } from '../src/fakeProvider.js'
import type { FakeProviderScript } from '../src/fakeProvider.js'
import { FileWorkflowStore } from '../src/fileWorkflowStore.js'
import { parseWorkflowSource } from '../src/loadWorkflow.js'
import { PersistentWorkflowJournal } from '../src/persistentWorkflowJournal.js'
import { runWorkflow } from '../src/runWorkflow.js'
import type { WorkflowRun } from '../src/runWorkflow.js'
import { WorkflowService } from '../src/workflowService.js'
import { projectWorkflowState } from '../src/workflowState.js'
import type { WorkflowEvent } from '../src/workflowEvents.js'
import { WorkConservingScheduler } from '../src/workConservingScheduler.js'

function workflow(body: string, name = 'reliability') {
  return parseWorkflowSource(`export const meta = {
    name: ${JSON.stringify(name)},
    description: 'Reliability fixture',
  }
  ${body}`)
}

function collect(run: WorkflowRun): Promise<WorkflowEvent[]> {
  return (async () => {
    const events: WorkflowEvent[] = []
    for await (const event of run.events) events.push(event)
    return events
  })()
}

const FAST_RETRY = {
  maxAttempts: 3,
  startupTimeoutMs: 100,
  idleTimeoutMs: 100,
  activeOperationTimeoutMs: 100,
  attemptTimeoutMs: 1_000,
  retryBackoffBaseMs: 1,
  retryBackoffMaxMs: 1,
  retryJitterRatio: 0,
  hardTerminationGraceMs: 10,
  underutilizationWarningMs: 10,
} as const

describe('unattended workflow reliability', () => {
  it('keeps nine provider slots full while already-admitted work exists', async () => {
    const source = workflow(`
      return await parallel(Array.from({ length: 30 }, (_, index) => () => agent('job-' + index)))
    `)
    const scripts: FakeProviderScript[] = Array.from({ length: 30 }, (_, index) => ({
      // Seven fast leaders leave two deliberately slow members from the original wave. A
      // work-conserving scheduler must admit jobs 10+ immediately instead of waiting for all nine.
      delayMs: index < 7 ? 5 : index < 9 ? 100 : 1,
      outcome: { type: 'result', output: { type: 'text', text: `result-${index}` } },
    }))
    const provider = new FakeAgentProvider(scripts)
    const run = runWorkflow({ workflow: source, cwd: process.cwd(), provider, limits: { concurrency: 9 } })
    const events = collect(run)

    await expect(run.result).resolves.toHaveLength(30)
    await events
    expect(provider.maxConcurrentExecutions).toBe(9)
    expect(provider.completionOrder.indexOf(9)).toBeLessThan(provider.completionOrder.indexOf(7))
    expect(provider.completionOrder.indexOf(10)).toBeLessThan(provider.completionOrder.indexOf(8))
  })

  it('enforces a lower per-run ceiling beneath the shared service ceiling', async () => {
    const source = workflow(`
      return await parallel(Array.from({ length: 8 }, (_, index) => () => agent('limited-' + index)))
    `)
    const provider = new FakeAgentProvider(Array.from({ length: 8 }, (_, index) => ({
      delayMs: 15,
      outcome: { type: 'result', output: { type: 'text', text: `${index}` } },
    })))
    const run = runWorkflow({
      workflow: source,
      cwd: process.cwd(),
      provider,
      limits: { concurrency: 2 },
      scheduler: new WorkConservingScheduler(9),
    })

    await expect(run.result).resolves.toHaveLength(8)
    expect(provider.maxConcurrentExecutions).toBe(2)
  })

  it('enforces one global ceiling across concurrent runs', async () => {
    let maximumGlobalActive = 0
    const scheduler = new WorkConservingScheduler(3, (snapshot) => {
      maximumGlobalActive = Math.max(maximumGlobalActive, snapshot.active)
    })
    const source = workflow(`
      return await parallel(Array.from({ length: 6 }, (_, index) => () => agent('shared-' + index)))
    `)
    const scripts = (): FakeProviderScript[] => Array.from({ length: 6 }, (_, index) => ({
      delayMs: 15,
      outcome: { type: 'result', output: { type: 'text', text: `${index}` } },
    }))
    const first = runWorkflow({ workflow: source, cwd: process.cwd(), provider: new FakeAgentProvider(scripts()), scheduler })
    const second = runWorkflow({ workflow: source, cwd: process.cwd(), provider: new FakeAgentProvider(scripts()), scheduler })

    await expect(Promise.all([first.result, second.result])).resolves.toEqual([
      expect.arrayContaining(['0', '1', '2', '3', '4', '5']),
      expect.arrayContaining(['0', '1', '2', '3', '4', '5']),
    ])
    expect(maximumGlobalActive).toBe(3)
  })

  it('retries one retryable logical agent on the same provider session', async () => {
    const source = workflow(`return await agent('retry me')`)
    const provider = new FakeAgentProvider([
      {
        sessionId: 'durable-session',
        outcome: { type: 'provider-failure', message: 'temporary stream loss', code: 'stream', retryable: true },
      },
      {
        expect: { sessionId: 'durable-session' },
        outcome: { type: 'result', output: { type: 'text', text: 'recovered' } },
      },
    ])
    const run = runWorkflow({
      workflow: source,
      cwd: process.cwd(),
      provider,
      sandbox: { mode: 'read-only' },
      reliability: FAST_RETRY,
    })
    const events = collect(run)

    await expect(run.result).resolves.toBe('recovered')
    const captured = await events
    const state = projectWorkflowState(run.id, captured)
    expect(state.agents[0]?.attempts.map((attempt) => attempt.status)).toEqual(['failed', 'completed'])
    expect(state.agents[0]?.outcome?.source).toBe('provider-resume')
    expect(captured.some((event) => event.type === 'agent.retry_scheduled')).toBe(true)
    expect(provider.calls[1]?.request.session?.id).toBe('durable-session')
  })

  it('opens the provider circuit and admits only a half-open recovery probe', async () => {
    const provider = new FakeAgentProvider([
      { outcome: { type: 'provider-failure', message: 'provider unavailable', retryable: true } },
      { outcome: { type: 'result', output: { type: 'text', text: 'probe recovered' } } },
    ])
    const startedAt = Date.now()
    const run = runWorkflow({
      workflow: workflow(`return await agent('circuit probe')`),
      cwd: process.cwd(),
      provider,
      sandbox: { mode: 'read-only' },
      reliability: {
        ...FAST_RETRY,
        circuitBreakerThreshold: 1,
        circuitBreakerCooldownMs: 20,
        circuitBreakerWindowMs: 1_000,
      },
    })

    await expect(run.result).resolves.toBe('probe recovered')
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(18)
    expect(provider.calls).toHaveLength(2)
  })

  it('bounds the total retry storm across a run', async () => {
    const provider = new FakeAgentProvider([
      { outcome: { type: 'provider-failure', message: 'outage-1', retryable: true } },
      { outcome: { type: 'provider-failure', message: 'outage-2', retryable: true } },
    ])
    const run = runWorkflow({
      workflow: workflow(`return await agent('bounded retries')`),
      cwd: process.cwd(),
      provider,
      sandbox: { mode: 'read-only' },
      reliability: { ...FAST_RETRY, maxRetryAttemptsPerRun: 1 },
    })
    const events = collect(run)

    await expect(run.result).resolves.toBeNull()
    expect(provider.calls).toHaveLength(2)
    expect((await events).filter((event) => event.type === 'agent.retry_scheduled')).toHaveLength(1)
  })

  it('detects an idle provider, aborts only that attempt, and resumes it', async () => {
    const source = workflow(`return await agent('stall then recover')`)
    const provider = new FakeAgentProvider([
      { sessionId: 'stalled-session', outcome: { type: 'wait-for-abort' } },
      {
        expect: { sessionId: 'stalled-session' },
        outcome: { type: 'result', output: { type: 'text', text: 'alive' } },
      },
    ])
    const run = runWorkflow({
      workflow: source,
      cwd: process.cwd(),
      provider,
      limits: { cancellationGraceMs: 10 },
      sandbox: { mode: 'read-only' },
      reliability: { ...FAST_RETRY, idleTimeoutMs: 20 },
    })
    const events = collect(run)

    await expect(run.result).resolves.toBe('alive')
    const captured = await events
    expect(captured).toContainEqual(expect.objectContaining({
      type: 'agent.stalled',
      payload: expect.objectContaining({ kind: 'idle' }),
    }))
    expect(provider.calls.map((call) => call.status)).toEqual(['aborted', 'completed'])
  })

  it('detects a provider which never establishes a session as a startup stall', async () => {
    const source = workflow(`return await agent('never started')`)
    const provider = new FakeAgentProvider([
      { emitSession: false, outcome: { type: 'wait-for-abort' } },
      { outcome: { type: 'result', output: { type: 'text', text: 'fresh retry' } } },
    ])
    const run = runWorkflow({
      workflow: source,
      cwd: process.cwd(),
      provider,
      limits: { cancellationGraceMs: 10 },
      sandbox: { mode: 'read-only' },
      reliability: { ...FAST_RETRY, startupTimeoutMs: 20 },
    })
    const events = collect(run)

    await expect(run.result).resolves.toBe('fresh retry')
    expect((await events).some(
      (event) => event.type === 'agent.stalled' && event.payload.kind === 'startup',
    )).toBe(true)
  })

  it('escalates run cancellation through the attempt-addressed termination hook', async () => {
    let rejectExecution!: (error: unknown) => void
    let terminatedAttempt: string | undefined
    let markStarted!: () => void
    const started = new Promise<void>((resolveStarted) => { markStarted = resolveStarted })
    const provider: AgentProvider = {
      name: 'termination-fixture',
      execute: async (_request, context): Promise<AgentProviderResult> => {
        await context.emit({
          type: 'session.started',
          session: { provider: 'termination-fixture', id: 'session-1' },
        })
        markStarted()
        return new Promise<AgentProviderResult>((_resolve, reject) => { rejectExecution = reject })
      },
      terminateAttempt: async (attempt) => {
        terminatedAttempt = attempt.attemptId
        rejectExecution(new AgentProviderAbortError('forcibly reaped'))
      },
    }
    const run = runWorkflow({
      workflow: workflow(`return await agent('ignore cooperative abort')`),
      cwd: process.cwd(),
      provider,
      limits: { cancellationGraceMs: 5 },
      reliability: { ...FAST_RETRY, hardTerminationGraceMs: 10 },
    })
    const events = collect(run)
    await started
    await run.cancel('test cancellation')

    await expect(run.result).rejects.toThrow('test cancellation')
    expect(terminatedAttempt).toBe('agent_1_attempt_1')
    expect((await events).some((event) => event.type === 'run.cancelled')).toBe(true)
  })

  it('prepares and cleans one stable workspace across all attempts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-reliable-workspace-'))
    const source = workflow(`return await agent('isolated retry', { isolation: 'worktree' })`)
    const provider = new FakeAgentProvider([
      { outcome: { type: 'provider-failure', message: 'retry', retryable: true } },
      { outcome: { type: 'result', output: { type: 'text', text: 'done' } } },
    ])
    const preparations: Array<{ workspaceId: string; lineageId: string }> = []
    let cleanups = 0
    const run = runWorkflow({
      workflow: source,
      cwd: process.cwd(),
      provider,
      reliability: FAST_RETRY,
      prepareWorkingDirectory: async ({ workspaceId, lineageId }) => {
        preparations.push({ workspaceId, lineageId })
        return {
          path: root,
          leaseId: 'lease-1',
          cleanup: async () => { cleanups += 1 },
        }
      },
    })
    const events = collect(run)

    await expect(run.result).resolves.toBe('done')
    const state = projectWorkflowState(run.id, await events)
    expect(preparations).toEqual([{ workspaceId: expect.stringMatching(/^workspace_/), lineageId: run.id }])
    expect(new Set(provider.calls.map((call) => call.request.workingDirectory))).toEqual(new Set([root]))
    expect(cleanups).toBe(1)
    expect(state.agents[0]?.workspace).toMatchObject({ leaseId: 'lease-1', path: root })
  })

  it('diagnoses a workflow-authored batch barrier instead of claiming queued work is starved', async () => {
    const source = workflow(`
      const output = []
      for (let start = 0; start < 18; start += 9) {
        const batch = Array.from({ length: 9 }, (_, offset) => start + offset)
        output.push(...await parallel(batch.map((index) => () => agent('batch-' + index))))
      }
      return output
    `)
    const provider = new FakeAgentProvider(Array.from({ length: 18 }, (_, index) => ({
      delayMs: index < 7 ? 1 : index < 9 ? 60 : 1,
      outcome: { type: 'result', output: { type: 'text', text: `${index}` } },
    })))
    const run = runWorkflow({
      workflow: source,
      cwd: process.cwd(),
      provider,
      limits: { concurrency: 9 },
      reliability: { underutilizationWarningMs: 10 },
    })
    const events = collect(run)

    await expect(run.result).resolves.toHaveLength(18)
    const state = projectWorkflowState(run.id, await events)
    expect(state.warnings).toContainEqual(expect.objectContaining({
      code: 'workflow-capacity-unfilled-no-runnable-work',
    }))
  })

  it('automatically continues a safely interrupted running manifest as a linked run', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'workflow-auto-recovery-project-'))
    const storeRoot = join(cwd, 'state')
    await mkdir(storeRoot, { recursive: true })
    const source = workflow(`return await agent('recover after crash')`, 'auto-recovery')
    const seed = new FileWorkflowStore(storeRoot)
    await seed.initialize()
    await seed.createRun({ runId: 'run_crashed', cwd, workflow: source })
    await seed.appendEvent('run_crashed', {
      schemaVersion: 1,
      runId: 'run_crashed',
      sequence: 1,
      eventId: 'event_started',
      timestamp: new Date().toISOString(),
      type: 'run.started',
      payload: { workflow: { name: source.meta.name, description: source.meta.description } },
    })

    const service = new WorkflowService({
      store: new FileWorkflowStore(storeRoot),
      provider: new FakeAgentProvider([
        { outcome: { type: 'result', output: { type: 'text', text: 'recovered' } } },
      ]),
    })
    await service.initialize()
    // Read through a separate handle without calling initialize(), because initialization is a
    // recovery mutation and the service deliberately owns that responsibility while leased.
    const manifests = await new FileWorkflowStore(storeRoot).listManifests()
    const recovered = manifests.find((manifest) => manifest.recoveryMode === 'automatic')
    expect(recovered).toBeDefined()
    if (!recovered) throw new Error('Automatic recovery run was not created')

    for (let attempt = 0; attempt < 200; attempt += 1) {
      const status = await service.status({ cwd }, recovered.runId)
      if (['completed', 'failed', 'cancelled', 'interrupted'].includes(status.status)) break
      await new Promise((resolveWait) => setTimeout(resolveWait, 5))
    }
    await expect(service.status({ cwd }, 'run_crashed')).resolves.toMatchObject({ status: 'interrupted' })
    await expect(service.status({ cwd }, recovered.runId)).resolves.toMatchObject({
      status: 'completed',
      resumedFromRunId: 'run_crashed',
      lineageId: 'run_crashed',
      recoveryMode: 'automatic',
    })
    await service.stop()
  })

  it('recovers only the interrupted sibling from an exact-source parallel run', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'workflow-sparse-recovery-project-'))
    const storeRoot = join(cwd, 'state')
    await mkdir(storeRoot, { recursive: true })
    const source = workflow(`
      return await parallel(Array.from({ length: 9 }, (_, index) => () => agent('sibling-' + index)))
    `, 'sparse-auto-recovery')
    const seed = new FileWorkflowStore(storeRoot)
    await seed.initialize()
    await seed.createRun({ runId: 'run_sparse_crashed', cwd, workflow: source })
    await seed.appendEvent('run_sparse_crashed', {
      schemaVersion: 1,
      runId: 'run_sparse_crashed',
      sequence: 1,
      eventId: 'event_sparse_started',
      timestamp: new Date().toISOString(),
      type: 'run.started',
      payload: { workflow: { name: source.meta.name, description: source.meta.description } },
    })

    const priorJournal = await PersistentWorkflowJournal.open(seed.journalPath('run_sparse_crashed'))
    const priorRun = priorJournal.beginRun({ workflowId: source.meta.name, sourceHash: source.sourceHash })
    for (let index = 0; index < 9; index += 1) {
      const decision = priorRun.admit({ agentId: `prior-${index}`, prompt: `sibling-${index}` })
      if (decision.reused) throw new Error('A fresh recovery fixture unexpectedly reused a result')
      // WHY the fifth call has a start without a result: this is the durable shape left by a real
      // process death. The four siblings after it still finished before the process disappeared,
      // so exact-source recovery must preserve those successes rather than falling back to the
      // manual edited-workflow rule that invalidates everything after the first gap.
      if (index !== 4) {
        priorRun.recordResult(decision, `seed-${index}`, { successful: true })
      }
    }

    const provider = new FakeAgentProvider([
      {
        expect: { prompt: 'sibling-4' },
        outcome: { type: 'result', output: { type: 'text', text: 'recovered-4' } },
      },
    ])
    const service = new WorkflowService({ store: new FileWorkflowStore(storeRoot), provider })
    await service.initialize()
    const recovered = (await new FileWorkflowStore(storeRoot).listManifests())
      .find((manifest) => manifest.resumedFromRunId === 'run_sparse_crashed')
    expect(recovered).toBeDefined()
    if (!recovered) throw new Error('Sparse automatic recovery run was not created')

    for (let attempt = 0; attempt < 200; attempt += 1) {
      const status = await service.status({ cwd }, recovered.runId)
      if (['completed', 'failed', 'cancelled', 'interrupted'].includes(status.status)) break
      await new Promise((resolveWait) => setTimeout(resolveWait, 5))
    }
    await expect(service.status({ cwd }, recovered.runId)).resolves.toMatchObject({
      status: 'completed',
    })
    const completed = (await new FileWorkflowStore(storeRoot).readEvents(recovered.runId, 0, 1_000))
      .events.find((stored) => stored.event.type === 'run.completed')
    expect(completed?.event).toMatchObject({
      type: 'run.completed',
      payload: { result: { content: [
        'seed-0',
        'seed-1',
        'seed-2',
        'seed-3',
        'recovered-4',
        'seed-5',
        'seed-6',
        'seed-7',
        'seed-8',
      ] } },
    })
    expect(provider.calls).toHaveLength(1)
    provider.assertExhausted()
    await service.stop()
  })

  it('fences a durable store to one live service owner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-owner-fence-'))
    const first = new FileWorkflowStore(root)
    const second = new FileWorkflowStore(root)
    await Promise.all([first.initialize(), second.initialize()])
    const lease = await first.acquireLease('first')
    await expect(second.acquireLease('second')).rejects.toMatchObject({ code: 'owner-conflict' })
    await expect(second.appendEvent('run_missing', {} as never)).rejects.toMatchObject({
      code: 'owner-conflict',
    })
    await expect(new FileWorkflowStore(root).initialize()).rejects.toMatchObject({
      code: 'owner-conflict',
    })
    await lease.release()
    const replacement = await second.acquireLease('second')
    await replacement.release()
  })
})
