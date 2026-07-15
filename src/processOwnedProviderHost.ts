import { fork, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  AgentProviderAbortError,
  AgentProviderFailure,
} from './agentProvider.js'
import type {
  AgentProviderAttemptIdentity,
  AgentProviderExecutionContext,
  AgentProviderResult,
  AgentProviderTerminationReason,
  AgentRequest,
} from './agentProvider.js'
import type { CodexConfigurationIsolation } from './codexProvider.js'
import { deserializeProviderHostError } from './providerHost.js'
import {
  isProviderHostToParentMessage,
} from './providerHostProtocol.js'
import type {
  ParentToProviderHostMessage,
  ProviderHostToParentMessage,
  SerializedCodexHostOptions,
} from './providerHostProtocol.js'

const HOST_HEARTBEAT_INTERVAL_MS = 5_000
const HOST_STDERR_LIMIT = 64 * 1_024
const SOFT_TREE_KILL_GRACE_MS = 500
const HARD_TREE_KILL_GRACE_MS = 4_000

export type ProcessOwnedCodexHostOptions = {
  hostFilePath?: string
  codexOptions: SerializedCodexHostOptions
  modelAliases: Readonly<Record<string, string | null>>
  configurationIsolation?: CodexConfigurationIsolation
}

type HostTerminalMessage = Extract<ProviderHostToParentMessage, { type: 'result' | 'error' }>

type HostExecution = {
  identity: AgentProviderAttemptIdentity
  child: ChildProcess
  result: Promise<AgentProviderResult>
  resolve(result: AgentProviderResult): void
  reject(error: unknown): void
  context: AgentProviderExecutionContext
  terminal?: HostTerminalMessage
  delivery: Promise<void>
  deliveryError?: unknown
  stderr: string
  abortRequested: boolean
  settled: boolean
  termination?: Promise<void>
}

/**
 * Own one OS process group per Codex attempt.
 *
 * WHY the provider promise settles on `close`, not on the host's `result` message: the original
 * incident was caused by treating a wrapper promise as proof that every tool descendant had died.
 * A terminal IPC message proves only that JavaScript reached a return statement. This owner waits
 * for the host process to be reaped, verifies the dedicated group has no remaining members, and
 * forcibly clears any residual descendants before handing the scheduler permit back.
 */
export class ProcessOwnedCodexHost {
  readonly #hostFilePath: string
  readonly #codexOptions: SerializedCodexHostOptions
  readonly #modelAliases: Readonly<Record<string, string | null>>
  readonly #configurationIsolation: CodexConfigurationIsolation | undefined
  readonly #executions = new Map<string, HostExecution>()

