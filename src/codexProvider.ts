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
  AgentReplaySafetyAssessment,
  AgentProvider,
  AgentProviderActivity,
  AgentProviderAttemptIdentity,
  AgentProviderExecutionContext,
  AgentProviderResult,
  AgentProviderTerminationReason,
  AgentRequest,
  AgentUsage,
  ProviderSessionReference,
} from './agentProvider.js'
import { ProcessOwnedCodexHost } from './processOwnedProviderHost.js'

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
  /** Built provider-host entry; Agent Code supplies its electron-vite emitted sibling. */
  providerHostFilePath?: string
  /**
   * Dedicated Codex state root used to prevent workflow attempts from inheriting user/project
   * configuration while retaining durable thread files for provider-session resume.
   */
  configurationIsolation?: CodexConfigurationIsolation
  /**
   * Host attestation for tools outside the local sandbox.
   *
   * WHY omitted means unknown: the Codex CLI can inherit MCP servers from user/project config.
   * Merely passing no additional server in this constructor does not prove that the effective tool
   * set is empty. A host may mark inheritance disabled only when it enforces that at its config
   * boundary, and must classify every server it intentionally exposes.
   */
  capabilities?: CodexExecutionCapabilities
}

export type CodexExternalCapabilityEffect = 'read-only' | 'idempotent' | 'mutating' | 'unknown'

export type CodexExecutionCapabilities = {
  inheritedMcpServers: 'disabled' | 'unknown'
  mcpServers?: readonly {
    name: string
    effect: CodexExternalCapabilityEffect
  }[]
}

export type CodexConfigurationIsolation = {
  /** Stable across attempts and application restarts so Codex thread resume remains possible. */
  codexHome: string
  /** Optional login copied into the isolated home before each host starts. */
  authenticationFile?: string
}

