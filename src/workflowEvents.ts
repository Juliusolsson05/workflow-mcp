import type {
  AgentActivityKind,
  AgentRecoveryContext,
  AgentReplaySafetyAssessment,
  AgentSandboxPolicy,
  AgentUsage,
  ProviderSessionReference,
} from './agentProvider.js'

export type { AgentUsage, ProviderSessionReference } from './agentProvider.js'

export type ContentChecksum = {
  algorithm: 'sha256'
  /** Lowercase hexadecimal digest of the complete UTF-8 artifact bytes. */
  value: string
}

/**
 * A bounded piece of content carried by the event stream.
 *
 * WHY both `preview` and `content` exist: most prompts and agent outcomes are small enough to
 * retain in events, while final workflow results now move their complete bytes into the artifact
 * store. Consumers must be able to render a list without loading an artifact, while an inspector
 * can still show inline content when it is present. The optional locator fields keep one additive
 * shape readable across legacy inline-only events and durable paginated results.
 */
export type ContentReference = {
  preview: string
  lineCount: number
  content?: unknown
  artifactId?: string
  mediaType?: string
  truncated?: boolean
  /** Exact UTF-8 artifact size, not JavaScript UTF-16 code units. */
  sizeBytes?: number
  /** Stable integrity identity for reassembling bounded result pages. */
  checksum?: ContentChecksum
}

/**
 * The executor owns JavaScript normalization while the store owns durable bytes.
 *
 * WHY this handoff contains a serialized string rather than the raw result: `runWorkflow` already
 * applies the compatibility boundary which turns Dates into ISO strings, rejects cycles and
 * blocked keys, and maps non-finite numbers to null. Asking a store to repeat that policy would
 * let the inline completion event and downloaded artifact disagree about what the workflow
 * returned. The store encodes this one canonical representation as UTF-8 and adds its locator.
 */
export type WorkflowResultMaterialization = {
  serializedContent: string
  reference: ContentReference
}

export type WorkflowErrorReference = {
  message: string
  name?: string
  code?: string
  stack?: string
  details?: unknown
}

/**
 * These are execution-affecting, provider-neutral options after runtime normalization. Labels,
 * phases, and cache keys intentionally do not belong here: they describe orchestration rather
 * than the provider request and must not accidentally leak into provider adapters.
 */
export type NormalizedAgentOptions = {
  model?: string
  effort?: string
  agentType?: string
  schema?: unknown
  workingDirectory?: string
  isolation?: string
  sandbox?: AgentSandboxPolicy
}

export type WorkflowDefinitionReference = {
  name: string
  description: string
  title?: string
  sourceHash?: string
  filePath?: string
}

export type WorkflowActivityKind = AgentActivityKind

export type WorkflowActivityDetails = {
  activityId: string
  kind: WorkflowActivityKind
  title?: string
  content?: ContentReference
  data?: unknown
}

export type AgentAdmitted = {
  callIndex: number
  label: string
  prompt: ContentReference
  options: NormalizedAgentOptions
  cacheKey: string
}

export type AgentOutcome = {
  source: 'live' | 'provider-resume' | 'journal'
  result: ContentReference
  structured: boolean
  usage?: AgentUsage
  providerSession?: ProviderSessionReference
  diagnostics?: Readonly<Record<string, unknown>>
}

export type AgentCoverageGapDisposition = {
  status: WorkflowAgentFailurePlaceholder['__workflowAgentFailure']['status']
  error: WorkflowErrorReference
}

export type AgentReusedOutcome = AgentOutcome & {
  /** Automatic recovery reused a terminal casualty rather than a provider success. */
  coverageGap?: AgentCoverageGapDisposition
}

export type AgentAttemptStarted = {
  attemptNumber: number
  source: 'live' | 'provider-resume'
  provider: string
  providerSession?: ProviderSessionReference
  startupDeadlineAt?: string
  absoluteDeadlineAt?: string
  workspaceId?: string
  /** Persisted before provider dispatch so crash recovery can evaluate the concrete request. */
  replaySafety?: AgentReplaySafetyAssessment
}

type EventEnvelope<Type extends string, Payload> = {
  schemaVersion: 1
  runId: string
  sequence: number
  eventId: string
  timestamp: string
  type: Type
  parentId?: string
  payload: Payload
}

type PhaseEvent<Type extends string, Payload> = EventEnvelope<Type, Payload> & {
  phaseId: string
}

type AgentEvent<Type extends string, Payload> = EventEnvelope<Type, Payload> & {
  agentId: string
  phaseId?: string
  attemptId?: string
}

type AttemptEvent<Type extends string, Payload> = AgentEvent<Type, Payload> & {
  attemptId: string
}

export type RunStartedEvent = EventEnvelope<
  'run.started',
  {
    workflow: WorkflowDefinitionReference
  }
>