  constructor(options: ProcessOwnedCodexHostOptions) {
    this.#hostFilePath = resolve(options.hostFilePath ?? defaultProviderHostFilePath())
    this.#codexOptions = options.codexOptions
    this.#modelAliases = { ...options.modelAliases }
    this.#configurationIsolation = options.configurationIsolation === undefined
      ? undefined
      : { ...options.configurationIsolation }
    if (!existsSync(this.#hostFilePath)) {
      throw new AgentProviderFailure(
        `Codex provider host is missing at ${this.#hostFilePath}; build the package/host entry before running workflows`,
        { code: 'codex-provider-host-missing' },
      )
    }
  }

  execute(request: AgentRequest, context: AgentProviderExecutionContext): Promise<AgentProviderResult> {
    if (context.signal.aborted) return Promise.reject(new AgentProviderAbortError(context.signal.reason))
    const identity = context.attempt ?? {
      runId: 'direct',
      agentId: 'direct',
      attemptId: `direct_${randomUUID()}`,
      attemptNumber: 1,
    }
    if (this.#executions.has(identity.attemptId)) {
      return Promise.reject(new Error(`Provider attempt already exists: ${identity.attemptId}`))
    }

    const codexOptions = this.#configurationIsolation === undefined
      ? this.#codexOptions
      : prepareIsolatedCodexOptions(this.#codexOptions, this.#configurationIsolation)

    let resolveResult!: (result: AgentProviderResult) => void
    let rejectResult!: (error: unknown) => void
    const result = new Promise<AgentProviderResult>((resolvePromise, rejectPromise) => {
      resolveResult = resolvePromise
      rejectResult = rejectPromise
    })
    const child = fork(this.#hostFilePath, [], {
      detached: process.platform !== 'win32',
      // The host receives all provider credentials inside the explicit Codex options message. Its
      // own environment stays minimal so an unrelated cloud secret cannot become reachable merely
      // because a future host dependency inspects process.env.
      env: providerHostEnvironment(),
      execArgv: [],
      serialization: 'json',
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    })
    const execution: HostExecution = {
      identity,
      child,
      result,
      resolve: resolveResult,
      reject: rejectResult,
      context,
      delivery: Promise.resolve(),
      stderr: '',
      abortRequested: false,
      settled: false,
    }
    this.#executions.set(identity.attemptId, execution)

    child.stderr?.on('data', (chunk: Buffer | string) => {
      if (execution.stderr.length >= HOST_STDERR_LIMIT) return
      execution.stderr = (execution.stderr + chunk.toString()).slice(0, HOST_STDERR_LIMIT)
    })
    child.on('message', (message: unknown) => this.#onMessage(execution, message))
    child.once('error', (error) => {
      execution.deliveryError ??= error
    })
    child.once('exit', () => {
      // `close` waits for every inherited stdio descriptor to close. A Codex tool grandchild can
      // keep the host's stderr pipe open after the host itself exits, which means waiting until
      // `close` to begin reaping creates a deadlock: the pipe waits for the descendant and the
      // descendant waits forever. Direct-child `exit` is the first authoritative moment at which
      // the parent may clear residual group members without racing the host's terminal IPC send.
      execution.termination ??= reapResidualProcessTree(execution.child)
    })
    child.once('close', (code, signal) => {
      void this.#onClose(execution, code, signal)
    })

    const onAbort = (): void => {
      execution.abortRequested = true
      sendIfConnected(child, {
        type: 'cancel',
        reason: abortMessage(context.signal.reason),
      })
    }
    context.signal.addEventListener('abort', onAbort, { once: true })
    void result.finally(() => context.signal.removeEventListener('abort', onAbort)).catch(() => undefined)

    sendIfConnected(child, {
      type: 'start',
      request,
      options: codexOptions,
      modelAliases: this.#modelAliases,
      heartbeatIntervalMs: HOST_HEARTBEAT_INTERVAL_MS,
    })
    return result
  }

  async terminateAttempt(
    identity: AgentProviderAttemptIdentity,
    _reason: AgentProviderTerminationReason,
  ): Promise<void> {
    const execution = this.#executions.get(identity.attemptId)
    if (!execution || execution.settled) return
    execution.abortRequested = true
    execution.termination ??= terminateProcessTree(execution.child)
    await execution.termination
    // `terminateProcessTree` proves the OS boundary is gone. Awaiting the provider promise here is
    // still useful because it guarantees the close handler has converted that fact into exactly
    // one runtime-visible settlement before the supervisor returns from escalation.
    await execution.result.then(() => undefined, () => undefined)
  }

  #onMessage(execution: HostExecution, raw: unknown): void {
    if (!isProviderHostToParentMessage(raw) || execution.settled) return
    switch (raw.type) {
      case 'ready':
        execution.context.heartbeat?.(new Date().toISOString())
        return
      case 'heartbeat':
        execution.context.heartbeat?.(raw.at)
        return
      case 'event':
        execution.delivery = execution.delivery.then(async () => {
          await execution.context.emit(raw.event)
          sendIfConnected(execution.child, {
            type: 'event.acknowledged',
            sequence: raw.sequence,
          })
        }).catch((error: unknown) => {
          execution.deliveryError ??= error
          execution.termination ??= terminateProcessTree(execution.child)
        })
        return
      case 'result':
      case 'error':
        execution.terminal = raw
        return
    }
  }

  async #onClose(
    execution: HostExecution,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    if (execution.settled) return
    try {
      // A normally completed SDK turn can still leave a detached tool grandchild. Reaping here is
      // not merely cancellation cleanup; it is what makes every successful permit release obey
      // the same process-tree invariant as a timed-out one.
      execution.termination ??= reapResidualProcessTree(execution.child)
      await execution.termination
      await execution.delivery

      if (execution.deliveryError !== undefined) throw execution.deliveryError
      if (execution.terminal?.type === 'result') {
        execution.settled = true
        execution.resolve(execution.terminal.result)
        return
      }
      if (execution.terminal?.type === 'error') {
        execution.settled = true
        execution.reject(deserializeProviderHostError(execution.terminal.error))
        return
      }
      execution.settled = true
      if (execution.abortRequested) {
        execution.reject(new AgentProviderAbortError('Codex provider process tree was terminated'))
        return
      }
      const detail = signal ? `signal ${signal}` : `code ${code ?? 1}`
      const stderr = execution.stderr.trim()
      execution.reject(new AgentProviderFailure(
        `Codex provider host exited with ${detail} before returning a terminal record${stderr.length === 0 ? '' : `: ${stderr}`}`,
        { code: 'codex-provider-host-exited', retryable: true },
      ))
    } catch (error) {
      execution.settled = true
      execution.reject(error)
    } finally {
      this.#executions.delete(execution.identity.attemptId)
    }
  }
}

