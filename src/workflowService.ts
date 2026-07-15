import { randomUUID } from 'node:crypto'
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
import type { WorkflowLimits, WorkflowRun } from './runWorkflow.js'
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
} from './workflowStore.js'

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
  provider: AgentProvider | (() => AgentProvider)
  workerLauncher?: WorkflowWorkerLauncher
  workerFilePath?: string
  limits?: Partial<WorkflowLimits>
  budgetTokens?: number | null
  defaultModel?: string
  modelAliases?: Readonly<Record<string, string | null>>
  defaultEffort?: string
  sandbox?: Partial<AgentSandboxPolicy>
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
  resumedFromRunId?: string
}

export type WorkflowServiceErrorCode =
  | 'run-not-found'
  | 'scope-forbidden'
  | 'workflow-not-found'
  | 'run-not-resumable'
  | 'service-stopped'
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
  readonly #active = new Map<string, WorkflowRun>()
  readonly #listeners = new Set<WorkflowServiceListener>()
  readonly #waiters = new Map<string, Set<() => void>>()
  readonly #runVersions = new Map<string, number>()
  #initialized = false
  #stopped = false

  constructor(options: WorkflowServiceOptions) {
    this.#options = options
  }

  async initialize(): Promise<void> {
    if (this.#initialized) return
    await this.#options.store.initialize()
    this.#initialized = true

    for (const manifest of await this.#options.store.listManifests()) {
      if (TERMINAL_STATUSES.has(manifest.status)) continue
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
    }
  }

  async stop(reason = 'Workflow service is stopping'): Promise<void> {
    if (this.#stopped) return
    this.#stopped = true
    const runs = [...this.#active.values()]
    await Promise.allSettled(runs.map((run) => run.cancel(reason)))
    this.#active.clear()
    for (const waiters of this.#waiters.values()) for (const wake of waiters) wake()
    this.#waiters.clear()
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
    const existing = input.idempotencyKey === undefined
      ? undefined
      : await this.#options.store.findByIdempotencyKey(resolve(scope.cwd), input.idempotencyKey)
    if (existing) {
      this.#assertScope(scope, existing)
      return startResult(existing)
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
    if ('claudeRunPath' in input) return this.#resumeClaude(scope, input)
    return this.#resumeStored(scope, input)
  }

  async #resumeStored(
    scope: WorkflowServiceScope,
    input: Extract<WorkflowResumeInput, { runId: string }>,
    overrides?: WorkflowStartInput,
  ): Promise<WorkflowRunStartResult> {
    const original = await this.status(scope, input.runId)
    if (!['interrupted', 'failed', 'cancelled'].includes(original.status)) {
      throw new WorkflowServiceError(
        'run-not-resumable',
        `Workflow run ${input.runId} has status ${original.status}`,
      )
    }
    if (input.idempotencyKey !== undefined) {
      const existing = await this.#options.store.findByIdempotencyKey(resolve(scope.cwd), input.idempotencyKey)
      if (existing) return startResult(existing)
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
      if (existing) return startResult(existing)
    }
    const imported = await loadClaudeWorkflowResume(metadataPath, {
      ...(workflowPath === undefined ? {} : { workflowPath }),
    })
    const workflowId = imported.workflow.filePath ?? imported.workflow.meta.name
    const journalSnapshot = imported.journal.getSnapshot(workflowId)
    return this.#startLoaded(scope, imported.workflow, {
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
      resumedFromRunId: imported.metadata.runId,
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
      journalSnapshots?: Parameters<typeof PersistentWorkflowJournal.open>[1]
    },
  ): Promise<WorkflowRunStartResult> {
    const runId = `run_${randomUUID()}`
    let manifest = await this.#options.store.createRun({
      runId,
      cwd: resolve(scope.cwd),
      workflow,
      ...(Object.prototype.hasOwnProperty.call(input, 'args') ? { args: input.args } : {}),
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
      ...(input.resumedFromRunId === undefined ? {} : { resumedFromRunId: input.resumedFromRunId }),
    })
    const journal = await PersistentWorkflowJournal.open(
      this.#options.store.journalPath(runId),
      input.journalSnapshots,
    )
    const provider = typeof this.#options.provider === 'function'
      ? this.#options.provider()
      : this.#options.provider
    const run = runWorkflow({
      runId,
      workflow,
      ...(Object.prototype.hasOwnProperty.call(input, 'args') ? { args: input.args } : {}),
      cwd: resolve(scope.cwd),
      provider,
      journal,
      ...(this.#options.workerLauncher === undefined
        ? {}
        : { workerLauncher: this.#options.workerLauncher }),
      ...(this.#options.workerFilePath === undefined
        ? {}
        : { workerFilePath: this.#options.workerFilePath }),
      ...(this.#options.limits === undefined ? {} : { limits: this.#options.limits }),
      ...(this.#options.budgetTokens === undefined
        ? {}
        : { budgetTokens: this.#options.budgetTokens }),
      ...(this.#options.defaultModel === undefined ? {} : { defaultModel: this.#options.defaultModel }),
      ...(this.#options.modelAliases === undefined ? {} : { modelAliases: this.#options.modelAliases }),
      ...(this.#options.defaultEffort === undefined
        ? {}
        : { defaultEffort: this.#options.defaultEffort }),
      // Read-only is the service default even though the low-level executor remains backwards
      // compatible with its historical workspace-write CLI default. MCP input has no field that
      // can widen this host-owned policy.
      sandbox: {
        mode: 'read-only',
        approvalPolicy: 'never',
        network: false,
        ...this.#options.sandbox,
      },
      eventSink: async (event) => {
        const stored = await this.#options.store.appendEvent(runId, event)
        this.#publish(stored)
      },
    })
    this.#active.set(runId, run)
    void run.result
      .catch(() => undefined)
      .finally(() => this.#active.delete(runId))

    // First event persistence is asynchronous by design; returning queued immediately is what lets
    // an MCP client render a card before the evaluator or provider has completed any work.
    manifest = await this.#options.store.getManifest(runId) ?? manifest
    return startResult(manifest)
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
    if (resolve(scope.cwd) !== manifest.cwd) {
      throw new WorkflowServiceError(
        'scope-forbidden',
        `Workflow run ${manifest.runId} belongs to another project`,
      )
    }
  }

  #assertAvailable(): void {
    if (this.#stopped) throw new WorkflowServiceError('service-stopped', 'Workflow service is stopped')
    if (!this.#initialized) {
      throw new WorkflowServiceError('invalid-request', 'Workflow service must be initialized first')
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

function startResult(manifest: WorkflowRunManifest): WorkflowRunStartResult {
  return {
    runId: manifest.runId,
    status: manifest.status,
    workflow: {
      name: manifest.workflow.name,
      description: manifest.workflow.description,
      ...(manifest.workflow.title === undefined ? {} : { title: manifest.workflow.title }),
    },
    cursor: manifest.cursor,
    ...(manifest.workflow.filePath === undefined ? {} : { scriptPath: manifest.workflow.filePath }),
    ...(manifest.resumedFromRunId === undefined
      ? {}
      : { resumedFromRunId: manifest.resumedFromRunId }),
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
