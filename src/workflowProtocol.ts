import type { WorkflowDefinitionReference, WorkflowEvent } from './workflowEvents.js'
import type { WorkflowSnapshot } from './workflowState.js'

/** Pure durable/wire DTOs shared by Node hosts and browser renderers. */
export type WorkflowRunStatus =
  | 'queued'
  | 'running'
  | 'cancellation_requested'
  | 'completed'
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
  resumedFromRunId?: string
  cancellationReason?: string
  error?: string
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
