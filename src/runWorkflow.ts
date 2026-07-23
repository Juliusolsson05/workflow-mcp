import { createHash, randomUUID } from 'node:crypto'
import { setMaxListeners } from 'node:events'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Ajv } from 'ajv/dist/ajv.js'
import type { AnySchema, ValidateFunction } from 'ajv'

import {
  AgentProviderAbortError,
  AgentProviderFailure,
} from './agentProvider.js'
import type {
  AgentProvider,
  AgentProviderActivity,
  AgentProviderAttemptIdentity,
  AgentProviderEvent,
  AgentProviderResult,
  AgentRecoveryContext,
  AgentReplaySafetyAssessment,
  AgentRequest,
  AgentSandboxPolicy,
  ProviderSessionReference,
} from './agentProvider.js'
import {
  AgentAttemptTimeoutError,
  AttemptLivenessMonitor,
  ProviderCircuitBreaker,
  normalizeReliabilityPolicy,
  retryDelayMs,
} from './executionReliability.js'
import type { WorkflowReliabilityPolicy } from './executionReliability.js'
import type { ProviderCircuitLease } from './executionReliability.js'
import { findWorkflows } from './findWorkflows.js'
import { loadWorkflowFile } from './loadWorkflow.js'
import type { LoadedWorkflow } from './loadWorkflow.js'
import { InMemoryWorkflowJournal } from './workflowJournal.js'
import type {
  JournalReuseMode,
  JournalMiss,
  WorkflowJournal,
  WorkflowJournalRun,
} from './workflowJournal.js'
import type {
  ContentReference,
  NormalizedAgentOptions,
  WorkflowErrorReference,
  WorkflowEvent,
  WorkflowEventSink,
  WorkflowAgentFailurePlaceholder,
  WorkflowResultMaterialization,
} from './workflowEvents.js'
import { isWorkflowAgentFailurePlaceholder, serializeWorkflowValue } from './workflowEvents.js'
import type {
  ParentToWorkerMessage,
  SerializedWorkerError,
  WorkerAgentOptions,
  WorkerToParentMessage,
  WorkerWorkflowTarget,
  WorkflowWorkerLimits,
} from './workerMessages.js'
import { serializeWorkerError, WORKFLOW_WORKER_HEARTBEAT_INTERVAL_MS } from './workerMessages.js'
import { NodeWorkflowWorkerLauncher } from './nodeWorkflowWorkerLauncher.js'
import type { WorkflowWorkerHandle, WorkflowWorkerLauncher } from './workerLauncher.js'
import { WorkConservingScheduler } from './workConservingScheduler.js'
import type { AgentScheduler, SchedulerLease, SchedulerSnapshot } from './workConservingScheduler.js'

export type WorkflowLimits = {
  concurrency: number
  maxAgentCalls: number
  maxCollectionItems: number
  maxLogCharacters: number
  maxValueDepth: number
  maxValueNodes: number
  synchronousTimeoutMs: number
  /** Optional host policy. Omit to let the workflow run until completion or explicit cancellation. */
  wallClockTimeoutMs?: number
  cancellationGraceMs: number
}

export type WorkflowResolver = (
  target: WorkerWorkflowTarget,
  cwd: string,
) => Promise<LoadedWorkflow>

export type PreparedWorkingDirectory = {
  path: string
  /** Stable host-owned lease identity, when the workspace manager persists leases. */
  leaseId?: string
  /** True when this logical workspace survived an earlier attempt or process. */
  reused?: boolean
  cleanup?(input?: { signal: AbortSignal }): Promise<void | { preservedPath: string }>
}

export type WorkingDirectoryPreparer = (input: {
  baseDirectory: string
  isolation: string
  runId: string
  agentId: string
  /** Stable across attempts and resumed runs for the same logical journal call. */
  workspaceId: string
  /** Root run identity shared by every automatic/manual recovery descendant. */
  lineageId: string
  /** Git/process work must honor this signal so preparation cannot strand an unattended run. */
  signal: AbortSignal
}) => Promise<PreparedWorkingDirectory>

export type RunWorkflowOptions = {
  /** A service may allocate and persist identity before starting the evaluator. */
  runId?: string
  workflow: LoadedWorkflow
  args?: unknown
  cwd: string
  provider: AgentProvider
  limits?: Partial<WorkflowLimits>
  budgetTokens?: number | null
  journal?: WorkflowJournal
  /** Automatic exact-source recovery may reuse completed siblings beyond one interrupted call. */
  journalReuseMode?: JournalReuseMode
  /** Automatic recovery preserves terminal coverage gaps; manual resume deliberately retries them. */
  reuseCoverageGaps?: boolean
  resolveWorkflow?: WorkflowResolver
  resolveAgentType?(name: string): Promise<string | undefined>
  prepareWorkingDirectory?: WorkingDirectoryPreparer
  /** Shared service scheduler. Omit for a run-local scheduler at limits.concurrency. */
  scheduler?: AgentScheduler
  /** Shared provider-outage gate. Omit for a run-local circuit breaker. */
  circuitBreaker?: ProviderCircuitBreaker
  reliability?: Partial<WorkflowReliabilityPolicy>
  /** Stable recovery lineage; defaults to this run ID. */
  lineageId?: string
  defaultModel?: string
  /** Host-owned portable-name mapping; null selects the provider's configured default model. */
  modelAliases?: Readonly<Record<string, string | null>>
  defaultEffort?: string
  sandbox?: Partial<AgentSandboxPolicy>
  eventSink?: WorkflowEventSink
  /**
   * Persist the canonical final representation before its completion locator is published.
   * Low-level callers may omit this; WorkflowService always delegates it to the run store.
   */
  materializeResult?(
    result: WorkflowResultMaterialization,
  ): Promise<ContentReference>
  /**
   * Persist ONE agent's terminal value before its agent.completed locator is published.
   *
   * Separate from materializeResult because the failure contract is opposite. A run result that
   * cannot be persisted must fail the run — a completed run promises readable bytes. An agent
   * result that cannot be persisted must NOT fail the agent: it is observability, the agent
   * genuinely succeeded, and the value is already safe in the journal, which is what serves the
   * read when this is absent. The runner therefore swallows every rejection here.
   */
  materializeAgentResult?(
    agentId: string,
    result: WorkflowResultMaterialization,
  ): Promise<ContentReference>
  /**
   * Retain direct-API event replay for iterators attached after publication. Services with a
   * durable eventSink should disable this to avoid holding a second unbounded activity history.
   */
  retainEventHistory?: boolean
  signal?: AbortSignal
  workerLauncher?: WorkflowWorkerLauncher
  workerFilePath?: string
}

export type WorkflowRun = {
  id: string
  events: AsyncIterable<WorkflowEvent>
  result: Promise<unknown>
  cancel(reason?: string): Promise<void>
  /** Host lifecycle interruption is recoverable evidence, not a user cancellation. */
  interrupt(reason?: string): Promise<void>
  /** False while an adapter execution survived every cooperative and hard-stop deadline. */
  ownershipReleaseSafe?(): boolean
  /** Settles only after every already-quarantined adapter execution has actually stopped. */
  waitForOwnershipRelease?(): Promise<void>
  /**
   * Explicitly retire process-lifetime fences for provider descendants whose termination cannot
   * be proven. Hosts must expose this only behind an operator acknowledgement and a non-mutating
   * sandbox policy; it is not evidence that the abandoned descendants stopped.
   */
  abandonUnconfirmedProviderExecutions?(): number
}

export class WorkflowCancelledError extends Error {
  constructor(message = 'Workflow cancelled') {
    super(message)
    this.name = 'AbortError'
  }
}

export class WorkflowInterruptedError extends Error {
  constructor(message = 'Workflow host interrupted execution') {
    super(message)
    this.name = 'WorkflowInterruptedError'
  }
}

export class WorkflowExecutionError extends Error {
  readonly code: string

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'WorkflowExecutionError'
    this.code = code
  }
}

class AgentAssignmentFailure extends Error {
  readonly code: string

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'AgentAssignmentFailure'
    this.code = code
  }
}

class UnconfirmedProviderTerminationError extends Error {
  readonly execution: Promise<unknown>
  readonly reason: 'timeout' | 'cancellation'

  constructor(
    message: string,
    execution: Promise<unknown>,
    reason: 'timeout' | 'cancellation',
    options?: { cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'UnconfirmedProviderTerminationError'
    this.execution = execution
    this.reason = reason
  }
}

/**
 * The error name and message are part of the portable workflow contract, not cosmetics. Claude
 * 2.1.210 throws `WorkflowBudgetExceededError` from `agent()` admission, and its realm helpers
 * (`parallel`/`pipeline`) match that exact name to turn exceeded slots into null results with one
 * aggregate log line. A workflow written against Claude may therefore catch by `error.name`, so a
 * different name here would silently change control flow of an unmodified file.
 */
export class WorkflowBudgetExceededError extends Error {
  constructor(spent: number, total: number) {
    super(
      `Workflow token budget exceeded (${spent.toLocaleString()} / ${total.toLocaleString()} output tokens). ` +
        'Stopping further agent() calls. In-flight agents will complete; their results are preserved.',
    )
    this.name = 'WorkflowBudgetExceededError'
  }
}

const DEFAULT_LIMITS: WorkflowLimits = {
  // WHY this is a product-level constant rather than derived from logical CPUs: one agent is mostly
  // waiting on provider/network work, so a CPU heuristic held capable machines to four without
  // protecting the actual constrained resource. Nine is the Agent Code operating point: enough
  // fan-out for broad workflows to make progress while keeping native CLI/process pressure bounded.
  // Explicit `limits.concurrency` and WORKFLOW_MCP_CONCURRENCY still override this when a caller has
  // a workload-specific reason to choose differently.
  concurrency: 9,
  maxAgentCalls: 1_000,
  maxCollectionItems: 4_096,
  maxLogCharacters: 10_000,
  maxValueDepth: 64,
  maxValueNodes: 100_000,
  synchronousTimeoutMs: 30_000,
  // WHY there is no default wall-clock deadline: workflows are durable orchestration, and useful
  // runs can legitimately wait on providers, retries, user intervention, or large agent trees for
  // longer than an hour. A process-local timer cannot distinguish that healthy work from a stuck
  // run and used to cancel resumable work at exactly 3,600,000 ms. Run lifetime is therefore owned
  // by completion or explicit cancellation. Embedders that truly have a finite service deadline
  // can still opt into one through `limits.wallClockTimeoutMs`.
  cancellationGraceMs: 500,
}

const DEFAULT_SANDBOX: AgentSandboxPolicy = {
  mode: 'workspace-write',
  approvalPolicy: 'never',
  network: false,
}

// `max` is part of Claude's public Workflow source language. `minimal` remains accepted as a
// provider-portability extension because older workflow-mcp definitions already used it; rejecting
// those files would add incompatibility without making a Claude-authored file any safer.
const VALID_EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
const BLOCKED_VALUE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

type WorkflowEventDraft = WorkflowEvent extends infer Event
  ? Event extends WorkflowEvent
    ? Omit<Event, 'schemaVersion' | 'runId' | 'sequence' | 'eventId' | 'timestamp'>
    : never
  : never

type Deferred<Value> = {
  promise: Promise<Value>
  resolve(value: Value): void
  reject(error: unknown): void
}

type AgentAdmission = {
  requestId: string
  worker: WorkflowWorkerHandle
  agentId: string
  phaseId?: string
  prompt: string
  options: WorkerAgentOptions
  normalizedOptions: NormalizedAgentOptions
  journalMiss: JournalMiss
  journalRun: WorkflowJournalRun
  validateOutput?: ValidateFunction
  depth: number
}

type PhaseRuntimeState = {
  title: string
  entered: boolean
  sealed: boolean
  activeAgents: number
  terminal: boolean
}

function deferred<Value>(): Deferred<Value> {
  let resolvePromise!: (value: Value) => void
  let rejectPromise!: (error: unknown) => void
  const promise = new Promise<Value>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return { promise, resolve: resolvePromise, reject: rejectPromise }
}

class WorkflowEventStream implements AsyncIterable<WorkflowEvent> {
  readonly #subscribers = new Set<{
    queue: WorkflowEvent[]
    wake: (() => void) | undefined
  }>()
  readonly #history: WorkflowEvent[] | undefined
  #closed = false

  constructor(retainHistory: boolean) {
    this.#history = retainHistory ? [] : undefined
  }

