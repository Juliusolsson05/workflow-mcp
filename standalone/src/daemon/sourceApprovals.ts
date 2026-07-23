import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { realpath } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import type { WorkflowService } from 'workflow-mcp'

const MAX_APPROVAL_FILE_BYTES = 1024 * 1024
const MAX_APPROVALS = 10_000

export type SourceApproval = Readonly<{
  workflowName: string
  sourceHash: string
  canonicalIdentityHash: string
  projectHash: string
  approvedAt: string
}>

type SourceApprovalDocument = Readonly<{
  schemaVersion: 1
  approvals: readonly SourceApproval[]
}>

/**
 * Durable authorization for workflow code which appeared after daemon startup.
 *
 * Absolute host/container paths are intentionally never persisted or returned. A salted identity
 * hash preserves the security join key without turning backups, diagnostics, or the admin API into
 * a filesystem-path disclosure channel. Project identity is part of every key, so restoring the
 * same bytes for a different checkout cannot silently transfer execution authority.
 */
export class SourceApprovalStore {
  readonly #path: string
  readonly #projectHash: string
  #records: SourceApproval[] = []

  constructor(dataDirectory: string, projectHash: string) {
    if (!/^[a-f0-9]{64}$/.test(projectHash)) throw new Error('Project hash is invalid')
    this.#path = join(resolve(dataDirectory), 'approvals', 'sources.json')
    this.#projectHash = projectHash
  }

  initialize(): void {
    if (!existsSync(this.#path)) return
    const info = lstatSync(this.#path)
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_APPROVAL_FILE_BYTES) {
      throw new Error('Source approval file is not a bounded ordinary file')
    }
    let value: unknown
    try {
      value = JSON.parse(readFileSync(this.#path, 'utf8')) as unknown
    } catch (cause) {
      throw new Error('Source approval file is unreadable', { cause })
    }
    this.#records = parseDocument(value).approvals.slice()
  }

  isApproved(canonicalIdentity: string, sourceHash: string): boolean {
    const identity = hashCanonicalIdentity(canonicalIdentity)
    return this.#records.some(record => (
      record.projectHash === this.#projectHash &&
      record.canonicalIdentityHash === identity &&
      record.sourceHash === sourceHash
    ))
  }

  list(): readonly SourceApproval[] {
    return this.#records
      .filter(record => record.projectHash === this.#projectHash)
      .sort((left, right) => (
        left.workflowName.localeCompare(right.workflowName) ||
        left.approvedAt.localeCompare(right.approvedAt)
      ))
      .map(record => Object.freeze({ ...record }))
  }

  /** Call only inside WorkflowService.runAdministrativeMutation(). */
  commit(input: { workflowName: string; canonicalIdentity: string; sourceHash: string }): SourceApproval {
    const record: SourceApproval = Object.freeze({
      workflowName: input.workflowName,
      sourceHash: input.sourceHash,
      canonicalIdentityHash: hashCanonicalIdentity(input.canonicalIdentity),
      projectHash: this.#projectHash,
      approvedAt: new Date().toISOString(),
    })
    const retained = this.#records.filter(existing => !(
      existing.projectHash === record.projectHash &&
      existing.canonicalIdentityHash === record.canonicalIdentityHash &&
      existing.workflowName === record.workflowName
    ))
    const next = [...retained, record]
    if (next.length > MAX_APPROVALS) throw new Error(`Source approvals exceed ${MAX_APPROVALS}`)
    writeDocumentAtomically(this.#path, { schemaVersion: 1, approvals: next })
    // Memory changes only after rename and parent fsync. A failed disk commit therefore cannot
    // create process-local authority that disappears or changes meaning after restart.
    this.#records = next
    return record
  }
}

export async function approveVisibleWorkflow(input: {
  service: WorkflowService
  approvals: SourceApprovalStore
  workspace: string
  workflowName: string
  expectedSourceHash?: string
}): Promise<SourceApproval> {
  const workflow = await input.service.describe({ cwd: input.workspace }, { name: input.workflowName })
  if (input.expectedSourceHash !== undefined && workflow.sourceHash !== input.expectedSourceHash) {
    throw Object.assign(new Error(
      `Workflow ${input.workflowName} changed: expected ${input.expectedSourceHash}, found ${workflow.sourceHash}`,
    ), { code: 'source-changed' })
  }
  return input.service.runAdministrativeMutation(async () => input.approvals.commit({
    workflowName: workflow.meta.name,
    canonicalIdentity: await realpath(workflow.filePath).catch(() => resolve(workflow.filePath)),
    sourceHash: workflow.sourceHash,
  }))
}

function hashCanonicalIdentity(identity: string): string {
  return createHash('sha256').update(`workflow-mcp-source-identity-v1\0${resolve(identity)}`).digest('hex')
}

function writeDocumentAtomically(path: string, document: SourceApprovalDocument): void {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
  try {
    const handle = openSync(temporary, 'wx', 0o600)
    try {
      writeFileSync(handle, `${JSON.stringify(document)}\n`, 'utf8')
      fsyncSync(handle)
    } finally {
      closeSync(handle)
    }
    renameSync(temporary, path)
    const parent = openSync(dirname(path), 'r')
    try {
      fsyncSync(parent)
    } finally {
      closeSync(parent)
    }
  } catch (cause) {
    rmSync(temporary, { force: true })
    throw new Error('Cannot commit source approval', { cause })
  }
}

function parseDocument(value: unknown): SourceApprovalDocument {
  if (!isObject(value) || value.schemaVersion !== 1 || !Array.isArray(value.approvals) || value.approvals.length > MAX_APPROVALS) {
    throw new Error('Source approval file has an unsupported schema')
  }
  const approvals = value.approvals.map((entry, index): SourceApproval => {
    if (
      !isObject(entry) ||
      typeof entry.workflowName !== 'string' || entry.workflowName.length === 0 || entry.workflowName.length > 256 ||
      typeof entry.sourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sourceHash) ||
      typeof entry.canonicalIdentityHash !== 'string' || !/^[a-f0-9]{64}$/.test(entry.canonicalIdentityHash) ||
      typeof entry.projectHash !== 'string' || !/^[a-f0-9]{64}$/.test(entry.projectHash) ||
      typeof entry.approvedAt !== 'string' || !Number.isFinite(Date.parse(entry.approvedAt))
    ) throw new Error(`Source approval ${index} is invalid`)
    return Object.freeze({
      workflowName: entry.workflowName,
      sourceHash: entry.sourceHash,
      canonicalIdentityHash: entry.canonicalIdentityHash,
      projectHash: entry.projectHash,
      approvedAt: entry.approvedAt,
    })
  })
  return Object.freeze({ schemaVersion: 1, approvals: Object.freeze(approvals) })
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
