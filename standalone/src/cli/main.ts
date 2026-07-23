#!/usr/bin/env node

import { serveWorkflowMcpStdio } from 'workflow-mcp'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { lstat, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { loadStandaloneConfig } from '../config/loadConfig.js'
import { StandaloneConfigurationError } from '../config/schema.js'
import { createStandaloneApplication } from '../daemon/application.js'
import { inspectContainer } from '../daemon/health.js'
import { startStandaloneDaemon } from '../daemon/lifecycle.js'
import { inspectWorkflowDataLayout } from '../daemon/dataLayout.js'
import { printDoctor } from './output.js'
import { terminalSafe } from './terminal.js'
import { startWorkflowMcpProxy } from '../mcp/proxy.js'
import { StandaloneApiClient } from '../client/apiClient.js'
import { StandaloneAdminClient } from '../admin/client.js'
import { runTerminalUi } from '../tui/application.js'
import {
  EXIT_INTERNAL,
  EXIT_UNAVAILABLE,
  exitCodeFor,
} from './exitCodes.js'
import {
  adoptInstanceRecord,
  createHostDoctorEnvelope,
  createInstanceRecord,
  hashDockerDaemonIdentity,
  hashProjectIdentity,
  readInstanceRecord,
  renderPosixInstanceEnvironment,
  replaceInstanceImage,
  renderCodexMcpConfiguration,
} from '../instance/record.js'
import {
  createOfflineBackup,
  claimInterruptedRestore,
  commitHostBackup,
  restoreOfflineBackup,
  verifyOfflineBackup,
} from '../maintenance/backup.js'

void main(process.argv.slice(2)).catch(error => {
  process.stderr.write(`workflow-mcp: ${terminalSafe(error instanceof Error ? error.message : String(error))}\n`)
  process.exitCode = exitCodeFor(error)
})

async function main(arguments_: string[]): Promise<void> {
  const [command = 'help', ...rest] = arguments_
  const parsed = parseArguments(rest)
  if (command === 'help' || parsed.flags.help === true) {
    usage()
    return
  }
  validateCommandArguments(command, parsed)
  if (command === 'doctor') {
    const config = loadStandaloneConfig(parsed.flags)
    const report = await inspectContainer(config)
    try {
      const readiness = await fetch(`http://127.0.0.1:${config.port}/readyz`, {
        signal: AbortSignal.timeout(2_000),
      })
      if (!readiness.ok) throw new Error(`daemon readiness returned HTTP ${readiness.status}`)
      report.checks.push({
        id: 'daemon-readiness',
        status: 'pass',
        message: 'daemon reports ready after durable owner startup and API bind',
      })
    } catch (error) {
      report.checks.push({
        id: 'daemon-readiness',
        status: 'fail',
        message: error instanceof Error ? error.message : String(error),
      })
      report.ok = false
    }
    try {
      const auth = await new StandaloneAdminClient({
        socketPath: config.adminSocketPath,
        token: await readAdminToken(config.dataDirectory),
      }).authStatus()
      report.checks.push({
        id: 'provider-authentication',
        status: auth.authenticated ? 'pass' : 'warn',
        message: auth.detail,
      })
    } catch (error) {
      report.checks.push({
        id: 'provider-authentication',
        status: 'fail',
        message: error instanceof Error ? error.message : String(error),
      })
      report.ok = false
    }
    printDoctor(report, parsed.flags.json === true)
    if (!report.ok) process.exitCode = EXIT_UNAVAILABLE
    return
  }
  if (command === 'instance') {
    const action = parsed.positionals[0]
    if (action === 'create' || action === 'adopt') {
      const projectDirectory = requiredStringArgument(parsed.flags, 'project')
      const webPortValue = stringArgument(parsed.flags, 'web-port')
      const common = {
        projectDirectory,
        dockerContext: requiredStringArgument(parsed.flags, 'docker-context'),
        dockerEndpoint: requiredStringArgument(parsed.flags, 'docker-endpoint'),
        dockerDaemonFingerprint: requiredStringArgument(parsed.flags, 'docker-daemon-fingerprint'),
        image: requiredStringArgument(parsed.flags, 'image'),
        ...(webPortValue === undefined ? {} : { webPort: parsePort(webPortValue, 'web-port') }),
        authoring: parsed.flags.authoring === true,
        hardened: parsed.flags.hardened === true,
        hostCodexAuth: parsed.flags['host-codex-auth'] === true,
        ...(stringArgument(parsed.flags, 'api-key-file') === undefined
          ? {}
          : { apiKeyFile: stringArgument(parsed.flags, 'api-key-file')! }),
      }
      const record = action === 'adopt'
        ? adoptInstanceRecord({ ...common, instanceId: requiredStringArgument(parsed.flags, 'instance-id') })
        : createInstanceRecord(common)
      process.stdout.write(`${JSON.stringify(record)}\n`)
      return
    }
    if (action === 'inspect') {
      const record = await readInstanceRecord(requiredStringArgument(parsed.flags, 'file'))
      const field = stringArgument(parsed.flags, 'field')
      const format = stringArgument(parsed.flags, 'format')
      if (field !== undefined && format !== undefined) {
        throw new StandaloneConfigurationError('instance inspect accepts either --field or --format')
      }
      if (format === 'posix-shell') process.stdout.write(renderPosixInstanceEnvironment(record))
      else if (format !== undefined) throw new StandaloneConfigurationError('Unsupported instance format')
      else if (field === undefined) process.stdout.write(`${JSON.stringify(record)}\n`)
      else if (['instanceId', 'composeProjectName', 'projectHash', 'dockerContext', 'dockerEndpoint', 'dockerDaemonFingerprint', 'image', 'webPort', 'authoring', 'hardened', 'hostCodexAuth', 'apiKeyFile'].includes(field)) {
        const value = record[field as keyof typeof record]
        process.stdout.write(value === undefined ? '' : `${String(value)}\n`)
      } else throw new StandaloneConfigurationError('Unsupported instance field')
      return
    }
    if (action === 'hash') {
      process.stdout.write(`${hashProjectIdentity(requiredStringArgument(parsed.flags, 'project'))}\n`)
      return
    }
    if (action === 'daemon-fingerprint') {
      process.stdout.write(`${hashDockerDaemonIdentity(requiredStringArgument(parsed.flags, 'daemon-id'))}\n`)
      return
    }
    if (action === 'verify-policy') {
      await verifyInstalledPolicy(requiredStringArgument(parsed.flags, 'directory'))
      return
    }
    if (action === 'codex-config') {
      const record = await readInstanceRecord(requiredStringArgument(parsed.flags, 'file'))
      process.stdout.write(renderCodexMcpConfiguration(
        record,
        requiredStringArgument(parsed.flags, 'compose-file'),
      ))
      return
    }
    if (action === 'replace-image') {
      const record = await readInstanceRecord(requiredStringArgument(parsed.flags, 'file'))
      process.stdout.write(`${JSON.stringify(replaceInstanceImage(
        record,
        requiredStringArgument(parsed.flags, 'image'),
      ))}\n`)
      return
    }
    if (action === 'doctor-envelope') {
      const platform = requiredStringArgument(parsed.flags, 'platform')
      if (platform !== 'posix' && platform !== 'windows') {
        throw new StandaloneConfigurationError('--platform must be posix or windows')
      }
      const envelope = await createHostDoctorEnvelope({
        instanceFile: requiredStringArgument(parsed.flags, 'file'),
        containerReportFile: requiredStringArgument(parsed.flags, 'container-report'),
        platform,
        hostDescription: requiredStringArgument(parsed.flags, 'host-description'),
        dockerClientVersion: requiredStringArgument(parsed.flags, 'docker-client-version'),
        dockerServerVersion: requiredStringArgument(parsed.flags, 'docker-server-version'),
        composeVersion: requiredStringArgument(parsed.flags, 'compose-version'),
        dockerContext: requiredStringArgument(parsed.flags, 'docker-context'),
        dockerEndpoint: requiredStringArgument(parsed.flags, 'docker-endpoint'),
        dockerDaemonFingerprint: requiredStringArgument(parsed.flags, 'docker-daemon-fingerprint'),
        volumeDriver: requiredStringArgument(parsed.flags, 'volume-driver'),
        volumeOptions: requiredStringArgument(parsed.flags, 'volume-options'),
        volumeInstanceLabel: requiredStringArgument(parsed.flags, 'volume-instance-label'),
        volumeProjectLabel: requiredStringArgument(parsed.flags, 'volume-project-label'),
        volumeDaemonLabel: requiredStringArgument(parsed.flags, 'volume-daemon-label'),
      })
      process.stdout.write(`${JSON.stringify(envelope)}\n`)
      // A diagnostic transport succeeded even when one or more checks failed. Preserve the full
      // machine-readable envelope for automation, but keep the documented unavailable exit code so
      // callers cannot confuse "valid JSON" with a healthy daemon/container.
      if (envelope.ok !== true) process.exitCode = EXIT_UNAVAILABLE
      return
    }
    throw new StandaloneConfigurationError('instance requires create, adopt, inspect, hash, daemon-fingerprint, verify-policy, codex-config, replace-image, or doctor-envelope')
  }
  if (command === 'migrate' && parsed.positionals[0] === 'inspect') {
    const config = loadStandaloneConfig(parsed.flags)
    const inspection = inspectWorkflowDataLayout(config.dataDirectory)
    const result = {
      schemaVersion: 1,
      state: inspection.state,
      supportedLayoutVersion: 1,
      ...(inspection.state === 'ready'
        ? { layoutVersion: inspection.layout.version, generation: inspection.layout.generation }
        : {}),
    }
    if (parsed.flags.json === true) process.stdout.write(`${JSON.stringify(result)}\n`)
    else process.stdout.write(`Data layout: ${result.state}${'layoutVersion' in result ? ` v${result.layoutVersion}` : ''}\n`)
    return
  }
  if (command === 'maintenance') {
    const action = parsed.positionals[0]
    if (action === 'host-backup-commit') {
      await commitHostBackup({
        directory: requiredStringArgument(parsed.flags, 'directory'),
        archiveTemporary: requiredStringArgument(parsed.flags, 'archive-temporary'),
        checksumTemporary: requiredStringArgument(parsed.flags, 'checksum-temporary'),
        archive: requiredStringArgument(parsed.flags, 'archive'),
        checksum: requiredStringArgument(parsed.flags, 'checksum'),
      })
      process.stdout.write('{"schemaVersion":1,"committed":true}\n')
      return
    }
    const identity = maintenanceIdentity()
    if (action === 'restore-reset-check') {
      const config = loadStandaloneConfig(parsed.flags)
      await claimInterruptedRestore({ dataDirectory: config.dataDirectory, identity })
      process.stdout.write('{"schemaVersion":1,"interruptedRestore":true,"resetClaimed":true}\n')
      return
    }
    if (action === 'backup-create') {
      const config = loadStandaloneConfig(parsed.flags)
      const report = await createOfflineBackup({
        dataDirectory: config.dataDirectory,
        outputPath: requiredStringArgument(parsed.flags, 'output'),
        identity,
      })
      process.stdout.write(`${JSON.stringify(report)}\n`)
      return
    }
    if (action === 'backup-verify') {
      const report = await verifyOfflineBackup({
        inputPath: requiredStringArgument(parsed.flags, 'input'),
        ...(parsed.flags['skip-identity'] === true ? {} : { expectedIdentity: identity }),
      })
      process.stdout.write(`${JSON.stringify(report)}\n`)
      return
    }
    if (action === 'restore') {
      const config = loadStandaloneConfig(parsed.flags)
      const report = await restoreOfflineBackup({
        dataDirectory: config.dataDirectory,
        inputPath: requiredStringArgument(parsed.flags, 'input'),
        identity,
      })
      process.stdout.write(`${JSON.stringify(report)}\n`)
      return
    }
    throw new StandaloneConfigurationError('maintenance requires backup-create, backup-verify, restore, restore-reset-check, or host-backup-commit')
  }
  if (command === 'daemon') {
    const config = loadStandaloneConfig(parsed.flags)
    const daemon = await startStandaloneDaemon(config)
    process.stderr.write(`workflow-mcp daemon ready on ${daemon.host}:${daemon.port}\n`)
    installShutdown(signal => daemon.close(`Standalone daemon received ${signal}`))
    return
  }
  if (command === 'healthcheck') {
    const config = loadStandaloneConfig(parsed.flags)
    const response = await fetch(`http://127.0.0.1:${config.port}/readyz`, {
      headers: { host: `127.0.0.1:${config.port}` },
      signal: AbortSignal.timeout(2_500),
    })
    if (!response.ok) process.exitCode = EXIT_UNAVAILABLE
    return
  }
  if (command === 'mcp-proxy') {
    const config = loadStandaloneConfig(parsed.flags)
    const proxy = await startWorkflowMcpProxy({
      endpoint: process.env.WORKFLOW_MCP_ENDPOINT ?? `http://127.0.0.1:${config.port}/mcp`,
      tokenFile: process.env.WORKFLOW_MCP_MCP_TOKEN_FILE ?? join(config.dataDirectory, 'secrets', 'mcp.token'),
    })
    installShutdown(() => proxy.close())
    return
  }
  if (command === 'status') {
    const config = loadStandaloneConfig(parsed.flags)
    const token = await readAudienceToken(config.dataDirectory, 'web')
    const client = new StandaloneApiClient({
      baseUrl: process.env.WORKFLOW_MCP_ENDPOINT ?? `http://127.0.0.1:${config.port}`,
      token,
    })
    const [instance, runs] = await Promise.all([client.instance(), client.runs({ limit: 50 })])
    if (parsed.flags.json === true) process.stdout.write(`${JSON.stringify({ instance, runs })}\n`)
    else process.stdout.write(`${terminalSafe(instance.lifecycle)} · ${terminalSafe(instance.version)} · ${runs.items.length} runs\n`)
    return
  }
  if (command === 'ui') {
    const config = loadStandaloneConfig(parsed.flags)
    await runTerminalUi({
      endpoint: process.env.WORKFLOW_MCP_ENDPOINT ?? `http://127.0.0.1:${config.port}`,
      token: await readAudienceToken(config.dataDirectory, 'web'),
      snapshot: parsed.flags.snapshot === true,
    })
    return
  }
  if (command === 'token' && parsed.positionals[0] === 'show') {
    const config = loadStandaloneConfig(parsed.flags)
    const purpose = stringArgument(parsed.flags, 'purpose')
    if (purpose !== 'mcp' && purpose !== 'web') {
      throw new StandaloneConfigurationError('--purpose must be mcp or web')
    }
    if (!process.stdout.isTTY && parsed.flags.force !== true) {
      throw new StandaloneConfigurationError('Refusing to print a token without a TTY; pass --force for deliberate automation')
    }
    process.stdout.write(`${await readAudienceToken(config.dataDirectory, purpose)}\n`)
    return
  }
  if (command === 'auth') {
    const config = loadStandaloneConfig(parsed.flags)
    const client = new StandaloneAdminClient({
      socketPath: config.adminSocketPath,
      token: await readAdminToken(config.dataDirectory),
    })
    if (parsed.positionals[0] === 'status') {
      const status = await client.authStatus()
      if (parsed.flags.json === true) process.stdout.write(`${JSON.stringify(status)}\n`)
      else process.stdout.write(`${status.authenticated ? 'Authenticated' : 'Not authenticated'} · ${terminalSafe(status.detail)}\n`)
      if (!status.authenticated) process.exitCode = EXIT_UNAVAILABLE
      return
    }
    if (parsed.positionals[0] === 'login') {
      await client.login((stream, text) => {
        // Device login instructions are operator-facing protocol output. Preserve their stream so
        // URLs/codes remain visible while stdout discipline stays strict for MCP proxy processes.
        const safeText = terminalSafe(text, { multiline: true })
        if (stream === 'stdout') process.stdout.write(safeText)
        else process.stderr.write(safeText)
      })
      return
    }
    if (parsed.positionals[0] === 'logout') {
      await client.logout()
      process.stdout.write('Codex authentication removed.\n')
      return
    }
    throw new StandaloneConfigurationError('auth requires login, status, or logout')
  }
  if (command === 'source') {
    const config = loadStandaloneConfig(parsed.flags)
    const client = new StandaloneAdminClient({
      socketPath: config.adminSocketPath,
      token: await readAdminToken(config.dataDirectory),
    })
    if (parsed.positionals[0] === 'approvals') {
      const result = await client.sourceApprovals()
      if (parsed.flags.json === true) process.stdout.write(`${JSON.stringify(result)}\n`)
      else if (result.items.length === 0) process.stdout.write('No durable source approvals.\n')
      else for (const item of result.items) {
        process.stdout.write(`${terminalSafe(item.workflowName)}\t${terminalSafe(item.sourceHash)}\t${terminalSafe(item.approvedAt)}\n`)
      }
      return
    }
    if (parsed.positionals[0] === 'approve') {
      const expectedSourceHash = stringArgument(parsed.flags, 'source-hash')
      const result = await client.approveSource({
        name: requiredStringArgument(parsed.flags, 'name'),
        ...(expectedSourceHash === undefined ? {} : { expectedSourceHash }),
      })
      if (parsed.flags.json === true) process.stdout.write(`${JSON.stringify(result)}\n`)
      else process.stdout.write(`Approved ${terminalSafe(result.approval.workflowName)} at ${terminalSafe(result.approval.sourceHash)}.\n`)
      return
    }
    throw new StandaloneConfigurationError('source requires approvals or approve')
  }
  if (command === 'serve') {
    if (parsed.positionals[0] !== undefined) {
      parsed.flags.workspace = parsed.positionals[0]
    }
    // The generic OCI/Registry STDIO surface has no launcher attesting mounts, no operator
    // profile record, and its published metadata promises the conservative posture (read-only
    // workspace, gated authoring). The consumer `default` profile is a decision an installer
    // makes explicitly; an anonymous `docker run` must not inherit it, so this one entry point
    // pins hardened unless the caller opts out in their own run command.
    if (process.env.WORKFLOW_MCP_PROFILE === undefined && parsed.flags.profile === undefined) {
      parsed.flags.profile = 'hardened'
    }
    const config = loadStandaloneConfig(parsed.flags)
    // Generic OCI registries launch one STDIO process and cannot express the Compose daemon's
    // independent lifecycle. Put the distinction on stderr at the actual execution boundary so a
    // direct `docker run` cannot mistake a mounted volume for unattended post-disconnect work.
    process.stderr.write('workflow-mcp: session-bound STDIO mode; client disconnect stops active execution (durable state remains resumable).\n')
    const application = await createStandaloneApplication(config)
    const server = await serveWorkflowMcpStdio(
      application.service,
      { cwd: config.workspace },
      {
        inlineAuthoring: config.sourceMode === 'authoring',
        providerCapacity: config.concurrency,
        onInputClose: () => application.quiesce('Standalone STDIO client closed its input'),
      },
    )
    installShutdown(async signal => {
      await server.close()
      await application.quiesce(`Standalone STDIO received ${signal}`)
    })
    await server.closed
    return
  }
  throw new StandaloneConfigurationError(`Unknown command ${JSON.stringify(command)}`)
}

async function readAudienceToken(dataDirectory: string, purpose: 'mcp' | 'web'): Promise<string> {
  const value = await readFile(join(dataDirectory, 'secrets', `${purpose}.token`), 'utf8')
  return value.trim()
}

async function readAdminToken(dataDirectory: string): Promise<string> {
  const value = await readFile(join(dataDirectory, 'secrets', 'admin.token'), 'utf8')
  return value.trim()
}

function maintenanceIdentity(): { instanceId: string; projectHash: string } {
  const instanceId = process.env.WORKFLOW_MCP_INSTANCE_ID
  const projectHash = process.env.WORKFLOW_MCP_PROJECT_HASH
  if (instanceId === undefined || projectHash === undefined) {
    throw new StandaloneConfigurationError('Maintenance requires stable instance and project identity')
  }
  return { instanceId, projectHash }
}

function stringArgument(flags: Readonly<Record<string, string | boolean>>, name: string): string | undefined {
  const value = flags[name]
  return typeof value === 'string' ? value : undefined
}

function requiredStringArgument(flags: Readonly<Record<string, string | boolean>>, name: string): string {
  const value = stringArgument(flags, name)
  if (value === undefined) throw new StandaloneConfigurationError(`--${name} requires a value`)
  return value
}

function parsePort(value: string, name: string): number {
  if (!/^\d+$/.test(value)) throw new StandaloneConfigurationError(`--${name} must be a TCP port`)
  const port = Number(value)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new StandaloneConfigurationError(`--${name} must be a TCP port`)
  }
  return port
}

