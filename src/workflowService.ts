import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import type { AgentProvider, AgentSandboxPolicy } from './agentProvider.js'
import {
  ClaudeResumeError,
  findClaudeWorkflowRunMetadata,
  loadClaudeWorkflowResume,
} from './claudeResume.js'
import { findWorkflows } from './findWorkflows.js'
import type { FoundWorkflow } from './findWorkflows.js'
import type { LoadedWorkflow } from './loadWorkflow.js'
import { PersistentWorkflowJournal } from './persistentWorkflowJournal.js'
import type { JournalReuseMode } from './workflowJournal.js'
import { runWorkflow } from './runWorkflow.js'
import type { RunWorkflowOptions, WorkflowLimits, WorkflowResolver, WorkflowRun } from './runWorkflow.js'
import { normalizeReliabilityPolicy, ProviderCircuitBreaker } from './executionReliability.js'
import type { ProviderCircuitSnapshot, WorkflowReliabilityPolicy } from './executionReliability.js'
import {
  loadScopedWorkflowPath,
  persistInlineWorkflow,
  WorkflowAuthoringError,
} from './workflowAuthoring.js'
import type { WorkflowEvent, WorkflowResultMaterialization } from './workflowEvents.js'
import type { WorkflowWorkerLauncher } from './workerLauncher.js'
import type {
  StoredWorkflowEvent,
  WorkflowEventPage,
  WorkflowRunManifest,
  WorkflowRunSnapshot,
  WorkflowRunStatus,
  WorkflowAgentListEntry,
  WorkflowAgentListPage,
  WorkflowAgentResultPage,
  WorkflowAgentResultsPage,
  WorkflowAgentTranscriptPage,
  WorkflowResultPage,
  WorkflowRunListInput,
  WorkflowRunListPage,
  WorkflowStore,
  WorkflowStoreLease,
} from './workflowStore.js'
import {
  DEFAULT_WORKFLOW_RESULT_PAGE_BYTES,
  MAX_WORKFLOW_RESULT_PAGE_BYTES,
  MIN_WORKFLOW_RESULT_PAGE_BYTES,
} from './workflowStore.js'
import { WorkConservingScheduler } from './workConservingScheduler.js'
import type { AgentScheduler, SchedulerSnapshot } from './workConservingScheduler.js'

const TERMINAL_STATUSES = new Set<WorkflowRunStatus>([
  'completed',
  'completed_with_errors',
  'failed',
  'cancelled',
  'interrupted',
])
const MAX_EVENTS_PER_PAGE = 1_000
const MAX_WAIT_MS = 30_000

export type WorkflowServiceScope = {
  cwd: string
  clientId?: string
}

export type WorkflowServiceOptions = {
  store: WorkflowStore
  provider: AgentProvider | ((context: WorkflowProviderFactoryContext) => AgentProvider)
  /**
   * Root containing Claude's project-key directories. Production uses ~/.claude/projects; an
   * explicit root lets embedders with isolated Claude state and tests preserve the same scope rules
   * without mutating the process home directory.
   */
  claudeProjectsRoot?: string
  /**
   * Side-effect-free recovery evidence for lazy provider factories. Initialization must compare
   * persisted capability evidence without constructing a run-scoped provider twice. Static
   * providers expose the same values directly and do not need this callback.
   */
  providerRecoveryEvidence?(context: WorkflowProviderFactoryContext): {
    fingerprint?: string
    automaticReplaySafe: boolean
  }
  /**
   * App-owned source approval keyed by canonical identity plus immutable bytes.
   *
   * The portable runtime cannot decide whether repository-controlled JavaScript is trusted for a
   * particular signed-in user. Embedders can display or persist approval here; returning false
   * prevents worker creation. A one-byte edit changes sourceHash and therefore requires a new grant.
   */
  authorizeWorkflowSource?(request: WorkflowSourceAuthorizationRequest): boolean | Promise<boolean>
  /**
   * Inline source persists into the project before execution. Embedded Agent Code keeps its
   * historical authoring behavior by default; read-only products must disable it explicitly so a
   * policy error is returned before mkdir/open rather than leaking an EROFS implementation detail.
   */
  allowInlineWorkflowAuthoring?: boolean
  workerLauncher?: WorkflowWorkerLauncher
  workerFilePath?: string
  limits?: Partial<WorkflowLimits>
  reliability?: Partial<WorkflowReliabilityPolicy>
  /** Shared provider capacity across every run owned by this service. */
  scheduler?: AgentScheduler
  recovery?: Partial<WorkflowRecoveryPolicy>
  /**
   * Selects which provider outage domain shares a circuit. The provider name is the safe default;
   * hosts with multiple accounts or regions can include that immutable scope here.
   */
  providerCircuitKey?(provider: AgentProvider, context: WorkflowProviderFactoryContext): string
  budgetTokens?: number | null
  defaultModel?: string
  modelAliases?: Readonly<Record<string, string | null>>
  defaultEffort?: string
  sandbox?: Partial<AgentSandboxPolicy>
  resolveAgentType?(name: string, cwd: string): Promise<string | undefined>
  prepareWorkingDirectory?: RunWorkflowOptions['prepareWorkingDirectory']
}

export type WorkflowRecoveryPolicy = {
  /** Recover only runs which durably reached run.started; never guess about an untouched queue row. */
  autoResumeOnInitialize: boolean
  /** Mutable shared checkouts can contain ambiguous side effects and are manual by default. */
  allowMutableSandbox: boolean
}

const DEFAULT_RECOVERY_POLICY: Readonly<WorkflowRecoveryPolicy> = {
  autoResumeOnInitialize: true,
  allowMutableSandbox: false,
}

export type WorkflowProviderFactoryContext = {
  runId: string
  cwd: string
  /** MCP client/session which requested this run, when the transport has one. */
  clientId?: string
}

export type WorkflowSourceAuthorizationRequest = {
  cwd: string
  clientId?: string
  origin: 'root' | 'nested'
  canonicalIdentity: string
  sourceHash: string
  workflowName: string
}

export type WorkflowRunStartResult = {
  runId: string
  /** Normally queued/running; an idempotent retry reports the existing run's honest status. */
  status: WorkflowRunStatus
  workflow: {
    name: string
    title?: string
    description: string
  }
  cursor: number
  /** Editable Claude-visible definition. The private run store separately snapshots these bytes. */
  scriptPath?: string
  /** Directory containing Claude-shaped agent-<id>.jsonl transcript mirrors for this run. */
  transcriptDirectory: string
  resumedFromRunId?: string
  lineageId?: string
  recoveryMode?: 'manual' | 'automatic'
}

export type WorkflowStoredRunReference = WorkflowRunStartResult & {
  cwd: string
  clientId?: string
}

export type WorkflowRunHealth = {
  runId: string
  status: WorkflowRunStatus
  cursor: number
  scheduler: SchedulerSnapshot
  providerCircuit: ProviderCircuitSnapshot
  agents: {
    total: number
    queued: number
    running: number
    stalled: number
    retrying: number
    completed: number
    failed: number
    recoveryRequired: number
  }
  lastProgressAt?: string
  oldestRunningSince?: string
  lineageId: string
  recoveryMode?: 'manual' | 'automatic'
  /** Newest linked continuation, allowing clients to follow an interrupted generation. */
  successorRunId?: string
}

export type WorkflowServiceErrorCode =
  | 'run-not-found'
  | 'scope-forbidden'
  | 'workflow-not-found'
  | 'run-not-resumable'
  | 'service-stopping'
  | 'service-stopped'
  | 'unsafe-provider-active'
  | 'source-approval-required'
  | 'authoring-disabled'
  | 'result-not-ready'
  | 'result-unavailable'
  | 'result-not-found'
  | 'agent-not-found'
  | 'result-expired'
  | 'cursor-ahead'
  | 'invalid-cursor'
  | 'invalid-request'

export class WorkflowServiceError extends Error {
  readonly code: WorkflowServiceErrorCode

  constructor(code: WorkflowServiceErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'WorkflowServiceError'
    this.code = code
  }
}

export type WorkflowStartInput = {
  /** Lowest-precedence source selector, matching Claude's Workflow tool. */
  name?: string
  /** Inline Claude-compatible workflow source; persisted before execution. */
  script?: string
  /** Highest-precedence source selector, scoped to visible .claude/workflows directories. */
  scriptPath?: string
  args?: unknown
  /** Agent Code run_* or scoped Claude wf_* resume alias; creates a new durable linked run. */
  resumeFromRunId?: string
  idempotencyKey?: string
}

export type WorkflowResumeInput =
  | {
      runId: string
      idempotencyKey?: string
      /**
       * Operator acknowledgement that an unconfirmed provider descendant may still be alive.
       * Accepted only for a read-only, offline sandbox; mutable runs retain the hard fence.
       */
      abandonUnconfirmedProvider?: boolean
    }
  | { claudeRunPath: string; workflowPath?: string; idempotencyKey?: string }

type ReadInput = {
  runId: string
  after?: number
  limit?: number
  waitMs?: number
}

export type WorkflowResultReadInput = {
  runId: string
  artifactId: string
  cursor?: string
  maxBytes?: number
}

export type WorkflowAgentResultReadServiceInput = {
  runId: string
  agentId: string
  artifactId?: string
  cursor?: string
  maxBytes?: number
}

/** One page per agent per bulk call, so a response is bounded by agents, not by total output. */
const AGENT_RESULTS_PAGE_ITEMS = 20
const DEFAULT_AGENT_TRANSCRIPT_EVENTS = 200
const MAX_AGENT_TRANSCRIPT_EVENTS = 1_000
/** Raw events scanned per filtered batch; most events in a fan-out belong to other agents. */
const TRANSCRIPT_SCAN_BATCH = 500
/**
 * Batches scanned per call. Bounds WORK, not output: without it, an agent with three events in a
 * long run scanned from `after` to the end of the stream every call, which a read-only client could
 * repeat at will against a 512 MiB event log.
 */
const MAX_TRANSCRIPT_SCAN_BATCHES = 20

