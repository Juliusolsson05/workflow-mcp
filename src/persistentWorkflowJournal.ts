import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import type { ProviderSessionReference } from './agentProvider.js'
import {
  InMemoryWorkflowJournal,
  type JournalCall,
  type JournalDecision,
  type JournalIdentity,
  type JournalMiss,
  type JournalRecord,
  type JournalReuseMode,
  type JournalSessionRecord,
  type JournalSnapshot,
  type WorkflowJournal,
  type WorkflowJournalRun,
} from './workflowJournal.js'

const FORMAT = 'workflow-mcp-journal'
const VERSION = 2
const LEGACY_VERSION = 1
const MAX_FILE_BYTES = 256 * 1024 * 1024
const MAX_RECORDS = 100_000

type StoredJournal = {
  format: typeof FORMAT
  version: typeof VERSION
  snapshots: readonly JournalSnapshot[]
}

type ReadStoredJournal = {
  version: typeof VERSION | typeof LEGACY_VERSION
  snapshots: readonly JournalSnapshot[]
}

export class PersistentJournalError extends Error {
  readonly code: string

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'PersistentJournalError'
    this.code = code
  }
}

/**
 * A crash-safe workflow-lineage journal layered over the exact in-memory resume semantics.
 *
 * WHY the file is an atomic snapshot rather than another subtly different call matcher: matching,
 * prefix invalidation, and provider-session reuse remain owned by InMemoryWorkflowJournal. This
 * class only commits that state after each mutation. One sidecar contains the root and every nested
 * workflow identity in the run. An atomic replace buys a much simpler recovery rule than replaying
 * partially appended custom records alongside Claude's JSONL.
 */
export class PersistentWorkflowJournal implements WorkflowJournal {
  readonly filePath: string
  readonly #inner: InMemoryWorkflowJournal

  private constructor(filePath: string, snapshots: Iterable<JournalSnapshot>) {
    this.filePath = resolve(filePath)
    this.#inner = new InMemoryWorkflowJournal(snapshots)
  }

  static async open(
    filePath: string,
    fallbackSnapshots: Iterable<JournalSnapshot> = [],
  ): Promise<PersistentWorkflowJournal> {
    const fallback = [...fallbackSnapshots]
    const stored = await readStoredSnapshots(resolve(filePath))
    const snapshots = new Map<string, JournalSnapshot>()
    for (const snapshot of stored?.snapshots ?? []) snapshots.set(snapshot.workflowId, snapshot)

    for (const candidate of fallback) {
      const existing = snapshots.get(candidate.workflowId)
      if (existing !== undefined && existing.sourceHash !== candidate.sourceHash) {
        // A deterministic sidecar path can survive workflow edits. Silently preferring its old
        // source would discard a valid imported fallback and could resume provider sessions against
        // different code. This comparison is per nested identity, not merely the root workflow.
        throw new PersistentJournalError(
          'source-mismatch',
          `Persistent journal source does not match workflow ${candidate.workflowId}: ${resolve(filePath)}`,
        )
      }
      // A process can stop while replaying an imported prefix. At that point the sidecar only
      // contains calls admitted so far, while the immutable fallback may contain later valid
      // results. Unioning both histories preserves that tail; chained keys still invalidate the
      // suffix after the first real miss.
      snapshots.set(
        candidate.workflowId,
        existing === undefined ? candidate : mergeSnapshots(existing, candidate),
      )
    }

    const journal = new PersistentWorkflowJournal(filePath, snapshots.values())
    if (fallback.length > 0 || stored?.version === LEGACY_VERSION) {
      // Imported lineage must be durable before run.started can be published. This also migrates a
      // version-1 root-only file on first open instead of waiting for the next agent admission.
      journal.#persistAll()
    }
    return journal
  }

  beginRun(identity: JournalIdentity, options: { reuseMode?: JournalReuseMode } = {}): WorkflowJournalRun {
    const run = this.#inner.beginRun(identity, options)
    // Do not replace a complete durable prefix with an empty current run. `admit()` is the first
    // actual mutation and persists immediately; if the process dies between beginRun and admit,
    // retaining the previous snapshot is the only state that can still resume useful work.
    return new PersistentWorkflowJournalRun(run, () => this.#persistAll())
  }

  getSnapshot(workflowId: string): JournalSnapshot | undefined {
    return this.#inner.getSnapshot(workflowId)
  }

  getSnapshots(): readonly JournalSnapshot[] {
    return this.#inner.getSnapshots()
  }

  #persistAll(): void {
    persistAtomically(this.filePath, this.#inner.getSnapshots())
  }
}

/**
 * Seed a successor's complete lineage before its manifest becomes visible to startup recovery.
 *
 * WHY this is exported instead of calling `open()` after createRun: that ordering creates a crash
 * window where startup sees a queued successor but no inherited journal, then reruns completed
 * siblings. FileWorkflowStore calls this while the run directory is still unpublished.
 */
export function writeInitialWorkflowJournal(
  filePath: string,
  snapshots: readonly JournalSnapshot[],
): void {
  if (snapshots.length === 0) return
  persistAtomically(resolve(filePath), snapshots)
}

function mergeSnapshots(primary: JournalSnapshot, fallback: JournalSnapshot): JournalSnapshot {
  return {
    workflowId: primary.workflowId,
    sourceHash: primary.sourceHash,
    records: [...primary.records, ...fallback.records],
    sessions: [...(primary.sessions ?? []), ...(fallback.sessions ?? [])],
  }
}

class PersistentWorkflowJournalRun implements WorkflowJournalRun {
  readonly #inner: WorkflowJournalRun
  readonly #persist: () => void