function installShutdown(shutdown: (signal: string) => Promise<void>): void {
  let stopping: Promise<void> | undefined
  const begin = (signal: string): void => {
    if (stopping !== undefined) return
    stopping = shutdown(signal)
    void stopping.then(
      () => { process.exitCode = 0 },
      error => {
        process.stderr.write(`workflow-mcp: shutdown failed: ${terminalSafe(error instanceof Error ? error.message : String(error))}\n`)
        process.exitCode = EXIT_INTERNAL
      },
    )
  }
  process.once('SIGTERM', () => begin('SIGTERM'))
  process.once('SIGINT', () => begin('SIGINT'))
}

async function verifyInstalledPolicy(directory: string): Promise<void> {
  if (!isAbsolute(directory) || resolve(directory) !== directory) {
    throw new StandaloneConfigurationError('Installed policy directory must be canonical and absolute')
  }
  // The image contains the release's immutable Compose inputs. A downloaded launcher can recover a
  // missing project launcher only after comparing installed policy to those bytes; trusting the
  // project's checksum file would let the same project writer replace both data and digest. The
  // mutable instance record remains outside this comparison and is parsed through its own schema.
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
  for (const name of [
    'compose.yaml',
    'compose.web.yaml',
    'compose.authoring.yaml',
    'compose.auth-api-key.yaml',
    'compose.auth-host-codex.yaml',
    'compose.hardened.yaml',
    'compose.project-codex-mask.yaml',
  ]) {
    const target = join(directory, name)
    const metadata = await lstat(target).catch(() => undefined)
    if (metadata === undefined || !metadata.isFile() || metadata.isSymbolicLink()) {
      throw new StandaloneConfigurationError(`Installed policy file is missing or redirected: ${name}`)
    }
    const [expected, actual] = await Promise.all([
      readFile(join(packageRoot, name)),
      readFile(target),
    ])
    if (!expected.equals(actual)) {
      throw new StandaloneConfigurationError(`Installed policy differs from the verified image: ${name}`)
    }
  }
}

