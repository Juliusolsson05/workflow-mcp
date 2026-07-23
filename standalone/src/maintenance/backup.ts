import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import {
  lstat,
  mkdir,
  open,
  opendir,
  readFile,
  readdir,
  rename,
  rm,
} from 'node:fs/promises'
import { basename, dirname, join, posix, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createGunzip, createGzip } from 'node:zlib'

const MAGIC = Buffer.from('WORKFLOW-MCP-BACKUP-V1\n', 'utf8')
const MAX_HEADER_BYTES = 64 * 1024
const MAX_ENTRIES = 1_000_000
const PAYLOAD_ROOTS = ['approvals', 'config', 'store', 'workspaces'] as const
const DURABLE_DIRECTORIES = [
  '.coordination', 'store', 'codex-home', 'config', 'secrets', 'approvals', 'backups', 'workspaces',
] as const

type BackupIdentity = Readonly<{
  instanceId: string
  projectHash: string
}>

type ArchiveEntry = Readonly<{
  path: string
  kind: 'directory' | 'file'
  mode: number
  size: number
  sha256?: string
}>

export type BackupVerification = Readonly<{
  schemaVersion: 1
  format: 'workflow-mcp-backup-v1'
  instanceId: string
  projectHash: string
  layoutVersion: 1
  createdAt: string
  entries: number
  bytes: number
  archiveSha256: string
}>

export async function createOfflineBackup(input: {
  dataDirectory: string
  outputPath: string
  identity: BackupIdentity
}): Promise<BackupVerification> {
  validateIdentity(input.identity)
  const dataDirectory = resolve(input.dataDirectory)
  const outputPath = resolve(input.outputPath)
  if (exists(await lstat(outputPath).catch(missing))) throw new Error(`Backup output already exists: ${outputPath}`)
  const checksumPath = `${outputPath}.sha256`
  if (exists(await lstat(checksumPath).catch(missing))) throw new Error(`Backup checksum already exists: ${checksumPath}`)
  await requireOrdinaryDirectory(dirname(outputPath))
  const entries = await inventoryPayload(dataDirectory)
  const createdAt = new Date().toISOString()
  const temporary = `${outputPath}.tmp-${process.pid}`
  const checksumTemporary = `${checksumPath}.tmp-${process.pid}`
  try {
    await writeArchive(temporary, dataDirectory, entries, { ...input.identity, createdAt })
    const archiveSha256 = await hashFile(temporary)
    const checksum = await open(checksumTemporary, 'wx', 0o600)
    try {
      await checksum.writeFile(`${archiveSha256}  ${basename(outputPath)}\n`, 'utf8')
      await checksum.sync()
    } finally {
      await checksum.close()
    }
    // The checksum sidecar is the two-file commit record. Publishing it last means a crash can
    // leave an uncommitted archive, but no verifier will accept a checksum naming absent/partial
    // bytes. Both renames are followed by a directory fsync before success is reported.
    await rename(temporary, outputPath)
    await rename(checksumTemporary, checksumPath)
    await fsyncDirectory(dirname(outputPath))
    return Object.freeze({
      schemaVersion: 1,
      format: 'workflow-mcp-backup-v1',
      ...input.identity,
      layoutVersion: 1,
      createdAt,
      entries: entries.length,
      bytes: entries.reduce((sum, entry) => sum + entry.size, 0),
      archiveSha256,
    })
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    await rm(checksumTemporary, { force: true }).catch(() => undefined)
    throw error
  }
}

