import { createHash, randomUUID } from 'node:crypto'
import { COPYFILE_EXCL } from 'node:constants'
import { execFile } from 'node:child_process'
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
import { promisify } from 'node:util'

import { parseWorkflowSource } from './loadWorkflow.js'
import {
  readWorkflowJournalSnapshots,
  writeInitialWorkflowJournal,
} from './persistentWorkflowJournal.js'
import type { JournalSnapshot } from './workflowJournal.js'
import type { WorkflowEvent } from './workflowEvents.js'
import {
  MAX_WORKFLOW_RESULT_PAGE_BYTES,
  MIN_WORKFLOW_RESULT_PAGE_BYTES,
} from './workflowStore.js'
import type { WorkflowAgentResultReadInput } from './workflowStore.js'
import type {
  ContentChecksum,
  ContentReference,
  WorkflowResultMaterialization,
} from './workflowEvents.js'
import { serializeWorkflowValue } from './workflowEvents.js'
import { createWorkflowState, reduceWorkflowState } from './workflowState.js'
import type {
  CreateWorkflowRunInput,
  StoredWorkflowEvent,
  WorkflowAgentResultPage,
  WorkflowEventPage,
  WorkflowResultArtifact,
  WorkflowResultPage,
  WorkflowRunManifest,
  WorkflowRunSnapshot,
  WorkflowRunStatus,
  WorkflowStore,
  WorkflowStoreLease,
  WorkflowResultReadInput,
} from './workflowStore.js'