function parseArguments(arguments_: string[]): {
  flags: Record<string, string | boolean>
  positionals: string[]
} {
  // WHY: The image's public OCI command is `serve --stdio /workspace`. A parser that guesses flag
  // arity from the following token consumes `/workspace` as the value of `--stdio`, even though the
  // flag is deliberately valueless. Keep this set beside parsing (rather than command dispatch) so
  // every boolean works in either option-first or positional-first order and generated Catalog
  // arguments behave exactly like the documented direct Docker invocation.
  const booleanFlags = new Set([
    'authoring', 'container', 'force', 'hardened', 'help', 'host-codex-auth', 'json',
    'skip-identity', 'snapshot', 'stdio',
  ])
  const flags: Record<string, string | boolean> = {}
  const positionals: string[] = []
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!
    if (!argument.startsWith('--')) {
      positionals.push(argument)
      continue
    }
    const equal = argument.indexOf('=')
    if (equal >= 0) {
      flags[argument.slice(2, equal)] = argument.slice(equal + 1)
      continue
    }
    const name = argument.slice(2)
    if (booleanFlags.has(name)) {
      flags[name] = true
      continue
    }
    const next = arguments_[index + 1]
    if (next !== undefined && !next.startsWith('--')) {
      flags[name] = next
      index += 1
    } else {
      flags[name] = true
    }
  }
  return { flags, positionals }
}

