import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { loadWorkflowFile } from './loadWorkflow.js'
import type { LoadedWorkflow } from './loadWorkflow.js'
import { InMemoryWorkflowJournal } from './workflowJournal.js'
import type { JournalRecord, JournalSnapshot } from './workflowJournal.js'

const MAX_CLAUDE_RUN_BYTES = 16 * 1024 * 1024
const MAX_CLAUDE_JOURNAL_BYTES = 256 * 1024 * 1024
const MAX_CLAUDE_JOURNAL_RECORDS = 100_000

export type ClaudeWorkflowRunMetadata = {
  runId: string
  workflowName: string
  status?: string
  scriptPath: string
  script?: string
  agentCount?: number
}

export type ClaudeWorkflowResume = {
  workflow: LoadedWorkflow
  journal: InMemoryWorkflowJournal
  metadata: ClaudeWorkflowRunMetadata
  metadataPath: string
  journalPath: string
  journalRecordCount: number
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
  const workflowId = workflow.filePath ?? workflow.meta.name
  const snapshot: JournalSnapshot = {
    workflowId,
    sourceHash: workflow.sourceHash,
    records,
  }

  return {
    workflow,
    journal: new InMemoryWorkflowJournal([snapshot]),
    metadata,
    metadataPath,
    journalPath,
    journalRecordCount: records.length,
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
