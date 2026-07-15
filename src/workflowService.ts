import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'

import type { AgentProvider, AgentSandboxPolicy } from './agentProvider.js'
import { loadClaudeWorkflowResume } from './claudeResume.js'
import { findWorkflows } from './findWorkflows.js'
import type { FoundWorkflow } from './findWorkflows.js'
import type { LoadedWorkflow } from './loadWorkflow.js'
import { PersistentWorkflowJournal } from './persistentWorkflowJournal.js'
import { runWorkflow } from './runWorkflow.js'
import type { RunWorkflowOptions, WorkflowLimits, WorkflowRun } from './runWorkflow.js'
import { normalizeReliabilityPolicy, ProviderCircuitBreaker } from './executionReliability.js'
import type { ProviderCircuitSnapshot, WorkflowReliabilityPolicy } from './executionReliability.js'
import {
  loadScopedWorkflowPath,
  persistInlineWorkflow,
  WorkflowAuthoringError,
} from './workflowAuthoring.js'
import type { WorkflowEvent } from './workflowEvents.js'
import type { WorkflowWorkerLauncher } from './workerLauncher.js'
import type {
  StoredWorkflowEvent,
  WorkflowEventPage,
  WorkflowRunManifest,
  WorkflowRunSnapshot,
  WorkflowRunStatus,
  WorkflowStore,
  WorkflowStoreLease,
} from './workflowStore.js'
import { WorkConservingScheduler } from './workConservingScheduler.js'
import type { AgentScheduler, SchedulerSnapshot } from './workConservingScheduler.js'

