import { access, lstat, mkdir, mkdtemp, rm, statfs } from 'node:fs/promises'
import { constants } from 'node:fs'
import { execFile } from 'node:child_process'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'

import {
  CODEX_SDK_VERSION,
  MCP_SDK_VERSION,
  WORKFLOW_MCP_REVISION,
  WORKFLOW_MCP_VERSION,
} from 'workflow-mcp'

import type { StandaloneConfig } from '../config/schema.js'
import { inspectWorkflowDataLayout } from './dataLayout.js'
import { readDataDurabilityProof } from './durabilityProof.js'
import { inspectResourceProfile } from './resourceProfile.js'

const execute = promisify(execFile)

export type DoctorCheck = {
  id: string
  status: 'pass' | 'warn' | 'fail'
  message: string
}

export type DoctorReport = {
  schemaVersion: 1
  ok: boolean
  version: string
  revision: string
  dependencies: { codexSdk: string; mcpSdk: string }
  checks: DoctorCheck[]
}

export async function inspectContainer(config: StandaloneConfig): Promise<DoctorReport> {
  const checks: DoctorCheck[] = []
  checks.push({
    id: 'platform',
    status: process.platform === 'linux' ? 'pass' : 'warn',
    message: process.platform === 'linux'
      ? `Linux ${process.arch}`
      : `${process.platform}/${process.arch}; embedded development mode only`,
  })
  const effectiveUid = process.getuid?.()
  checks.push({
    id: 'effective-user',
    status: process.platform === 'linux' && effectiveUid === 10_001 ? 'pass' : 'warn',
    message: effectiveUid === undefined ? 'effective UID unavailable' : `effective UID ${effectiveUid}`,
  })
  try {
    const profile = await inspectResourceProfile(config)
    const memoryOk = profile.memoryLimitBytes === undefined || profile.memoryLimitBytes >= profile.requiredMemoryBytes
    const cpuOk = profile.cpuLimitCores === undefined || profile.cpuLimitCores + 0.001 >= profile.requiredCpuCores
    checks.push({
      id: 'resource-profile',
      status: memoryOk && cpuOk ? 'pass' : 'fail',
      message: `concurrency=${profile.concurrency}; required=${profile.requiredCpuCores} CPU/${profile.requiredMemoryBytes} bytes; limits=${profile.cpuLimitCores ?? 'unlimited'} CPU/${profile.memoryLimitBytes ?? 'unlimited'} bytes`,
    })
  } catch (error) {
    checks.push({
      id: 'resource-profile',
      status: 'fail',
      message: error instanceof Error ? error.message : String(error),
    })
  }
  await pathCheck(checks, 'workspace-readable', config.workspace, constants.R_OK | constants.X_OK)
  await pathCheck(checks, 'data-writable', config.dataDirectory, constants.R_OK | constants.W_OK | constants.X_OK)
  await pathCheck(checks, 'codex-executable', config.codexExecutable, constants.R_OK | constants.X_OK)
  // The host-seeded credential is startup-validated, but doctor runs long after startup and the
  // mount can go stale (host file rotated away, secret bind broken by an engine restart). Report
  // it as its own named check so a failed agent spawn has a diagnosis instead of an EPIPE.
  if (config.hostCodexAuthFile !== undefined) {
    await pathCheck(checks, 'codex-auth-readable', config.hostCodexAuthFile, constants.R_OK)
  }
  let layoutReady = false
  try {
    const inspection = inspectWorkflowDataLayout(config.dataDirectory)
    layoutReady = inspection.state === 'ready'
    checks.push({
      id: 'data-layout',
      status: layoutReady ? 'pass' : 'warn',
      message: `Workflow data layout is ${inspection.state}`,
    })
  } catch (error) {
    checks.push({
      id: 'data-layout',
      status: 'fail',
      message: error instanceof Error ? error.message : String(error),
    })
  }
  if (!layoutReady && process.platform === 'linux' && basename(config.codexExecutable) === 'codex-isolated') {
    // WHY: policy-probe is an external executable and the validated layout selector is the only
    // authority we have to interpret anything below /data. An unknown-newer tree may contain
    // FIFOs, devices, or semantics this version does not understand, so even launching a probe
    // that normally performs bounded reads would violate the absolute no-touch compatibility
    // boundary. This ordering is intentional: no executable runs before the selector is accepted.
    checks.push({
      id: 'codex-policy',
      status: 'fail',
      message: 'Codex policy proof is unavailable until the current data layout is validated',
    })
  } else if (process.platform === 'linux' && basename(config.codexExecutable) === 'codex-isolated') {
    try {
      const stdout = await executeCodexPolicyProbe(config.codexExecutable)
      const policyResult = /^codex-policy-ok network=(probed|not-configured)$/.exec(stdout.trim())
      if (policyResult === null) throw new Error('policy probe returned an unexpected response')
      checks.push({
        id: 'codex-policy',
        status: 'pass',
        message: `credential/process deny-read, admin-socket, dynamic environment, project-write, daemon-loopback, and PID-namespace probes passed; network sentinel ${policyResult[1]}`,
      })
    } catch (error) {
      checks.push({
        id: 'codex-policy',
        status: 'fail',
        message: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
      })
    }
  } else {
    checks.push({
      id: 'codex-policy',
      status: 'warn',
      message: 'final image policy probe is unavailable in embedded development mode',
    })
  }
  // WHY agent-startup is its own check, and why it sits HERE: readiness proves the HTTP surface and
  // store ownership, not that the provider can execute, so a daemon whose every agent will fail
  // still reports READY and only reveals it hours later as an EPIPE buried in a workflow result —
  // the isolation wrapper exits before the SDK can write the prompt. Running the exact wrapper the
  // provider runs surfaces its own refusal sentence in `doctor`, which is where operators are told
  // to look. It must come AFTER the data-layout gate and share its refusal, because the validated
  // layout selector is the only authority for interpreting anything below /data: launching any
  // executable against an unknown-newer tree would break the same absolute no-touch boundary the
  // policy probe protects.
  if (process.platform === 'linux' && basename(config.codexExecutable) === 'codex-isolated') {
    if (!layoutReady) {
      checks.push({
        id: 'agent-startup',
        status: 'fail',
        message: 'agent startup proof is unavailable until the current data layout is validated',
      })
    } else {
      try {
        await executeAgentStartupProbe(config.codexExecutable)
        checks.push({
          id: 'agent-startup',
          // Deliberately narrow: this proves the wrapper's gates admit a provider process, which is
          // exactly the failure that used to surface as EPIPE. It is NOT a claim that a model call
          // would succeed — credential state is reported by the separate authentication check.
          status: 'pass',
          message: 'the provider isolation wrapper starts, so agent launches are not blocked by project or secret policy',
        })
      } catch (error) {
        checks.push({
          id: 'agent-startup',
          status: 'fail',
          message: `workflow agents cannot start: ${
            error instanceof Error ? error.message.slice(0, 400) : String(error).slice(0, 400)
          }`,
        })
      }
    }
  }
  if (config.leaseMode === 'inherited-flock') {
    await tmpfsCheck(checks, dirname(config.adminSocketPath))
    if (config.lockFileDescriptor === undefined) {
      checks.push({
        id: 'flock-descriptor',
        status: 'warn',
        message: 'Client process has no owner descriptor; daemon ownership must be inspected separately',
      })
    } else {
      const descriptorPath = `/proc/self/fdinfo/${config.lockFileDescriptor}`
      await pathCheck(checks, 'flock-descriptor', descriptorPath, constants.R_OK)
    }
  } else {
    checks.push({
      id: 'flock-descriptor',
      status: 'warn',
      message: 'Cross-platform embedded lease selected; this mode is not the Docker durability contract',
    })
  }
  await dataDurabilityProofCheck(checks, config.dataDirectory, layoutReady)
  try {
    const filesystem = await statfs(config.dataDirectory)
    const freeBytes = filesystem.bavail * filesystem.bsize
    checks.push({
      id: 'data-free-space',
      status: freeBytes >= 512 * 1024 * 1024 ? 'pass' : 'warn',
      message: `${freeBytes} bytes available`,
    })
  } catch (error) {
    checks.push({
      id: 'data-free-space',
      status: 'fail',
      message: error instanceof Error ? error.message : String(error),
    })
  }
  return {
    schemaVersion: 1,
    ok: checks.every(check => check.status !== 'fail'),
    version: WORKFLOW_MCP_VERSION,
    revision: WORKFLOW_MCP_REVISION,
    dependencies: { codexSdk: CODEX_SDK_VERSION, mcpSdk: MCP_SDK_VERSION },
    checks,
  }
}

