import { randomUUID } from 'node:crypto'
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
  AgentProviderEvent,
  AgentProviderResult,
  AgentSandboxPolicy,
  ProviderSessionReference,
} from './agentProvider.js'
import { findWorkflows } from './findWorkflows.js'
import { loadWorkflowFile } from './loadWorkflow.js'
import type { LoadedWorkflow } from './loadWorkflow.js'
import { InMemoryWorkflowJournal } from './workflowJournal.js'
import type {
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
} from './workflowEvents.js'
import type {
  ParentToWorkerMessage,
  SerializedWorkerError,
  WorkerAgentOptions,
  WorkerToParentMessage,
  WorkerWorkflowTarget,
  WorkflowWorkerLimits,
} from './workerMessages.js'
import { serializeWorkerError } from './workerMessages.js'
import { NodeWorkflowWorkerLauncher } from './nodeWorkflowWorkerLauncher.js'
import type { WorkflowWorkerHandle, WorkflowWorkerLauncher } from './workerLauncher.js'

export type WorkflowLimits = {
  concurrency: number
  maxAgentCalls: number
  maxCollectionItems: number
  maxLogCharacters: number
  maxValueDepth: number
  maxValueNodes: number
  synchronousTimeoutMs: number
  wallClockTimeoutMs: number
  cancellationGraceMs: number
}

export type WorkflowResolver = (
  target: WorkerWorkflowTarget,
  cwd: string,
) => Promise<LoadedWorkflow>

export type PreparedWorkingDirectory = {
  path: string
  cleanup?(): Promise<void | { preservedPath: string }>
}

