import { randomUUID } from 'node:crypto'
import { COPYFILE_EXCL } from 'node:constants'
import { createReadStream } from 'node:fs'
import {
  chmod,
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'

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
  WorkflowStoreLease,
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
const EVENT_INDEX_STRIDE = 256

export class WorkflowStoreError extends Error {
  readonly code: 'run-exists' | 'run-not-found' | 'corrupt-store' | 'io-error' | 'owner-conflict'

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
  readonly #snapshotCache = new Map<string, { cursor: number; state: WorkflowRunSnapshot['state'] }>()
  readonly #eventOffsets = new Map<string, Map<number, number>>()
  readonly #appendTails = new Map<string, Promise<void>>()
  #leaseToken: string | undefined
  #leaseWasAcquired = false

  constructor(rootDirectory: string) {
    this.rootDirectory = resolve(rootDirectory)
    this.runsDirectory = join(this.rootDirectory, 'runs')
  }

  async initialize(): Promise<void> {
    // initialize() is not read-only: crash-tail recovery can rewrite manifests. A convenience
    // store handle which never acquired the owner lease must therefore be fenced just like append
    // and create, or a second process can race recovery before WorkflowService sees it.
    await this.#assertLease()
    await mkdir(this.runsDirectory, { recursive: true, mode: 0o700 })
    await chmod(this.rootDirectory, 0o700).catch(() => undefined)
    await chmod(this.runsDirectory, 0o700)

    const entries = await readdir(this.runsDirectory, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      await this.#recoverEventTail(entry.name)
    }
  }

  async acquireLease(ownerId: string): Promise<WorkflowStoreLease> {
    if (ownerId.length === 0) throw new TypeError('Workflow store ownerId must not be empty')
    await mkdir(this.rootDirectory, { recursive: true, mode: 0o700 })
    const path = join(this.rootDirectory, 'service-owner.json')
    const token = randomUUID()
    const generation = (Date.now() * 1_000) + Math.floor(Math.random() * 1_000)
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(path, 'wx', 0o600)
        try {
          await handle.writeFile(`${JSON.stringify({ ownerId, token, generation, pid: process.pid, acquiredAt: new Date().toISOString() })}\n`)
          await handle.sync()
        } finally {
          await handle.close()
        }
        this.#leaseToken = token
        this.#leaseWasAcquired = true
        let released = false
        return {
          ownerId,
          generation,
          release: async () => {
            if (released) return
            released = true
            try {
              try {
                const current = JSON.parse(await readFile(path, 'utf8')) as { token?: unknown }
                // WHY release checks the random fencing token instead of blindly unlinking: a stale
                // owner can resume after another process reclaimed its dead PID lock. It must never
                // delete the new owner's lease and reopen the store to concurrent writers.
                if (current.token === token) await rm(path, { force: true })
              } catch (error) {
                if (!isMissing(error)) throw error
              }
            } finally {
              if (this.#leaseToken === token) this.#leaseToken = undefined
            }
          },
        }
      } catch (error) {
        if (!isAlreadyExists(error)) {
          throw new WorkflowStoreError('io-error', `Cannot acquire workflow store ownership: ${path}`, { cause: error })
        }
        const existing = await readOwner(path)
        if (existing !== undefined && processIsAlive(existing.pid)) {
          throw new WorkflowStoreError(
            'owner-conflict',
            `Workflow store is already owned by ${existing.ownerId} (pid ${existing.pid})`,
          )
        }
        // The exclusive file outlives a hard crash. Reclaim only after proving its PID is absent;
        // malformed files are also stale because no valid owner can use them for fencing.
        await rm(path, { force: true })
      }
    }
    throw new WorkflowStoreError('owner-conflict', 'Workflow store ownership changed while acquiring it')
  }

  async createRun(input: CreateWorkflowRunInput): Promise<WorkflowRunManifest> {
    await this.#assertLease()
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
      lineageId: input.lineageId ?? input.runId,
      ...(input.recoveryMode === undefined ? {} : { recoveryMode: input.recoveryMode }),
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
      await mkdir(join(directory, 'transcripts'), { mode: 0o700 })
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
    const previous = this.#appendTails.get(runId) ?? Promise.resolve()
    let releaseTail!: () => void
    const owned = new Promise<void>((resolveOwned) => { releaseTail = resolveOwned })
    this.#appendTails.set(runId, owned)
    await previous.catch(() => undefined)
    try {
      return await this.#appendEvent(runId, event)
    } finally {
      releaseTail()
      if (this.#appendTails.get(runId) === owned) this.#appendTails.delete(runId)
    }
  }

  async #appendEvent(runId: string, event: WorkflowEvent): Promise<StoredWorkflowEvent> {
    await this.#assertLease()
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
    let eventOffset = 0
    try {
      eventOffset = (await handle.stat()).size
      await handle.writeFile(`${JSON.stringify(stored)}\n`, 'utf8')
      // Persist-before-publish is a user-visible guarantee: renderer replay after a crash must
      // include every event that IPC or MCP ever acknowledged. Awaiting fsync is intentionally
      // more conservative than relying on the OS page cache.
      await handle.sync()
    } finally {
      await handle.close()
    }

    await this.#writeManifest(applyEventToManifest(manifest, stored))
    await this.#appendAgentTranscript(stored)
    if ((cursor - 1) % EVENT_INDEX_STRIDE === 0) {
      const offsets = this.#eventOffsets.get(runId) ?? new Map<number, number>()
      offsets.set(cursor, eventOffset)
      this.#eventOffsets.set(runId, offsets)
    }
    const cached = this.#snapshotCache.get(runId)
    if (cached?.cursor === manifest.cursor) {
      this.#snapshotCache.set(runId, {
        cursor,
        state: reduceWorkflowState(cached.state, event),
      })
    } else if (cached !== undefined) {
      // A cache gap means an append raced initial replay or recovery changed the durable cursor.
      // Dropping the projection is cheaper and safer than attempting to infer the missing event.
      this.#snapshotCache.delete(runId)
    }
    return stored
  }

  async readEvents(runId: string, after: number, limit: number): Promise<WorkflowEventPage> {
    const manifest = await this.#requiredManifest(runId)
    const selected: StoredWorkflowEvent[] = []
    for await (const event of this.#events(runId, Number.MAX_SAFE_INTEGER, after)) {
      if (event.cursor <= after) continue
      selected.push(event)
      // One look-ahead record answers hasMore without retaining or parsing the rest of a history
      // that may contain hundreds of thousands of provider activity events.
      if (selected.length > limit) break
    }
    const hasMore = selected.length > limit
    if (hasMore) selected.pop()
    return {
      runId,
      cwd: manifest.cwd,
      fromCursor: after,
      toCursor: selected.at(-1)?.cursor ?? after,
      events: selected,
      hasMore,
    }
  }

  async snapshot(runId: string): Promise<WorkflowRunSnapshot> {
    const manifest = await this.#requiredManifest(runId)
    const cached = this.#snapshotCache.get(runId)
    if (cached?.cursor === manifest.cursor) {
      return { manifest, state: cached.state, cursor: manifest.cursor }
    }
    let state = createWorkflowState(runId)
    for await (const stored of this.#events(runId, manifest.cursor)) {
      state = reduceWorkflowState(state, stored.event)
    }
    const newerCache = this.#snapshotCache.get(runId)
    if (newerCache === undefined || newerCache.cursor <= manifest.cursor) {
      this.#snapshotCache.set(runId, { cursor: manifest.cursor, state })
    }
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
    return join(this.transcriptDirectory(runId), 'journal.jsonl')
  }

  transcriptDirectory(runId: string): string {
    return join(this.#runDirectory(runId), 'transcripts')
  }

  async #appendAgentTranscript(stored: StoredWorkflowEvent): Promise<void> {
    const event = stored.event
    if (!('agentId' in event) || typeof event.agentId !== 'string') return
    const agentId = event.agentId.replace(/[^A-Za-z0-9_-]/g, '-')
    const path = join(this.transcriptDirectory(stored.runId), `agent-${agentId}.jsonl`)
    try {
      await writeFile(path, `${JSON.stringify(stored)}\n`, {
        encoding: 'utf8',
        flag: 'a',
        mode: 0o600,
      })
    } catch (cause) {
      // The canonical events.jsonl append and manifest are already durable. A transcript mirror is
      // a discoverability aid for Claude-shaped tooling, never a second source of truth; failing a
      // live workflow after its event committed would create a worse split-brain than reporting the
      // secondary I/O problem and allowing replay to remain authoritative.
      console.warn(`[workflow-mcp] Cannot append agent transcript ${path}:`, cause)
    }
  }

  async #requiredManifest(runId: string): Promise<WorkflowRunManifest> {
    const manifest = await this.getManifest(runId)
    if (!manifest) throw new WorkflowStoreError('run-not-found', `Workflow run not found: ${runId}`)
    return manifest
  }

  async *#events(
    runId: string,
    throughCursor = Number.MAX_SAFE_INTEGER,
    nearCursor = 0,
  ): AsyncGenerator<StoredWorkflowEvent> {
    const path = this.#eventsPath(runId)
    const info = await stat(path)
    if (info.size > MAX_EVENT_FILE_BYTES) {
      throw new WorkflowStoreError('corrupt-store', `Workflow event log is too large: ${path}`)
    }
    const offsets = this.#eventOffsets.get(runId) ?? new Map<number, number>()
    this.#eventOffsets.set(runId, offsets)
    let startCursor = 1
    let startOffset = 0
    for (const [indexedCursor, indexedOffset] of offsets) {
      if (indexedCursor > nearCursor + 1 || indexedCursor < startCursor) continue
      startCursor = indexedCursor
      startOffset = indexedOffset
    }
    const lines = createInterface({
      input: createReadStream(path, { encoding: 'utf8', start: startOffset }),
      crlfDelay: Infinity,
    })
    let cursor = startCursor - 1
    let lineNumber = 0
    for await (const line of lines) {
      lineNumber += 1
      if (line.length === 0) continue
      let value: unknown
      try {
        value = JSON.parse(line) as unknown
      } catch (cause) {
        throw new WorkflowStoreError(
          'corrupt-store',
          `Workflow event ${lineNumber} is invalid JSON: ${path}`,
          { cause },
        )
      }
      cursor += 1
      if ((cursor - 1) % EVENT_INDEX_STRIDE === 0) offsets.set(cursor, startOffset)
      const event = parseStoredEvent(value, runId, cursor, path)
      // WHY the upper-bound check must happen before yield: append fsyncs events.jsonl before it
      // advances manifest.cursor. A concurrent health/snapshot read can therefore see one durable
      // record beyond its manifest. Yielding that future record under the old cursor poisons the
      // projection cache, then the writer applies the same event a second time and fails the run
      // with a false duplicate-sequence error. The manifest is the published commit boundary even
      // though the append-only file intentionally reaches disk first for crash recovery.
      if (cursor > throughCursor) break
      yield event
      startOffset += Buffer.byteLength(line, 'utf8') + 1
      if (cursor >= throughCursor) break
    }
  }

  async #recoverEventTail(runId: string): Promise<void> {
    this.#eventOffsets.delete(runId)
    this.#snapshotCache.delete(runId)
    const manifest = await this.getManifest(runId)
    if (!manifest) return
    await mkdir(this.transcriptDirectory(runId), { recursive: true, mode: 0o700 })
    const legacyJournal = join(this.#runDirectory(runId), 'journal.json')
    const currentJournal = this.journalPath(runId)
    await copyFile(legacyJournal, currentJournal, COPYFILE_EXCL).catch((error: NodeJS.ErrnoException) => {
      // Missing legacy state is normal for runs created after the transcript layout changed. Never
      // overwrite the new journal: its atomic snapshots may already be ahead of the retained
      // compatibility copy after a resumed process wrote more agent results.
      if (error.code !== 'ENOENT' && error.code !== 'EEXIST') throw error
    })
    const path = this.#eventsPath(runId)
    let handle
    try {
      handle = await open(path, 'r+')
    } catch (cause) {
      throw new WorkflowStoreError('corrupt-store', `Cannot read workflow events: ${path}`, { cause })
    }
    try {
      const info = await handle.stat()
      if (info.size > 0) {
        const finalByte = Buffer.alloc(1)
        await handle.read(finalByte, 0, 1, info.size - 1)
        if (finalByte[0] !== 0x0a) {
          // Activity content is bounded before persistence, so one MiB is comfortably larger than
          // a legitimate event. Reading only this tail prevents startup from allocating the entire
          // log merely to repair one interrupted append.
          const tailBytes = Math.min(info.size, 1024 * 1024)
          const buffer = Buffer.alloc(tailBytes)
          await handle.read(buffer, 0, tailBytes, info.size - tailBytes)
          const finalBreak = buffer.lastIndexOf(0x0a)
          if (finalBreak < 0 && info.size > tailBytes) {
            throw new WorkflowStoreError('corrupt-store', `Workflow event tail is too large: ${path}`)
          }
          const tail = buffer.subarray(finalBreak + 1).toString('utf8')
          let completeRecord = true
          try {
            JSON.parse(tail)
          } catch {
            completeRecord = false
          }
          if (completeRecord) {
            await handle.write(Buffer.from('\n'), 0, 1, info.size)
            await handle.sync()
          } else {
            // Only a torn final append is recoverable. The streaming parser below still rejects
            // invalid JSON in the middle, so tail repair cannot hide older corruption.
            await handle.truncate(info.size - tailBytes + finalBreak + 1)
          }
        }
      }
    } finally {
      await handle.close()
    }
    let cursor = 0
    for await (const event of this.#events(runId)) {
      cursor = event.cursor
    }
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
      // The mismatch is rare (only a crash between event fsync and manifest rename). Rescan rather
      // than holding the entire history in memory during every normal startup.
      for await (const event of this.#events(runId)) rebuilt = applyEventToManifest(rebuilt, event)
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

  async #assertLease(): Promise<void> {
    const path = join(this.rootDirectory, 'service-owner.json')
    if (!this.#leaseWasAcquired) {
      try {
        await readFile(path, 'utf8')
      } catch (error) {
        if (isMissing(error)) return
        throw new WorkflowStoreError('io-error', 'Cannot inspect workflow store ownership', { cause: error })
      }
      // WHY even a malformed/stale-looking owner file fences an unleased handle: only
      // acquireLease() is allowed to prove a PID dead and reclaim it atomically. Letting ordinary
      // mutations make that judgment would recreate two ownership protocols and eventually let a
      // convenience writer race the real service.
      throw new WorkflowStoreError(
        'owner-conflict',
        'Workflow store has a service owner; acquire its lease before mutating it',
      )
    }
    if (this.#leaseToken === undefined) {
      throw new WorkflowStoreError('owner-conflict', 'Workflow store ownership has been released')
    }
    try {
      const current = JSON.parse(await readFile(path, 'utf8')) as { token?: unknown }
      // WHY every externally initiated mutation rechecks the token: PID-only locks prevent two
      // normal starts, but they do not fence an old asynchronous owner after its lock was reclaimed
      // or replaced. A stale service must fail before appending, even if its JavaScript stack wakes
      // much later with a previously valid store object.
      if (current.token !== this.#leaseToken) {
        throw new WorkflowStoreError('owner-conflict', 'Workflow store ownership was fenced by another service')
      }
    } catch (error) {
      if (error instanceof WorkflowStoreError) throw error
      if (isMissing(error)) {
        throw new WorkflowStoreError('owner-conflict', 'Workflow store ownership file disappeared')
      }
      throw new WorkflowStoreError('io-error', 'Cannot verify workflow store ownership', { cause: error })
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

async function readOwner(path: string): Promise<{ ownerId: string; pid: number } | undefined> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as unknown
    if (
      !isObject(value) ||
      typeof value.ownerId !== 'string' ||
      !Number.isSafeInteger(value.pid) ||
      (value.pid as number) <= 0
    ) return undefined
    return { ownerId: value.ownerId, pid: value.pid as number }
  } catch (error) {
    if (isMissing(error) || error instanceof SyntaxError) return undefined
    throw error
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !(isObject(error) && error.code === 'ESRCH')
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