  publish(event: WorkflowEvent): void {
    if (this.#closed) return
    this.#history?.push(event)
    for (const subscriber of this.#subscribers) {
      subscriber.queue.push(event)
      subscriber.wake?.()
      subscriber.wake = undefined
    }
  }

  close(): void {
    this.#closed = true
    for (const subscriber of this.#subscribers) {
      subscriber.wake?.()
      subscriber.wake = undefined
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<WorkflowEvent> {
    // WHY replay is selectable rather than silently removed: direct runWorkflow consumers have
    // historically been allowed to attach after awaiting result, while WorkflowService persists a
    // canonical replay and never consumes this convenience stream. The service opts out below so
    // FAT runs do not retain two full activity histories; standalone callers keep compatibility.
    const subscriber: { queue: WorkflowEvent[]; wake: (() => void) | undefined } = {
      queue: [...(this.#history ?? [])],
      wake: undefined,
    }
    this.#subscribers.add(subscriber)
    const remove = (): void => {
      this.#subscribers.delete(subscriber)
      subscriber.queue.length = 0
      subscriber.wake?.()
      subscriber.wake = undefined
    }
    return {
      next: async (): Promise<IteratorResult<WorkflowEvent>> => {
        while (subscriber.queue.length === 0 && !this.#closed) {
          await new Promise<void>((resolveWait) => { subscriber.wake = resolveWait })
        }
        const event = subscriber.queue.shift()
        if (event !== undefined) {
          return { done: false, value: event }
        }
        remove()
        return { done: true, value: undefined }
      },
      return: async (): Promise<IteratorResult<WorkflowEvent>> => {
        remove()
        return { done: true, value: undefined }
      },
    }
  }
}

class WorkflowRuntime {
  readonly id: string
  readonly #options: RunWorkflowOptions
  readonly #limits: WorkflowLimits
  readonly #sandbox: AgentSandboxPolicy
  readonly #stream: WorkflowEventStream
  readonly #result = deferred<unknown>()
  readonly #controller = new AbortController()
  /** Global service capacity, or the run scheduler itself for standalone execution. */
  readonly #scheduler: AgentScheduler
  /** Per-run ceiling; a shared service scheduler must never erase a smaller workflow limit. */
  readonly #runScheduler: AgentScheduler
  readonly #preparationScheduler: AgentScheduler
  readonly #cleanupScheduler: AgentScheduler
  readonly #reliability: WorkflowReliabilityPolicy
  readonly #circuitBreaker: ProviderCircuitBreaker
  readonly #journal: WorkflowJournal
  readonly #journalRun: WorkflowJournalRun
  readonly #ajv = new Ajv({ allErrors: true, strict: false })
  readonly #workers = new Set<WorkflowWorkerHandle>()
  readonly #tasks = new Set<Promise<void>>()
  readonly #phaseByTitle = new Map<string, string>()
  readonly #phaseRuntime = new Map<string, PhaseRuntimeState>()
  readonly #agentPhase = new Map<string, string>()
  readonly #terminalAgents = new Set<string>()
  readonly #childCounts = new Map<string, number>()
  readonly #pendingWorkerRequests = new Map<WorkflowWorkerHandle, Set<string>>()
  readonly #quarantinedExecutions = new Set<Promise<unknown>>()
  readonly #abandonableProviderQuarantines = new Set<() => void>()
  readonly #warnedModelAliases = new Set<string>()
  #warnedBudgetExceeded = false
  #eventSequence = 0
  #phaseSequence = 0
  #agentSequence = 0
  #budgetSpent = 0
  #terminal = false
  #failing = false
  #terminalOwner: 'completion' | 'failure' | 'cancellation' | 'interruption' | undefined
  #emitTail: Promise<void> = Promise.resolve()
  #cancelPromise: Promise<void> | undefined
  #interruptPromise: Promise<void> | undefined
  #wallClockTimer: NodeJS.Timeout | undefined
  #underutilizationTimer: NodeJS.Timeout | undefined
  #lastUnderutilizationSignature: string | undefined
  #retryAttemptsScheduled = 0
  #completedWithErrors = false
  #storageFailure: WorkflowExecutionError | undefined

  constructor(options: RunWorkflowOptions) {
    this.id = options.runId ?? `run_${randomUUID()}`
    this.#options = options
    this.#stream = new WorkflowEventStream(options.retainEventHistory ?? true)
    this.#limits = normalizeLimits(options.limits)
    // Large Claude workflows legitimately park more than Node's default ten cancellation
    // listeners on one run signal (semaphore waiters, providers, and timers). Bound the diagnostic
    // threshold by the already-enforced admission limit so Node 20 does not report a false leak
    // while still warning if listener growth somehow exceeds the maximum logical work of the run.
    setMaxListeners(this.#limits.maxAgentCalls + 10, this.#controller.signal)
    validateBudget(options.budgetTokens)
    this.#sandbox = normalizeSandbox(options.sandbox)
    this.#reliability = normalizeReliabilityPolicy(options.reliability)
    this.#circuitBreaker = options.circuitBreaker ?? new ProviderCircuitBreaker(this.#reliability)
    this.#scheduler = options.scheduler ?? new WorkConservingScheduler(this.#limits.concurrency)
    this.#runScheduler = options.scheduler === undefined
      ? this.#scheduler
      : new WorkConservingScheduler(
          this.#limits.concurrency,
          (snapshot) => this.#observeScheduler(snapshot),
        )
    this.#preparationScheduler = new WorkConservingScheduler(this.#reliability.preparationConcurrency)
    this.#cleanupScheduler = new WorkConservingScheduler(this.#reliability.cleanupConcurrency)
    const journal = options.journal ?? new InMemoryWorkflowJournal()
    this.#journal = journal
    this.#journalRun = journal.beginRun({
      workflowId: workflowIdentity(options.workflow),
      sourceHash: options.workflow.sourceHash,
    }, {
      reuseMode: options.journalReuseMode ?? 'longest-prefix',
      reuseCoverageGaps: options.reuseCoverageGaps ?? false,
    })

    const externalSignal = options.signal
    if (externalSignal) {
      if (externalSignal.aborted) {
        this.#controller.abort(new WorkflowCancelledError(abortReason(externalSignal)))
      } else {
        externalSignal.addEventListener(
          'abort',
          () => void this.cancel(abortReason(externalSignal)),
          { once: true },
        )
      }
    }
  }

  publicHandle(): WorkflowRun {
    return {
      id: this.id,
      events: this.#stream,
      result: this.#result.promise,
      cancel: (reason?: string) => this.cancel(reason),
      interrupt: (reason?: string) => this.interrupt(reason),
      ownershipReleaseSafe: () => (
        this.#quarantinedExecutions.size === 0 && this.#tasks.size === 0
      ),
      waitForOwnershipRelease: async () => {
        // Cancellation has already prevented new workflow admissions before the service calls this.
        // A still-running supervisor can move its provider promise from #tasks into quarantine, so
        // wait for stable emptiness rather than trusting one snapshot between those two states.
        while (this.#tasks.size > 0 || this.#quarantinedExecutions.size > 0) {
          await Promise.allSettled([...this.#tasks, ...this.#quarantinedExecutions])
        }
      },
      abandonUnconfirmedProviderExecutions: () => {
        const releases = [...this.#abandonableProviderQuarantines]
        for (const release of releases) release()
        return releases.length
      },
    }
  }

  start(): void {
    void this.#run()
  }

  async cancel(reason = 'Workflow cancelled'): Promise<void> {
    if (this.#terminal) return
    if (this.#cancelPromise) return this.#cancelPromise
    this.#cancelPromise = this.#terminate(reason, 'cancellation')
    return this.#cancelPromise
  }

  async interrupt(reason = 'Workflow host interrupted execution'): Promise<void> {
    if (this.#terminal) return
    if (this.#interruptPromise) return this.#interruptPromise
    this.#interruptPromise = this.#terminate(reason, 'interruption')
    return this.#interruptPromise
  }

  async #run(): Promise<void> {
    try {
      await this.#emit({
        type: 'run.started',
        payload: {
          workflow: {
            name: this.#options.workflow.meta.name,
            description: this.#options.workflow.meta.description,
            sourceHash: this.#options.workflow.sourceHash,
            ...(this.#options.workflow.meta.title === undefined
              ? {}
              : { title: this.#options.workflow.meta.title }),
            ...(this.#options.workflow.filePath === undefined
              ? {}
              : { filePath: this.#options.workflow.filePath }),
          },
        },
      })

      for (const phase of this.#options.workflow.meta.phases ?? []) {
        await this.#ensurePhase(phase.title, 'metadata', phase)
      }

      if (this.#controller.signal.aborted) {
        await this.cancel(abortReason(this.#controller.signal))
        return
      }

      const wallClockTimeoutMs = this.#limits.wallClockTimeoutMs
      if (wallClockTimeoutMs !== undefined) {
        this.#wallClockTimer = setTimeout(() => {
          void this.cancel(`Workflow exceeded ${wallClockTimeoutMs}ms wall-clock limit`)
        }, wallClockTimeoutMs)
      }

      const result = await this.#executeWorker({
        workflow: this.#options.workflow,
        args: this.#options.args,
        depth: 0,
        journalRun: this.#journalRun,
      })
      // `agent()` and nested `workflow()` calls are run-owned even when workflow JavaScript drops
      // their promises. Completing while those tasks are live leaks provider processes and lets
      // late events appear after run.completed. Drain a stable snapshot until no task remains.
      await this.#drainTasks()
      if (this.#controller.signal.aborted || this.#terminal) return
      const materialization = workflowResultMaterialization(result, this.#limits)
      const resultReference = this.#options.materializeResult === undefined
        ? materialization.reference
        : await this.#options.materializeResult(materialization)
      if (this.#controller.signal.aborted || this.#terminal) return
      if (resultReference.artifactId !== undefined) {
        // The durable bytes already exist when this discovery event is emitted. Publishing a
        // generic artifact record before the terminal event keeps existing artifact projections
        // useful while run.completed remains the direct, backwards-compatible result locator.
        await this.#emit({
          type: 'artifact.created',
          payload: {
            artifactId: resultReference.artifactId,
            name: resultReference.mediaType === 'application/json'
              ? 'workflow-result.json'
              : 'workflow-result.txt',
            ...(resultReference.mediaType === undefined
              ? {}
              : { mediaType: resultReference.mediaType }),
            ...(resultReference.sizeBytes === undefined
              ? {}
              : { sizeBytes: resultReference.sizeBytes }),
          },
        })
      }
      if (this.#controller.signal.aborted || this.#terminal) return
      if (!this.#claimTerminal('completion')) return

      await this.#emit({
        type: 'run.completed',
        payload: {
          result: resultReference,
          ...(this.#completedWithErrors ? { withErrors: true } : {}),
        },
      })
      this.#terminal = true
      this.#clearWallClockTimer()
      this.#result.resolve(result)
      this.#stream.close()
    } catch (error) {
      if (this.#terminalOwner === 'completion') {
        // A terminal sink failure occurs after completion won the race, so publishing a competing
        // run.failed record would violate the one-terminal-event invariant. The public result must
        // still settle instead of hanging forever.
        this.#terminal = true
        this.#clearWallClockTimer()
        this.#result.reject(error)
        this.#stream.close()
        return
      }
      if (this.#controller.signal.aborted && !this.#failing) {
        if (!this.#cancelPromise && !this.#interruptPromise) {
          await this.cancel(abortReason(this.#controller.signal)).catch(() => undefined)
        }
        return
      }
      if (this.#failing) return
      // #fail settles the public result in its terminal finally block. A storage failure can make
      // the diagnostic run.failed append reject afterward; swallowing only that supervisor promise
      // prevents the fire-and-forget #run task from becoming an unhandled rejection.
      await this.#fail(error).catch(() => undefined)
    }
  }

  async #terminate(
    reason: string,
    mode: 'cancellation' | 'interruption',
  ): Promise<void> {
    if (this.#terminal) return
    if (!this.#claimTerminal(mode)) return

    const terminalError = mode === 'cancellation'
      ? new WorkflowCancelledError(reason)
      : new WorkflowInterruptedError(reason)

    // Abort first. Event sinks are external code and may be slow or wedged; they must never delay
    // stopping credentialed provider work after the user or wall-clock limit requested cancel.
    if (!this.#controller.signal.aborted) {
      this.#controller.abort(terminalError)
    }
    this.#clearWallClockTimer()
    for (const worker of this.#workers) this.#sendBestEffort(worker, { type: 'cancel', reason })

    // Diagnostic persistence has its own finite deadline, but process shutdown should not spend
    // even that budget before escalation begins. The serialized emit tail preserves ordering if
    // storage recovers; the storage-degraded fence closes admission if it does not.
    if (mode === 'cancellation') {
      void this.#emit({
        type: 'run.cancellation_requested',
        payload: reason.length === 0 ? {} : { reason },
      }).catch(() => undefined)
    }

    await Promise.race([
      Promise.allSettled([...this.#tasks]),
      delay(this.#limits.cancellationGraceMs),
    ])
    try {
      await this.#killWorkers()
    } catch {
      // Worker lifecycle adapters are not allowed to veto terminal settlement. Provider attempts
      // already received the run abort; store ownership separately remains fenced while any real
      // tracked execution is unresolved.
    }

    // WHY shutdown waits for the supervisor's complete escalation budget after killing the
    // evaluator: run.cancel() is also the service's ownership handoff barrier. Releasing the store
    // lease while an ignored provider abort can still publish an agent event allows a replacement
    // service to recover the same run concurrently. The bound includes hard termination and
    // cleanup, so shutdown remains finite even for a hostile adapter or Git hook.
    await Promise.race([
      Promise.allSettled([...this.#tasks]),
      delay(
        (2 * this.#reliability.hardTerminationGraceMs) +
        this.#reliability.cleanupTimeoutMs +
        100,
      ),
    ])

    try {
      await this.#failOpenPhases(terminalError)
    } catch {
      // A storage-degraded run may be unable to persist phase diagnostics. Terminal settlement and
      // process cleanup remain mandatory even when those explanatory events cannot be appended.
    }

    try {
      await this.#emit(mode === 'cancellation'
        ? {
            type: 'run.cancelled',
            payload: reason.length === 0 ? {} : { reason },
          }
        : {
            type: 'run.interrupted',
            payload: { reason },
          })
    } finally {
      this.#terminal = true
      this.#result.reject(terminalError)
      this.#stream.close()
    }
  }

  async #fail(error: unknown): Promise<void> {
    if (this.#terminal || this.#failing) return
    if (!this.#claimTerminal('failure')) return
    // WHY this flag is set before the first await: killing the worker causes #executeWorker to
    // reject immediately. Without a synchronous failure owner, #run can misread the abort signal
    // as user cancellation and publish run.cancelled while this path is publishing run.failed.
    this.#failing = true
    if (!this.#controller.signal.aborted) this.#controller.abort(error)
    this.#clearWallClockTimer()
    for (const worker of this.#workers) {
      this.#sendBestEffort(worker, { type: 'cancel', reason: 'Workflow failed' })
    }
    // Cooperative providers should publish their agent terminal event before run.failed closes the
    // stream. The bound also covers the rare case where this failure originated inside a tracked
    // task and waiting for every task would otherwise include the caller itself.
    await Promise.race([
      Promise.allSettled([...this.#tasks]),
      delay(this.#limits.cancellationGraceMs),
    ])
    try {
      await this.#killWorkers()
    } catch {
      // See cancellation: adapter notification failure must not strand the public run promise.
    }
    // Failure can originate in the evaluator while provider attempts are still live. The first
    // grace only gives cooperative abort a chance; it is not long enough for the attempt-addressed
    // termination hook and worktree cleanup. Publishing run.failed before that escalation finishes
    // would let callers start replacement work while an old process may still be mutating the same
    // workspace. This mirrors cancellation's bounded ownership-handoff barrier.
    await Promise.race([
      Promise.allSettled([...this.#tasks]),
      delay(
        (2 * this.#reliability.hardTerminationGraceMs) +
        this.#reliability.cleanupTimeoutMs +
        100,
      ),
    ])
    const reference = errorReference(error)

    try {
      await this.#failOpenPhases(error)
    } catch {
      // The original failure remains authoritative when persistence is already degraded.
    }

    try {
      await this.#emit({ type: 'run.failed', payload: { error: reference } })
    } finally {
      this.#terminal = true
      this.#result.reject(
        error instanceof Error
          ? error
          : new WorkflowExecutionError('workflow-failed', reference.message),
      )
      this.#stream.close()
    }
  }

  #clearWallClockTimer(): void {
    if (this.#wallClockTimer) clearTimeout(this.#wallClockTimer)
    this.#wallClockTimer = undefined
    if (this.#underutilizationTimer) clearTimeout(this.#underutilizationTimer)
    this.#underutilizationTimer = undefined
    this.#lastUnderutilizationSignature = undefined
  }

  #claimTerminal(owner: 'completion' | 'failure' | 'cancellation' | 'interruption'): boolean {
    if (this.#terminalOwner !== undefined) return false
    this.#terminalOwner = owner
    return true
  }

  async #drainTasks(): Promise<void> {
    while (this.#tasks.size > 0) {
      await Promise.allSettled([...this.#tasks])
    }
  }

  async #killWorkers(): Promise<void> {
    const workers = [...this.#workers]
    await Promise.all(workers.map(async (worker) => {
      if (!worker.isRunning()) return
      const exited = new Promise<void>((resolveExit) => worker.onExit(() => resolveExit()))
      worker.terminate()
      // SIGKILL is authoritative on supported local hosts, but a short bound keeps cancellation
      // from hanging forever if a mocked ChildProcess violates Node's lifecycle contract.
      await Promise.race([exited, delay(this.#limits.cancellationGraceMs)])
    }))
    this.#workers.clear()
  }

  #emit(draft: WorkflowEventDraft): Promise<void> {
    const operation = this.#emitTail.then(async () => {
      if (this.#terminal) return
      await this.#publishDraft(draft)
      if (
        draft.type === 'agent.reused' ||
        draft.type === 'agent.completed' ||
        (draft.type === 'agent.failed' && draft.payload.retrying !== true) ||
        draft.type === 'agent.recovery_required' ||
        draft.type === 'agent.skipped' ||
        draft.type === 'agent.cancelled'
      ) {
        await this.#recordAgentTerminal(draft.agentId)
      }
    })
    // A failed sink rejects the caller that produced the event, but later failure/cancellation
    // events still need an ordering chain instead of inheriting the first rejection forever.
    this.#emitTail = operation.catch(() => undefined)
    return operation
  }

  async #publishDraft(draft: WorkflowEventDraft): Promise<void> {
    if (this.#storageFailure !== undefined) throw this.#storageFailure
    this.#eventSequence += 1
    const event = {
      ...draft,
      schemaVersion: 1,
      runId: this.id,
      sequence: this.#eventSequence,
      eventId: `event_${randomUUID()}`,
      timestamp: new Date().toISOString(),
    } as WorkflowEvent
    try {
      if (this.#options.eventSink !== undefined) {
        await withDeadline(
          Promise.resolve(this.#options.eventSink(event)),
          this.#reliability.eventSinkTimeoutMs,
          `Workflow event persistence exceeded ${this.#reliability.eventSinkTimeoutMs}ms`,
        )
      }
    } catch (cause) {
      // WHY a timed-out append closes admission instead of letting later sequence numbers race it:
      // the original fsync may still finish. Starting another append would create two writers to
      // one logical cursor and make durable replay ambiguous. Cleanup is allowed to continue, but
      // every subsequent publication fails immediately until startup recovery reconciles the last
      // acknowledged record.
      this.#storageFailure ??= new WorkflowExecutionError(
        'workflow-storage-degraded',
        `Workflow event persistence failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      )
      throw this.#storageFailure
    }
    this.#stream.publish(event)
  }

  async #ensurePhase(
    title: string,
    source: 'metadata' | 'runtime',
    metadata?: { detail?: string; model?: string },
  ): Promise<string> {
    const existing = this.#phaseByTitle.get(title)
    if (existing) return existing
    this.#phaseSequence += 1
    const phaseId = `phase_${this.#phaseSequence}`
    this.#phaseByTitle.set(title, phaseId)
    this.#phaseRuntime.set(phaseId, {
      title,
      entered: false,
      sealed: false,
      activeAgents: 0,
      terminal: false,
    })
    await this.#emit({
      type: 'phase.discovered',
      phaseId,
      payload: {
        title,
        source,
        ...(metadata?.detail === undefined ? {} : { detail: metadata.detail }),
        ...(metadata?.model === undefined ? {} : { model: metadata.model }),
      },
    })

    return phaseId
  }

  async #executeWorker(input: {
    workflow: LoadedWorkflow
    args?: unknown
    depth: number
    journalRun: WorkflowJournalRun
    forcedPhaseId?: string
    logPrefix?: string
  }): Promise<unknown> {
    if (this.#controller.signal.aborted) {
      throw new WorkflowCancelledError(abortReason(this.#controller.signal))
    }
    const launcher = this.#options.workerLauncher ?? new NodeWorkflowWorkerLauncher()
    const worker = launcher.launch({
      workerFilePath: this.#options.workerFilePath ?? workerFilePath(),
      env: minimalWorkerEnvironment(),
    })
    this.#workers.add(worker)

    let currentPhaseId = input.forcedPhaseId
    let stderr = ''
    let settled = false
    let ready = false
    let launchedAt = Date.now()
    let lastHeartbeatAt = launchedAt
    let lastWatchdogAt = launchedAt
    let idleSince: number | undefined
    let messageTail: Promise<void> = Promise.resolve()
    const outcome = deferred<unknown>()

    worker.stderr?.setEncoding('utf8')
    worker.stderr?.on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-65_536)
    })

    const settleResolve = (value: unknown): void => {
      if (settled) return
      const cloned = cloneBoundaryValue(value, this.#limits)
      settled = true
      outcome.resolve(cloned)
    }
    const settleReject = (error: unknown): void => {
      if (settled) return
      settled = true
      outcome.reject(error)
    }

    const watchdogIntervalMs = Math.max(10, Math.min(
      1_000,
      Math.floor(Math.min(
        this.#reliability.workerStartupTimeoutMs,
        this.#reliability.workerHeartbeatTimeoutMs,
        this.#reliability.workerIdleTimeoutMs,
      ) / 4),
    ))
    const watchdog = setInterval(() => {
      if (settled) return
      const now = Date.now()
      const watchdogGapMs = now - lastWatchdogAt
      lastWatchdogAt = now
      if (watchdogGapMs > Math.max(5_000, watchdogIntervalMs * 5)) {
        // The parent timer pauses during macOS sleep and can also be delayed by a suspended
        // Electron utility process. Charging that wall-clock gap to the worker causes the first
        // watchdog tick after wake to kill a healthy evaluator before its own queued heartbeat can
        // run. Give startup, heartbeat, and idle detection one fresh policy window; a genuinely
        // dead worker will still fail normally if it remains silent after wake.
        launchedAt = now
        lastHeartbeatAt = now
        if (idleSince !== undefined) idleSince = now
        return
      }
      if (!ready && now - launchedAt >= this.#reliability.workerStartupTimeoutMs) {
        settleReject(new WorkflowExecutionError(
          'workflow-worker-startup-timeout',
          'Workflow evaluator did not become ready before its startup deadline',
        ))
        return
      }
      if (ready && now - lastHeartbeatAt >= this.#reliability.workerHeartbeatTimeoutMs) {
        settleReject(new WorkflowExecutionError(
          'workflow-worker-heartbeat-timeout',
          'Workflow evaluator stopped reporting health before its heartbeat deadline',
        ))
        return
      }
      if (idleSince !== undefined && now - idleSince >= this.#reliability.workerIdleTimeoutMs) {
        settleReject(new WorkflowExecutionError(
          'workflow-worker-idle',
          'Workflow evaluator is unresolved but has no pending capability call or timer',
        ))
      }
    }, watchdogIntervalMs)
    watchdog.unref?.()

    const removeMessageListener = worker.onMessage((raw: WorkerToParentMessage) => {
      // Message receipt is recorded before ordered async processing. A slow durable event sink must
      // not make a responsive evaluator look dead merely because its earlier log is awaiting disk.
      lastHeartbeatAt = Date.now()
      if (raw.type !== 'heartbeat') idleSince = undefined
      messageTail = messageTail
        .then(async () => {
          if (raw.type === 'ready') {
            if (ready) throw new WorkflowExecutionError('worker-protocol', 'Worker sent ready twice')
            ready = true
            const argsJson = encodeWorkflowArgs(input.args, this.#limits)
            this.#send(worker, {
              type: 'start',
              runId: this.id,
              body: input.workflow.body,
              ...(input.workflow.filePath === undefined ? {} : { filePath: input.workflow.filePath }),
              ...(argsJson === undefined ? {} : { argsJson }),
              budgetTotal: this.#options.budgetTokens ?? null,
              budgetSpent: this.#budgetSpent,
              metadataPhases: input.depth === 0
                ? (input.workflow.meta.phases ?? []).map((phase) => phase.title)
                : [],
              // Keep at least three theoretical ticks inside the parent deadline. The 5s constant
              // remains the normal cadence, while deliberately short test/host policies receive a
              // proportionally faster worker instead of a watchdog that is impossible to satisfy.
              heartbeatIntervalMs: Math.max(10, Math.min(
                WORKFLOW_WORKER_HEARTBEAT_INTERVAL_MS,
                Math.floor(this.#reliability.workerHeartbeatTimeoutMs / 3),
              )),
              limits: workerLimits(this.#limits),
            })
            return
          }

          if (raw.type === 'heartbeat') {
            if (!ready) throw new WorkflowExecutionError('worker-protocol', 'Worker heartbeat arrived before ready')
            if (raw.pendingRequests === 0 && raw.timers === 0) idleSince ??= Date.now()
            else idleSince = undefined
            return
          }

          if (raw.type === 'phase') {
            if (input.depth > 0) return
            const nextPhaseId = await this.#ensurePhase(raw.title, 'runtime')
            if (currentPhaseId !== nextPhaseId) {
              if (currentPhaseId !== undefined) await this.#sealPhase(currentPhaseId)
              currentPhaseId = nextPhaseId
              const phase = this.#phaseRuntime.get(currentPhaseId)
              if (phase && !phase.entered) {
                phase.entered = true
                await this.#emit({
                  type: 'phase.entered',
                  phaseId: currentPhaseId,
                  payload: { title: raw.title },
                })
              }
            }
            return
          }

          if (raw.type === 'log') {
            const text = input.logPrefix ? `${input.logPrefix}${raw.text}` : raw.text
            await this.#emit({
              type: 'log',
              ...(currentPhaseId === undefined ? {} : { phaseId: currentPhaseId }),
              payload: {
                message: contentReference(text, this.#limits),
                level: raw.level === 'log' ? 'info' : raw.level,
              },
            })
            return
          }

          if (raw.type === 'agent.request') {
            await this.#acceptAgentRequest({
              worker,
              request: raw,
              depth: input.depth,
              journalRun: input.journalRun,
              ...(input.forcedPhaseId === undefined ? {} : { forcedPhaseId: input.forcedPhaseId }),
            })
            return
          }

          if (raw.type === 'workflow.request') {
            this.#markWorkerRequest(worker, raw.requestId)
            this.#trackTask(
              this.#executeNestedWorkflow(worker, raw, input.depth).catch((error: unknown) => {
                if (error instanceof WorkflowExecutionError && error.code === 'detached-capability') {
                  throw error
                }
                this.#completeWorkerRequest(worker, raw.requestId, {
                  type: 'workflow.result',
                  requestId: raw.requestId,
                  result: { type: 'error', error: serializeWorkerError(error) },
                  budgetSpent: this.#budgetSpent,
                })
              }),
            )
            return
          }

          if (raw.type === 'complete') {
            const pending = this.#pendingWorkerRequests.get(worker)
            if (pending && pending.size > 0) {
              settleReject(
                new WorkflowExecutionError(
                  'detached-capability',
                  `Workflow returned with ${pending.size} unawaited capability call(s)`,
                ),
              )
              return
            }
            if (currentPhaseId !== undefined) await this.#sealPhase(currentPhaseId)
            settleResolve(raw.value)
            return
          }
          settleReject(workerError(raw.error))
        })
        .catch(settleReject)
    })

    const removeErrorListener = worker.onError(settleReject)
    const removeExitListener = worker.onExit(({ code, signal }) => {
      this.#workers.delete(worker)
      // Node can deliver the terminal IPC message and process exit back-to-back. Processing that
      // message may now await durable phase events, so exit must drain the already-received message
      // tail before deciding that a clean worker exit lacked a terminal result.
      void messageTail.then(() => {
        if (settled) return
        if (this.#controller.signal.aborted) {
          settleReject(new WorkflowCancelledError(abortReason(this.#controller.signal)))
          return
        }
        const detail = signal ? `signal ${signal}` : `code ${code ?? 1}`
        settleReject(
          new WorkflowExecutionError(
            'worker-exit',
            `Workflow worker exited with ${detail}${stderr.length === 0 ? '' : `: ${stderr}`}`,
          ),
        )
      }).catch(settleReject)
    })

    try {
      return await outcome.promise
    } finally {
      clearInterval(watchdog)
      removeMessageListener()
      removeErrorListener()
      removeExitListener()
      this.#workers.delete(worker)
      this.#pendingWorkerRequests.delete(worker)
      if (worker.isRunning()) {
        const exited = new Promise<void>((resolveExit) => worker.onExit(() => resolveExit()))
        worker.terminate()
        await Promise.race([exited, delay(this.#limits.cancellationGraceMs)])
      }
    }
  }

  async #acceptAgentRequest(input: {
    worker: WorkflowWorkerHandle
    request: Extract<WorkerToParentMessage, { type: 'agent.request' }>
    depth: number
    journalRun: WorkflowJournalRun
    forcedPhaseId?: string
  }): Promise<void> {
    if (this.#controller.signal.aborted) {
      this.#replyAgentError(input.worker, input.request.requestId, new WorkflowCancelledError(abortReason(this.#controller.signal)))
      return
    }
    if (this.#agentSequence >= this.#limits.maxAgentCalls) {
      this.#replyAgentError(
        input.worker,
        input.request.requestId,
        new RangeError(`Workflow exceeds ${this.#limits.maxAgentCalls} agent calls`),
      )
      return
    }
    // WHY the budget gate sits before any identity allocation: Claude 2.1.210 checks the shared
    // output-token pool before computing the call index or journal key (`I(),P()` precede the v2
    // lookup in its agent() implementation). Refusing here means an exceeded call leaves no
    // phantom agent record and no started-only journal entry, and a `total <= 0` target disables
    // enforcement entirely — both observed Claude behaviors, not choices this runtime gets to make.
    const budgetTotal = this.#options.budgetTokens
    if (budgetTotal !== undefined && budgetTotal !== null && budgetTotal > 0 && this.#budgetSpent >= budgetTotal) {
      if (!this.#warnedBudgetExceeded) {
        this.#warnedBudgetExceeded = true
        await this.#emit({
          type: 'warning',
          payload: {
            code: 'workflow-budget-exceeded',
            message: `Workflow token budget exceeded (${this.#budgetSpent}/${budgetTotal} output tokens); further agent() calls throw`,
          },
        })
      }
      this.#replyAgentError(
        input.worker,
        input.request.requestId,
        new WorkflowBudgetExceededError(this.#budgetSpent, budgetTotal),
      )
      return
    }

    this.#agentSequence += 1
    const agentId = `agent_${this.#agentSequence}`
    let phaseId = input.forcedPhaseId
    if (phaseId === undefined && input.request.options.phase !== undefined) {
      phaseId = await this.#ensurePhase(input.request.options.phase, 'runtime')
    }
    if (this.#controller.signal.aborted) {
      this.#replyAgentError(input.worker, input.request.requestId, new WorkflowCancelledError(abortReason(this.#controller.signal)))
      return
    }

    const normalizedOptions = normalizeAgentOptions(
      input.request.options,
      this.#options,
      this.#sandbox,
      this.#limits,
    )
    const decision = input.journalRun.admit({
      agentId,
      prompt: input.request.prompt,
      // Claude's v2 journal hashes only options written in the workflow call. Runtime defaults
      // affect provider execution but injecting them here would break byte-compatible reuse keys.
      options: input.request.options,
    })

    if (phaseId !== undefined) {
      this.#agentPhase.set(agentId, phaseId)
      const phase = this.#phaseRuntime.get(phaseId)
      if (phase) phase.activeAgents += 1
    }

    await this.#emit({
      type: 'agent.admitted',
      agentId,
      ...(phaseId === undefined ? {} : { phaseId }),
      payload: {
        callIndex: this.#agentSequence - 1,
        label: input.request.options.label ?? fallbackLabel(input.request.prompt),
        prompt: contentReference(input.request.prompt, this.#limits),
        options: normalizedOptions,
        cacheKey: decision.key,
      },
    })

    const requestedModel = input.request.options.model
    if (
      requestedModel !== undefined &&
      this.#options.modelAliases !== undefined &&
      Object.prototype.hasOwnProperty.call(this.#options.modelAliases, requestedModel) &&
      !this.#warnedModelAliases.has(requestedModel)
    ) {
      this.#warnedModelAliases.add(requestedModel)
      const mapped = this.#options.modelAliases[requestedModel]
      await this.#emit({
        type: 'warning',
        agentId,
        ...(phaseId === undefined ? {} : { phaseId }),
        payload: {
          code: 'model-alias-mapped',
          message: mapped === null
            ? `Workflow model ${JSON.stringify(requestedModel)} uses the host provider's configured default`
            : `Workflow model ${JSON.stringify(requestedModel)} maps to ${JSON.stringify(mapped)}`,
          details: { requestedModel, mappedModel: mapped },
        },
      })
    }

    let validateOutput: ValidateFunction | undefined
    if (normalizedOptions.schema !== undefined) {
      try {
        if (
          typeof normalizedOptions.schema !== 'boolean' &&
          (typeof normalizedOptions.schema !== 'object' || normalizedOptions.schema === null)
        ) {
          throw new TypeError('JSON Schema must be an object or boolean')
        }
        validateOutput = this.#ajv.compile(normalizedOptions.schema as AnySchema)
      } catch (error) {
        const schemaError = new TypeError(
          `Invalid workflow agent schema: ${error instanceof Error ? error.message : String(error)}`,
        )
        await this.#emit({
          type: 'agent.failed',
          agentId,
          ...(phaseId === undefined ? {} : { phaseId }),
          payload: { error: errorReference(schemaError) },
        })
        this.#replyAgentError(input.worker, input.request.requestId, schemaError)
        return
      }
    }

    if (decision.reused) {
      const value = cloneBoundaryValue(decision.result, this.#limits)
      const reusedCoverageGap = decision.coverageGap === true
      let coverageGapDisposition
      if (reusedCoverageGap) {
        if (!isWorkflowAgentFailurePlaceholder(value)) {
          // The journal implementations reject this earlier. Keep a final runtime assertion because
          // WorkflowJournal is injectable and a custom adapter must not gain schema-bypass authority
          // merely by returning `coverageGap: true` beside arbitrary data.
          throw new Error('Workflow journal returned an invalid coverage-gap placeholder')
        }
        coverageGapDisposition = {
          status: value.__workflowAgentFailure.status,
          error: {
            message: value.__workflowAgentFailure.message,
            ...(value.__workflowAgentFailure.code === undefined
              ? {}
              : { code: value.__workflowAgentFailure.code }),
          },
        }
      }
      if (validateOutput && !reusedCoverageGap && !validateOutput(value)) {
        // WHY cached output is revalidated even though the schema participates in the journal key:
        // older releases accepted malformed structured output, and schemas can gain stricter
        // runtime behavior after an AJV upgrade. A cache hit is an optimization, not permission to
        // bypass the workflow's current output contract.
        const schemaError = new TypeError(
          `Reused agent output failed schema validation: ${this.#ajv.errorsText(validateOutput.errors)}`,
        )
        await this.#emit({
          type: 'agent.failed',
          agentId,
          ...(phaseId === undefined ? {} : { phaseId }),
          payload: { error: errorReference(schemaError) },
        })
        this.#replyAgentError(input.worker, input.request.requestId, schemaError)
        return
      }
      await this.#emit({
        type: 'agent.reused',
        agentId,
        ...(phaseId === undefined ? {} : { phaseId }),
        payload: {
          source: 'journal',
          result: contentReference(value, this.#limits),
          // A JSON scalar is still structured when the call declared a schema. Inferring this from
          // typeof(value) turns schema-backed strings/numbers into text after journal reuse.
          structured: normalizedOptions.schema !== undefined,
          ...(coverageGapDisposition === undefined
            ? {}
            : { coverageGap: coverageGapDisposition }),
        },
      })
      // WHY a coverage gap bypasses the declared provider-output schema: it is supervisor metadata,
      // not a forged provider success. Automatic crash recovery must pass the exact typed casualty
      // back to workflow JavaScript and final synthesis without rerunning an effect that policy
      // already declared unsafe. Manual resume does not set reuseCoverageGaps and therefore runs
      // the assignment again instead.
      if (reusedCoverageGap) this.#completedWithErrors = true
      this.#send(input.worker, {
        type: 'agent.result',
        requestId: input.request.requestId,
        result: {
          type: 'success',
          value,
          ...(reusedCoverageGap ? { coverageGap: true } : {}),
        },
        budgetSpent: this.#budgetSpent,
      })
      return
    }

    await this.#emit({
      type: 'agent.queued',
      agentId,
      ...(phaseId === undefined ? {} : { phaseId }),
      payload: {},
    })

    const admission: AgentAdmission = {
      requestId: input.request.requestId,
      worker: input.worker,
      agentId,
      ...(phaseId === undefined ? {} : { phaseId }),
      prompt: input.request.prompt,
      options: input.request.options,
      normalizedOptions,
      journalMiss: decision,
      journalRun: input.journalRun,
      ...(validateOutput === undefined ? {} : { validateOutput }),
      depth: input.depth,
    }
    this.#markWorkerRequest(input.worker, input.request.requestId)
    this.#trackTask(this.#executeAgent(admission))
  }

  async #executeAgent(admission: AgentAdmission): Promise<void> {
    let prepared: PreparedWorkingDirectory | undefined
    let preserveWorkspaceForRecovery = false
    let lastAttemptId: string | undefined
    let lastAttemptNumber = 0
    let lastAttemptOpen = false
    const unconfirmedRetryAbortListeners = new Set<() => void>()
    let providerSession = admission.journalMiss.providerSession?.provider === this.#options.provider.name
      ? admission.journalMiss.providerSession
      : undefined
    const workspaceId = stableWorkspaceId(
      workflowIdentity(this.#options.workflow),
      admission.journalMiss.key,
    )

    try {
      let workingDirectory = resolve(this.#options.cwd)
      if (admission.options.isolation === 'worktree') {
        if (!this.#options.prepareWorkingDirectory) {
          throw new AgentAssignmentFailure(
            'worktree-unavailable',
            'This workflow requests worktree isolation but no worktree preparer is configured',
          )
        }
        // WHY preparation has a separate bounded pool and happens before provider admission: git
        // worktree creation can be slow on a large repository, but it consumes no scarce model
        // turn. Holding one of nine provider permits while preparing disk state is the exact kind
        // of hidden capacity leak that makes a nominal nine-way workflow run at two or three.
        const preparationLease = await this.#preparationScheduler.acquire(this.#controller.signal)
        const preparationController = linkedTimeoutController(
          this.#controller.signal,
          this.#reliability.preparationTimeoutMs,
          'Working-directory preparation timed out',
        )
        const preparationAbort = abortRejection(preparationController.signal)
        let preparationSettled = false
        const preparation = Promise.resolve().then(() => this.#options.prepareWorkingDirectory!({
          baseDirectory: workingDirectory,
          isolation: 'worktree',
          runId: this.id,
          agentId: admission.agentId,
          workspaceId,
          lineageId: this.#options.lineageId ?? this.id,
          signal: preparationController.signal,
        }))
        const observedPreparation = preparation.then(
          (value) => { preparationSettled = true; return value },
          (error: unknown) => { preparationSettled = true; throw error },
        )
        try {
          try {
            prepared = await Promise.race([
              observedPreparation,
              preparationAbort.promise,
            ])
          } catch (cause) {
            if (this.#controller.signal.aborted) throw cause
            if (preparationController.signal.aborted) {
              throw new AgentAssignmentFailure(
                'worktree-preparation-timeout',
                `Working-directory preparation timed out: ${cause instanceof Error ? cause.message : String(cause)}`,
                { cause },
              )
            }
            // WHY arbitrary preparer failures remain supervisor-fatal: the host owns deterministic
            // recovery paths and repository identity. A collision/corruption exception is not a
            // disposable model attempt, and continuing sibling writers after it can compound the
            // damage. Missing capability and bounded timeout are explicitly classified above;
            // everything else fails closed until hosts expose a narrower typed availability error.
            throw cause
          }
        } finally {
          preparationAbort.dispose()
          preparationController.dispose()
          if (preparationSettled) {
            preparationLease.release()
          } else {
            // An abort signal is a request, not proof that git/worktree preparation stopped. Keep
            // its concurrency lease and service ownership quarantined until the real promise
            // settles. If it creates a workspace late, immediately reconcile it through cleanup so
            // a timed-out preparation cannot leak a hidden checkout forever.
            const lateDisposition = observedPreparation
              .then(async (latePrepared) => {
                if (latePrepared.cleanup) await this.#cleanupWorkingDirectory(latePrepared)
              })
              .finally(() => preparationLease.release())
            this.#quarantineSettlingOperation(lateDisposition)
          }
        }
        if (this.#controller.signal.aborted) throw new WorkflowCancelledError(abortReason(this.#controller.signal))
        workingDirectory = resolve(prepared.path)
        await this.#emit({
          type: 'agent.workspace.prepared',
          agentId: admission.agentId,
          ...(admission.phaseId === undefined ? {} : { phaseId: admission.phaseId }),
          payload: {
            workspaceId,
            path: workingDirectory,
            reused: prepared.reused ?? false,
            ...(prepared.leaseId === undefined ? {} : { leaseId: prepared.leaseId }),
          },
        })
      }

      let instructions: string | undefined
      if (admission.options.agentType !== undefined) {
        try {
          instructions = await this.#options.resolveAgentType?.(admission.options.agentType)
        } catch (cause) {
          if (this.#controller.signal.aborted) throw cause
          throw new AgentAssignmentFailure(
            'agent-type-resolution-failed',
            `Workflow agent type ${JSON.stringify(admission.options.agentType)} could not be resolved`,
            { cause },
          )
        }
        if (this.#controller.signal.aborted) throw new WorkflowCancelledError(abortReason(this.#controller.signal))
        if (instructions === undefined) {
          throw new AgentAssignmentFailure(
            'agent-type-unavailable',
            `Workflow agent type ${JSON.stringify(admission.options.agentType)} is unavailable`,
          )
        }
      }

      let recovery: AgentRecoveryContext | undefined
      let previousAttemptId: string | undefined
      for (let attemptNumber = 1; attemptNumber <= this.#reliability.maxAttempts; attemptNumber += 1) {
        const attemptId = `${admission.agentId}_attempt_${attemptNumber}`
        let providerLease: SchedulerLease | undefined
        let circuitLease: ProviderCircuitLease | undefined
        let attemptRequest: AgentRequest | undefined
        let announcedCircuitWait = false
        try {
          // Circuit wait owns no provider capacity. When the provider is globally unavailable,
          // queued work remains visible without nine backoff loops pinning all nine permits.
          while (true) {
            const circuit = this.#circuitBreaker.snapshot()
            if (circuit.state !== 'closed' && !announcedCircuitWait) {
              announcedCircuitWait = true
              await this.#emit({
                type: 'agent.queued',
                agentId: admission.agentId,
                ...(admission.phaseId === undefined ? {} : { phaseId: admission.phaseId }),
                payload: {
                  reason: circuit.state === 'half-open'
                    ? `Waiting for ${this.#options.provider.name} provider health probe`
                    : `Waiting for ${this.#options.provider.name} provider circuit cooldown`,
                },
              })
            }
            circuitLease = await this.#circuitBreaker.enter(this.#controller.signal)
            providerLease = await this.#acquireProviderLease(this.#controller.signal)
            this.#observeScheduler(this.#runScheduler.snapshot())
            if (circuitLease.startAllowed()) break
            // The circuit changed while this call waited behind already-running work. Relinquish
            // capacity and re-enter the gate; launching from the stale lease is the thundering-herd
            // bug the circuit is meant to prevent.
            circuitLease.neutral()
            circuitLease = undefined
            providerLease.release()
            providerLease = undefined
            this.#observeScheduler(this.#runScheduler.snapshot())
          }
          if (this.#controller.signal.aborted) {
            throw new WorkflowCancelledError(abortReason(this.#controller.signal))
          }

          const resumeSession = providerSession
          attemptRequest = this.#providerRequest({
            admission,
            workingDirectory,
            ...(instructions === undefined ? {} : { instructions }),
            ...(resumeSession === undefined ? {} : { resumeSession }),
            ...(recovery === undefined ? {} : { recovery }),
          })
          const replaySafety = this.#replaySafety(admission, attemptRequest)
          const startedAt = Date.now()
          await this.#emit({
            type: 'agent.started',
            agentId: admission.agentId,
            attemptId,
            ...(admission.phaseId === undefined ? {} : { phaseId: admission.phaseId }),
            payload: {
              attemptNumber,
              source: resumeSession === undefined ? 'live' : 'provider-resume',
              provider: this.#options.provider.name,
              startupDeadlineAt: new Date(startedAt + this.#reliability.startupTimeoutMs).toISOString(),
              absoluteDeadlineAt: new Date(startedAt + this.#reliability.attemptTimeoutMs).toISOString(),
              ...(admission.options.isolation === 'worktree' ? { workspaceId } : {}),
              ...(resumeSession === undefined ? {} : { providerSession: resumeSession }),
              replaySafety,
            },
          })
          lastAttemptId = attemptId
          lastAttemptNumber = attemptNumber
          lastAttemptOpen = true
          if (recovery !== undefined && previousAttemptId !== undefined) {
            await this.#emit({
              type: 'agent.recovery_started',
              agentId: admission.agentId,
              attemptId,
              ...(admission.phaseId === undefined ? {} : { phaseId: admission.phaseId }),
              payload: { previousAttemptId, context: recovery },
            })
          }

          const result = await this.#executeProviderAttempt({
            admission,
            attemptId,
            attemptNumber,
            request: attemptRequest,
            onSession: (session) => { providerSession = session },
            onProviderProgress: () => circuitLease?.providerResponsive(),
          })
          circuitLease.success()
          if (this.#controller.signal.aborted || this.#terminal) {
            throw new WorkflowCancelledError(abortReason(this.#controller.signal))
          }

          // Claude's budget pool counts generated output only. Input/context tokens may dwarf the
          // actual requested work on resumed threads; charging totalTokens caused identical
          // workflows to stop at different points depending on provider cache state. Charge before
          // validating the returned contract because malformed output still consumed the shared
          // provider budget; otherwise repeated invalid turns could evade the cap indefinitely.
          if (result.usage?.outputTokens !== undefined) this.#budgetSpent += result.usage.outputTokens
          const value = this.#providerValue(result, admission.validateOutput)
          admission.journalRun.recordResult(admission.journalMiss, value, { successful: true })
          const completedSession = result.providerSession ?? providerSession

          if (recovery !== undefined && previousAttemptId !== undefined) {
            await this.#emit({
              type: 'agent.recovery_completed',
              agentId: admission.agentId,
              attemptId,
              ...(admission.phaseId === undefined ? {} : { phaseId: admission.phaseId }),
              payload: { previousAttemptId },
            })
          }

          // Durable per-agent bytes are published BEFORE the terminal agent event, mirroring the
          // run-result ordering: every advertised locator already names fsynced content. Best
          // effort by contract — see materializeAgentResult.
          const agentResultReference = await this.#materializeAgentResult(admission.agentId, value)

          await this.#emit({
            type: 'agent.completed',
            agentId: admission.agentId,
            attemptId,
            ...(admission.phaseId === undefined ? {} : { phaseId: admission.phaseId }),
            payload: {
              source: resumeSession === undefined ? 'live' : 'provider-resume',
              result: agentResultReference ?? contentReference(value, this.#limits),
              structured: result.output.type === 'structured',
              ...(result.usage === undefined ? {} : { usage: result.usage }),
              ...(completedSession === undefined ? {} : { providerSession: completedSession }),
              ...(result.diagnostics === undefined
                ? {}
                : {
                    diagnostics: cloneBoundaryValue(
                      result.diagnostics,
                      this.#limits,
                    ) as Readonly<Record<string, unknown>>,
                  }),
            },
          })
          lastAttemptOpen = false
          this.#completeWorkerRequest(admission.worker, admission.requestId, {
            type: 'agent.result',
            requestId: admission.requestId,
            result: { type: 'success', value },
            budgetSpent: this.#budgetSpent,
          })
          return
        } catch (error) {
          if (error instanceof UnconfirmedProviderTerminationError) {
            circuitLease?.infrastructureFailure()
            if (error.reason === 'cancellation' || this.#controller.signal.aborted) {
              // Explicit run cancellation is an ownership handoff, not a logical retry. Keep the
              // real provider permit and store lease fenced until the adapter settles so a second
              // supervisor cannot overlap the cancelled run during shutdown/restart.
              const quarantinedLease = providerLease
              providerLease = undefined
              const fencedExecution = this.#quarantineExecution(error.execution)
              if (admission.options.isolation === 'worktree') preserveWorkspaceForRecovery = true
              if (quarantinedLease) {
                void fencedExecution.finally(() => {
                  quarantinedLease.release()
                  this.#observeScheduler(this.#runScheduler.snapshot())
                }).catch(() => undefined)
              }
              throw new WorkflowCancelledError(abortReason(this.#controller.signal))
            }
            const assessedReplaySafety = this.#replaySafety(admission, attemptRequest!)
            // WHY an isolated worktree is replay-safe only after the old writer is confirmed gone:
            // the stable worktree intentionally survives retries. An unconfirmed descendant may
            // still be writing into that same path, so launching a replacement there creates two
            // concurrent writers rather than a safe replay. Preserve/quarantine this casualty and
            // let independent assignments continue.
            const replaySafety = assessedReplaySafety.risk === 'worktree_write'
              ? {
                  ...assessedReplaySafety,
                  automatic: false,
                  reason: `${assessedReplaySafety.reason}; the prior writer is still unconfirmed`,
                }
              : assessedReplaySafety
            const failure = new AgentProviderFailure(error.message, {
              code: 'provider-termination-unconfirmed',
              retryable: true,
              circuitImpact: 'infrastructure',
              cause: error,
            })
            const retrying = this.#reserveRetry(admission, failure, attemptNumber, replaySafety)
            lastAttemptOpen = false
            if (!retrying) {
              // WHY logical completion does not imply execution ownership can transfer: on macOS
              // Codex descendants may escape the wrapper process group. The coverage placeholder
              // lets every independent assignment and synthesis continue, but a replacement
              // supervisor still must not reclaim this lineage's durable store while the abandoned
              // credentialed process may be alive. Keep that cross-process fence closed without
              // consuming provider admission capacity or turning the casualty into a run failure.
              this.#quarantineExecution(error.execution)
              preserveWorkspaceForRecovery = true
              await this.#markRecoveryRequired(
                admission,
                attemptId,
                attemptNumber,
                failure,
                replaySafety,
              )
              return
            }

            // Effect safety authorizes a fresh read-only attempt, but it does not prove the old
            // credentialed descendant exited. If the run is cancelled before this logical agent
            // finishes, ownership may transfer to another supervisor; promote every still-
            // ambiguous physical attempt into the permanent process-lifetime fence in that case.
            // The listener is installed before any awaited retry event so event-sink cancellation
            // cannot slip through the handoff window.
            const fenceUnconfirmedAttemptOnAbort = () => {
              this.#quarantineExecution(error.execution)
            }
            unconfirmedRetryAbortListeners.add(fenceUnconfirmedAttemptOnAbort)
            if (this.#controller.signal.aborted) fenceUnconfirmedAttemptOnAbort()
            else this.#controller.signal.addEventListener('abort', fenceUnconfirmedAttemptOnAbort, { once: true })

            previousAttemptId = attemptId
            recovery = recoveryContext(failure, attemptNumber)
            // Publishing agent.failed promises a fresh physical attempt. Persist removal of the
            // poisoned provider-session pointer before that awaited event so a host crash cannot
            // recover into the very thread the audit stream says was abandoned.
            admission.journalRun.discardProviderSession(admission.journalMiss)
            providerSession = undefined

            // WHY only a retry gets agent.failed here: without `retrying: true` that event is
            // terminal and may close the phase before the more accurate recovery_required event.
            // An abandoned ambiguous attempt has exactly one terminal classification; the failed
            // attempt remains visible inside recovery_required and its attempt audit trail.
            await this.#emit({
              type: 'agent.failed',
              agentId: admission.agentId,
              attemptId,
              ...(admission.phaseId === undefined ? {} : { phaseId: admission.phaseId }),
              payload: { error: errorReference(failure), retrying: true },
            })

            const delayMs = retryDelayMs(this.#reliability, attemptNumber)
            await this.#emit({
              type: 'agent.retry_scheduled',
              agentId: admission.agentId,
              attemptId,
              ...(admission.phaseId === undefined ? {} : { phaseId: admission.phaseId }),
              payload: {
                completedAttemptNumber: attemptNumber,
                nextAttemptNumber: attemptNumber + 1,
                delayMs,
                retryAt: new Date(Date.now() + delayMs).toISOString(),
                reason: errorReference(failure),
              },
            })
            // WHY a timed-out wrapper cannot keep a shared scheduler permit forever: Codex tools
            // may escape the process group, so settlement is not guaranteed. Effect safety—not OS
            // containment—is what authorizes this fresh read-only retry. Late callbacks are muted
            // inside #executeProviderAttempt, and the old physical attempt remains diagnostic-only.
            providerLease?.release()
            providerLease = undefined
            this.#observeScheduler(this.#runScheduler.snapshot())
            await abortableDelay(delayMs, this.#controller.signal)
            continue
          }
          if (error instanceof AgentProviderFailure && error.providerSession !== undefined) {
            providerSession = error.providerSession
            admission.journalRun.recordProviderSession(admission.journalMiss, error.providerSession)
          }
          if (
            this.#controller.signal.aborted ||
            error instanceof WorkflowCancelledError ||
            (error instanceof AgentProviderAbortError && !(error.reason instanceof AgentAttemptTimeoutError))
          ) {
            circuitLease?.neutral()
            throw error
          }

          if (error instanceof AgentProviderFailure) {
            if (error.retryable && error.circuitImpact === 'infrastructure') {
              circuitLease?.infrastructureFailure()
            }
            else circuitLease?.neutral()
            const replaySafety = this.#replaySafety(
              admission,
              attemptRequest ?? this.#providerRequest({
                admission,
                workingDirectory,
                ...(instructions === undefined ? {} : { instructions }),
                ...(providerSession === undefined ? {} : { resumeSession: providerSession }),
              }),
            )
            const retrying = this.#reserveRetry(admission, error, attemptNumber, replaySafety)
            // WHY replay safety is independent of whether policy would grant another attempt: a
            // retryable provider failure means the prior turn may have produced an effect whose
            // response was lost. The typed recovery_required placeholder preserves that ambiguity;
            // silently treating the assignment as successful data would be corruption.
            const replayWouldBeUnsafe = error.retryable && !replaySafety.automatic
            if (replayWouldBeUnsafe) {
              preserveWorkspaceForRecovery = true
              await this.#markRecoveryRequired(admission, attemptId, attemptNumber, error, replaySafety)
              lastAttemptOpen = false
              return
            }
            lastAttemptOpen = false
            if (!retrying) {
              const placeholder = this.#recordAgentFailure(admission, error, 'failed', attemptNumber)
              await this.#emit({
                type: 'agent.failed',
                agentId: admission.agentId,
                attemptId,
                ...(admission.phaseId === undefined ? {} : { phaseId: admission.phaseId }),
                payload: { error: errorReference(error) },
              })
              await this.#emit({
                type: 'warning',
                agentId: admission.agentId,
                attemptId,
                ...(admission.phaseId === undefined ? {} : { phaseId: admission.phaseId }),
                payload: {
                  message: error.message,
                  ...(error.code === undefined ? {} : { code: error.code }),
                },
              })
              this.#replyAgentFailure(admission, placeholder)
              return
            }

            previousAttemptId = attemptId
            recovery = recoveryContext(error, attemptNumber)
            // Keep the durable fresh-thread boundary ahead of retry diagnostics for the same crash
            // ordering reason as the unconfirmed-termination branch above.
            admission.journalRun.discardProviderSession(admission.journalMiss)
            providerSession = undefined

            await this.#emit({
              type: 'agent.failed',
              agentId: admission.agentId,
              attemptId,
              ...(admission.phaseId === undefined ? {} : { phaseId: admission.phaseId }),
              payload: { error: errorReference(error), retrying: true },
            })

            const delayMs = retryDelayMs(this.#reliability, attemptNumber)
            const retryAt = new Date(Date.now() + delayMs).toISOString()
            await this.#emit({
              type: 'agent.retry_scheduled',
              agentId: admission.agentId,
              attemptId,
              ...(admission.phaseId === undefined ? {} : { phaseId: admission.phaseId }),
              payload: {
                completedAttemptNumber: attemptNumber,
                nextAttemptNumber: attemptNumber + 1,
                delayMs,
                retryAt,
                reason: errorReference(error),
              },
            })
            // Provider capacity is released in finally before backoff. Sleeping while holding a
            // permit made one transient 30-second retry pause reduce a nine-agent pool to eight.
            providerLease?.release()
            providerLease = undefined
            this.#observeScheduler(this.#runScheduler.snapshot())
            await abortableDelay(delayMs, this.#controller.signal)
            continue
          }
          circuitLease?.neutral()
          throw error
        } finally {
          circuitLease?.neutral()
          providerLease?.release()
          this.#observeScheduler(this.#runScheduler.snapshot())
        }
      }
    } catch (error) {
      if (
        this.#controller.signal.aborted ||
        error instanceof WorkflowCancelledError ||
        error instanceof AgentProviderAbortError
      ) {
        await this.#emit({
          type: 'agent.cancelled',
          agentId: admission.agentId,
          ...(!lastAttemptOpen || lastAttemptId === undefined ? {} : { attemptId: lastAttemptId }),
          ...(admission.phaseId === undefined ? {} : { phaseId: admission.phaseId }),
          payload: { reason: abortReason(this.#controller.signal) },
        })
        this.#replyAgentError(admission.worker, admission.requestId, error)
      } else if (error instanceof AgentProviderFailure || error instanceof AgentAssignmentFailure) {
        const placeholder = this.#recordAgentFailure(admission, error, 'failed', lastAttemptNumber)
        await this.#emit({
          type: 'agent.failed',
          agentId: admission.agentId,
          ...(lastAttemptId === undefined ? {} : { attemptId: lastAttemptId }),
          ...(admission.phaseId === undefined ? {} : { phaseId: admission.phaseId }),
          payload: { error: errorReference(error) },
        })
        this.#replyAgentFailure(admission, placeholder)
      } else {
        // WHY the assignment boundary is typed and fail-closed: provider/contract/setup casualties
        // are expected disposable work, but a rejected scheduler, corrupted journal, or broken
        // supervisor invariant means we cannot honestly account for every logical assignment.
        // Converting those control-plane faults into a normal coverage gap would let the run claim
        // completed_with_errors while its orchestration authority itself was unreliable.
        throw error
      }
    } finally {
      for (const listener of unconfirmedRetryAbortListeners) {
        this.#controller.signal.removeEventListener('abort', listener)
      }
      unconfirmedRetryAbortListeners.clear()
      try {
        const cleanup = prepared?.cleanup && !preserveWorkspaceForRecovery
          ? await this.#cleanupWorkingDirectory(prepared)
          : undefined
        if (prepared !== undefined && preserveWorkspaceForRecovery) {
          // Recovery must observe the exact filesystem state which surrounded the uncertain turn.
          // Cleaning here is especially dangerous for an unconfirmed process: that process may
          // still have its cwd or files open. The host/reconciler owns eventual disposition after
          // an operator resolves the ambiguity.
          await this.#emit({
            type: 'warning',
            agentId: admission.agentId,
            ...(lastAttemptId === undefined ? {} : { attemptId: lastAttemptId }),
            ...(admission.phaseId === undefined ? {} : { phaseId: admission.phaseId }),
            payload: {
              code: 'working-directory-preserved-for-recovery',
              message: `Isolated working directory was preserved for recovery at ${prepared.path}`,
              details: { path: prepared.path, workspaceId },
            },
          })
        }
        if (cleanup?.preservedPath) {
          await this.#emit({
            type: 'warning',
            agentId: admission.agentId,
            ...(lastAttemptId === undefined ? {} : { attemptId: lastAttemptId }),
            ...(admission.phaseId === undefined ? {} : { phaseId: admission.phaseId }),
            payload: {
              code: 'working-directory-preserved',
              message: `Isolated worktree contains changes and was preserved at ${cleanup.preservedPath}`,
              details: { path: cleanup.preservedPath },
            },
          })
        }
      } catch (error) {
        // Cleanup happens after the provider outcome is already authoritative. Turning a failed
        // best-effort worktree removal into a second agent failure would contradict the event
        // history and strand the worker waiting for a reply it already received.
        try {
          await this.#emit({
            type: 'warning',
            agentId: admission.agentId,
            ...(lastAttemptId === undefined ? {} : { attemptId: lastAttemptId }),
            ...(admission.phaseId === undefined ? {} : { phaseId: admission.phaseId }),
            payload: {
              code: 'working-directory-cleanup-failed',
              message: `Failed to clean up isolated working directory: ${error instanceof Error ? error.message : String(error)}`,
            },
          })
        } catch {
          // A failed event sink must not turn cleanup into an unhandled background rejection.
        }
      }
    }
  }

  async #cleanupWorkingDirectory(
    prepared: PreparedWorkingDirectory,
  ): Promise<void | { preservedPath: string }> {
    if (!prepared.cleanup) return
    // Cleanup is separately bounded and deliberately does not consume provider capacity. A
    // cancelled run still needs this best-effort path, so it uses an independent signal.
    const cleanupLease = await this.#cleanupScheduler.acquire(new AbortController().signal)
    const cleanupController = linkedTimeoutController(
      undefined,
      this.#reliability.cleanupTimeoutMs,
      'Working-directory cleanup timed out',
    )
    const cleanupAbort = abortRejection(cleanupController.signal)
    let cleanupSettled = false
    const cleanup = Promise.resolve().then(() => prepared.cleanup!({ signal: cleanupController.signal }))
    const observedCleanup = cleanup.then(
      (value) => { cleanupSettled = true; return value },
      (error: unknown) => { cleanupSettled = true; throw error },
    )
    try {
      return await Promise.race([observedCleanup, cleanupAbort.promise])
    } finally {
      cleanupAbort.dispose()
      cleanupController.dispose()
      if (cleanupSettled) {
        cleanupLease.release()
      } else {
        // Releasing on timeout let the next cleanup start while the old git process still held
        // locks. Preserve both the real concurrency count and the cross-process ownership fence
        // until the cleanup promise—not its AbortSignal—confirms settlement.
        const lateCleanup = observedCleanup.finally(() => cleanupLease.release())
        this.#quarantineSettlingOperation(lateCleanup)
      }
    }
  }

  async #executeProviderAttempt(input: {
    admission: AgentAdmission
    attemptId: string
    attemptNumber: number
    request: AgentRequest
    onSession(session: ProviderSessionReference): void
    onProviderProgress(): void
  }): Promise<AgentProviderResult> {
    const attemptController = new AbortController()
    const onRunAbort = (): void => attemptController.abort(this.#controller.signal.reason)
    this.#controller.signal.addEventListener('abort', onRunAbort, { once: true })
    const monitor = new AttemptLivenessMonitor(
      attemptController,
      this.#reliability,
      (snapshot) => {
        // A quiet model turn can be legitimate reasoning. This durable warning gives the operator a
        // visible soft phase without declaring progress or extending the hard deadline. A responsive
        // host heartbeat is intentionally absent from this decision because wrapper liveness does
        // not prove the model/tool stream is advancing.
        void this.#emit({
          type: 'warning',
          agentId: input.admission.agentId,
          attemptId: input.attemptId,
          ...(input.admission.phaseId === undefined ? {} : { phaseId: input.admission.phaseId }),
          payload: {
            code: 'agent-soft-stall',
            message: 'Agent has been quiet long enough to warrant observation; the hard deadline has not fired',
            details: snapshot,
          },
        }).catch(() => undefined)
      },
    )
    const activityIds = new Set<string>()
    let acceptProviderEvents = true
    const identity: AgentProviderAttemptIdentity = {
      runId: this.id,
      agentId: input.admission.agentId,
      attemptId: input.attemptId,
      attemptNumber: input.attemptNumber,
    }

    const execution = Promise.resolve().then(() => this.#options.provider.execute(
      input.request,
      {
        signal: attemptController.signal,
        attempt: identity,
        emit: async (event) => {
          if (!acceptProviderEvents) return
          monitor.progress(event)
          if (event.type === 'session.started') input.onSession(event.session)
          await this.#emitProviderEvent(input.admission, input.attemptId, event, activityIds)
          // Parent-generated warnings (for example a safe fresh-thread fallback) do not prove that
          // Codex is healthy. Session/activity events crossed the provider boundary and were
          // durably recorded, which is sufficient to release a half-open probe immediately.
          if (event.type !== 'warning') input.onProviderProgress()
        },
        // Provider-host heartbeat is recorded only by process diagnostics. Feeding it to `progress`
        // would let a healthy Node wrapper mask a permanently wedged Codex stream.
        heartbeat: () => undefined,
      },
    ))
    // A timeout wins Promise.race even if a broken adapter ignores AbortSignal forever. The
    // rejection handler prevents that detached adapter promise from becoming an unhandled process
    // rejection if it eventually settles after the logical attempt has moved on.
    void execution.catch(() => undefined)
    const cancellation = abortRejection(this.#controller.signal)

    try {
      return await Promise.race([execution, monitor.timeout, cancellation.promise])
    } catch (error) {
      if (this.#controller.signal.aborted) {
        acceptProviderEvents = false
        const settlement = await this.#confirmProviderTermination(execution, identity, {
          code: 'cancellation',
          message: abortReason(this.#controller.signal),
        })
        if (!settlement) {
          await this.#emitUnconfirmedTermination(input.admission, input.attemptId)
          throw new UnconfirmedProviderTerminationError(
            'Cancelled provider attempt could not be confirmed stopped',
            execution,
            'cancellation',
            { cause: error },
          )
        }
        await this.#emit({
          type: 'agent.termination_confirmed',
          agentId: input.admission.agentId,
          attemptId: input.attemptId,
          ...(input.admission.phaseId === undefined ? {} : { phaseId: input.admission.phaseId }),
          payload: {
            reason: 'cancellation',
            boundary: this.#options.provider.terminationBoundary === 'process-tree'
              ? 'process-tree'
              : 'settlement',
          },
        })
        throw new WorkflowCancelledError(abortReason(this.#controller.signal))
      }
      if (!(error instanceof AgentAttemptTimeoutError)) {
        if (this.#storageFailure !== undefined) throw this.#storageFailure
        if (error instanceof AgentProviderFailure) throw error
        if (error instanceof AgentProviderAbortError) {
          throw new AgentProviderFailure(`Provider execution aborted unexpectedly: ${error.message}`, {
            code: 'provider-execution-aborted',
            retryable: true,
            circuitImpact: 'infrastructure',
            cause: error,
          })
        }
        // Anything thrown from inside the provider execution boundary is an assignment-local
        // physical-attempt failure. The scheduler/journal/event-sink live outside this boundary and
        // therefore remain supervisor-fatal instead of being accidentally downgraded here.
        throw new AgentProviderFailure(
          `Provider execution failed: ${error instanceof Error ? error.message : String(error)}`,
          {
            code: 'provider-execution-failed',
            retryable: true,
            // An untyped adapter exception proves only that this physical attempt broke. Providers
            // must opt known outages into infrastructure impact; otherwise one malformed request
            // can open the shared circuit and starve every healthy independent assignment.
            circuitImpact: 'neutral',
            cause: error,
          },
        )
      }
      acceptProviderEvents = false
      // Start the diagnostic append without putting it on the process-termination critical path.
      // A stalled fsync is exactly the failure mode in which waiting here would leave a timed-out
      // credentialed process alive indefinitely. Event ordering remains serialized by #emitTail;
      // storage has its own deadline and degradation fence.
      void this.#emit({
        type: 'agent.stalled',
        agentId: input.admission.agentId,
        attemptId: input.attemptId,
        ...(input.admission.phaseId === undefined ? {} : { phaseId: input.admission.phaseId }),
        payload: {
          kind: error.kind,
          lastProgressAt: error.lastProgressAt,
          deadlineAt: error.deadlineAt,
        },
      }).catch(() => undefined)
      const settlement = await this.#confirmProviderTermination(execution, identity, {
        code: 'timeout',
        message: error.message,
      })
      if (!settlement) {
        await this.#emitUnconfirmedTermination(input.admission, input.attemptId)
        throw new UnconfirmedProviderTerminationError(
          'Timed-out provider attempt could not be confirmed stopped',
          execution,
          'timeout',
          { cause: error },
        )
      }
      await this.#emit({
        type: 'agent.termination_confirmed',
        agentId: input.admission.agentId,
        attemptId: input.attemptId,
        ...(input.admission.phaseId === undefined ? {} : { phaseId: input.admission.phaseId }),
        payload: {
          reason: 'timeout',
          boundary: this.#options.provider.terminationBoundary === 'process-tree'
            ? 'process-tree'
            : 'settlement',
        },
      })
      // A completion can race the timeout and cooperative abort. Once the provider returned a
      // successful result during the bounded grace period, discarding it and replaying the same
      // tool-bearing turn is both wasteful and potentially duplicative. Rejections still retain
      // the timeout classification because they commonly are the expected AbortSignal response.
      if (settlement.status === 'fulfilled') return settlement.value
      throw error
    } finally {
      monitor.stop()
      cancellation.dispose()
      this.#controller.signal.removeEventListener('abort', onRunAbort)
    }
  }

  async #confirmProviderTermination<T>(
    execution: Promise<T>,
    identity: AgentProviderAttemptIdentity,
    reason: { code: 'timeout' | 'cancellation' | 'shutdown'; message: string },
  ): Promise<PromiseSettlement<T> | undefined> {
    const settlementProvesTermination =
      this.#options.provider.terminationBoundary !== 'unconfirmed-descendants'
    const cooperative = await settlementWithin(execution, this.#limits.cancellationGraceMs)
    if (cooperative && settlementProvesTermination) return cooperative
    if (this.#options.provider.terminateAttempt) {
      // A buggy termination hook must itself be bounded. Its return is not proof of exit; only the
      // attempt result settling confirms that the adapter has reaped its execution boundary.
      const termination = Promise.resolve().then(() => this.#options.provider.terminateAttempt!(identity, reason))
      void termination.catch(() => undefined)
      await settlementWithin(termination, this.#reliability.hardTerminationGraceMs)
    }
    const hardSettlement = cooperative ?? await settlementWithin(
      execution,
      this.#reliability.hardTerminationGraceMs,
    )
    return settlementProvesTermination ? hardSettlement : undefined
  }

  async #emitUnconfirmedTermination(admission: AgentAdmission, attemptId: string): Promise<void> {
    await this.#emit({
      type: 'warning',
      agentId: admission.agentId,
      attemptId,
      ...(admission.phaseId === undefined ? {} : { phaseId: admission.phaseId }),
      payload: {
        code: 'provider-termination-unconfirmed',
        message: 'The provider execution boundary could not prove that every descendant stopped; replay will use effect-safety policy and a fresh provider thread',
      },
    })
  }

  #quarantineExecution(execution: Promise<unknown>): Promise<unknown> {
    // An SDK which cannot identify descendants gives us no future in-process event that proves
    // those tools exited. Keep the fence until process exit instead of pretending the already-
    // settled wrapper promise is evidence. The replacement process can then reclaim the PID-bound
    // store lease and recover from the durable interrupted boundary.
    if (this.#options.provider.terminationBoundary === 'unconfirmed-descendants') {
      let resolveQuarantine!: () => void
      const quarantine = new Promise<void>((resolvePromise) => {
        resolveQuarantine = resolvePromise
      })
      let released = false
      const release = (): void => {
        if (released) return
        released = true
        this.#abandonableProviderQuarantines.delete(release)
        // Delete synchronously so a service resume in the same turn can verify ownership transfer
        // before the promise-finally microtask runs.
        this.#quarantinedExecutions.delete(quarantine)
        resolveQuarantine()
      }
      this.#abandonableProviderQuarantines.add(release)
      this.#quarantinedExecutions.add(quarantine)
      void quarantine.finally(() => this.#quarantinedExecutions.delete(quarantine)).catch(() => undefined)
      // Observe late rejection even though it cannot prove escaped descendants stopped.
      void execution.catch(() => undefined)
      return quarantine
    }
    const quarantine = execution
    this.#quarantinedExecutions.add(quarantine)
    // WHY removal follows the original execution rather than a timer: only adapter settlement is
    // evidence that the old credentialed process boundary has stopped. A timeout would recreate
    // the same unsafe handoff this quarantine exists to prevent.
    void quarantine.finally(() => this.#quarantinedExecutions.delete(quarantine)).catch(() => undefined)
    return quarantine
  }

  #quarantineSettlingOperation(operation: Promise<unknown>): Promise<unknown> {
    // WHY preparation/cleanup does not use #quarantineExecution: no provider process exists yet,
    // so the provider's descendant-containment guarantee is irrelevant. The operation promise is
    // authoritative evidence that the git/filesystem work stopped; replacing it with a permanent
    // provider fence would retain the store lease forever after a completely successful cleanup.
    this.#quarantinedExecutions.add(operation)
    void operation.finally(() => this.#quarantinedExecutions.delete(operation)).catch(() => undefined)
    return operation
  }

  #providerRequest(input: {
    admission: AgentAdmission
    workingDirectory: string
    instructions?: string
    resumeSession?: ProviderSessionReference
    recovery?: AgentRecoveryContext
  }): AgentRequest {
    return {
      prompt: input.admission.prompt,
      ...(input.admission.normalizedOptions.schema === undefined
        ? {}
        : { schema: input.admission.normalizedOptions.schema }),
      ...(input.admission.normalizedOptions.model === undefined
        ? {}
        : { model: input.admission.normalizedOptions.model }),
      ...(input.admission.normalizedOptions.effort === undefined
        ? {}
        : { effort: input.admission.normalizedOptions.effort }),
      workingDirectory: input.workingDirectory,
      sandbox: this.#sandbox,
      ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
      ...(input.resumeSession === undefined ? {} : { session: input.resumeSession }),
      ...(input.recovery === undefined ? {} : { recovery: input.recovery }),
    }
  }

  #replaySafety(admission: AgentAdmission, request: AgentRequest): AgentReplaySafetyAssessment {
    const providerAssessment = this.#options.provider.assessReplaySafety?.(request) ?? {
      automatic: this.#options.provider.automaticReplaySafety === 'safe',
      risk: this.#options.provider.automaticReplaySafety === 'safe'
        ? ('read_only' as const)
        : ('unknown_external' as const),
      reason: this.#options.provider.automaticReplaySafety === 'safe'
        ? 'Provider attests that reachable external effects are replay-safe'
        : 'Provider does not attest that reachable external effects are replay-safe',
    }
    if (!providerAssessment.automatic) return providerAssessment
    if (this.#sandbox.mode === 'read-only') return providerAssessment
    if (admission.options.isolation === 'worktree') {
      return {
        ...providerAssessment,
        risk: 'worktree_write',
        reason: `${providerAssessment.reason}; local writes remain in the same durable isolated worktree`,
      }
    }
    return {
      automatic: false,
      risk: 'unknown_external',
      reason: 'The attempt may have modified the shared working directory without durable isolation',
    }
  }

  async #markRecoveryRequired(
    admission: AgentAdmission,
    attemptId: string,
    attemptNumber: number,
    error: unknown,
    replaySafety: AgentReplaySafetyAssessment,
  ): Promise<void> {
    const reference = errorReference(error)
    // Persist the terminal disposition before publishing its event. A host can disappear after any
    // fsync; if the event won that race while the journal still looked unfinished, automatic
    // recovery would replay exactly the unsafe attempt this classification is meant to quarantine.
    const placeholder = this.#recordAgentFailure(
      admission,
      error,
      'recovery_required',
      attemptNumber,
    )
    await this.#emit({
      type: 'agent.recovery_required',
      agentId: admission.agentId,
      attemptId,
      ...(admission.phaseId === undefined ? {} : { phaseId: admission.phaseId }),
      payload: { error: reference, replaySafety },
    })
    // WHY recovery_required is terminal only for this logical assignment: workflows exist so a
    // 200-agent research job can finish unattended. An honest typed coverage gap gives downstream
    // synthesis sound input without pretending the uncertain turn succeeded, while a global fence
    // would discard every independent sibling and make manual resume part of normal operation.
    this.#replyAgentFailure(admission, placeholder)
  }

  #recordAgentFailure(
    admission: AgentAdmission,
    error: unknown,
    status: WorkflowAgentFailurePlaceholder['__workflowAgentFailure']['status'],
    attempts: number,
  ): WorkflowAgentFailurePlaceholder {
    const reference = errorReference(error)
    const placeholder: WorkflowAgentFailurePlaceholder = {
      __workflowAgentFailure: {
        schemaVersion: 1,
        agentId: admission.agentId,
        label: admission.options.label ?? fallbackLabel(admission.prompt),
        status,
        message: reference.message.slice(0, this.#limits.maxLogCharacters),
        ...(reference.code === undefined ? {} : { code: reference.code }),
        attempts,
        coverageGap: true,
      },
    }
    this.#completedWithErrors = true
    // Terminal casualties must never leave a provider thread pointer that restart recovery can
    // accidentally resume. recordResult invalidates that pointer and stores the coverage gap in
    // one journal mutation, so a crash cannot observe only half of the terminal disposition.
    admission.journalRun.recordResult(admission.journalMiss, placeholder, {
      successful: false,
      coverageGap: true,
    })
    return placeholder
  }

  #replyAgentFailure(
    admission: AgentAdmission,
    placeholder: WorkflowAgentFailurePlaceholder,
  ): void {
    this.#completeWorkerRequest(admission.worker, admission.requestId, {
      type: 'agent.result',
      requestId: admission.requestId,
      // The public placeholder remains visible to synthesis, but the evaluator receives an
      // out-of-band provenance bit so user-controlled structured output cannot impersonate it and
      // suppress later pipeline stages.
      result: { type: 'success', value: placeholder, coverageGap: true },
      budgetSpent: this.#budgetSpent,
    })
  }

  #reserveRetry(
    admission: AgentAdmission,
    error: AgentProviderFailure,
    attemptNumber: number,
    replaySafety: AgentReplaySafetyAssessment,
  ): boolean {
    if (!error.retryable || attemptNumber >= this.#reliability.maxAttempts) return false
    if (this.#retryAttemptsScheduled >= this.#reliability.maxRetryAttemptsPerRun) return false
    if (this.#reliability.automaticRetry === 'never') return false
    // A local read-only sandbox says nothing about remote MCP side effects. Retrying an unknown
    // provider after a lost response can duplicate an email, deployment, or database mutation, so
    // automatic replay requires an affirmative provider capability instead of optimistic guessing.
    if (!replaySafety.automatic) return false
    // WHY workspace-write without isolation is excluded even when an adapter says "retryable": a
    // network failure can happen after a tool changed the user's checkout. Read-only calls cannot
    // mutate it, and a stable isolated worktree makes repeated local writes inspectable/reconcilable.
    if (this.#sandbox.mode !== 'read-only' && admission.options.isolation !== 'worktree') return false
    // WHY reservation happens synchronously inside the predicate: several provider promises can
    // reject in one turn. If callers merely inspect the counter and increment after awaiting the
    // durable failure event, every concurrent failure can observe the same remaining final slot.
    // JavaScript execution between awaits is serialized, so check-and-increment here is the run's
    // linearization point.
    this.#retryAttemptsScheduled += 1
    return true
  }

  async #acquireProviderLease(signal: AbortSignal): Promise<SchedulerLease> {
    const runLease = await this.#runScheduler.acquire(signal, this.id)
    if (this.#runScheduler === this.#scheduler) return runLease
    try {
      // WHY both leases are required: the service scheduler prevents two runs from exceeding the
      // machine-wide provider budget, while this run-local lease preserves a workflow's explicit
      // lower concurrency limit. Using only the shared scheduler silently turned `concurrency: 2`
      // into nine as soon as WorkflowService began sharing admission across runs.
      const serviceLease = await this.#scheduler.acquire(signal, this.id)
      let released = false
      return {
        release: () => {
          if (released) return
          released = true
          serviceLease.release()
          runLease.release()
        },
      }
    } catch (error) {
      runLease.release()
      throw error
    }
  }

  #providerValue(result: AgentProviderResult, validateOutput: ValidateFunction | undefined): unknown {
    if (validateOutput && result.output.type !== 'structured') {
      throw new AgentProviderFailure('Agent completed without the required structured output', {
        code: 'structured-output-invalid',
        terminalDisposition: 'reject',
      })
    }
    let value: unknown
    try {
      value = cloneBoundaryValue(
        result.output.type === 'structured' ? result.output.value : result.output.text,
        this.#limits,
      )
    } catch (cause) {
      // Provider output is untrusted contract data. A circular/oversized/unsupported value is one
      // assignment casualty, not evidence that the scheduler or journal is corrupt. Keep the typed
      // boundary here so the broader executeAgent catch can still fail closed for genuine
      // supervisor exceptions thrown outside the provider-result conversion.
      throw new AgentProviderFailure(
        `Agent output could not cross the workflow boundary: ${cause instanceof Error ? cause.message : String(cause)}`,
        { code: 'provider-output-invalid', terminalDisposition: 'reject', cause },
      )
    }
    if (validateOutput && !validateOutput(value)) {
      throw new AgentProviderFailure(
        `Agent structured output failed schema validation: ${this.#ajv.errorsText(validateOutput.errors)}`,
        { code: 'structured-output-invalid', terminalDisposition: 'reject' },
      )
    }
    return value
  }

  async #emitProviderEvent(
    admission: AgentAdmission,
    attemptId: string,
    event: AgentProviderEvent,
    activityIds: Set<string>,
  ): Promise<void> {
    const identity = {
      agentId: admission.agentId,
      attemptId,
      ...(admission.phaseId === undefined ? {} : { phaseId: admission.phaseId }),
    }

    if (event.type === 'session.started') {
      // Capture the session immediately, not only at successful completion. A killed process may
      // have created a perfectly resumable Codex thread before the turn was interrupted.
      admission.journalRun.recordProviderSession(admission.journalMiss, event.session)
      await this.#emit({
        type: 'agent.session.started',
        ...identity,
        payload: { session: event.session },
      })
      return
    }
    if (event.type === 'warning') {
      await this.#emit({
        type: 'warning',
        ...identity,
        payload: {
          message: event.message,
          ...(event.code === undefined ? {} : { code: event.code }),
        },
      })
      return
    }

    if (event.type === 'activity.started') {
      if (activityIds.has(event.activity.id)) return
      activityIds.add(event.activity.id)
      await this.#emit({
        type: 'agent.activity.started',
        ...identity,
        payload: { activity: activityDetails(event.activity, this.#limits) },
      })
      return
    }

    if (!activityIds.has(event.type === 'activity.updated' ? event.activityId : event.activity.id)) {
      const activity = event.type === 'activity.updated'
        ? {
            id: event.activityId,
            kind: event.patch.kind ?? 'message',
            ...(event.patch.title === undefined ? {} : { title: event.patch.title }),
            ...(event.patch.content === undefined ? {} : { content: event.patch.content }),
          } satisfies AgentProviderActivity
        : event.activity
      activityIds.add(activity.id)
      await this.#emit({
        type: 'agent.activity.started',
        ...identity,
        payload: { activity: activityDetails(activity, this.#limits) },
      })
    }

    if (event.type === 'activity.updated') {
      await this.#emit({
        type: 'agent.activity.updated',
        ...identity,
        payload: {
          activityId: event.activityId,
          ...(event.patch.title === undefined ? {} : { title: event.patch.title }),
          ...(event.patch.content === undefined
            ? {}
            : { content: contentReference(event.patch.content, this.#limits) }),
        },
      })
      return
    }

    await this.#emit({
      type: 'agent.activity.completed',
      ...identity,
      payload: {
        activityId: event.activity.id,
        ...(event.activity.title === undefined ? {} : { title: event.activity.title }),
        ...(event.activity.content === undefined
          ? {}
          : { content: contentReference(event.activity.content, this.#limits) }),
        ...(event.activity.kind === 'error'
          ? { error: errorReference(String(event.activity.content ?? event.activity.title ?? 'Provider activity failed')) }
          : {}),
      },
    })
  }

  async #executeNestedWorkflow(
    worker: WorkflowWorkerHandle,
    request: Extract<WorkerToParentMessage, { type: 'workflow.request' }>,
    depth: number,
  ): Promise<void> {
    if (this.#controller.signal.aborted) {
      throw new WorkflowCancelledError(abortReason(this.#controller.signal))
    }
    if (depth >= 1) {
      throw new WorkflowExecutionError('nested-depth', 'A child workflow cannot invoke another workflow')
    }
    const resolver = this.#options.resolveWorkflow ?? defaultWorkflowResolver
    const workflow = await resolver(request.target, this.#options.cwd)
    if (this.#controller.signal.aborted) {
      throw new WorkflowCancelledError(abortReason(this.#controller.signal))
    }
    const count = (this.#childCounts.get(workflow.meta.name) ?? 0) + 1
    this.#childCounts.set(workflow.meta.name, count)
    const title = `workflow:${workflow.meta.name}${count === 1 ? '' : ` #${count}`}`
    const phaseId = await this.#ensurePhase(title, 'runtime')
    const phase = this.#phaseRuntime.get(phaseId)
    if (phase && !phase.entered) {
      phase.entered = true
      await this.#emit({
        type: 'phase.entered',
        phaseId,
        payload: { title },
      })
    }
    // A child has its own source compatibility boundary. Reusing the parent's chain lets an
    // unchanged parent replay stale child results after the child file changes. The deterministic
    // invocation suffix also keeps two calls to the same child from overwriting each other's run.
    const childJournalRun = this.#journal.beginRun({
      workflowId: `${workflowIdentity(this.#options.workflow)}::${workflowIdentity(workflow)}#${count}`,
      sourceHash: workflow.sourceHash,
    }, {
      reuseMode: this.#options.journalReuseMode ?? 'longest-prefix',
      reuseCoverageGaps: this.#options.reuseCoverageGaps ?? false,
    })
    const result = await this.#executeWorker({
      workflow,
      ...(request.args === undefined ? {} : { args: request.args }),
      depth: depth + 1,
      journalRun: childJournalRun,
      forcedPhaseId: phaseId,
      logPrefix: `[${workflow.meta.name}] `,
    })
    await this.#sealPhase(phaseId)
    this.#completeWorkerRequest(worker, request.requestId, {
      type: 'workflow.result',
      requestId: request.requestId,
      result: { type: 'success', value: result },
      budgetSpent: this.#budgetSpent,
    })
  }

  #replyAgentError(worker: WorkflowWorkerHandle, requestId: string, error: unknown): void {
    this.#completeWorkerRequest(worker, requestId, {
      type: 'agent.result',
      requestId,
      result: { type: 'error', error: serializeWorkerError(error) },
      budgetSpent: this.#budgetSpent,
    })
  }

  #markWorkerRequest(worker: WorkflowWorkerHandle, requestId: string): void {
    const existing = this.#pendingWorkerRequests.get(worker)
    if (existing) existing.add(requestId)
    else this.#pendingWorkerRequests.set(worker, new Set([requestId]))
  }

  /**
   * Persist one agent's value and return the locator-bearing reference, or undefined.
   *
   * Every failure path returns undefined rather than throwing. That is the entire point: this runs
   * inside the success path of an agent that has already produced a validated value and already
   * recorded it in the journal. Letting a full disk, a read-only artifacts directory, or a lone
   * surrogate that cannot survive UTF-8 fail the agent would convert an inspection convenience into
   * a cause of coverage gaps — at agent 147 of 200, with retry amplification behind it.
   *
   * The corresponding read path falls back to the journal, so an absent artifact costs speed, never
   * access.
   */
  async #materializeAgentResult(
    agentId: string,
    value: unknown,
  ): Promise<ContentReference | undefined> {
    if (this.#options.materializeAgentResult === undefined) return undefined
    const materialization = workflowResultMaterialization(value, this.#limits)
    let reference: ContentReference
    try {
      reference = await this.#options.materializeAgentResult(agentId, materialization)
    } catch (cause) {
      console.warn(`[workflow-mcp] Cannot persist agent result artifact for ${agentId}:`, cause)
      return undefined
    }
    if (reference.artifactId === undefined) return reference
    try {
      await this.#emit({
        type: 'artifact.created',
        agentId,
        payload: {
          artifactId: reference.artifactId,
          name: reference.mediaType === 'application/json'
            ? `agent-${agentId}.json`
            : `agent-${agentId}.txt`,
          ...(reference.mediaType === undefined ? {} : { mediaType: reference.mediaType }),
          ...(reference.sizeBytes === undefined ? {} : { sizeBytes: reference.sizeBytes }),
        },
      })
    } catch (cause) {
      // The bytes are already durable; only the discovery record failed. The result read resolves
      // artifacts from the artifact metadata itself, not from this event, so the locator on the
      // returned reference stays truthful.
      console.warn(`[workflow-mcp] Cannot publish agent artifact record for ${agentId}:`, cause)
    }
    return reference
  }

  #completeWorkerRequest(
    worker: WorkflowWorkerHandle,
    requestId: string,
    message: ParentToWorkerMessage,
  ): void {
    const pending = this.#pendingWorkerRequests.get(worker)
    pending?.delete(requestId)
    if (pending?.size === 0) this.#pendingWorkerRequests.delete(worker)
    this.#send(worker, message)
  }

  #send(worker: WorkflowWorkerHandle, message: ParentToWorkerMessage): void {
    worker.postMessage(message)
  }

  #sendBestEffort(worker: WorkflowWorkerHandle, message: ParentToWorkerMessage): void {
    try {
      worker.postMessage(message)
    } catch {
      // WHY cancellation uses a separate send path: an Electron UtilityProcess can exit between
      // isRunning() and postMessage(). That race is evidence the worker is already gone, not a
      // reason to reject the cancellation supervisor before provider escalation and result
      // settlement execute.
    }
  }

  async #sealPhase(phaseId: string): Promise<void> {
    const phase = this.#phaseRuntime.get(phaseId)
    if (!phase || phase.terminal) return
    phase.sealed = true
    await this.#completePhaseIfReady(phaseId, phase)
  }

  async #recordAgentTerminal(agentId: string): Promise<void> {
    if (this.#terminalAgents.has(agentId)) return
    this.#terminalAgents.add(agentId)
    const phaseId = this.#agentPhase.get(agentId)
    if (!phaseId) return
    const phase = this.#phaseRuntime.get(phaseId)
    if (!phase || phase.terminal) return
    phase.activeAgents = Math.max(0, phase.activeAgents - 1)
    if (phase.sealed && phase.activeAgents === 0) {
      // We are already executing inside the serialized emit tail, so publishing directly preserves
      // event order without recursively waiting on the tail that currently owns this callback.
      phase.terminal = true
      await this.#publishDraft({
        type: 'phase.completed',
        phaseId,
        payload: { title: phase.title },
      })
    }
  }

  async #completePhaseIfReady(phaseId: string, phase: PhaseRuntimeState): Promise<void> {
    if (!phase.entered || !phase.sealed || phase.activeAgents > 0 || phase.terminal) return
    phase.terminal = true
    await this.#emit({
      type: 'phase.completed',
      phaseId,
      payload: { title: phase.title },
    })
  }

  async #failOpenPhases(error: unknown): Promise<void> {
    const reference = errorReference(error)
    for (const [phaseId, phase] of this.#phaseRuntime) {
      if (!phase.entered || phase.terminal) continue
      phase.terminal = true
      await this.#emit({
        type: 'phase.failed',
        phaseId,
        payload: { title: phase.title, error: reference },
      })
    }
  }

  #trackTask(task: Promise<void>): void {
    // Promise.prototype.finally() creates a second rejected promise. Dropping that derived promise
    // produced process-level unhandled rejections even when the original task had a caller. This
    // tracked wrapper both owns background failures and removes itself from the cancellation set.
    const tracked = task
      .catch(async (error: unknown) => {
        // WHY the failing wrapper leaves the set before entering #fail: #fail drains every tracked
        // task as an ownership barrier. Including the promise currently awaiting #fail creates a
        // self-dependency, forcing every background failure to consume the full escalation timeout.
        this.#tasks.delete(tracked)
        try {
          await this.#fail(error)
        } catch {
          // #fail always settles the public result in a finally block; an event-sink failure must
          // not escape as a second, unobservable background rejection.
        }
      })
      .finally(() => this.#tasks.delete(tracked))
    this.#tasks.add(tracked)
  }

  #observeScheduler(snapshot: SchedulerSnapshot): void {
    const underfilled =
      !this.#terminal &&
      snapshot.active > 0 &&
      snapshot.active < snapshot.capacity &&
      snapshot.queued === 0 &&
      this.#agentSequence >= snapshot.capacity
    if (!underfilled) {
      if (this.#underutilizationTimer) clearTimeout(this.#underutilizationTimer)
      this.#underutilizationTimer = undefined
      this.#lastUnderutilizationSignature = undefined
      return
    }

    const signature = `${snapshot.active}/${snapshot.capacity}/${this.#agentSequence}`
    if (this.#underutilizationTimer && this.#lastUnderutilizationSignature === signature) return
    if (this.#underutilizationTimer) clearTimeout(this.#underutilizationTimer)
    this.#lastUnderutilizationSignature = signature
    this.#underutilizationTimer = setTimeout(() => {
      this.#underutilizationTimer = undefined
      const current = this.#runScheduler.snapshot()
      if (
        this.#terminal ||
        current.active === 0 ||
        current.active >= current.capacity ||
        current.queued > 0
      ) return
      // WHY this warning does not claim there is a scheduler bug: at this point the scheduler has
      // spare permits and no queued requests. The usual cause is workflow-authored chunking such as
      // awaiting Promise.all(batchOfNine) before creating the next batch. Runtime JavaScript cannot
      // safely execute code past that await, but it can make the hidden barrier explicit instead of
      // leaving operators wondering why only two of nine slots are occupied.
      void this.#emit({
        type: 'warning',
        payload: {
          code: 'workflow-capacity-unfilled-no-runnable-work',
          message: `Provider capacity is ${current.active}/${current.capacity} with no admitted work waiting; a workflow batch barrier may be hiding later tasks`,
          details: {
            active: current.active,
            capacity: current.capacity,
            queued: current.queued,
            admittedAgents: this.#agentSequence,
          },
        },
      }).catch(() => undefined)
    }, this.#reliability.underutilizationWarningMs)
    this.#underutilizationTimer.unref?.()
  }
}