/**
 * Split `v1.<agentId>.<innerCursor>`.
 *
 * The inner cursor keeps its own `v1.<sha256>.<offset>` shape untouched, so the single-artifact
 * staleness fence still applies inside a bulk walk. A trailing empty inner cursor means "start this
 * agent from the beginning", which is how the walk advances past a fully-read agent.
 */
function parseAgentResultsCursor(
  cursor: string | undefined,
): { agentId: string; cursor?: string } | undefined {
  if (cursor === undefined) return undefined
  const match = /^v1\.(agent_[0-9]+)\.(.*)$/.exec(cursor)
  if (match === null) {
    throw new WorkflowServiceError('invalid-cursor', 'Bulk agent result cursor is malformed')
  }
  const inner = match[2]!
  return { agentId: match[1]!, ...(inner.length === 0 ? {} : { cursor: inner }) }
}

export type WorkflowServiceListener = (event: StoredWorkflowEvent) => void

export type WorkflowServiceLifecycleState =
  | 'NEW'
  | 'INITIALIZING'
  | 'READY'
  | 'QUIESCING'
  | 'STOPPED'
  | 'FAILED'

/**
 * Long-lived owner for workflow discovery, execution, persistence, and recovery.
 *
 * WHY this is not an MCP-session object: the client which starts a workflow may disconnect or be
 * replaced while its agents continue. One app-owned service gives each run one writer, keeps
 * cancellation reachable, and lets a later renderer or provider recover solely from durable state.
 */
export class WorkflowService {
  readonly #options: WorkflowServiceOptions
  readonly #scheduler: AgentScheduler
  readonly #reliability: WorkflowReliabilityPolicy
  readonly #circuitBreakers = new Map<string, ProviderCircuitBreaker>()
  readonly #runCircuitKeys = new Map<string, string>()
  readonly #recovery: WorkflowRecoveryPolicy
  readonly #active = new Map<string, WorkflowRun>()
  readonly #ownedRuns = new Map<string, WorkflowRun>()
  readonly #listeners = new Set<WorkflowServiceListener>()
  readonly #waiters = new Map<string, Set<() => void>>()
  readonly #runVersions = new Map<string, number>()
  readonly #idempotentStarts = new Map<string, Promise<WorkflowRunStartResult>>()
  #storeLease: WorkflowStoreLease | undefined
  #storeLeaseRelease: Promise<void> | undefined
  #initializePromise: Promise<void> | undefined
  #stopPromise: Promise<void> | undefined
  #closingMode: 'cancellation' | 'interruption' | undefined
  #lifecycle: WorkflowServiceLifecycleState = 'NEW'
  #admittedMutations = 0
  readonly #admissionDrainWaiters = new Set<() => void>()

  constructor(options: WorkflowServiceOptions) {
    this.#options = options
    this.#scheduler = options.scheduler ?? new WorkConservingScheduler(options.limits?.concurrency ?? 9)
    this.#reliability = normalizeReliabilityPolicy(options.reliability)
    this.#recovery = { ...DEFAULT_RECOVERY_POLICY, ...options.recovery }
  }

