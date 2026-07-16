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
  /**
   * Host-generated context for a replacement physical attempt.
   *
   * WHY this is separate from `prompt`: the original prompt participates in Claude-compatible
   * journal identity. Folding an operational recovery note into that prompt would turn a retry of
   * one logical call into a different call and invalidate otherwise reusable siblings. Providers
   * may render this context differently, but they must never use it as journal/cache identity.
   */
  recovery?: AgentRecoveryContext
}

export type AgentRecoveryContext = {
  reason: string
  previousAttemptNumber: number
  lastProgressAt: string
  uncertainInFlightActivity?: {
    id: string
    kind: AgentActivityKind
    title?: string
  }
  /** The exact host-generated note sent to a resumed provider session. */
  note: string
}

export type AgentReplayRisk =
  | 'read_only'
  | 'worktree_write'
  | 'idempotent_external'
  | 'unknown_external'

export type AgentReplaySafetyAssessment = {
  automatic: boolean
  risk: AgentReplayRisk
  reason: string
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
   * Durable runtime identity for one physical attempt. Providers which launch child processes use
   * this key to terminate only the wedged attempt instead of killing healthy siblings sharing the
   * same adapter instance.
   */
  attempt?: AgentProviderAttemptIdentity
  /**
   * Emission is awaited so the parent remains the single ordering authority. Fire-and-forget
   * callbacks can reorder an activity completion ahead of its update under concurrent load.
   */
  emit(event: AgentProviderEvent): Promise<void>
  /**
   * A provider-host heartbeat proves only that the host boundary is responsive. It deliberately
   * does not enter the durable activity stream and must not reset the meaningful-progress clock;
   * otherwise a healthy wrapper around a wedged Codex child could defeat the idle watchdog.
   */
  heartbeat?(at: string): void
}

export type AgentProviderAttemptIdentity = {
  runId: string
  agentId: string
  attemptId: string
  attemptNumber: number
}

export type AgentProviderTerminationReason = {
  code: 'timeout' | 'cancellation' | 'shutdown'
  message: string
}

export type AgentProvider = {
  /** Available before execution so queued/started events never need a guessed provider name. */
  readonly name: string
  /**
   * Whether an interrupted or timed-out request may be repeated automatically.
   *
   * WHY this is explicit instead of inferred from a read-only filesystem sandbox: MCP and other
   * remote tools can send mail, mutate databases, or trigger deployments while the local checkout
   * remains perfectly read-only. Unknown providers therefore fail closed. A host should advertise
   * `safe` only when every reachable tool is read-only or independently idempotent; manual resume
   * remains available when that cannot be proven.
   */
  readonly automaticReplaySafety?: 'safe' | 'unsafe-or-unknown'
  /**
   * Stable digest of the executable and complete effective capability policy used to justify
   * automatic replay. Recovery compares this exact value with the current provider; absence means
   * a provider-wide `safe` flag is useful for same-process retries only, never crash recovery.
   */
  readonly recoveryFingerprint?: string
  /**
   * Request-aware replay classification supersedes the legacy provider-wide flag when present.
   * Filesystem policy, worktree isolation, network access, and exposed MCP capabilities are known
   * only after a concrete request exists, so one global boolean cannot describe them honestly.
   */
  assessReplaySafety?(request: AgentRequest): AgentReplaySafetyAssessment
  /**
   * What execution-promise settlement proves after cancellation.
   *
   * SDK wrappers which kill only their direct CLI child while that child may have spawned tools
   * must use `unconfirmed-descendants`; the runtime then refuses a same-process ownership handoff.
   * A process-owning adapter may use `process-tree` only when its termination hook reaps the whole
   * group. Ordinary in-process/network adapters can rely on the default `settlement` boundary.
   */
  readonly terminationBoundary?: 'settlement' | 'process-tree' | 'unconfirmed-descendants'
  execute(request: AgentRequest, context: AgentProviderExecutionContext): Promise<AgentProviderResult>
  /**
   * Optional escalation after cooperative AbortSignal cancellation did not settle promptly.
   *
   * WHY this is attempt-addressed and optional: SDK-only adapters may not expose a child PID, while
   * process-owning adapters can and must kill the complete descendant tree. Making a global
   * `terminate()` method would let one stalled turn destroy unrelated concurrent agents.
   */
  terminateAttempt?(
    attempt: AgentProviderAttemptIdentity,
    reason: AgentProviderTerminationReason,
  ): Promise<void>
}

export type AgentProviderFailureOptions = {
  code?: string
  retryable?: boolean
  /**
   * Whether this failure says the provider itself is unavailable.
   *
   * WHY retryability is not enough: a missing provider-session file can be safe to recover with a
   * fresh thread, but it is deterministic and local to one logical agent. Treating every
   * retryable failure as an outage lets five corrupt/stale sessions open a service-wide circuit
   * and serialize unrelated healthy workflows. Providers therefore mark request-local failures
   * neutral while transport/process/rate-limit failures retain the infrastructure default.
   */
  circuitImpact?: 'infrastructure' | 'neutral'
  /**
   * Kept on the provider wire for backwards compatibility with older hosts. The unattended
   * supervisor now returns a versioned failure placeholder for both dispositions: malformed
   * contract output is a coverage gap for synthesis, not permission to terminate every sibling.
   */
  terminalDisposition?: 'null-slot' | 'reject'
  providerSession?: ProviderSessionReference
  cause?: unknown
}

/**
 * A terminal API/provider failure carries retry and circuit policy across adapter boundaries.
 * The workflow supervisor turns an exhausted instance into a versioned coverage-gap result so
 * unattended siblings and final synthesis can continue without mistaking failure for null data.
 */
export class AgentProviderFailure extends Error {
  readonly code?: string
  readonly retryable: boolean
  readonly circuitImpact: 'infrastructure' | 'neutral'
  readonly terminalDisposition: 'null-slot' | 'reject'
  readonly providerSession?: ProviderSessionReference

  constructor(message: string, options: AgentProviderFailureOptions = {}) {
    super(message)
    if (options.cause !== undefined) Object.defineProperty(this, 'cause', { value: options.cause })
    this.name = 'AgentProviderFailure'
    if (options.code !== undefined) this.code = options.code
    this.retryable = options.retryable ?? false
    this.circuitImpact = options.circuitImpact ?? (this.retryable ? 'infrastructure' : 'neutral')
    this.terminalDisposition = options.terminalDisposition ?? 'null-slot'
    if (options.providerSession !== undefined) this.providerSession = options.providerSession
  }
}

/** A named error makes deterministic cancellation assertions possible without DOM implementation quirks. */
export class AgentProviderAbortError extends Error {
  readonly reason: unknown

  constructor(reason?: unknown) {
    super(abortMessage(reason))
    if (reason instanceof Error) Object.defineProperty(this, 'cause', { value: reason })
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