  constructor(inner: WorkflowJournalRun, persist: () => void) {
    this.#inner = inner
    this.#persist = persist
  }

  admit(call: JournalCall): JournalDecision {
    const decision = this.#inner.admit(call)
    this.#persist()
    return decision
  }

  recordProviderSession(decision: JournalMiss, session: ProviderSessionReference): void {
    this.#inner.recordProviderSession(decision, session)
    this.#persist()
  }

  recordResult(decision: JournalMiss, result: unknown, options: { successful?: boolean } = {}): void {
    this.#inner.recordResult(decision, result, options)
    this.#persist()
  }

  snapshot(): JournalSnapshot {
    return this.#inner.snapshot()
  }
}

function persistAtomically(filePath: string, snapshots: readonly JournalSnapshot[]): void {
  const directory = dirname(filePath)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`
  try {
    validateSnapshotCollection(snapshots, filePath)
    const journal: StoredJournal = { format: FORMAT, version: VERSION, snapshots }
    const content = `${JSON.stringify(journal)}\n`
    if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) {
      throw new PersistentJournalError(
        'file-too-large',
        `Workflow journal exceeds ${MAX_FILE_BYTES} bytes: ${filePath}`,
      )
    }
    // Results can contain source fragments or business data. 0600 is intentional even when a user's
    // umask is permissive; standalone resume state should have the same privacy posture as provider
    // transcripts, not ordinary checked-in project files.
    const file = openSync(temporary, 'wx', 0o600)
    try {
      writeFileSync(file, content, { encoding: 'utf8' })
      // WHY rename alone is not a durable checkpoint: an OS may acknowledge the replace while the
      // new bytes remain only in page cache. Resume correctness depends on a reported tool result
      // surviving sudden power loss, so flush the bytes before publishing the new name.
      fsyncSync(file)
    } finally {
      closeSync(file)
    }
    renameSync(temporary, filePath)
    if (process.platform !== 'win32') {
      // WHY the directory is flushed after rename: fsyncing the file protects its contents, but
      // POSIX does not promise the new directory entry survives a crash until the directory itself
      // is synced. Windows does not expose portable directory fsync through Node.
      const parent = openSync(directory, 'r')
      try {
        fsyncSync(parent)
      } finally {
        closeSync(parent)
      }
    }
  } catch (cause) {
    rmSync(temporary, { force: true })
    if (cause instanceof PersistentJournalError) throw cause
    throw new PersistentJournalError('write-failed', `Cannot persist workflow journal: ${filePath}`, {
      cause,
    })
  }
}

async function readStoredSnapshots(filePath: string): Promise<ReadStoredJournal | undefined> {
  let info
  try {
    info = await stat(filePath)
  } catch (cause) {
    if (isMissing(cause)) return undefined
    throw new PersistentJournalError('read-failed', `Cannot read workflow journal: ${filePath}`, {
      cause,
    })
  }
  if (!info.isFile()) {
    throw new PersistentJournalError('not-a-file', `Workflow journal is not a file: ${filePath}`)
  }
  if (info.size > MAX_FILE_BYTES) {
    throw new PersistentJournalError(
      'file-too-large',
      `Workflow journal exceeds ${MAX_FILE_BYTES} bytes: ${filePath}`,
    )
  }

  let value: unknown
  try {
    value = JSON.parse(await readFile(filePath, 'utf8')) as unknown
  } catch (cause) {
    throw new PersistentJournalError('invalid-json', `Workflow journal is not valid JSON: ${filePath}`, {
      cause,
    })
  }
  return parseStoredJournal(value, filePath)
}

function parseStoredJournal(value: unknown, filePath: string): ReadStoredJournal {
  if (!isObject(value) || value.format !== FORMAT) {
    throw new PersistentJournalError('invalid-format', `Workflow journal has an unknown format: ${filePath}`)
  }
  if (value.version === LEGACY_VERSION) {
    if (!isObject(value.snapshot)) {
      throw new PersistentJournalError('invalid-snapshot', `Workflow journal snapshot is invalid: ${filePath}`)
    }
    const snapshot = parseSnapshot(value.snapshot, filePath, 'snapshot')
    validateSnapshotCollection([snapshot], filePath)
    return { version: LEGACY_VERSION, snapshots: [snapshot] }
  }
  if (value.version !== VERSION || !Array.isArray(value.snapshots)) {
    throw new PersistentJournalError('invalid-format', `Workflow journal has an unknown format: ${filePath}`)
  }
  const snapshots = value.snapshots.map((snapshot, index) => (
    parseSnapshot(snapshot, filePath, `snapshot ${index + 1}`)
  ))
  validateSnapshotCollection(snapshots, filePath)
  return { version: VERSION, snapshots }
}

function parseSnapshot(value: unknown, filePath: string, label: string): JournalSnapshot {
  if (!isObject(value)) {
    throw new PersistentJournalError('invalid-snapshot', `Workflow journal ${label} is invalid: ${filePath}`)
  }
  const snapshot = value
  if (
    typeof snapshot.workflowId !== 'string' ||
    snapshot.workflowId.length === 0 ||
    typeof snapshot.sourceHash !== 'string' ||
    snapshot.sourceHash.length === 0 ||
    !Array.isArray(snapshot.records) ||
    snapshot.records.length > MAX_RECORDS
  ) {
    throw new PersistentJournalError(
      'invalid-snapshot',
      `Workflow journal ${label} identity is invalid: ${filePath}`,
    )
  }

  const records = snapshot.records.map((record, index) => parseRecord(record, filePath, index))
  const sessions = snapshot.sessions === undefined
    ? undefined
    : parseSessions(snapshot.sessions, filePath)
  return {
    workflowId: snapshot.workflowId,
    sourceHash: snapshot.sourceHash,
    records,
    ...(sessions === undefined ? {} : { sessions }),
  }
}

function validateSnapshotCollection(
  snapshots: readonly JournalSnapshot[],
  filePath: string,
): void {
  const workflowIds = new Set<string>()
  let entries = 0
  for (const snapshot of snapshots) {
    if (
      snapshot.workflowId.length === 0 ||
      snapshot.sourceHash.length === 0 ||
      snapshot.records.length > MAX_RECORDS ||
      (snapshot.sessions?.length ?? 0) > MAX_RECORDS
    ) {
      throw new PersistentJournalError(
        'invalid-snapshot',
        `Workflow journal snapshot identity or size is invalid: ${filePath}`,
      )
    }
    if (workflowIds.has(snapshot.workflowId)) {
      throw new PersistentJournalError(
        'duplicate-workflow',
        `Workflow journal contains duplicate identity ${snapshot.workflowId}: ${filePath}`,
      )
    }
    workflowIds.add(snapshot.workflowId)
    entries += snapshot.records.length + (snapshot.sessions?.length ?? 0)
    if (entries > MAX_RECORDS) {
      // The cap is lineage-wide. Capping each child independently would let a deeply nested
      // workflow multiply the sidecar without bound and turn every admission into a huge sync write.
      throw new PersistentJournalError(
        'too-many-records',
        `Persistent journal exceeds ${MAX_RECORDS} aggregate records`,
      )
    }
  }
}

function parseRecord(value: unknown, filePath: string, index: number): JournalRecord {
  if (
    !isObject(value) ||
    (value.type !== 'started' && value.type !== 'result') ||
    typeof value.key !== 'string' ||
    !/^v2:[a-f0-9]{64}$/.test(value.key) ||
    typeof value.agentId !== 'string' ||
    value.agentId.length === 0
  ) {
    throw new PersistentJournalError(
      'invalid-record',
      `Workflow journal record ${index + 1} is invalid: ${filePath}`,
    )
  }
  if (value.type === 'started') return { type: 'started', key: value.key, agentId: value.agentId }
  if (!Object.prototype.hasOwnProperty.call(value, 'result')) {
    throw new PersistentJournalError(
      'invalid-record',
      `Workflow journal result ${index + 1} has no value: ${filePath}`,
    )
  }
  if (value.successful !== undefined && typeof value.successful !== 'boolean') {
    throw new PersistentJournalError(
      'invalid-record',
      `Workflow journal result ${index + 1} has an invalid success marker: ${filePath}`,
    )
  }
  return {
    type: 'result',
    key: value.key,
    agentId: value.agentId,
    result: value.result,
    ...(value.successful === undefined ? {} : { successful: value.successful }),
  }
}

function parseSessions(value: unknown, filePath: string): JournalSessionRecord[] {
  if (!Array.isArray(value) || value.length > MAX_RECORDS) {
    throw new PersistentJournalError('invalid-sessions', `Workflow journal sessions are invalid: ${filePath}`)
  }
  return value.map((entry, index) => {
    if (
      !isObject(entry) ||
      typeof entry.key !== 'string' ||
      !/^v2:[a-f0-9]{64}$/.test(entry.key) ||
      typeof entry.agentId !== 'string' ||
      entry.agentId.length === 0 ||
      !isObject(entry.session) ||
      typeof entry.session.provider !== 'string' ||
      entry.session.provider.length === 0 ||
      typeof entry.session.id !== 'string' ||
      entry.session.id.length === 0
    ) {
      throw new PersistentJournalError(
        'invalid-session',
        `Workflow journal session ${index + 1} is invalid: ${filePath}`,
      )
    }
    return {
      key: entry.key,
      agentId: entry.agentId,
      session: { provider: entry.session.provider, id: entry.session.id },
    }
  })
}

function isMissing(cause: unknown): boolean {
  return isObject(cause) && cause.code === 'ENOENT'
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
