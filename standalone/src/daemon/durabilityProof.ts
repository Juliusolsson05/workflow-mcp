import { constants } from 'node:fs'
import { lstat, open, readFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'

const PROOF_FILE = 'durability-proof.json'
const PREPARING_FILE = '.durability-proof.preparing'
const MAX_PROOF_BYTES = 16 * 1024
const DURABILITY_CAPABILITIES = Object.freeze([
  'file-fsync',
  'atomic-rename',
  'directory-fsync',
] as const)

export type DataDurabilityProof = Readonly<{
  schemaVersion: 1
  status: 'pass'
  checkedAt: string
  capabilities: readonly ['file-fsync', 'atomic-rename', 'directory-fsync']
}>

/**
 * Exercise and cache the persistence primitives required by every durable Workflow MCP mutation.
 *
 * The caller must hold a store writer permit. Keeping that authority outside this filesystem helper
 * is deliberate: an exported function cannot forge a lease generation, while application startup
 * can prove that layout selection, store repair, and this check all belong to one kernel owner.
 */
export async function writeDataDurabilityProof(dataDirectory: string): Promise<DataDurabilityProof> {
  const directory = join(dataDirectory, 'config')
  const preparing = join(directory, PREPARING_FILE)
  const committed = join(directory, PROOF_FILE)
  const proof: DataDurabilityProof = Object.freeze({
    schemaVersion: 1,
    status: 'pass',
    checkedAt: new Date().toISOString(),
    capabilities: DURABILITY_CAPABILITIES,
  })
  let file: Awaited<ReturnType<typeof open>> | undefined
  try {
    // A fixed private preparing leaf makes crash debris bounded. Removing an earlier interrupted
    // attempt is itself inside the writer permit; O_NOFOLLOW keeps a damaged leaf from redirecting
    // the proof write before rename atomically replaces the public cache.
    await unlink(preparing).catch(error => {
      if (!isMissing(error)) throw error
    })
    file = await open(
      preparing,
      constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY,
      0o600,
    )
    await file.writeFile(`${JSON.stringify(proof)}\n`)
    await file.sync()
    await file.close()
    file = undefined
    await rename(preparing, committed)
    const parent = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      await parent.sync()
    } finally {
      await parent.close()
    }
    return proof
  } catch (error) {
    await file?.close().catch(() => undefined)
    await unlink(preparing).catch(() => undefined)
    throw error
  }
}

/** Read-only doctor view of the last proof completed by the fenced daemon owner. */
export async function readDataDurabilityProof(dataDirectory: string): Promise<DataDurabilityProof> {
  const path = join(dataDirectory, 'config', PROOF_FILE)
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_PROOF_BYTES || (info.mode & 0o077) !== 0) {
    throw new Error('Data durability proof is not an owner-only ordinary file')
  }
  const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
  if (!isProof(parsed)) throw new Error('Data durability proof is invalid or unsupported')
  return Object.freeze({
    schemaVersion: 1,
    status: 'pass',
    checkedAt: parsed.checkedAt,
    capabilities: DURABILITY_CAPABILITIES,
  })
}

function isProof(value: unknown): value is DataDurabilityProof {
  return isObject(value) &&
    value.schemaVersion === 1 &&
    value.status === 'pass' &&
    typeof value.checkedAt === 'string' &&
    Number.isFinite(Date.parse(value.checkedAt)) &&
    Array.isArray(value.capabilities) &&
    value.capabilities.length === 3 &&
    value.capabilities[0] === 'file-fsync' &&
    value.capabilities[1] === 'atomic-rename' &&
    value.capabilities[2] === 'directory-fsync'
}

function isMissing(error: unknown): boolean {
  return isObject(error) && error.code === 'ENOENT'
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
