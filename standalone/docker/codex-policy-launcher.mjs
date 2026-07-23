import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { lstat, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { createConnection, createServer } from 'node:net'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const codex = '/opt/workflow-mcp/node_modules/@openai/codex/bin/codex.js'
const protectedEnvironmentNames = Object.freeze([
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'CODEX_ACCESS_TOKEN',
  'WORKFLOW_MCP_OPENAI_API_KEY_FILE',
  'WORKFLOW_MCP_CODEX_AUTH_FILE',
  'WORKFLOW_MCP_ATTEMPT_PROFILE',
  'WORKFLOW_MCP_MCP_TOKEN',
  'WORKFLOW_MCP_WEB_TOKEN',
])
const shellEnvironmentInherit = 'shell_environment_policy.inherit="core"'
const shellEnvironmentExclude = `shell_environment_policy.exclude=${JSON.stringify(protectedEnvironmentNames)}`

if (process.argv[2] === '--self-test' || process.argv[2] === '--self-test-authoring') {
  const profile = process.argv[2] === '--self-test-authoring' ? 'authoring' : 'read-only'
  await selfTest(profile)
  process.stdout.write(`codex-policy-ok network=${process.env.WORKFLOW_MCP_POLICY_NETWORK_TARGET === undefined ? 'not-configured' : 'probed'}\n`)
  process.exit(0)
}

const rewritten = rewriteProviderArguments(process.argv.slice(2), process.env)
if (process.env.WORKFLOW_MCP_CODEX_POLICY_DRY_RUN === '1') {
  process.stdout.write(`${JSON.stringify(rewritten)}\n`)
  process.exit(0)
}

// Importing the official JS launcher in-process preserves its own native-binary
// selection and signal forwarding. A second wrapper child would otherwise make
// SDK cancellation depend on one more best-effort process hop.
process.argv = [process.execPath, codex, ...rewritten]
await import(codex)

export function rewriteProviderArguments(arguments_, environment) {
  let sandboxMode
  const retained = []
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]
    if (argument === '--sandbox' || argument === '-s') {
      sandboxMode = requiredFollowing(arguments_, ++index, argument)
      continue
    }
    if (argument.startsWith('--sandbox=')) {
      sandboxMode = argument.slice('--sandbox='.length)
      continue
    }
    if (argument === '--add-dir') {
      throw new Error(`Additional writable directories are not supported: ${requiredFollowing(arguments_, ++index, argument)}`)
    }
    if (argument.startsWith('--add-dir=')) throw new Error('Additional writable directories are not supported')
    if (argument === '--dangerously-bypass-approvals-and-sandbox' || argument === '--yolo') {
      throw new Error('Sandbox bypass is forbidden in Workflow MCP provider attempts')
    }
    if (
      argument === '--profile' || argument.startsWith('--profile=') || argument === '-p' ||
      argument.startsWith('-p') || argument === '--remote' || argument.startsWith('--remote=') ||
      argument === '--oss' || argument === '--local-provider' || argument.startsWith('--local-provider=') ||
      argument === '--dangerously-bypass-hook-trust'
    ) {
      throw new Error(`Provider runtime/configuration switch is forbidden: ${argument}`)
    }
    if (argument === '--search') {
      throw new Error('Native web search is forbidden in Workflow MCP provider attempts')
    }
    if (argument === '--enable') {
      throw new Error(`Provider feature enablement is forbidden: ${requiredFollowing(arguments_, ++index, argument)}`)
    }
    if (argument.startsWith('--enable=')) {
      throw new Error(`Provider feature enablement is forbidden: ${argument.slice('--enable='.length)}`)
    }
    if (argument === '--config' || argument === '-c') {
      const value = requiredFollowing(arguments_, ++index, argument)
      if (isSandboxOverride(value)) continue
      retained.push('--config', value)
      continue
    }
    if (argument.startsWith('--config=') || (argument.startsWith('-c') && argument.length > 2)) {
      const value = argument.startsWith('--config=')
        ? argument.slice('--config='.length)
        : argument.slice(2)
      if (value.length === 0) throw new Error(`${argument.slice(0, 2)} requires a value`)
      if (isSandboxOverride(value)) continue
      retained.push('--config', value)
      continue
    }
    retained.push(argument)
  }

  const sourceMode = environment.WORKFLOW_MCP_ATTEMPT_PROFILE ?? 'read-only'
  if (sandboxMode !== 'read-only' && sandboxMode !== 'workspace-write') {
    throw new Error(`Provider attempt requested unsupported sandbox ${JSON.stringify(sandboxMode)}`)
  }
  if (sourceMode === 'read-only' && sandboxMode !== 'read-only') {
    throw new Error('Read-only source mode cannot request a writable Codex sandbox')
  }
  if (sourceMode !== 'read-only' && sourceMode !== 'authoring') {
    throw new Error(`Unknown Workflow MCP attempt profile ${JSON.stringify(sourceMode)}`)
  }
  const permissionProfile = sandboxMode === 'workspace-write'
    ? 'workflow_mcp_authoring'
    : 'workflow_mcp_read_only'

  return [
    'exec',
    '--ignore-user-config',
    '--ignore-rules',
    '--disable', 'apps',
    '--disable', 'plugins',
    '--disable', 'image_generation',
    '--disable', 'multi_agent',
    '--disable', 'multi_agent_v2',
    '--config', `default_permissions="${permissionProfile}"`,
    '--config', 'approval_policy="never"',
    '--config', 'allow_login_shell=false',
    '--config', 'include_apps_instructions=false',
    '--config', shellEnvironmentInherit,
    '--config', shellEnvironmentExclude,
    ...retained,
  ]
}