export function runWorkflow(options: RunWorkflowOptions): WorkflowRun {
  const runtime = new WorkflowRuntime(options)
  const handle = runtime.publicHandle()
  runtime.start()
  return handle
}

async function defaultWorkflowResolver(
  target: WorkerWorkflowTarget,
  cwd: string,
): Promise<LoadedWorkflow> {
  if (typeof target !== 'string') return loadWorkflowFile(target.scriptPath)
  const found = await findWorkflows({ cwd })
  const workflow = found.workflows.find((candidate) => candidate.meta.name === target)
  if (!workflow) {
    throw new WorkflowExecutionError('workflow-not-found', `Workflow ${JSON.stringify(target)} was not found`)
  }
  return workflow
}

function normalizeLimits(overrides: Partial<WorkflowLimits> | undefined): WorkflowLimits {
  const result = { ...DEFAULT_LIMITS, ...overrides }
  for (const [name, value] of Object.entries(result)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`Workflow limit ${name} must be a positive safe integer`)
    }
  }
  return result
}

function workflowIdentity(workflow: LoadedWorkflow): string {
  return workflow.filePath ?? workflow.meta.name
}

function stableWorkspaceId(workflowId: string, journalKey: string): string {
  // The chained journal key is stable across retry and longest-prefix resume. Hashing the workflow
  // namespace alongside it avoids leaking absolute paths into directory names while preventing two
  // unrelated workflows with the same first prompt from claiming one durable worktree lease.
  return `workspace_${createHash('sha256').update(`${workflowId}\0${journalKey}`).digest('hex').slice(0, 24)}`
}