export type RunCompletedEvent = EventEnvelope<
  'run.completed',
  {
    result: ContentReference
    /**
     * WHY this is carried by the existing completion event instead of adding a competing terminal
     * event: old event readers already understand `run.completed`, and the result is still a valid
     * best-effort product. The flag lets newer projections distinguish complete coverage from a
     * synthesis that honestly contains one or more assignment casualties.
     */
    withErrors?: boolean
  }
>

/**
 * A failed provider attempt is data for synthesis, not an exception which may tear down 199
 * healthy siblings. Keep the marker deliberately loud and versioned so workflow JavaScript cannot
 * confuse it with a provider's legitimate null/empty result and future versions can extend it
 * without guessing which ad-hoc error object a historical run returned.
 */
export type WorkflowAgentFailurePlaceholder = {
  __workflowAgentFailure: {
    schemaVersion: 1
    agentId: string
    label: string
    status: 'failed' | 'recovery_required' | 'skipped'
    message: string
    code?: string
    attempts: number
    coverageGap: true
  }
}

/**
 * Recognize the runtime-owned casualty value at every trust boundary.
 *
 * WHY this is stricter than the public marker's first two fields: durable recovery deliberately
 * bypasses a workflow's provider-output schema for coverage gaps. If a corrupt journal could set
 * `coverageGap: true` beside an arbitrary value, recovery would turn corrupted persistence into a
 * synthetic success. Keep the complete version-one contract centralized so the disk parser,
 * in-memory importer, and event projection cannot drift into different definitions of "gap".
 */
export function isWorkflowAgentFailurePlaceholder(
  value: unknown,
): value is WorkflowAgentFailurePlaceholder {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const marker = (value as Record<string, unknown>).__workflowAgentFailure
  if (typeof marker !== 'object' || marker === null || Array.isArray(marker)) return false
  const candidate = marker as Record<string, unknown>
  return candidate.schemaVersion === 1 &&
    typeof candidate.agentId === 'string' && candidate.agentId.length > 0 &&
    typeof candidate.label === 'string' &&
    (candidate.status === 'failed' ||
      candidate.status === 'recovery_required' ||
      candidate.status === 'skipped') &&
    typeof candidate.message === 'string' &&
    (candidate.code === undefined || typeof candidate.code === 'string') &&
    typeof candidate.attempts === 'number' &&
    Number.isInteger(candidate.attempts) &&
    // Assignment preparation can fail before a physical provider attempt exists; zero is an
    // honest terminal count for that casualty, while negatives/fractions indicate corruption.
    candidate.attempts >= 0 &&
    candidate.coverageGap === true
}

export type SerializedWorkflowValue = {
  content: string
  mediaType: 'text/plain' | 'application/json'
}

/**
 * The single spelling of "this workflow value as durable UTF-8".
 *
 * WHY centralized: the same value is now serialized in three places — the final run result, the
 * per-agent result artifact, and the journal fallback that serves agents whose artifact write was
 * dropped. If those drifted, an agent read from the journal would return different bytes than the
 * same agent read from its artifact, and the checksum-fenced cursors would silently disagree about
 * what the content even is. `undefined` keeps its explicit 'undefined' spelling rather than being
 * coerced to null, because JSON has no way to say it and lying is worse than a sentinel.
 */
export function serializeWorkflowValue(value: unknown): SerializedWorkflowValue {
  if (value === undefined) return { content: 'undefined', mediaType: 'text/plain' }
  if (typeof value === 'string') return { content: value, mediaType: 'text/plain' }
  return { content: JSON.stringify(value, null, 2), mediaType: 'application/json' }
}

export type RunFailedEvent = EventEnvelope<
  'run.failed',
  {
    error: WorkflowErrorReference
  }
>

export type RunCancellationRequestedEvent = EventEnvelope<
  'run.cancellation_requested',
  {
    reason?: string
  }
>

export type RunCancelledEvent = EventEnvelope<
  'run.cancelled',
  {
    reason?: string
  }
>

/**
 * Recovery writes this terminal event when a process died without completing its active run.
 * It is distinct from cancellation: no cooperative cancel was observed, and claiming otherwise
 * would make resume diagnostics lie about the previous process's last durable state.
 */
export type RunInterruptedEvent = EventEnvelope<
  'run.interrupted',
  {
    reason: string
  }
>

export type PhaseDiscoveredEvent = PhaseEvent<
  'phase.discovered',
  {
    title: string
    detail?: string
    model?: string
    source: 'metadata' | 'runtime'
  }
>

export type PhaseEnteredEvent = PhaseEvent<'phase.entered', { title: string }>
export type PhaseCompletedEvent = PhaseEvent<'phase.completed', { title: string }>
export type PhaseFailedEvent = PhaseEvent<
  'phase.failed',
  { title: string; error: WorkflowErrorReference }
>

