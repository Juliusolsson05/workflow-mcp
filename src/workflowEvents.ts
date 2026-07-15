import type {
  AgentActivityKind,
  AgentRecoveryContext,
  AgentReplaySafetyAssessment,
  AgentSandboxPolicy,
  AgentUsage,
  ProviderSessionReference,
} from './agentProvider.js'

export type { AgentUsage, ProviderSessionReference } from './agentProvider.js'

/**
 * A bounded piece of content carried by the event stream.
 *
 * WHY both `preview` and `content` exist: prompts and outcomes are small enough to retain in
 * memory today, but production runs will eventually move large values into an artifact store.
 * Consumers must be able to render a list without loading the artifact, while an inspector can
 * still show the full value when it is present. Keeping that distinction in version one avoids a
 * breaking event migration when persistence arrives.
 */
export type ContentReference = {
  preview: string
  lineCount: number
  content?: unknown
  artifactId?: string
  mediaType?: string
  truncated?: boolean
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

export type AgentAttemptStarted = {
  attemptNumber: number
  source: 'live' | 'provider-resume'
  provider: string
  providerSession?: ProviderSessionReference
  startupDeadlineAt?: string
  absoluteDeadlineAt?: string
  workspaceId?: string
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
  }
>

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
export type AgentReusedEvent = AgentEvent<'agent.reused', AgentOutcome>
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
