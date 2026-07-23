import { randomUUID } from 'node:crypto'
import {
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import type {
  WorkflowStoreLeaseBackend,
  WorkflowStoreLeaseBackendLease,
} from './workflowStore.js'

const REQUIRED_LOCK_NAME = 'owner.lock'
const DIAGNOSTIC_NAME = 'owner.json'

export class InheritedFlockLeaseError extends Error {
  readonly code: 'owner-conflict' | 'io-error' | 'invalid-lock'

  constructor(
    code: InheritedFlockLeaseError['code'],
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'InheritedFlockLeaseError'
    this.code = code
  }
}

/**
 * Adopts an already-flocked descriptor passed across exec by the Linux image's tiny lock launcher.
 *
 * Node deliberately has no built-in flock API. Keeping acquisition in an audited native launcher
 * avoids a long-lived helper process (which could outlive the daemon) and avoids making the core
 * package depend on an aging native addon. This backend owns the descriptor after exec, continually
 * compares its inode with the immutable pathname, and closes it only after FileWorkflowStore has
 * drained every writer permit.
 */
export class InheritedFlockLeaseBackend implements WorkflowStoreLeaseBackend {
  readonly #fd: number
  readonly #lockPath: string
  #adopted = false

  constructor(options: { fd: number; lockPath: string }) {
    if (!Number.isSafeInteger(options.fd) || options.fd <= 2) {
      throw new TypeError('Inherited flock descriptor must be an integer greater than stderr')
    }
    this.#fd = options.fd
    this.#lockPath = resolve(options.lockPath)
    if (this.#lockPath.split('/').at(-1) !== REQUIRED_LOCK_NAME) {
      throw new TypeError(`Inherited flock path must end with ${REQUIRED_LOCK_NAME}`)
    }
  }

  async acquire(input: {
    rootDirectory: string
    ownerId: string
  }): Promise<WorkflowStoreLeaseBackendLease> {
    if (process.platform !== 'linux') {
      throw new InheritedFlockLeaseError(
        'invalid-lock',
        'The inherited flock backend is supported only by the Linux container runtime',
      )
    }
    if (this.#adopted) {
      throw new InheritedFlockLeaseError('owner-conflict', 'Inherited flock was already adopted')
    }
    const coordinationDirectory = dirname(this.#lockPath)
    const expectedStore = join(dirname(coordinationDirectory), 'store')
    if (resolve(input.rootDirectory) !== expectedStore) {
      throw new InheritedFlockLeaseError(
        'invalid-lock',
        `Store ${resolve(input.rootDirectory)} is not governed by ${this.#lockPath}`,
      )
    }

    const identity = inspectIdentity(this.#fd, this.#lockPath)
    this.#adopted = true
    const generation = (Date.now() * 1_000) + Math.floor(Math.random() * 1_000)
    const acquiredAt = new Date().toISOString()
    writeDiagnostic(join(coordinationDirectory, DIAGNOSTIC_NAME), {
      schemaVersion: 1,
      ownerId: input.ownerId,
      generation,
      pid: process.pid,
      acquiredAt,
      device: identity.dev,
      inode: identity.ino,
    })

    let released = false
    return {
      generation,
      assertOwned: () => {
        if (released) {
          throw new InheritedFlockLeaseError('owner-conflict', 'Inherited flock ownership was released')
        }
        const current = inspectIdentity(this.#fd, this.#lockPath)
        if (current.dev !== identity.dev || current.ino !== identity.ino) {
          throw new InheritedFlockLeaseError(
            'owner-conflict',
            'Workflow coordination path no longer names the flocked inode',
          )
        }
      },
      release: async () => {
        if (released) return
        let diagnosticError: unknown
        try {
          writeDiagnostic(join(coordinationDirectory, DIAGNOSTIC_NAME), {
            schemaVersion: 1,
            ownerId: input.ownerId,
            generation,
            pid: process.pid,
            acquiredAt,
            releasedAt: new Date().toISOString(),
            device: identity.dev,
            inode: identity.ino,
          })
        } catch (error) {
          diagnosticError = error
        }
        // Closing this exact open-file description is the ownership transfer point. Diagnostic
        // metadata is deliberately never consulted for liveness and therefore cannot retain a lock.
        closeSync(this.#fd)
        released = true
        if (diagnosticError !== undefined) throw diagnosticError
      },
    }
  }
}

function inspectIdentity(fd: number, path: string): { dev: number; ino: number } {
  try {
    const descriptor = fstatSync(fd)
    const pathname = lstatSync(path)
    if (!descriptor.isFile() || !pathname.isFile() || pathname.isSymbolicLink()) {
      throw new InheritedFlockLeaseError(
        'invalid-lock',
        'Workflow coordination lock must be a regular file, never a symlink',
      )
    }
    if ((pathname.mode & 0o077) !== 0) {
      throw new InheritedFlockLeaseError(
        'invalid-lock',
        'Workflow coordination lock must not be accessible to group or other users',
      )
    }
    if (descriptor.dev !== pathname.dev || descriptor.ino !== pathname.ino) {
      throw new InheritedFlockLeaseError(
        'owner-conflict',
        'Workflow coordination path does not name the inherited flock descriptor',
      )
    }
    if (descriptor.nlink !== 1 || pathname.nlink !== 1) {
      throw new InheritedFlockLeaseError(
        'invalid-lock',
        'Workflow coordination inode must have exactly one immutable pathname',
      )
    }

    // Linux exposes the descriptor status flags without another native binding. The audited
    // launcher opens O_RDWR|O_NOFOLLOW and clears CLOEXEC only for the one exec into Node. libuv
    // does not inherit unspecified descriptors into provider children.
    const fdInfo = readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8')
    const flagsText = /^flags:\s+([0-7]+)$/m.exec(fdInfo)?.[1]
    const flags = flagsText === undefined ? undefined : Number.parseInt(flagsText, 8)
    const oAccmode = 0o3
    const oRdwr = 0o2
    const oNofollow = 0o400000
    if (flags === undefined || (flags & oAccmode) !== oRdwr || (flags & oNofollow) === 0) {
      throw new InheritedFlockLeaseError(
        'invalid-lock',
        'Inherited coordination descriptor lacks O_RDWR or O_NOFOLLOW',
      )
    }
    return { dev: Number(descriptor.dev), ino: Number(descriptor.ino) }
  } catch (error) {
    if (error instanceof InheritedFlockLeaseError) throw error
    throw new InheritedFlockLeaseError(
      'owner-conflict',
      `Cannot verify inherited workflow flock at ${path}`,
      { cause: error },
    )
  }
}

function writeDiagnostic(path: string, value: Record<string, unknown>): void {
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
  try {
    const handle = openSync(temporary, 'wx', 0o600)
    try {
      writeFileSync(handle, `${JSON.stringify(value)}\n`, 'utf8')
      fsyncSync(handle)
    } finally {
      closeSync(handle)
    }
    renameSync(temporary, path)
    const parent = openSync(directory, 'r')
    try {
      fsyncSync(parent)
    } finally {
      closeSync(parent)
    }
  } catch (error) {
    rmSync(temporary, { force: true })
    throw new InheritedFlockLeaseError(
      'io-error',
      `Cannot persist workflow owner diagnostics: ${path}`,
      { cause: error },
    )
  }
}