export async function verifyOfflineBackup(input: {
  inputPath: string
  expectedIdentity?: BackupIdentity
}): Promise<BackupVerification> {
  const inputPath = resolve(input.inputPath)
  const info = await lstat(inputPath)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Backup input is not an ordinary file')
  const archiveSha256 = await verifyOuterChecksum(inputPath)
  const reader = new ArchiveReader(createReadStream(inputPath).pipe(createGunzip()))
  const magic = await reader.readExact(MAGIC.length)
  if (!magic.equals(MAGIC)) throw new Error('Backup archive magic is invalid')
  const manifest = parseManifest(await reader.readHeader())
  if (input.expectedIdentity !== undefined) {
    validateIdentity(input.expectedIdentity)
    if (
      manifest.instanceId !== input.expectedIdentity.instanceId ||
      manifest.projectHash !== input.expectedIdentity.projectHash
    ) throw new Error('Backup identity does not match this Workflow MCP installation')
  }
  let previousPath = ''
  let entries = 0
  let bytes = 0
  while (true) {
    const raw = await reader.readHeader()
    if (isObject(raw) && raw.kind === 'end') {
      if (raw.entries !== entries) throw new Error('Backup end record has the wrong entry count')
      break
    }
    const entry = parseEntry(raw)
    entries += 1
    if (entries > MAX_ENTRIES) throw new Error(`Backup exceeds ${MAX_ENTRIES} entries`)
    if (entry.path <= previousPath) throw new Error('Backup entries are duplicated or not sorted')
    previousPath = entry.path
    bytes += entry.size
    if (entry.kind === 'file') {
      const hash = createHash('sha256')
      await reader.consume(entry.size, chunk => { hash.update(chunk) })
      if (hash.digest('hex') !== entry.sha256) throw new Error(`Backup entry checksum failed: ${entry.path}`)
    }
  }
  await reader.assertEnd()
  return Object.freeze({
    schemaVersion: 1,
    format: 'workflow-mcp-backup-v1',
    instanceId: manifest.instanceId,
    projectHash: manifest.projectHash,
    layoutVersion: 1,
    createdAt: manifest.createdAt,
    entries,
    bytes,
    archiveSha256,
  })
}

export async function restoreOfflineBackup(input: {
  dataDirectory: string
  inputPath: string
  identity: BackupIdentity
}): Promise<BackupVerification> {
  // Verify the complete archive before creating the first payload inode. A corrupt input therefore
  // leaves the target reusable; a crash during the later extraction intentionally leaves a
  // non-empty target that requires operator cleanup rather than guessing which files committed.
  const verification = await verifyOfflineBackup({
    inputPath: input.inputPath,
    expectedIdentity: input.identity,
  })
  const dataDirectory = resolve(input.dataDirectory)
  await assertRestoreTargetEmpty(dataDirectory)
  for (const directory of DURABLE_DIRECTORIES) {
    await mkdir(join(dataDirectory, directory), { recursive: true, mode: 0o700 })
  }

  const reader = new ArchiveReader(createReadStream(resolve(input.inputPath)).pipe(createGunzip()))
  await reader.readExact(MAGIC.length)
  parseManifest(await reader.readHeader())
  while (true) {
    const raw = await reader.readHeader()
    if (isObject(raw) && raw.kind === 'end') break
    const entry = parseEntry(raw)
    const target = join(dataDirectory, ...entry.path.split('/'))
    if (entry.kind === 'directory') {
      await mkdir(target, { recursive: true, mode: entry.mode })
      await fsyncDirectory(dirname(target))
      continue
    }
    const handle = await open(target, 'wx', entry.mode)
    let position = 0
    try {
      await reader.consume(entry.size, async chunk => {
        let offset = 0
        while (offset < chunk.length) {
          const written = await handle.write(chunk, offset, chunk.length - offset, position)
          if (written.bytesWritten <= 0) throw new Error(`Short restore write: ${entry.path}`)
          offset += written.bytesWritten
          position += written.bytesWritten
        }
      })
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fsyncDirectory(dirname(target))
  }
  await reader.assertEnd()
  await fsyncDirectory(dataDirectory)
  return verification
}

async function inventoryPayload(dataDirectory: string): Promise<ArchiveEntry[]> {
  const layoutPath = join(dataDirectory, 'layout.json')
  const layout = JSON.parse(await readFile(layoutPath, 'utf8')) as unknown
  if (!isObject(layout) || layout.version !== 1) throw new Error('Only data layout version 1 can be backed up')
  const entries: ArchiveEntry[] = [await inspectEntry(dataDirectory, 'layout.json')]
  for (const root of PAYLOAD_ROOTS) {
    const rootPath = join(dataDirectory, root)
    await requirePrivateDirectory(rootPath)
    await walk(dataDirectory, root, entries)
  }
  return entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
}

async function walk(dataDirectory: string, relativePath: string, entries: ArchiveEntry[]): Promise<void> {
  const entry = await inspectEntry(dataDirectory, relativePath)
  entries.push(entry)
  if (entry.kind !== 'directory') return
  const directory = await opendir(join(dataDirectory, relativePath))
  const names: string[] = []
  for await (const child of directory) names.push(child.name)
  names.sort()
  for (const name of names) await walk(dataDirectory, posix.join(relativePath, name), entries)
}

async function inspectEntry(dataDirectory: string, relativePath: string): Promise<ArchiveEntry> {
  validateArchivePath(relativePath)
  const info = await lstat(join(dataDirectory, ...relativePath.split('/')))
  const mode = info.mode & 0o777
  if (info.isDirectory() && !info.isSymbolicLink()) {
    if ((mode & 0o077) !== 0) throw new Error(`Backup payload entry is not private: ${relativePath}`)
    return Object.freeze({ path: relativePath, kind: 'directory', mode, size: 0 })
  }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    throw new Error(`Backup payload entry is not an ordinary single-link file: ${relativePath}`)
  }
  if ((mode & 0o077) !== 0) throw new Error(`Backup payload entry is not private: ${relativePath}`)
  return Object.freeze({
    path: relativePath,
    kind: 'file',
    mode,
    size: info.size,
    sha256: await hashFile(join(dataDirectory, ...relativePath.split('/'))),
  })
}

