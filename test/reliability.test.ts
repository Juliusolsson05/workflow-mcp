import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { AgentProviderAbortError, AgentProviderFailure } from '../src/agentProvider.js'
import type { AgentProvider, AgentProviderResult } from '../src/agentProvider.js'
import { ProviderCircuitBreaker } from '../src/executionReliability.js'
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

function expectFailurePlaceholder(status: 'failed' | 'recovery_required' = 'failed') {
  return expect.objectContaining({
    __workflowAgentFailure: expect.objectContaining({
      schemaVersion: 1,
      status,
      coverageGap: true,
    }),
  })
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

  it('round-robins queued capacity across workflow runs', async () => {
    const scheduler = new WorkConservingScheduler(1)
    const controller = new AbortController()
    const first = await scheduler.acquire(controller.signal, 'run-a')
    const order: string[] = []
    const queued = ['run-a', 'run-a', 'run-b', 'run-b'].map(async (runId) => {
      const lease = await scheduler.acquire(controller.signal, runId)
      order.push(runId)
      lease.release()
    })
    first.release()
    await Promise.all(queued)

    expect(order).toEqual(['run-b', 'run-a', 'run-b', 'run-a'])
  })

  it('does not starve a third fairness key behind two queued bursts', async () => {
    const scheduler = new WorkConservingScheduler(1)
    const controller = new AbortController()
    const held = await scheduler.acquire(controller.signal, 'run-a')
    const order: string[] = []
    const queued = ['run-a', 'run-a', 'run-a', 'run-b', 'run-b', 'run-b', 'run-c']
      .map(async (runId) => {
        const lease = await scheduler.acquire(controller.signal, runId)
        order.push(runId)
        lease.release()
      })

    held.release()
    await Promise.all(queued)

    // run-a owns the held grant, so the next complete rotation is B, C, A. The old
    // "anything except the last key" selector produced B, A, B and starved C.
    expect(order.slice(0, 3)).toEqual(['run-b', 'run-c', 'run-a'])
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

  it('retries one retryable logical agent in a fresh provider session', async () => {
    const source = workflow(`return await agent('retry me')`)
    const provider = new FakeAgentProvider([
      {
        sessionId: 'durable-session',
        outcome: { type: 'provider-failure', message: 'temporary stream loss', code: 'stream', retryable: true },
      },
      { outcome: { type: 'result', output: { type: 'text', text: 'recovered' } } },
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
    expect(state.agents[0]?.outcome?.source).toBe('live')
    expect(captured.some((event) => event.type === 'agent.retry_scheduled')).toBe(true)
    expect(captured.some((event) => event.type === 'agent.recovery_started')).toBe(true)
    expect(captured.some((event) => event.type === 'agent.recovery_completed')).toBe(true)
    expect(provider.calls[1]?.request.session).toBeUndefined()
    expect(provider.calls[1]?.request.recovery?.note).toContain('previous turn was interrupted')
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

  it('releases unrelated queued work as soon as a half-open probe produces provider progress', async () => {
    const circuit = new ProviderCircuitBreaker({
      circuitBreakerThreshold: 1,
      circuitBreakerWindowMs: 1_000,
      circuitBreakerCooldownMs: 1,
    })
    const outage = await circuit.enter(new AbortController().signal)
    expect(outage.startAllowed()).toBe(true)
    outage.infrastructureFailure()
    await new Promise((resolveWait) => setTimeout(resolveWait, 2))

    const probe = await circuit.enter(new AbortController().signal)
    expect(probe.probe).toBe(true)
    expect(probe.startAllowed()).toBe(true)
    const waiting = circuit.enter(new AbortController().signal)
    probe.providerResponsive()
    const released = await waiting

    expect(released.startAllowed()).toBe(true)
    expect(circuit.snapshot()).toEqual({ state: 'closed', recentFailures: 0 })
    released.neutral()
    probe.success()
  })

  it('does not let a retryable request-local failure poison the shared provider circuit', async () => {
    const circuit = new ProviderCircuitBreaker({
      circuitBreakerThreshold: 1,
      circuitBreakerWindowMs: 10_000,
      circuitBreakerCooldownMs: 10_000,
    })
    const provider = new FakeAgentProvider([
      {
        outcome: {
          type: 'provider-failure',
          message: 'historical thread is unavailable',
          code: 'codex-session-unavailable',
          retryable: true,
          circuitImpact: 'neutral',
        },
      },
    ])
    const run = runWorkflow({
      workflow: workflow(`return await agent('session-local failure')`),
      cwd: process.cwd(),
      provider,
      circuitBreaker: circuit,
      sandbox: { mode: 'read-only' },
      reliability: { ...FAST_RETRY, maxAttempts: 1, circuitBreakerThreshold: 1 },
    })

    await expect(run.result).resolves.toEqual(expectFailurePlaceholder())
    expect(circuit.snapshot()).toEqual({ state: 'closed', recentFailures: 0 })
  })

  it('revalidates circuit reservations after waiting for provider capacity', async () => {
    const starts: number[] = []
    let call = 0
    const provider: AgentProvider = {
      name: 'stale-circuit-fixture',
      automaticReplaySafety: 'safe',
      execute: async (): Promise<AgentProviderResult> => {
        const index = call++
        starts.push(Date.now())
        if (index === 0) {
          await new Promise((resolveWait) => setTimeout(resolveWait, 5))
          throw new AgentProviderFailure('provider outage', { retryable: true })
        }
        return { output: { type: 'text', text: `recovered-${index}` } }
      },
    }
    const run = runWorkflow({
      workflow: workflow(`
        return await parallel([0, 1, 2].map((index) => () => agent('stale-' + index)))
      `),
      cwd: process.cwd(),
      provider,
      sandbox: { mode: 'read-only' },
      limits: { concurrency: 1 },
      reliability: {
        ...FAST_RETRY,
        maxAttempts: 1,
        circuitBreakerThreshold: 1,
        circuitBreakerCooldownMs: 40,
        circuitBreakerWindowMs: 1_000,
      },
    })

    // Parallel result slots preserve task identity, while this intentionally invocation-indexed
    // fake assigns recovered-1/2 to whichever queued task the scheduler wakes first. The invariant
    // is one failed outage call plus two post-cooldown starts, not an ordering promise between the
    // two independent successful tasks.
    await expect(run.result).resolves.toEqual(expect.arrayContaining([
      expectFailurePlaceholder(),
      'recovered-1',
      'recovered-2',
    ]))
    expect(starts).toHaveLength(3)
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(30)
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

    await expect(run.result).resolves.toEqual(expectFailurePlaceholder())
    expect(provider.calls).toHaveLength(2)
    expect((await events).filter((event) => event.type === 'agent.retry_scheduled')).toHaveLength(1)
  })

  it('reports provider contract failures as honest coverage gaps', async () => {
    const provider: AgentProvider = {
      name: 'contract-provider',
      execute: async () => {
        throw new AgentProviderFailure('structured output was invalid', {
          code: 'structured-output-invalid',
          terminalDisposition: 'reject',
        })
      },
    }
    const run = runWorkflow({
      workflow: workflow(`return await agent('return structured output', { schema: { type: 'object' } })`),
      cwd: process.cwd(),
      provider,
    })

    const events = collect(run)
    await expect(run.result).resolves.toEqual(expectFailurePlaceholder())
    expect(projectWorkflowState(run.id, await events).status).toBe('completed_with_errors')
  })

  it('reserves one shared retry slot atomically across concurrent failures', async () => {
    const provider = new FakeAgentProvider([
      ...Array.from({ length: 3 }, (_, index): FakeProviderScript => ({
        delayMs: 5,
        outcome: {
          type: 'provider-failure',
          message: `simultaneous-outage-${index}`,
          retryable: true,
        },
      })),
      { outcome: { type: 'result', output: { type: 'text', text: 'only reserved retry' } } },
    ])
    const run = runWorkflow({
      workflow: workflow(`
        return await parallel([0, 1, 2].map((index) => () => agent('concurrent-' + index)))
      `),
      cwd: process.cwd(),
      provider,
      sandbox: { mode: 'read-only' },
      reliability: { ...FAST_RETRY, maxRetryAttemptsPerRun: 1 },
    })
    const events = collect(run)

    await expect(run.result).resolves.toEqual(expect.arrayContaining([
      expectFailurePlaceholder(),
      'only reserved retry',
    ]))
    expect(provider.calls).toHaveLength(4)
    expect((await events).filter((event) => event.type === 'agent.retry_scheduled')).toHaveLength(1)
  })

  it('does not automatically replay retryable failures from an unknown remote-effect provider', async () => {
    let calls = 0
    const provider: AgentProvider = {
      name: 'unknown-effects',
      execute: async () => {
        calls += 1
        throw new AgentProviderFailure('response lost after possible remote side effect', {
          retryable: true,
        })
      },
    }
    const run = runWorkflow({
      workflow: workflow(`return await agent('possibly mutating MCP call')`),
      cwd: process.cwd(),
      provider,
      sandbox: { mode: 'read-only' },
      // The ambiguity must remain visible even when policy says no retry would be admitted. This
      // catches the historical coupling that converted an unsafe final attempt to successful null.
      reliability: { ...FAST_RETRY, automaticRetry: 'never' },
    })

    const events = collect(run)
    await expect(run.result).resolves.toEqual(expectFailurePlaceholder('recovery_required'))
    expect(calls).toBe(1)
    const state = projectWorkflowState(run.id, await events)
    expect(state.agents[0]?.status).toBe('recovery_required')
    expect(state.agents[0]?.attempts[0]?.status).toBe('recovery_required')
    expect(state.counts.running).toBe(0)
  })

  it('keeps later agents and synthesis admissible after an ambiguous effect', async () => {
    let calls = 0
    let nestedResolutions = 0
    const provider: AgentProvider = {
      name: 'unknown-effects',
      execute: async () => {
        calls += 1
        if (calls > 1) return { output: { type: 'text', text: `healthy-${calls}` } }
        throw new AgentProviderFailure('lost response after possible mutation', { retryable: true })
      },
    }
    const run = runWorkflow({
      workflow: workflow(`
        const casualty = await agent('ambiguous first call')
        const sibling = await agent('healthy sibling')
        const nested = await workflow('healthy-child')
        const synthesis = await agent('final synthesis ' + JSON.stringify({ casualty, sibling, nested }))
        return { casualty, sibling, nested, synthesis }
      `),
      cwd: process.cwd(),
      provider,
      sandbox: { mode: 'read-only' },
      reliability: FAST_RETRY,
      resolveWorkflow: async () => {
        nestedResolutions += 1
        return workflow(`return 'child'`, 'healthy-child')
      },
    })
    const events = collect(run)

    await expect(run.result).resolves.toEqual({
      casualty: expectFailurePlaceholder('recovery_required'),
      sibling: 'healthy-2',
      nested: 'child',
      synthesis: 'healthy-3',
    })
    expect(calls).toBe(3)
    expect(nestedResolutions).toBe(1)
    const state = projectWorkflowState(run.id, await events)
    expect(state.status).toBe('completed_with_errors')
    expect(state.counts.total).toBe(3)
  })

  it('preserves an isolated workspace when an ambiguous attempt requires recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-recovery-workspace-'))
    let cleanups = 0
    const provider: AgentProvider = {
      name: 'unknown-effects',
      execute: async () => {
        throw new AgentProviderFailure('result lost after uncertain work', { retryable: true })
      },
    }
    const run = runWorkflow({
      workflow: workflow(`return await agent('uncertain worktree', { isolation: 'worktree' })`),
      cwd: process.cwd(),
      provider,
      sandbox: { mode: 'workspace-write' },
      prepareWorkingDirectory: async () => ({
        path: root,
        cleanup: async () => { cleanups += 1 },
      }),
      reliability: FAST_RETRY,
    })
    const events = collect(run)

    await expect(run.result).resolves.toEqual(expectFailurePlaceholder('recovery_required'))
    expect(cleanups).toBe(0)
    expect(await events).toContainEqual(expect.objectContaining({
      type: 'warning',
      payload: expect.objectContaining({ code: 'working-directory-preserved-for-recovery' }),
    }))
  })

  it('keeps a failed attempt failed when cancellation interrupts retry backoff', async () => {
    const provider = new FakeAgentProvider([
      { outcome: { type: 'provider-failure', message: 'retry later', retryable: true } },
      { outcome: { type: 'result', output: { type: 'text', text: 'must not run' } } },
    ])
    const run = runWorkflow({
      workflow: workflow(`return await agent('cancel backoff')`),
      cwd: process.cwd(),
      provider,
      // WHY this fixture opts into the read-only sandbox: automatic retry is deliberately refused
      // for writable attempts because a lost response may follow a real side effect. The behavior
      // under test starts only after a retry has legitimately been scheduled.
      sandbox: { mode: 'read-only' },
      reliability: {
        ...FAST_RETRY,
        retryBackoffBaseMs: 500,
        retryBackoffMaxMs: 500,
      },
    })
    const events = collect(run)
    for await (const event of run.events) {
      if (event.type !== 'agent.retry_scheduled') continue
      await run.cancel('cancel during retry delay')
      break
    }

    await expect(run.result).rejects.toThrow('cancel during retry delay')
    const state = projectWorkflowState(run.id, await events)
    expect(state.agents[0]?.status).toBe('cancelled')
    expect(state.agents[0]?.attempts[0]?.status).toBe('failed')
    expect(state.agents[0]?.retry).toBeUndefined()
    expect(provider.calls).toHaveLength(1)
  })

  it('detects an idle provider, aborts only that attempt, and resumes it', async () => {
    const source = workflow(`return await agent('stall then recover')`)
    const provider = new FakeAgentProvider([
      { sessionId: 'stalled-session', outcome: { type: 'wait-for-abort' } },
      { outcome: { type: 'result', output: { type: 'text', text: 'alive' } } },
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

  it('retains store ownership when an unconfirmed timeout becomes a coverage gap', async () => {
    const provider: AgentProvider = {
      name: 'unconfirmed-timeout',
      terminationBoundary: 'unconfirmed-descendants',
      // This deliberately models the macOS Codex failure which motivated the production fence:
      // AbortSignal reaches the wrapper, but neither wrapper settlement nor complete descendant
      // termination can be proven. The logical assignment must finish without making it safe for a
      // replacement supervisor to overlap the still-credentialed physical attempt.
      execute: () => new Promise<AgentProviderResult>(() => undefined),
    }
    const run = runWorkflow({
      workflow: workflow(`return await agent('stalls forever')`),
      cwd: process.cwd(),
      provider,
      sandbox: { mode: 'read-only' },
      limits: { cancellationGraceMs: 2 },
      reliability: {
        ...FAST_RETRY,
        maxAttempts: 1,
        startupTimeoutMs: 5,
        hardTerminationGraceMs: 2,
      },
    })

    await expect(run.result).resolves.toEqual(expectFailurePlaceholder('recovery_required'))
    expect(run.ownershipReleaseSafe?.()).toBe(false)
  })

  it('recovers one silent attempt among nine without cancelling its healthy siblings', async () => {
    const provider = new FakeAgentProvider([
      { sessionId: 'silent-session', outcome: { type: 'wait-for-abort' } },
      ...Array.from({ length: 8 }, (_, index): FakeProviderScript => ({
        // Finish before the deliberately tiny idle deadline; only the first fixture is silent.
        delayMs: 5,
        outcome: { type: 'result', output: { type: 'text', text: `healthy-${index}` } },
      })),
      { outcome: { type: 'result', output: { type: 'text', text: 'silent-recovered' } } },
    ])
    const run = runWorkflow({
      workflow: workflow(`
        return await parallel(Array.from({ length: 9 }, (_, index) => () => agent('peer-' + index)))
      `),
      cwd: process.cwd(),
      provider,
      limits: { concurrency: 9, cancellationGraceMs: 5 },
      sandbox: { mode: 'read-only' },
      reliability: { ...FAST_RETRY, idleTimeoutMs: 20 },
    })
    const events = collect(run)

    await expect(run.result).resolves.toEqual(expect.arrayContaining([
      'silent-recovered',
      ...Array.from({ length: 8 }, (_, index) => `healthy-${index}`),
    ]))
    const captured = await events
    expect(captured.filter((event) => event.type === 'agent.completed')).toHaveLength(9)
    expect(captured.some((event) => event.type === 'agent.cancelled')).toBe(false)
    expect(provider.maxConcurrentExecutions).toBe(9)
  })

  it('emits a soft-stall diagnostic without cancelling a healthy quiet attempt', async () => {
    const provider = new FakeAgentProvider([{
      delayMs: 40,
      outcome: { type: 'result', output: { type: 'text', text: 'quietly healthy' } },
    }])
    const run = runWorkflow({
      workflow: workflow(`return await agent('quiet reasoning')`),
      cwd: process.cwd(),
      provider,
      reliability: {
        ...FAST_RETRY,
        softStallTimeoutMs: 10,
        idleTimeoutMs: 100,
        attemptTimeoutMs: 200,
      },
    })
    const events = collect(run)

    await expect(run.result).resolves.toBe('quietly healthy')
    const captured = await events
    expect(captured).toContainEqual(expect.objectContaining({
      type: 'warning',
      payload: expect.objectContaining({ code: 'agent-soft-stall' }),
    }))
    expect(captured.some((event) => event.type === 'agent.stalled')).toBe(false)
  })

  it('keeps a successful result which arrives during timeout cancellation grace', async () => {
    let calls = 0
    const provider: AgentProvider = {
      name: 'grace-success',
      automaticReplaySafety: 'safe',
      execute: async (_request, context) => {
        calls += 1
        await context.emit({
          type: 'session.started',
          session: { provider: 'grace-success', id: 'late-success' },
        })
        // Deliberately ignore AbortSignal: the provider wins inside cancellation grace after the
        // absolute attempt timer. The completed result is authoritative and must not be replayed.
        await new Promise((resolveWait) => setTimeout(resolveWait, 30))
        return { output: { type: 'text', text: 'late but successful' } }
      },
    }
    const run = runWorkflow({
      workflow: workflow(`return await agent('finish near deadline')`),
      cwd: process.cwd(),
      provider,
      limits: { cancellationGraceMs: 30 },
      reliability: {
        ...FAST_RETRY,
        attemptTimeoutMs: 20,
        activeOperationTimeoutMs: 100,
        idleTimeoutMs: 100,
      },
    })

    await expect(run.result).resolves.toBe('late but successful')
    expect(calls).toBe(1)
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

  it('uses a heartbeat cadence below a configured sub-five-second worker deadline', async () => {
    const run = runWorkflow({
      workflow: workflow(`return await agent('long provider call with quiet evaluator')`),
      cwd: process.cwd(),
      provider: new FakeAgentProvider([{
        // Longer than the configured watchdog, so the old fixed 5s heartbeat deterministically
        // fails; short enough that this remains a focused regression test.
        delayMs: 1_250,
        outcome: { type: 'result', output: { type: 'text', text: 'worker stayed alive' } },
      }]),
      reliability: {
        ...FAST_RETRY,
        // WHY these provider deadlines exceed the scripted quiet call: this test isolates the
        // evaluator heartbeat contract. Letting the independent provider-idle watchdog fire first
        // would return null for the right production reason while proving nothing about heartbeat
        // cadence below the old hard-coded five seconds.
        idleTimeoutMs: 3_000,
        activeOperationTimeoutMs: 3_000,
        attemptTimeoutMs: 4_000,
        // One second still proves the cadence is policy-derived and below five seconds, while
        // allowing a busy CI host to deschedule the evaluator for more than a few dozen ms.
        workerHeartbeatTimeoutMs: 1_000,
        workerIdleTimeoutMs: 4_000,
        workerStartupTimeoutMs: 4_000,
      },
    })

    await expect(run.result).resolves.toBe('worker stayed alive')
  })

  it('does not make a tracked failure wait for its own promise to settle', async () => {
    const startedAt = Date.now()
    const run = runWorkflow({
      workflow: workflow(`return await agent('event sink fails')`),
      cwd: process.cwd(),
      provider: new FakeAgentProvider([{
        outcome: { type: 'result', output: { type: 'text', text: 'unreachable' } },
      }]),
      eventSink: async (event) => {
        if (event.type === 'agent.queued') throw new Error('persistent event sink failed')
      },
      // Make the counterfactual visible without a brittle wall-clock race: the old self-dependency
      // had to consume this full one-second grace; the fixed path does not wait for it at all.
      limits: { cancellationGraceMs: 1_000 },
      reliability: {
        ...FAST_RETRY,
        hardTerminationGraceMs: 10,
        cleanupTimeoutMs: 10,
      },
    })

    await expect(run.result).rejects.toThrow('persistent event sink failed')
    expect(Date.now() - startedAt).toBeLessThan(750)
  })

  it('escalates provider termination while cancellation diagnostics are permanently blocked', async () => {
    let markStarted!: () => void
    const started = new Promise<void>((resolveStarted) => { markStarted = resolveStarted })
    let rejectExecution!: (error: unknown) => void
    let terminatedAt: number | undefined
    const provider: AgentProvider = {
      name: 'blocked-storage-fixture',
      execute: async (_request, context): Promise<AgentProviderResult> => {
        await context.emit({
          type: 'session.started',
          session: { provider: 'blocked-storage-fixture', id: 'session-1' },
        })
        markStarted()
        return new Promise<AgentProviderResult>((_resolve, reject) => { rejectExecution = reject })
      },
      terminateAttempt: async () => {
        terminatedAt = Date.now()
        rejectExecution(new AgentProviderAbortError('terminated despite blocked diagnostics'))
      },
    }
    const run = runWorkflow({
      workflow: workflow(`return await agent('must terminate')`),
      cwd: process.cwd(),
      provider,
      eventSink: (event) => event.type === 'run.cancellation_requested'
        ? new Promise<void>(() => undefined)
        : Promise.resolve(),
      limits: { cancellationGraceMs: 5 },
      reliability: {
        ...FAST_RETRY,
        hardTerminationGraceMs: 10,
        cleanupTimeoutMs: 10,
        eventSinkTimeoutMs: 250,
      },
    })
    await started
    const cancelledAt = Date.now()
    const cancelling = run.cancel('blocked storage cancellation')

    while (terminatedAt === undefined && Date.now() - cancelledAt < 150) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 2))
    }
    expect(terminatedAt).toBeDefined()
    expect(terminatedAt! - cancelledAt).toBeLessThan(150)
    await expect(cancelling).rejects.toMatchObject({ code: 'workflow-storage-degraded' })
    await expect(run.result).rejects.toThrow('blocked storage cancellation')
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

  it('retains cleanup capacity until timed-out cleanup promises actually settle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-cleanup-capacity-'))
    const cleanupStarts: number[] = []
    let activeCleanups = 0
    let maxActiveCleanups = 0
    const run = runWorkflow({
      workflow: workflow(`
        return await parallel([0, 1].map((index) => () => agent('cleanup-' + index, { isolation: 'worktree' })))
      `),
      cwd: process.cwd(),
      provider: new FakeAgentProvider([
        { outcome: { type: 'result', output: { type: 'text', text: 'one' } } },
        { outcome: { type: 'result', output: { type: 'text', text: 'two' } } },
      ]),
      prepareWorkingDirectory: async () => ({
        path: root,
        cleanup: async () => {
          cleanupStarts.push(Date.now())
          activeCleanups += 1
          maxActiveCleanups = Math.max(maxActiveCleanups, activeCleanups)
          await new Promise((resolveWait) => setTimeout(resolveWait, 35))
          activeCleanups -= 1
        },
      }),
      reliability: {
        ...FAST_RETRY,
        cleanupConcurrency: 1,
        cleanupTimeoutMs: 5,
      },
    })

    await expect(run.result).resolves.toEqual(['one', 'two'])
    await run.waitForOwnershipRelease?.()
    expect(maxActiveCleanups).toBe(1)
    expect(cleanupStarts[1]! - cleanupStarts[0]!).toBeGreaterThanOrEqual(25)
  })

  it('retains preparation capacity and cleans a workspace created after timeout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-preparation-capacity-'))
    const preparationStarts: number[] = []
    let activePreparations = 0
    let maxActivePreparations = 0
    let lateCleanups = 0
    const fake = new FakeAgentProvider([
      { outcome: { type: 'result', output: { type: 'text', text: 'second prepared' } } },
    ])
    const provider: AgentProvider = {
      name: fake.name,
      automaticReplaySafety: fake.automaticReplaySafety,
      recoveryFingerprint: fake.recoveryFingerprint,
      // Preparation happens before provider admission. Its ownership fence must therefore settle
      // even when the eventual provider cannot prove descendant termination.
      terminationBoundary: 'unconfirmed-descendants',
      execute: (request, context) => fake.execute(request, context),
    }
    const run = runWorkflow({
      workflow: workflow(`
        return await parallel([0, 1].map((index) => async () => {
          try {
            return await agent('preparation-' + index, { isolation: 'worktree' })
          } catch (error) {
            return 'preparation-failed-' + index
          }
        }))
      `),
      cwd: process.cwd(),
      provider,
      prepareWorkingDirectory: async () => {
        const index = preparationStarts.length
        preparationStarts.push(Date.now())
        activePreparations += 1
        maxActivePreparations = Math.max(maxActivePreparations, activePreparations)
        if (index === 0) await new Promise((resolveWait) => setTimeout(resolveWait, 35))
        activePreparations -= 1
        return {
          path: root,
          cleanup: async () => { if (index === 0) lateCleanups += 1 },
        }
      },
      reliability: {
        ...FAST_RETRY,
        preparationConcurrency: 1,
        preparationTimeoutMs: 5,
      },
    })

    await expect(run.result).resolves.toEqual([expectFailurePlaceholder(), 'second prepared'])
    await run.waitForOwnershipRelease?.()
    expect(maxActivePreparations).toBe(1)
    expect(preparationStarts[1]! - preparationStarts[0]!).toBeGreaterThanOrEqual(25)
    expect(lateCleanups).toBe(1)
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
    const seedLease = await seed.acquireLease('running-recovery-seed')
    await seed.initialize()
    await seed.createRun({
      runId: 'run_crashed',
      cwd,
      workflow: source,
      automaticReplaySafe: true,
      providerRecoveryFingerprint: 'fake-provider:fake:v1',
    })
    await seed.appendEvent('run_crashed', {
      schemaVersion: 1,
      runId: 'run_crashed',
      sequence: 1,
      eventId: 'event_started',
      timestamp: new Date().toISOString(),
      type: 'run.started',
      payload: { workflow: { name: source.meta.name, description: source.meta.description } },
    })
    await seedLease.release()

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

  it('automatically continues an untouched queued manifest even when general replay is unsafe', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'workflow-queued-recovery-project-'))
    const storeRoot = join(cwd, 'state')
    const source = workflow(`return await agent('recover untouched queue')`, 'queued-recovery')
    const seed = new FileWorkflowStore(storeRoot)
    const seedLease = await seed.acquireLease('queued-recovery-seed')
    await seed.initialize()
    await seed.createRun({
      runId: 'run_queued_crash',
      cwd,
      workflow: source,
      // No event means no evaluator/provider call began. Recovery is safe independently of the
      // provider's policy and closes the createRun-before-run.started crash window.
      automaticReplaySafe: false,
    })
    await seedLease.release()

    const service = new WorkflowService({
      store: new FileWorkflowStore(storeRoot),
      provider: new FakeAgentProvider([
        { outcome: { type: 'result', output: { type: 'text', text: 'queued recovered' } } },
      ]),
    })
    await service.initialize()
    const recovered = (await new FileWorkflowStore(storeRoot).listManifests())
      .find((manifest) => manifest.resumedFromRunId === 'run_queued_crash')
    expect(recovered).toBeDefined()
    if (!recovered) throw new Error('Queued automatic recovery run was not created')

    for (let attempt = 0; attempt < 200; attempt += 1) {
      if ((await service.status({ cwd }, recovered.runId)).status === 'completed') break
      await new Promise((resolveWait) => setTimeout(resolveWait, 5))
    }
    await expect(service.status({ cwd }, recovered.runId)).resolves.toMatchObject({
      status: 'completed',
      recoveryMode: 'automatic',
    })
    await service.stop()
  })

  it('honors initialization recovery opt-out for an unstarted interrupted run', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'workflow-recovery-opt-out-'))
    const storeRoot = join(cwd, 'state')
    const source = workflow(`return await agent('must remain stopped')`, 'recovery-opt-out')
    const seed = new FileWorkflowStore(storeRoot)
    const lease = await seed.acquireLease('recovery-opt-out-seed')
    await seed.initialize()
    await seed.createRun({ runId: 'run_recovery_opt_out', cwd, workflow: source })
    await seed.appendEvent('run_recovery_opt_out', {
      schemaVersion: 1,
      runId: 'run_recovery_opt_out',
      sequence: 1,
      eventId: 'event_recovery_opt_out_interrupted',
      timestamp: new Date().toISOString(),
      type: 'run.interrupted',
      payload: { reason: 'fixture stopped before evaluator admission' },
    })
    await lease.release()

    const provider = new FakeAgentProvider([])
    const service = new WorkflowService({
      store: new FileWorkflowStore(storeRoot),
      provider,
      recovery: { autoResumeOnInitialize: false },
    })
    await service.initialize()

    const manifests = await new FileWorkflowStore(storeRoot).listManifests()
    expect(manifests.some((manifest) => manifest.resumedFromRunId === 'run_recovery_opt_out')).toBe(false)
    expect(provider.calls).toHaveLength(0)
    await service.stop()
  })

  it('recovers an interrupted handoff exactly once and preserves its MCP client scope', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'workflow-handoff-recovery-'))
    const storeRoot = join(cwd, 'state')
    const source = workflow(`return await agent('recover handoff')`, 'handoff-recovery')
    const seed = new FileWorkflowStore(storeRoot)
    const seedLease = await seed.acquireLease('handoff-seed')
    await seed.initialize()
    await seed.createRun({
      runId: 'run_handoff_crash',
      cwd,
      workflow: source,
      clientId: 'renderer-client-7',
      automaticReplaySafe: true,
      providerRecoveryFingerprint: 'fake-provider:fake:v1',
    })
    await seed.appendEvent('run_handoff_crash', {
      schemaVersion: 1,
      runId: 'run_handoff_crash',
      sequence: 1,
      eventId: 'event_handoff_started',
      timestamp: new Date().toISOString(),
      type: 'run.started',
      payload: { workflow: { name: source.meta.name, description: source.meta.description } },
    })
    await seed.appendEvent('run_handoff_crash', {
      schemaVersion: 1,
      runId: 'run_handoff_crash',
      sequence: 2,
      eventId: 'event_handoff_interrupted',
      timestamp: new Date().toISOString(),
      type: 'run.interrupted',
      payload: { reason: 'host died between interruption and successor creation' },
    })
    await seedLease.release()

    const contexts: Array<{ clientId?: string }> = []
    const first = new WorkflowService({
      store: new FileWorkflowStore(storeRoot),
      providerRecoveryEvidence: () => ({
        fingerprint: 'fake-provider:fake:v1',
        automaticReplaySafe: true,
      }),
      provider: (context) => {
        contexts.push({ ...(context.clientId === undefined ? {} : { clientId: context.clientId }) })
        return new FakeAgentProvider([
          { outcome: { type: 'result', output: { type: 'text', text: 'handoff recovered' } } },
        ])
      },
    })
    await first.initialize()
    const successor = (await new FileWorkflowStore(storeRoot).listManifests())
      .find((manifest) => manifest.resumedFromRunId === 'run_handoff_crash')
    expect(successor).toBeDefined()
    if (!successor) throw new Error('Interrupted handoff was not recovered')
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if ((await first.status({ cwd }, successor.runId)).status === 'completed') break
      await new Promise((resolveWait) => setTimeout(resolveWait, 5))
    }
    expect(contexts).toEqual([{ clientId: 'renderer-client-7' }])
    await first.stop()

    const second = new WorkflowService({
      store: new FileWorkflowStore(storeRoot),
      provider: new FakeAgentProvider([]),
    })
    await second.initialize()
    expect((await new FileWorkflowStore(storeRoot).listManifests())
      .filter((manifest) => manifest.resumedFromRunId === 'run_handoff_crash')).toHaveLength(1)
    await second.stop()
  })

  it('interrupts but does not auto-replay a started run with unknown remote effects', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'workflow-unsafe-recovery-'))
    const storeRoot = join(cwd, 'state')
    const source = workflow(`return await agent('unsafe replay')`, 'unsafe-recovery')
    const seed = new FileWorkflowStore(storeRoot)
    const seedLease = await seed.acquireLease('unsafe-seed')
    await seed.initialize()
    await seed.createRun({
      runId: 'run_unsafe_crash',
      cwd,
      workflow: source,
      automaticReplaySafe: false,
    })
    await seed.appendEvent('run_unsafe_crash', {
      schemaVersion: 1,
      runId: 'run_unsafe_crash',
      sequence: 1,
      eventId: 'event_unsafe_started',
      timestamp: new Date().toISOString(),
      type: 'run.started',
      payload: { workflow: { name: source.meta.name, description: source.meta.description } },
    })
    await seedLease.release()

    const service = new WorkflowService({
      store: new FileWorkflowStore(storeRoot),
      provider: new FakeAgentProvider([]),
    })
    await service.initialize()
    const manifests = await new FileWorkflowStore(storeRoot).listManifests()
    expect(manifests.find((manifest) => manifest.runId === 'run_unsafe_crash')?.status)
      .toBe('interrupted')
    expect(manifests.some((manifest) => manifest.resumedFromRunId === 'run_unsafe_crash')).toBe(false)
    await service.stop()
  })

  it('does not trust an old provider-wide replay attestation when restart enables network access', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'workflow-network-recovery-'))
    const storeRoot = join(cwd, 'state')
    const source = workflow(`return await agent('networked replay')`, 'network-recovery')
    const seed = new FileWorkflowStore(storeRoot)
    const seedLease = await seed.acquireLease('network-seed')
    await seed.initialize()
    await seed.createRun({
      runId: 'run_network_crash',
      cwd,
      workflow: source,
      // Models a pre-fix manifest that persisted only provider-wide safety and lost the
      // request-specific network capability.
      automaticReplaySafe: true,
    })
    await seed.appendEvent('run_network_crash', {
      schemaVersion: 1,
      runId: 'run_network_crash',
      sequence: 1,
      eventId: 'event_network_started',
      timestamp: new Date().toISOString(),
      type: 'run.started',
      payload: { workflow: { name: source.meta.name, description: source.meta.description } },
    })
    await seedLease.release()

    const service = new WorkflowService({
      store: new FileWorkflowStore(storeRoot),
      provider: new FakeAgentProvider([]),
      sandbox: { mode: 'read-only', network: true },
    })
    await service.initialize()
    const manifests = await new FileWorkflowStore(storeRoot).listManifests()
    expect(manifests.find((manifest) => manifest.runId === 'run_network_crash')?.status)
      .toBe('interrupted')
    expect(manifests.some((manifest) => manifest.resumedFromRunId === 'run_network_crash')).toBe(false)
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
    const seedLease = await seed.acquireLease('sparse-recovery-seed')
    await seed.initialize()
    await seed.createRun({
      runId: 'run_sparse_crashed',
      cwd,
      workflow: source,
      automaticReplaySafe: true,
      providerRecoveryFingerprint: 'fake-provider:fake:v1',
    })
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
    await seedLease.release()

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

  it('uses exact-source sparse reuse for an unchanged manual resume beyond a journal gap', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'workflow-sparse-manual-recovery-'))
    const storeRoot = join(cwd, 'state')
    const source = workflow(`
      return await parallel(Array.from({ length: 6 }, (_, index) => () => agent('manual-' + index)))
    `, 'sparse-manual-recovery')
    const seed = new FileWorkflowStore(storeRoot)
    const lease = await seed.acquireLease('sparse-manual-seed')
    await seed.initialize()
    await seed.createRun({ runId: 'run_sparse_manual', cwd, workflow: source })
    await seed.appendEvent('run_sparse_manual', {
      schemaVersion: 1,
      runId: 'run_sparse_manual',
      sequence: 1,
      eventId: 'event_sparse_manual_started',
      timestamp: new Date().toISOString(),
      type: 'run.started',
      payload: { workflow: { name: source.meta.name, description: source.meta.description } },
    })
    await seed.appendEvent('run_sparse_manual', {
      schemaVersion: 1,
      runId: 'run_sparse_manual',
      sequence: 2,
      eventId: 'event_sparse_manual_interrupted',
      timestamp: new Date().toISOString(),
      type: 'run.interrupted',
      payload: { reason: 'fixture interruption' },
    })
    const journal = await PersistentWorkflowJournal.open(seed.journalPath('run_sparse_manual'))
    const prior = journal.beginRun({ workflowId: source.meta.name, sourceHash: source.sourceHash })
    for (let index = 0; index < 6; index += 1) {
      const decision = prior.admit({ agentId: `old-${index}`, prompt: `manual-${index}` })
      if (decision.reused) throw new Error('Fresh manual sparse fixture unexpectedly reused work')
      if (index !== 2) prior.recordResult(decision, `old-result-${index}`, { successful: true })
    }
    await lease.release()

    const provider = new FakeAgentProvider([{
      expect: { prompt: 'manual-2' },
      outcome: { type: 'result', output: { type: 'text', text: 'manual-recovered-2' } },
    }])
    const service = new WorkflowService({
      store: new FileWorkflowStore(storeRoot),
      provider,
      recovery: { autoResumeOnInitialize: false },
    })
    await service.initialize()
    const resumed = await service.resume({ cwd }, { runId: 'run_sparse_manual' })
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if ((await service.status({ cwd }, resumed.runId)).status === 'completed') break
      await new Promise((resolveWait) => setTimeout(resolveWait, 5))
    }
    const completed = (await new FileWorkflowStore(storeRoot).readEvents(resumed.runId, 0, 1_000))
      .events.find((stored) => stored.event.type === 'run.completed')
    expect(completed?.event).toMatchObject({
      type: 'run.completed',
      payload: { result: { content: [
        'old-result-0',
        'old-result-1',
        'manual-recovered-2',
        'old-result-3',
        'old-result-4',
        'old-result-5',
      ] } },
    })
    expect(provider.calls).toHaveLength(1)
    await service.stop()
  })

  it('isolates outage circuits by provider identity', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'workflow-provider-circuits-'))
    await mkdir(join(cwd, '.claude', 'workflows'), { recursive: true })
    await writeFile(
      join(cwd, '.claude', 'workflows', 'circuit.js'),
      `export const meta = { name: 'scoped-circuit', description: 'Provider circuit fixture' }
       return await agent('provider circuit')`,
    )
    const providers = [
      new FakeAgentProvider([
        { outcome: { type: 'provider-failure', message: 'provider-a down', retryable: true } },
      ], { providerName: 'provider-a' }),
      new FakeAgentProvider([
        { outcome: { type: 'result', output: { type: 'text', text: 'provider-b healthy' } } },
      ], { providerName: 'provider-b' }),
    ]
    const service = new WorkflowService({
      store: new FileWorkflowStore(join(cwd, 'state')),
      provider: () => {
        const provider = providers.shift()
        if (!provider) throw new Error('No circuit fixture provider remains')
        return provider
      },
      reliability: {
        ...FAST_RETRY,
        maxAttempts: 1,
        circuitBreakerThreshold: 1,
        circuitBreakerCooldownMs: 10_000,
        circuitBreakerWindowMs: 20_000,
      },
    })
    await service.initialize()
    const first = await service.start({ cwd }, { name: 'scoped-circuit' })
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if ((await service.status({ cwd }, first.runId)).status === 'completed') break
      await new Promise((resolveWait) => setTimeout(resolveWait, 5))
    }
    const second = await service.start({ cwd }, { name: 'scoped-circuit' })
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if ((await service.status({ cwd }, second.runId)).status === 'completed') break
      await new Promise((resolveWait) => setTimeout(resolveWait, 5))
    }

    await expect(service.health({ cwd }, first.runId)).resolves.toMatchObject({
      providerCircuit: { state: 'open', recentFailures: 1 },
    })
    await expect(service.health({ cwd }, second.runId)).resolves.toMatchObject({
      providerCircuit: { state: 'closed', recentFailures: 0 },
    })
    await service.stop()
  })

  it('fences a durable store to one live service owner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-owner-fence-'))
    const first = new FileWorkflowStore(root)
    const second = new FileWorkflowStore(root)
    const lease = await first.acquireLease('first')
    await first.initialize()
    await expect(second.acquireLease('second')).rejects.toMatchObject({ code: 'owner-conflict' })
    await expect(second.appendEvent('run_missing', {} as never)).rejects.toMatchObject({
      code: 'owner-conflict',
    })
    await expect(second.initialize()).rejects.toMatchObject({
      code: 'owner-conflict',
    })
    await lease.release()
    const replacement = await second.acquireLease('second')
    await replacement.release()
  })

  it('serializes concurrent initialize calls and an initialize-stop race', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-service-initialize-race-'))
    const service = new WorkflowService({
      store: new FileWorkflowStore(root),
      provider: new FakeAgentProvider([]),
    })
    await Promise.all([service.initialize(), service.initialize(), service.initialize()])
    await service.stop()

    const raced = new WorkflowService({
      store: new FileWorkflowStore(root),
      provider: new FakeAgentProvider([]),
    })
    const initializing = raced.initialize()
    const stopping = raced.stop('race initialization')
    await expect(initializing).rejects.toMatchObject({ code: 'service-stopped' })
    await stopping

    const replacement = new WorkflowService({
      store: new FileWorkflowStore(root),
      provider: new FakeAgentProvider([]),
    })
    await replacement.initialize()
    await replacement.stop()
  })

  it('does not launch recovery when stop arrives during the manifest scan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-service-scan-stop-race-'))
    let announceListStarted!: () => void
    let releaseList!: () => void
    const listStarted = new Promise<void>((resolveStarted) => { announceListStarted = resolveStarted })
    const listGate = new Promise<void>((resolveList) => { releaseList = resolveList })
    class GatedListStore extends FileWorkflowStore {
      override async listManifests() {
        announceListStarted()
        await listGate
        return super.listManifests()
      }
    }
    const service = new WorkflowService({
      store: new GatedListStore(root),
      provider: new FakeAgentProvider([]),
    })

    const initializing = service.initialize()
    await listStarted
    const stopping = service.stop('stop during durable manifest scan')
    releaseList()

    await expect(initializing).rejects.toMatchObject({ code: 'service-stopped' })
    await stopping
    await expect(service.initialize()).rejects.toMatchObject({ code: 'service-stopped' })

    // WHY a fresh service must acquire immediately: this assertion proves the losing initializer
    // did not merely reject its public promise while retaining the filesystem fence.
    const replacement = new WorkflowService({
      store: new FileWorkflowStore(root),
      provider: new FakeAgentProvider([]),
    })
    await replacement.initialize()
    await replacement.stop()
  })

  it('allows exactly one contender to atomically reclaim a malformed stale owner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-owner-reclaim-'))
    const stale = join(root, 'service-owner.lock')
    await mkdir(stale, { recursive: true })
    await writeFile(join(stale, 'owner.json'), '{}\n')
    const contenders = [new FileWorkflowStore(root), new FileWorkflowStore(root)]

    const claims = await Promise.allSettled([
      contenders[0]!.acquireLease('contender-a'),
      contenders[1]!.acquireLease('contender-b'),
    ])
    expect(claims.filter((claim) => claim.status === 'fulfilled')).toHaveLength(1)
    expect(claims.filter((claim) => claim.status === 'rejected')).toHaveLength(1)
    const winner = claims.find((claim) => claim.status === 'fulfilled')
    if (winner?.status !== 'fulfilled') throw new Error('No lease contender won')
    await winner.value.release()
  })

  it('reclaims a reused live PID only when its recorded process-start identity differs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-owner-pid-reuse-'))
    const stale = join(root, 'service-owner.lock')
    await mkdir(stale, { recursive: true })
    await writeFile(join(stale, 'owner.json'), `${JSON.stringify({
      ownerId: 'dead-generation',
      token: 'stale-token',
      generation: 1,
      pid: process.pid,
      processStartIdentity: 'Mon Jan 1 00:00:00 1900',
      acquiredAt: new Date(0).toISOString(),
    })}\n`)

    const replacement = await new FileWorkflowStore(root).acquireLease('replacement')
    await replacement.release()
  })

  it('retains store ownership when an adapter never confirms hard termination', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'workflow-unconfirmed-owner-'))
    await mkdir(join(cwd, '.claude', 'workflows'), { recursive: true })
    await writeFile(
      join(cwd, '.claude', 'workflows', 'unconfirmed.js'),
      `export const meta = { name: 'unconfirmed', description: 'Termination fence fixture' }
       return await agent('never settle')`,
    )
    let started!: () => void
    const providerStarted = new Promise<void>((resolveStarted) => { started = resolveStarted })
    const provider: AgentProvider = {
      name: 'unconfirmed-fixture',
      execute: async (_request, context) => {
        await context.emit({
          type: 'session.started',
          session: { provider: 'unconfirmed-fixture', id: 'stuck-session' },
        })
        started()
        return new Promise<AgentProviderResult>(() => undefined)
      },
      // The process-owning adapter claims the signal was delivered but the execution promise is
      // intentionally left alive. The service must trust settlement, not the hook's return value.
      terminateAttempt: async () => undefined,
    }
    const storeRoot = join(cwd, 'state')
    const service = new WorkflowService({
      store: new FileWorkflowStore(storeRoot),
      provider,
      limits: { cancellationGraceMs: 5 },
      reliability: {
        ...FAST_RETRY,
        hardTerminationGraceMs: 5,
        cleanupTimeoutMs: 5,
      },
    })
    await service.initialize()
    await service.start({ cwd }, { name: 'unconfirmed' })
    await providerStarted

    await expect(service.stop('exercise ownership fence')).rejects.toMatchObject({
      code: 'unsafe-provider-active',
    })
    await expect(new WorkflowService({
      store: new FileWorkflowStore(storeRoot),
      provider: new FakeAgentProvider([]),
    }).initialize()).rejects.toMatchObject({ code: 'owner-conflict' })
  })
})