function requiredFollowing(arguments_, index, option) {
  const value = arguments_[index]
  if (value === undefined || value.startsWith('--')) throw new Error(`${option} requires a value`)
  return value
}

function isSandboxOverride(value) {
  // The pinned SDK emits the legacy network key alongside --sandbox. Keeping it
  // would make Codex select the legacy policy and discard deny-read profiles.
  // Every other policy/profile override is rejected instead of silently winning
  // by argument order if a future SDK or app configuration starts supplying it.
  if (value === 'sandbox_workspace_write.network_access=false') return true
  // The SDK currently emits this exact defensive value. Keeping the literal disabled setting is
  // safe; any spelling that can turn search back on is handled by the immutable namespace below.
  if (value === 'web_search="disabled"') return false
  if (value === 'approval_policy="never"') return true
  if (/^model_reasoning_effort="(?:none|minimal|low|medium|high|xhigh)"$/.test(value)) return false
  const separator = value.indexOf('=')
  if (separator < 1) throw new Error('Provider config override must use canonical key=value syntax')
  const key = value.slice(0, separator)
  // Codex's TOML parser accepts whitespace around keys, but the pinned SDK emits canonical keys.
  // Requiring that grammar keeps `default_permissions = ...` from becoming a different blocklist
  // string than `default_permissions=...` while remaining the same security setting to Codex.
  if (!/^[A-Za-z0-9_.-]+$/.test(key)) {
    throw new Error('Provider config override must use a canonical key without whitespace')
  }
  const immutableExactKeys = new Set([
    'sandbox_mode',
    'default_permissions',
    'approval_policy',
    'permissions',
    'sandbox_workspace_write',
    'allow_login_shell',
    'include_apps_instructions',
    'shell_environment_policy',
    'web_search',
    'mcp_servers',
    'model_providers',
    'tools',
  ])
  // WHY: Codex applies repeated -c values in argv order. Retaining a later feature, permission, or
  // environment override would let an SDK upgrade silently undo the settings injected above even
  // though this wrapper still looked correct in a dry-run. Reject the complete namespaces instead
  // of chasing today's individual feature names; new members must start life fail-closed.
  if (immutableExactKeys.has(key) || [
    'permissions.',
    'approval_policy.',
    'sandbox_workspace_write.',
    'shell_environment_policy.',
    'features.',
    'web_search.',
    'mcp_servers.',
    'model_providers.',
    'tools.',
  ].some(prefix => key.startsWith(prefix))) {
    throw new Error(`Provider attempted to override immutable sandbox policy: ${key}`)
  }
  throw new Error(`Provider config override is outside the pinned SDK allowlist: ${key}`)
}