function validateBudget(value: number | null | undefined): void {
  if (value === undefined || value === null) return
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('Workflow budgetTokens must be a non-negative safe integer, null, or undefined')
  }
}

function normalizeSandbox(overrides: Partial<AgentSandboxPolicy> | undefined): AgentSandboxPolicy {
  const result: AgentSandboxPolicy = {
    ...DEFAULT_SANDBOX,
    ...overrides,
    ...(overrides?.additionalWritableDirectories === undefined
      ? {}
      : { additionalWritableDirectories: [...overrides.additionalWritableDirectories] }),
  }
  if (!['read-only', 'workspace-write', 'danger-full-access'].includes(result.mode)) {
    throw new TypeError(`Unsupported sandbox mode ${JSON.stringify(result.mode)}`)
  }
  if (!['never', 'on-request', 'on-failure', 'untrusted'].includes(result.approvalPolicy)) {
    throw new TypeError(`Unsupported approval policy ${JSON.stringify(result.approvalPolicy)}`)
  }
  return result
}

function normalizeAgentOptions(
  options: WorkerAgentOptions,
  run: RunWorkflowOptions,
  sandbox: AgentSandboxPolicy,
  limits: WorkflowLimits,
): NormalizedAgentOptions {
  const effort = options.effort !== undefined && VALID_EFFORTS.has(options.effort)
    ? options.effort
    : run.defaultEffort
  const requestedModel = options.model ?? run.defaultModel
  const mappedModel = requestedModel === undefined
    ? undefined
    : Object.prototype.hasOwnProperty.call(run.modelAliases ?? {}, requestedModel)
      ? run.modelAliases?.[requestedModel] ?? undefined
      : requestedModel
  return {
    ...(options.schema === undefined ? {} : { schema: cloneBoundaryValue(options.schema, limits) }),
    ...(mappedModel === undefined ? {} : { model: mappedModel }),
    ...(effort === undefined ? {} : { effort }),
    ...(options.agentType === undefined ? {} : { agentType: options.agentType }),
    ...(options.isolation === undefined ? {} : { isolation: options.isolation }),
    workingDirectory: resolve(run.cwd),
    sandbox,
  }
}

