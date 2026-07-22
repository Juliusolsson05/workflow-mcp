import type {
  ContentChecksum,
  ContentReference,
  WorkflowDefinitionReference,
  WorkflowEvent,
} from './workflowEvents.js'
import type {
  WorkflowAgentStatus,
  WorkflowAttemptStatus,
  WorkflowSnapshot,
} from './workflowState.js'

/** Pure durable/wire DTOs shared by Node hosts and browser renderers. */
export type WorkflowRunStatus =
  | 'queued'
  | 'running'
  | 'cancellation_requested'
  | 'completed'
  | 'completed_with_errors'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

export type WorkflowRunManifest = {
  schemaVersion: 1
  runId: string
  cwd: string
  workflow: WorkflowDefinitionReference
  status: WorkflowRunStatus
  cursor: number
  createdAt: string
  updatedAt: string
  idempotencyKey?: string
  /** Transport scope used to reconstruct the same provider/MCP client after a host restart. */
  clientId?: string
  resumedFromRunId?: string
  /** Root run shared by manual and automatic recovery descendants. */
  lineageId?: string
  recoveryMode?: 'manual' | 'automatic'
  /** Persisted decision; recovery must not reinterpret a later host's provider configuration. */
  automaticReplaySafe?: boolean
  /** Exact provider/configuration evidence which must match before crash recovery can replay. */
  providerRecoveryFingerprint?: string
  cancellationReason?: string
  error?: string
  /** Compact completion reference; full bytes remain in the run-owned result artifact. */
  result?: ContentReference
}

export type WorkflowResultArtifact = {
  artifactId: string
  mediaType: string
  sizeBytes: number
  lineCount: number
  checksum: ContentChecksum
}

export type WorkflowResultPage = {
  runId: string
  artifact: WorkflowResultArtifact
  encoding: 'utf-8'
  /** Inclusive byte offset in the immutable UTF-8 artifact. */
  fromByte: number
  /** Exclusive byte offset; use `nextCursor` instead of manufacturing offsets. */
  toByte: number
  content: string
  hasMore: boolean
  nextCursor?: string
}

/**
 * Where an agent's bytes came from.
 *
 * `artifact` is the fsynced per-agent blob written at completion. `journal` is the untruncated
 * value recorded in the run journal, which is the only source for runs created before per-agent
 * artifacts existed — and the fallback whenever an artifact write was dropped (that write is
 * deliberately best-effort so an observability failure can never fail an agent). `none` means the
 * agent has not produced a terminal value yet.
 */
export type WorkflowAgentResultSource = 'artifact' | 'journal' | 'none'

export type WorkflowAgentResultLocator = {
  available: boolean
  source: WorkflowAgentResultSource
  artifactId?: string
  mediaType?: string
  /** UTF-8 bytes. Event previews count UTF-16 units; these two never have to agree. */
  sizeBytes?: number
  lineCount?: number
  checksum?: ContentChecksum
}

/** One physical attempt. Abandoned attempts stay here as history; the agent above is logical. */
export type WorkflowAgentAttemptEntry = {
  attemptId: string
  attemptNumber: number
  status: WorkflowAttemptStatus
  startedAt?: string
  completedAt?: string
}

export type WorkflowAgentListEntry = {
  agentId: string
  callIndex: number
  label: string
  phaseId?: string
  phaseTitle?: string
  status: WorkflowAgentStatus
  /** Served from the journal without re-running the agent (a cache hit, not a fresh execution). */
  reused: boolean
  /**
   * The terminal value is a `__workflowAgentFailure` placeholder rather than provider output. Kept
   * readable rather than filtered: it is the honest outcome for an exhausted assignment, and a run
   * where a handful of agents gapped is exactly when those values need reading.
   */
  coverageGap: boolean
  attempts: WorkflowAgentAttemptEntry[]
  result: WorkflowAgentResultLocator
}

export type WorkflowAgentListPage = {
  runId: string
  /**
   * Echoed with `cursor` so a caller can poll deterministically while the run is still moving.
   * Per-agent reads deliberately do not require a terminal run — inspecting a live fan-out is the
   * point — so the caller needs the run's position to know whether to look again.
   */
  runStatus: WorkflowRunStatus
  cursor: number
  agents: WorkflowAgentListEntry[]
}

/** Identical paging contract to `WorkflowResultPage`, plus which agent and which source. */
export type WorkflowAgentResultPage = {
  runId: string
  agentId: string
  source: 'artifact' | 'journal'
  artifact: WorkflowResultArtifact
  encoding: 'utf-8'
  fromByte: number
  toByte: number
  content: string
  hasMore: boolean
  nextCursor?: string
}

export type WorkflowAgentResultsPage = {
  runId: string
  /** Ordered by `callIndex` ascending — the canonical agent order everywhere else in this package. */
  items: WorkflowAgentResultPage[]
  hasMore: boolean
  /** Composite `v1.<agentId>.<sha256>.<offset>`; advances to the next agent when one is exhausted. */
  nextCursor?: string
}

export type WorkflowAgentTranscriptPage = {
  runId: string
  agentId: string
  fromCursor: number
  toCursor: number
  events: StoredWorkflowEvent[]
  hasMore: boolean
}

export type StoredWorkflowEvent = {
  runId: string
  cursor: number
  recordedAt: string
  event: WorkflowEvent
}

export type WorkflowRunSnapshot = {
  manifest: WorkflowRunManifest
  state: WorkflowSnapshot
  cursor: number
}

export type WorkflowEventPage = {
  runId: string
  cwd: string
  fromCursor: number
  toCursor: number
  events: StoredWorkflowEvent[]
  hasMore: boolean
}
