import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

import type { WorkflowJournalWriteCoordinator } from 'workflow-mcp'

export type TokenPurpose = 'mcp' | 'web'
export type StandaloneTokens = Readonly<Record<TokenPurpose, string>>

export function loadOrCreateTokens(
  dataDirectory: string,
  coordinator: WorkflowJournalWriteCoordinator,
): StandaloneTokens {
  return coordinator.runSync(() => {
    const directory = join(dataDirectory, 'secrets')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    chmodSync(directory, 0o700)
    return Object.freeze({
      mcp: loadOrCreate(join(directory, 'mcp.token')),
      web: loadOrCreate(join(directory, 'web.token')),
    })
  })
}

export function bearerMatches(header: string | undefined, expected: string): boolean {
  if (!header?.startsWith('Bearer ')) return false
  const actual = Buffer.from(header.slice('Bearer '.length), 'utf8')
  const wanted = Buffer.from(expected, 'utf8')
  return actual.length === wanted.length && timingSafeEqual(actual, wanted)
}

function loadOrCreate(path: string): string {
  try {
    const existing = readFileSync(path, 'utf8').trim()
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(existing)) {
      throw new Error(`Token file is malformed: ${path}`)
    }
    chmodSync(path, 0o600)
    return existing
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
  }
  const token = randomBytes(32).toString('base64url')
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
  try {
    const handle = openSync(temporary, 'wx', 0o600)
    try {
      writeFileSync(handle, `${token}\n`, 'utf8')
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
    return token
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}