function workerLimits(limits: WorkflowLimits): WorkflowWorkerLimits {
  return {
    maxCollectionItems: limits.maxCollectionItems,
    maxLogCharacters: limits.maxLogCharacters,
    maxValueDepth: limits.maxValueDepth,
    maxValueNodes: limits.maxValueNodes,
    synchronousTimeoutMs: limits.synchronousTimeoutMs,
  }
}

function workerFilePath(): string {
  const adjacent = fileURLToPath(new URL('./workflowWorker.js', import.meta.url))
  if (existsSync(adjacent)) return adjacent
  const sourceDirectory = dirname(fileURLToPath(import.meta.url))
  const built = resolve(sourceDirectory, '..', 'dist', 'workflowWorker.js')
  if (existsSync(built)) return built
  throw new WorkflowExecutionError(
    'worker-missing',
    'workflowWorker.js is missing; run the package build before executing workflows',
  )
}

function minimalWorkerEnvironment(): NodeJS.ProcessEnv {
  // The workflow VM is not allowed to inherit API keys, cloud credentials, or provider tokens.
  // Windows needs its system-root variables to start some native processes; the worker itself
  // launches none, but preserving those OS-only values keeps Node startup portable.
  const env: NodeJS.ProcessEnv = {}
  for (const name of ['SYSTEMROOT', 'WINDIR']) {
    if (process.env[name] !== undefined) env[name] = process.env[name]
  }
  return env
}

