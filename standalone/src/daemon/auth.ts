import { spawn } from 'node:child_process'
import { join } from 'node:path'

import type { WorkflowService } from 'workflow-mcp'

const MAX_AUTH_OUTPUT_BYTES = 256 * 1024

export type AuthenticationStatus = Readonly<{
  schemaVersion: 1
  mode: 'api-key-secret' | 'interactive'
  authenticated: boolean
  detail: string
}>

/**
 * Serialize the official Codex credential CLI with workflow admission and durable ownership.
 *
 * Authentication remains in the container-owned CODEX_HOME. Calling Codex directly from another
 * `compose exec` process would bypass the daemon's knowledge of active attempts and could replace
 * auth.json while a provider refresh is committing it. Holding an administrative mutation keeps
 * starts behind the store writer, and the active-run check excludes already-running providers.
 */
export class CodexCredentialBroker {
  readonly #service: WorkflowService
  readonly #codexExecutable: string
  readonly #codexHome: string
  readonly #apiKeySecret: boolean

  constructor(options: {
    service: WorkflowService
    codexExecutable: string
    dataDirectory: string
    apiKeySecret: boolean
  }) {
    this.#service = options.service
    this.#codexExecutable = options.codexExecutable
    this.#codexHome = join(options.dataDirectory, 'codex-home')
    this.#apiKeySecret = options.apiKeySecret
  }

  async status(): Promise<AuthenticationStatus> {
    if (this.#apiKeySecret) {
      return Object.freeze({
        schemaVersion: 1,
        mode: 'api-key-secret',
        authenticated: true,
        detail: 'OpenAI API key is supplied through the configured Compose secret',
      })
    }
    return this.#service.runAdministrativeMutation(async () => {
      const result = await runCodex(this.#codexExecutable, ['login', 'status'], this.#environment())
      return Object.freeze({
        schemaVersion: 1,
        mode: 'interactive',
        authenticated: result.code === 0,
        detail: boundedDetail(result.stdout || result.stderr || 'Codex is not logged in'),
      })
    })
  }

  login(emit: (stream: 'stdout' | 'stderr', text: string) => void, signal?: AbortSignal): Promise<void> {
    if (this.#apiKeySecret) {
      return Promise.reject(authError(
        'auth-mode-conflict',
        'Interactive login is disabled while the API-key secret overlay is configured',
      ))
    }
    return this.#exclusive(async () => {
      const result = await runCodex(
        this.#codexExecutable,
        ['login', '--device-auth'],
        this.#environment(),
        emit,
        signal,
      )
      if (result.code !== 0) throw authError('authentication-failed', boundedDetail(result.stderr || result.stdout))
    })
  }

  logout(): Promise<void> {
    if (this.#apiKeySecret) {
      return Promise.reject(authError(
        'auth-mode-conflict',
        'Logout cannot remove a host-managed API-key secret; remove the Compose overlay instead',
      ))
    }
    return this.#exclusive(async () => {
      const result = await runCodex(this.#codexExecutable, ['logout'], this.#environment())
      if (result.code !== 0) throw authError('authentication-failed', boundedDetail(result.stderr || result.stdout))
    })
  }

  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    return this.#service.runAdministrativeMutation(async () => {
      if (this.#service.hasActiveRuns()) {
        throw authError('auth-busy', 'Authentication changes require every workflow run to be terminal')
      }
      return operation()
    })
  }

  #environment(): NodeJS.ProcessEnv {
    // Authentication receives only the process mechanics it needs. In particular, an API key,
    // admin bearer, or Compose secret path must not accidentally become a credential source for a
    // supposedly interactive login or appear in a Codex child diagnostic.
    return {
      PATH: process.env.PATH,
      LANG: process.env.LANG ?? 'C.UTF-8',
      TERM: process.env.TERM ?? 'dumb',
      HOME: this.#codexHome,
      CODEX_HOME: this.#codexHome,
    }
  }
}

async function runCodex(
  executable: string,
  arguments_: string[],
  environment: NodeJS.ProcessEnv,
  emit?: (stream: 'stdout' | 'stderr', text: string) => void,
  signal?: AbortSignal,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, arguments_, {
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let bytes = 0
    let killedForLimit = false
    const capture = (stream: 'stdout' | 'stderr', chunk: Buffer): void => {
      bytes += chunk.length
      if (bytes > MAX_AUTH_OUTPUT_BYTES) {
        killedForLimit = true
        child.kill('SIGKILL')
        return
      }
      const text = chunk.toString('utf8')
      if (stream === 'stdout') stdout += text
      else stderr += text
      emit?.(stream, text)
    }
    child.stdout.on('data', chunk => capture('stdout', Buffer.from(chunk)))
    child.stderr.on('data', chunk => capture('stderr', Buffer.from(chunk)))
    child.once('error', rejectRun)
    const abort = (): void => { child.kill('SIGTERM') }
    signal?.addEventListener('abort', abort, { once: true })
    child.once('close', (code, terminationSignal) => {
      signal?.removeEventListener('abort', abort)
      if (killedForLimit) {
        rejectRun(authError('authentication-failed', 'Codex authentication output exceeded 256 KiB'))
        return
      }
      if (signal?.aborted) {
        rejectRun(authError('authentication-cancelled', 'Authentication client disconnected'))
        return
      }
      resolveRun({
        code: code ?? (terminationSignal === null ? 1 : 128),
        stdout,
        stderr,
      })
    })
  })
}

function boundedDetail(value: string): string {
  const normalized = value.replace(/[\r\n]+/g, ' ').trim()
  return (normalized || 'Codex authentication command failed').slice(0, 1_000)
}

function authError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}