async function writeArchive(
  path: string,
  dataDirectory: string,
  entries: readonly ArchiveEntry[],
  identity: BackupIdentity & { createdAt: string },
): Promise<void> {
  const output = createWriteStream(path, { flags: 'wx', mode: 0o600 })
  const gzip = createGzip({ level: 9 })
  const completion = pipeline(gzip, output)
  await writeChunk(gzip, MAGIC)
  await writeHeader(gzip, { kind: 'manifest', schemaVersion: 1, layoutVersion: 1, ...identity })
  for (const entry of entries) {
    await writeHeader(gzip, entry)
    if (entry.kind !== 'file') continue
    const hash = createHash('sha256')
    let size = 0
    for await (const chunk of createReadStream(join(dataDirectory, ...entry.path.split('/')))) {
      const buffer = Buffer.from(chunk)
      hash.update(buffer)
      size += buffer.length
      await writeChunk(gzip, buffer)
    }
    // Offline ownership should make this impossible. Checking the second read still protects
    // against an accidental uncoordinated writer or mutable mount before blessing mixed bytes.
    if (size !== entry.size || hash.digest('hex') !== entry.sha256) {
      gzip.destroy(new Error(`Backup payload changed while reading: ${entry.path}`))
      await completion.catch(() => undefined)
      throw new Error(`Backup payload changed while reading: ${entry.path}`)
    }
  }
  await writeHeader(gzip, { kind: 'end', entries: entries.length })
  gzip.end()
  await completion
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function assertRestoreTargetEmpty(dataDirectory: string): Promise<void> {
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 })
  await requirePrivateDirectory(dataDirectory)
  for (const name of await readdir(dataDirectory)) {
    if (!(DURABLE_DIRECTORIES as readonly string[]).includes(name)) {
      throw new Error(`Restore target contains unsupported state: ${name}`)
    }
    const path = join(dataDirectory, name)
    await requirePrivateDirectory(path)
    const children = await readdir(path)
    const allowed = name === '.coordination' ? ['owner.lock'] : []
    if (children.some(child => !allowed.includes(child))) {
      throw new Error(`Restore target is not empty: ${name}`)
    }
  }
}

async function verifyOuterChecksum(inputPath: string): Promise<string> {
  const checksumPath = `${inputPath}.sha256`
  const info = await lstat(checksumPath)
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024) throw new Error('Backup checksum sidecar is invalid')
  const content = await readFile(checksumPath, 'utf8')
  const match = /^([a-f0-9]{64})  ([^/\\\r\n]+)\n$/.exec(content)
  if (match === null || match[2] !== basename(inputPath)) throw new Error('Backup checksum sidecar is malformed')
  const actual = await hashFile(inputPath)
  if (actual !== match[1]) throw new Error('Backup archive checksum failed')
  return actual
}

class ArchiveReader {
  readonly #iterator: AsyncIterator<Buffer | string>
  #buffer = Buffer.alloc(0)
  #ended = false

  constructor(stream: NodeJS.ReadableStream & AsyncIterable<Buffer | string>) {
    this.#iterator = stream[Symbol.asyncIterator]()
  }

  async readHeader(): Promise<unknown> {
    const size = (await this.readExact(4)).readUInt32BE(0)
    if (size < 2 || size > MAX_HEADER_BYTES) throw new Error('Backup record header is invalid')
    try {
      return JSON.parse((await this.readExact(size)).toString('utf8')) as unknown
    } catch (cause) {
      throw new Error('Backup record header is not valid JSON', { cause })
    }
  }

  async readExact(length: number): Promise<Buffer> {
    const chunks: Buffer[] = []
    let remaining = length
    await this.consume(remaining, chunk => { chunks.push(chunk); remaining -= chunk.length })
    return Buffer.concat(chunks, length)
  }