function validateCommandArguments(
  command: string,
  parsed: Readonly<{ flags: Readonly<Record<string, string | boolean>>; positionals: readonly string[] }>,
): void {
  const common = ['workspace', 'data-dir', 'host', 'port', 'profile', 'source-mode', 'lease', 'web', 'concurrency']
  let flags: readonly string[]
  let positionals: number
  switch (command) {
    case 'doctor': flags = [...common, 'container', 'json']; positionals = 0; break
    case 'daemon': flags = common; positionals = 0; break
    case 'healthcheck': flags = ['port']; positionals = 0; break
    case 'mcp-proxy': flags = [...common]; positionals = 0; break
    case 'status': flags = [...common, 'json']; positionals = 0; break
    case 'ui': flags = [...common, 'snapshot']; positionals = 0; break
    case 'serve': flags = [...common, 'stdio']; positionals = 1; break
    case 'migrate': flags = [...common, 'json']; positionals = 1; break
    case 'maintenance': {
      const action = parsed.positionals[0]
      flags = action === 'host-backup-commit'
        ? ['directory', 'archive-temporary', 'checksum-temporary', 'archive', 'checksum']
        : action === 'restore-reset-check'
          ? common
        : [...common, ...(action === 'backup-create' ? ['output'] : ['input', 'skip-identity'])]
      positionals = 1
      break
    }
    case 'token': flags = [...common, 'purpose', 'force']; positionals = 1; break
    case 'auth': flags = [...common, ...(parsed.positionals[0] === 'status' ? ['json'] : [])]; positionals = 1; break
    case 'source': flags = [
      ...common,
      'json',
      ...(parsed.positionals[0] === 'approve' ? ['name', 'source-hash'] : []),
    ]; positionals = 1; break
    case 'instance': {
      const action = parsed.positionals[0]
      const create = ['project', 'docker-context', 'docker-endpoint', 'docker-daemon-fingerprint', 'image', 'web-port', 'authoring', 'hardened', 'host-codex-auth', 'api-key-file']
      if (action === 'create') flags = create
      else if (action === 'adopt') flags = [...create, 'instance-id']
      else if (action === 'inspect') flags = ['file', 'field', 'format']
      else if (action === 'hash') flags = ['project']
      else if (action === 'daemon-fingerprint') flags = ['daemon-id']
      else if (action === 'verify-policy') flags = ['directory']
      else if (action === 'codex-config') flags = ['file', 'compose-file']
      else if (action === 'replace-image') flags = ['file', 'image']
      else if (action === 'doctor-envelope') flags = [
        'file', 'container-report', 'platform', 'host-description', 'docker-client-version', 'docker-server-version',
        'compose-version', 'docker-context', 'docker-endpoint', 'docker-daemon-fingerprint',
        'volume-driver', 'volume-options', 'volume-instance-label', 'volume-project-label',
        'volume-daemon-label',
      ]
      else flags = []
      positionals = 1
      break
    }
    default: return
  }
  if ((command === 'serve' && parsed.positionals.length > positionals) ||
      (command !== 'serve' && parsed.positionals.length !== positionals)) {
    throw new StandaloneConfigurationError(`${command} requires exactly ${positionals} positional argument${positionals === 1 ? '' : 's'}`)
  }
  for (const flag of Object.keys(parsed.flags)) {
    if (!flags.includes(flag)) throw new StandaloneConfigurationError(`Unknown ${command} option --${flag}`)
  }
  for (const flag of ['container', 'json', 'snapshot', 'stdio', 'skip-identity', 'force', 'authoring', 'hardened', 'host-codex-auth']) {
    const value = parsed.flags[flag]
    if (value !== undefined && value !== true) {
      throw new StandaloneConfigurationError(`--${flag} does not take a value`)
    }
  }
}

function usage(): void {
  process.stdout.write(`Workflow MCP standalone

Usage:
  workflow-mcp daemon [--host=0.0.0.0] [--port=7331] [--workspace=/workspace] [--data-dir=/data]
  workflow-mcp serve --stdio [workspace] [--data-dir=/data]
  workflow-mcp doctor --container [--json] [--workspace=/workspace] [--data-dir=/data]
  workflow-mcp healthcheck [--port=7331]
  workflow-mcp mcp-proxy [--port=7331]
  workflow-mcp status [--json] [--port=7331]
  workflow-mcp ui [--snapshot] [--port=7331]
  workflow-mcp token show --purpose=mcp|web [--force]
  workflow-mcp auth login|status|logout [--json]
  workflow-mcp source approvals [--json]
  workflow-mcp source approve --name=NAME [--source-hash=SHA256] [--json]
  workflow-mcp instance create|adopt|inspect|hash|daemon-fingerprint|verify-policy|codex-config|replace-image [options]
`)
}