function encodeWorkflowArgs(value: unknown, limits: WorkflowLimits): string | undefined {
  if (value === undefined) return undefined
  return JSON.stringify(cloneBoundaryValue(value, limits))
}

function cloneBoundaryValue(value: unknown, limits: WorkflowLimits = DEFAULT_LIMITS): unknown {
  const seen = new Set<object>()
  let nodes = 0

  const visit = (current: unknown, depth: number, arraySlot: boolean): unknown => {
    nodes += 1
    if (nodes > limits.maxValueNodes) throw new TypeError('Workflow value contains too many nodes')
    if (depth > limits.maxValueDepth) throw new TypeError('Workflow value is nested too deeply')
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return current
    if (typeof current === 'number') return Number.isFinite(current) ? current : null
    if (typeof current === 'undefined' || typeof current === 'function' || typeof current === 'symbol') {
      return arraySlot ? null : undefined
    }
    if (typeof current === 'bigint') throw new TypeError('Workflow values cannot contain bigint')
    if (seen.has(current)) throw new TypeError('Workflow values cannot contain cycles')
    seen.add(current)
    try {
      if (Array.isArray(current)) {
        if (current.length > limits.maxCollectionItems) {
          throw new TypeError(`Workflow array exceeds ${limits.maxCollectionItems} entries`)
        }
        return current.map((entry) => visit(entry, depth + 1, true))
      }
      if (Object.prototype.toString.call(current) === '[object Date]') {
        return (current as Date).toISOString()
      }
      const result = Object.create(null) as Record<string, unknown>
      for (const key of Object.keys(current)) {
        if (BLOCKED_VALUE_KEYS.has(key)) {
          throw new TypeError(`Workflow value contains blocked key ${JSON.stringify(key)}`)
        }
        const entry = visit((current as Record<string, unknown>)[key], depth + 1, false)
        if (entry !== undefined) result[key] = entry
      }
      return result
    } finally {
      seen.delete(current)
    }
  }

  const cloned = visit(value, 0, false)
  if (cloned === undefined && value !== undefined) {
    throw new TypeError('Value cannot cross the workflow execution boundary')
  }
  return cloned
}

