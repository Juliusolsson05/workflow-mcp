import { randomUUID } from 'node:crypto'
import {
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  truncate,
  writeFile,
} from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { parseWorkflowSource } from './loadWorkflow.js'
import type { WorkflowEvent } from './workflowEvents.js'
import { createWorkflowState, reduceWorkflowState } from './workflowState.js'
import type {
  CreateWorkflowRunInput,
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
const RUN_STATUSES = new Set<WorkflowRunStatus>([
  'queued',
  'running',
  'cancellation_requested',
  ...TERMINAL_STATUSES,
])
const MAX_EVENT_FILE_BYTES = 512 * 1024 * 1024

export class WorkflowStoreError extends Error {
  readonly code: 'run-exists' | 'run-not-found' | 'corrupt-store' | 'io-error'

  constructor(code: WorkflowStoreError['code'], message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'WorkflowStoreError'
    this.code = code
  }
}

/**
 * A private, append-only local store for workflow runs.
 *
 * WHY files instead of SQLite: the only writer is one WorkflowService in the Electron main
 * process, while SQLite would add a native ABI, rebuild, signing, and packaging surface. An atomic
 * manifest plus fsynced JSONL gives this ownership model the durability it needs and leaves every
 * run inspectable with ordinary tools when a 100-agent execution goes wrong.
 */
export class FileWorkflowStore implements WorkflowStore {
  readonly rootDirectory: string
  readonly runsDirectory: string

  constructor(rootDirectory: string) {
    this.rootDirectory = resolve(rootDirectory)
    this.runsDirectory = join(this.rootDirectory, 'runs')
  }

  async initialize(): Promise<void> {
    await mkdir(this.runsDirectory, { recursive: true, mode: 0o700 })
    await chmod(this.rootDirectory, 0o700).catch(() => undefined)
    await chmod(this.runsDirectory, 0o700)

    const entries = await readdir(this.runsDirectory, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      await this.#recoverEventTail(entry.name)
    }
  }

  async createRun(input: CreateWorkflowRunInput): Promise<WorkflowRunManifest> {
    const directory = this.#runDirectory(input.runId)
    try {
      await mkdir(directory, { mode: 0o700 })
    } catch (cause) {
      if (isAlreadyExists(cause)) {
        throw new WorkflowStoreError('run-exists', `Workflow run already exists: ${input.runId}`)
      }
      throw new WorkflowStoreError('io-error', `Cannot create workflow run: ${input.runId}`, { cause })
    }

    const now = new Date().toISOString()
    const manifest: WorkflowRunManifest = {
      schemaVersion: 1,
      runId: input.runId,
      cwd: resolve(input.cwd),
      workflow: {
        name: input.workflow.meta.name,
        description: input.workflow.meta.description,
        sourceHash: input.workflow.sourceHash,
        ...(input.workflow.meta.title === undefined ? {} : { title: input.workflow.meta.title }),
        ...(input.workflow.filePath === undefined ? {} : { filePath: input.workflow.filePath }),
      },
      status: 'queued',
      cursor: 0,
      createdAt: now,
      updatedAt: now,
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
      ...(input.resumedFromRunId === undefined
        ? {}
        : { resumedFromRunId: input.resumedFromRunId }),
    }

    try {
      await writePrivateFile(join(directory, 'workflow.js'), input.workflow.source)
      await writePrivateFile(
        join(directory, 'args.json'),
        `${JSON.stringify(
          input.args === undefined
            ? { provided: false }
            : { provided: true, value: input.args },
        )}\n`,
      )
      await writePrivateFile(join(directory, 'events.jsonl'), '')
      await this.#writeManifest(manifest)
      await mkdir(join(directory, 'artifacts'), { mode: 0o700 })
      return manifest
    } catch (cause) {
      await rm(directory, { recursive: true, force: true })
      throw new WorkflowStoreError('io-error', `Cannot initialize workflow run: ${input.runId}`, {
        cause,
      })
    }
  }

  async getManifest(runId: string): Promise<WorkflowRunManifest | undefined> {
    const path = this.#manifestPath(runId)
    try {
      return parseManifest(JSON.parse(await readFile(path, 'utf8')) as unknown, path)
    } catch (cause) {
      if (isMissing(cause)) return undefined
      if (cause instanceof WorkflowStoreError) throw cause
      throw new WorkflowStoreError('corrupt-store', `Cannot read workflow manifest: ${path}`, { cause })
    }
  }

  async listManifests(): Promise<WorkflowRunManifest[]> {
    const entries = await readdir(this.runsDirectory, { withFileTypes: true })
    const manifests: WorkflowRunManifest[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const manifest = await this.getManifest(entry.name)
      if (manifest) manifests.push(manifest)
    }
    return manifests.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  }

  async findByIdempotencyKey(cwd: string, key: string): Promise<WorkflowRunManifest | undefined> {
    const scopedCwd = resolve(cwd)
    const manifests = await this.listManifests()
    return manifests.find((manifest) => manifest.cwd === scopedCwd && manifest.idempotencyKey === key)
  }

  async appendEvent(runId: string, event: WorkflowEvent): Promise<StoredWorkflowEvent> {
    const manifest = await this.#requiredManifest(runId)
    if (event.runId !== runId) {
      throw new WorkflowStoreError(
        'corrupt-store',
        `Event for ${event.runId} cannot be appended to ${runId}`,
      )
    }
    const cursor = manifest.cursor + 1
    if (event.sequence !== cursor) {
      throw new WorkflowStoreError(
        'corrupt-store',
        `Event sequence ${event.sequence} does not follow durable cursor ${manifest.cursor}`,
      )
    }
    if (TERMINAL_STATUSES.has(manifest.status)) {
      throw new WorkflowStoreError('corrupt-store', `Cannot append to terminal run ${runId}`)
    }

    const stored: StoredWorkflowEvent = {
      runId,
      cursor,
      recordedAt: new Date().toISOString(),
      event,
    }
    const path = this.#eventsPath(runId)
    const handle = await open(path, 'a', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(stored)}\n`, 'utf8')
      // Persist-before-publish is a user-visible guarantee: renderer replay after a crash must
      // include every event that IPC or MCP ever acknowledged. Awaiting fsync is intentionally
      // more conservative than relying on the OS page cache.
      await handle.sync()
    } finally {
      await handle.close()
    }

    await this.#writeManifest(applyEventToManifest(manifest, stored))
    return stored
  }

  async readEvents(runId: string, after: number, limit: number): Promise<WorkflowEventPage> {
    const manifest = await this.#requiredManifest(runId)
    const events = await this.#readAllEvents(runId)
    const selected = events.filter((event) => event.cursor > after).slice(0, limit)
    return {
      runId,
      cwd: manifest.cwd,
      fromCursor: after,
      toCursor: selected.at(-1)?.cursor ?? after,
      events: selected,
      hasMore: events.some((event) => event.cursor > (selected.at(-1)?.cursor ?? after)),
    }
  }

  async snapshot(runId: string): Promise<WorkflowRunSnapshot> {
    const manifest = await this.#requiredManifest(runId)
    const events = await this.#readAllEvents(runId)
    let state = createWorkflowState(runId)
    for (const stored of events) state = reduceWorkflowState(state, stored.event)
    return { manifest, state, cursor: manifest.cursor }
  }

  async loadWorkflow(runId: string) {
    const manifest = await this.#requiredManifest(runId)
    const path = join(this.#runDirectory(runId), 'workflow.js')
    const source = await readFile(path, 'utf8')
    const loaded = parseWorkflowSource(source, manifest.workflow.filePath)
    if (loaded.sourceHash !== manifest.workflow.sourceHash) {
      throw new WorkflowStoreError('corrupt-store', `Stored workflow source changed for ${runId}`)
    }
    return loaded
  }

  async loadArgs(runId: string): Promise<{ provided: boolean; value?: unknown }> {
    await this.#requiredManifest(runId)
    const path = join(this.#runDirectory(runId), 'args.json')
    const value = JSON.parse(await readFile(path, 'utf8')) as unknown
    if (!isObject(value) || typeof value.provided !== 'boolean') {
      throw new WorkflowStoreError('corrupt-store', `Stored workflow arguments are invalid: ${path}`)
    }
    return value.provided ? { provided: true, value: value.value } : { provided: false }
  }

  journalPath(runId: string): string {
    return join(this.#runDirectory(runId), 'journal.json')
  }

  async #requiredManifest(runId: string): Promise<WorkflowRunManifest> {
    const manifest = await this.getManifest(runId)
    if (!manifest) throw new WorkflowStoreError('run-not-found', `Workflow run not found: ${runId}`)
    return manifest
  }

  async #readAllEvents(runId: string): Promise<StoredWorkflowEvent[]> {
    const path = this.#eventsPath(runId)
    const info = await stat(path)
    if (info.size > MAX_EVENT_FILE_BYTES) {
      throw new WorkflowStoreError('corrupt-store', `Workflow event log is too large: ${path}`)
    }
    const text = await readFile(path, 'utf8')
    const events: StoredWorkflowEvent[] = []
    for (const [index, line] of text.split('\n').entries()) {
      if (line.length === 0) continue
      let value: unknown
      try {
        value = JSON.parse(line) as unknown
      } catch (cause) {
        throw new WorkflowStoreError(
          'corrupt-store',
          `Workflow event ${index + 1} is invalid JSON: ${path}`,
          { cause },
        )
      }
      events.push(parseStoredEvent(value, runId, events.length + 1, path))
    }
    return events
  }

  async #recoverEventTail(runId: string): Promise<void> {
    const manifest = await this.getManifest(runId)
    if (!manifest) return
    const path = this.#eventsPath(runId)
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (cause) {
      throw new WorkflowStoreError('corrupt-store', `Cannot read workflow events: ${path}`, { cause })
    }
    if (text.length > 0 && !text.endsWith('\n')) {
      const finalBreak = text.lastIndexOf('\n')
      const tail = text.slice(finalBreak + 1)
      let completeRecord = true
      try {
        JSON.parse(tail)
      } catch {
        completeRecord = false
      }
      if (completeRecord) {
        const handle = await open(path, 'a', 0o600)
        try {
          await handle.writeFile('\n', 'utf8')
          await handle.sync()
        } finally {
          await handle.close()
        }
      } else {
        // Only a torn final append is recoverable. Earlier invalid JSON remains a hard error in
        // #readAllEvents so recovery never hides mid-history corruption behind a plausible UI.
        await truncate(path, finalBreak + 1)
      }
    }
    const events = await this.#readAllEvents(runId)
    const cursor = events.at(-1)?.cursor ?? 0
    if (manifest.cursor !== cursor) {
      // A crash can land after fsyncing events.jsonl but before atomically replacing the manifest.
      // Replaying every durable event from the immutable identity fields is the only safe repair;
      // applying just the final event to a stale terminal status can preserve a state that no
      // longer matches the log.
      const {
        error: _oldError,
        cancellationReason: _oldCancellationReason,
        ...identity
      } = manifest
      let rebuilt: WorkflowRunManifest = {
        ...identity,
        status: 'queued',
        cursor: 0,
        updatedAt: manifest.createdAt,
      }
      for (const event of events) rebuilt = applyEventToManifest(rebuilt, event)
      await this.#writeManifest(rebuilt)
    }
  }

  async #writeManifest(manifest: WorkflowRunManifest): Promise<void> {
    const path = this.#manifestPath(manifest.runId)
    const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
    try {
      await writeFile(temporary, `${JSON.stringify(manifest)}\n`, { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, path)
      await chmod(path, 0o600)
    } catch (cause) {
      await rm(temporary, { force: true })
      throw new WorkflowStoreError('io-error', `Cannot persist workflow manifest: ${path}`, { cause })
    }
  }

  #runDirectory(runId: string): string {
    if (!/^run_[A-Za-z0-9_-]+$/.test(runId)) {
      throw new TypeError(`Invalid workflow run ID: ${JSON.stringify(runId)}`)
    }
    return join(this.runsDirectory, runId)
  }

  #manifestPath(runId: string): string {
    return join(this.#runDirectory(runId), 'manifest.json')
  }

  #eventsPath(runId: string): string {
    return join(this.#runDirectory(runId), 'events.jsonl')
  }
}

function applyEventToManifest(
  manifest: WorkflowRunManifest,
  stored: StoredWorkflowEvent,
): WorkflowRunManifest {
  const event = stored.event
  let status = manifest.status
  let error = manifest.error
  let cancellationReason = manifest.cancellationReason
  switch (event.type) {
    case 'run.started': status = 'running'; break
    case 'run.cancellation_requested':
      status = 'cancellation_requested'
      cancellationReason = event.payload.reason
      break
    case 'run.completed': status = 'completed'; break
    case 'run.failed': status = 'failed'; error = event.payload.error.message; break
    case 'run.cancelled':
      status = 'cancelled'
      cancellationReason = event.payload.reason
      break
    case 'run.interrupted': status = 'interrupted'; error = event.payload.reason; break
  }
  return {
    ...manifest,
    status,
    cursor: stored.cursor,
    updatedAt: stored.recordedAt,
    ...(error === undefined ? {} : { error }),
    ...(cancellationReason === undefined ? {} : { cancellationReason }),
  }
}

function parseStoredEvent(
  value: unknown,
  runId: string,
  expectedCursor: number,
  path: string,
): StoredWorkflowEvent {
  if (
    !isObject(value) ||
    value.runId !== runId ||
    value.cursor !== expectedCursor ||
    typeof value.recordedAt !== 'string' ||
    !isObject(value.event) ||
    value.event.runId !== runId ||
    value.event.sequence !== expectedCursor ||
    typeof value.event.type !== 'string'
  ) {
    throw new WorkflowStoreError(
      'corrupt-store',
      `Workflow event cursor ${expectedCursor} is invalid: ${path}`,
    )
  }
  return value as StoredWorkflowEvent
}

function parseManifest(value: unknown, path: string): WorkflowRunManifest {
  if (
    !isObject(value) ||
    value.schemaVersion !== 1 ||
    typeof value.runId !== 'string' ||
    typeof value.cwd !== 'string' ||
    typeof value.status !== 'string' ||
    !RUN_STATUSES.has(value.status as WorkflowRunStatus) ||
    !Number.isSafeInteger(value.cursor) ||
    typeof value.createdAt !== 'string' ||
    typeof value.updatedAt !== 'string' ||
    !isObject(value.workflow) ||
    typeof value.workflow.name !== 'string' ||
    typeof value.workflow.description !== 'string'
  ) {
    throw new WorkflowStoreError('corrupt-store', `Workflow manifest is invalid: ${path}`)
  }
  return value as WorkflowRunManifest
}

async function writePrivateFile(path: string, content: string): Promise<void> {
  await writeFile(path, content, { encoding: 'utf8', mode: 0o600 })
  await chmod(path, 0o600)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isMissing(error: unknown): boolean {
  return isObject(error) && error.code === 'ENOENT'
}

function isAlreadyExists(error: unknown): boolean {
  return isObject(error) && error.code === 'EEXIST'
}
