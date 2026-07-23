import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { describe, expect, it } from 'vitest'

import { FakeAgentProvider } from 'workflow-mcp'

import type { StandaloneConfig } from '../src/config/schema.js'
import { hashProjectIdentity } from '../src/instance/record.js'
import { startStandaloneDaemon } from '../src/daemon/lifecycle.js'

describe('stdio MCP proxy', () => {
  it('adapts the SDK lifecycle and concurrent tools without taking daemon ownership', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-proxy-'))
    const workspace = join(root, 'workspace')
    const workflows = join(workspace, '.claude', 'workflows')
    await mkdir(workflows, { recursive: true })
    await writeFile(join(workflows, 'proxy.js'), `export const meta = {
      name: 'proxy', description: 'Proxy fixture'
    }
    return 'proxy result'`)
    const config: StandaloneConfig = Object.freeze({
      workspace,
      projectHash: hashProjectIdentity(workspace),
      dataDirectory: join(root, 'data'),
      host: '127.0.0.1',
      port: 0,
      sourceMode: 'read-only',
      leaseMode: 'embedded',
      adminSocketPath: join(root, 'run', 'admin.sock'),
      codexExecutable: '/unused/fake-codex',
      webEnabled: false,
      concurrency: 1,
    })
    const daemon = await startStandaloneDaemon(config, { provider: new FakeAgentProvider([]) })
    const environment = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    )
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        resolve('dist/cli/main.js'),
        'mcp-proxy',
        '--lease=embedded',
        `--workspace=${workspace}`,
        `--data-dir=${config.dataDirectory}`,
        `--port=${daemon.port}`,
      ],
      cwd: resolve('.'),
      env: {
        ...environment,
        WORKFLOW_MCP_ENDPOINT: `http://127.0.0.1:${daemon.port}/mcp`,
        WORKFLOW_MCP_MCP_TOKEN_FILE: join(config.dataDirectory, 'secrets', 'mcp.token'),
      },
      stderr: 'pipe',
    })
    const client = new Client({ name: 'proxy-system-test', version: '1' })
    await client.connect(transport)
    const [firstList, secondList] = await Promise.all([client.listTools(), client.listTools()])
    expect(firstList.tools).toHaveLength(13)
    expect(secondList.tools.map(tool => tool.name)).toEqual(firstList.tools.map(tool => tool.name))
    const started = await client.callTool({ name: 'workflow_run', arguments: { name: 'proxy' } })
    expect(started.structuredContent).toMatchObject({ ok: true, run: { status: expect.any(String) } })

    await client.close()
    expect(daemon.ready()).toBe(true)
    expect(daemon.application.service.lifecycleState()).toBe('READY')
    await daemon.close('proxy test complete')
  }, 20_000)
})