const ISOLATED_CODEX_CONFIG = `# Generated by workflow-mcp. Do not add normal interactive Codex settings here.
#
# WHY this home is deliberately sparse: workflow attempts need durable session files for exact
# thread resume, but inheriting ~/.codex/config.toml, plugins, apps, or project MCP servers would
# make a read-only filesystem sandbox unsafe to replay. Explicit host-approved MCP servers are
# supplied as per-process CLI overrides and remain visible to capability classification.
include_apps_instructions = false

[features]
apps = false
plugins = false
tool_search = false
image_generation = false
multi_agent = false
enable_fanout = false
`

function prepareIsolatedCodexOptions(
  options: SerializedCodexHostOptions,
  isolation: CodexConfigurationIsolation,
): SerializedCodexHostOptions {
  const codexHome = resolve(isolation.codexHome)
  mkdirSync(codexHome, { recursive: true, mode: 0o700 })
  writePrivateFileAtomically(resolve(codexHome, 'config.toml'), ISOLATED_CODEX_CONFIG)
  if (isolation.authenticationFile !== undefined && existsSync(isolation.authenticationFile)) {
    copyPrivateFileAtomically(resolve(isolation.authenticationFile), resolve(codexHome, 'auth.json'))
  }

  return {
    ...options,
    // Supplying env to the SDK replaces, rather than augments, its process environment. Preserve
    // the parent's explicit allowlist and pin only CODEX_HOME; no normal user configuration path
    // remains reachable through the provider process.
    env: {
      ...(options.env ?? {}),
      CODEX_HOME: codexHome,
    },
  }
}

function writePrivateFileAtomically(path: string, contents: string): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(temporary, contents, { encoding: 'utf8', mode: 0o600 })
  renameSync(temporary, path)
  chmodSync(path, 0o600)
}

