import { spawn, type ChildProcess } from 'node:child_process'
import { accessSync, constants, lstatSync } from 'node:fs'
import { join } from 'node:path'

import type { WorkflowService } from 'workflow-mcp'

const MAX_AUTH_OUTPUT_BYTES = 256 * 1024
const AUTH_TERM_GRACE_MS = 1_000
const AUTH_PIPE_REAP_GRACE_MS = 1_000

export type AuthenticationStatus = Readonly<{
  schemaVersion: 1
  mode: 'api-key-secret' | 'host-codex' | 'interactive'
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
  readonly #hostCodexAuthFile: string | undefined

  constructor(options: {
    service: WorkflowService
    codexExecutable: string
    dataDirectory: string
    apiKeySecret: boolean
    hostCodexAuthFile?: string
  }) {
    this.#service = options.service
    this.#codexExecutable = options.codexExecutable
    this.#codexHome = join(options.dataDirectory, 'codex-home')
    this.#apiKeySecret = options.apiKeySecret
    this.#hostCodexAuthFile = options.hostCodexAuthFile
  }

  async status(signal?: AbortSignal): Promise<AuthenticationStatus> {
    if (this.#apiKeySecret) {
      return Object.freeze({
        schemaVersion: 1,
        mode: 'api-key-secret',
        authenticated: true,
        detail: 'OpenAI API key is supplied through the configured external secret input',
      })
    }
    if (this.#hostCodexAuthFile !== undefined) {
      // WHY this asks Codex instead of trusting the file: the previous version reported
      // "configured" whenever the mounted seed was merely readable. That is not the same claim.
      // A host ChatGPT/subscription login carries account/config state beyond auth.json, so the
      // seed can copy cleanly and still leave the containerized Codex unable to authenticate —
      // which surfaced to operators as a READY daemon whose every agent died with EPIPE. Status
      // must reflect whether Codex can actually run, so a shape check gates a real `login status`
      // spawn, and an inherited credential that cannot authenticate is reported honestly as
      // unauthenticated with the actionable next step.
      const seed = lstatSyncSafe(this.#hostCodexAuthFile)
      const mounted = seed !== undefined && seed.isFile() && !seed.isSymbolicLink() &&
        readableSync(this.#hostCodexAuthFile)
      if (!mounted) {
        return Object.freeze({
          schemaVersion: 1,
          mode: 'host-codex',
          authenticated: false,
          detail: 'Mounted host Codex credential is missing or unreadable; run `auth login` to create a container credential instead',
        })
      }
      return this.#exclusive(async () => {
        const result = await runCodex(
          this.#codexExecutable,
          ['login', 'status'],
          this.#environment(),
          undefined,
          signal,
        )
        return Object.freeze({
          schemaVersion: 1,
          mode: 'host-codex',
          authenticated: result.code === 0,
          detail: result.code === 0
            ? 'Codex credentials inherited from the host login are usable in this container'
            : boundedDetail(
                `Inherited host credential is not usable by the containerized Codex; run \`auth login\` to create a container credential. ${result.stderr || result.stdout}`,
              ),
        })
      })
    }
    return this.#exclusive(async () => {
      const result = await runCodex(
        this.#codexExecutable,
        ['login', 'status'],
        this.#environment(),
        undefined,
        signal,
      )
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
    // WHY inheritance never blocks login: refusing here created the worst possible state — the
    // installer detected a host login, the containerized Codex could not actually use it, and the
    // one command that would have fixed it was rejected as an "auth-mode conflict", leaving the
    // operator with no in-product way out. A container-side device login is always permitted and
    // deliberately WINS: it writes a real credential into the isolated Codex home, which the SDK's
    // seed-and-preserve contract then keeps over the older mounted seed. Only an explicit API-key
    // secret still refuses, because that credential is supplied by an external operator decision
    // this daemon does not own.
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

  logout(signal?: AbortSignal): Promise<void> {
    if (this.#apiKeySecret) {
      return Promise.reject(authError(
        'auth-mode-conflict',
        'Logout cannot remove a host-managed API-key secret; remove the Compose overlay instead',
      ))
    }
    // Logout clears the container's own Codex home for the same reason login may write it: the
    // operator must be able to reset container credential state without editing host files. The
    // host seed itself is never modified — removing it remains a host-side `codex logout`.
    return this.#exclusive(async () => {
      const result = await runCodex(
        this.#codexExecutable,
        ['logout'],
        this.#environment(),
        undefined,
        signal,
      )
      if (result.code !== 0) throw authError('authentication-failed', boundedDetail(result.stderr || result.stdout))
    })
  }

  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    return this.#service.runExclusiveAdministrativeMutation(async () => {
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
    //
    // The project-Codex mask attestation is forwarded because it is policy state, not a credential:
    // dropping it is what made every `auth status`/`auth login` on a default install hit the
    // isolation wrapper's unmasked refusal (a default install always creates <project>/.codex for
    // the Codex stanza). The wrapper now proves the mask from the mount itself, so this forward is
    // no longer load-bearing for correctness — it is kept so the wrapper's own diagnostics stay
    // accurate about what the caller intended.
    return {
      PATH: process.env.PATH,
      LANG: process.env.LANG ?? 'C.UTF-8',
      TERM: process.env.TERM ?? 'dumb',
      HOME: this.#codexHome,
      CODEX_HOME: this.#codexHome,
      ...(process.env.WORKFLOW_MCP_PROJECT_CODEX_MASKED === undefined
        ? {}
        : { WORKFLOW_MCP_PROJECT_CODEX_MASKED: process.env.WORKFLOW_MCP_PROJECT_CODEX_MASKED }),
    }
  }
}