export type WorkingDirectoryPreparer = (input: {
  baseDirectory: string
  isolation: string
  runId: string
  agentId: string
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
  resolveWorkflow?: WorkflowResolver
  resolveAgentType?(name: string): Promise<string | undefined>
  prepareWorkingDirectory?: WorkingDirectoryPreparer
  defaultModel?: string
  /** Host-owned portable-name mapping; null selects the provider's configured default model. */
  modelAliases?: Readonly<Record<string, string | null>>
  defaultEffort?: string
  sandbox?: Partial<AgentSandboxPolicy>
  eventSink?: WorkflowEventSink
  signal?: AbortSignal
  workerLauncher?: WorkflowWorkerLauncher
  workerFilePath?: string
}

export type WorkflowRun = {
  id: string
  events: AsyncIterable<WorkflowEvent>
  result: Promise<unknown>
  cancel(reason?: string): Promise<void>
}

export class WorkflowCancelledError extends Error {
  constructor(message = 'Workflow cancelled') {
    super(message)
    this.name = 'AbortError'
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
  wallClockTimeoutMs: 60 * 60 * 1_000,
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
  attemptId: string
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
  readonly #events: WorkflowEvent[] = []
  readonly #waiters = new Set<() => void>()
  #closed = false

  publish(event: WorkflowEvent): void {
    if (this.#closed) return
    this.#events.push(event)
    for (const wake of this.#waiters) wake()
    this.#waiters.clear()
  }

  close(): void {
    this.#closed = true
    for (const wake of this.#waiters) wake()
    this.#waiters.clear()
  }

  [Symbol.asyncIterator](): AsyncIterator<WorkflowEvent> {
    let cursor = 0
    return {
      next: async (): Promise<IteratorResult<WorkflowEvent>> => {
        while (cursor >= this.#events.length && !this.#closed) {
          await new Promise<void>((resolveWait) => this.#waiters.add(resolveWait))
        }
        const event = this.#events[cursor]
        if (event !== undefined) {
          cursor += 1
          return { done: false, value: event }
        }
        return { done: true, value: undefined }
      },
    }
  }
}

type SemaphoreWaiter = {
  resolve(release: () => void): void
  reject(error: unknown): void
  signal: AbortSignal
  onAbort(): void
}

class Semaphore {
  readonly #limit: number
  readonly #waiters: SemaphoreWaiter[] = []
  #active = 0

  constructor(limit: number) {
    this.#limit = limit
  }

  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(new WorkflowCancelledError(abortReason(signal)))
    if (this.#active < this.#limit) {
      this.#active += 1
      return Promise.resolve(this.#releaseOnce())
    }

    return new Promise((resolveAcquire, reject) => {
      const waiter: SemaphoreWaiter = {
        resolve: resolveAcquire,
        reject,
        signal,
        onAbort: () => {
          const index = this.#waiters.indexOf(waiter)
          if (index !== -1) this.#waiters.splice(index, 1)
          reject(new WorkflowCancelledError(abortReason(signal)))
        },
      }
      signal.addEventListener('abort', waiter.onAbort, { once: true })
      this.#waiters.push(waiter)
    })
  }

  #releaseOnce(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      this.#release()
    }
  }

  #release(): void {
    const waiter = this.#waiters.shift()
    if (!waiter) {
      this.#active -= 1
      return
    }
    waiter.signal.removeEventListener('abort', waiter.onAbort)
    waiter.resolve(this.#releaseOnce())
  }
}

class WorkflowRuntime {
  readonly id: string
  readonly #options: RunWorkflowOptions
  readonly #limits: WorkflowLimits
  readonly #sandbox: AgentSandboxPolicy
  readonly #stream = new WorkflowEventStream()
  readonly #result = deferred<unknown>()
  readonly #controller = new AbortController()
  readonly #scheduler: Semaphore
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
  readonly #warnedModelAliases = new Set<string>()
  #eventSequence = 0
  #phaseSequence = 0
  #agentSequence = 0
  #budgetSpent = 0
  #terminal = false
  #failing = false
  #terminalOwner: 'completion' | 'failure' | 'cancellation' | undefined
  #emitTail: Promise<void> = Promise.resolve()
  #cancelPromise: Promise<void> | undefined
  #wallClockTimer: NodeJS.Timeout | undefined

  constructor(options: RunWorkflowOptions) {
    this.id = options.runId ?? `run_${randomUUID()}`
    this.#options = options
    this.#limits = normalizeLimits(options.limits)
    // Large Claude workflows legitimately park more than Node's default ten cancellation
    // listeners on one run signal (semaphore waiters, providers, and timers). Bound the diagnostic
    // threshold by the already-enforced admission limit so Node 20 does not report a false leak
    // while still warning if listener growth somehow exceeds the maximum logical work of the run.
    setMaxListeners(this.#limits.maxAgentCalls + 10, this.#controller.signal)
    validateBudget(options.budgetTokens)
    this.#sandbox = normalizeSandbox(options.sandbox)
    this.#scheduler = new Semaphore(this.#limits.concurrency)
    const journal = options.journal ?? new InMemoryWorkflowJournal()
    this.#journal = journal
    this.#journalRun = journal.beginRun({
      workflowId: workflowIdentity(options.workflow),
      sourceHash: options.workflow.sourceHash,
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
    }
  }

  start(): void {
    void this.#run()
  }

  async cancel(reason = 'Workflow cancelled'): Promise<void> {
    if (this.#terminal) return
    if (this.#cancelPromise) return this.#cancelPromise
    this.#cancelPromise = this.#cancel(reason)
    return this.#cancelPromise
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

      this.#wallClockTimer = setTimeout(() => {
        void this.cancel(`Workflow exceeded ${this.#limits.wallClockTimeoutMs}ms wall-clock limit`)
      }, this.#limits.wallClockTimeoutMs)

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
      if (!this.#claimTerminal('completion')) return

      await this.#emit({
        type: 'run.completed',
        payload: { result: contentReference(result, this.#limits) },
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
        if (!this.#cancelPromise) await this.cancel(abortReason(this.#controller.signal))
        return
      }
      if (this.#failing) return
      await this.#fail(error)
    }
  }

  async #cancel(reason: string): Promise<void> {
    if (this.#terminal) return
    if (!this.#claimTerminal('cancellation')) return

    // Abort first. Event sinks are external code and may be slow or wedged; they must never delay
    // stopping credentialed provider work after the user or wall-clock limit requested cancel.
    if (!this.#controller.signal.aborted) {
      this.#controller.abort(new WorkflowCancelledError(reason))
    }
    this.#clearWallClockTimer()
    for (const worker of this.#workers) this.#send(worker, { type: 'cancel', reason })

    try {
      await this.#emit({
        type: 'run.cancellation_requested',
        payload: reason.length === 0 ? {} : { reason },
      })
    } catch {
      // A sink failure must not prevent aborting native provider and worker processes.
    }

    await Promise.race([
      Promise.allSettled([...this.#tasks]),
      delay(this.#limits.cancellationGraceMs),
    ])
    await this.#killWorkers()

    await this.#failOpenPhases(new WorkflowCancelledError(reason))

    try {
      await this.#emit({
        type: 'run.cancelled',
        payload: reason.length === 0 ? {} : { reason },
      })
    } finally {
      this.#terminal = true
      this.#result.reject(new WorkflowCancelledError(reason))
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
    for (const worker of this.#workers) this.#send(worker, { type: 'cancel', reason: 'Workflow failed' })
    // Cooperative providers should publish their agent terminal event before run.failed closes the
    // stream. The bound also covers the rare case where this failure originated inside a tracked
    // task and waiting for every task would otherwise include the caller itself.
    await Promise.race([
      Promise.allSettled([...this.#tasks]),
      delay(this.#limits.cancellationGraceMs),
    ])
    await this.#killWorkers()
    const reference = errorReference(error)

    await this.#failOpenPhases(error)

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
    if (!this.#wallClockTimer) return
    clearTimeout(this.#wallClockTimer)
    this.#wallClockTimer = undefined
  }

  #claimTerminal(owner: 'completion' | 'failure' | 'cancellation'): boolean {
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
        draft.type === 'agent.failed' ||
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
      this.#eventSequence += 1
      const event = {
        ...draft,
        schemaVersion: 1,
        runId: this.id,
        sequence: this.#eventSequence,
        eventId: `event_${randomUUID()}`,
        timestamp: new Date().toISOString(),
      } as WorkflowEvent
      await this.#options.eventSink?.(event)
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

    const removeMessageListener = worker.onMessage((raw: WorkerToParentMessage) => {
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
              limits: workerLimits(this.#limits),
            })
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

    this.#agentSequence += 1
    const agentId = `agent_${this.#agentSequence}`
    const attemptId = `${agentId}_attempt_1`
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

    if (decision.reused) {
      const value = cloneBoundaryValue(decision.result, this.#limits)
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
        },
      })
      this.#send(input.worker, {
        type: 'agent.result',
        requestId: input.request.requestId,
        result: { type: 'success', value },
        budgetSpent: this.#budgetSpent,
      })
      return
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

    if (
      this.#options.budgetTokens !== undefined &&
      this.#options.budgetTokens !== null &&
      this.#budgetSpent >= this.#options.budgetTokens
    ) {
      // Claude exposes this pool as a hard output-token ceiling. Returning null here used to make a
      // sequential workflow silently continue with missing data, which is materially different
      // from Claude's catchable throw and made `budget.remaining()` guards impossible to trust.
      const budgetError = new WorkflowExecutionError(
        'budget-exhausted',
        `Workflow output-token budget is exhausted (${this.#budgetSpent}/${this.#options.budgetTokens})`,
      )
      await this.#emit({
        type: 'agent.failed',
        agentId,
        ...(phaseId === undefined ? {} : { phaseId }),
        payload: { error: errorReference(budgetError) },
      })
      this.#replyAgentError(input.worker, input.request.requestId, budgetError)
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
      attemptId,
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
    let release: (() => void) | undefined
    let prepared: PreparedWorkingDirectory | undefined
    let providerSession: ProviderSessionReference | undefined
    let attemptStarted = false
    const activityIds = new Set<string>()
    const resumeSession = admission.journalMiss.providerSession?.provider === this.#options.provider.name
      ? admission.journalMiss.providerSession
      : undefined

    try {
      release = await this.#scheduler.acquire(this.#controller.signal)
      if (this.#controller.signal.aborted) throw new WorkflowCancelledError(abortReason(this.#controller.signal))

      let workingDirectory = resolve(this.#options.cwd)
      if (admission.options.isolation === 'worktree') {
        if (!this.#options.prepareWorkingDirectory) {
          throw new WorkflowExecutionError(
            'worktree-unavailable',
            'This workflow requests worktree isolation but no worktree preparer is configured',
          )
        }
        prepared = await this.#options.prepareWorkingDirectory({
          baseDirectory: workingDirectory,
          isolation: 'worktree',
          runId: this.id,
          agentId: admission.agentId,
        })
        if (this.#controller.signal.aborted) throw new WorkflowCancelledError(abortReason(this.#controller.signal))
        workingDirectory = resolve(prepared.path)
      }

      let instructions: string | undefined
      if (admission.options.agentType !== undefined) {
        instructions = await this.#options.resolveAgentType?.(admission.options.agentType)
        if (this.#controller.signal.aborted) throw new WorkflowCancelledError(abortReason(this.#controller.signal))
        if (instructions === undefined) {
          throw new WorkflowExecutionError(
            'agent-type-unavailable',
            `Workflow agent type ${JSON.stringify(admission.options.agentType)} is unavailable`,
          )
        }
      }

      await this.#emit({
        type: 'agent.started',
        agentId: admission.agentId,
        attemptId: admission.attemptId,
        ...(admission.phaseId === undefined ? {} : { phaseId: admission.phaseId }),
        payload: {
          attemptNumber: 1,
          source: resumeSession === undefined ? 'live' : 'provider-resume',
          provider: this.#options.provider.name,
          ...(resumeSession === undefined ? {} : { providerSession: resumeSession }),
        },
      })
      attemptStarted = true

      const result = await this.#options.provider.execute(
        {
          prompt: admission.prompt,
          ...(admission.normalizedOptions.schema === undefined
            ? {}
            : { schema: admission.normalizedOptions.schema }),
          ...(admission.normalizedOptions.model === undefined
            ? {}
            : { model: admission.normalizedOptions.model }),
          ...(admission.normalizedOptions.effort === undefined
            ? {}
            : { effort: admission.normalizedOptions.effort }),
          workingDirectory,
          sandbox: this.#sandbox,
          ...(instructions === undefined ? {} : { instructions }),
          ...(resumeSession === undefined ? {} : { session: resumeSession }),
        },
        {
          signal: this.#controller.signal,
          emit: async (event) => {
            if (event.type === 'session.started') providerSession = event.session
            await this.#emitProviderEvent(admission, event, activityIds)
          },
        },
      )
      if (this.#controller.signal.aborted || this.#terminal) {
        throw new WorkflowCancelledError(abortReason(this.#controller.signal))
      }

      const value = this.#providerValue(result, admission.validateOutput)
      // Claude's budget pool counts generated output only. Input/context tokens may dwarf the
      // actual requested work on resumed threads; charging totalTokens caused identical workflows
      // to stop at wildly different points depending on provider cache state.
      if (result.usage?.outputTokens !== undefined) this.#budgetSpent += result.usage.outputTokens
      admission.journalRun.recordResult(admission.journalMiss, value)
      const completedSession = result.providerSession ?? providerSession

      await this.#emit({
        type: 'agent.completed',
        agentId: admission.agentId,
        attemptId: admission.attemptId,
        ...(admission.phaseId === undefined ? {} : { phaseId: admission.phaseId }),
        payload: {
          source: resumeSession === undefined ? 'live' : 'provider-resume',
          result: contentReference(value, this.#limits),
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
      this.#completeWorkerRequest(admission.worker, admission.requestId, {
        type: 'agent.result',
        requestId: admission.requestId,
        result: { type: 'success', value },
        budgetSpent: this.#budgetSpent,
      })
    } catch (error) {
      // A queued call has a logical agent identity but no provider attempt yet. Attaching the
      // planned attempt ID before agent.started makes the pure projector reference an attempt
      // that never existed, which is especially easy to trigger by cancelling a saturated run.
      const attemptIdentity = attemptStarted ? { attemptId: admission.attemptId } : {}
      if (error instanceof AgentProviderFailure) {
        admission.journalRun.recordResult(admission.journalMiss, null)
        await this.#emit({
          type: 'agent.failed',
          agentId: admission.agentId,
          ...attemptIdentity,
          ...(admission.phaseId === undefined ? {} : { phaseId: admission.phaseId }),
          payload: { error: errorReference(error) },
        })
        await this.#emit({
          type: 'warning',
          agentId: admission.agentId,
          ...attemptIdentity,
          ...(admission.phaseId === undefined ? {} : { phaseId: admission.phaseId }),
          payload: {
            message: error.message,
            ...(error.code === undefined ? {} : { code: error.code }),
          },
        })
        this.#completeWorkerRequest(admission.worker, admission.requestId, {
          type: 'agent.result',
          requestId: admission.requestId,
          result: { type: 'success', value: null },
          budgetSpent: this.#budgetSpent,
        })
      } else if (
        this.#controller.signal.aborted ||
        error instanceof WorkflowCancelledError ||
        error instanceof AgentProviderAbortError
      ) {
        await this.#emit({
          type: 'agent.cancelled',
          agentId: admission.agentId,
          ...attemptIdentity,
          ...(admission.phaseId === undefined ? {} : { phaseId: admission.phaseId }),
          payload: { reason: abortReason(this.#controller.signal) },
        })
        this.#replyAgentError(admission.worker, admission.requestId, error)
      } else {
        await this.#emit({
          type: 'agent.failed',
          agentId: admission.agentId,
          ...attemptIdentity,
          ...(admission.phaseId === undefined ? {} : { phaseId: admission.phaseId }),
          payload: { error: errorReference(error) },
        })
        this.#replyAgentError(admission.worker, admission.requestId, error)
      }
    } finally {
      try {
        const cleanup = await prepared?.cleanup?.()
        if (cleanup?.preservedPath) {
          await this.#emit({
            type: 'warning',
            agentId: admission.agentId,
            ...(attemptStarted ? { attemptId: admission.attemptId } : {}),
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
            ...(attemptStarted ? { attemptId: admission.attemptId } : {}),
            ...(admission.phaseId === undefined ? {} : { phaseId: admission.phaseId }),
            payload: {
              code: 'working-directory-cleanup-failed',
              message: `Failed to clean up isolated working directory: ${error instanceof Error ? error.message : String(error)}`,
            },
          })
        } catch {
          // A failed event sink must not turn cleanup into an unhandled background rejection.
        }
      } finally {
        release?.()
      }
    }
  }

  #providerValue(result: AgentProviderResult, validateOutput: ValidateFunction | undefined): unknown {
    if (validateOutput && result.output.type !== 'structured') {
      throw new TypeError('Agent completed without the required structured output')
    }
    const value = cloneBoundaryValue(
      result.output.type === 'structured' ? result.output.value : result.output.text,
      this.#limits,
    )
    if (validateOutput && !validateOutput(value)) {
      throw new TypeError(`Agent structured output failed schema validation: ${this.#ajv.errorsText(validateOutput.errors)}`)
    }
    return value
  }

  async #emitProviderEvent(
    admission: AgentAdmission,
    event: AgentProviderEvent,
    activityIds: Set<string>,
  ): Promise<void> {
    const identity = {
      agentId: admission.agentId,
      attemptId: admission.attemptId,
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
  const cloned = cloneBoundaryValue(value, limits)
  // `undefined` is a valid JavaScript workflow result even though JSON has no spelling for it.
  // Giving it an explicit preview keeps list UIs useful while leaving `content` absent rather than
  // lying by coercing the actual result to null.
  const full = cloned === undefined
    ? 'undefined'
    : typeof cloned === 'string'
      ? cloned
      : JSON.stringify(cloned, null, 2)
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
    preview: full.slice(0, previewLimit),
    lineCount: countLines(full),
    ...(cloned === undefined ? {} : { content: retainedContent }),
    mediaType: contentWasCapped || typeof cloned === 'string' || cloned === undefined
      ? 'text/plain'
      : 'application/json',
    ...(full.length <= previewLimit ? {} : { truncated: true }),
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

function workerError(error: SerializedWorkerError): Error {
  const result = new Error(error.message)
  result.name = error.name
  if (error.stack !== undefined) result.stack = error.stack
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