const TERMINAL_STATUSES = new Set<WorkflowRunStatus>([
  'completed',
  'completed_with_errors',
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
const DEFAULT_MAX_EVENT_FILE_BYTES = 512 * 1024 * 1024
export const DEFAULT_MAX_WORKFLOW_RESULT_BYTES = 64 * 1024 * 1024
export const MAX_WORKFLOW_RESULT_BYTES = 512 * 1024 * 1024
const MAX_RESULT_METADATA_BYTES = 8 * 1024
const EVENT_INDEX_STRIDE = 256
const OWNER_LOCK_DIRECTORY = 'service-owner.lock'
const OWNER_METADATA_FILE = 'owner.json'
const OWNER_ACQUIRE_ATTEMPTS = 16
const execFileAsync = promisify(execFile)

type StoredWorkflowResultMetadata = {
  schemaVersion: 1
  runId: string
  artifactId: string
  mediaType: string
  sizeBytes: number
  lineCount: number
  checksum: ContentChecksum
  createdAt: string
}

export class WorkflowStoreError extends Error {
  readonly code:
    | 'run-exists'
    | 'run-not-found'
    | 'corrupt-store'
    | 'event-log-full'
    | 'lineage-active'
    | 'io-error'
    | 'owner-conflict'
    | 'result-too-large'
    | 'invalid-result'
    | 'result-not-found'
    | 'agent-not-found'
    | 'invalid-cursor'

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
  /** runId → parsed journal results, invalidated by the journal file's size+mtime. */
  readonly #journalResultCache = new Map<
    string,
    { identity: string; located: Map<string, JournalResultLocator> }
  >()
  readonly #eventOffsets = new Map<string, Map<number, number>>()
  readonly #appendTails = new Map<string, Promise<void>>()
  #createTail: Promise<void> = Promise.resolve()
  readonly #quarantinedRuns = new Map<string, WorkflowStoreError>()
  readonly #maxEventFileBytes: number
  readonly #maxResultBytes: number
  #leaseToken: string | undefined
  #leaseWasAcquired = false

  constructor(
    rootDirectory: string,
    options: { maxEventFileBytes?: number; maxResultBytes?: number } = {},
  ) {
    this.rootDirectory = resolve(rootDirectory)
    this.runsDirectory = join(this.rootDirectory, 'runs')
    this.#maxEventFileBytes = options.maxEventFileBytes ?? DEFAULT_MAX_EVENT_FILE_BYTES
    this.#maxResultBytes = options.maxResultBytes ?? DEFAULT_MAX_WORKFLOW_RESULT_BYTES
    if (!Number.isSafeInteger(this.#maxEventFileBytes) || this.#maxEventFileBytes <= 0) {
      throw new TypeError('maxEventFileBytes must be a positive safe integer')
    }
    if (
      !Number.isSafeInteger(this.#maxResultBytes) ||
      this.#maxResultBytes <= 0 ||
      this.#maxResultBytes > MAX_WORKFLOW_RESULT_BYTES
    ) {
      throw new TypeError(
        `maxResultBytes must be an integer from 1 through ${MAX_WORKFLOW_RESULT_BYTES}`,
      )
    }
  }

  async initialize(): Promise<void> {
    // initialize() is not read-only: crash-tail recovery can rewrite manifests. A convenience
    // store handle which never acquired the owner lease must therefore be fenced just like append
    // and create, or a second process can race recovery before WorkflowService sees it.
    await this.#assertLease()
    await mkdir(this.runsDirectory, { recursive: true, mode: 0o700 })
    await chmod(this.rootDirectory, 0o700).catch(() => undefined)
    await chmod(this.runsDirectory, 0o700)

    this.#quarantinedRuns.clear()
    const entries = await readdir(this.runsDirectory, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      try {
        await this.#recoverEventTail(entry.name)
      } catch (cause) {
        const error = cause instanceof WorkflowStoreError
          ? cause
          : new WorkflowStoreError(
              'corrupt-store',
              `Cannot recover workflow run ${entry.name}`,
              { cause },
            )
        // One historical run is not the service's availability boundary. Remembering the exact
        // failure keeps direct access fail-closed while allowing healthy lineages to initialize.
        this.#quarantinedRuns.set(entry.name, error)
      }
    }
  }

  listQuarantinedRuns(): readonly { runId: string; code: string; message: string }[] {
    return [...this.#quarantinedRuns].map(([runId, error]) => ({
      runId,
      code: error.code,
      message: error.message,
    }))
  }

  async acquireLease(ownerId: string): Promise<WorkflowStoreLease> {
    if (ownerId.length === 0) throw new TypeError('Workflow store ownerId must not be empty')
    await mkdir(this.rootDirectory, { recursive: true, mode: 0o700 })
    const lockDirectory = join(this.rootDirectory, OWNER_LOCK_DIRECTORY)
    const metadataPath = join(lockDirectory, OWNER_METADATA_FILE)
    const token = randomUUID()
    const generation = (Date.now() * 1_000) + Math.floor(Math.random() * 1_000)
    const processStartIdentity = await readProcessStartIdentity(process.pid)
    for (let attempt = 0; attempt < OWNER_ACQUIRE_ATTEMPTS; attempt += 1) {
      const candidateDirectory = join(
        this.rootDirectory,
        `${OWNER_LOCK_DIRECTORY}.candidate-${process.pid}-${randomUUID()}`,
      )
      try {
        // WHY the directory is the lock primitive: replacing an expired ordinary file requires
        // unlink-then-create, which lets two reclaimers both delete each other's lock (the classic
        // ABA race). mkdir and rename are atomic namespace operations, so exactly one contender can
        // claim an absent lock or detach one stale generation for deletion.
        // Build the complete generation off to the side. Publishing an empty lock directory and
        // filling owner.json afterward creates a window where another contender cannot distinguish
        // a live claim from malformed crash debris and may reclaim it.
        await mkdir(candidateDirectory, { mode: 0o700 })
        const candidateMetadata = join(candidateDirectory, OWNER_METADATA_FILE)
        const handle = await open(candidateMetadata, 'wx', 0o600)
        try {
          await handle.writeFile(`${JSON.stringify({
            ownerId,
            token,
            generation,
            pid: process.pid,
            ...(processStartIdentity === undefined ? {} : { processStartIdentity }),
            acquiredAt: new Date().toISOString(),
          })}\n`)
          await handle.sync()
        } finally {
          await handle.close()
        }
        await rename(candidateDirectory, lockDirectory)
        this.#leaseToken = token
        this.#leaseWasAcquired = true
        let released = false
        return {
          ownerId,
          generation,
          release: async () => {
            if (released) return
            let completed = false
            try {
              try {
                const current = JSON.parse(await readFile(metadataPath, 'utf8')) as { token?: unknown }
                // WHY release checks the random fencing token instead of blindly unlinking: a stale
                // owner can resume after another process reclaimed its dead PID lock. It must never
                // delete the new owner's lease and reopen the store to concurrent writers.
                if (current.token === token) {
                  const tombstone = join(
                    this.rootDirectory,
                    `${OWNER_LOCK_DIRECTORY}.released-${process.pid}-${randomUUID()}`,
                  )
                  await rename(lockDirectory, tombstone)
                  await rm(tombstone, { recursive: true, force: true })
                }
              } catch (error) {
                if (!isMissing(error)) throw error
              }
              completed = true
            } finally {
              // An I/O failure must remain retryable. Marking release complete before the atomic
              // rename would strand a live lock forever while every later release call no-ops.
              if (completed) {
                released = true
                if (this.#leaseToken === token) this.#leaseToken = undefined
              }
            }
          },
        }
      } catch (error) {
        await rm(candidateDirectory, { recursive: true, force: true }).catch(() => undefined)
        if (!isLockExists(error)) {
          throw new WorkflowStoreError('io-error', `Cannot acquire workflow store ownership: ${lockDirectory}`, { cause: error })
        }
        const existing = await readOwner(metadataPath)
        if (existing !== undefined && await ownerProcessIsAlive(existing)) {
          throw new WorkflowStoreError(
            'owner-conflict',
            `Workflow store is already owned by ${existing.ownerId} (pid ${existing.pid})`,
          )
        }
        const tombstone = join(
          this.rootDirectory,
          `${OWNER_LOCK_DIRECTORY}.stale-${process.pid}-${randomUUID()}`,
        )
        try {
          // The stale directory outlives a hard crash. Rename is the takeover linearization point:
          // a rival either renames this exact generation first or observes our newly created one.
          // It can never unlink a generation created after its stale-owner inspection.
          await rename(lockDirectory, tombstone)
        } catch (cause) {
          if (isMissing(cause)) continue
          throw new WorkflowStoreError(
            'io-error',
            `Cannot reclaim stale workflow store ownership: ${lockDirectory}`,
            { cause },
          )
        }
        await rm(tombstone, { recursive: true, force: true })
      }
    }
    throw new WorkflowStoreError('owner-conflict', 'Workflow store ownership changed while acquiring it')
  }

  async createRun(input: CreateWorkflowRunInput): Promise<WorkflowRunManifest> {
    const previous = this.#createTail
    let release!: () => void
    this.#createTail = new Promise<void>((resolveCreate) => { release = resolveCreate })
    await previous.catch(() => undefined)
    try {
      return await this.#createRun(input)
    } finally {
      release()
    }
  }

  async #createRun(input: CreateWorkflowRunInput): Promise<WorkflowRunManifest> {
    await this.#assertLease()
    if (input.resumedFromRunId !== undefined) {
      const lineageId = input.lineageId ?? input.resumedFromRunId
      const active = (await this.listManifests()).find((manifest) => (
        manifest.runId !== input.resumedFromRunId &&
        (manifest.lineageId ?? manifest.runId) === lineageId &&
        !TERMINAL_STATUSES.has(manifest.status)
      ))
      if (active !== undefined) {
        // Store ownership serializes creators, making this check plus manifest publication one
        // durable uniqueness boundary. Idempotency keys are request-local and cannot prevent two
        // clients from supplying different keys for the same recovery lineage.
        throw new WorkflowStoreError(
          'lineage-active',
          `Workflow lineage ${lineageId} already has active successor ${active.runId}`,
        )
      }
    }
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
      ...(input.clientId === undefined ? {} : { clientId: input.clientId }),
      ...(input.resumedFromRunId === undefined
        ? {}
        : { resumedFromRunId: input.resumedFromRunId }),
      lineageId: input.lineageId ?? input.runId,
      ...(input.recoveryMode === undefined ? {} : { recoveryMode: input.recoveryMode }),
      ...(input.automaticReplaySafe === undefined
        ? {}
        : { automaticReplaySafe: input.automaticReplaySafe }),
      ...(input.providerRecoveryFingerprint === undefined
        ? {}
        : { providerRecoveryFingerprint: input.providerRecoveryFingerprint }),
    }

    try {
      // Publish the manifest last. Startup treats a manifest as a recoverable run, so every file it
      // references -- especially inherited journal history -- must already be durable before that
      // publication point. The old order exposed a queued successor before transcripts/ existed.
      await mkdir(join(directory, 'artifacts'), { mode: 0o700 })
      await mkdir(join(directory, 'transcripts'), { mode: 0o700 })
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
      if (input.journalSnapshots !== undefined && input.journalSnapshots.length > 0) {
        writeInitialWorkflowJournal(this.journalPath(input.runId), input.journalSnapshots)
      }
      await this.#writeManifest(manifest)
      return manifest
    } catch (cause) {
      await rm(directory, { recursive: true, force: true })
      throw new WorkflowStoreError('io-error', `Cannot initialize workflow run: ${input.runId}`, {
        cause,
      })
    }
  }

  async getManifest(runId: string): Promise<WorkflowRunManifest | undefined> {
    const quarantined = this.#quarantinedRuns.get(runId)
    if (quarantined !== undefined) throw quarantined
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
      if (this.#quarantinedRuns.has(entry.name)) continue
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
    const serialized = `${JSON.stringify(stored)}\n`
    const path = this.#eventsPath(runId)
    const handle = await open(path, 'a', 0o600)
    let eventOffset = 0
    try {
      eventOffset = (await handle.stat()).size
      if (eventOffset + Buffer.byteLength(serialized, 'utf8') > this.#maxEventFileBytes) {
        // Reject before the append reaches disk. Once an acknowledged cursor crosses the reader's
        // ceiling, every future replay calls the valid log "corrupt" and can strand the run.
        throw new WorkflowStoreError(
          'event-log-full',
          `Workflow event log would exceed ${this.#maxEventFileBytes} bytes: ${path}`,
        )
      }
      await handle.writeFile(serialized, 'utf8')
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

  async persistResult(
    runId: string,
    result: WorkflowResultMaterialization,
  ): Promise<ContentReference> {
    await this.#assertLease()
    const manifest = await this.#requiredManifest(runId)
    if (TERMINAL_STATUSES.has(manifest.status)) {
      throw new WorkflowStoreError(
        'corrupt-store',
        `Cannot replace the result of terminal workflow run ${runId}`,
      )
    }
    const mediaType = result.reference.mediaType
    if (typeof mediaType !== 'string' || mediaType.length === 0 || mediaType.length > 255) {
      throw new WorkflowStoreError('corrupt-store', `Workflow result media type is invalid: ${runId}`)
    }
    const sizeBytes = Buffer.byteLength(result.serializedContent, 'utf8')
    if (sizeBytes > this.#maxResultBytes) {
      // A completed run is a promise that every advertised result byte can be read. Silently
      // clipping at the storage ceiling would recreate the original bug behind a different API,
      // so a result which cannot fit the configured durable bound fails the run before completion.
      throw new WorkflowStoreError(
        'result-too-large',
        `Workflow result exceeds ${this.#maxResultBytes} UTF-8 bytes: ${runId}`,
      )
    }
    const bytes = Buffer.from(result.serializedContent, 'utf8')
    if (bytes.toString('utf8') !== result.serializedContent) {
      // JavaScript permits lone UTF-16 surrogates but UTF-8 does not. Node would silently replace
      // them with U+FFFD, making the artifact differ from run.completed's inline value. Fail before
      // completion instead so a successful locator is always byte-for-byte faithful.
      throw new WorkflowStoreError(
        'invalid-result',
        `Workflow result cannot be represented losslessly as UTF-8: ${runId}`,
      )
    }
    const lineCount = countUtf8Lines(bytes)
    if (lineCount !== result.reference.lineCount) {
      throw new WorkflowStoreError(
        'corrupt-store',
        `Workflow result line count changed during materialization: ${runId}`,
      )
    }
    const checksum: ContentChecksum = {
      algorithm: 'sha256',
      value: createHash('sha256').update(bytes).digest('hex'),
    }
    const metadata: StoredWorkflowResultMetadata = {
      schemaVersion: 1,
      runId,
      artifactId: resultArtifactId(checksum.value),
      mediaType,
      sizeBytes,
      lineCount,
      checksum,
      createdAt: new Date().toISOString(),
    }

    const existing = await this.#readResultMetadata(runId, true)
    if (existing !== undefined) {
      // A crash may leave fully synced artifact bytes just before run.completed is appended. A
      // retry in the same process may reuse byte-identical materialization, but a second value for
      // one run ID is corruption: cursors and checksum identity are intentionally immutable.
      if (
        existing.artifactId !== metadata.artifactId ||
        existing.mediaType !== metadata.mediaType ||
        existing.sizeBytes !== metadata.sizeBytes ||
        existing.lineCount !== metadata.lineCount
      ) {
        throw new WorkflowStoreError(
          'corrupt-store',
          `Workflow run ${runId} already has a different result artifact`,
        )
      }
      return resultReference(result.reference, existing)
    }

    const dataPath = this.#resultDataPath(runId)
    const metadataPath = this.#resultMetadataPath(runId)
    try {
      // Data is published before metadata, and run.completed is appended only after this method
      // returns. Every externally visible locator therefore names complete, fsynced bytes. A crash
      // between these steps leaves an unreferenced fixed-name file, never a half-readable result.
      await writePrivateFileAtomically(dataPath, bytes)
      await writePrivateFileAtomically(
        metadataPath,
        Buffer.from(`${JSON.stringify(metadata)}\n`, 'utf8'),
      )
      await syncDirectory(this.#artifactsDirectory(runId))
    } catch (cause) {
      if (cause instanceof WorkflowStoreError) throw cause
      throw new WorkflowStoreError(
        'io-error',
        `Cannot persist workflow result artifact: ${runId}`,
        { cause },
      )
    }
    return resultReference(result.reference, metadata)
  }

  async readResult(runId: string, input: WorkflowResultReadInput): Promise<WorkflowResultPage> {
    await this.#requiredManifest(runId)
    if (input.artifactId.length === 0 || input.artifactId.length > 200) {
      throw new WorkflowStoreError('result-not-found', `Workflow result artifact does not exist for ${runId}`)
    }
    if (input.cursor !== undefined && (input.cursor.length === 0 || input.cursor.length > 200)) {
      throw new WorkflowStoreError('invalid-cursor', 'Workflow result cursor is malformed')
    }
    if (
      !Number.isSafeInteger(input.maxBytes) ||
      input.maxBytes < MIN_WORKFLOW_RESULT_PAGE_BYTES ||
      input.maxBytes > MAX_WORKFLOW_RESULT_PAGE_BYTES
    ) {
      throw new TypeError(
        `maxBytes must be an integer from ${MIN_WORKFLOW_RESULT_PAGE_BYTES} through ${MAX_WORKFLOW_RESULT_PAGE_BYTES}`,
      )
    }
    const metadata = await this.#readResultMetadata(runId)
    if (input.artifactId !== metadata.artifactId) {
      // Artifact IDs are capabilities scoped beneath an already-authorized run. Never interpolate
      // the caller's value into a path; equality against private metadata is the entire selector.
      throw new WorkflowStoreError(
        'result-not-found',
        `Workflow result artifact does not exist for ${runId}`,
      )
    }
    const fromByte = parseResultCursor(input.cursor, metadata)
    const path = this.#resultDataPath(runId)
    let handle
    try {
      handle = await open(path, 'r')
    } catch (cause) {
      if (isMissing(cause)) {
        throw new WorkflowStoreError(
          'result-not-found',
          `Workflow result artifact is missing or expired: ${runId}`,
          { cause },
        )
      }
      throw new WorkflowStoreError('io-error', `Cannot open workflow result: ${runId}`, { cause })
    }
    try {
      const info = await handle.stat()
      if (info.size !== metadata.sizeBytes || info.size > MAX_WORKFLOW_RESULT_BYTES) {
        throw new WorkflowStoreError(
          'corrupt-store',
          `Workflow result size does not match its integrity metadata: ${runId}`,
        )
      }
      if (fromByte === metadata.sizeBytes) {
        return resultPage(runId, metadata, fromByte, fromByte, '', false)
      }

      const requestedBytes = Math.min(input.maxBytes, metadata.sizeBytes - fromByte)
      const buffer = Buffer.allocUnsafe(requestedBytes)
      const { bytesRead } = await handle.read(buffer, 0, requestedBytes, fromByte)
      if (bytesRead <= 0) {
        throw new WorkflowStoreError(
          'corrupt-store',
          `Workflow result ended before byte ${fromByte}: ${runId}`,
        )
      }
      const selected = buffer.subarray(0, bytesRead)
      if (isUtf8ContinuationByte(selected[0]!)) {
        throw new WorkflowStoreError(
          'invalid-cursor',
          `Workflow result cursor is not on a UTF-8 boundary: ${runId}`,
        )
      }
      const decoded = decodeCompleteUtf8Prefix(selected, runId)
      const toByte = fromByte + decoded.bytes
      if (toByte <= fromByte) {
        // The public minimum is four bytes, enough for the largest UTF-8 scalar. No progress under
        // that bound means the file is malformed rather than merely ending inside a code point.
        throw new WorkflowStoreError(
          'corrupt-store',
          `Workflow result contains invalid UTF-8 at byte ${fromByte}: ${runId}`,
        )
      }
      return resultPage(
        runId,
        metadata,
        fromByte,
        toByte,
        decoded.content,
        toByte < metadata.sizeBytes,
      )
    } finally {
      await handle.close()
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

  async #readResultMetadata(runId: string): Promise<StoredWorkflowResultMetadata>
  async #readResultMetadata(
    runId: string,
    missingAllowed: true,
  ): Promise<StoredWorkflowResultMetadata | undefined>
  async #readResultMetadata(
    runId: string,
    missingAllowed = false,
  ): Promise<StoredWorkflowResultMetadata | undefined> {
    const path = this.#resultMetadataPath(runId)
    let source: string
    try {
      source = (await readBoundedFile(path, MAX_RESULT_METADATA_BYTES)).toString('utf8')
    } catch (cause) {
      if (isMissing(cause)) {
        if (missingAllowed) return undefined
        throw new WorkflowStoreError(
          'result-not-found',
          `Workflow result artifact is missing or expired: ${runId}`,
          { cause },
        )
      }
      if (cause instanceof WorkflowStoreError) throw cause
      throw new WorkflowStoreError(
        'io-error',
        `Cannot read workflow result metadata: ${runId}`,
        { cause },
      )
    }
    try {
      // The configured limit is a write-admission policy, not a retention policy. Lowering it on
      // restart must not make a previously accepted immutable result unreadable, so historical
      // reads use the package hard ceiling while new materialization uses #maxResultBytes.
      return parseResultMetadata(
        JSON.parse(source) as unknown,
        path,
        runId,
        MAX_WORKFLOW_RESULT_BYTES,
      )
    } catch (cause) {
      if (cause instanceof WorkflowStoreError) throw cause
      throw new WorkflowStoreError(
        'corrupt-store',
        `Workflow result metadata is invalid: ${path}`,
        { cause },
      )
    }
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
    if (info.size > this.#maxEventFileBytes) {
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
        result: _oldResult,
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
    const lockDirectory = join(this.rootDirectory, OWNER_LOCK_DIRECTORY)
    const metadataPath = join(lockDirectory, OWNER_METADATA_FILE)
    if (!this.#leaseWasAcquired) {
      // Mutations never get an "unowned means safe" fast path. Checking for no lock and then
      // appending is a classic check/use race: a service can publish its lock between those two
      // operations and both handles become writers. Requiring every mutator to have acquired the
      // lease makes acquisition itself the one linearization point.
      throw new WorkflowStoreError(
        'owner-conflict',
        'Workflow store mutations require an acquired owner lease',
      )
    }
    if (this.#leaseToken === undefined) {
      throw new WorkflowStoreError('owner-conflict', 'Workflow store ownership has been released')
    }
    try {
      const current = JSON.parse(await readFile(metadataPath, 'utf8')) as { token?: unknown }
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


  #artifactsDirectory(runId: string): string {
    return join(this.#runDirectory(runId), 'artifacts')
  }

  #resultDataPath(runId: string): string {
    return join(this.#artifactsDirectory(runId), 'workflow-result.data')
  }

  #resultMetadataPath(runId: string): string {
    return join(this.#artifactsDirectory(runId), 'workflow-result.json')
  }

  /**
   * Validate an agent ID before it can influence a path.
   *
   * The transcript mirror sanitizes with a character-class replace, which is only safe because ids
   * happen to be `agent_N` today. The store's rule is stricter and stated at #runDirectory: a
   * caller value is validated, never laundered. A sanitizer silently maps two different ids onto one
   * file; this refuses instead.
   */
  #assertAgentId(agentId: string): string {
    if (!/^agent_[0-9]+$/.test(agentId)) {
      throw new WorkflowStoreError('agent-not-found', `Invalid workflow agent ID: ${JSON.stringify(agentId)}`)
    }
    return agentId
  }

  #agentResultDataPath(runId: string, agentId: string): string {
    return join(this.#artifactsDirectory(runId), `agent-${this.#assertAgentId(agentId)}.data`)
  }

  #agentResultMetadataPath(runId: string, agentId: string): string {
    return join(this.#artifactsDirectory(runId), `agent-${this.#assertAgentId(agentId)}.json`)
  }

  async #readAgentResultMetadata(
    runId: string,
    agentId: string,
  ): Promise<StoredWorkflowResultMetadata | undefined> {
    const path = this.#agentResultMetadataPath(runId, agentId)
    let raw
    try {
      raw = await readBoundedFile(path, MAX_RESULT_METADATA_BYTES)
    } catch (cause) {
      if (isMissing(cause)) return undefined
      throw new WorkflowStoreError('io-error', `Cannot read agent result metadata: ${runId}`, { cause })
    }
    let value: unknown
    try {
      value = JSON.parse(raw.toString('utf8')) as unknown
    } catch (cause) {
      throw new WorkflowStoreError('corrupt-store', `Agent result metadata is not valid JSON: ${runId}`, { cause })
    }
    return parseResultMetadata(value, path, runId, this.#maxResultBytes, agentResultArtifactId)
  }

  /**
   * Persist one agent's terminal value as its own artifact.
   *
   * Deliberately NOT an overload of persistResult: that method is a run-scoped singleton on fixed
   * filenames which refuses a second value and refuses to write once the manifest is terminal. Both
   * are correct for the run result and wrong here — a run has many agents, and they complete while
   * the run is still very much alive.
   *
   * Callers must treat failure as non-fatal. Persisting an agent result is observability, and an
   * observability failure that could fail agent 147 of a 200-agent fan-out would be a far worse bug
   * than the one this feature fixes. The journal fallback exists precisely so this is allowed to
   * fail.
   */
  async persistAgentResult(
    runId: string,
    agentId: string,
    result: WorkflowResultMaterialization,
  ): Promise<ContentReference> {
    await this.#assertLease()
    await this.#requiredManifest(runId)
    this.#assertAgentId(agentId)
    const mediaType = result.reference.mediaType
    if (typeof mediaType !== 'string' || mediaType.length === 0 || mediaType.length > 255) {
      throw new WorkflowStoreError('corrupt-store', `Agent result media type is invalid: ${runId}/${agentId}`)
    }
    const sizeBytes = Buffer.byteLength(result.serializedContent, 'utf8')
    if (sizeBytes > this.#maxResultBytes) {
      throw new WorkflowStoreError(
        'result-too-large',
        `Agent result exceeds ${this.#maxResultBytes} UTF-8 bytes: ${runId}/${agentId}`,
      )
    }
    const bytes = Buffer.from(result.serializedContent, 'utf8')
    if (bytes.toString('utf8') !== result.serializedContent) {
      // Lone UTF-16 surrogates cannot round-trip through UTF-8. For the RUN result this fails the
      // run, because a completed run promises byte-faithful bytes. For an AGENT it must not: the
      // agent genuinely succeeded and its value is already safe in the journal. Refusing the
      // artifact here leaves the journal fallback to serve it.
      throw new WorkflowStoreError(
        'invalid-result',
        `Agent result cannot be represented losslessly as UTF-8: ${runId}/${agentId}`,
      )
    }
    const checksum: ContentChecksum = {
      algorithm: 'sha256',
      value: createHash('sha256').update(bytes).digest('hex'),
    }
    const metadata: StoredWorkflowResultMetadata = {
      schemaVersion: 1,
      runId,
      artifactId: agentResultArtifactId(checksum.value),
      mediaType,
      sizeBytes,
      lineCount: countUtf8Lines(bytes),
      checksum,
      createdAt: new Date().toISOString(),
    }

    const existing = await this.#readAgentResultMetadata(runId, agentId)
    if (existing !== undefined) {
      // Retried attempts under one logical agent can materialize the same value twice. Identical
      // bytes are idempotent; a genuinely different value for a settled agent means the id was
      // reused, which would make an already-published cursor point at unrelated content.
      if (existing.checksum.value !== metadata.checksum.value) {
        throw new WorkflowStoreError(
          'corrupt-store',
          `Workflow agent ${agentId} already has a different result artifact: ${runId}`,
        )
      }
      return agentResultReference(result.reference, existing)
    }

    try {
      await writePrivateFileAtomically(this.#agentResultDataPath(runId, agentId), bytes)
      await writePrivateFileAtomically(
        this.#agentResultMetadataPath(runId, agentId),
        Buffer.from(`${JSON.stringify(metadata)}\n`, 'utf8'),
      )
      await syncDirectory(this.#artifactsDirectory(runId))
    } catch (cause) {
      if (cause instanceof WorkflowStoreError) throw cause
      throw new WorkflowStoreError('io-error', `Cannot persist agent result artifact: ${runId}/${agentId}`, { cause })
    }
    return agentResultReference(result.reference, metadata)
  }

  /**
   * Locate every agent's terminal bytes, artifact-first with a journal fallback.
   *
   * Returned map is keyed by the JOURNAL KEY (`v2:<sha256>`), not by agentId. Under
   * `exact-source-sparse` recovery a successor journal begins as a copy of its predecessor's
   * records and keeps the PREDECESSOR's agent ids until each key is re-admitted, so agentId is not
   * a stable join column across a lineage. cacheKey is.
   */
  async #journalResultsByKey(runId: string): Promise<Map<string, JournalResultLocator>> {
    // Cached on the journal file's identity (size + mtime), because the document is rewritten
    // wholesale on every admit and result, so any change moves both.
    //
    // WHY this cache is not optional: reading ONE agent from the journal parses EVERY agent's
    // result. Without it, paging a 1 MB value at the 16 KB default re-parsed the whole journal 64
    // times, and a bulk sweep of a resumed 200-agent run did it once per agent. Resumed runs are
    // both the worst case and the common one: reused agents complete through the agent.reused path,
    // which never materializes an artifact, so every agent in them is journal-served.
    const path = this.journalPath(runId)
    let identity = ''
    try {
      const info = await stat(path)
      identity = `${info.size}:${info.mtimeMs}`
      const cached = this.#journalResultCache.get(runId)
      if (cached !== undefined && cached.identity === identity) return cached.located
    } catch {
      // A journal we cannot stat is handled by the read below, which degrades to an empty map.
    }

    const located = new Map<string, JournalResultLocator>()
    let snapshots: readonly JournalSnapshot[]
    try {
      snapshots = await readWorkflowJournalSnapshots(path)
    } catch {
      // A journal this reader cannot parse must not take down inspection of a run whose artifacts
      // and events are perfectly readable. Callers degrade to `source: 'none'`.
      return located
    }
    for (const snapshot of snapshots) {
      for (const record of snapshot.records) {
        if (record.type !== 'result') continue
        located.set(record.key, {
          key: record.key,
          agentId: record.agentId,
          value: record.result,
          coverageGap: record.coverageGap === true,
        })
      }
    }
    if (identity !== '') this.#journalResultCache.set(runId, { identity, located })
    return located
  }

  async #agentResultBytes(
    runId: string,
    agentId: string,
    cacheKey: string | undefined,
  ): Promise<{ metadata: StoredWorkflowResultMetadata; source: 'artifact' | 'journal'; bytes?: Buffer }> {
    // A torn artifact (unreadable metadata, or metadata whose data file is gone) must fall through
    // to the journal rather than fail the read. Those are precisely the "the artifact write was
    // dropped or the disk filled" states the fallback exists for, and the journal still holds the
    // bytes. Previously only a MISSING metadata file fell through, so a half-written pair made
    // workflow_agent_list advertise a result that every read then refused.
    const artifact = await this.#readAgentResultMetadata(runId, agentId).catch(() => undefined)
    if (artifact !== undefined && await this.#agentArtifactDataUsable(runId, agentId, artifact)) {
      return { metadata: artifact, source: 'artifact' }
    }

    const journal = await this.#journalResultsByKey(runId)
    // cacheKey ONLY. Never fall back to scanning for a matching agentId: under exact-source-sparse
    // recovery a successor journal starts as a copy of its predecessor's records and keeps the
    // PREDECESSOR's agent ids until each key is re-admitted. Agent ids are positional (one runtime
    // counter), so agent_5 in this run and agent_5 in its parent are routinely different logical
    // calls. Review proved the scan served a predecessor's value as the terminal result of an agent
    // that had produced nothing at all, with the list reporting available: true beside it. A missing
    // result is a fine answer; a confidently wrong one is not.
    const record = cacheKey === undefined ? undefined : journal.get(cacheKey)
    if (record === undefined) {
      throw new WorkflowStoreError(
        'result-not-found',
        `Workflow agent ${agentId} has no readable result: ${runId}`,
      )
    }
    const serialized = serializeWorkflowValue(record.value)
    const bytes = Buffer.from(serialized.content, 'utf8')
    return {
      source: 'journal',
      bytes,
      metadata: {
        schemaVersion: 1,
        runId,
        artifactId: agentResultArtifactId(createHash('sha256').update(bytes).digest('hex')),
        mediaType: serialized.mediaType,
        sizeBytes: bytes.byteLength,
        lineCount: countUtf8Lines(bytes),
        checksum: { algorithm: 'sha256', value: createHash('sha256').update(bytes).digest('hex') },
        createdAt: new Date().toISOString(),
      },
    }
  }

  /**
   * Read one bounded UTF-8 page of an agent's terminal value.
   *
   * `artifactId` is optional here and required by readResult, on purpose: a completed run always
   * has exactly one result artifact to name, whereas a journal-served agent has no artifact at all.
   * When supplied it is still enforced as an integrity fence.
   */
  async readAgentResult(
    runId: string,
    agentId: string,
    input: WorkflowAgentResultReadInput,
  ): Promise<WorkflowAgentResultPage> {
    await this.#requiredManifest(runId)
    this.#assertAgentId(agentId)
    // Bounded here as well as at the MCP edge: WorkflowStore is exported public API, so the zod
    // schema is not the only door into this method. Mirrors readResult's guard.
    if (input.artifactId !== undefined && (input.artifactId.length === 0 || input.artifactId.length > 200)) {
      throw new WorkflowStoreError(
        'result-not-found',
        `Workflow agent result artifact does not exist for ${runId}/${agentId}`,
      )
    }
    if (input.cursor !== undefined && (input.cursor.length === 0 || input.cursor.length > 200)) {
      throw new WorkflowStoreError('invalid-cursor', 'Agent result cursor is malformed')
    }
    if (
      !Number.isSafeInteger(input.maxBytes) ||
      input.maxBytes < MIN_WORKFLOW_RESULT_PAGE_BYTES ||
      input.maxBytes > MAX_WORKFLOW_RESULT_PAGE_BYTES
    ) {
      throw new TypeError(
        `maxBytes must be an integer from ${MIN_WORKFLOW_RESULT_PAGE_BYTES} through ${MAX_WORKFLOW_RESULT_PAGE_BYTES}`,
      )
    }
    const located = await this.#agentResultBytes(runId, agentId, input.cacheKey)
    const { metadata, source } = located
    if (input.artifactId !== undefined && input.artifactId !== metadata.artifactId) {
      throw new WorkflowStoreError(
        'result-not-found',
        `Workflow agent result artifact does not exist for ${runId}/${agentId}`,
      )
    }
    const fromByte = parseResultCursor(input.cursor, metadata)

    if (located.bytes !== undefined) {
      // Journal path: the bytes are already resident, so slice in memory using the identical
      // boundary rules the file path uses. Recomputed per page — see readWorkflowJournalSnapshots
      // for why that is acceptable only as a fallback.
      return agentResultPage(runId, agentId, source, metadata, located.bytes, fromByte, input.maxBytes)
    }

    const path = this.#agentResultDataPath(runId, agentId)
    let handle
    try {
      handle = await open(path, 'r')
    } catch (cause) {
      if (isMissing(cause)) {
        throw new WorkflowStoreError(
          'result-not-found',
          `Workflow agent result artifact is missing: ${runId}/${agentId}`,
          { cause },
        )
      }
      throw new WorkflowStoreError('io-error', `Cannot open agent result: ${runId}/${agentId}`, { cause })
    }
    try {
      const info = await handle.stat()
      if (info.size !== metadata.sizeBytes || info.size > MAX_WORKFLOW_RESULT_BYTES) {
        throw new WorkflowStoreError(
          'corrupt-store',
          `Agent result size does not match its integrity metadata: ${runId}/${agentId}`,
        )
      }
      if (fromByte === metadata.sizeBytes) {
        return agentResultPage(runId, agentId, source, metadata, Buffer.alloc(0), fromByte, input.maxBytes)
      }
      const requestedBytes = Math.min(input.maxBytes, metadata.sizeBytes - fromByte)
      const buffer = Buffer.allocUnsafe(requestedBytes)
      const { bytesRead } = await handle.read(buffer, 0, requestedBytes, fromByte)
      if (bytesRead <= 0) {
        throw new WorkflowStoreError(
          'corrupt-store',
          `Agent result ended before byte ${fromByte}: ${runId}/${agentId}`,
        )
      }
      return agentResultPageFromSelection(
        runId,
        agentId,
        source,
        metadata,
        buffer.subarray(0, bytesRead),
        fromByte,
      )
    } finally {
      await handle.close()
    }
  }

  /**
   * Is this agent's artifact actually servable, or only half-present?
   *
   * Checked before advertising `source: 'artifact'` anywhere, because metadata and data are two
   * files written in sequence: a crash or a full disk between them leaves a locator pointing at
   * bytes that are absent or the wrong length. Cheaper to stat once here than to let the caller
   * discover it as a mid-pagination corrupt-store error.
   */
  async #agentArtifactDataUsable(
    runId: string,
    agentId: string,
    metadata: StoredWorkflowResultMetadata,
  ): Promise<boolean> {
    try {
      const info = await stat(this.#agentResultDataPath(runId, agentId))
      return info.isFile() && info.size === metadata.sizeBytes
    } catch {
      return false
    }
  }

  /** Locators for every agent, for the list tool. Absent entries mean "no terminal value yet". */
  async agentResultLocators(
    runId: string,
    agents: readonly { agentId: string; cacheKey: string }[],
  ): Promise<Map<string, { source: 'artifact' | 'journal'; metadata?: StoredWorkflowResultMetadata; coverageGap: boolean }>> {
    const locators = new Map<
      string,
      { source: 'artifact' | 'journal'; metadata?: StoredWorkflowResultMetadata; coverageGap: boolean }
    >()
    // Read the journal once for the whole list rather than once per agent — it is a single document
    // holding every result, so per-agent reads would be quadratic in the run's total output.
    const journal = await this.#journalResultsByKey(runId)
    for (const agent of agents) {
      const artifact = await this.#readAgentResultMetadata(runId, agent.agentId).catch(() => undefined)
      // cacheKey only — see the WHY in #agentResultBytes. The list must not advertise a result the
      // read would refuse to serve, so both sites resolve identically.
      const record = journal.get(agent.cacheKey)
      if (artifact !== undefined && await this.#agentArtifactDataUsable(runId, agent.agentId, artifact)) {
        locators.set(agent.agentId, {
          source: 'artifact',
          metadata: artifact,
          coverageGap: record?.coverageGap ?? false,
        })
        continue
      }
      if (record === undefined) continue
      locators.set(agent.agentId, { source: 'journal', coverageGap: record.coverageGap })
    }
    return locators
  }
}

async function readOwner(path: string): Promise<{
  ownerId: string
  pid: number
  processStartIdentity?: string
} | undefined> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as unknown
    if (
      !isObject(value) ||
      typeof value.ownerId !== 'string' ||
      !Number.isSafeInteger(value.pid) ||
      (value.pid as number) <= 0
    ) return undefined
    return {
      ownerId: value.ownerId,
      pid: value.pid as number,
      ...(typeof value.processStartIdentity === 'string'
        ? { processStartIdentity: value.processStartIdentity }
        : {}),
    }
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

async function ownerProcessIsAlive(owner: {
  pid: number
  processStartIdentity?: string
}): Promise<boolean> {
  if (!processIsAlive(owner.pid)) return false
  // Legacy locks have no start identity. Treat a live matching PID as owned rather than risking a
  // split brain; only newly written locks can safely distinguish PID reuse.
  if (owner.processStartIdentity === undefined) return true
  const currentIdentity = await readProcessStartIdentity(owner.pid)
  // Failure to inspect a live process is not proof it died (sandboxed `ps` is common in packaged
  // apps), so ambiguity remains fenced and may require manual stale-lock removal.
  return currentIdentity === undefined || currentIdentity === owner.processStartIdentity
}

async function readProcessStartIdentity(pid: number): Promise<string | undefined> {
  if (process.platform === 'win32') return undefined
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
    })
    const value = stdout.trim().replace(/\s+/g, ' ')
    return value.length === 0 ? undefined : value
  } catch {
    return undefined
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
  let result = manifest.result
  switch (event.type) {
    case 'run.started': status = 'running'; break
    case 'run.cancellation_requested':
      status = 'cancellation_requested'
      cancellationReason = event.payload.reason
      break
    case 'run.completed':
      status = event.payload.withErrors === true ? 'completed_with_errors' : 'completed'
      // Status polling needs the durable locator, but copying the inline result body into every
      // manifest rewrite would duplicate up to 10 KB and turn a small health response into another
      // result transport. Keep preview plus integrity metadata; events retain the compatible inline
      // `content` field for existing consumers.
      result = compactResultReference(event.payload.result)
      break
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
    ...(result === undefined ? {} : { result }),
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
    typeof value.workflow.description !== 'string' ||
    (value.result !== undefined && !isContentReference(value.result))
  ) {
    throw new WorkflowStoreError('corrupt-store', `Workflow manifest is invalid: ${path}`)
  }
  return value as WorkflowRunManifest
}

function compactResultReference(reference: ContentReference): ContentReference {
  const { content: _inlineContent, ...compact } = reference
  return compact
}

function isContentReference(value: unknown): value is ContentReference {
  if (
    !isObject(value) ||
    typeof value.preview !== 'string' ||
    !Number.isSafeInteger(value.lineCount) ||
    (value.lineCount as number) < 0 ||
    (value.artifactId !== undefined && typeof value.artifactId !== 'string') ||
    (value.mediaType !== undefined && typeof value.mediaType !== 'string') ||
    (value.truncated !== undefined && typeof value.truncated !== 'boolean') ||
    (
      value.sizeBytes !== undefined &&
      (!Number.isSafeInteger(value.sizeBytes) || (value.sizeBytes as number) < 0)
    ) ||
    (value.checksum !== undefined && !isContentChecksum(value.checksum))
  ) return false
  return true
}

function isContentChecksum(value: unknown): value is ContentChecksum {
  return isObject(value) &&
    value.algorithm === 'sha256' &&
    typeof value.value === 'string' &&
    /^[a-f0-9]{64}$/.test(value.value)
}

function parseResultMetadata(
  value: unknown,
  path: string,
  runId: string,
  maxResultBytes: number,
  // The scheme is injected rather than hardcoded because run results and per-agent results use
  // different ID namespaces over the same metadata shape. Two agents returning identical bytes
  // would otherwise mint identical IDs in one run-wide space.
  artifactIdFor: (checksum: string) => string = resultArtifactId,
): StoredWorkflowResultMetadata {
  if (
    !isObject(value) ||
    value.schemaVersion !== 1 ||
    value.runId !== runId ||
    typeof value.artifactId !== 'string' ||
    typeof value.mediaType !== 'string' ||
    value.mediaType.length === 0 ||
    value.mediaType.length > 255 ||
    !Number.isSafeInteger(value.sizeBytes) ||
    (value.sizeBytes as number) < 0 ||
    (value.sizeBytes as number) > maxResultBytes ||
    !Number.isSafeInteger(value.lineCount) ||
    (value.lineCount as number) < 0 ||
    typeof value.createdAt !== 'string' ||
    !isContentChecksum(value.checksum) ||
    value.artifactId !== artifactIdFor(value.checksum.value)
  ) {
    throw new WorkflowStoreError('corrupt-store', `Workflow result metadata is invalid: ${path}`)
  }
  const sizeBytes = value.sizeBytes as number
  const lineCount = value.lineCount as number
  if (
    (sizeBytes === 0 && lineCount !== 0) ||
    (sizeBytes > 0 && (lineCount < 1 || lineCount > sizeBytes + 1))
  ) {
    throw new WorkflowStoreError('corrupt-store', `Workflow result line metadata is invalid: ${path}`)
  }
  return value as StoredWorkflowResultMetadata
}

function resultArtifactId(checksum: string): string {
  // The ID is content-derived for stable integrity identity, but the file name is intentionally
  // fixed. A caller can hand back this opaque value; it can never turn into path traversal.
  return `result_sha256_${checksum}`
}

function agentResultArtifactId(checksum: string): string {
  // Namespaced away from the run result. Both are content-addressed, so two agents returning the
  // same bytes legitimately share an ID; that is safe only because lookup is equality against a
  // specific agent's own metadata, never a run-wide index keyed by ID.
  return `agent_result_sha256_${checksum}`
}

type JournalResultLocator = {
  key: string
  agentId: string
  value: unknown
  coverageGap: boolean
}

function agentResultReference(
  inline: ContentReference,
  metadata: StoredWorkflowResultMetadata,
): ContentReference {
  // Carries the same integrity metadata the run-result reference does. Publishing a bare artifactId
  // with no size or checksum beside it left a consumer unable to tell a complete read from a torn
  // one. Note the id lives in the agent_result_sha256_* namespace and is readable ONLY through
  // workflow_agent_result_read — handing it to workflow_result_read yields result-not-found.
  return {
    ...inline,
    artifactId: metadata.artifactId,
    mediaType: metadata.mediaType,
    lineCount: metadata.lineCount,
    sizeBytes: metadata.sizeBytes,
    checksum: metadata.checksum,
  }
}

/** Slice resident bytes with the same UTF-8 boundary rules the file path applies. */
function agentResultPage(
  runId: string,
  agentId: string,
  source: 'artifact' | 'journal',
  metadata: StoredWorkflowResultMetadata,
  bytes: Buffer,
  fromByte: number,
  maxBytes: number,
): WorkflowAgentResultPage {
  if (fromByte >= metadata.sizeBytes) {
    return {
      runId,
      agentId,
      source,
      artifact: publicArtifact(metadata),
      encoding: 'utf-8',
      fromByte,
      toByte: fromByte,
      content: '',
      hasMore: false,
    }
  }
  const selected = bytes.subarray(fromByte, Math.min(fromByte + maxBytes, metadata.sizeBytes))
  return agentResultPageFromSelection(runId, agentId, source, metadata, selected, fromByte)
}

function agentResultPageFromSelection(
  runId: string,
  agentId: string,
  source: 'artifact' | 'journal',
  metadata: StoredWorkflowResultMetadata,
  selected: Buffer,
  fromByte: number,
): WorkflowAgentResultPage {
  if (isUtf8ContinuationByte(selected[0]!)) {
    throw new WorkflowStoreError(
      'invalid-cursor',
      `Agent result cursor is not on a UTF-8 boundary: ${runId}/${agentId}`,
    )
  }
  const decoded = decodeCompleteUtf8Prefix(selected, runId)
  const toByte = fromByte + decoded.bytes
  if (toByte <= fromByte) {
    throw new WorkflowStoreError(
      'corrupt-store',
      `Agent result contains invalid UTF-8 at byte ${fromByte}: ${runId}/${agentId}`,
    )
  }
  const hasMore = toByte < metadata.sizeBytes
  return {
    runId,
    agentId,
    source,
    artifact: publicArtifact(metadata),
    encoding: 'utf-8',
    fromByte,
    toByte,
    content: decoded.content,
    hasMore,
    ...(hasMore ? { nextCursor: resultCursor(metadata, toByte) } : {}),
  }
}

function publicArtifact(metadata: StoredWorkflowResultMetadata): WorkflowResultArtifact {
  return {
    artifactId: metadata.artifactId,
    mediaType: metadata.mediaType,
    sizeBytes: metadata.sizeBytes,
    lineCount: metadata.lineCount,
    checksum: metadata.checksum,
  }
}

function resultCursor(metadata: StoredWorkflowResultMetadata, offset: number): string {
  return `v1.${metadata.checksum.value}.${offset}`
}

function parseResultCursor(
  cursor: string | undefined,
  metadata: StoredWorkflowResultMetadata,
): number {
  if (cursor === undefined) return 0
  const match = /^v1\.([a-f0-9]{64})\.(0|[1-9][0-9]*)$/.exec(cursor)
  const offset = match?.[2] === undefined ? Number.NaN : Number(match[2])
  if (
    match?.[1] !== metadata.checksum.value ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > metadata.sizeBytes
  ) {
    throw new WorkflowStoreError('invalid-cursor', 'Workflow result cursor is malformed or stale')
  }
  return offset
}

function resultReference(
  inline: ContentReference,
  metadata: StoredWorkflowResultMetadata,
): ContentReference {
  return {
    ...inline,
    artifactId: metadata.artifactId,
    mediaType: metadata.mediaType,
    sizeBytes: metadata.sizeBytes,
    lineCount: metadata.lineCount,
    checksum: metadata.checksum,
    // New durable references make the state explicit. Legacy events may omit false, but status and
    // completion readers should not have to infer whether a missing boolean predates artifacts.
    truncated: inline.truncated === true,
  }
}

function resultPage(
  runId: string,
  metadata: StoredWorkflowResultMetadata,
  fromByte: number,
  toByte: number,
  content: string,
  hasMore: boolean,
): WorkflowResultPage {
  return {
    runId,
    artifact: {
      artifactId: metadata.artifactId,
      mediaType: metadata.mediaType,
      sizeBytes: metadata.sizeBytes,
      lineCount: metadata.lineCount,
      checksum: metadata.checksum,
    },
    encoding: 'utf-8',
    fromByte,
    toByte,
    content,
    hasMore,
    ...(hasMore ? { nextCursor: resultCursor(metadata, toByte) } : {}),
  }
}

function countUtf8Lines(bytes: Buffer): number {
  if (bytes.length === 0) return 0
  let lines = 1
  for (const byte of bytes) if (byte === 0x0a) lines += 1
  return lines
}

function isUtf8ContinuationByte(byte: number): boolean {
  return (byte & 0xc0) === 0x80
}

function decodeCompleteUtf8Prefix(
  bytes: Buffer,
  runId: string,
): { bytes: number; content: string } {
  // A valid page can be incomplete only at its final scalar. Trying at most three trims is enough
  // because UTF-8 code points are at most four bytes; `fatal` also detects corruption in the
  // interior instead of replacing it with U+FFFD and invalidating the advertised checksum.
  // `ignoreBOM: true` means "do not consume it" in the Encoding API. Workflow strings may
  // legitimately begin with U+FEFF; silently stripping those three bytes would make concatenated
  // pages fail the checksum even though every page decoded successfully.
  for (let trim = 0; trim <= Math.min(3, bytes.length); trim += 1) {
    const length = bytes.length - trim
    try {
      // Use a fresh decoder after each fatal attempt; implementations are not required to preserve
      // useful state after throwing on an incomplete suffix.
      const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
      return { bytes: length, content: decoder.decode(bytes.subarray(0, length)) }
    } catch {
      // Try removing one more possible suffix byte. Interior corruption fails every attempt.
    }
  }
  throw new WorkflowStoreError('corrupt-store', `Workflow result contains invalid UTF-8: ${runId}`)
}

async function readBoundedFile(path: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(path, 'r')
  try {
    const before = await handle.stat()
    if (before.size > maxBytes) {
      throw new WorkflowStoreError('corrupt-store', `Workflow metadata file is too large: ${path}`)
    }
    const buffer = Buffer.alloc(before.size)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    const after = await handle.stat()
    if (offset !== buffer.length || after.size !== before.size) {
      throw new WorkflowStoreError('corrupt-store', `Workflow metadata changed while reading: ${path}`)
    }
    return buffer
  } finally {
    await handle.close()
  }
}

async function writePrivateFileAtomically(path: string, content: Buffer): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
  let handle
  try {
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(content)
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporary, path)
    await chmod(path, 0o600)
  } catch (cause) {
    await handle?.close().catch(() => undefined)
    await rm(temporary, { force: true }).catch(() => undefined)
    throw cause
  }
}

async function syncDirectory(path: string): Promise<void> {
  let handle
  try {
    handle = await open(path, 'r')
    await handle.sync()
  } catch (error) {
    // Windows does not expose directory fsync through Node. The files themselves are still synced
    // before publication; ignore only that platform limitation, never an unexpected POSIX error.
    if (process.platform !== 'win32') throw error
  } finally {
    await handle?.close().catch(() => undefined)
  }
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

function isLockExists(error: unknown): boolean {
  return isAlreadyExists(error) || (isObject(error) && error.code === 'ENOTEMPTY')
}
