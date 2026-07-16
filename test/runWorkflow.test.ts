import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { FakeAgentProvider } from '../src/fakeProvider.js'
import type { FakeProviderScript } from '../src/fakeProvider.js'
import { parseWorkflowSource } from '../src/loadWorkflow.js'
import { createJournalKey, InMemoryWorkflowJournal } from '../src/workflowJournal.js'
import { runWorkflow } from '../src/runWorkflow.js'
import type { RunWorkflowOptions, WorkflowRun } from '../src/runWorkflow.js'
import { projectWorkflowState } from '../src/workflowState.js'
import type { WorkflowEvent } from '../src/workflowEvents.js'

function workflow(body: string, name = 'test') {
  return parseWorkflowSource(`export const meta = {
    name: ${JSON.stringify(name)},
    description: 'Execution test',
    phases: [{ title: 'Find' }, { title: 'Verify' }],
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

function start(
  source: ReturnType<typeof workflow>,
  scripts: readonly FakeProviderScript[],
  options: Partial<Omit<RunWorkflowOptions, 'workflow' | 'cwd' | 'provider'>> = {},
) {
  const provider = new FakeAgentProvider(scripts)
  const run = runWorkflow({
    workflow: source,
    cwd: process.cwd(),
    provider,
    ...options,
  })
  return { provider, run, events: collect(run) }
}

describe('workflow realm', () => {
  it('replays direct API events to an iterator attached after completion', async () => {
    const run = runWorkflow({
      workflow: workflow(`return 'late-reader'`),
      cwd: process.cwd(),
      provider: new FakeAgentProvider([]),
    })
    await expect(run.result).resolves.toBe('late-reader')
    const events: WorkflowEvent[] = []
    for await (const event of run.events) events.push(event)
    expect(events.map((event) => event.type)).toEqual([
      'run.started',
      'phase.discovered',
      'phase.discovered',
      'run.completed',
    ])
  })

  it('supports args, top-level await/return, phases, logs, timers, and budget snapshots', async () => {
    const source = workflow(`
      phase('Find')
      log('starting', args.name)
      await new Promise((resolve) => setTimeout(resolve, 5))
      return {
        greeting: 'hello ' + args.name,
        spent: budget.spent(),
        remaining: budget.remaining(),
      }
    `)
    const { run, events } = start(source, [], { args: { name: 'Ada' }, budgetTokens: 100 })

    await expect(run.result).resolves.toEqual({ greeting: 'hello Ada', spent: 0, remaining: 100 })
    const snapshot = projectWorkflowState(run.id, await events)
    expect(snapshot.status).toBe('completed')
    expect(snapshot.currentPhaseId).toBe(snapshot.phases[0]?.id)
    expect(snapshot.logs[0]?.message.content).toBe('starting Ada')
  })

  it('does not expose process or dynamic code generation and blocks nondeterministic globals', async () => {
    const source = workflow(`
      const errors = []
      for (const operation of [
        () => eval('1 + 1'),
        () => agent.constructor('return process')(),
        () => Date.now(),
        () => new Date(),
        () => Math.random(),
      ]) {
        try { operation() } catch (error) { errors.push(error.name) }
      }
      await Promise.resolve()
      return { processType: typeof process, requireType: typeof require, errors }
    `)
    const { run, events } = start(source, [])

    await expect(run.result).resolves.toEqual({
      processType: 'undefined',
      requireType: 'undefined',
      errors: ['EvalError', 'EvalError', 'Error', 'Error', 'Error'],
    })
    await events
  })

  it('never exposes host constructors through capability promises, results, or rejections', async () => {
    const source = workflow(`
      const checks = []
      const pending = agent('object result')
      for (const value of [pending]) {
        try { value.constructor.constructor('return process')(); checks.push('escaped') }
        catch (error) { checks.push(error.name) }
      }
      const result = await pending
      try { result.constructor.constructor('return process')(); checks.push('escaped') }
      catch (error) { checks.push(error.name) }
      try { await agent('rejection') }
      catch (rejection) {
        try { rejection.constructor.constructor('return process')(); checks.push('escaped') }
        catch (error) { checks.push(error.name) }
      }
      return checks
    `)
    const { run, events } = start(source, [
      { outcome: { type: 'result', output: { type: 'structured', value: { ok: true } } } },
      { outcome: { type: 'error', error: new Error('expected rejection') } },
    ])

    await expect(run.result).resolves.toEqual(['EvalError', 'EvalError', 'EvalError'])
    await events
  })

  it('terminates a synchronous infinite loop through the V8 timeout', async () => {
    const source = workflow(`while (true) {}`)
    const { run, events } = start(source, [], { limits: { synchronousTimeoutMs: 50 } })

    await expect(run.result).rejects.toThrow(/timed out/i)
    expect(projectWorkflowState(run.id, await events).status).toBe('failed')
  })

  it('uses the wall-clock kill as a backstop for an infinite loop after await', async () => {
    const source = workflow(`await Promise.resolve(); while (true) {}`)
    const { run, events } = start(source, [], {
      limits: { synchronousTimeoutMs: 50, wallClockTimeoutMs: 100, cancellationGraceMs: 25 },
    })

    await expect(run.result).rejects.toMatchObject({ name: 'AbortError' })
    expect(projectWorkflowState(run.id, await events).status).toBe('cancelled')
  })

  it('uses the wall-clock kill for an infinite timer callback outside vm.runInContext', async () => {
    const source = workflow(`
      await new Promise(() => setTimeout(() => { while (true) {} }, 0))
    `)
    const { run, events } = start(source, [], {
      limits: { synchronousTimeoutMs: 50, wallClockTimeoutMs: 100, cancellationGraceMs: 25 },
    })

    await expect(run.result).rejects.toMatchObject({ name: 'AbortError' })
    expect(projectWorkflowState(run.id, await events).status).toBe('cancelled')
  })

  it('preserves undefined as a valid top-level JavaScript result', async () => {
    const { run, events } = start(workflow('return undefined'), [])
    await expect(run.result).resolves.toBeUndefined()
    const completed = (await events).find((event) => event.type === 'run.completed')
    expect(completed?.payload.result.preview).toBe('undefined')
  })
})

describe('agent scheduling and helpers', () => {
  it('runs 17 logical agents under the shared cap while preserving result and phase order', async () => {
    const scripts: FakeProviderScript[] = Array.from({ length: 17 }, (_, index) => ({
      delayMs: (17 - index) * 2,
      outcome: { type: 'result', output: { type: 'text', text: `result-${index}` } },
    }))
    const source = workflow(`
      phase('Find')
      return await parallel(Array.from({ length: 17 }, (_, index) => () => agent('finder-' + index)))
    `)
    const { provider, run, events } = start(source, scripts, { limits: { concurrency: 4 } })

    await expect(run.result).resolves.toEqual(Array.from({ length: 17 }, (_, index) => `result-${index}`))
    const snapshot = projectWorkflowState(run.id, await events)
    const find = snapshot.phases.find((phase) => phase.title === 'Find')
    expect(find?.agentIds).toHaveLength(17)
    expect(find?.agentIds).toEqual(snapshot.agents.map((agent) => agent.id))
    expect(snapshot.counts).toMatchObject({ total: 17, completed: 17, attempts: 17 })
    expect(provider.maxConcurrentExecutions).toBe(4)
    expect(provider.completionOrder).not.toEqual(Array.from({ length: 17 }, (_, index) => index))
  })

  it('lets pipeline items advance without a stage barrier and skips only null', async () => {
    const source = workflow(`
      return await pipeline(
        [1, 2, 3],
        (value) => agent('first:' + value),
        (value, original) => agent('second:' + value + ':' + original),
      )
    `)
    const { provider, run, events } = start(source, [
      { delayMs: 5, outcome: { type: 'result', output: { type: 'structured', value: 2 } } },
      { delayMs: 30, outcome: { type: 'result', output: { type: 'structured', value: null } } },
      { delayMs: 40, outcome: { type: 'result', output: { type: 'structured', value: 4 } } },
      { outcome: { type: 'result', output: { type: 'structured', value: 20 } } },
      { outcome: { type: 'result', output: { type: 'structured', value: 40 } } },
    ], { limits: { concurrency: 5 } })

    await expect(run.result).resolves.toEqual([20, null, 40])
    await events
    expect(provider.calls.map((call) => call.request.prompt)).toEqual([
      'first:1',
      'first:2',
      'first:3',
      'second:2:1',
      'second:4:3',
    ])
    expect(provider.completionOrder.indexOf(3)).toBeLessThan(provider.completionOrder.indexOf(2))
  })

  it('turns provider failures and rejected parallel slots into independent null results', async () => {
    const source = workflow(`
      return await parallel([
        () => agent('provider failure'),
        () => agent('ordinary error'),
      ])
    `)
    const { run, events } = start(source, [
      { outcome: { type: 'provider-failure', message: 'service unavailable', code: 'unavailable' } },
      { outcome: { type: 'error', error: new Error('adapter bug') } },
    ])

    await expect(run.result).resolves.toEqual([null, null])
    const snapshot = projectWorkflowState(run.id, await events)
    expect(snapshot.counts.failed).toBe(2)
    expect(snapshot.warnings.some((warning) => warning.code === 'unavailable')).toBe(true)
    expect(snapshot.logs.some((log) => String(log.message.content).includes('parallel() entry failed'))).toBe(true)
  })

  it('validates schemas before provider execution and validates structured results afterward', async () => {
    const invalidSchema = workflow(`
      return await agent('bad schema', { schema: { type: 'definitely-not-json-schema' } })
    `)
    const first = start(invalidSchema, [])
    await expect(first.run.result).rejects.toThrow(/invalid workflow agent schema/i)
    expect(first.provider.calls).toHaveLength(0)
    await first.events

    const invalidResult = workflow(`
      return await agent('bad result', {
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' } },
          required: ['ok'],
          additionalProperties: false,
        },
      })
    `)
    const second = start(invalidResult, [
      { outcome: { type: 'result', output: { type: 'structured', value: { ok: 'no' } } } },
    ])
    await expect(second.run.result).rejects.toThrow(/schema validation/i)
    expect(projectWorkflowState(second.run.id, await second.events).status).toBe('failed')
  })

  it('counts output tokens and throws the Claude-named budget error before allocating identity', async () => {
    const source = workflow(`
      try {
        const first = await agent('first')
        await agent('second')
      } catch (error) {
        return [error.name, error.message, budget.spent(), budget.remaining()]
      }
      return 'unreachable'
    `)
    const { provider, run, events } = start(source, [
      {
        outcome: {
          type: 'result',
          output: { type: 'text', text: 'one' },
          usage: { inputTokens: 99, outputTokens: 2, totalTokens: 101 },
        },
      },
    ], { budgetTokens: 2 })

    // The name and catchability are Claude's realm contract: a portable workflow may branch on
    // `error.name === 'WorkflowBudgetExceededError'`, and the refused call must leave no agent
    // record because Claude refuses before computing a call index or journal key.
    await expect(run.result).resolves.toEqual([
      'WorkflowBudgetExceededError',
      expect.stringMatching(/token budget exceeded \(2 \/ 2 output tokens\)/i),
      2,
      0,
    ])
    const snapshot = projectWorkflowState(run.id, await events)
    expect(snapshot.counts).toMatchObject({ total: 1, completed: 1, failed: 0 })
    expect(snapshot.warnings.some((warning) => warning.code === 'workflow-budget-exceeded')).toBe(true)
    expect(provider.calls).toHaveLength(1)
  })

  it('drops budget-exceeded parallel slots to null with one aggregate log line', async () => {
    const source = workflow(`
      const first = await agent('first')
      const slots = await parallel([() => agent('second'), () => agent('third')])
      return [first, ...slots]
    `)
    const { provider, run, events } = start(source, [
      {
        outcome: {
          type: 'result',
          output: { type: 'text', text: 'one' },
          usage: { inputTokens: 1, outputTokens: 5 },
        },
      },
    ], { budgetTokens: 5 })

    await expect(run.result).resolves.toEqual(['one', null, null])
    const snapshot = projectWorkflowState(run.id, await events)
    expect(snapshot.logs.some((log) =>
      log.message.preview.includes('parallel: 2 slots dropped'),
    )).toBe(true)
    expect(provider.calls).toHaveLength(1)
  })

  it('rejects invalid budgets and enforces caller-supplied value limits in the parent', async () => {
    expect(() => start(workflow(`return null`), [], { budgetTokens: Number.NaN })).toThrow(
      /budgetTokens/,
    )

    const oversizedArgs = start(workflow(`return args`), [], {
      args: [1, 2, 3],
      limits: { maxCollectionItems: 2 },
    })
    await expect(oversizedArgs.run.result).rejects.toThrow(/exceeds 2 entries/)
    await oversizedArgs.events
  })

  it('normalizes provider activities and synthesizes a start for completion-only streams', async () => {
    const source = workflow(`return await agent('inspect')`)
    const { run, events } = start(source, [
      {
        events: [
          {
            event: {
              type: 'activity.completed',
              activity: { id: 'command-1', kind: 'command', title: 'pwd', content: { exitCode: 0 } },
            },
          },
        ],
        outcome: { type: 'result', output: { type: 'text', text: 'done' } },
      },
    ])

    await expect(run.result).resolves.toBe('done')
    const snapshot = projectWorkflowState(run.id, await events)
    expect(snapshot.agents[0]?.attempts[0]?.activities).toMatchObject([
      { activityId: 'command-1', kind: 'command', title: 'pwd', status: 'completed' },
    ])
  })
})

describe('cancellation, journal, and composition', () => {
  it('aborts a live provider and leaves one cancelled terminal state', async () => {
    const source = workflow(`return await agent('wait')`)
    const { provider, run, events } = start(source, [
      { outcome: { type: 'wait-for-abort' } },
    ], { limits: { cancellationGraceMs: 100 } })
    const rejected = expect(run.result).rejects.toMatchObject({ name: 'AbortError' })

    while (provider.activeExecutions === 0) await new Promise((resolveWait) => setTimeout(resolveWait, 2))
    await run.cancel('user stopped the run')
    await rejected
    const snapshot = projectWorkflowState(run.id, await events)
    expect(snapshot.status).toBe('cancelled')
    expect(snapshot.counts.cancelled).toBe(1)
    expect(provider.activeExecutions).toBe(0)
  })

  it('cancels queued agents without inventing provider attempts', async () => {
    const source = workflow(`
      return await parallel([
        () => agent('first'),
        () => agent('second'),
        () => agent('third'),
      ])
    `)
    const { provider, run, events } = start(source, [
      { outcome: { type: 'wait-for-abort' } },
    ], { limits: { concurrency: 1, cancellationGraceMs: 100 } })
    const rejected = expect(run.result).rejects.toMatchObject({ name: 'AbortError' })

    // Provider start can win the IPC race before the worker's next two synchronous requests reach
    // the parent. Wait for the state this test names instead of sleeping and assuming host speed.
    let queued = 0
    for await (const event of run.events) {
      if (event.type === 'agent.queued') queued += 1
      if (queued === 3) break
    }
    while (provider.activeExecutions === 0) await new Promise((resolveWait) => setTimeout(resolveWait, 2))
    await run.cancel('stop queued work')
    await rejected
    const snapshot = projectWorkflowState(run.id, await events)
    expect(snapshot.counts.cancelled).toBe(3)
    expect(snapshot.agents.map((agent) => agent.attempts.length)).toEqual([1, 0, 0])
  })

  it('fails and aborts an unawaited capability call instead of leaking it after completion', async () => {
    const source = workflow(`agent('detached'); return 'premature'`)
    const { provider, run, events } = start(source, [
      { outcome: { type: 'wait-for-abort' } },
    ], { limits: { cancellationGraceMs: 100, wallClockTimeoutMs: 1_000 } })

    await expect(run.result).rejects.toMatchObject({ code: 'detached-capability' })
    expect(projectWorkflowState(run.id, await events).status).toBe('failed')
    expect(provider.activeExecutions).toBe(0)
  })

  it('lets completion atomically win a concurrent cancellation request', async () => {
    let completionEntered!: () => void
    const entered = new Promise<void>((resolveEntered) => { completionEntered = resolveEntered })
    let releaseCompletion!: () => void
    const release = new Promise<void>((resolveRelease) => { releaseCompletion = resolveRelease })
    const source = workflow(`return 'done'`)
    const { run, events } = start(source, [], {
      eventSink: async (event) => {
        if (event.type !== 'run.completed') return
        completionEntered()
        await release
      },
    })

    await entered
    const cancel = run.cancel('too late')
    releaseCompletion()
    await cancel
    await expect(run.result).resolves.toBe('done')
    const terminalTypes = (await events)
      .map((event) => event.type)
      .filter((type) => type === 'run.completed' || type === 'run.failed' || type === 'run.cancelled')
    expect(terminalTypes).toEqual(['run.completed'])
  })

  it('materializes journal reuse as a completed logical agent without a provider attempt', async () => {
    const source = workflow(`return await agent('same', { model: 'test-model' })`, 'journal-test')
    const journal = new InMemoryWorkflowJournal()
    const first = start(source, [
      { outcome: { type: 'result', output: { type: 'structured', value: { value: 1 } } } },
    ], { journal })
    await expect(first.run.result).resolves.toEqual({ value: 1 })
    await first.events

    const second = start(source, [], { journal })
    await expect(second.run.result).resolves.toEqual({ value: 1 })
    const snapshot = projectWorkflowState(second.run.id, await second.events)
    expect(snapshot.counts).toMatchObject({ total: 1, completed: 1, reused: 1, attempts: 0 })
    expect(snapshot.agents[0]?.outcome?.source).toBe('journal')
    expect(second.provider.calls).toHaveLength(0)
  })

  it('keeps journal keys compatible when runtime defaults affect only provider execution', async () => {
    const source = workflow(`return await agent('same')`, 'journal-defaults')
    const journal = new InMemoryWorkflowJournal()
    const first = start(source, [
      {
        expect: { model: 'runtime-default' },
        outcome: { type: 'result', output: { type: 'text', text: 'done' } },
      },
    ], { journal, defaultModel: 'runtime-default', defaultEffort: 'high' })

    await expect(first.run.result).resolves.toBe('done')
    await first.events
    const snapshot = journal.getSnapshot(source.meta.name)
    expect(snapshot?.records[0]?.key).toBe(createJournalKey('', 'same', {}))
  })

  it('retains schema-backed scalar identity after journal reuse', async () => {
    const source = workflow(`
      return await agent('scalar', { schema: { type: 'string' } })
    `, 'journal-scalar')
    const journal = new InMemoryWorkflowJournal()
    const first = start(source, [
      { outcome: { type: 'result', output: { type: 'structured', value: 'yes' } } },
    ], { journal })
    await expect(first.run.result).resolves.toBe('yes')
    await first.events

    const second = start(source, [], { journal })
    await expect(second.run.result).resolves.toBe('yes')
    const snapshot = projectWorkflowState(second.run.id, await second.events)
    expect(snapshot.agents[0]?.outcome).toMatchObject({ source: 'journal', structured: true })
  })

  it('revalidates historical structured output before returning a journal hit', async () => {
    const schema = {
      type: 'object',
      properties: { ok: { type: 'boolean' } },
      required: ['ok'],
      additionalProperties: false,
    }
    const source = workflow(`return await agent('cached', { schema: ${JSON.stringify(schema)} })`, 'journal-schema-validation')
    const key = createJournalKey('', 'cached', { schema })
    const journal = new InMemoryWorkflowJournal([{
      workflowId: source.meta.name,
      sourceHash: source.sourceHash,
      records: [
        { type: 'started', key, agentId: 'legacy-agent' },
        { type: 'result', key, agentId: 'legacy-agent', result: { ok: 'not-boolean' }, successful: true },
      ],
    }])

    const run = start(source, [], { journal })
    await expect(run.run.result).rejects.toThrow(/reused agent output failed schema validation/i)
    expect(run.provider.calls).toHaveLength(0)
    expect(projectWorkflowState(run.run.id, await run.events).status).toBe('failed')
  })

  it('records an interrupted provider session and resumes it on the next matching run', async () => {
    const source = workflow(`return await agent('resume me')`, 'provider-resume')
    const journal = new InMemoryWorkflowJournal()
    const first = start(source, [
      { sessionId: 'session-to-resume', outcome: { type: 'wait-for-abort' } },
    ], { journal, limits: { cancellationGraceMs: 100 } })
    const rejected = expect(first.run.result).rejects.toMatchObject({ name: 'AbortError' })
    while (first.provider.activeExecutions === 0) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 2))
    }
    await first.run.cancel('interrupt')
    await rejected
    await first.events

    const second = start(source, [
      {
        expect: { sessionId: 'session-to-resume' },
        outcome: { type: 'result', output: { type: 'text', text: 'resumed' } },
      },
    ], { journal })
    await expect(second.run.result).resolves.toBe('resumed')
    const snapshot = projectWorkflowState(second.run.id, await second.events)
    expect(snapshot.agents[0]?.attempts[0]).toMatchObject({
      source: 'provider-resume',
      providerSession: { provider: 'fake', id: 'session-to-resume' },
    })
    expect(second.provider.calls[0]?.request.session).toEqual({
      provider: 'fake',
      id: 'session-to-resume',
    })
  })

  it('runs one child workflow under a synthetic phase and rejects a second nesting level', async () => {
    const parent = workflow(`return await workflow('child', { value: 3 })`, 'parent')
    const child = workflow(`
      phase('Ignored child phase')
      log('child log')
      return await agent('child:' + args.value)
    `, 'child')
    const { provider, run, events } = start(parent, [
      { expect: { prompt: 'child:3' }, outcome: { type: 'result', output: { type: 'text', text: 'child result' } } },
    ], {
      resolveWorkflow: async (target) => {
        expect(target).toBe('child')
        return child
      },
    })

    await expect(run.result).resolves.toBe('child result')
    const snapshot = projectWorkflowState(run.id, await events)
    expect(snapshot.phases.map((phase) => phase.title)).toContain('workflow:child')
    expect(snapshot.phases.map((phase) => phase.title)).not.toContain('Ignored child phase')
    const childPhase = snapshot.phases.find((phase) => phase.title === 'workflow:child')
    expect(snapshot.agents[0]?.phaseId).toBe(childPhase?.id)
    expect(snapshot.logs.some((log) => log.message.content === '[child] child log')).toBe(true)
    expect(provider.calls).toHaveLength(1)

    const recursiveChild = workflow(`return await workflow('grandchild')`, 'recursive-child')
    const recursive = start(parent, [], { resolveWorkflow: async () => recursiveChild })
    await expect(recursive.run.result).rejects.toThrow(/cannot invoke another workflow/i)
    expect(projectWorkflowState(recursive.run.id, await recursive.events).status).toBe('failed')
  })

  it('reuses a nested workflow prefix when edited child source keeps the same call', async () => {
    const parent = workflow(`return await workflow('child')`, 'journal-parent')
    const childOne = workflow(`return await agent('same child prompt')`, 'child')
    const childTwo = workflow(`log('changed source'); return await agent('same child prompt')`, 'child')
    const journal = new InMemoryWorkflowJournal()
    const first = start(parent, [
      { outcome: { type: 'result', output: { type: 'text', text: 'old' } } },
    ], { journal, resolveWorkflow: async () => childOne })
    await expect(first.run.result).resolves.toBe('old')
    await first.events

    const second = start(parent, [], { journal, resolveWorkflow: async () => childTwo })
    await expect(second.run.result).resolves.toBe('old')
    await second.events
    expect(second.provider.calls).toHaveLength(0)
  })

  it('resolves agent types and delegates worktree lifecycle above the provider', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'workflow-worktree-'))
    const source = workflow(`
      return await agent('isolated', { isolation: 'worktree', agentType: 'reviewer' })
    `)
    let cleaned = false
    const { provider, run, events } = start(source, [
      {
        expect: { workingDirectory: directory },
        outcome: { type: 'result', output: { type: 'text', text: 'ok' } },
      },
    ], {
      resolveAgentType: async (name) => name === 'reviewer' ? 'Review changes carefully.' : undefined,
      prepareWorkingDirectory: async () => ({
        path: directory,
        cleanup: async () => { cleaned = true },
      }),
    })

    await expect(run.result).resolves.toBe('ok')
    await events
    expect(provider.calls[0]?.request.instructions).toBe('Review changes carefully.')
    expect(cleaned).toBe(true)
  })
})
