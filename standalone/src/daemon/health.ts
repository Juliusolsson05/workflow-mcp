import { access, lstat, statfs } from 'node:fs/promises'
import { constants } from 'node:fs'
import { execFile } from 'node:child_process'
import { basename } from 'node:path'
import { promisify } from 'node:util'

import {
  CODEX_SDK_VERSION,
  MCP_SDK_VERSION,
  WORKFLOW_MCP_REVISION,
  WORKFLOW_MCP_VERSION,
} from 'workflow-mcp'

import type { StandaloneConfig } from '../config/schema.js'
import { inspectWorkflowDataLayout } from './dataLayout.js'

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
  await pathCheck(checks, 'workspace-readable', config.workspace, constants.R_OK | constants.X_OK)
  await pathCheck(checks, 'data-writable', config.dataDirectory, constants.R_OK | constants.W_OK | constants.X_OK)
  await pathCheck(checks, 'codex-executable', config.codexExecutable, constants.R_OK | constants.X_OK)
  if (process.platform === 'linux' && basename(config.codexExecutable) === 'codex-isolated') {
    try {
      const { stdout } = await execute(config.codexExecutable, ['policy-probe'], {
        timeout: 15_000,
        maxBuffer: 64 * 1_024,
      })
      if (stdout.trim() !== 'codex-policy-ok') throw new Error('policy probe returned an unexpected response')
      checks.push({
        id: 'codex-policy',
        status: 'pass',
        message: 'credential deny-read and PID-namespace descendant probes passed',
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
  if (config.leaseMode === 'inherited-flock') {
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
  try {
    const inspection = inspectWorkflowDataLayout(config.dataDirectory)
    checks.push({
      id: 'data-layout',
      status: inspection.state === 'ready' ? 'pass' : 'warn',
      message: `Workflow data layout is ${inspection.state}`,
    })
  } catch (error) {
    checks.push({
      id: 'data-layout',
      status: 'fail',
      message: error instanceof Error ? error.message : String(error),
    })
  }
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