async function selfTest(profile) {
  const permissionProfile = profile === 'authoring' ? 'workflow_mcp_authoring' : 'workflow_mcp_read_only'
  const controlServers = []
  if (profile === 'authoring') {
    // WHY: every negative reachability/read probe needs a live control target. The normal daemon
    // supplies these during its read-only doctor; the isolated authoring release gate creates
    // disposable non-secret equivalents so missing files/listeners cannot masquerade as denial.
    await mkdir('/data/secrets', { recursive: true, mode: 0o700 })
    await mkdir('/run/secrets', { recursive: true, mode: 0o700 })
    await writeFile('/data/secrets/mcp.token', 'authoring-policy-sentinel\n', { flag: 'wx', mode: 0o600 })
    const defaultCredential = '/run/secrets/openai_api_key'
    const configuredCredential = process.env.WORKFLOW_MCP_OPENAI_API_KEY_FILE
    if (configuredCredential === defaultCredential) {
      // WHY: codex-isolated validates and imports the configured key before this Node wrapper can
      // start. The final-image gate therefore seeds a disposable real file in the same container;
      // accepting only an ordinary file here keeps the positive parent-namespace control honest.
      const credentialInfo = await lstat(defaultCredential)
      if (!credentialInfo.isFile() || credentialInfo.isSymbolicLink()) {
        throw new Error('Authoring policy credential control is not an ordinary file')
      }
    } else {
      await writeFile(defaultCredential, 'authoring-policy-sentinel\n', { flag: 'wx', mode: 0o600 })
    }
    const daemonServer = createServer(socket => socket.end())
    await listenControl(daemonServer, Number(process.env.WORKFLOW_MCP_PORT ?? '7331'), '127.0.0.1')
    controlServers.push(daemonServer)
    await unlink('/run/workflow-mcp/admin.sock').catch(() => undefined)
    const adminServer = createServer(socket => socket.end())
    await listenControl(adminServer, '/run/workflow-mcp/admin.sock')
    controlServers.push(adminServer)
  }
  const common = [
    codex,
    'sandbox',
    '--permission-profile', permissionProfile,
    '--include-managed-config',
    '--cd', '/workspace',
    '--config', shellEnvironmentInherit,
    '--config', shellEnvironmentExclude,
  ]
  const deniedReads = [
    '/data/secrets/mcp.token',
    '/run/secrets/openai_api_key',
    '/run/secrets/host_codex_auth',
    '/proc/1/environ',
  ]
  // WHY: the configured paths are the real credential boundary. A safe hard-coded alias would let
  // a mount/overlay drift expose the actual secret while the release probe still reported pass.
  // The host-seeded Codex credential joins the same probe: its bytes are exactly as sensitive as
  // an API key, and its /run/secrets mount is only the default location, not a guarantee.
  for (const configuredCredential of [
    process.env.WORKFLOW_MCP_OPENAI_API_KEY_FILE,
    process.env.WORKFLOW_MCP_CODEX_AUTH_FILE,
  ]) {
    if (configuredCredential !== undefined && !deniedReads.includes(configuredCredential)) {
      deniedReads.push(configuredCredential)
    }
  }
  for (const path of deniedReads) {
    let denied = false
    try {
      await execute(process.execPath, [...common, '/bin/sh', '-c', 'cat "$1" >/dev/null', 'sh', path], {
        env: process.env,
        timeout: 5_000,
      })
    } catch {
      denied = true
    }
    if (!denied) throw new Error(`Codex command sandbox could read protected path ${path}`)
  }

  let adminDenied = false
  try {
    await execute(process.execPath, [
      ...common,
      process.execPath, '-e',
      'const net=require("node:net");const s=net.connect("/run/workflow-mcp/admin.sock");s.setTimeout(1500);s.on("connect",()=>process.exit(0));s.on("error",()=>process.exit(2));s.on("timeout",()=>process.exit(3));',
    ], { env: process.env, timeout: 5_000 })
  } catch {
    adminDenied = true
  }
  if (!adminDenied) throw new Error('Codex command sandbox reached the administrative socket')

  const daemonPort = Number(process.env.WORKFLOW_MCP_PORT ?? '7331')
  if (!Number.isSafeInteger(daemonPort) || daemonPort < 1 || daemonPort > 65_535) {
    throw new Error('Workflow MCP daemon port is invalid')
  }
  await assertNetworkReachable('127.0.0.1', daemonPort, 'daemon loopback')
  await assertNetworkDenied(common, '127.0.0.1', daemonPort, 'daemon loopback')

  const target = process.env.WORKFLOW_MCP_POLICY_NETWORK_TARGET
  if (target !== undefined) {
    const separator = target.lastIndexOf(':')
    const host = target.slice(0, separator)
    const port = Number(target.slice(separator + 1))
    if (separator < 1 || !Number.isSafeInteger(port) || port < 1 || port > 65_535) {
      throw new Error('Policy network target is invalid')
    }
    await assertNetworkReachable(host, port, 'managed network sentinel')
    await assertNetworkDenied(common, host, port, 'managed network sentinel')
  }

  if (profile === 'authoring') {
    const authoringMarker = `/workspace/.claude/workflows/.workflow-mcp-policy-write-${randomUUID()}`
    const renamedMarker = `${authoringMarker}.renamed`
    await execute(process.execPath, [
      ...common,
      process.execPath, '-e',
      'const fs=require("node:fs"),a=process.argv[1],b=process.argv[2];const f=fs.openSync(a,"wx",0o600);fs.writeSync(f,"probe");fs.fsyncSync(f);fs.closeSync(f);fs.renameSync(a,b);const d=fs.openSync(require("node:path").dirname(b),"r");fs.fsyncSync(d);fs.closeSync(d);fs.unlinkSync(b);',
      authoringMarker, renamedMarker,
    ], { env: process.env, timeout: 5_000 })
  }
  const projectMarker = `/workspace/.workflow-mcp-policy-write-${randomUUID()}`
  let projectWriteDenied = false
  try {
    await execute(process.execPath, [...common, '/bin/sh', '-c', 'printf probe > "$1"', 'sh', projectMarker], {
      env: process.env,
      timeout: 5_000,
    })
  } catch {
    projectWriteDenied = true
  }
  await unlink(projectMarker).catch(() => undefined)
  if (!projectWriteDenied) throw new Error(`${profile} Codex command sandbox wrote outside the authoring directory`)

  const rewritten = rewriteProviderArguments(['--sandbox', 'read-only'], process.env)
  const environmentRule = rewritten.find(value => value.startsWith('shell_environment_policy.exclude='))
  for (const name of protectedEnvironmentNames) {
    if (environmentRule === undefined || !environmentRule.includes(`"${name}"`)) {
      throw new Error(`Provider environment policy does not exclude ${name}`)
    }
  }
  const environmentSentinel = `workflow-mcp-secret-env-${randomUUID()}`
  const hostileEnvironment = { ...process.env }
  for (const name of protectedEnvironmentNames) hostileEnvironment[name] = environmentSentinel
  await execute(process.execPath, [
    ...common,
    process.execPath, '-e',
    'const names=JSON.parse(process.argv[1]),sentinel=process.argv[2];if(names.some(name=>process.env[name]===sentinel))process.exit(9);',
    JSON.stringify(protectedEnvironmentNames), environmentSentinel,
  ], { env: hostileEnvironment, timeout: 5_000 })

  const marker = `workflow-mcp-escape-${randomUUID()}`
  await execute(process.execPath, [
    ...common,
    '/bin/sh', '-c',
    `setsid /usr/local/bin/node -e 'setTimeout(() => {}, 30000)' ${marker} >/dev/null 2>&1 &`,
  ], { env: process.env, timeout: 5_000 })
  await new Promise(resolve => setTimeout(resolve, 100))
  const escaped = await markerProcesses(marker)
  if (escaped.length > 0) {
    // A failed probe must not leave its deliberate sleeper behind. Match the
    // UUID-bearing argv exactly enough that normal service processes are never
    // termination candidates.
    for (const pid of escaped) process.kill(pid, 'SIGKILL')
    throw new Error('A setsid descendant escaped the Codex PID namespace')
  }
  await Promise.all(controlServers.map(server => new Promise(resolve => server.close(resolve))))
}