function contentReference(value: unknown, limits: WorkflowLimits = DEFAULT_LIMITS): ContentReference {
  return workflowResultMaterialization(value, limits).reference
}

function workflowResultMaterialization(
  value: unknown,
  limits: WorkflowLimits = DEFAULT_LIMITS,
): WorkflowResultMaterialization {
  const cloned = cloneBoundaryValue(value, limits)
  // `undefined` is a valid JavaScript workflow result even though JSON has no spelling for it.
  // Giving it an explicit preview keeps list UIs useful while leaving `content` absent rather than
  // lying by coercing the actual result to null.
  const serialized = serializeWorkflowValue(cloned)
  const full = serialized.content
  const previewLimit = Math.min(4_000, limits.maxLogCharacters)
  const contentWasCapped = full.length > limits.maxLogCharacters

  // WHY the cap belongs here rather than in `cloneBoundaryValue`: boundary cloning also carries
  // execution values into workers and journals, where truncation would silently change workflow
  // semantics. A ContentReference is an observability/display record. Retaining a megabyte-scale
  // command result in it defeats the advertised limit, bloats every durable event replay, and can
  // make Electron structured-clone plus DOM text layout monopolize the renderer. The exact value
  // remains available to execution and journal reuse; only this display copy becomes bounded.
  const retainedContent = contentWasCapped ? full.slice(0, limits.maxLogCharacters) : cloned
  return {
    serializedContent: full,
    reference: {
      preview: full.slice(0, previewLimit),
      lineCount: countLines(full),
      ...(cloned === undefined ? {} : { content: retainedContent }),
      // Media type describes the complete value behind the reference, not the bounded inline
      // prefix. A clipped JSON prefix is not independently parseable, but callers can now follow
      // its artifactId and concatenate pages into the advertised application/json document.
      mediaType: serialized.mediaType,
      // `preview` is always allowed to be shorter than complete inline `content`. `truncated`
      // specifically means the inline content is incomplete and the artifact must be followed;
      // conflating those two states made 4-10 KB values look irrecoverably clipped when they were
      // actually present in full.
      ...(contentWasCapped ? { truncated: true } : {}),
    },
  }
}