export type AgentAdmittedEvent = AgentEvent<'agent.admitted', AgentAdmitted>
export type AgentQueuedEvent = AgentEvent<'agent.queued', { reason?: string }>
export type AgentReusedEvent = AgentEvent<'agent.reused', AgentReusedOutcome>
export type AgentStartedEvent = AttemptEvent<'agent.started', AgentAttemptStarted>
export type AgentWorkspacePreparedEvent = AgentEvent<
  'agent.workspace.prepared',
  {
    workspaceId: string
    path: string
    reused: boolean
    leaseId?: string
  }
>
export type AgentSessionStartedEvent = AttemptEvent<
  'agent.session.started',
  { session: ProviderSessionReference }
>
export type AgentActivityStartedEvent = AttemptEvent<
  'agent.activity.started',
  { activity: WorkflowActivityDetails }
>
export type AgentActivityUpdatedEvent = AttemptEvent<
  'agent.activity.updated',
  {
    activityId: string
    title?: string
    content?: ContentReference
    data?: unknown
  }
>
export type AgentActivityCompletedEvent = AttemptEvent<
  'agent.activity.completed',
  {
    activityId: string
    title?: string
    content?: ContentReference
    data?: unknown
    error?: WorkflowErrorReference
  }
>
export type AgentCompletedEvent = AgentEvent<'agent.completed', AgentOutcome>
export type AgentStalledEvent = AttemptEvent<
  'agent.stalled',
  {
    kind: 'startup' | 'idle' | 'active-operation' | 'absolute'
    lastProgressAt: string
    deadlineAt: string
  }
>
export type AgentFailedEvent = AgentEvent<
  'agent.failed',
  {
    error: WorkflowErrorReference
    /** A failed attempt may be followed by another attempt for the same logical agent. */
    retrying?: boolean
  }
>
export type AgentRetryScheduledEvent = AgentEvent<
  'agent.retry_scheduled',
  {
    completedAttemptNumber: number
    nextAttemptNumber: number
    delayMs: number
    retryAt: string
    reason: WorkflowErrorReference
  }
>
export type AgentTerminationConfirmedEvent = AttemptEvent<
  'agent.termination_confirmed',
  {
    reason: 'timeout' | 'cancellation' | 'shutdown'
    boundary: 'settlement' | 'process-tree'
  }
>
export type AgentRecoveryStartedEvent = AttemptEvent<
  'agent.recovery_started',
  {
    previousAttemptId: string
    context: AgentRecoveryContext
  }
>
export type AgentRecoveryCompletedEvent = AttemptEvent<
  'agent.recovery_completed',
  { previousAttemptId: string }
>
export type AgentRecoveryRequiredEvent = AttemptEvent<
  'agent.recovery_required',
  {
    error: WorkflowErrorReference
    replaySafety: AgentReplaySafetyAssessment
  }
>
export type AgentSkippedEvent = AgentEvent<'agent.skipped', { reason?: string }>
export type AgentCancelledEvent = AgentEvent<'agent.cancelled', { reason?: string }>

export type LogEvent = EventEnvelope<
  'log',
  {
    message: ContentReference
    level?: 'debug' | 'info' | 'warn' | 'error'
  }
> & {
  phaseId?: string
  agentId?: string
}

export type WarningEvent = EventEnvelope<
  'warning',
  {
    message: string
    code?: string
    details?: unknown
  }
> & {
  phaseId?: string
  agentId?: string
  attemptId?: string
}

export type ArtifactCreatedEvent = EventEnvelope<
  'artifact.created',
  {
    artifactId: string
    name: string
    mediaType?: string
    sizeBytes?: number
  }
> & {
  phaseId?: string
  agentId?: string
  attemptId?: string
}

/**
 * This is deliberately a closed union. Provider-native events must be normalized before they
 * cross this boundary, and reducer switches use `never` to make adding an event a compile-time
 * decision instead of silently dropping it from snapshots.
 */
export type WorkflowEvent =
  | RunStartedEvent
  | RunCompletedEvent
  | RunFailedEvent
  | RunCancellationRequestedEvent
  | RunCancelledEvent
  | RunInterruptedEvent
  | PhaseDiscoveredEvent
  | PhaseEnteredEvent
  | PhaseCompletedEvent
  | PhaseFailedEvent
  | AgentAdmittedEvent
  | AgentQueuedEvent
  | AgentReusedEvent
  | AgentStartedEvent
  | AgentWorkspacePreparedEvent
  | AgentSessionStartedEvent
  | AgentActivityStartedEvent
  | AgentActivityUpdatedEvent
  | AgentActivityCompletedEvent
  | AgentCompletedEvent
  | AgentStalledEvent
  | AgentFailedEvent
  | AgentRetryScheduledEvent
  | AgentTerminationConfirmedEvent
  | AgentRecoveryStartedEvent
  | AgentRecoveryCompletedEvent
  | AgentRecoveryRequiredEvent
  | AgentSkippedEvent
  | AgentCancelledEvent
  | LogEvent
  | WarningEvent
  | ArtifactCreatedEvent

export type WorkflowEventType = WorkflowEvent['type']

export type WorkflowEventSink = (event: WorkflowEvent) => void | Promise<void>
