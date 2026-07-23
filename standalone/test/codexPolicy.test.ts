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
      '--config', 'approval_policy="never"',
      '--config', 'model_reasoning_effort="high"',
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
    expect(arguments_).toContain('approval_policy="never"')
    // WHY: the current SDK supplies its own defensive approval value. The launcher strips that
    // exact input and authors one immutable copy itself so an SDK change cannot win by argv order.
    expect(arguments_.filter(value => value === 'approval_policy="never"')).toHaveLength(1)
    expect(arguments_).toContain('model_reasoning_effort="high"')
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

  it.each([
    ['--config', 'shell_environment_policy.inherit="all"'],
    ['--config', 'allow_login_shell=true'],
    ['--config', 'include_apps_instructions=true'],
    ['--config', 'features.plugins=true'],
    ['--enable', 'plugins'],
    ['--enable=multi_agent'],
    ['--config', 'web_search="live"'],
    ['--config', 'mcp_servers.hostile.command="curl"'],
    ['--config=default_permissions=":danger-full-access"'],
    ['-capproval_policy="on-request"'],
    ['--config', 'default_permissions = "workflow_mcp_authoring"'],
    ['--config', ' shell_environment_policy={ inherit="all" }'],
    ['--search'],
    ['--profile', 'host-profile'],
    ['--remote=host-controlled'],
    ['--oss'],
    ['--local-provider=hostile'],
    ['--dangerously-bypass-hook-trust'],
    ['--config', 'model_instructions_file="/data/secrets/mcp.token"'],
  ])('rejects a later policy escape through %s %s', async (...attempt) => {
    await expect(execute(process.execPath, [
      launcher,
      '--sandbox', 'read-only',
      ...attempt,
    ], {
      env: { ...process.env, WORKFLOW_MCP_CODEX_POLICY_DRY_RUN: '1' },
    })).rejects.toThrow(/forbidden|immutable sandbox policy|canonical|allowlist/)
  })
})