function countLines(value: string): number {
  if (value.length === 0) return 0
  let count = 1
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 10) count += 1
  }
  return count
}

function activityDetails(activity: AgentProviderActivity, limits: WorkflowLimits) {
  return {
    activityId: activity.id,
    kind: activity.kind,
    ...(activity.title === undefined ? {} : { title: activity.title }),
    ...(activity.content === undefined
      ? {}
      : { content: contentReference(activity.content, limits) }),
  }
}

function errorReference(error: unknown): WorkflowErrorReference {
  if (error instanceof Error) {
    const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined
    return {
      name: error.name,
      message: error.message,
      ...(code === undefined ? {} : { code }),
      ...(error.stack === undefined ? {} : { stack: error.stack }),
    }
  }
  return { message: typeof error === 'string' ? error : String(error) }
}

function recoveryContext(error: AgentProviderFailure, previousAttemptNumber: number): AgentRecoveryContext {
  const lastProgressAt = error instanceof AgentAttemptTimeoutError
    ? error.lastProgressAt
    : new Date().toISOString()
  const uncertain = error instanceof AgentAttemptTimeoutError
    ? error.uncertainInFlightActivity
    : undefined
  const uncertainInFlightActivity = uncertain === undefined
    ? undefined
    : {
        id: uncertain.id,
        kind: uncertain.kind,
        ...(uncertain.title === undefined ? {} : { title: uncertain.title }),
      }
  const uncertaintyLine = uncertainInFlightActivity === undefined
    ? 'No specific in-flight activity was recorded; inspect the current thread and repository state before acting.'
    : `The last open activity was ${uncertainInFlightActivity.kind} ${JSON.stringify(uncertainInFlightActivity.title ?? uncertainInFlightActivity.id)}; its completion is uncertain.`
  const note = [
    'Your previous turn was interrupted after the last recorded activity.',
    'Continue the same assignment from the current repository and thread state.',
    'Inspect existing state before acting. Do not repeat completed external actions.',
    `Interruption reason: ${error.message}`,
    `Previous physical attempt: ${previousAttemptNumber}. Last recorded progress: ${lastProgressAt}.`,
    uncertaintyLine,
    'Finish the assignment and return the requested output schema only.',
  ].join(' ')
  return {
    reason: error.message,
    previousAttemptNumber,
    lastProgressAt,
    ...(uncertainInFlightActivity === undefined ? {} : { uncertainInFlightActivity }),
    note,
  }
}

function workerError(error: SerializedWorkerError): Error {
  const result = new Error(error.message)
  result.name = error.name
  if (error.stack !== undefined) result.stack = error.stack
  if (error.code !== undefined) Object.assign(result, { code: error.code })
  return result
}

function fallbackLabel(prompt: string): string {
  return prompt.replace(/\s+/g, ' ').trim().slice(0, 60)
}

function abortReason(signal: AbortSignal): string {
  if (signal.reason instanceof Error && signal.reason.message.length > 0) return signal.reason.message
  if (typeof signal.reason === 'string' && signal.reason.length > 0) return signal.reason
  return 'Workflow cancelled'
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new WorkflowCancelledError(abortReason(signal)))
  return new Promise((resolveDelay, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolveDelay()
    }, milliseconds)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new WorkflowCancelledError(abortReason(signal)))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

type PromiseSettlement<T> =
  | { status: 'fulfilled'; value: T }
  | { status: 'rejected'; reason: unknown }

async function settlementWithin<T>(
  promise: Promise<T>,
  milliseconds: number,
): Promise<PromiseSettlement<T> | undefined> {
  const sentinel = { timeout: true } as const
  const outcome = await Promise.race([
    promise.then(
      (value): PromiseSettlement<T> => ({ status: 'fulfilled', value }),
      (reason: unknown): PromiseSettlement<T> => ({ status: 'rejected', reason }),
    ),
    delay(milliseconds).then(() => sentinel),
  ])
  return 'timeout' in outcome ? undefined : outcome
}

function abortRejection(signal: AbortSignal): { promise: Promise<never>; dispose(): void } {
  let rejectAbort!: (error: unknown) => void
  const promise = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
  const onAbort = (): void => rejectAbort(
    signal.reason instanceof Error
      ? signal.reason
      : new WorkflowCancelledError(abortReason(signal)),
  )
  if (signal.aborted) onAbort()
  else signal.addEventListener('abort', onAbort, { once: true })
  // Promise.race observes this rejection during normal execution. The explicit handler also makes
  // disposal safe when the provider wins and a much later run cancellation fires after the race's
  // caller has already returned.
  void promise.catch(() => undefined)
  return {
    promise,
    dispose: () => signal.removeEventListener('abort', onAbort),
  }
}

async function withDeadline<T>(operation: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new WorkflowExecutionError('operation-timeout', message))
    }, milliseconds)
    timer.unref?.()
  })
  try {
    return await Promise.race([operation, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function linkedTimeoutController(
  parent: AbortSignal | undefined,
  milliseconds: number,
  message: string,
): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController()
  const onParentAbort = (): void => controller.abort(parent?.reason)
  if (parent?.aborted) onParentAbort()
  else parent?.addEventListener('abort', onParentAbort, { once: true })
  const timer = setTimeout(() => {
    controller.abort(new WorkflowExecutionError('operation-timeout', message))
  }, milliseconds)
  timer.unref?.()
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer)
      parent?.removeEventListener('abort', onParentAbort)
    },
  }
}
