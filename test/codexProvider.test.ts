import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'

import type { ThreadEvent, ThreadOptions, TurnOptions } from '@openai/codex-sdk'

import type {
  AgentProviderEvent,
  AgentRequest,
} from '../src/agentProvider.js'
import { buildCodexRecoveryFingerprint, CodexAgentProvider } from '../src/codexProvider.js'
import type { CodexClientLike } from '../src/codexProvider.js'

function eventStream(events: readonly ThreadEvent[]): AsyncGenerator<ThreadEvent> {
  return (async function* stream() {
    for (const event of events) yield event
  })()
}

function request(overrides: Partial<AgentRequest> = {}): AgentRequest {
  return {
    prompt: 'Inspect the repository',
    workingDirectory: '/tmp/project',
    sandbox: {
      mode: 'workspace-write',
      approvalPolicy: 'never',
      network: false,
    },
    ...overrides,
  }
}

function mockClient(events: readonly ThreadEvent[]) {
  const calls: Array<{
    kind: 'start' | 'resume'
    id?: string
    threadOptions?: ThreadOptions
    input?: unknown
    turnOptions?: TurnOptions
  }> = []
  const thread = {
    id: 'thread-fallback' as string | null,
    async runStreamed(input: unknown, turnOptions?: TurnOptions) {
      const call = calls.at(-1)
      if (call) {
        call.input = input
        if (turnOptions !== undefined) call.turnOptions = turnOptions
      }
      return { events: eventStream(events) }
    },
  }
  const client = {
    startThread(threadOptions?: ThreadOptions) {
      calls.push({ kind: 'start', ...(threadOptions === undefined ? {} : { threadOptions }) })
      return thread
    },
    resumeThread(id: string, threadOptions?: ThreadOptions) {
      calls.push({ kind: 'resume', id, ...(threadOptions === undefined ? {} : { threadOptions }) })
      return thread
    },
  } as CodexClientLike
  return { client, calls }
}

