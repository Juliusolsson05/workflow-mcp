import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { describe, expect, it } from 'vitest'

import { FakeAgentProvider } from 'workflow-mcp'

import type { StandaloneConfig } from '../src/config/schema.js'
import { startStandaloneDaemon } from '../src/daemon/lifecycle.js'
import { StandaloneAdminClient } from '../src/admin/client.js'
import { hashProjectIdentity } from '../src/instance/record.js'

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
      projectHash: hashProjectIdentity(workspace),
      dataDirectory: join(root, 'data'),
      host: '127.0.0.1',
      port: 0,
      sourceMode: 'read-only',
      leaseMode: 'embedded',
      adminSocketPath: join(root, 'run', 'admin.sock'),
      codexExecutable: '/unused/fake-codex',
      webEnabled: true,
    })
    const daemon = await startStandaloneDaemon(config, {
      provider: new FakeAgentProvider([{ outcome: { type: 'wait-for-abort' } }]),
    })
    const base = `http://127.0.0.1:${daemon.port}`
    expect(await (await fetch(`${base}/healthz`)).json()).toEqual({ status: 'live' })
    expect((await fetch(`${base}/readyz`)).status).toBe(200)
    expect((await fetch(`${base}/api/v1/instance`)).status).toBe(401)
    expect((await stat(config.adminSocketPath)).mode & 0o777).toBe(0o600)
    const admin = new StandaloneAdminClient({
      socketPath: config.adminSocketPath,
      token: daemon.tokens.admin,
    })
    expect(await admin.status()).toMatchObject({ lifecycle: 'READY', activeRuns: false })
    expect(await admin.sourceApprovals()).toEqual({ schemaVersion: 1, items: [] })
    const web = await fetch(`${base}/`)
    expect(web.status).toBe(200)
    expect(web.headers.get('content-security-policy')).toContain("default-src 'self'")
    const html = await web.text()
    expect(html).toContain('Workflow MCP')
    expect(html).not.toContain(daemon.tokens.web)
    const scriptPath = /src="([^"]+\.js)"/.exec(html)?.[1]
    expect(scriptPath).toMatch(/^\/assets\//)
    const script = await fetch(`${base}${scriptPath}`)
    expect(script.status).toBe(200)
    expect(script.headers.get('cache-control')).toContain('immutable')
    expect((await fetch(`${base}/assets/..%2Fpackage.json`)).status).toBe(404)

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
