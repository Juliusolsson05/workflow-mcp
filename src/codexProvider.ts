import { Codex } from '@openai/codex-sdk'
import type {
  CodexOptions,
  Input,
  ThreadEvent,
  ThreadOptions,
  TurnOptions,
} from '@openai/codex-sdk'

import {
  AgentProviderAbortError,
  AgentProviderFailure,
} from './agentProvider.js'
import { adaptCodexOutputSchema } from './codexSchema.js'
import type {
  AgentProvider,
  AgentProviderActivity,
  AgentProviderExecutionContext,
  AgentProviderResult,
  AgentRequest,
  AgentUsage,
  ProviderSessionReference,
} from './agentProvider.js'

export type CodexThreadLike = {
  readonly id: string | null
  runStreamed(input: Input, options?: TurnOptions): Promise<{ events: AsyncGenerator<ThreadEvent> }>
}

export type CodexClientLike = {
  startThread(options?: ThreadOptions): CodexThreadLike
  resumeThread(id: string, options?: ThreadOptions): CodexThreadLike
}

export type CodexProviderOptions = Omit<CodexOptions, 'env'> & {
  /** Injected by tests and embedders that already own a configured SDK client. */
  client?: CodexClientLike
  /** Additional explicit values are merged into the small safe environment allowlist. */
  env?: Record<string, string>
  /** A null mapping intentionally selects the SDK/CLI configured default model. */
  modelAliases?: Readonly<Record<string, string | null>>
}

const CODEX_EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh'])
const CLAUDE_MODEL_NAMES = new Set(['haiku', 'sonnet', 'opus', 'inherit'])
// Keep this literal beside the adapter and the exact package.json pin. Reading package metadata at
// runtime fails under some package export maps and bundlers; a mismatched upgrade should therefore
// be an obvious one-line review change rather than silently reporting the wrong installed version.
const CODEX_SDK_VERSION = '0.144.4'

/**
 * Supported Codex SDK adapter for one workflow `agent()` call.
 *
 * WHY this owns SDK event translation: workflow events are a durable product contract, while the
 * SDK event union can evolve with the bundled CLI. Keeping every Codex-specific field here lets
 * old workflow runs replay after an SDK upgrade without teaching the scheduler about Codex JSONL.
 */
export class CodexAgentProvider implements AgentProvider {
  readonly name = 'codex'
  readonly #client: CodexClientLike
  readonly #modelAliases: Readonly<Record<string, string | null>>

  constructor(options: CodexProviderOptions = {}) {
    const { client, modelAliases = {}, env, ...codexOptions } = options
    this.#modelAliases = { ...modelAliases }
    this.#client = client ?? new Codex({
      ...codexOptions,
      env: safeCodexEnvironment(env),
    })
  }

  async execute(
    request: AgentRequest,
    context: AgentProviderExecutionContext,
  ): Promise<AgentProviderResult> {
    if (context.signal.aborted) throw new AgentProviderAbortError(context.signal.reason)
    if (request.session !== undefined && request.session.provider !== this.name) {
      throw new AgentProviderFailure(
        `Cannot resume ${JSON.stringify(request.session.provider)} session with Codex`,
        { code: 'provider-session-mismatch' },
      )
    }

    let schemaAdapter
    try {
      schemaAdapter = request.schema === undefined ? undefined : adaptCodexOutputSchema(request.schema)
    } catch (cause) {
      throw new AgentProviderFailure(
        `Codex cannot represent this workflow output schema: ${cause instanceof Error ? cause.message : String(cause)}`,
        { code: 'codex-schema-unsupported', cause },
      )
    }

    const threadOptions = this.#threadOptions(request)
    const thread = request.session
      ? this.#client.resumeThread(request.session.id, threadOptions)
      : this.#client.startThread(threadOptions)
    const input = request.instructions === undefined
      ? request.prompt
      : `${request.instructions}\n\nTask:\n${request.prompt}`
    const turnOptions: TurnOptions = {
      signal: context.signal,
      ...(schemaAdapter === undefined ? {} : { outputSchema: schemaAdapter.outputSchema }),
    }

    let providerSession: ProviderSessionReference | undefined
    let finalResponse: string | undefined
    let usage: AgentUsage | undefined

    try {
      const streamed = await thread.runStreamed(input, turnOptions)
      for await (const event of streamed.events) {
        switch (event.type) {
          case 'thread.started':
            providerSession = { provider: this.name, id: event.thread_id }
            await context.emit({
              type: 'session.started',
              session: { provider: this.name, id: event.thread_id },
            })
            break

          case 'item.started':
            await context.emit({ type: 'activity.started', activity: codexActivity(event.item) })
            break

          case 'item.updated':
            await context.emit({
              type: 'activity.updated',
              activityId: event.item.id,
              patch: activityPatch(event.item),
            })
            break

          case 'item.completed':
            await context.emit({ type: 'activity.completed', activity: codexActivity(event.item) })
            if (event.item.type === 'agent_message') finalResponse = event.item.text
            break

          case 'turn.completed':
            usage = {
              inputTokens: event.usage.input_tokens,
              outputTokens: event.usage.output_tokens,
              cachedInputTokens: event.usage.cached_input_tokens,
              reasoningTokens: event.usage.reasoning_output_tokens,
              // Codex reports cached input and reasoning as breakdowns of its input/output totals.
              // Charging input + output is therefore explicit, reproducible, and avoids either
              // double-counting those subsets or silently leaving workflow budgets at zero.
              totalTokens: event.usage.input_tokens + event.usage.output_tokens,
            }
            break

          case 'turn.failed':
            throw new AgentProviderFailure(event.error.message, {
              code: 'codex-turn-failed',
              ...(providerSession === undefined ? {} : { providerSession }),
            })

          case 'error':
            throw new AgentProviderFailure(event.message, {
              code: 'codex-stream-error',
              ...(providerSession === undefined ? {} : { providerSession }),
            })

          case 'turn.started':
            break
        }
      }
    } catch (error) {
      if (context.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
        throw new AgentProviderAbortError(context.signal.reason ?? error)
      }
      if (error instanceof AgentProviderFailure) throw error
      throw new AgentProviderFailure(
        `Codex SDK execution failed: ${error instanceof Error ? error.message : String(error)}`,
        {
          code: 'codex-sdk-failed',
          ...(providerSession === undefined ? {} : { providerSession }),
          cause: error,
        },
      )
    }

    if (providerSession === undefined && thread.id !== null) {
      providerSession = { provider: this.name, id: thread.id }
      await context.emit({
        type: 'session.started',
        session: { provider: this.name, id: thread.id },
      })
    }
    if (finalResponse === undefined) {
      throw new AgentProviderFailure('Codex completed without a final agent message', {
        code: 'codex-missing-response',
        ...(providerSession === undefined ? {} : { providerSession }),
      })
    }

    return {
      output: request.schema === undefined
        ? { type: 'text', text: finalResponse }
        : {
            type: 'structured',
            value: schemaAdapter?.restore(parseStructuredOutput(finalResponse, providerSession)),
          },
      ...(usage === undefined ? {} : { usage }),
      ...(providerSession === undefined ? {} : { providerSession }),
      diagnostics: {
        sdk: '@openai/codex-sdk',
        sdkVersion: CODEX_SDK_VERSION,
        bundledCliVersion: CODEX_SDK_VERSION,
      },
    }
  }

  #threadOptions(request: AgentRequest): ThreadOptions {
    const model = this.#model(request.model)
    if (request.effort !== undefined && !CODEX_EFFORTS.has(request.effort)) {
      throw new AgentProviderFailure(`Unsupported Codex reasoning effort ${JSON.stringify(request.effort)}`, {
        code: 'codex-effort-unmapped',
      })
    }
    return {
      workingDirectory: request.workingDirectory,
      sandboxMode: request.sandbox.mode,
      approvalPolicy: request.sandbox.approvalPolicy,
      networkAccessEnabled: request.sandbox.network,
      ...(request.sandbox.additionalWritableDirectories === undefined
        ? {}
        : { additionalDirectories: [...request.sandbox.additionalWritableDirectories] }),
      ...(model === undefined ? {} : { model }),
      ...(request.effort === undefined
        ? {}
        : { modelReasoningEffort: request.effort as NonNullable<ThreadOptions['modelReasoningEffort']> }),
    }
  }

  #model(value: string | undefined): string | undefined {
    if (value === undefined) return undefined
    const mapped = this.#modelAliases[value]
    if (mapped !== undefined) return mapped ?? undefined
    if (CLAUDE_MODEL_NAMES.has(value)) {
      throw new AgentProviderFailure(
        `Claude model alias ${JSON.stringify(value)} needs an explicit Codex model mapping`,
        { code: 'codex-model-unmapped' },
      )
    }
    return value
  }
}