const TERMINAL_STATUSES = new Set<WorkflowRunStatus>([
  'completed',
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
  | 'service-stopped'
  | 'unsafe-provider-active'
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
  /** Claude-shaped resume alias; creates a new durable run and preserves the lineage. */
  resumeFromRunId?: string
  idempotencyKey?: string
}

export type WorkflowResumeInput =
  | { runId: string; idempotencyKey?: string }
  | { claudeRunPath: string; workflowPath?: string; idempotencyKey?: string }

type ReadInput = {
  runId: string
  after?: number
  limit?: number
  waitMs?: number
}

export type WorkflowServiceListener = (event: StoredWorkflowEvent) => void

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
  #initialized = false
  #stopped = false

  constructor(options: WorkflowServiceOptions) {
    this.#options = options
    this.#scheduler = options.scheduler ?? new WorkConservingScheduler(options.limits?.concurrency ?? 9)
    this.#reliability = normalizeReliabilityPolicy(options.reliability)
    this.#recovery = { ...DEFAULT_RECOVERY_POLICY, ...options.recovery }
  }

  async initialize(): Promise<void> {
    if (this.#stopped) {
      throw new WorkflowServiceError('service-stopped', 'Workflow service is stopped')
    }
    if (this.#initialized) return
    if (this.#initializePromise) return this.#initializePromise
    const initialization = this.#initializeOnce()
    this.#initializePromise = initialization
    try {
      await initialization
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
      if (this.#stopped) {
        await this.#releaseStoreLease()
        throw new WorkflowServiceError('service-stopped', 'Workflow service stopped during initialization')
      }
      await this.#options.store.initialize()
      // stop() may arrive while an asynchronous store repair is in flight. It deliberately waits
      // for this initialization owner rather than stealing the lease, so this owner must notice the
      // stop before advertising availability or creating recovery successors.
      if (this.#stopped) {
        throw new WorkflowServiceError('service-stopped', 'Workflow service stopped during initialization')
      }
      this.#initialized = true
      const manifests = await this.#options.store.listManifests()
      // The manifest scan can itself be a long filesystem operation on a FAT history. Recheck at
      // each awaited boundary: otherwise a stop which lands during the scan can return only after
      // initialization has unexpectedly launched every automatic-recovery run.
      if (this.#stopped) {
        throw new WorkflowServiceError('service-stopped', 'Workflow service stopped during initialization')
      }
      const continuedRuns = new Set(
        manifests.flatMap((manifest) => (
          manifest.resumedFromRunId === undefined ? [] : [manifest.resumedFromRunId]
        )),
      )
      const recoverable: WorkflowRunManifest[] = []
      for (const manifest of manifests) {
        if (TERMINAL_STATUSES.has(manifest.status)) {
          // WHY interrupted runs are reconsidered: the previous host may have durably written the
          // terminal marker and died before creating its successor manifest. A successor is the
          // recovery commit record; without one, skipping every terminal run strands the lineage.
          if (
            manifest.status === 'interrupted' &&
            !continuedRuns.has(manifest.runId) &&
            (
              this.#automaticRecoveryIsSafe(manifest) ||
              // A lone run.interrupted event is the recovery record for a cursor-zero queued run.
              // No evaluator or provider was ever admitted, so continuing it cannot repeat a tool
              // side effect even when the provider correctly refuses general automatic replay.
              manifest.cursor === 1
            )
          ) recoverable.push(manifest)
          continue
        }
        const shouldRecover =
          this.#recovery.autoResumeOnInitialize &&
          (
            (manifest.status === 'running' && this.#automaticRecoveryIsSafe(manifest)) ||
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
      this.#initialized = false
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
    if (this.#stopPromise) return this.#stopPromise
    this.#stopped = true
    const stopping = this.#stopOnce(reason)
    this.#stopPromise = stopping
    try {
      await stopping
    } finally {
      // FileWorkflowStore.release() deliberately remains retryable after transient I/O failure.
      // Do not memoize a rejected service stop forever or callers can never exercise that retry.
      if (this.#stopPromise === stopping) this.#stopPromise = undefined
    }
  }

  async #stopOnce(reason: string): Promise<void> {
    // Initialization owns the lease transition and recovery scan. Cancelling/releasing in the
    // middle would let a second host enter while the first still mutates manifests. Once the shared
    // initialization promise settles, this stop owns a clean, deterministic teardown boundary.
    await this.#initializePromise?.catch(() => undefined)
    let ownershipCanTransfer = true
    try {
      const runs = [...this.#active.values()]
      await Promise.allSettled(runs.map((run) => run.cancel(reason)))
      this.#active.clear()
      ownershipCanTransfer = [...this.#ownedRuns.values()]
        .every((run) => run.ownershipReleaseSafe?.() !== false)
      for (const waiters of this.#waiters.values()) for (const wake of waiters) wake()
      this.#waiters.clear()
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
    this.#assertAvailable()
    validateIdempotencyKey(input.idempotencyKey)
    return this.#serializeIdempotentStart(scope, input.idempotencyKey, () => this.#startOnce(scope, input))
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
      return this.#resumeStored(scope, {
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
    const successor = (await this.#options.store.listManifests())
      .filter((manifest) => manifest.resumedFromRunId === runId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .at(-1)
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
    let page = await this.#options.store.readEvents(input.runId, after, limit)
    if (page.events.length > 0 || waitMs === 0 || TERMINAL_STATUSES.has(manifest.status)) return page

    await this.#waitForEvent(input.runId, waitMs, observedVersion)
    manifest = await this.status(scope, input.runId)
    page = await this.#options.store.readEvents(input.runId, after, limit)
    return page
  }

  async cancel(
    scope: WorkflowServiceScope,
    runId: string,
    reason = 'Cancelled by workflow client',
  ): Promise<WorkflowRunManifest> {
    const manifest = await this.status(scope, runId)
    if (TERMINAL_STATUSES.has(manifest.status)) return manifest
    const active = this.#active.get(runId)
    if (!active) {
      // A non-terminal manifest without an active owner can only exist between startup and recovery
      // or after an invariant failure. Refusing to fabricate cancellation preserves the distinction
      // that run.interrupted exists to communicate.
      throw new WorkflowServiceError('invalid-request', `Workflow run is not active: ${runId}`)
    }
    await active.cancel(reason)
    return this.status(scope, runId)
  }

  async resume(scope: WorkflowServiceScope, input: WorkflowResumeInput): Promise<WorkflowRunStartResult> {
    this.#assertAvailable()
    validateIdempotencyKey(input.idempotencyKey)
    return this.#serializeIdempotentStart(scope, input.idempotencyKey, () => (
      'claudeRunPath' in input ? this.#resumeClaude(scope, input) : this.#resumeStored(scope, input)
    ))
  }

  async #resumeStored(
    scope: WorkflowServiceScope,
    input: Extract<WorkflowResumeInput, { runId: string }>,
    overrides?: WorkflowStartInput,
    recoveryMode: 'manual' | 'automatic' = 'manual',
  ): Promise<WorkflowRunStartResult> {
    const owned = this.#ownedRuns.get(input.runId)
    if (owned?.ownershipReleaseSafe?.() === false) {
      throw new WorkflowServiceError(
        'unsafe-provider-active',
        `Workflow run ${input.runId} still has an unconfirmed provider execution`,
      )
    }
    const original = await this.status(scope, input.runId)
    if (!['interrupted', 'failed', 'cancelled'].includes(original.status)) {
      throw new WorkflowServiceError(
        'run-not-resumable',
        `Workflow run ${input.runId} has status ${original.status}`,
      )
    }
    if (input.idempotencyKey !== undefined) {
      const existing = await this.#options.store.findByIdempotencyKey(resolve(scope.cwd), input.idempotencyKey)
      if (existing) return startResult(existing, this.#options.store)
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
    )
    // WHY the old identity is used to retrieve the snapshot: `scriptPath` may point at edited
    // bytes, but its stable path is precisely what allows beginRun to compare the prior source hash
    // and invalidate only when the source actually changed. Looking up with a newly selected name
    // would silently discard resumable history before the journal can make that decision.
    const workflowId = originalWorkflow.filePath ?? originalWorkflow.meta.name
    const priorSnapshot = priorJournal.getSnapshot(workflowId)
    return this.#startLoaded(scope, workflow, {
      ...(args.provided ? { args: args.value } : {}),
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
      resumedFromRunId: input.runId,
      lineageId: original.lineageId ?? original.runId,
      recoveryMode,
      ...(priorSnapshot === undefined ? {} : { journalSnapshots: [priorSnapshot] }),
    })
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
      if (input.script !== undefined) return await persistInlineWorkflow(cwd, input.script)
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
  ): Promise<WorkflowRunStartResult> {
    const cwd = resolve(scope.cwd)
    const claudeProjectRoot = await realpath(
      join(homedir(), '.claude', 'projects', claudeProjectKey(cwd)),
    ).catch(() => join(homedir(), '.claude', 'projects', claudeProjectKey(cwd)))
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
    const workflowId = imported.workflow.filePath ?? imported.workflow.meta.name
    const journalSnapshot = imported.journal.getSnapshot(workflowId)
    return this.#startLoaded(scope, imported.workflow, {
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
      resumedFromRunId: imported.metadata.runId,
      lineageId: imported.metadata.runId,
      recoveryMode: 'manual',
      ...(journalSnapshot === undefined ? {} : { journalSnapshots: [journalSnapshot] }),
    })
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
      journalSnapshots?: Parameters<typeof PersistentWorkflowJournal.open>[1]
    },
  ): Promise<WorkflowRunStartResult> {
    const runId = `run_${randomUUID()}`
    const cwd = resolve(scope.cwd)
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
      automaticReplaySafe: provider.automaticReplaySafety === 'safe',
    })
    const journal = await PersistentWorkflowJournal.open(
      this.#options.store.journalPath(runId),
      input.journalSnapshots,
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
      journalReuseMode: input.recoveryMode === 'automatic'
        ? 'exact-source-sparse'
        : 'longest-prefix',
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
          if (this.#stopped && [...this.#ownedRuns.values()]
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

  async #requiredManifest(runId: string): Promise<WorkflowRunManifest> {
    const manifest = await this.#options.store.getManifest(runId)
    if (!manifest) throw new WorkflowServiceError('run-not-found', `Workflow run not found: ${runId}`)
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
    if (this.#stopped) throw new WorkflowServiceError('service-stopped', 'Workflow service is stopped')
    if (!this.#initialized) {
      throw new WorkflowServiceError('invalid-request', 'Workflow service must be initialized first')
    }
  }

  #automaticRecoveryIsSafe(manifest: WorkflowRunManifest): boolean {
    if (!this.#recovery.autoResumeOnInitialize || manifest.automaticReplaySafe !== true) return false
    const mode = this.#options.sandbox?.mode ?? 'read-only'
    return mode === 'read-only' || this.#recovery.allowMutableSandbox
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