async function listenControl(server, address, host) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(address, host, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
}

async function assertNetworkDenied(common, host, port, description) {
  let denied = false
  try {
    await execute(process.execPath, [
      ...common,
      process.execPath, '-e',
      'const net=require("node:net");const s=net.connect(+process.argv[2],process.argv[1]);s.setTimeout(1500);s.on("connect",()=>process.exit(0));s.on("error",()=>process.exit(2));s.on("timeout",()=>process.exit(3));',
      host, String(port),
    ], { env: process.env, timeout: 5_000 })
  } catch {
    denied = true
  }
  if (!denied) throw new Error(`Codex command sandbox reached ${description}`)
}

async function assertNetworkReachable(host, port, description) {
  // WHY: a connection error inside the sandbox proves nothing unless the same endpoint is known
  // to be live from the parent namespace. Without this control leg, DNS drift or a listener race
  // would turn an accidental outage into a false-positive network-isolation release gate.
  await new Promise((resolve, reject) => {
    const socket = createConnection({ host, port })
    const timeout = setTimeout(() => {
      socket.destroy()
      reject(new Error(`${description} control connection timed out`))
    }, 2_000)
    socket.once('connect', () => {
      clearTimeout(timeout)
      socket.destroy()
      resolve()
    })
    socket.once('error', error => {
      clearTimeout(timeout)
      reject(new Error(`${description} control connection failed`, { cause: error }))
    })
  })
}

async function markerProcesses(marker) {
  const matches = []
  for (const entry of await readdir('/proc', { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue
    const command = await readFile(`/proc/${entry.name}/cmdline`).catch(() => undefined)
    if (command === undefined || !command.toString().includes(marker)) continue
    const pid = Number(entry.name)
    if (Number.isSafeInteger(pid) && pid > 1) matches.push(pid)
  }
  return matches
}
