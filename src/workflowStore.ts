import type { LoadedWorkflow } from './loadWorkflow.js'
import type {
  ContentChecksum,
  ContentReference,
  WorkflowEvent,
  WorkflowResultMaterialization,
} from './workflowEvents.js'
import type { JournalSnapshot } from './workflowJournal.js'
import type { WorkflowJournalWriteCoordinator } from './workflowWriteCoordinator.js'
import type {
  StoredWorkflowEvent,
  WorkflowAgentResultPage,
  WorkflowEventPage,
  WorkflowResultArtifact,
  WorkflowResultPage,
  WorkflowRunManifest,
  WorkflowRunSnapshot,
} from './workflowProtocol.js'
export type {
  StoredWorkflowEvent,
  WorkflowAgentListEntry,
  WorkflowAgentListPage,
  WorkflowAgentResultPage,
  WorkflowAgentResultsPage,
  WorkflowAgentTranscriptPage,
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

export type WorkflowStoreLeaseBackendLease = {
  generation: number
  /** Synchronous because persistent journals mutate through a synchronous execution contract. */
  assertOwned(): void
  release(): Promise<void>
}

/** Injected ownership authority for environments where PID liveness is not globally meaningful. */
export interface WorkflowStoreLeaseBackend {
  acquire(input: {
    rootDirectory: string
    ownerId: string
  }): Promise<WorkflowStoreLeaseBackendLease>
}

export type WorkflowResultReadInput = {
  artifactId: string
  cursor?: string
  maxBytes: number
}

export type WorkflowRunSummary = {
  schemaVersion: 1
  runId: string
  status: WorkflowRunManifest['status']
  cursor: number
  createdAt: string
  updatedAt: string
  workflow: {
    name: string
    title?: string
    description: string
  }
  lineageId: string
  resumedFromRunId?: string
  recoveryMode?: 'manual' | 'automatic'
}

export type WorkflowRunListInput = {
  cursor?: string
  limit?: number
  statuses?: readonly WorkflowRunManifest['status'][]
}

export type WorkflowRunListPage = {
  items: WorkflowRunSummary[]
  hasMore: boolean
  nextCursor?: string
}

export type WorkflowAgentResultReadInput = {
  /**
   * Optional, unlike the run-result equivalent. A completed run always has exactly one artifact to
   * name; an agent served from the journal fallback has none. Supplied values are still enforced as
   * an integrity fence.
   */
  artifactId?: string
  cursor?: string
  maxBytes: number
  /**
   * The agent's journal key, when the caller already resolved it from the snapshot. It is the
   * stable join column across a recovery lineage — a successor journal keeps its predecessor's
   * agent ids until each key is re-admitted, so agentId alone can miss.
   */
  cacheKey?: string
}

export interface WorkflowStore {
  initialize(): Promise<void>
  /** Corrupt histories are isolated per run so one cannot make the whole service unavailable. */
  listQuarantinedRuns?(): readonly { runId: string; code: string; message: string }[]
  /** Optional cross-process single-writer fence. It may be acquired before initialize(). */
  acquireLease?(ownerId: string): Promise<WorkflowStoreLease>
  /**
   * Coordinator for synchronous journal checkpoints which happen outside ordinary store methods.
   * A journal holding this reference cannot mint authority: runSync fails after lease quiesce.
   */
  journalWriteCoordinator?(): WorkflowJournalWriteCoordinator
  createRun(input: CreateWorkflowRunInput): Promise<WorkflowRunManifest>
  getManifest(runId: string): Promise<WorkflowRunManifest | undefined>
  listManifests(): Promise<WorkflowRunManifest[]>
  /** Bounded, path-redacted keyset inventory for standalone clients. */
  listRuns?(input: WorkflowRunListInput): Promise<WorkflowRunListPage>
  /** Indexed successor query keeps health and recovery off the unbounded manifest scan path. */
  findActiveLineageSuccessor?(
    lineageId: string,
    predecessorRunId: string,
  ): Promise<WorkflowRunManifest | undefined>
  findLatestSuccessor?(runId: string): Promise<WorkflowRunManifest | undefined>
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
  /**
   * Persist one agent's terminal value. Optional because it is observability, not execution: a
   * store that cannot do it must not stop workflows from running, and callers must treat a
   * rejection as non-fatal.
   */
  persistAgentResult?(
    runId: string,
    agentId: string,
    result: WorkflowResultMaterialization,
  ): Promise<ContentReference>
  /** Artifact-first with a journal fallback, so agents remain readable when the artifact is absent. */
  readAgentResult?(
    runId: string,
    agentId: string,
    input: WorkflowAgentResultReadInput,
  ): Promise<WorkflowAgentResultPage>
  /** Bulk locators for the list tool; reads the journal once for the whole run. */
  agentResultLocators?(
    runId: string,
    agents: readonly { agentId: string; cacheKey: string }[],
  ): Promise<Map<string, { source: 'artifact' | 'journal'; metadata?: { artifactId: string; mediaType: string; sizeBytes: number; lineCount: number; checksum: ContentChecksum }; coverageGap: boolean }>>
  snapshot(runId: string): Promise<WorkflowRunSnapshot>
  loadWorkflow(runId: string): Promise<LoadedWorkflow>
  loadArgs(runId: string): Promise<{ provided: boolean; value?: unknown }>
  journalPath(runId: string): string
  transcriptDirectory(runId: string): string
}
