import type { LoadedWorkflow } from './loadWorkflow.js'
import type { WorkflowEvent } from './workflowEvents.js'
import type {
  StoredWorkflowEvent,
  WorkflowEventPage,
  WorkflowRunManifest,
  WorkflowRunSnapshot,
} from './workflowProtocol.js'
export type {
  StoredWorkflowEvent,
  WorkflowEventPage,
  WorkflowRunManifest,
  WorkflowRunSnapshot,
  WorkflowRunStatus,
} from './workflowProtocol.js'

export type CreateWorkflowRunInput = {
  runId: string
  cwd: string
  workflow: LoadedWorkflow
  args?: unknown
  idempotencyKey?: string
  resumedFromRunId?: string
}

export interface WorkflowStore {
  initialize(): Promise<void>
  createRun(input: CreateWorkflowRunInput): Promise<WorkflowRunManifest>
  getManifest(runId: string): Promise<WorkflowRunManifest | undefined>
  listManifests(): Promise<WorkflowRunManifest[]>
  findByIdempotencyKey(cwd: string, key: string): Promise<WorkflowRunManifest | undefined>
  appendEvent(runId: string, event: WorkflowEvent): Promise<StoredWorkflowEvent>
  readEvents(runId: string, after: number, limit: number): Promise<WorkflowEventPage>
  snapshot(runId: string): Promise<WorkflowRunSnapshot>
  loadWorkflow(runId: string): Promise<LoadedWorkflow>
  loadArgs(runId: string): Promise<{ provided: boolean; value?: unknown }>
  journalPath(runId: string): string
}
