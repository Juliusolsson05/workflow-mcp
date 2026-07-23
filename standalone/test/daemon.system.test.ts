import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { describe, expect, it } from 'vitest'

import { FakeAgentProvider } from 'workflow-mcp'

import type { StandaloneConfig } from '../src/config/schema.js'
import { startStandaloneDaemon } from '../src/daemon/lifecycle.js'

describe('standalone daemon', () => {
  it('owns MCP and read-only API state after clients detach, then quiesces as interrupted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-daemon-'))
    const workspace = join(root, 'workspace')
    const workflows = join(workspace, '.claude', 'workflows')
    await mkdir(workflows, { recursive: true })
    await writeFile(join(workflows, 'wait.js'), `export const meta = {
      name: 'wait', description: 'Daemon lifetime fixture'
    }
    return await agent('wait for daemon shutdown')`)
    const config: StandaloneConfig = Object.freeze({
      workspace,
      dataDirectory: join(root, 'data'),
      host: '127.0.0.1',
      port: 0,
      sourceMode: 'read-only',
      leaseMode: 'embedded',
      codexExecutable: '/unused/fake-codex',
      webEnabled: false,
    })
    const daemon = await startStandaloneDaemon(config, {
      provider: new FakeAgentProvider([{ outcome: { type: 'wait-for-abort' } }]),
    })
    const base = `http://127.0.0.1:${daemon.port}`
    expect(await (await fetch(`${base}/healthz`)).json()).toEqual({ status: 'live' })
    expect((await fetch(`${base}/readyz`)).status).toBe(200)
    expect((await fetch(`${base}/api/v1/instance`)).status).toBe(401)

    const client = new Client({ name: 'daemon-test', version: '1' })
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${daemon.tokens.mcp}` } },
    })
    await client.connect(transport)
    expect((await client.listTools()).tools).toHaveLength(13)
    const started = await client.callTool({ name: 'workflow_run', arguments: { name: 'wait' } })
    const runId = (started.structuredContent as { run: { runId: string } }).run.runId
    await client.close()

    const inventory = await fetch(`${base}/api/v1/runs?limit=10`, {
      headers: { authorization: `Bearer ${daemon.tokens.web}` },
    })
    expect(inventory.status).toBe(200)
    const body = await inventory.json() as { items: Array<Record<string, unknown>> }
    expect(body.items).toEqual([expect.objectContaining({ runId })])
    expect(JSON.stringify(body)).not.toContain(workspace)

    await daemon.close('test container replacement')
    expect((await daemon.application.store.getManifest(runId))?.status).toBe('interrupted')
  }, 20_000)
})