describe('CodexAgentProvider', () => {
  it('builds a canonical recovery fingerprint only from complete capability evidence', () => {
    const common = {
      executableEvidence: { path: '/opt/codex', sha256: 'a'.repeat(64), version: '1.2.3' },
      configurationIsolation: {
        codexHome: '/data/codex-home',
        effectiveConfigurationFingerprint: 'effective-config-v1',
      },
      capabilities: {
        inheritedMcpServers: 'disabled' as const,
        mcpServers: [
          { name: 'zeta', effect: 'read-only' as const },
          { name: 'alpha', effect: 'idempotent' as const },
        ],
      },
      modelAliases: { sonnet: 'gpt-5', haiku: null },
    }
    const fingerprint = buildCodexRecoveryFingerprint(common)
    expect(fingerprint).toMatch(/^codex:v1:[a-f0-9]{64}$/)
    expect(buildCodexRecoveryFingerprint({
      ...common,
      capabilities: {
        ...common.capabilities,
        mcpServers: [...common.capabilities.mcpServers].reverse(),
      },
      modelAliases: { haiku: null, sonnet: 'gpt-5' },
    })).toBe(fingerprint)
    expect(buildCodexRecoveryFingerprint({
      ...common,
      executableEvidence: { ...common.executableEvidence, sha256: 'b'.repeat(64) },
    })).not.toBe(fingerprint)
    const { executableEvidence: _omitted, ...withoutExecutable } = common
    expect(buildCodexRecoveryFingerprint(withoutExecutable)).toBeUndefined()
  })

  it('does not advertise process-tree ownership for hosted Codex attempts', () => {
    const provider = new CodexAgentProvider({
      codexPathOverride: '/tmp/codex',
      providerHostFilePath: fileURLToPath(new URL('../dist/providerHost.js', import.meta.url)),
    })

    // A real Codex shell tool may call setsid() and leave the provider-host process group. This
    // default-capability fixture also has no MCP effect attestation, so ownership and replay are
    // independently unknown for two different reasons.
    expect(provider.terminationBoundary).toBe('unconfirmed-descendants')
    expect(provider.automaticReplaySafety).toBe('unsafe-or-unknown')
  })

  it('separates hosted process containment from proven read-only replay safety', () => {
    const provider = new CodexAgentProvider({
      codexPathOverride: '/tmp/codex',
      providerHostFilePath: fileURLToPath(new URL('../dist/providerHost.js', import.meta.url)),
      configurationIsolation: {
        codexHome: '/tmp/private-codex-home',
        effectiveConfigurationFingerprint: 'read-only-fixture',
      },
      capabilities: { inheritedMcpServers: 'disabled', mcpServers: [] },
    })

    expect(provider.terminationBoundary).toBe('unconfirmed-descendants')
    expect(provider.automaticReplaySafety).toBe('safe')
    expect(provider.assessReplaySafety(request({
      sandbox: { mode: 'read-only', approvalPolicy: 'never', network: false },
    }))).toMatchObject({ automatic: true, risk: 'read_only' })
  })

  it('maps thread policy, streamed activities, final text, session, and raw usage', async () => {
    const { client, calls } = mockClient([
      { type: 'thread.started', thread_id: 'thread-1' },
      { type: 'turn.started' },
      {
        type: 'item.started',
        item: {
          id: 'command-1',
          type: 'command_execution',
          command: 'pwd',
          aggregated_output: '',
          status: 'in_progress',
        },
      },
      {
        type: 'item.updated',
        item: {
          id: 'command-1',
          type: 'command_execution',
          command: 'pwd',
          aggregated_output: '/tmp/project\n',
          status: 'in_progress',
        },
      },
      {
        type: 'item.completed',
        item: {
          id: 'command-1',
          type: 'command_execution',
          command: 'pwd',
          aggregated_output: '/tmp/project\n',
          exit_code: 0,
          status: 'completed',
        },
      },
      {
        type: 'item.completed',
        item: { id: 'message-1', type: 'agent_message', text: 'Finished' },
      },
      {
        type: 'turn.completed',
        usage: {
          input_tokens: 10,
          cached_input_tokens: 4,
          output_tokens: 3,
          reasoning_output_tokens: 2,
        },
      },
    ])
    const provider = new CodexAgentProvider({ client })
    const emitted: AgentProviderEvent[] = []
    const result = await provider.execute(
      request({
        effort: 'high',
        sandbox: {
          mode: 'workspace-write',
          approvalPolicy: 'never',
          network: true,
          additionalWritableDirectories: ['/tmp/shared'],
        },
      }),
      {
        signal: new AbortController().signal,
        emit: async (event) => { emitted.push(event) },
      },
    )

    expect(calls[0]).toMatchObject({
      kind: 'start',
      threadOptions: {
        workingDirectory: '/tmp/project',
        sandboxMode: 'workspace-write',
        approvalPolicy: 'never',
        networkAccessEnabled: true,
        additionalDirectories: ['/tmp/shared'],
        modelReasoningEffort: 'high',
      },
      input: 'Inspect the repository',
    })
    expect(emitted.map((event) => event.type)).toEqual([
      'session.started',
      'activity.started',
      'activity.updated',
      'activity.completed',
      'activity.completed',
    ])
    expect(result).toEqual({
      output: { type: 'text', text: 'Finished' },
      usage: {
        inputTokens: 10,
        cachedInputTokens: 4,
        outputTokens: 3,
        reasoningTokens: 2,
        totalTokens: 13,
      },
      providerSession: { provider: 'codex', id: 'thread-1' },
      diagnostics: {
        sdk: '@openai/codex-sdk',
        sdkVersion: '0.144.6',
      },
    })
  })

  it('disables native web search for offline attempts and rejects unenforced replay attestations', async () => {
    const { client, calls } = mockClient([
      { type: 'thread.started', thread_id: 'thread-offline' },
      { type: 'item.completed', item: { id: 'message-1', type: 'agent_message', text: 'Done' } },
    ])
    const provider = new CodexAgentProvider({ client })
    await provider.execute(request({
      sandbox: { mode: 'read-only', approvalPolicy: 'never', network: false },
    }), { signal: new AbortController().signal, emit: async () => undefined })

    expect(calls[0]?.threadOptions).toMatchObject({
      networkAccessEnabled: false,
      webSearchMode: 'disabled',
    })
    expect(() => new CodexAgentProvider({
      codexPathOverride: '/tmp/codex',
      capabilities: { inheritedMcpServers: 'disabled' },
    })).toThrow(expect.objectContaining({ code: 'codex-capability-attestation-invalid' }))
    expect(() => new CodexAgentProvider({
      codexPathOverride: '/tmp/codex',
      configurationIsolation: { codexHome: '/tmp/private-codex-home' },
      capabilities: { inheritedMcpServers: 'disabled' },
    })).toThrow(expect.objectContaining({ code: 'codex-capability-attestation-invalid' }))
  })

  it('does not call a read-only request replay-safe when extra writable directories are exposed', () => {
    const provider = new CodexAgentProvider({
      client: mockClient([]).client,
      capabilities: { inheritedMcpServers: 'disabled', mcpServers: [] },
    })

    expect(provider.assessReplaySafety(request({
      sandbox: {
        mode: 'read-only',
        approvalPolicy: 'never',
        network: false,
        additionalWritableDirectories: ['/tmp/shared-output'],
      },
    }))).toMatchObject({ automatic: false, risk: 'unknown_external' })
  })

  it('never calls danger-full-access replay-safe even inside an isolated worktree', () => {
    const provider = new CodexAgentProvider({
      client: mockClient([]).client,
      capabilities: { inheritedMcpServers: 'disabled', mcpServers: [] },
    })

    expect(provider.assessReplaySafety(request({
      sandbox: { mode: 'danger-full-access', approvalPolicy: 'never', network: false },
    }))).toMatchObject({
      automatic: false,
      risk: 'unknown_external',
      reason: expect.stringMatching(/outside the isolated workspace/i),
    })
  })

  it('resumes a thread, maps a Claude model alias, prepends agent instructions, and parses schema output', async () => {
    const { client, calls } = mockClient([
      { type: 'thread.started', thread_id: 'thread-old' },
      {
        type: 'item.completed',
        item: { id: 'message-1', type: 'agent_message', text: '{"ok":true}' },
      },
      {
        type: 'turn.completed',
        usage: {
          input_tokens: 1,
          cached_input_tokens: 0,
          output_tokens: 1,
          reasoning_output_tokens: 0,
        },
      },
    ])
    const provider = new CodexAgentProvider({ client, modelAliases: { sonnet: 'gpt-test' } })
    const schema = {
      type: 'object',
      properties: { ok: { type: 'boolean' } },
      required: ['ok'],
      additionalProperties: false,
    }
    const result = await provider.execute(
      request({
        schema,
        model: 'sonnet',
        instructions: 'You are the review specialist.',
        session: { provider: 'codex', id: 'thread-old' },
      }),
      { signal: new AbortController().signal, emit: async () => undefined },
    )

    expect(calls[0]).toMatchObject({
      kind: 'resume',
      id: 'thread-old',
      threadOptions: { model: 'gpt-test' },
      input: 'You are the review specialist.\n\nTask:\nInspect the repository',
      turnOptions: { outputSchema: schema },
    })
    expect(result.output).toEqual({ type: 'structured', value: { ok: true } })
  })

  it('sends only the continuation note when recovering an existing provider thread', async () => {
    const { client, calls } = mockClient([
      { type: 'thread.started', thread_id: 'thread-old' },
      { type: 'item.completed', item: { id: 'message-1', type: 'agent_message', text: 'Recovered' } },
      {
        type: 'turn.completed',
        usage: {
          input_tokens: 1,
          cached_input_tokens: 0,
          output_tokens: 1,
          reasoning_output_tokens: 0,
        },
      },
    ])
    const provider = new CodexAgentProvider({ client })
    await provider.execute(request({
      session: { provider: 'codex', id: 'thread-old' },
      recovery: {
        reason: 'idle timeout',
        previousAttemptNumber: 1,
        lastProgressAt: '2026-07-15T20:39:32.000Z',
        note: 'Continue from the recorded state without repeating completed actions.',
      },
    }), { signal: new AbortController().signal, emit: async () => undefined })

    expect(calls[0]?.input).toBe('Continue from the recorded state without repeating completed actions.')
    expect(calls[0]?.input).not.toContain('Inspect the repository')
  })

  it('classifies a missing historical rollout as session-local rather than a provider outage', async () => {
    const client: CodexClientLike = {
      startThread: () => { throw new Error('startThread should not be called') },
      resumeThread: (id) => ({
        id,
        runStreamed: async () => {
          throw new Error(`thread/resume: thread/resume failed: no rollout found for thread id ${id} (code -32600)`)
        },
      }),
    }
    const provider = new CodexAgentProvider({ client })

    await expect(provider.execute(request({
      session: { provider: 'codex', id: 'historical-thread' },
      recovery: {
        reason: 'manual resume',
        previousAttemptNumber: 1,
        lastProgressAt: '2026-07-15T20:39:32.000Z',
        note: 'Continue safely.',
      },
    }), { signal: new AbortController().signal, emit: async () => undefined }))
      .rejects.toMatchObject({
        code: 'codex-session-unavailable',
        retryable: true,
        circuitImpact: 'neutral',
        providerSession: { provider: 'codex', id: 'historical-thread' },
      })
  })

  it('bridges Claude-optional schema fields through Codex strict output without changing the result', async () => {
    const { client, calls } = mockClient([
      { type: 'thread.started', thread_id: 'thread-schema' },
      {
        type: 'item.completed',
        item: {
          id: 'message-1',
          type: 'agent_message',
          text: '{"findings":[{"title":"real issue","line":null,"details":{"note":null}}]}',
        },
      },
      {
        type: 'turn.completed',
        usage: {
          input_tokens: 1,
          cached_input_tokens: 0,
          output_tokens: 1,
          reasoning_output_tokens: 0,
        },
      },
    ])
    const provider = new CodexAgentProvider({ client })
    const schema = {
      type: 'object',
      required: ['findings'],
      properties: {
        findings: {
          type: 'array',
          items: {
            type: 'object',
            required: ['title', 'details'],
            properties: {
              title: { type: 'string' },
              line: { type: 'integer' },
              details: {
                type: 'object',
                properties: { note: { type: 'string' } },
              },
            },
          },
        },
      },
    }

    const result = await provider.execute(request({ schema }), {
      signal: new AbortController().signal,
      emit: async () => undefined,
    })

    expect(calls[0]?.turnOptions?.outputSchema).toEqual({
      type: 'object',
      required: ['findings'],
      properties: {
        findings: {
          type: 'array',
          items: {
            type: 'object',
            required: ['title', 'line', 'details'],
            properties: {
              title: { type: 'string' },
              line: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
              details: {
                type: 'object',
                required: ['note'],
                properties: {
                  note: { anyOf: [{ type: 'string' }, { type: 'null' }] },
                },
                additionalProperties: false,
              },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    })
    expect(result.output).toEqual({
      type: 'structured',
      value: { findings: [{ title: 'real issue', details: {} }] },
    })
  })

  it('fails clearly for unmapped Claude models, invalid JSON, and provider session mismatches', async () => {
    const empty = mockClient([])
    const provider = new CodexAgentProvider({ client: empty.client })
    await expect(
      provider.execute(request({ model: 'opus' }), {
        signal: new AbortController().signal,
        emit: async () => undefined,
      }),
    ).rejects.toMatchObject({ code: 'codex-model-unmapped' })
    expect(empty.calls).toHaveLength(0)

    await expect(
      provider.execute(request({ session: { provider: 'claude', id: 'other' } }), {
        signal: new AbortController().signal,
        emit: async () => undefined,
      }),
    ).rejects.toMatchObject({ code: 'provider-session-mismatch' })

    const invalid = mockClient([
      { type: 'thread.started', thread_id: 'thread-1' },
      {
        type: 'item.completed',
        item: { id: 'message-1', type: 'agent_message', text: 'not json' },
      },
      {
        type: 'turn.completed',
        usage: {
          input_tokens: 1,
          cached_input_tokens: 0,
          output_tokens: 1,
          reasoning_output_tokens: 0,
        },
      },
    ])
    const structured = new CodexAgentProvider({ client: invalid.client })
    await expect(
      structured.execute(request({ schema: { type: 'object' } }), {
        signal: new AbortController().signal,
        emit: async () => undefined,
      }),
    ).rejects.toMatchObject({
      code: 'codex-structured-output-invalid',
      terminalDisposition: 'reject',
    })
  })

  it('normalizes stream failures and AbortSignal cancellation', async () => {
    const failed = mockClient([
      { type: 'thread.started', thread_id: 'thread-1' },
      { type: 'turn.failed', error: { message: 'model failed' } },
    ])
    const provider = new CodexAgentProvider({ client: failed.client })
    await expect(
      provider.execute(request(), {
        signal: new AbortController().signal,
        emit: async () => undefined,
      }),
    ).rejects.toMatchObject({ code: 'codex-turn-failed' })

    const controller = new AbortController()
    controller.abort('stop')
    await expect(
      provider.execute(request(), { signal: controller.signal, emit: async () => undefined }),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })
})