function parseStructuredOutput(
  text: string,
  providerSession: ProviderSessionReference | undefined,
): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch (cause) {
    throw new AgentProviderFailure('Codex structured output was not valid JSON', {
      code: 'codex-structured-output-invalid',
      ...(providerSession === undefined ? {} : { providerSession }),
      cause,
    })
  }
}

function codexActivity(item: ThreadEventItem): AgentProviderActivity {
  switch (item.type) {
    case 'agent_message':
      return { id: item.id, kind: 'message', content: item.text }
    case 'reasoning':
      return { id: item.id, kind: 'reasoning', content: item.text }
    case 'command_execution':
      return {
        id: item.id,
        kind: 'command',
        title: item.command,
        content: {
          command: item.command,
          output: item.aggregated_output,
          status: item.status,
          ...(item.exit_code === undefined ? {} : { exitCode: item.exit_code }),
        },
      }
    case 'file_change':
      return { id: item.id, kind: 'file_change', content: { changes: item.changes, status: item.status } }
    case 'mcp_tool_call':
      return {
        id: item.id,
        kind: 'tool_call',
        title: `${item.server}.${item.tool}`,
        content: {
          arguments: item.arguments,
          status: item.status,
          ...(item.result === undefined ? {} : { result: item.result }),
          ...(item.error === undefined ? {} : { error: item.error }),
        },
      }
    case 'web_search':
      return { id: item.id, kind: 'web_search', title: item.query, content: { query: item.query } }
    case 'todo_list':
      return { id: item.id, kind: 'todo_list', content: item.items }
    case 'error':
      return { id: item.id, kind: 'error', content: item.message }
  }
}

type ThreadEventItem = Extract<ThreadEvent, { type: 'item.started' }>['item']

function activityPatch(item: ThreadEventItem): Partial<Omit<AgentProviderActivity, 'id'>> {
  const activity = codexActivity(item)
  return {
    kind: activity.kind,
    ...(activity.title === undefined ? {} : { title: activity.title }),
    ...(activity.content === undefined ? {} : { content: activity.content }),
  }
}

function safeCodexEnvironment(explicit: Record<string, string> | undefined): Record<string, string> {
  const env: Record<string, string> = {}
  const allowed = [
    'HOME',
    'USER',
    'LOGNAME',
    'PATH',
    'SHELL',
    'TMPDIR',
    'TEMP',
    'TMP',
    'CODEX_HOME',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'SSL_CERT_FILE',
    'SYSTEMROOT',
    'WINDIR',
  ]
  for (const name of allowed) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  return { ...env, ...explicit }
}