  async initialize(): Promise<void> {
    if (this.#lifecycle === 'READY') return
    if (this.#lifecycle === 'QUIESCING') {
      throw new WorkflowServiceError('service-stopping', 'Workflow service is stopping')
    }
    if (this.#lifecycle === 'STOPPED') {
      throw new WorkflowServiceError('service-stopped', 'Workflow service is stopped')
    }
    if (this.#lifecycle === 'FAILED') {
      throw new WorkflowServiceError('invalid-request', 'Workflow service initialization failed')
    }
    if (this.#initializePromise) return this.#initializePromise
    this.#lifecycle = 'INITIALIZING'
    const initialization = this.#initializeOnce()
    this.#initializePromise = initialization
    try {
      await initialization
      // A concurrent quiesce owns the state transition once it has closed admission. Initialization
      // may finish cleaning up after that point, but it must never reopen a daemon that is stopping.
      if (this.#lifecycle === 'INITIALIZING') this.#lifecycle = 'READY'
    } catch (error) {
      if (this.#lifecycle === 'INITIALIZING') this.#lifecycle = 'FAILED'
      throw error
    } finally {
      if (this.#initializePromise === initialization) this.#initializePromise = undefined
    }
  }

  async #initializeOnce(): Promise<void> {
    let acquiredLease: WorkflowStoreLease | undefined
    try {
      // Acquire before recovery scans: FileWorkflowStore.initialize() can repair an event tail and
      // rewrite a manifest. Two hosts must not both perform that mutation before either announces
      // ownership. Stores without a lease API retain their historical initialize-first behavior.
      acquiredLease = this.#storeLease ?? await this.#options.store.acquireLease?.(
        `workflow-service:${randomUUID()}`,
      )
      this.#storeLease = acquiredLease
      if (this.#isClosing()) {
        await this.#releaseStoreLease()
        throw this.#initializationClosingError()
      }
      await this.#options.store.initialize()
      // stop() may arrive while an asynchronous store repair is in flight. It deliberately waits
      // for this initialization owner rather than stealing the lease, so this owner must notice the
      // stop before advertising availability or creating recovery successors.
      if (this.#isClosing()) {
        throw this.#initializationClosingError()
      }
      const manifests = await this.#options.store.listManifests()
      // The manifest scan can itself be a long filesystem operation on a FAT history. Recheck at
      // each awaited boundary: otherwise a stop which lands during the scan can return only after
      // initialization has unexpectedly launched every automatic-recovery run.
      if (this.#isClosing()) {
        throw this.#initializationClosingError()
      }
      const continuedRuns = new Set(
        manifests.flatMap((manifest) => (
          manifest.resumedFromRunId === undefined ? [] : [manifest.resumedFromRunId]
        )),
      )
      const recoverable: WorkflowRunManifest[] = []
      for (const manifest of manifests) {
        const needsReplayDecision =
          manifest.status === 'running' ||
          (manifest.status === 'interrupted' && !continuedRuns.has(manifest.runId))
        const automaticRecoveryIsSafe = needsReplayDecision
          ? await this.#automaticRecoveryIsSafe(manifest)
          : false
        if (TERMINAL_STATUSES.has(manifest.status)) {
          // WHY interrupted runs are reconsidered: the previous host may have durably written the
          // terminal marker and died before creating its successor manifest. A successor is the
          // recovery commit record; without one, skipping every terminal run strands the lineage.
          if (
            manifest.status === 'interrupted' &&
            !continuedRuns.has(manifest.runId) &&
            (
              automaticRecoveryIsSafe ||
              // A lone run.interrupted event is the recovery record for a cursor-zero queued run.
              // No evaluator or provider was ever admitted, so continuing it cannot repeat a tool
              // side effect even when the provider correctly refuses general automatic replay.
              // The operator's explicit initialization opt-out still wins over that safety fact.
              (this.#recovery.autoResumeOnInitialize && manifest.cursor === 1)
            )
          ) recoverable.push(manifest)
          continue
        }
        const shouldRecover =
          this.#recovery.autoResumeOnInitialize &&
          (
            (manifest.status === 'running' && automaticRecoveryIsSafe) ||
            // WHY cursor zero makes this queued state unambiguous: createRun durably reserves the
            // identity before runWorkflow can emit run.started. A process death in that narrow
            // window performed no workflow call, so provider replay safety is irrelevant.
            (manifest.status === 'queued' && manifest.cursor === 0)
          )
        const timestamp = new Date().toISOString()
        const event: WorkflowEvent = {
          schemaVersion: 1,
          runId: manifest.runId,
          sequence: manifest.cursor + 1,
          eventId: `event_${randomUUID()}`,
          timestamp,
          type: 'run.interrupted',
          payload: {
            reason: 'Workflow host stopped before this run reached a durable terminal event',
          },
        }
        const stored = await this.#options.store.appendEvent(manifest.runId, event)
        this.#publish(stored)
        if (shouldRecover) recoverable.push({ ...manifest, status: 'interrupted' })
      }

      for (const manifest of recoverable) {
        try {
          // WHY recovery creates a linked run instead of mutating the interrupted history: the old
          // event stream is immutable evidence of where the process died. Reusing its run ID would
          // allow two physical executions to publish the same sequence and make crash forensics
          // indistinguishable from duplicate provider events.
          await this.#resumeStored(
            {
              cwd: manifest.cwd,
              ...(manifest.clientId === undefined ? {} : { clientId: manifest.clientId }),
            },
            {
              runId: manifest.runId,
              idempotencyKey: `automatic-recovery:${manifest.runId}`,
            },
            undefined,
            'automatic',
          )
        } catch (error) {
          // Initialization must still expose the interrupted run when recovery cannot be constructed
          // (for example a corrupt journal). A cleanly logged manual recovery requirement is better
          // than making the entire MCP service unavailable for every unrelated project run.
          console.error(`[workflow-mcp] Automatic recovery failed for ${manifest.runId}:`, error)
        }
      }
    } catch (error) {
      // WHY partial initialization relinquishes ownership: keeping #initialized true or retaining
      // the lock after a store scan failure creates a service that refuses requests yet blocks the
      // next healthy process from recovering. Recovery is retriable only from a clean ownership
      // boundary.
      // Only the initializer which acquired this generation may release it. A concurrent caller
      // awaits the same promise, so it cannot tear down a lease another successful initializer won.
      if (this.#storeLease === acquiredLease) {
        try {
          await acquiredLease?.release()
          this.#storeLease = undefined
        } catch (releaseError) {
          // Preserve the lease object so stop() or a later initialize() can retry its token-owned
          // release. Clearing it here would strand a live lock until process exit.
          throw new AggregateError(
            [error, releaseError],
            'Workflow initialization failed and store ownership could not be released',
          )
        }
      }
      throw error
    }
  }

  async stop(reason = 'Workflow service is stopping'): Promise<void> {
    return this.#beginStop(reason, 'cancellation')
  }

  /**
   * Stop the host without claiming that an operator cancelled its workflows.
   *
   * This is additive because Agent Code historically uses stop() as an explicit cancellation
   * boundary. Container replacement has different semantics: the durable history must say that
   * the owner disappeared and leave replay-safe work eligible for recovery.
   */
  async quiesce(reason = 'Workflow service host is stopping'): Promise<void> {
    return this.#beginStop(reason, 'interruption')
  }

  lifecycleState(): WorkflowServiceLifecycleState {
    return this.#lifecycle
  }

  #beginStop(reason: string, mode: 'cancellation' | 'interruption'): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise
    if (this.#lifecycle === 'STOPPED') return Promise.resolve()

    // This assignment and mutation admission happen synchronously on one JavaScript turn. Closing
    // the gate before the first await is what prevents an async source lookup from registering a
    // provider after shutdown has already taken its active-run snapshot.
    this.#lifecycle = 'QUIESCING'
    this.#closingMode = mode
    for (const waiters of this.#waiters.values()) for (const wake of waiters) wake()
    this.#waiters.clear()

    const stopping = this.#stopOnce(reason, mode)
    this.#stopPromise = stopping
    void stopping.then(
      () => { this.#lifecycle = 'STOPPED' },
      () => { this.#lifecycle = 'FAILED' },
    ).finally(() => {
      // FileWorkflowStore.release() deliberately remains retryable after transient I/O failure.
      // Do not memoize a rejected service stop forever or callers can never exercise that retry.
      if (this.#stopPromise === stopping) this.#stopPromise = undefined
    })
    return stopping
  }

  async #stopOnce(reason: string, mode: 'cancellation' | 'interruption'): Promise<void> {
    // Initialization owns the lease transition and recovery scan. Cancelling/releasing in the
    // middle would let a second host enter while the first still mutates manifests. Once the shared
    // initialization promise settles, this stop owns a clean, deterministic teardown boundary.
    await this.#initializePromise?.catch(() => undefined)
    // An admitted start may be between its first filesystem lookup and registration in #active.
    // Waiting for the admission transaction is the only point at which the run snapshot is closed.
    await this.#waitForAdmissionDrain()
    let ownershipCanTransfer = true
    try {
      const runs = [...this.#active.values()]
      await Promise.allSettled(runs.map((run) => (
        mode === 'interruption' ? run.interrupt(reason) : run.cancel(reason)
      )))
      this.#active.clear()
      ownershipCanTransfer = [...this.#ownedRuns.values()]
        .every((run) => run.ownershipReleaseSafe?.() !== false)
    } finally {
      // WHY an unconfirmed adapter keeps the store lease even after its logical run failed: the
      // old execution may still be mutating its workspace and can wake later with callbacks into
      // this store. Releasing ownership would let a replacement service resume the same lineage
      // concurrently. The OS removes this process-bound fence on process exit; before then, a
      // cooperative adapter which eventually settles makes a later stop/resume safe again.
      if (ownershipCanTransfer) {
        await this.#releaseStoreLease()
      }
    }
    if (!ownershipCanTransfer) {
      throw new WorkflowServiceError(
        'unsafe-provider-active',
        'Workflow service retained store ownership because a provider attempt did not confirm termination',
      )
    }
  }

  async list(scope: WorkflowServiceScope) {
    this.#assertAvailable()
    return findWorkflows({ cwd: resolve(scope.cwd) })
  }

  /**
   * App-host recovery inventory. This is intentionally not registered as an MCP tool: an embedding
   * main process needs to rebuild UI/session ownership after restart, while project-scoped clients
   * must continue using status with an explicit cwd capability.
   */
  async listStoredRunReferences(): Promise<readonly WorkflowStoredRunReference[]> {
    this.#assertAvailable()
    return (await this.#options.store.listManifests()).map((manifest) => ({
      cwd: manifest.cwd,
      ...(manifest.clientId === undefined ? {} : { clientId: manifest.clientId }),
      ...startResult(manifest, this.#options.store),
    }))
  }

  /** Path-redacted, bounded inventory used by standalone control surfaces. */
  async listRuns(input: WorkflowRunListInput = {}): Promise<WorkflowRunListPage> {
    this.#assertAvailable()
    if (this.#options.store.listRuns === undefined) {
      throw new WorkflowServiceError(
        'invalid-request',
        'This workflow store does not support bounded run inventory',
      )
    }
    return this.#options.store.listRuns(input)
  }

  /** Synchronous process lease used by hosts which must not replace a provider executable mid-run. */
  hasActiveRuns(): boolean {
    return this.#active.size > 0 || this.#ownedRuns.size > 0
  }

  /**
   * Serialize app-owned control-plane persistence with starts/cancels and the store lease. The
   * callback itself remains application code, but it cannot begin after quiesce or finish after
   * ownership transfer; a store without this explicit fence fails closed.
   */
  async runAdministrativeMutation<T>(mutation: () => Promise<T>): Promise<T> {
    return this.#withMutationAdmission(async () => {
      if (this.#options.store.runOwnedMutation === undefined) {
        throw new WorkflowServiceError(
          'invalid-request',
          'This workflow store does not support fenced administrative mutations',
        )
      }
      return this.#options.store.runOwnedMutation(mutation)
    })
  }

  async describe(scope: WorkflowServiceScope, input: { name: string }): Promise<FoundWorkflow> {
    this.#assertAvailable()
    return this.#resolveVisibleWorkflow(scope, input.name)
  }

  async validate(scope: WorkflowServiceScope, input: { name: string }): Promise<{
    valid: true
    workflow: FoundWorkflow
  }> {
    return { valid: true, workflow: await this.describe(scope, input) }
  }

  async start(scope: WorkflowServiceScope, input: WorkflowStartInput): Promise<WorkflowRunStartResult> {
    return this.#withMutationAdmission(async () => {
      validateIdempotencyKey(input.idempotencyKey)
      return this.#serializeIdempotentStart(
        scope,
        input.idempotencyKey,
        () => this.#startOnce(scope, input),
      )
    })
  }

  async #startOnce(scope: WorkflowServiceScope, input: WorkflowStartInput): Promise<WorkflowRunStartResult> {
    const existing = input.idempotencyKey === undefined
      ? undefined
      : await this.#options.store.findByIdempotencyKey(resolve(scope.cwd), input.idempotencyKey)
    if (existing) {
      this.#assertScope(scope, existing)
      return startResult(existing, this.#options.store)
    }

    if (input.resumeFromRunId !== undefined) {
      return this.#resumeRunId(scope, {
        runId: input.resumeFromRunId,
        ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
      }, input)
    }

    const workflow = await this.#resolveStartWorkflow(scope, input)
    return this.#startLoaded(scope, workflow, {
      ...(Object.prototype.hasOwnProperty.call(input, 'args') ? { args: input.args } : {}),
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
    })
  }

  async status(scope: WorkflowServiceScope, runId: string): Promise<WorkflowRunManifest> {
    this.#assertAvailable()
    const manifest = await this.#requiredManifest(runId)
    this.#assertScope(scope, manifest)
    return manifest
  }

  async health(scope: WorkflowServiceScope, runId: string): Promise<WorkflowRunHealth> {
    const snapshot = await this.snapshot(scope, runId)
    return this.#healthFromSnapshot(snapshot)
  }

  /** A single replay drives both halves of the MCP status response. */
  async inspect(
    scope: WorkflowServiceScope,
    runId: string,
  ): Promise<{ run: WorkflowRunManifest; health: WorkflowRunHealth }> {
    const snapshot = await this.snapshot(scope, runId)
    return { run: snapshot.manifest, health: await this.#healthFromSnapshot(snapshot) }
  }

  async #healthFromSnapshot(snapshot: WorkflowRunSnapshot): Promise<WorkflowRunHealth> {
    const runId = snapshot.manifest.runId
    const successor = this.#options.store.findLatestSuccessor === undefined
      ? (await this.#options.store.listManifests())
          .filter((manifest) => manifest.resumedFromRunId === runId)
          .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
          .at(-1)
      : await this.#options.store.findLatestSuccessor(runId)
    const attempts = snapshot.state.agents.flatMap((agent) => agent.attempts)
    const progressTimes = attempts
      .map((attempt) => attempt.lastProgressAt)
      .filter((value): value is string => value !== undefined)
    const runningStarts = attempts
      .filter((attempt) => attempt.status === 'running' || attempt.status === 'stalled')
      .map((attempt) => attempt.startedAt)
    const lastProgressAt = progressTimes.sort().at(-1)
    const oldestRunningSince = runningStarts.sort()[0]
    return {
      runId,
      status: snapshot.manifest.status,
      cursor: snapshot.cursor,
      scheduler: this.#scheduler.snapshot(),
      providerCircuit: this.#circuitBreakers.get(this.#runCircuitKeys.get(runId) ?? '')?.snapshot() ?? {
        state: 'closed',
        recentFailures: 0,
      },
      agents: {
        total: snapshot.state.counts.total,
        queued: snapshot.state.counts.queued,
        running: snapshot.state.counts.running,
        stalled: attempts.filter((attempt) => attempt.status === 'stalled').length,
        retrying: snapshot.state.agents.filter((agent) => agent.retry !== undefined && agent.status === 'queued').length,
        completed: snapshot.state.counts.completed,
        failed: snapshot.state.counts.failed,
        recoveryRequired: snapshot.state.counts.recovery_required,
      },
      ...(lastProgressAt === undefined ? {} : { lastProgressAt }),
      ...(oldestRunningSince === undefined ? {} : { oldestRunningSince }),
      lineageId: snapshot.manifest.lineageId ?? snapshot.manifest.runId,
      ...(snapshot.manifest.recoveryMode === undefined
        ? {}
        : { recoveryMode: snapshot.manifest.recoveryMode }),
      ...(successor === undefined ? {} : { successorRunId: successor.runId }),
    }
  }

  async snapshot(scope: WorkflowServiceScope, runId: string): Promise<WorkflowRunSnapshot> {
    const manifest = await this.status(scope, runId)
    const snapshot = await this.#options.store.snapshot(runId)
    // Scope is checked against the manifest read immediately before replay. The store has one
    // writer and cwd is immutable, so replay cannot cross into another project between awaits.
    this.#assertScope(scope, manifest)
    return snapshot
  }

  async readEvents(scope: WorkflowServiceScope, input: ReadInput): Promise<WorkflowEventPage> {
    const after = boundedInteger(input.after ?? 0, 'after', 0, Number.MAX_SAFE_INTEGER)
    const limit = boundedInteger(input.limit ?? 200, 'limit', 1, MAX_EVENTS_PER_PAGE)
    const waitMs = boundedInteger(input.waitMs ?? 0, 'waitMs', 0, MAX_WAIT_MS)
    let manifest = await this.status(scope, input.runId)
    const observedVersion = this.#runVersions.get(input.runId) ?? 0
    let page = await this.#readEventPage(input.runId, after, limit)
    if (page.events.length > 0 || waitMs === 0 || TERMINAL_STATUSES.has(manifest.status)) return page

    await this.#waitForEvent(input.runId, waitMs, observedVersion)
    manifest = await this.status(scope, input.runId)
    page = await this.#readEventPage(input.runId, after, limit)
    return page
  }

  async #readEventPage(runId: string, after: number, limit: number): Promise<WorkflowEventPage> {
    try {
      return await this.#options.store.readEvents(runId, after, limit)
    } catch (cause) {
      if (hasErrorCode(cause, 'cursor-ahead')) {
        throw new WorkflowServiceError(
          'cursor-ahead',
          `Workflow event cursor ${after} is ahead of the durable stream for ${runId}`,
          { cause },
        )
      }
      throw cause
    }
  }

  async readResult(
    scope: WorkflowServiceScope,
    input: WorkflowResultReadInput,
  ): Promise<WorkflowResultPage> {
    const maxBytes = boundedInteger(
      input.maxBytes ?? DEFAULT_WORKFLOW_RESULT_PAGE_BYTES,
      'maxBytes',
      MIN_WORKFLOW_RESULT_PAGE_BYTES,
      MAX_WORKFLOW_RESULT_PAGE_BYTES,
    )
    if (input.artifactId.length === 0 || input.artifactId.length > 200) {
      throw new WorkflowServiceError(
        'invalid-request',
        'artifactId must contain 1 to 200 characters',
      )
    }
    if (input.cursor !== undefined && (input.cursor.length === 0 || input.cursor.length > 200)) {
      throw new WorkflowServiceError('invalid-cursor', 'Workflow result cursor is malformed')
    }
    const manifest = await this.status(scope, input.runId)
    if (manifest.status !== 'completed' && manifest.status !== 'completed_with_errors') {
      if (!TERMINAL_STATUSES.has(manifest.status)) {
        throw new WorkflowServiceError(
          'result-not-ready',
          `Workflow run ${input.runId} has not completed`,
        )
      }
      throw new WorkflowServiceError(
        'result-unavailable',
        `Workflow run ${input.runId} ended with ${manifest.status} and has no result`,
      )
    }
    const reference = manifest.result
    if (reference?.artifactId === undefined) {
      // Runs created before durable result artifacts may still carry a complete small inline value.
      // Do not pretend that value is a paginated artifact: old truncated completions cannot be
      // distinguished safely from complete ones after renderer compaction, and manufacturing a
      // locator would give callers false restart/retention guarantees.
      throw new WorkflowServiceError(
        'result-unavailable',
        `Workflow run ${input.runId} has no durable result artifact`,
      )
    }
    if (input.artifactId !== reference.artifactId) {
      throw new WorkflowServiceError(
        'result-not-found',
        `Workflow result artifact does not exist for ${input.runId}`,
      )
    }
    try {
      return await this.#options.store.readResult(input.runId, {
        artifactId: input.artifactId,
        maxBytes,
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      })
    } catch (cause) {
      if (hasErrorCode(cause, 'invalid-cursor')) {
        throw new WorkflowServiceError(
          'invalid-cursor',
          `Workflow result cursor is malformed or stale for ${input.runId}`,
          { cause },
        )
      }
      if (hasErrorCode(cause, 'result-not-found')) {
        throw new WorkflowServiceError(
          'result-expired',
          `Workflow result artifact is missing or expired for ${input.runId}`,
          { cause },
        )
      }
      throw cause
    }
  }

  /**
   * List the run's LOGICAL agents with attempt history and a result locator each.
   *
   * No terminal-run gate, unlike readResult. Inspecting a fan-out while it is still moving is the
   * whole point, so the response echoes the run's status and cursor and the caller polls.
   */
  async listAgents(
    scope: WorkflowServiceScope,
    input: { runId: string },
  ): Promise<WorkflowAgentListPage> {
    const snapshot = await this.snapshot(scope, input.runId)
    const phaseTitles = new Map(snapshot.state.phases.map(phase => [phase.id, phase.title]))
    const store = this.#options.store
    const locators = store.agentResultLocators === undefined
      ? new Map()
      : await store.agentResultLocators(
        input.runId,
        snapshot.state.agents.map(agent => ({ agentId: agent.id, cacheKey: agent.cacheKey })),
      )
    const agents: WorkflowAgentListEntry[] = snapshot.state.agents.map(agent => {
      const located = locators.get(agent.id)
      const phaseTitle = agent.phaseId === undefined ? undefined : phaseTitles.get(agent.phaseId)
      return {
        agentId: agent.id,
        callIndex: agent.callIndex,
        label: agent.label,
        ...(agent.phaseId === undefined ? {} : { phaseId: agent.phaseId }),
        ...(phaseTitle === undefined ? {} : { phaseTitle }),
        status: agent.status,
        reused: agent.outcome?.source === 'journal',
        coverageGap: located?.coverageGap ?? false,
        attempts: agent.attempts.map(attempt => ({
          attemptId: attempt.id,
          attemptNumber: attempt.number,
          status: attempt.status,
          ...(attempt.startedAt === undefined ? {} : { startedAt: attempt.startedAt }),
          ...(attempt.completedAt === undefined ? {} : { completedAt: attempt.completedAt }),
        })),
        result: located === undefined
          ? { available: false, source: 'none' as const }
          : {
            available: true,
            source: located.source,
            ...(located.metadata === undefined ? {} : {
              artifactId: located.metadata.artifactId,
              mediaType: located.metadata.mediaType,
              sizeBytes: located.metadata.sizeBytes,
              lineCount: located.metadata.lineCount,
              checksum: located.metadata.checksum,
            }),
          },
      }
    })
    return {
      runId: input.runId,
      runStatus: snapshot.manifest.status,
      cursor: snapshot.cursor,
      agents,
    }
  }

  async readAgentResult(
    scope: WorkflowServiceScope,
    input: WorkflowAgentResultReadServiceInput,
  ): Promise<WorkflowAgentResultPage> {
    const maxBytes = boundedInteger(
      input.maxBytes ?? DEFAULT_WORKFLOW_RESULT_PAGE_BYTES,
      'maxBytes',
      MIN_WORKFLOW_RESULT_PAGE_BYTES,
      MAX_WORKFLOW_RESULT_PAGE_BYTES,
    )
    if (input.cursor !== undefined && (input.cursor.length === 0 || input.cursor.length > 200)) {
      throw new WorkflowServiceError('invalid-cursor', 'Agent result cursor is malformed')
    }
    // snapshot() carries the scope assertion; it also gives the cacheKey, which is the stable join
    // column into the journal across a recovery lineage.
    const snapshot = await this.snapshot(scope, input.runId)
    const agent = snapshot.state.agents.find(candidate => candidate.id === input.agentId)
    if (agent === undefined) {
      throw new WorkflowServiceError(
        'agent-not-found',
        `Workflow run ${input.runId} has no agent ${input.agentId}`,
      )
    }
    const store = this.#options.store
    if (store.readAgentResult === undefined) {
      throw new WorkflowServiceError(
        'result-unavailable',
        'This workflow store cannot read per-agent results',
      )
    }
    try {
      return await store.readAgentResult(input.runId, input.agentId, {
        maxBytes,
        cacheKey: agent.cacheKey,
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        ...(input.artifactId === undefined ? {} : { artifactId: input.artifactId }),
      })
    } catch (cause) {
      if (hasErrorCode(cause, 'invalid-cursor')) {
        throw new WorkflowServiceError(
          'invalid-cursor',
          `Agent result cursor is malformed or stale for ${input.runId}/${input.agentId}`,
          { cause },
        )
      }
      if (hasErrorCode(cause, 'agent-not-found')) {
        throw new WorkflowServiceError(
          'agent-not-found',
          `Workflow run ${input.runId} has no agent ${input.agentId}`,
          { cause },
        )
      }
      if (hasErrorCode(cause, 'result-not-found')) {
        throw new WorkflowServiceError(
          'result-unavailable',
          `Workflow agent ${input.agentId} has no result recorded in ${input.runId}`,
          { cause },
        )
      }
      if (hasErrorCode(cause, 'corrupt-store')) {
        // Damage, not absence. Previously this escaped as a raw WorkflowStoreError, unlike every
        // other error from this path.
        throw new WorkflowServiceError(
          'result-unavailable',
          `Workflow agent ${input.agentId} result is unreadable in ${input.runId}: storage is damaged`,
          { cause },
        )
      }
      throw cause
    }
  }

  /**
   * Page every agent's result in one walk, ordered by callIndex.
   *
   * The composite cursor is `v1.<agentId>.<inner>` where `<inner>` is an ordinary single-artifact
   * cursor. A page stops at the first agent that still has more bytes, so a caller following
   * nextCursor sees each agent's content contiguously rather than interleaved.
   */
  async readAgentResults(
    scope: WorkflowServiceScope,
    input: { runId: string; phase?: string; cursor?: string; maxBytes?: number },
  ): Promise<WorkflowAgentResultsPage> {
    const maxBytes = boundedInteger(
      input.maxBytes ?? DEFAULT_WORKFLOW_RESULT_PAGE_BYTES,
      'maxBytes',
      MIN_WORKFLOW_RESULT_PAGE_BYTES,
      MAX_WORKFLOW_RESULT_PAGE_BYTES,
    )
    const listing = await this.listAgents(scope, { runId: input.runId })
    const readable = listing.agents
      .filter(agent => agent.result.available)
      .filter(agent => input.phase === undefined ||
        agent.phaseId === input.phase ||
        agent.phaseTitle === input.phase)
      .sort((left, right) => left.callIndex - right.callIndex)

    const parsed = parseAgentResultsCursor(input.cursor)
    let startIndex = 0
    if (parsed !== undefined) {
      startIndex = readable.findIndex(agent => agent.agentId === parsed.agentId)
      if (startIndex < 0) {
        throw new WorkflowServiceError(
          'invalid-cursor',
          `Bulk agent cursor names an agent that is not readable in ${input.runId}`,
        )
      }
    }

    const items: WorkflowAgentResultPage[] = []
    const skipped: { agentId: string; reason: string }[] = []
    for (let index = startIndex; index < readable.length; index += 1) {
      const agent = readable[index]!
      const inner = index === startIndex ? parsed?.cursor : undefined
      let page: WorkflowAgentResultPage
      try {
        page = await this.readAgentResult(scope, {
          runId: input.runId,
          agentId: agent.agentId,
          maxBytes,
          ...(inner === undefined ? {} : { cursor: inner }),
        })
      } catch (cause) {
        // One damaged agent must not make the whole run uninspectable. Aborting stranded the
        // caller: the composite cursor names an agent, so stepping past a poisoned one meant
        // hand-forging `v1.<next_agent>.` — a shape no tool description documents. This tool's job
        // is post-mortem inspection of runs that may well have had storage trouble, so a partial
        // answer that names what it could not read beats an error for everything.
        skipped.push({
          agentId: agent.agentId,
          reason: cause instanceof Error ? cause.message : String(cause),
        })
        continue
      }
      items.push(page)
      if (page.hasMore) {
        return {
          runId: input.runId,
          items,
          hasMore: true,
          nextCursor: `v1.${agent.agentId}.${page.nextCursor!}`,
          ...(skipped.length === 0 ? {} : { skipped }),
        }
      }
      // One page per agent per call keeps the response bounded by maxBytes × agents rather than by
      // the run's total output, which is unbounded.
      if (items.length >= AGENT_RESULTS_PAGE_ITEMS) {
        const next = readable[index + 1]
        return {
          runId: input.runId,
          items,
          hasMore: next !== undefined,
          ...(next === undefined ? {} : { nextCursor: `v1.${next.agentId}.` }),
          ...(skipped.length === 0 ? {} : { skipped }),
        }
      }
    }
    return {
      runId: input.runId,
      items,
      hasMore: false,
      ...(skipped.length === 0 ? {} : { skipped }),
    }
  }

  /**
   * Page a single agent's slice of the canonical event stream.
   *
   * Reads events.jsonl filtered by agentId rather than transcripts/agent-<id>.jsonl. That mirror is
   * appended best-effort after the canonical write, is never fsynced, and its own comment calls it
   * "a discoverability aid, never a second source of truth" — it has no checksum to fence a cursor
   * against and can silently be short.
   */
  async readAgentTranscript(
    scope: WorkflowServiceScope,
    input: { runId: string; agentId: string; after?: number; limit?: number },
  ): Promise<WorkflowAgentTranscriptPage> {
    const after = input.after === undefined ? 0 : boundedInteger(input.after, 'after', 0, Number.MAX_SAFE_INTEGER)
    const limit = boundedInteger(input.limit ?? DEFAULT_AGENT_TRANSCRIPT_EVENTS, 'limit', 1, MAX_AGENT_TRANSCRIPT_EVENTS)
    const snapshot = await this.snapshot(scope, input.runId)
    if (!snapshot.state.agents.some(candidate => candidate.id === input.agentId)) {
      throw new WorkflowServiceError(
        'agent-not-found',
        `Workflow run ${input.runId} has no agent ${input.agentId}`,
      )
    }
    const events: StoredWorkflowEvent[] = []
    // Three positions, deliberately not one. `scanCursor` is how far the raw stream has been read;
    // `lastReturned` is the last event actually handed to the caller. They diverge because most
    // events in a fan-out belong to other agents, and conflating them loses data in one direction
    // or spins in the other:
    //   - reporting the last MATCH re-scans the same rejected span on every poll (the original bug)
    //   - reporting the SCAN position when the budget filled mid-batch skips the matching events in
    //     the rest of that batch, silently, while hasMore still says true (the fix's own bug)
    // So: if the budget filled, resume from the last returned event; otherwise the batch was fully
    // consumed and the scan position is safe.
    let scanCursor = after
    let lastReturned = after
    let budgetFilled = false
    let streamExhausted = false
    let batches = 0
    while (events.length < limit && batches < MAX_TRANSCRIPT_SCAN_BATCHES) {
      const page = await this.#options.store.readEvents(input.runId, scanCursor, TRANSCRIPT_SCAN_BATCH)
      batches += 1
      if (page.events.length === 0) {
        streamExhausted = true
        break
      }
      for (const stored of page.events) {
        const event = stored.event as { agentId?: unknown }
        if (event.agentId !== input.agentId) continue
        if (events.length >= limit) {
          budgetFilled = true
          break
        }
        events.push(stored)
        lastReturned = stored.cursor
      }
      if (budgetFilled) break
      // Only advance once the whole batch has been consumed, so a mid-batch stop cannot strand the
      // events behind it.
      scanCursor = page.toCursor
      if (!page.hasMore) {
        streamExhausted = true
        break
      }
    }
    return {
      runId: input.runId,
      agentId: input.agentId,
      fromCursor: after,
      toCursor: budgetFilled ? lastReturned : scanCursor,
      events,
      // A batch budget stop is also "more available". `limit` bounds the RESPONSE; the batch cap
      // bounds the WORK, so a sparse agent in a million-event run returns promptly with a cursor
      // instead of scanning to the end of the stream on every call.
      hasMore: budgetFilled || !streamExhausted,
    }
  }

  async cancel(
    scope: WorkflowServiceScope,
    runId: string,
    reason = 'Cancelled by workflow client',
  ): Promise<WorkflowRunManifest> {
    return this.#withMutationAdmission(async () => {
      const manifest = await this.#requiredScopedManifest(scope, runId)
      if (TERMINAL_STATUSES.has(manifest.status)) return manifest
      const active = this.#active.get(runId)
      if (!active) {
        // A non-terminal manifest without an active owner can only exist between startup and recovery
        // or after an invariant failure. Refusing to fabricate cancellation preserves the distinction
        // that run.interrupted exists to communicate.
        throw new WorkflowServiceError('invalid-request', `Workflow run is not active: ${runId}`)
      }
      await active.cancel(reason)
      // Quiesce may close admission while this already-admitted cancellation waits for its durable
      // event. Calling public status() here would turn successful cancellation into a misleading
      // service-stopping error, so finish the same admission transaction with an internal read.
      return this.#requiredScopedManifest(scope, runId)
    })
  }

  async resume(scope: WorkflowServiceScope, input: WorkflowResumeInput): Promise<WorkflowRunStartResult> {
    return this.#withMutationAdmission(async () => {
      validateIdempotencyKey(input.idempotencyKey)
      return this.#serializeIdempotentStart(scope, input.idempotencyKey, () => (
        'claudeRunPath' in input ? this.#resumeClaude(scope, input) : this.#resumeRunId(scope, input)
      ))
    })
  }

  async #resumeRunId(
    scope: WorkflowServiceScope,
    input: Extract<WorkflowResumeInput, { runId: string }>,
    overrides?: WorkflowStartInput,
  ): Promise<WorkflowRunStartResult> {
    if (!input.runId.startsWith('wf_')) return this.#resumeStored(scope, input, overrides)

    const cwd = resolve(scope.cwd)
    const projectRoot = await this.#claudeProjectRoot(cwd)
    let metadataPath: string
    try {
      metadataPath = await findClaudeWorkflowRunMetadata(projectRoot, input.runId)
    } catch (cause) {
      if (!(cause instanceof ClaudeResumeError)) throw cause
      throw new WorkflowServiceError(
        cause.code === 'run-not-found' ? 'run-not-found' : 'invalid-request',
        cause.message,
        { cause },
      )
    }

    let workflowPath: string | undefined
    const hasSourceOverride = overrides?.scriptPath !== undefined ||
      overrides?.script !== undefined ||
      overrides?.name !== undefined
    if (hasSourceOverride) {
      const workflow = await this.#resolveStartWorkflow(scope, overrides ?? {})
      if (workflow.filePath === undefined) {
        throw new WorkflowServiceError(
          'invalid-request',
          'Claude workflow resume source override must resolve to a persisted workflow file',
        )
      }
      workflowPath = workflow.filePath
    }

    // Native and Claude runs deliberately keep different identifier namespaces. Routing here—at
    // the service boundary shared by both MCP tools—prevents an external wf_* ID from ever reaching
    // FileWorkflowStore's run_* path validator while preserving one validated importer for explicit
    // paths and discovered IDs.
    return this.#resumeClaude(scope, {
      claudeRunPath: metadataPath,
      ...(workflowPath === undefined ? {} : { workflowPath }),
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
    }, overrides !== undefined && Object.prototype.hasOwnProperty.call(overrides, 'args')
      ? { provided: true, value: overrides.args }
      : undefined)
  }

  async #resumeStored(
    scope: WorkflowServiceScope,
    input: Extract<WorkflowResumeInput, { runId: string }>,
    overrides?: WorkflowStartInput,
    recoveryMode: 'manual' | 'automatic' = 'manual',
  ): Promise<WorkflowRunStartResult> {
    const owned = this.#ownedRuns.get(input.runId)
    if (owned?.ownershipReleaseSafe?.() === false) {
      const sandbox = this.#options.sandbox
      const canAbandonReadOnlyProvider =
        recoveryMode === 'manual' &&
        input.abandonUnconfirmedProvider === true &&
        (sandbox?.mode ?? 'read-only') === 'read-only' &&
        (sandbox?.network ?? false) === false &&
        (sandbox?.additionalWritableDirectories?.length ?? 0) === 0
      if (!canAbandonReadOnlyProvider) {
        throw new WorkflowServiceError(
          'unsafe-provider-active',
          `Workflow run ${input.runId} still has an unconfirmed provider execution; explicitly acknowledge abandonment to continue this read-only offline run`,
        )
      }
      const abandoned = owned.abandonUnconfirmedProviderExecutions?.() ?? 0
      if (abandoned === 0 || owned.ownershipReleaseSafe?.() === false) {
        throw new WorkflowServiceError(
          'unsafe-provider-active',
          `Workflow run ${input.runId} still owns provider or workspace operations that cannot be abandoned safely`,
        )
      }
      console.warn(
        `[workflow-mcp] Operator abandoned ${abandoned} unconfirmed provider execution(s) before resuming ${input.runId}`,
      )
    }
    const original = await this.#requiredScopedManifest(scope, input.runId)
    if (!['interrupted', 'failed', 'cancelled', 'completed_with_errors'].includes(original.status)) {
      throw new WorkflowServiceError(
        'run-not-resumable',
        `Workflow run ${input.runId} has status ${original.status}`,
      )
    }
    if (input.idempotencyKey !== undefined) {
      const existing = await this.#options.store.findByIdempotencyKey(resolve(scope.cwd), input.idempotencyKey)
      if (existing) return startResult(existing, this.#options.store)
    }
    const lineageId = original.lineageId ?? original.runId
    const existingSuccessor = await this.#findActiveLineageSuccessor(lineageId, original.runId)
    if (existingSuccessor !== undefined) {
      // Recovery identity belongs to the lineage, not the caller's arbitrary idempotency key. A
      // renderer which missed automatic startup must attach to that live successor instead of
      // creating a second physical execution of the same inherited journal.
      this.#assertScope(scope, existingSuccessor)
      return startResult(existingSuccessor, this.#options.store)
    }

    const originalWorkflow = await this.#options.store.loadWorkflow(input.runId)
    const hasSourceOverride = overrides?.scriptPath !== undefined || overrides?.script !== undefined || overrides?.name !== undefined
    const workflow = hasSourceOverride
      ? await this.#resolveStartWorkflow(scope, overrides ?? {})
      : originalWorkflow
    const originalArgs = await this.#options.store.loadArgs(input.runId)
    const args = overrides !== undefined && Object.prototype.hasOwnProperty.call(overrides, 'args')
      ? { provided: true, value: overrides.args }
      : originalArgs
    const priorJournal = await PersistentWorkflowJournal.open(
      this.#options.store.journalPath(input.runId),
      [],
      this.#options.store.journalWriteCoordinator?.(),
    )
    const priorSnapshots = priorJournal.getSnapshots()
    const exactSourceAndArgs =
      workflow.sourceHash === originalWorkflow.sourceHash &&
      isDeepStrictEqual(args, originalArgs)
    try {
      return await this.#startLoaded(scope, workflow, {
        ...(args.provided ? { args: args.value } : {}),
        ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
        resumedFromRunId: input.runId,
        lineageId,
        recoveryMode,
        // Manual recovery should be sparse when the operator is resuming the exact same logical
        // program. Claude's longest-prefix rule remains the compatibility fallback for edited source
        // or changed args, where reusing a later sibling could smuggle an obsolete control-flow path
        // into the new run.
        journalReuseMode: exactSourceAndArgs ? 'exact-source-sparse' : 'longest-prefix',
        // Nested workflow identities share the run sidecar. Passing only the top-level snapshot made
        // a successfully completed child disappear at each successor boundary and rerun after crash.
        ...(priorSnapshots.length === 0 ? {} : { journalSnapshots: priorSnapshots }),
      })
    } catch (cause) {
      if (!hasErrorCode(cause, 'lineage-active')) throw cause
      const winner = await this.#findActiveLineageSuccessor(lineageId, original.runId)
      if (winner === undefined) throw cause
      this.#assertScope(scope, winner)
      return startResult(winner, this.#options.store)
    }
  }

  async #resolveStartWorkflow(
    scope: WorkflowServiceScope,
    input: Pick<WorkflowStartInput, 'name' | 'script' | 'scriptPath'>,
  ): Promise<LoadedWorkflow> {
    const cwd = resolve(scope.cwd)
    try {
      // Claude's precedence is intentional: authoring clients commonly keep `name` in a reusable
      // payload while adding script/scriptPath during iteration. Rejecting that combination would
      // make a harmless stale selector override the bytes the user explicitly asked to test.
      if (input.scriptPath !== undefined) return await loadScopedWorkflowPath(cwd, input.scriptPath)
      if (input.script !== undefined) {
        if (this.#options.allowInlineWorkflowAuthoring === false) {
          throw new WorkflowServiceError(
            'authoring-disabled',
            'Inline workflow authoring is disabled for this read-only service profile',
          )
        }
        return await persistInlineWorkflow(cwd, input.script)
      }
      if (input.name !== undefined) return await this.#resolveVisibleWorkflow(scope, input.name)
    } catch (cause) {
      if (cause instanceof WorkflowAuthoringError) {
        const code = cause.code === 'path-forbidden' ? 'scope-forbidden' : 'invalid-request'
        throw new WorkflowServiceError(code, cause.message, { cause })
      }
      throw cause
    }
    throw new WorkflowServiceError(
      'invalid-request',
      'workflow_run requires one source selector: scriptPath, script, or name',
    )
  }

  async #resumeClaude(
    scope: WorkflowServiceScope,
    input: Extract<WorkflowResumeInput, { claudeRunPath: string }>,
    argsOverride?: { provided: true; value: unknown },
  ): Promise<WorkflowRunStartResult> {
    const cwd = resolve(scope.cwd)
    const claudeProjectRoot = await this.#claudeProjectRoot(cwd)
    const metadataPath = await realpath(resolve(input.claudeRunPath)).catch(() => resolve(input.claudeRunPath))
    if (!isInside(claudeProjectRoot, metadataPath)) {
      throw new WorkflowServiceError(
        'scope-forbidden',
        'Claude run metadata does not belong to the scoped project',
      )
    }

    let workflowPath: string | undefined
    if (input.workflowPath !== undefined) {
      const candidate = resolve(input.workflowPath)
      const found = await findWorkflows({ cwd })
      if (!found.workflows.some((workflow) => resolve(workflow.filePath) === candidate)) {
        throw new WorkflowServiceError(
          'scope-forbidden',
          'Claude resume workflowPath must be one of the definitions visible from this project',
        )
      }
      workflowPath = candidate
    }

    if (input.idempotencyKey !== undefined) {
      const existing = await this.#options.store.findByIdempotencyKey(cwd, input.idempotencyKey)
      if (existing) return startResult(existing, this.#options.store)
    }
    const imported = await loadClaudeWorkflowResume(metadataPath, {
      ...(workflowPath === undefined ? {} : { workflowPath }),
    })
    const importedArgs = Object.prototype.hasOwnProperty.call(imported.metadata, 'args')
      ? { provided: true as const, value: imported.metadata.args }
      : { provided: false as const }
    const args = argsOverride ?? importedArgs
    const exactArgs = argsOverride === undefined || isDeepStrictEqual(argsOverride, importedArgs)
    const journalSnapshots = imported.journal.getSnapshots()
    return this.#startLoaded(scope, imported.workflow, {
      ...(args.provided ? { args: args.value } : {}),
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
      resumedFromRunId: imported.metadata.runId,
      lineageId: imported.metadata.runId,
      recoveryMode: 'manual',
      // loadClaudeWorkflowResume already refuses a source mismatch. When args also match, use the
      // same sparse contract as an unchanged native manual resume so one failed Claude call does not
      // invalidate successful siblings; imported prompt identities additionally repair chained-key
      // changes caused solely by work-conserving pipeline completion order. A caller-provided args
      // change falls back to Claude's conservative longest-prefix rule.
      journalReuseMode: exactArgs ? 'exact-source-sparse' : 'longest-prefix',
      ...(journalSnapshots.length === 0 ? {} : { journalSnapshots }),
    })
  }

  async #claudeProjectRoot(cwd: string): Promise<string> {
    const projectsRoot = resolve(
      this.#options.claudeProjectsRoot ?? join(homedir(), '.claude', 'projects'),
    )
    const projectRoot = join(projectsRoot, claudeProjectKey(cwd))
    return realpath(projectRoot).catch(() => projectRoot)
  }

  subscribe(listener: WorkflowServiceListener): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  async #startLoaded(
    scope: WorkflowServiceScope,
    workflow: LoadedWorkflow,
    input: {
      args?: unknown
      idempotencyKey?: string
      resumedFromRunId?: string
      lineageId?: string
      recoveryMode?: 'manual' | 'automatic'
      journalReuseMode?: JournalReuseMode
      reuseCoverageGaps?: boolean
      journalSnapshots?: Parameters<typeof PersistentWorkflowJournal.open>[1]
    },
  ): Promise<WorkflowRunStartResult> {
    const runId = `run_${randomUUID()}`
    const cwd = resolve(scope.cwd)
    await this.#authorizeWorkflowSource(scope, workflow, 'root')
    const providerContext: WorkflowProviderFactoryContext = {
      runId,
      cwd,
      ...(scope.clientId === undefined ? {} : { clientId: scope.clientId }),
    }
    // Construct the provider before reserving the manifest so its replay-safety decision becomes
    // part of the durable crash contract. Deriving this later from a replacement host would allow
    // an upgraded or differently scoped MCP client to reinterpret an already-issued side effect.
    const provider = typeof this.#options.provider === 'function'
      ? this.#options.provider(providerContext)
      : this.#options.provider
    const recoveryEvidence = typeof this.#options.provider === 'function'
      ? this.#options.providerRecoveryEvidence?.(providerContext)
      : {
          fingerprint: provider.recoveryFingerprint,
          automaticReplaySafe: provider.automaticReplaySafety === 'safe',
        }
    const durableRecoveryFingerprint =
      recoveryEvidence?.automaticReplaySafe === true &&
      recoveryEvidence.fingerprint !== undefined &&
      recoveryEvidence.fingerprint === provider.recoveryFingerprint
        ? recoveryEvidence.fingerprint
        : undefined
    let manifest = await this.#options.store.createRun({
      runId,
      cwd,
      workflow,
      ...(Object.prototype.hasOwnProperty.call(input, 'args') ? { args: input.args } : {}),
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
      ...(scope.clientId === undefined ? {} : { clientId: scope.clientId }),
      ...(input.resumedFromRunId === undefined ? {} : { resumedFromRunId: input.resumedFromRunId }),
      lineageId: input.lineageId ?? runId,
      ...(input.recoveryMode === undefined ? {} : { recoveryMode: input.recoveryMode }),
      // Provider-wide safety is necessary but not sufficient. Network is a request capability,
      // and a read-only filesystem does not prevent HTTP POSTs or other remote effects. Persisting
      // `safe` here previously let restart recovery forget that distinction and replay a networked
      // attempt after a crash. The manifest records the effective host policy that every agent in
      // this service inherits; per-agent capability expansion must likewise become durable before
      // such expansion is added to the workflow language.
      automaticReplaySafe: durableRecoveryFingerprint !== undefined
        && (this.#options.sandbox?.network ?? false) === false,
      ...(durableRecoveryFingerprint === undefined
        ? {}
        : { providerRecoveryFingerprint: durableRecoveryFingerprint }),
      ...(input.journalSnapshots === undefined
        ? {}
        : { journalSnapshots: [...input.journalSnapshots] }),
    })
    const journal = await PersistentWorkflowJournal.open(
      this.#options.store.journalPath(runId),
      input.journalSnapshots,
      this.#options.store.journalWriteCoordinator?.(),
    )
    const circuitKey = this.#options.providerCircuitKey?.(provider, providerContext) ?? provider.name
    if (circuitKey.length === 0) {
      throw new WorkflowServiceError('invalid-request', 'Workflow provider circuit key must not be empty')
    }
    const circuitBreaker = this.#circuitBreakers.get(circuitKey) ?? new ProviderCircuitBreaker(this.#reliability)
    this.#circuitBreakers.set(circuitKey, circuitBreaker)
    this.#runCircuitKeys.set(runId, circuitKey)
    const run = runWorkflow({
      runId,
      workflow,
      ...(Object.prototype.hasOwnProperty.call(input, 'args') ? { args: input.args } : {}),
      cwd,
      provider,
      journal,
      journalReuseMode: input.journalReuseMode ?? (
        input.recoveryMode === 'automatic' ? 'exact-source-sparse' : 'longest-prefix'
      ),
      // WHY only automatic recovery reuses coverage gaps: it is repairing an interrupted
      // supervisor generation and must not silently replay work already classified unsafe or
      // exhausted. An explicit workflow_resume is the user's request to try those casualties
      // again, while still reusing every successful sibling from the exact-source sparse journal.
      reuseCoverageGaps: input.reuseCoverageGaps ?? input.recoveryMode === 'automatic',
      scheduler: this.#scheduler,
      circuitBreaker,
      lineageId: input.lineageId ?? runId,
      ...(this.#options.workerLauncher === undefined
        ? {}
        : { workerLauncher: this.#options.workerLauncher }),
      ...(this.#options.workerFilePath === undefined
        ? {}
        : { workerFilePath: this.#options.workerFilePath }),
      ...(this.#options.limits === undefined ? {} : { limits: this.#options.limits }),
      ...(this.#options.reliability === undefined ? {} : { reliability: this.#options.reliability }),
      ...(this.#options.budgetTokens === undefined
        ? {}
        : { budgetTokens: this.#options.budgetTokens }),
      ...(this.#options.defaultModel === undefined ? {} : { defaultModel: this.#options.defaultModel }),
      ...(this.#options.modelAliases === undefined ? {} : { modelAliases: this.#options.modelAliases }),
      ...(this.#options.defaultEffort === undefined
        ? {}
        : { defaultEffort: this.#options.defaultEffort }),
      ...(this.#options.resolveAgentType === undefined
        ? {}
        : { resolveAgentType: (name: string) => this.#options.resolveAgentType!(name, cwd) }),
      // Nested object targets used to bypass WorkflowService and call loadWorkflowFile() directly.
      // Keep every executable source behind the same project confinement and source-hash approval
      // boundary as the root, regardless of which workflow helper selected it.
      resolveWorkflow: (target) => this.#resolveNestedWorkflow(scope, target),
      ...(this.#options.prepareWorkingDirectory === undefined
        ? {}
        : { prepareWorkingDirectory: this.#options.prepareWorkingDirectory }),
      // Read-only is the service default even though the low-level executor remains backwards
      // compatible with its historical workspace-write CLI default. MCP input has no field that
      // can widen this host-owned policy.
      sandbox: {
        mode: 'read-only',
        approvalPolicy: 'never',
        network: false,
        ...this.#options.sandbox,
      },
      // Durable store replay is the service source of truth. Keeping a second in-memory copy was
      // the renderer-host memory amplification that originally made large workflows unstable.
      retainEventHistory: false,
      // Result bytes must cross the store's fsync boundary before artifact.created/run.completed
      // can expose their locator. This hook is deliberately adjacent to the durable event sink:
      // together they make completion publication one ordered artifact-then-event protocol.
      materializeResult: result => this.#options.store.persistResult(runId, result),
      // Non-fatal by contract on the runner side; a store that cannot do this at all simply omits
      // the capability and every agent read falls back to the journal.
      ...(this.#options.store.persistAgentResult === undefined ? {} : {
        materializeAgentResult: (agentId: string, result: WorkflowResultMaterialization) =>
          this.#options.store.persistAgentResult!(runId, agentId, result),
      }),
      eventSink: async (event) => {
        const stored = await this.#options.store.appendEvent(runId, event)
        this.#publish(stored)
      },
    })
    this.#active.set(runId, run)
    this.#ownedRuns.set(runId, run)
    void run.result
      .catch(() => undefined)
      .finally(() => {
        this.#active.delete(runId)
        if (run.ownershipReleaseSafe?.() !== false) {
          this.#ownedRuns.delete(runId)
          return
        }
        // A hostile adapter may outlive the finite cancellation path but still exit eventually.
        // Keep the cross-process fence during that interval, then retire the quarantine and release
        // a stopped service's lease automatically; requiring process exit after a late clean stop
        // would turn a bounded provider fault into needless downtime.
        void run.waitForOwnershipRelease?.().then(async () => {
          if (run.ownershipReleaseSafe?.() === false) return
          this.#ownedRuns.delete(runId)
          if ((this.#lifecycle === 'QUIESCING' || this.#lifecycle === 'FAILED') && [...this.#ownedRuns.values()]
            .every((owned) => owned.ownershipReleaseSafe?.() !== false)) {
            await this.#releaseStoreLease()
          }
        }).catch((error: unknown) => {
          console.error(`[workflow-mcp] Cannot retire provider quarantine for ${runId}:`, error)
        })
      })

    // First event persistence is asynchronous by design; returning queued immediately is what lets
    // an MCP client render a card before the evaluator or provider has completed any work.
    manifest = await this.#options.store.getManifest(runId) ?? manifest
    return startResult(manifest, this.#options.store)
  }

  async #resolveVisibleWorkflow(scope: WorkflowServiceScope, name: string): Promise<FoundWorkflow> {
    if (typeof name !== 'string' || name.length === 0) {
      throw new WorkflowServiceError('invalid-request', 'Workflow name is required')
    }
    const found = await findWorkflows({ cwd: resolve(scope.cwd) })
    const workflow = found.workflows.find((candidate) => candidate.meta.name === name)
    if (!workflow) {
      throw new WorkflowServiceError(
        'workflow-not-found',
        `Workflow ${JSON.stringify(name)} is not visible from ${resolve(scope.cwd)}`,
      )
    }
    return workflow
  }

  async #findActiveLineageSuccessor(
    lineageId: string,
    predecessorRunId: string,
  ): Promise<WorkflowRunManifest | undefined> {
    if (this.#options.store.findActiveLineageSuccessor !== undefined) {
      return this.#options.store.findActiveLineageSuccessor(lineageId, predecessorRunId)
    }
    return (await this.#options.store.listManifests())
      .filter((manifest) => (
        manifest.runId !== predecessorRunId &&
        (manifest.lineageId ?? manifest.runId) === lineageId &&
        !TERMINAL_STATUSES.has(manifest.status)
      ))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .at(-1)
  }

  async #resolveNestedWorkflow(
    scope: WorkflowServiceScope,
    target: Parameters<WorkflowResolver>[0],
  ): Promise<LoadedWorkflow> {
    let workflow: LoadedWorkflow
    try {
      workflow = typeof target === 'string'
        ? await this.#resolveVisibleWorkflow(scope, target)
        : await loadScopedWorkflowPath(resolve(scope.cwd), target.scriptPath)
    } catch (cause) {
      if (cause instanceof WorkflowAuthoringError) {
        const code = cause.code === 'path-forbidden' ? 'scope-forbidden' : 'invalid-request'
        throw new WorkflowServiceError(code, cause.message, { cause })
      }
      throw cause
    }
    await this.#authorizeWorkflowSource(scope, workflow, 'nested')
    return workflow
  }

  async #authorizeWorkflowSource(
    scope: WorkflowServiceScope,
    workflow: LoadedWorkflow,
    origin: WorkflowSourceAuthorizationRequest['origin'],
  ): Promise<void> {
    if (this.#options.authorizeWorkflowSource === undefined) return
    const canonicalIdentity = workflow.filePath === undefined
      ? `inline:${workflow.meta.name}`
      : await realpath(workflow.filePath).catch(() => resolve(workflow.filePath!))
    const authorized = await this.#options.authorizeWorkflowSource({
      cwd: resolve(scope.cwd),
      ...(scope.clientId === undefined ? {} : { clientId: scope.clientId }),
      origin,
      canonicalIdentity,
      sourceHash: workflow.sourceHash,
      workflowName: workflow.meta.name,
    })
    if (!authorized) {
      throw new WorkflowServiceError(
        'source-approval-required',
        `Workflow source approval is required for ${canonicalIdentity} at ${workflow.sourceHash}`,
      )
    }
  }

  async #requiredManifest(runId: string): Promise<WorkflowRunManifest> {
    const manifest = await this.#options.store.getManifest(runId)
    if (!manifest) throw new WorkflowServiceError('run-not-found', `Workflow run not found: ${runId}`)
    return manifest
  }

  async #requiredScopedManifest(
    scope: WorkflowServiceScope,
    runId: string,
  ): Promise<WorkflowRunManifest> {
    const manifest = await this.#requiredManifest(runId)
    this.#assertScope(scope, manifest)
    return manifest
  }

  #assertScope(scope: WorkflowServiceScope, manifest: WorkflowRunManifest): void {
    if (resolve(scope.cwd) === manifest.cwd) return
    // Manifests store resolve()d paths, but a client may address the same project through a
    // symlink (common for ~/dev shims and macOS /tmp). The Claude-resume importer already
    // compares realpaths; without the same tolerance here, that one caller could import a run
    // this method then refuses to read. realpath only runs on the mismatch path, so the common
    // exact-match case stays free of filesystem calls.
    try {
      if (realpathSync(scope.cwd) === realpathSync(manifest.cwd)) return
    } catch {
      // A path that cannot be canonicalized cannot prove scope membership; fall through.
    }
    throw new WorkflowServiceError(
      'scope-forbidden',
      `Workflow run ${manifest.runId} belongs to another project`,
    )
  }

  #assertAvailable(): void {
    if (this.#lifecycle === 'QUIESCING') {
      throw new WorkflowServiceError('service-stopping', 'Workflow service is stopping')
    }
    if (this.#lifecycle === 'STOPPED') {
      throw new WorkflowServiceError('service-stopped', 'Workflow service is stopped')
    }
    if (this.#lifecycle !== 'READY') {
      throw new WorkflowServiceError('invalid-request', 'Workflow service must be initialized first')
    }
  }

  #isClosing(): boolean {
    // Kept as a method because lifecycle may change while an awaited store operation is in flight;
    // TypeScript's local control-flow narrowing cannot observe that asynchronous transition.
    return this.#lifecycle === 'QUIESCING' || this.#lifecycle === 'STOPPED'
  }

  #initializationClosingError(): WorkflowServiceError {
    // Preserve stop()'s historical code for Agent Code while the additive daemon quiesce path gets
    // the typed transitional outcome needed by clients deciding whether to reconnect.
    return this.#closingMode === 'interruption'
      ? new WorkflowServiceError('service-stopping', 'Workflow service stopped during initialization')
      : new WorkflowServiceError('service-stopped', 'Workflow service stopped during initialization')
  }

  #withMutationAdmission<T>(mutation: () => Promise<T>): Promise<T> {
    this.#assertAvailable()
    this.#admittedMutations += 1
    return (async () => {
      try {
        return await mutation()
      } finally {
        this.#admittedMutations -= 1
        if (this.#admittedMutations === 0) {
          for (const wake of this.#admissionDrainWaiters) wake()
          this.#admissionDrainWaiters.clear()
        }
      }
    })()
  }

  #waitForAdmissionDrain(): Promise<void> {
    if (this.#admittedMutations === 0) return Promise.resolve()
    return new Promise(resolveDrain => this.#admissionDrainWaiters.add(resolveDrain))
  }

  async #automaticRecoveryIsSafe(manifest: WorkflowRunManifest): Promise<boolean> {
    if (!this.#recovery.autoResumeOnInitialize || manifest.automaticReplaySafe !== true) return false
    if (manifest.providerRecoveryFingerprint === undefined) return false
    const mode = this.#options.sandbox?.mode ?? 'read-only'
    // Re-check the current host policy as well as the persisted decision. An operator can restart
    // the service with broader capabilities than the crashed process had; recovery must become
    // more conservative across that transition, never less.
    if ((this.#options.sandbox?.network ?? false) !== false) return false
    if (!(mode === 'read-only' || this.#recovery.allowMutableSandbox)) return false

    const context: WorkflowProviderFactoryContext = {
      runId: manifest.runId,
      cwd: manifest.cwd,
      ...(manifest.clientId === undefined ? {} : { clientId: manifest.clientId }),
    }
    const evidence = typeof this.#options.provider === 'function'
      ? this.#options.providerRecoveryEvidence?.(context)
      : {
          fingerprint: this.#options.provider.recoveryFingerprint,
          automaticReplaySafe: this.#options.provider.automaticReplaySafety === 'safe',
        }
    if (
      evidence?.automaticReplaySafe !== true ||
      evidence.fingerprint !== manifest.providerRecoveryFingerprint
    ) return false

    const snapshot = await this.#options.store.snapshot(manifest.runId)
    const unresolvedAgents = snapshot.state.agents.filter((agent) => (
      agent.attempts.some((attempt) => attempt.status === 'running' || attempt.status === 'stalled')
    ))
    const journal = await PersistentWorkflowJournal.open(
      this.#options.store.journalPath(manifest.runId),
      [],
      this.#options.store.journalWriteCoordinator?.(),
    )
    const terminalJournalCalls = new Set(
      journal.getSnapshots().flatMap((journalSnapshot) => (
        journalSnapshot.records.flatMap((record) => (
          record.type === 'result' ? [`${record.key}\0${record.agentId}`] : []
        ))
      )),
    )
    // WHY legacy attempts without request evidence fail closed: provider-wide safety cannot prove
    // that this particular call had no network access, shared-worktree mutation, or expanded tool
    // capability. New runs persist the concrete assessment in agent.started before dispatch.
    //
    // WHY a terminal journal result overrides stale event state: result/session disposition is one
    // atomic recovery commit, but the subsequent agent.completed/recovery_required event is a
    // separate append. A crash between them leaves projection saying "running" even though the
    // successor will reuse the durable result and never replay the physical attempt. Requiring
    // replay safety in that window strands final synthesis, especially for intentionally unsafe
    // coverage gaps. Only unresolved calls without a terminal journal value need replay authority.
    return unresolvedAgents.every((agent) => (
      terminalJournalCalls.has(`${agent.cacheKey}\0${agent.id}`) ||
      agent.attempts
        .filter((attempt) => attempt.status === 'running' || attempt.status === 'stalled')
        .every((attempt) => attempt.replaySafety?.automatic === true)
    ))
  }

  async #releaseStoreLease(): Promise<void> {
    if (this.#storeLeaseRelease) return this.#storeLeaseRelease
    const lease = this.#storeLease
    if (!lease) return
    const release = lease.release()
    this.#storeLeaseRelease = release
    try {
      await release
      if (this.#storeLease === lease) this.#storeLease = undefined
    } finally {
      if (this.#storeLeaseRelease === release) this.#storeLeaseRelease = undefined
    }
  }

  async #serializeIdempotentStart(
    scope: WorkflowServiceScope,
    key: string | undefined,
    start: () => Promise<WorkflowRunStartResult>,
  ): Promise<WorkflowRunStartResult> {
    if (key === undefined) return start()
    const identity = `${resolve(scope.cwd)}\0${key}`
    const existing = this.#idempotentStarts.get(identity)
    if (existing) return existing
    // WHY the in-flight promise covers lookup plus create: the durable store has a single fenced
    // service owner, but two MCP requests can still interleave `findByIdempotencyKey()` before
    // either creates its manifest. Serializing only creation is too late and produces duplicate
    // provider executions for one client retry.
    const pending = start()
    this.#idempotentStarts.set(identity, pending)
    try {
      return await pending
    } finally {
      if (this.#idempotentStarts.get(identity) === pending) this.#idempotentStarts.delete(identity)
    }
  }

  #publish(event: StoredWorkflowEvent): void {
    this.#runVersions.set(event.runId, (this.#runVersions.get(event.runId) ?? 0) + 1)
    for (const listener of this.#listeners) listener(event)
    const waiters = this.#waiters.get(event.runId)
    if (!waiters) return
    this.#waiters.delete(event.runId)
    for (const wake of waiters) wake()
  }

  #waitForEvent(runId: string, waitMs: number, observedVersion: number): Promise<void> {
    return new Promise((resolveWait) => {
      let finished = false
      const finish = (): void => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        const waiters = this.#waiters.get(runId)
        waiters?.delete(finish)
        if (waiters?.size === 0) this.#waiters.delete(runId)
        resolveWait()
      }
      const timer = setTimeout(finish, waitMs)
      if ((this.#runVersions.get(runId) ?? 0) !== observedVersion) {
        finish()
        return
      }
      const waiters = this.#waiters.get(runId)
      if (waiters) waiters.add(finish)
      else this.#waiters.set(runId, new Set([finish]))
      // Persist/publish can win between the version check and waiter insertion because both sides
      // contain awaits before this point. Rechecking after insertion closes that lost-wakeup window;
      // cursor replay remains the source of truth after either wake path.
      if ((this.#runVersions.get(runId) ?? 0) !== observedVersion) finish()
    })
  }
}

function startResult(
  manifest: WorkflowRunManifest,
  store: WorkflowStore,
): WorkflowRunStartResult {
  return {
    runId: manifest.runId,
    status: manifest.status,
    workflow: {
      name: manifest.workflow.name,
      description: manifest.workflow.description,
      ...(manifest.workflow.title === undefined ? {} : { title: manifest.workflow.title }),
    },
    cursor: manifest.cursor,
    transcriptDirectory: store.transcriptDirectory(manifest.runId),
    lineageId: manifest.lineageId ?? manifest.runId,
    ...(manifest.workflow.filePath === undefined ? {} : { scriptPath: manifest.workflow.filePath }),
    ...(manifest.resumedFromRunId === undefined
      ? {}
      : { resumedFromRunId: manifest.resumedFromRunId }),
    ...(manifest.recoveryMode === undefined ? {} : { recoveryMode: manifest.recoveryMode }),
  }
}

function validateIdempotencyKey(key: string | undefined): void {
  if (key === undefined) return
  if (key.length === 0 || key.length > 200) {
    throw new WorkflowServiceError('invalid-request', 'idempotencyKey must contain 1 to 200 characters')
  }
}

function boundedInteger(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new WorkflowServiceError(
      'invalid-request',
      `${name} must be an integer from ${minimum} through ${maximum}`,
    )
  }
  return value
}

function claudeProjectKey(cwd: string): string {
  // Claude's on-disk project key replaces every path separator and punctuation byte with '-'. The
  // importer still verifies source hashes and journals; this key is only the scope boundary that
  // prevents an MCP session in project A from naming project B's otherwise-valid run manifest.
  return cwd.replace(/[^A-Za-z0-9]/g, '-')
}

function isInside(parent: string, candidate: string): boolean {
  const child = relative(resolve(parent), resolve(candidate))
  return child.length > 0 && !child.startsWith('..') && !isAbsolute(child)
}

function hasErrorCode(value: unknown, code: string): boolean {
  return typeof value === 'object' && value !== null && 'code' in value && value.code === code
}