function copyPrivateFileAtomically(source: string, destination: string): void {
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`
  copyFileSync(source, temporary)
  chmodSync(temporary, 0o600)
  renameSync(temporary, destination)
  chmodSync(destination, 0o600)
}

function defaultProviderHostFilePath(): string {
  const adjacent = fileURLToPath(new URL('./providerHostEntry.js', import.meta.url))
  if (existsSync(adjacent)) return adjacent
  const sourceDirectory = dirname(fileURLToPath(import.meta.url))
  return resolve(sourceDirectory, '..', 'dist', 'providerHostEntry.js')
}

function providerHostEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ELECTRON_RUN_AS_NODE: '1',
  }
  for (const name of ['SYSTEMROOT', 'WINDIR', 'TMPDIR', 'TEMP', 'TMP']) {
    if (process.env[name] !== undefined) env[name] = process.env[name]
  }
  return env
}

function sendIfConnected(child: ChildProcess, message: ParentToProviderHostMessage): void {
  if (!child.connected || typeof child.send !== 'function') return
  try {
    child.send(message, () => undefined)
  } catch {
    // `close` is the single settlement authority. A racing disconnect is expected during abort.
  }
}

async function reapResidualProcessTree(child: ChildProcess): Promise<void> {
  if (child.pid === undefined) return
  if (process.platform === 'win32') return
  if (!processGroupExists(child.pid)) return
  await terminatePosixProcessGroup(child.pid)
}

async function terminateProcessTree(child: ChildProcess): Promise<void> {
  if (child.pid === undefined) return
  if (process.platform === 'win32') {
    await terminateWindowsProcessTree(child.pid)
    await waitForChildClose(child, HARD_TREE_KILL_GRACE_MS)
    return
  }
  await terminatePosixProcessGroup(child.pid)
  await waitForChildClose(child, HARD_TREE_KILL_GRACE_MS)
}

async function terminatePosixProcessGroup(processGroupId: number): Promise<void> {
  signalProcessGroup(processGroupId, 'SIGTERM')
  if (await waitForProcessGroupExit(processGroupId, SOFT_TREE_KILL_GRACE_MS)) return
  signalProcessGroup(processGroupId, 'SIGKILL')
  if (await waitForProcessGroupExit(processGroupId, HARD_TREE_KILL_GRACE_MS)) return
  throw new Error(`Provider process group ${processGroupId} remained alive after SIGKILL`)
}

async function terminateWindowsProcessTree(pid: number): Promise<void> {
  // Node does not expose Job Objects. `taskkill /T /F` is the platform-provided whole-tree
  // equivalent available without shipping an unsigned native addon; waiting for both taskkill and
  // the owned host's close event prevents the scheduler from treating command dispatch as proof.
  await new Promise<void>((resolveTask, rejectTask) => {
    const taskkill = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    taskkill.once('error', rejectTask)
    taskkill.once('exit', (code) => {
      if (code === 0 || code === 128) resolveTask()
      else rejectTask(new Error(`taskkill exited with code ${code ?? 1} for provider tree ${pid}`))
    })
  })
}

function signalProcessGroup(processGroupId: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-processGroupId, signal)
  } catch (error) {
    if (!isMissingProcessError(error)) throw error
  }
}

function processGroupExists(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0)
    return true
  } catch (error) {
    if (isMissingProcessError(error)) return false
    // EPERM still proves the process group exists; lack of permission is not evidence of exit.
    if (isErrno(error, 'EPERM')) return true
    throw error
  }
}

async function waitForProcessGroupExit(processGroupId: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!processGroupExists(processGroupId)) return true
    await delay(20)
  }
  return !processGroupExists(processGroupId)
}

function waitForChildClose(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolveWait, rejectWait) => {
    const timer = setTimeout(() => {
      child.removeListener('close', onClose)
      rejectWait(new Error(`Provider host ${child.pid ?? 'unknown'} did not close after tree termination`))
    }, timeoutMs)
    timer.unref?.()
    const onClose = (): void => {
      clearTimeout(timer)
      resolveWait()
    }
    child.once('close', onClose)
  })
}

function isMissingProcessError(error: unknown): boolean {
  return isErrno(error, 'ESRCH')
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}

function abortMessage(reason: unknown): string {
  if (reason instanceof Error && reason.message.length > 0) return reason.message
  if (typeof reason === 'string' && reason.length > 0) return reason
  return 'Provider execution cancelled'
}