  async consume(length: number, consumer: (chunk: Buffer) => void | Promise<void>): Promise<void> {
    if (!Number.isSafeInteger(length) || length < 0) throw new Error('Backup record length is invalid')
    let remaining = length
    while (remaining > 0) {
      if (this.#buffer.length === 0) await this.#fill()
      if (this.#buffer.length === 0) throw new Error('Backup archive is truncated')
      const count = Math.min(remaining, this.#buffer.length)
      const chunk = this.#buffer.subarray(0, count)
      this.#buffer = this.#buffer.subarray(count)
      remaining -= count
      await consumer(chunk)
    }
  }

  async assertEnd(): Promise<void> {
    if (this.#buffer.length > 0) throw new Error('Backup archive has trailing data')
    await this.#fill()
    if (this.#buffer.length > 0 || !this.#ended) throw new Error('Backup archive has trailing data')
  }

  async #fill(): Promise<void> {
    if (this.#ended) return
    const next = await this.#iterator.next()
    if (next.done) {
      this.#ended = true
      return
    }
    this.#buffer = Buffer.from(next.value)
  }
}

async function writeHeader(stream: NodeJS.WritableStream, value: object): Promise<void> {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  if (body.length > MAX_HEADER_BYTES) throw new Error('Backup record header exceeds 64 KiB')
  const size = Buffer.alloc(4)
  size.writeUInt32BE(body.length)
  await writeChunk(stream, size)
  await writeChunk(stream, body)
}

function writeChunk(stream: NodeJS.WritableStream, chunk: Buffer): Promise<void> {
  if (stream.write(chunk)) return Promise.resolve()
  return new Promise((resolveDrain, rejectDrain) => {
    stream.once('drain', resolveDrain)
    stream.once('error', rejectDrain)
  })
}

function parseManifest(value: unknown): {
  instanceId: string
  projectHash: string
  createdAt: string
} {
  if (
    !isObject(value) || value.kind !== 'manifest' || value.schemaVersion !== 1 || value.layoutVersion !== 1 ||
    typeof value.instanceId !== 'string' || !/^[a-f0-9-]{36}$/.test(value.instanceId) ||
    typeof value.projectHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.projectHash) ||
    typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))
  ) throw new Error('Backup manifest is invalid or unsupported')
  return { instanceId: value.instanceId, projectHash: value.projectHash, createdAt: value.createdAt }
}

function parseEntry(value: unknown): ArchiveEntry {
  if (
    !isObject(value) || typeof value.path !== 'string' ||
    (value.kind !== 'directory' && value.kind !== 'file') ||
    typeof value.mode !== 'number' || !Number.isInteger(value.mode) || value.mode < 0o600 || value.mode > 0o700 || (value.mode & 0o077) !== 0 ||
    typeof value.size !== 'number' || !Number.isSafeInteger(value.size) || value.size < 0 ||
    (value.kind === 'directory' && (value.size !== 0 || value.sha256 !== undefined)) ||
    (value.kind === 'file' && (typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)))
  ) throw new Error('Backup entry header is invalid')
  validateArchivePath(value.path)
  return Object.freeze({
    path: value.path,
    kind: value.kind,
    mode: value.mode,
    size: value.size,
    ...(typeof value.sha256 === 'string' ? { sha256: value.sha256 } : {}),
  })
}

function validateArchivePath(path: string): void {
  if (path === 'layout.json') return
  if (path.length === 0 || path.startsWith('/') || path.includes('\\') || path.includes('\0')) {
    throw new Error(`Backup entry path is forbidden: ${JSON.stringify(path)}`)
  }
  const components = path.split('/')
  if (components.some(component => component === '' || component === '.' || component === '..')) {
    throw new Error(`Backup entry path is forbidden: ${JSON.stringify(path)}`)
  }
  if (!(PAYLOAD_ROOTS as readonly string[]).includes(components[0]!)) {
    throw new Error(`Backup entry root is forbidden: ${components[0]}`)
  }
}

function validateIdentity(identity: BackupIdentity): void {
  if (!/^[a-f0-9-]{36}$/.test(identity.instanceId)) throw new Error('Backup instance ID is invalid')
  if (!/^[a-f0-9]{64}$/.test(identity.projectHash)) throw new Error('Backup project hash is invalid')
}

async function requirePrivateDirectory(path: string): Promise<void> {
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    throw new Error(`Expected a private ordinary directory: ${path}`)
  }
}

async function requireOrdinaryDirectory(path: string): Promise<void> {
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Expected an ordinary directory: ${path}`)
  }
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function missing(error: unknown): undefined {
  if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
  throw error
}

function exists(value: unknown): boolean {
  return value !== undefined
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
