import type {
  ContentChecksum,
  ContentReference,
  WorkflowDefinitionReference,
  WorkflowEvent,
} from './workflowEvents.js'
import type { WorkflowSnapshot } from './workflowState.js'

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
