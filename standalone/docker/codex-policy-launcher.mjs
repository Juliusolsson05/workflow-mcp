import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const codex = '/opt/workflow-mcp/node_modules/@openai/codex/bin/codex.js'

if (process.argv[2] === '--self-test') {
  await selfTest()
  process.stdout.write('codex-policy-ok\n')
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
    if (argument === '--config' || argument === '-c') {
      const value = requiredFollowing(arguments_, ++index, argument)
      if (isSandboxOverride(value)) continue
      retained.push(argument, value)
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
    '--config', 'allow_login_shell=false',
    '--config', 'include_apps_instructions=false',
    '--config', 'shell_environment_policy.inherit="core"',
    '--config', 'shell_environment_policy.exclude=["OPENAI_API_KEY","CODEX_API_KEY","CODEX_ACCESS_TOKEN","WORKFLOW_MCP_ATTEMPT_PROFILE","WORKFLOW_MCP_MCP_TOKEN","WORKFLOW_MCP_WEB_TOKEN"]',
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
  if (/^(?:sandbox_mode|default_permissions|permissions\.|sandbox_workspace_write\.|features\.use_legacy_landlock)/.test(value)) {
    throw new Error(`Provider attempted to override immutable sandbox policy: ${value.split('=', 1)[0]}`)
  }
  return false
}

async function selfTest() {
  const common = [
    codex,
    'sandbox',
    '--permission-profile', 'workflow_mcp_read_only',
    '--include-managed-config',
    '--cd', '/workspace',
  ]
  let denied = false
  try {
    await execute(process.execPath, [...common, '/bin/sh', '-c', 'cat /data/secrets/mcp.token >/dev/null'], {
      env: process.env,
      timeout: 5_000,
    })
  } catch {
    denied = true
  }
  if (!denied) throw new Error('Codex command sandbox could read the daemon token directory')

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
