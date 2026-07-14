import { describe, expect, it } from 'vitest'

import {
  AgentProviderAbortError,
  AgentProviderFailure,
} from '../src/agentProvider.js'
import type {
  AgentProviderEvent,
  AgentProviderExecutionContext,
  AgentRequest,
} from '../src/agentProvider.js'
import {
  FakeAgentProvider,
  FakeProviderSetupError,
} from '../src/fakeProvider.js'
import type { FakeProviderScript } from '../src/fakeProvider.js'

const baseRequest: AgentRequest = {
  prompt: 'Inspect the session manager',
  workingDirectory: '/worktree',
  sandbox: {
    mode: 'workspace-write',
    approvalPolicy: 'never',
    network: false,
  },
}

function recordingContext(controller = new AbortController()): {
  context: AgentProviderExecutionContext
  controller: AbortController
  events: AgentProviderEvent[]
} {
  const events: AgentProviderEvent[] = []
  return {
    controller,
    events,
    context: {
      signal: controller.signal,
      emit(event) {
        events.push(event)
        return Promise.resolve()
      },
    },
  }
}

describe('FakeAgentProvider', () => {
  it('returns text, usage, a deterministic session, and ordered activity', async () => {
    const provider = new FakeAgentProvider([
      {
        name: 'finder',
        expect: {
          prompt: /session manager/,
          model: 'gpt-5',
          workingDirectory: '/worktree',
          sessionId: null,
        },
        events: [
          {
            event: {
              type: 'activity.started',
              activity: { id: 'activity-1', kind: 'command', title: 'Search source' },
            },
          },
          {
            event: {
              type: 'activity.updated',
              activityId: 'activity-1',
              patch: { content: { output: 'src/session.ts:10' } },
            },
          },
          {
            event: {
              type: 'activity.completed',
              activity: {
                id: 'activity-1',
                kind: 'command',
                title: 'Search source',
                content: { exitCode: 0 },
              },
            },
          },
          { event: { type: 'warning', code: 'fixture-warning', message: 'Synthetic warning' } },
        ],
        outcome: {
          type: 'result',
          output: { type: 'text', text: 'Found one issue' },
          usage: { inputTokens: 120, outputTokens: 30, cachedInputTokens: 20, totalTokens: 150 },
          diagnostics: { version: 'fake-1' },
        },
      },
    ])
    const { context, events } = recordingContext()

    const result = await provider.execute({ ...baseRequest, model: 'gpt-5' }, context)

    expect(result).toEqual({
      output: { type: 'text', text: 'Found one issue' },
      usage: { inputTokens: 120, outputTokens: 30, cachedInputTokens: 20, totalTokens: 150 },
      providerSession: { provider: 'fake', id: 'fake-session-1' },
      diagnostics: { version: 'fake-1' },
    })
    expect(events.map((event) => event.type)).toEqual([
      'session.started',
      'activity.started',
      'activity.updated',
      'activity.completed',
      'warning',
    ])
    expect(provider.calls[0]).toMatchObject({
      index: 0,
      scriptName: 'finder',
      status: 'completed',
      providerSession: { provider: 'fake', id: 'fake-session-1' },
    })
    expect(provider.calls[0]?.emittedEvents).toEqual(events)
    expect(provider.completionOrder).toEqual([0])
    expect(provider.activeExecutions).toBe(0)
    expect(provider.maxConcurrentExecutions).toBe(1)
    provider.assertExhausted()
  })

  it('returns parsed structured data and preserves a resumed provider session', async () => {
    const provider = new FakeAgentProvider(
      [
        {
          expect: { sessionId: 'thread-42' },
          outcome: {
            type: 'result',
            output: { type: 'structured', value: { findings: [{ file: 'src/main.ts', line: 42 }] } },
          },
        },
      ],
      { providerName: 'codex-fixture' },
    )
    const { context, events } = recordingContext()

    const result = await provider.execute(
      {
        ...baseRequest,
        schema: { type: 'object' },
        session: { provider: 'codex-fixture', id: 'thread-42' },
      },
      context,
    )

    expect(result.output).toEqual({
      type: 'structured',
      value: { findings: [{ file: 'src/main.ts', line: 42 }] },
    })
    expect(result.providerSession).toEqual({ provider: 'codex-fixture', id: 'thread-42' })
    expect(events[0]).toEqual({
      type: 'session.started',
      session: { provider: 'codex-fixture', id: 'thread-42' },
    })
  })

  it('tracks concurrent calls and intentionally reversed completion', async () => {
    const provider = new FakeAgentProvider([
      {
        delayMs: 30,
        outcome: { type: 'result', output: { type: 'text', text: 'slow first call' } },
      },
      {
        delayMs: 1,
        outcome: { type: 'result', output: { type: 'text', text: 'fast second call' } },
      },
    ])
    const firstContext = recordingContext()
    const secondContext = recordingContext()

    // Promise.all deliberately preserves input order while the fake records the opposite terminal
    // order. Runner tests can use this exact shape to catch settlement-order result bugs.
    const results = await Promise.all([
      provider.execute({ ...baseRequest, prompt: 'first' }, firstContext.context),
      provider.execute({ ...baseRequest, prompt: 'second' }, secondContext.context),
    ])

    expect(results.map((result) => result.output)).toEqual([
      { type: 'text', text: 'slow first call' },
      { type: 'text', text: 'fast second call' },
    ])
    expect(provider.completionOrder).toEqual([1, 0])
    expect(provider.maxConcurrentExecutions).toBe(2)
    expect(provider.activeExecutions).toBe(0)
  })

  it('distinguishes provider failure from an ordinary thrown error', async () => {
    const ordinaryError = new Error('adapter invariant broke')
    const provider = new FakeAgentProvider([
      {
        sessionId: 'failed-thread',
        outcome: {
          type: 'provider-failure',
          message: 'provider unavailable',
          code: 'unavailable',
          retryable: true,
        },
      },
      { outcome: { type: 'error', error: ordinaryError } },
    ])

    const first = provider.execute(baseRequest, recordingContext().context)
    await expect(first).rejects.toMatchObject({
      name: 'AgentProviderFailure',
      code: 'unavailable',
      retryable: true,
      providerSession: { provider: 'fake', id: 'failed-thread' },
    })
    await expect(first).rejects.toBeInstanceOf(AgentProviderFailure)

    const second = provider.execute(baseRequest, recordingContext().context)
    await expect(second).rejects.toBe(ordinaryError)
    expect(provider.calls.map((call) => call.status)).toEqual(['provider-failure', 'error'])
  })

  it('blocks without polling until cancellation and releases its concurrency slot', async () => {
    const provider = new FakeAgentProvider([{ outcome: { type: 'wait-for-abort' } }])
    const { context, controller, events } = recordingContext()
    const execution = provider.execute(baseRequest, context)

    // The call record is created before the first awaited event, making this assertion independent
    // of arbitrary sleeps and proving the fake really remains active until cancellation.
    expect(provider.activeExecutions).toBe(1)
    expect(provider.calls[0]?.status).toBe('running')
    controller.abort('workflow cancelled')

    await expect(execution).rejects.toMatchObject({
      name: 'AbortError',
      message: 'workflow cancelled',
      reason: 'workflow cancelled',
    })
    await expect(execution).rejects.toBeInstanceOf(AgentProviderAbortError)
    expect(events.map((event) => event.type)).toEqual(['session.started'])
    expect(provider.calls[0]?.status).toBe('aborted')
    expect(provider.activeExecutions).toBe(0)
  })

  it('cancels an in-progress deterministic delay before later activity is emitted', async () => {
    const provider = new FakeAgentProvider([
      {
        events: [
          {
            delayMs: 1_000,
            event: {
              type: 'activity.completed',
              activity: { id: 'late', kind: 'message', content: 'must not appear' },
            },
          },
        ],
        outcome: { type: 'result', output: { type: 'text', text: 'must not complete' } },
      },
    ])
    const { context, controller, events } = recordingContext()
    const execution = provider.execute(baseRequest, context)
    controller.abort()

    await expect(execution).rejects.toBeInstanceOf(AgentProviderAbortError)
    expect(events.map((event) => event.type)).toEqual(['session.started'])
    expect(provider.calls[0]?.status).toBe('aborted')
  })

  it('rejects invalid fake payloads at setup rather than during workflow execution', () => {
    const invalidScripts: unknown[] = [
      [{ delayMs: -1, outcome: { type: 'result', output: { type: 'text', text: 'x' } } }],
      [{ outcome: { type: 'result', output: { type: 'text', text: 1 } } }],
      [{ outcome: { type: 'result', output: { type: 'text', text: 'x' }, usage: { inputTokens: -1, outputTokens: 0 } } }],
      [{ outcome: { type: 'provider-failure', message: '' } }],
      [{ outcome: { type: 'error', error: 'not an Error' } }],
      [
        {
          events: [
            {
              event: {
                type: 'activity.started',
                activity: { id: '', kind: 'command' },
              },
            },
          ],
          outcome: { type: 'result', output: { type: 'text', text: 'x' } },
        },
      ],
    ]

    for (const scripts of invalidScripts) {
      expect(() => new FakeAgentProvider(scripts as FakeProviderScript[])).toThrow(FakeProviderSetupError)
    }
  })

  it('reports unused, exhausted, mismatched, and cross-provider fixture mistakes clearly', async () => {
    const script: FakeProviderScript = {
      expect: { prompt: 'expected prompt', sessionId: null },
      outcome: { type: 'result', output: { type: 'text', text: 'ok' } },
    }
    const unused = new FakeAgentProvider([script])
    expect(() => unused.assertExhausted()).toThrow('1 fake provider script(s) were not consumed')

    const mismatched = new FakeAgentProvider([script])
    await expect(mismatched.execute(baseRequest, recordingContext().context)).rejects.toThrow(
      'Call 0 prompt did not match its script',
    )

    const wrongProvider = new FakeAgentProvider([
      { outcome: { type: 'result', output: { type: 'text', text: 'ok' } } },
    ])
    await expect(
      wrongProvider.execute(
        { ...baseRequest, session: { provider: 'codex', id: 'thread-1' } },
        recordingContext().context,
      ),
    ).rejects.toThrow('cannot resume "codex" with the "fake" provider')

    const exhausted = new FakeAgentProvider([])
    await expect(exhausted.execute(baseRequest, recordingContext().context)).rejects.toThrow(
      'No fake provider script exists for call 0',
    )
  })
})