const CODEX_EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
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
  readonly #client: CodexClientLike | undefined
  readonly #host: ProcessOwnedCodexHost | undefined
  readonly #modelAliases: Readonly<Record<string, string | null>>
  readonly #capabilities: CodexExecutionCapabilities

  constructor(options: CodexProviderOptions = {}) {
    const {
      client,
      modelAliases = {},
      providerHostFilePath,
      configurationIsolation,
      capabilities = { inheritedMcpServers: 'unknown' },
      env,
      ...codexOptions
    } = options
    this.#modelAliases = { ...modelAliases }
    this.#capabilities = {
      inheritedMcpServers: capabilities.inheritedMcpServers,
      ...(capabilities.mcpServers === undefined
        ? {}
        : { mcpServers: capabilities.mcpServers.map((server) => ({ ...server })) }),
    }
    if (client) {
      // Injected clients are an in-process conformance seam. Production never takes this branch;
      // preserving it keeps adapter tests focused on event translation without spawning hosts.
      this.#client = client
      this.#host = undefined
    } else {
      if (capabilities.inheritedMcpServers === 'disabled' && configurationIsolation === undefined) {
        // A declaration is not an isolation boundary. Without a dedicated CODEX_HOME, the CLI
        // still reads ~/.codex/config.toml, project .codex/config.toml, plugins, and apps. Refusing
        // this combination prevents a host from accidentally converting "we did not pass an MCP
        // server" into the much stronger—and false—claim that no mutating server is reachable.
        throw new AgentProviderFailure(
          'Codex inherited MCP servers can be marked disabled only with configurationIsolation',
          { code: 'codex-capability-attestation-invalid' },
        )
      }
      this.#client = undefined
      this.#host = new ProcessOwnedCodexHost({
        ...(providerHostFilePath === undefined ? {} : { hostFilePath: providerHostFilePath }),
        ...(configurationIsolation === undefined ? {} : { configurationIsolation }),
        codexOptions: {
          ...codexOptions,
          env: safeCodexEnvironment(env),
        },
        modelAliases: this.#modelAliases,
      })
    }
  }

  get automaticReplaySafety(): 'safe' | 'unsafe-or-unknown' {
    return this.#externallyReplaySafe()
      ? 'safe'
      : 'unsafe-or-unknown'
  }

  get terminationBoundary(): 'settlement' | 'process-tree' | 'unconfirmed-descendants' {
    // Production turns always use the process owner. Injected clients deliberately retain the
    // weaker settlement boundary because no OS process exists for workflow-mcp to reap. Windows
    // taskkill is useful escalation, but unlike a Job Object it does not bind future descendants
    // at creation time, so advertising the POSIX guarantee there would be stronger than reality.
    if (this.#host === undefined) return 'settlement'
    return process.platform === 'win32' ? 'unconfirmed-descendants' : 'process-tree'
  }

  assessReplaySafety(request: AgentRequest): AgentReplaySafetyAssessment {
    if (request.sandbox.network) {
      return {
        automatic: false,
        risk: 'unknown_external',
        reason: 'Network-enabled shell execution can produce external effects outside the workflow journal',
      }
    }
    if (this.#host !== undefined && this.terminationBoundary !== 'process-tree') {
      return {
        automatic: false,
        risk: 'unknown_external',
        reason: 'This platform cannot yet prove creation-time ownership of every Codex descendant',
      }
    }
    if (!this.#externallyReplaySafe()) {
      return {
        automatic: false,
        risk: 'unknown_external',
        reason: this.#capabilities.inheritedMcpServers === 'unknown'
          ? 'Effective Codex MCP capabilities include unverified inherited user/project servers'
          : 'At least one exposed Codex MCP server is mutating or has unknown effects',
      }
    }
    const idempotent = this.#capabilities.mcpServers?.some((server) => server.effect === 'idempotent') === true
    return {
      automatic: true,
      risk: idempotent ? 'idempotent_external' : 'read_only',
      reason: idempotent
        ? 'Every external tool is read-only or independently idempotent'
        : 'No inherited MCP servers are enabled and every exposed tool is read-only',
    }
  }

  async execute(
    request: AgentRequest,
    context: AgentProviderExecutionContext,
  ): Promise<AgentProviderResult> {
    if (this.#host) return this.#host.execute(request, context)
    if (!this.#client) throw new Error('Codex provider has neither a client nor a process host')
    return executeCodexTurn(this.#client, request, context, this.#modelAliases)
  }

  async terminateAttempt(
    attempt: AgentProviderAttemptIdentity,
    reason: AgentProviderTerminationReason,
  ): Promise<void> {
    await this.#host?.terminateAttempt(attempt, reason)
  }

  #externallyReplaySafe(): boolean {
    if (this.#host !== undefined && this.terminationBoundary !== 'process-tree') return false
    if (this.#capabilities.inheritedMcpServers !== 'disabled') return false
    return (this.#capabilities.mcpServers ?? []).every(
      (server) => server.effect === 'read-only' || server.effect === 'idempotent',
    )
  }
}

/**
 * Execute one SDK turn inside whichever process owns the supplied client.
 *
 * WHY this function is shared by the in-process test seam and providerHost.ts: duplicating event
 * translation in the child would let hosted production behavior drift from unit-tested behavior.
 * Process ownership changes only lifecycle and transport; Codex SDK protocol semantics remain one
 * implementation.
 */
export async function executeCodexTurn(
  client: CodexClientLike,
  request: AgentRequest,
  context: AgentProviderExecutionContext,
  modelAliases: Readonly<Record<string, string | null>> = {},
): Promise<AgentProviderResult> {
    if (context.signal.aborted) throw new AgentProviderAbortError(context.signal.reason)
    if (request.session !== undefined && request.session.provider !== 'codex') {
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

    const threadOptions = codexThreadOptions(request, modelAliases)
    const thread = request.session
      ? client.resumeThread(request.session.id, threadOptions)
      : client.startThread(threadOptions)
    const input = codexTurnInput(request)
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
            providerSession = { provider: 'codex', id: event.thread_id }
            await context.emit({
              type: 'session.started',
              session: { provider: 'codex', id: event.thread_id },
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
              // A broken stream says nothing about whether the thread itself survived. The
              // supervisor can safely resume that exact thread in a read-only/worktree policy.
              retryable: true,
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
          retryable: true,
          ...(providerSession === undefined ? {} : { providerSession }),
          cause: error,
        },
      )
    }

    if (providerSession === undefined && thread.id !== null) {
      providerSession = { provider: 'codex', id: thread.id }
      await context.emit({
        type: 'session.started',
        session: { provider: 'codex', id: thread.id },
      })
    }
    if (finalResponse === undefined) {
      throw new AgentProviderFailure('Codex completed without a final agent message', {
        code: 'codex-missing-response',
        retryable: true,
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
        ...(request.recovery === undefined ? {} : { recovery: request.recovery }),
      },
    }
}

function codexThreadOptions(
  request: AgentRequest,
  modelAliases: Readonly<Record<string, string | null>>,
): ThreadOptions {
  const model = codexModel(request.model, modelAliases)
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
    // Codex web search is a separate native tool, not ordinary shell network access. Explicitly
    // removing it for an offline request keeps the replay-safety classification truthful even if
    // the user's normal Codex profile enables live search by default.
    ...(request.sandbox.network ? {} : { webSearchMode: 'disabled' }),
    ...(request.sandbox.additionalWritableDirectories === undefined
      ? {}
      : { additionalDirectories: [...request.sandbox.additionalWritableDirectories] }),
    ...(model === undefined ? {} : { model }),
    ...(request.effort === undefined
      ? {}
      : {
          // Claude's top tier is named `max`; the pinned Codex SDK's equivalent ceiling is
          // `xhigh`. Keep `max` valid in portable source and translate only at this adapter seam.
          modelReasoningEffort: (request.effort === 'max' ? 'xhigh' : request.effort) as NonNullable<ThreadOptions['modelReasoningEffort']>,
        }),
  }
}

function codexModel(
  value: string | undefined,
  modelAliases: Readonly<Record<string, string | null>>,
): string | undefined {
  if (value === undefined) return undefined
  const mapped = modelAliases[value]
  if (mapped !== undefined) return mapped ?? undefined
  if (CLAUDE_MODEL_NAMES.has(value)) {
    throw new AgentProviderFailure(
      `Claude model alias ${JSON.stringify(value)} needs an explicit Codex model mapping`,
      { code: 'codex-model-unmapped' },
    )
  }
  return value
}

function codexTurnInput(request: AgentRequest): Input {
  if (request.recovery !== undefined && request.session !== undefined) {
    // The resumed thread already contains the original task and all completed tool calls. Sending
    // that task again looks like a new assignment and empirically encourages duplicate external
    // actions. The host-generated note is the entire new user turn; agent-type instructions are
    // retained because they may contain the output contract for the specialist.
    return request.instructions === undefined
      ? request.recovery.note
      : `${request.instructions}\n\nRecovery:\n${request.recovery.note}`
  }
  const task = request.instructions === undefined
    ? request.prompt
    : `${request.instructions}\n\nTask:\n${request.prompt}`
  return request.recovery === undefined
    ? task
    : `${task}\n\nRecovery:\n${request.recovery.note}`
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
