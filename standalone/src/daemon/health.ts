import { access, lstat, statfs } from 'node:fs/promises'
import { constants } from 'node:fs'

import {
  CODEX_SDK_VERSION,
  MCP_SDK_VERSION,
  WORKFLOW_MCP_REVISION,
  WORKFLOW_MCP_VERSION,
} from 'workflow-mcp'

import type { StandaloneConfig } from '../config/schema.js'
import { inspectWorkflowDataLayout } from './dataLayout.js'

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
  if (config.leaseMode === 'inherited-flock') {
    const descriptorPath = `/proc/self/fdinfo/${config.lockFileDescriptor}`
    await pathCheck(checks, 'flock-descriptor', descriptorPath, constants.R_OK)
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
