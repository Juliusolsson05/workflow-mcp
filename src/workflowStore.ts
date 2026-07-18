import type { LoadedWorkflow } from './loadWorkflow.js'
import type {
  ContentReference,
  WorkflowEvent,
  WorkflowResultMaterialization,
} from './workflowEvents.js'
import type { JournalSnapshot } from './workflowJournal.js'
import type {
  StoredWorkflowEvent,
  WorkflowEventPage,
  WorkflowResultArtifact,
  WorkflowResultPage,
  WorkflowRunManifest,
  WorkflowRunSnapshot,
} from './workflowProtocol.js'
export type {
  StoredWorkflowEvent,
  WorkflowEventPage,
  WorkflowResultArtifact,
  WorkflowResultPage,
  WorkflowRunManifest,
  WorkflowRunSnapshot,
  WorkflowRunStatus,
} from './workflowProtocol.js'

export const DEFAULT_WORKFLOW_RESULT_PAGE_BYTES = 16 * 1024
export const MIN_WORKFLOW_RESULT_PAGE_BYTES = 4
export const MAX_WORKFLOW_RESULT_PAGE_BYTES = 64 * 1024

export type CreateWorkflowRunInput = {
  runId: string
  cwd: string
  workflow: LoadedWorkflow
  args?: unknown
  idempotencyKey?: string
  clientId?: string
  resumedFromRunId?: string
  lineageId?: string
  recoveryMode?: 'manual' | 'automatic'
  automaticReplaySafe?: boolean
  providerRecoveryFingerprint?: string
  /**
   * Resume history is part of run creation, not a later runtime convenience. A successor manifest
   * must never become visible without the journal bytes that justify its cached/replayed calls.
   */
  journalSnapshots?: readonly JournalSnapshot[]
}

export type WorkflowStoreLease = {
  ownerId: string
  /** Monotonic-enough local fencing generation; the random token remains the authority. */
  generation: number
  release(): Promise<void>
}

export type WorkflowResultReadInput = {
  artifactId: string
  cursor?: string
  maxBytes: number
}

export interface WorkflowStore {
  initialize(): Promise<void>
  /** Corrupt histories are isolated per run so one cannot make the whole service unavailable. */
  listQuarantinedRuns?(): readonly { runId: string; code: string; message: string }[]
  /** Optional cross-process single-writer fence. It may be acquired before initialize(). */
  acquireLease?(ownerId: string): Promise<WorkflowStoreLease>
  createRun(input: CreateWorkflowRunInput): Promise<WorkflowRunManifest>
  getManifest(runId: string): Promise<WorkflowRunManifest | undefined>
  listManifests(): Promise<WorkflowRunManifest[]>
  findByIdempotencyKey(cwd: string, key: string): Promise<WorkflowRunManifest | undefined>
  appendEvent(runId: string, event: WorkflowEvent): Promise<StoredWorkflowEvent>
  readEvents(runId: string, after: number, limit: number): Promise<WorkflowEventPage>
  /** Persist before run.completed so every published locator already names durable bytes. */
  persistResult(
    runId: string,
    result: WorkflowResultMaterialization,
  ): Promise<ContentReference>
  /** Read one bounded UTF-8 page without loading the complete artifact. */
  readResult(runId: string, input: WorkflowResultReadInput): Promise<WorkflowResultPage>
  snapshot(runId: string): Promise<WorkflowRunSnapshot>
  loadWorkflow(runId: string): Promise<LoadedWorkflow>
  loadArgs(runId: string): Promise<{ provided: boolean; value?: unknown }>
  journalPath(runId: string): string
  transcriptDirectory(runId: string): string
}
