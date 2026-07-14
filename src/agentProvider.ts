/**
 * The provider boundary deliberately contains no workflow concepts. A provider should never need
 * to know which phase owns a call, how a journal key was made, or how many sibling calls exist.
 * Keeping those identities above this interface is what lets the same workflow scheduler drive a
 * fake, Codex, or a future provider without leaking one provider's event model into saved runs.
 */

export type AgentSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

export type AgentApprovalPolicy = 'never' | 'on-request' | 'on-failure' | 'untrusted'

export type AgentSandboxPolicy = {
  mode: AgentSandboxMode
  approvalPolicy: AgentApprovalPolicy
  network: boolean
  additionalWritableDirectories?: readonly string[]
}

export type ProviderSessionReference = {
  /** A provider name prevents accidentally handing a Codex thread ID to another adapter. */
  provider: string
  id: string
}

export type AgentRequest = {
  prompt: string
  schema?: unknown
  model?: string
  effort?: string
  workingDirectory: string
  sandbox: AgentSandboxPolicy
  /** Agent-type names are resolved above this boundary so adapters receive actual instructions. */
  instructions?: string
  /** When present, the adapter resumes this provider session instead of opening a fresh one. */
  session?: ProviderSessionReference
}

export type AgentUsage = {
  inputTokens: number
  outputTokens: number
  cachedInputTokens?: number
  reasoningTokens?: number
  /** Optional because adapters must retain raw usage rather than invent a provider-missing total. */
  totalTokens?: number
}

export type AgentProviderOutput =
  | { type: 'text'; text: string }
  | { type: 'structured'; value: unknown }

export type AgentProviderResult = {
  output: AgentProviderOutput
  usage?: AgentUsage
  providerSession?: ProviderSessionReference
  /** Adapter versions and provider request IDs are useful diagnostics, but never drive semantics. */
  diagnostics?: Readonly<Record<string, unknown>>
}

export type AgentActivityKind =
  | 'message'
  | 'reasoning'
  | 'command'
  | 'file_change'
  | 'tool_call'
  | 'web_search'
  | 'todo_list'
  | 'error'

export type AgentProviderActivity = {
  /** Stable within one provider attempt; the parent adds run/agent/attempt identity later. */
  id: string
  kind: AgentActivityKind
  title?: string
  /** Structured data is retained so consumers are not forced to reverse-parse terminal text. */
  content?: unknown
}

export type AgentProviderEvent =
  | {
      type: 'session.started'
      session: ProviderSessionReference
      diagnostics?: Readonly<Record<string, unknown>>
    }
  | { type: 'activity.started'; activity: AgentProviderActivity }
  | {
      type: 'activity.updated'
      activityId: string
      patch: Partial<Omit<AgentProviderActivity, 'id'>>
    }
  | { type: 'activity.completed'; activity: AgentProviderActivity }
  | { type: 'warning'; message: string; code?: string }

export type AgentProviderExecutionContext = {
  signal: AbortSignal
  /**
   * Emission is awaited so the parent remains the single ordering authority. Fire-and-forget
   * callbacks can reorder an activity completion ahead of its update under concurrent load.
   */
  emit(event: AgentProviderEvent): Promise<void>
}

export type AgentProvider = {
  /** Available before execution so queued/started events never need a guessed provider name. */
  readonly name: string
  execute(request: AgentRequest, context: AgentProviderExecutionContext): Promise<AgentProviderResult>
}

export type AgentProviderFailureOptions = {
  code?: string
  retryable?: boolean
  providerSession?: ProviderSessionReference
  cause?: unknown
}

/**
 * A terminal API/provider failure is intentionally different from an ordinary JavaScript error.
 * Claude-compatible `agent()` handling turns the former into a logged null result while allowing
 * programming errors in an adapter or fake setup to reject the workflow call.
 */
export class AgentProviderFailure extends Error {
  readonly code?: string
  readonly retryable: boolean
  readonly providerSession?: ProviderSessionReference

  constructor(message: string, options: AgentProviderFailureOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'AgentProviderFailure'
    if (options.code !== undefined) this.code = options.code
    this.retryable = options.retryable ?? false
    if (options.providerSession !== undefined) this.providerSession = options.providerSession
  }
}

/** A named error makes deterministic cancellation assertions possible without DOM implementation quirks. */
export class AgentProviderAbortError extends Error {
  readonly reason: unknown

  constructor(reason?: unknown) {
    super(abortMessage(reason), reason instanceof Error ? { cause: reason } : undefined)
    this.name = 'AbortError'
    this.reason = reason
  }
}

function abortMessage(reason: unknown): string {
  if (reason instanceof Error && reason.message.length > 0) return reason.message
  if (typeof reason === 'string' && reason.length > 0) return reason
  return 'Agent provider execution was aborted'
}

export function throwIfAgentProviderAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new AgentProviderAbortError(signal.reason)
}
