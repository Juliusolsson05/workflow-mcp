import { createHash } from 'node:crypto'
import { open, readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { loadWorkflowFile } from './loadWorkflow.js'
import type { LoadedWorkflow } from './loadWorkflow.js'
import { InMemoryWorkflowJournal } from './workflowJournal.js'
import { createImportedPromptKey } from './workflowJournal.js'
import type { JournalImportedCall, JournalRecord, JournalSnapshot } from './workflowJournal.js'

const MAX_CLAUDE_RUN_BYTES = 16 * 1024 * 1024
const MAX_CLAUDE_JOURNAL_BYTES = 256 * 1024 * 1024
const MAX_CLAUDE_JOURNAL_RECORDS = 100_000
const MAX_CLAUDE_AGENT_PROMPT_BYTES = 4 * 1024 * 1024
const CLAUDE_TRANSCRIPT_READ_CONCURRENCY = 16

export type ClaudeWorkflowRunMetadata = {
  runId: string
  workflowName: string
  status?: string
  scriptPath: string
  script?: string
  agentCount?: number
  args?: unknown
}

export type ClaudeWorkflowResume = {
  workflow: LoadedWorkflow
  journal: InMemoryWorkflowJournal
  metadata: ClaudeWorkflowRunMetadata
  metadataPath: string
  journalPath: string
  journalRecordCount: number
  importedPromptCount: number
}

export class ClaudeResumeError extends Error {
  readonly code: string

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ClaudeResumeError'
    this.code = code
  }
}

export function claudeResumeSidecarPath(metadataFilePath: string): string {
  // Hash the canonical metadata path instead of exposing Claude's long project/session hierarchy in
  // filenames. The sidecar remains deterministic across launches but lives in workflow-mcp's own
  // private state directory; Claude can keep reading and writing its native journal independently.
  const identity = createHash('sha256').update(resolve(metadataFilePath), 'utf8').digest('hex')
  return join(homedir(), '.workflow-mcp', 'journals', `${identity}.json`)
}

export async function findClaudeWorkflowRunMetadata(
  projectRoot: string,
  runId: string,
): Promise<string> {
  if (!/^wf_[a-z0-9-]{6,}$/.test(runId)) {
    throw new ClaudeResumeError('invalid-run-id', `Invalid Claude workflow run ID: ${JSON.stringify(runId)}`)
  }
  const root = resolve(projectRoot)
  let sessions
  try {
    sessions = await readdir(root, { withFileTypes: true })
  } catch (cause) {
    if (isMissing(cause)) {
      throw new ClaudeResumeError('run-not-found', `Cannot find Claude workflow run ${runId}`, { cause })
    }
    throw new ClaudeResumeError('read-error', `Cannot inspect Claude project state: ${root}`, { cause })
  }

  // Claude nests workflow metadata beneath an opaque session directory. We inspect exactly that
  // one documented level instead of recursively walking ~/.claude: bounded discovery keeps a typo
  // from turning an MCP call into an unbounded home-directory scan, and it makes project scoping
  // auditable from this function alone.
  const candidates: string[] = []
  for (const session of sessions) {
    if (!session.isDirectory()) continue
    const metadataPath = join(root, session.name, 'workflows', `${runId}.json`)
    try {
      if ((await stat(metadataPath)).isFile()) candidates.push(metadataPath)
    } catch (cause) {
      if (isMissing(cause)) continue
      throw new ClaudeResumeError('read-error', `Cannot inspect Claude run metadata: ${metadataPath}`, {
        cause,
      })
    }
  }
  if (candidates.length === 0) {
    throw new ClaudeResumeError('run-not-found', `Cannot find Claude workflow run ${runId}`)
  }
  if (candidates.length > 1) {
    // Run IDs are expected to identify one execution globally. Choosing the newest duplicate would
    // silently attach historical agent results to whichever session happened to win an mtime race,
    // so ambiguity is an integrity failure that requires the explicit claudeRunPath escape hatch.
    throw new ClaudeResumeError(
      'ambiguous-run',
      `Claude workflow run ${runId} exists in multiple sessions; use claudeRunPath explicitly`,
    )
  }

  const metadataPath = candidates[0] as string
  const metadata = parseMetadata(
    await readBoundedJson(metadataPath, MAX_CLAUDE_RUN_BYTES, 'Claude run metadata'),
    metadataPath,
  )
  if (metadata.runId !== runId) {
    throw new ClaudeResumeError(
      'run-id-mismatch',
      `Claude run metadata ${metadataPath} contains ${JSON.stringify(metadata.runId)}, not ${JSON.stringify(runId)}`,
    )
  }
  return metadataPath
}