async function executeAgentStartupProbe(executable: string): Promise<void> {
  // Deliberately the plain wrapper entry with `--version`: it passes exactly the gates a real
  // attempt passes (project `.codex` masking, credential-secret readability) and then exits without
  // contacting a model or mutating durable state. Its stderr is the operator-facing sentence we
  // want in doctor, so surface that rather than a generic exit-code message. Isolate HOME/CODEX_HOME
  // to a one-shot /tmp tree for the same reason the policy probe does: an observational command must
  // not create Codex lock or cache entries in the durable volume without the daemon's flock.
  const probeRoot = await mkdtemp('/tmp/workflow-mcp-doctor-startup-')
  const probeHome = join(probeRoot, 'home')
  const probeCache = join(probeRoot, 'cache')
  const probeConfig = join(probeRoot, 'config')
  const probeData = join(probeRoot, 'share')
  try {
    await Promise.all([
      mkdir(probeHome, { mode: 0o700 }),
      mkdir(probeCache, { mode: 0o700 }),
      mkdir(probeConfig, { mode: 0o700 }),
      mkdir(probeData, { mode: 0o700 }),
    ])
    await execute(executable, ['--version'], {
      timeout: 15_000,
      maxBuffer: 64 * 1_024,
      // Every conventional state/cache root is redirected for the same reason the policy probe does
      // it: an inherited XDG variable can point back under the durable volume, and an observational
      // command must never create Codex lock or cache entries there without the daemon's flock.
      env: {
        ...process.env,
        HOME: probeHome,
        CODEX_HOME: probeHome,
        TMPDIR: probeRoot,
        XDG_CACHE_HOME: probeCache,
        XDG_CONFIG_HOME: probeConfig,
        XDG_DATA_HOME: probeData,
      },
    })
  } catch (error) {
    const stderr = isRecord(error) && typeof error.stderr === 'string' ? error.stderr.trim() : ''
    throw new Error(stderr.length > 0 ? stderr : (error instanceof Error ? error.message : String(error)))
  } finally {
    await rm(probeRoot, { recursive: true, force: true })
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

async function executeCodexPolicyProbe(executable: string): Promise<string> {
  // WHY: the final image deliberately points HOME and CODEX_HOME at durable /data so real Codex
  // authentication survives container replacement. Reusing that environment for doctor made a
  // supposedly observational command create Codex lock/cache entries without the daemon's flock
  // descriptor. The live policy proof needs managed /etc configuration, but it does not need user
  // state; give every conventional state/cache/temp root a one-shot /tmp tree and remove it before
  // returning. The final image mounts /tmp as tmpfs, and this branch runs only on Linux, so an
  // operator-controlled TMPDIR cannot redirect the probe back into the durable volume.
  const probeRoot = await mkdtemp('/tmp/workflow-mcp-doctor-codex-')
  const probeHome = join(probeRoot, 'home')
  const probeTemp = join(probeRoot, 'tmp')
  const probeCache = join(probeRoot, 'cache')
  const probeConfig = join(probeRoot, 'config')
  const probeData = join(probeRoot, 'share')
  try {
    await Promise.all([
      mkdir(probeHome, { mode: 0o700 }),
      mkdir(probeTemp, { mode: 0o700 }),
      mkdir(probeCache, { mode: 0o700 }),
      mkdir(probeConfig, { mode: 0o700 }),
      mkdir(probeData, { mode: 0o700 }),
    ])
    const { stdout } = await execute(executable, ['policy-probe'], {
      timeout: 15_000,
      maxBuffer: 64 * 1_024,
      env: {
        ...process.env,
        HOME: probeHome,
        CODEX_HOME: probeHome,
        TMPDIR: probeTemp,
        XDG_CACHE_HOME: probeCache,
        XDG_CONFIG_HOME: probeConfig,
        XDG_DATA_HOME: probeData,
      },
    })
    return stdout
  } finally {
    // A cleanup failure is a failed doctor operation rather than ignored residue. Although this is
    // tmpfs rather than durable state, silently accumulating probe material would make repeated
    // diagnostics an availability problem and weaken the claim that the command is observational.
    await rm(probeRoot, { recursive: true, force: true })
  }
}

async function dataDurabilityProofCheck(
  checks: DoctorCheck[],
  dataDirectory: string,
  layoutReady: boolean,
): Promise<void> {
  if (!layoutReady) {
    // An unknown-newer selector is an absolute no-touch boundary. In particular, do not guess that
    // its config directory still uses our proof schema: even a read of an attacker-selected FIFO or
    // device would violate doctor's bounded, ordinary-file-only contract.
    checks.push({
      id: 'data-fsync',
      status: 'fail',
      message: 'data durability proof is unavailable until the current layout is validated',
    })
    return
  }
  try {
    const proof = await readDataDurabilityProof(dataDirectory)
    checks.push({
      id: 'data-fsync',
      status: 'pass',
      message: `fenced owner proved file fsync, atomic rename, and directory fsync at ${proof.checkedAt}`,
    })
  } catch (error) {
    checks.push({
      id: 'data-fsync',
      status: 'fail',
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

async function tmpfsCheck(checks: DoctorCheck[], path: string): Promise<void> {
  try {
    const filesystem = await statfs(path)
    // Linux TMPFS_MAGIC. The durable data tree must never be used as a fallback for the admin
    // socket/token merely because the intended private runtime mount was omitted.
    if (filesystem.type !== 0x0102_1994) throw new Error(`${path} is not tmpfs`)
    checks.push({ id: 'runtime-tmpfs', status: 'pass', message: 'administrative runtime directory is tmpfs' })
  } catch (error) {
    checks.push({
      id: 'runtime-tmpfs',
      status: 'fail',
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

async function pathCheck(
  checks: DoctorCheck[],
  id: string,
  path: string,
  mode: number,
): Promise<void> {
  try {
    const info = await lstat(path)
    if (info.isSymbolicLink()) throw new Error(`${path} is a symbolic link`)
    await access(path, mode)
    checks.push({ id, status: 'pass', message: path })
  } catch (error) {
    checks.push({
      id,
      status: 'fail',
      message: `${path}: ${error instanceof Error ? error.message : String(error)}`,
    })
  }
}
