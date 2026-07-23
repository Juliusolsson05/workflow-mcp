import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

const execute = promisify(execFile)
const launcher = resolve('docker/codex-policy-launcher.mjs')

describe('Codex attempt policy launcher', () => {
  it('replaces the SDK legacy sandbox with the immutable read-only permission profile', async () => {
    const { stdout } = await execute(process.execPath, [
      launcher,
      '--experimental-json',
      '--sandbox', 'read-only',
      '--config', 'sandbox_workspace_write.network_access=false',
      '--config', 'web_search="disabled"',
      '--cd', '/workspace',
    ], {
      env: {
        ...process.env,
        WORKFLOW_MCP_CODEX_POLICY_DRY_RUN: '1',
        WORKFLOW_MCP_ATTEMPT_PROFILE: 'read-only',
      },
    })
    const arguments_ = JSON.parse(stdout) as string[]
    expect(arguments_.slice(0, 3)).toEqual(['exec', '--ignore-user-config', '--ignore-rules'])
    expect(arguments_).toContain('default_permissions="workflow_mcp_read_only"')
    expect(arguments_).toContain('web_search="disabled"')
    expect(arguments_).not.toContain('--sandbox')
    expect(arguments_.some(value => value.startsWith('sandbox_workspace_write.'))).toBe(false)
  })

  it('fails closed on a writable escalation or competing profile override', async () => {
    await expect(execute(process.execPath, [launcher, '--sandbox', 'workspace-write'], {
      env: {
        ...process.env,
        WORKFLOW_MCP_CODEX_POLICY_DRY_RUN: '1',
        WORKFLOW_MCP_ATTEMPT_PROFILE: 'read-only',
      },
    })).rejects.toThrow(/Read-only source mode/)
    await expect(execute(process.execPath, [
      launcher,
      '--sandbox', 'read-only',
      '--config', 'default_permissions=":danger-full-access"',
    ], {
      env: { ...process.env, WORKFLOW_MCP_CODEX_POLICY_DRY_RUN: '1' },
    })).rejects.toThrow(/immutable sandbox policy/)
  })
})