function lstatSyncSafe(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path)
  } catch {
    return undefined
  }
}

function readableSync(path: string): boolean {
  try {
    accessSync(path, constants.R_OK)
    return true
  } catch {
    return false
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
      // WHY: killing only Codex's direct PID is not tree ownership. Shell helpers and credential
      // subprocesses inherit its pipes and can keep Node's `close` event pending after the direct
      // child exits. A fresh POSIX process group gives TERM/KILL one stable tree target on Linux
      // and macOS without requiring container privileges or a platform-specific native addon.
      detached: process.platform !== 'win32',
    })
    let stdout = ''
    let stderr = ''
    let bytes = 0
    let killedForLimit = false
    let settled = false
    let exitResult: { code: number | null; signal: NodeJS.Signals | null } | undefined
    let killTimer: NodeJS.Timeout | undefined
    let pipeTimer: NodeJS.Timeout | undefined
    const clearTerminationState = (): void => {
      signal?.removeEventListener('abort', abort)
      if (killTimer !== undefined) clearTimeout(killTimer)
      if (pipeTimer !== undefined) clearTimeout(pipeTimer)
    }
    const finish = (code: number | null, terminationSignal: NodeJS.Signals | null): void => {
      if (settled) return
      settled = true
      clearTerminationState()
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
    }
    const boundPipeReap = (): void => {
      pipeTimer ??= setTimeout(() => {
        // WHY: `close` includes inherited stdio, not merely the owned process. After the isolated
        // process group has received KILL, a buggy double-fork may still retain a duplicate pipe
        // descriptor. Destroying our read ends and settling from the already-observed child exit
        // keeps daemon shutdown bounded without treating pipe EOF as proof of process ownership.
        child.stdout.destroy()
        child.stderr.destroy()
        finish(exitResult?.code ?? child.exitCode, exitResult?.signal ?? child.signalCode)
      }, AUTH_PIPE_REAP_GRACE_MS)
      pipeTimer.unref()
    }
    const hardKill = (): void => {
      signalAuthProcessTree(child, 'SIGKILL')
      boundPipeReap()
    }
    const abort = (): void => {
      signalAuthProcessTree(child, 'SIGTERM')
      // Codex is an external executable and cannot be trusted to honor TERM while waiting for a
      // device-login response. Escalation addresses the whole process group; settlement is also
      // independently bounded in case a re-parented descendant retained one of the capture pipes.
      killTimer ??= setTimeout(hardKill, AUTH_TERM_GRACE_MS)
      killTimer.unref()
    }
    const capture = (stream: 'stdout' | 'stderr', chunk: Buffer): void => {
      bytes += chunk.length
      if (bytes > MAX_AUTH_OUTPUT_BYTES && !killedForLimit) {
        killedForLimit = true
        hardKill()
        return
      }
      const text = chunk.toString('utf8')
      if (stream === 'stdout') stdout += text
      else stderr += text
      emit?.(stream, text)
    }
    child.stdout.on('data', chunk => capture('stdout', Buffer.from(chunk)))
    child.stderr.on('data', chunk => capture('stderr', Buffer.from(chunk)))
    child.once('error', error => {
      if (settled) return
      settled = true
      clearTerminationState()
      rejectRun(error)
    })
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    child.once('exit', (code, terminationSignal) => {
      exitResult = { code, signal: terminationSignal }
      // The direct child has finished, so any member left in its private group is residue rather
      // than legitimate credential work. Reap it immediately; otherwise a cooperative parent can
      // exit on TERM while a TERM-ignoring grandchild keeps both the admin writer and stdio alive.
      signalAuthProcessTree(child, 'SIGKILL')
      boundPipeReap()
    })
    child.once('close', (code, terminationSignal) => {
      finish(code, terminationSignal)
    })
  })
}

function signalAuthProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== 'win32' && child.pid !== undefined) process.kill(-child.pid, signal)
    else child.kill(signal)
  } catch (error) {
    // ESRCH means the direct child and its private POSIX group are already gone, which is exactly
    // the postcondition termination wanted. Permission and argument errors remain real failures;
    // swallowing them would release exclusive credential admission around a tree we did not reap.
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error
  }
}

function boundedDetail(value: string): string {
  const normalized = value.replace(/[\r\n]+/g, ' ').trim()
  return (normalized || 'Codex authentication command failed').slice(0, 1_000)
}

function authError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}