/**
 * Load the exact persisted state Claude uses to resume a dynamic workflow.
 *
 * WHY this is an importer rather than a second journal implementation: the v2 records are already
 * the compatibility format used by InMemoryWorkflowJournal. Translating them into another cache
 * shape would make cross-provider resume subtly different from ordinary prefix reuse. The only
 * runtime-owned fields we add are the current workflow identity and its verified source hash.
 */
export async function loadClaudeWorkflowResume(
  metadataFilePath: string,
  options: { workflowPath?: string } = {},
): Promise<ClaudeWorkflowResume> {
  const metadataPath = resolve(metadataFilePath)
  const metadataValue = await readBoundedJson(metadataPath, MAX_CLAUDE_RUN_BYTES, 'Claude run metadata')
  const metadata = parseMetadata(metadataValue, metadataPath)
  const workflow = await loadWorkflowFile(options.workflowPath ?? metadata.scriptPath)

  if (workflow.meta.name !== metadata.workflowName) {
    throw new ClaudeResumeError(
      'workflow-name-mismatch',
      `Claude run is for ${JSON.stringify(metadata.workflowName)}, not ${JSON.stringify(workflow.meta.name)}`,
    )
  }

  // Claude stores the approved source directly in run metadata and as a saved script. Resume must
  // never apply historical results to a changed program merely because the human-facing name is
  // unchanged. This is the same source gate used by the native Claude journal path.
  const approvedHash = metadata.script === undefined
    ? (await loadWorkflowFile(metadata.scriptPath)).sourceHash
    : createHash('sha256').update(metadata.script, 'utf8').digest('hex')
  if (approvedHash !== workflow.sourceHash) {
    throw new ClaudeResumeError(
      'workflow-source-mismatch',
      'The workflow file differs from the source saved with this Claude run; refusing unsafe resume',
    )
  }

  const journalPath = resolve(
    dirname(metadataPath),
    '..',
    'subagents',
    'workflows',
    metadata.runId,
    'journal.jsonl',
  )
  const records = await readClaudeJournal(journalPath)
  const importedCalls = await readClaudeImportedCalls(dirname(journalPath), records)
  const workflowId = workflow.filePath ?? workflow.meta.name
  const snapshot: JournalSnapshot = {
    workflowId,
    sourceHash: workflow.sourceHash,
    records,
    ...(importedCalls.length === 0 ? {} : { importedCalls }),
  }

  return {
    workflow,
    journal: new InMemoryWorkflowJournal([snapshot]),
    metadata,
    metadataPath,
    journalPath,
    journalRecordCount: records.length,
    importedPromptCount: importedCalls.length,
  }
}

async function readBoundedJson(path: string, maxBytes: number, label: string): Promise<unknown> {
  let file
  try {
    file = await stat(path)
  } catch (cause) {
    throw new ClaudeResumeError('read-error', `Cannot read ${label}: ${path}`, { cause })
  }
  if (!file.isFile()) throw new ClaudeResumeError('not-a-file', `${label} must be a regular file: ${path}`)
  if (file.size > maxBytes) {
    throw new ClaudeResumeError('file-too-large', `${label} exceeds ${maxBytes} bytes: ${path}`)
  }
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown
  } catch (cause) {
    throw new ClaudeResumeError('invalid-json', `${label} is not valid JSON: ${path}`, { cause })
  }
}

