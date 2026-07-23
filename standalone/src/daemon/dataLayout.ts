import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const LAYOUT_FILE = 'layout.json'
const FORMAT = 'workflow-mcp-installation'
export const CURRENT_LAYOUT_VERSION = 1
const MAX_LAYOUT_BYTES = 64 * 1024
const DURABLE_DIRECTORIES = [
  '.coordination',
  'store',
  'codex-home',
  'config',
  'secrets',
  'approvals',
  'backups',
] as const

export type WorkflowDataLayout = Readonly<{
  format: typeof FORMAT
  version: typeof CURRENT_LAYOUT_VERSION
  generation: string
  formats: Readonly<{
    store: 1
    journal: 2
    approvals: 1
    tokens: 1
    configuration: 1
    credentials: 1
  }>
}>

export type WorkflowDataLayoutInspection =
  | { state: 'fresh'; dataDirectory: string }
  | { state: 'legacy-v0'; dataDirectory: string }
  | { state: 'ready'; dataDirectory: string; layout: WorkflowDataLayout }

export class WorkflowDataLayoutError extends Error {
  readonly code: 'layout-invalid' | 'layout-newer' | 'layout-unsupported-entry' | 'layout-io'

  constructor(code: WorkflowDataLayoutError['code'], message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'WorkflowDataLayoutError'
    this.code = code
  }
}

/** Read-only classification performed before FileWorkflowStore is allowed to repair run bytes. */
export function inspectWorkflowDataLayout(dataDirectory: string): WorkflowDataLayoutInspection {
  const root = resolve(dataDirectory)
  if (!existsSync(root)) return { state: 'fresh', dataDirectory: root }
  const info = lstatSync(root)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new WorkflowDataLayoutError('layout-invalid', `Workflow data root is not a directory: ${root}`)
  }
  const selector = join(root, LAYOUT_FILE)
  if (!existsSync(selector)) {
    const entries = readdirSync(root)
    if (entries.length === 0) return { state: 'fresh', dataDirectory: root }
    for (const entry of entries) {
      if (!(DURABLE_DIRECTORIES as readonly string[]).includes(entry)) {
        throw new WorkflowDataLayoutError(
          'layout-unsupported-entry',
          `Unversioned workflow data contains an unknown entry: ${join(root, entry)}`,
        )
      }
      assertOrdinaryDirectory(join(root, entry))
    }
    // Version zero is the pre-container FileWorkflowStore layout. Adopting it adds only the global
    // selector; run bytes are not repaired until after that selector is durable and reopened.
    return { state: 'legacy-v0', dataDirectory: root }
  }

  const selectorInfo = lstatSync(selector)
  if (!selectorInfo.isFile() || selectorInfo.isSymbolicLink() || selectorInfo.size > MAX_LAYOUT_BYTES) {
    throw new WorkflowDataLayoutError('layout-invalid', `Workflow layout selector is invalid: ${selector}`)
  }
  let value: unknown
  try {
    value = JSON.parse(readFileSync(selector, 'utf8')) as unknown
  } catch (cause) {
    throw new WorkflowDataLayoutError('layout-invalid', `Workflow layout selector is unreadable: ${selector}`, {
      cause,
    })
  }
  if (isObject(value) && typeof value.version === 'number' && value.version > CURRENT_LAYOUT_VERSION) {
    // Nothing above this branch mutates the data directory. Downgrade refusal therefore leaves an
    // unknown future layout byte-, type-, mode-, and symlink-identical for its owning newer daemon.
    throw new WorkflowDataLayoutError(
      'layout-newer',
      `Workflow data layout ${value.version} is newer than supported layout ${CURRENT_LAYOUT_VERSION}`,
    )
  }
  const layout = parseLayout(value, selector)
  for (const directory of DURABLE_DIRECTORIES) assertOrdinaryDirectory(join(root, directory))
  return { state: 'ready', dataDirectory: root, layout }
}

/**
 * Create/adopt version one after the native launcher already owns the immutable installation lock.
 * The selector is published last and directory-fsynced; only after reopening it may store repair run
 * tails. This makes the one selector the migration commit record instead of several lazy versions.
 */
export function prepareWorkflowDataLayout(dataDirectory: string): WorkflowDataLayout {
  const inspection = inspectWorkflowDataLayout(dataDirectory)
  if (inspection.state === 'ready') return inspection.layout
  const root = inspection.dataDirectory
  mkdirSync(root, { recursive: true, mode: 0o700 })
  for (const directory of DURABLE_DIRECTORIES) {
    mkdirSync(join(root, directory), { recursive: true, mode: 0o700 })
    assertOrdinaryDirectory(join(root, directory))
  }
  const layout: WorkflowDataLayout = Object.freeze({
    format: FORMAT,
    version: CURRENT_LAYOUT_VERSION,
    generation: inspection.state === 'legacy-v0' ? 'adopted-v0' : `generation-${randomUUID()}`,
    formats: Object.freeze({
      store: 1,
      journal: 2,
      approvals: 1,
      tokens: 1,
      configuration: 1,
      credentials: 1,
    }),
  })
  writeSelectorAtomically(join(root, LAYOUT_FILE), layout)
  const reopened = inspectWorkflowDataLayout(root)
  if (reopened.state !== 'ready') {
    throw new WorkflowDataLayoutError('layout-io', 'Workflow layout selector was not durable after commit')
  }
  return reopened.layout
}

function writeSelectorAtomically(path: string, layout: WorkflowDataLayout): void {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
  try {
    const handle = openSync(temporary, 'wx', 0o600)
    try {
      writeFileSync(handle, `${JSON.stringify(layout)}\n`, 'utf8')
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
    throw new WorkflowDataLayoutError('layout-io', `Cannot commit workflow layout selector: ${path}`, {
      cause,
    })
  }
}

function parseLayout(value: unknown, path: string): WorkflowDataLayout {
  if (
    !isObject(value) ||
    value.format !== FORMAT ||
    value.version !== CURRENT_LAYOUT_VERSION ||
    typeof value.generation !== 'string' ||
    value.generation.length === 0 ||
    !isObject(value.formats) ||
    value.formats.store !== 1 ||
    value.formats.journal !== 2 ||
    value.formats.approvals !== 1 ||
    value.formats.tokens !== 1 ||
    value.formats.configuration !== 1 ||
    value.formats.credentials !== 1
  ) {
    throw new WorkflowDataLayoutError('layout-invalid', `Workflow layout is unsupported: ${path}`)
  }
  return Object.freeze({
    format: FORMAT,
    version: CURRENT_LAYOUT_VERSION,
    generation: value.generation,
    formats: Object.freeze({
      store: 1,
      journal: 2,
      approvals: 1,
      tokens: 1,
      configuration: 1,
      credentials: 1,
    }),
  })
}

function assertOrdinaryDirectory(path: string): void {
  const info = lstatSync(path)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new WorkflowDataLayoutError('layout-invalid', `Workflow data entry is not a directory: ${path}`)
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