function parseMetadata(value: unknown, path: string): ClaudeWorkflowRunMetadata {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ClaudeResumeError('invalid-metadata', `Claude run metadata must be an object: ${path}`)
  }
  const input = value as Record<string, unknown>
  for (const name of ['runId', 'workflowName', 'scriptPath'] as const) {
    if (typeof input[name] !== 'string' || input[name].length === 0) {
      throw new ClaudeResumeError('invalid-metadata', `Claude run metadata requires ${name}: ${path}`)
    }
  }
  return {
    runId: input.runId as string,
    workflowName: input.workflowName as string,
    scriptPath: input.scriptPath as string,
    ...(typeof input.status === 'string' ? { status: input.status } : {}),
    ...(typeof input.script === 'string' ? { script: input.script } : {}),
    ...(Number.isSafeInteger(input.agentCount) && (input.agentCount as number) >= 0
      ? { agentCount: input.agentCount as number }
      : {}),
    // Property presence matters: JSON null is a real workflow argument, while an absent field means
    // the original invocation did not supply args at all. Keep that distinction so the service can
    // recreate the same worker global before enabling exact-source sparse reuse.
    ...(Object.prototype.hasOwnProperty.call(input, 'args') ? { args: input.args } : {}),
  }
}

async function readClaudeJournal(path: string): Promise<JournalRecord[]> {
  let file
  try {
    file = await stat(path)
  } catch (cause) {
    throw new ClaudeResumeError('journal-read-error', `Cannot read Claude workflow journal: ${path}`, {
      cause,
    })
  }
  if (!file.isFile()) throw new ClaudeResumeError('journal-not-a-file', `Claude journal is not a file: ${path}`)
  if (file.size > MAX_CLAUDE_JOURNAL_BYTES) {
    throw new ClaudeResumeError(
      'journal-too-large',
      `Claude journal exceeds ${MAX_CLAUDE_JOURNAL_BYTES} bytes: ${path}`,
    )
  }

  const text = await readFile(path, 'utf8')
  const records: JournalRecord[] = []
  for (const [index, rawLine] of text.split('\n').entries()) {
    const line = rawLine.trim()
    if (line.length === 0) continue
    if (records.length >= MAX_CLAUDE_JOURNAL_RECORDS) {
      throw new ClaudeResumeError(
        'journal-too-many-records',
        `Claude journal exceeds ${MAX_CLAUDE_JOURNAL_RECORDS} records`,
      )
    }
    let value: unknown
    try {
      value = JSON.parse(line) as unknown
    } catch (cause) {
      throw new ClaudeResumeError(
        'journal-invalid-json',
        `Claude journal line ${index + 1} is not valid JSON`,
        { cause },
      )
    }
    records.push(parseJournalRecord(value, index + 1))
  }
  return records
}

function parseJournalRecord(value: unknown, line: number): JournalRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ClaudeResumeError('journal-invalid-record', `Claude journal line ${line} is not an object`)
  }
  const input = value as Record<string, unknown>
  if (
    (input.type !== 'started' && input.type !== 'result') ||
    typeof input.key !== 'string' ||
    !/^v2:[a-f0-9]{64}$/.test(input.key) ||
    typeof input.agentId !== 'string' ||
    input.agentId.length === 0
  ) {
    throw new ClaudeResumeError('journal-invalid-record', `Claude journal line ${line} has invalid identity`)
  }
  if (input.type === 'started') return { type: 'started', key: input.key, agentId: input.agentId }
  if (!Object.prototype.hasOwnProperty.call(input, 'result')) {
    throw new ClaudeResumeError('journal-invalid-record', `Claude result line ${line} has no result`)
  }
  return { type: 'result', key: input.key, agentId: input.agentId, result: input.result }
}

async function readClaudeImportedCalls(
  runDirectory: string,
  records: readonly JournalRecord[],
): Promise<JournalImportedCall[]> {
  let entries
  try {
    entries = await readdir(runDirectory, { withFileTypes: true })
  } catch {
    // Claude's journal remains sufficient for ordinary longest-prefix reuse. Transcript indexing is
    // an optimization for dynamic fan-out, so an older or partially cleaned run must degrade to the
    // existing behavior instead of making an otherwise valid resume impossible.
    return []
  }
  const transcriptNames = new Set(
    entries.filter((entry) => entry.isFile()).map((entry) => entry.name),
  )
  const seenStarts = new Set<string>()
  const starts = records.filter((record): record is Extract<JournalRecord, { type: 'started' }> => {
    if (record.type !== 'started') return false
    const identity = `${record.key}\0${record.agentId}`
    if (seenStarts.has(identity)) return false
    // Claude may append the same logical start again around a provider retry. One transcript hash is
    // enough to index that identity; emitting duplicate capability records would turn an otherwise
    // conservatively resumable journal into a validation failure in the in-memory boundary.
    seenStarts.add(identity)
    return true
  })
  const imported: Array<JournalImportedCall | undefined> = new Array(starts.length)
  let cursor = 0

  const worker = async (): Promise<void> => {
    while (cursor < starts.length) {
      const index = cursor
      cursor += 1
      const record = starts[index]
      if (record === undefined) continue
      // Agent IDs belong to Claude's journal contract, which historically allowed any non-empty
      // string. Keep accepting that journal, but only derive a sibling filename from the bounded
      // filename-safe IDs emitted by real Claude versions; an exotic legacy ID simply keeps normal
      // chained-prefix behavior instead of gaining a path traversal primitive.
      if (!/^[A-Za-z0-9_-]{1,200}$/.test(record.agentId)) continue
      const name = `agent-${record.agentId}.jsonl`
      if (!transcriptNames.has(name)) continue
      const prompt = await readClaudeAgentPrompt(join(runDirectory, name), record.agentId)
      if (prompt === undefined) continue
      imported[index] = {
        key: record.key,
        agentId: record.agentId,
        promptKey: createImportedPromptKey(prompt),
      }
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(CLAUDE_TRANSCRIPT_READ_CONCURRENCY, starts.length) },
      () => worker(),
    ),
  )
  return imported.filter((record): record is JournalImportedCall => record !== undefined)
}

async function readClaudeAgentPrompt(path: string, expectedAgentId: string): Promise<string | undefined> {
  const line = await readBoundedFirstLine(path)
  if (line === undefined) return undefined
  let value: unknown
  try {
    value = JSON.parse(line) as unknown
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const entry = value as Record<string, unknown>
  if (entry.type !== 'user' || entry.agentId !== expectedAgentId) return undefined
  if (typeof entry.message !== 'object' || entry.message === null || Array.isArray(entry.message)) {
    return undefined
  }
  const message = entry.message as Record<string, unknown>
  return message.role === 'user' && typeof message.content === 'string'
    ? message.content
    : undefined
}

async function readBoundedFirstLine(path: string): Promise<string | undefined> {
  let file
  try {
    file = await open(path, 'r')
  } catch {
    return undefined
  }
  try {
    const chunks: Buffer[] = []
    let total = 0
    let position = 0
    while (total <= MAX_CLAUDE_AGENT_PROMPT_BYTES) {
      const remaining = MAX_CLAUDE_AGENT_PROMPT_BYTES + 1 - total
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remaining))
      const { bytesRead } = await file.read(buffer, 0, buffer.length, position)
      if (bytesRead === 0) return Buffer.concat(chunks).toString('utf8')
      position += bytesRead
      const bytes = buffer.subarray(0, bytesRead)
      const newline = bytes.indexOf(0x0a)
      const firstLineBytes = newline === -1 ? bytes : bytes.subarray(0, newline)
      if (total + firstLineBytes.length > MAX_CLAUDE_AGENT_PROMPT_BYTES) return undefined
      chunks.push(firstLineBytes)
      total += firstLineBytes.length
      if (newline !== -1) return Buffer.concat(chunks).toString('utf8')
    }
    return undefined
  } catch {
    return undefined
  } finally {
    await file.close().catch(() => undefined)
  }
}

function isMissing(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'code' in value && (
    value.code === 'ENOENT' || value.code === 'ENOTDIR'
  )
}
