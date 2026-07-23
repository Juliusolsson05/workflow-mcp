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
      concurrency: 1,
    })
    const privateProviderMessage = 'hostile stderr OPENAI_API_KEY=leaked /data/workspaces/private'
    const privateProviderCode = 'hostile-/data/private-code'
    const daemon = await startStandaloneDaemon(config, {
      provider: new FakeAgentProvider([{
        events: [{ event: { type: 'warning', message: privateProviderMessage, code: privateProviderCode } }],
        outcome: { type: 'wait-for-abort' },
      }]),
    })
    const base = `http://127.0.0.1:${daemon.port}`
    expect(await (await fetch(`${base}/healthz`)).json()).toEqual({ status: 'live' })
    expect((await fetch(`${base}/readyz`)).status).toBe(200)
    expect((await fetch(`${base}/api/v1/instance`)).status).toBe(401)
    const instanceResponse = await fetch(`${base}/api/v1/instance`, {
      headers: { authorization: `Bearer ${daemon.tokens.web}` },
    })
    expect(instanceResponse.status).toBe(200)
    const instanceBody = await instanceResponse.json() as Record<string, unknown>
    expect(instanceBody).toMatchObject({
      runtime: {
        workspace: '/workspace',
        mountMode: 'project-read-only',
        authentication: { mode: 'interactive', status: 'operator-check-required' },
        providerCapacity: 1,
        uptimeSeconds: expect.any(Number),
      },
    })
    // The UI needs the logical mount identity, never the embedded host fixture's private path.
    expect(JSON.stringify(instanceBody)).not.toContain(workspace)
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

    let detailBody: {
      state: { phases: Array<{ agentCount: number }>; agents: unknown[]; warnings: Array<{ code: string }> }
    } | undefined
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const detail = await fetch(`${base}/api/v1/runs/${encodeURIComponent(runId)}`, {
        headers: { authorization: `Bearer ${daemon.tokens.web}` },
      })
      expect(detail.status).toBe(200)
      detailBody = await detail.json() as typeof detailBody
      if (detailBody?.state.warnings.length) break
      await new Promise(resolveWait => setTimeout(resolveWait, 5))
    }
    expect(detailBody).toBeDefined()
    expect(detailBody.state.phases.every(phase => Number.isSafeInteger(phase.agentCount))).toBe(true)
    expect(Array.isArray(detailBody.state.agents)).toBe(true)
    expect(JSON.stringify(detailBody)).not.toContain(workspace)
    expect(JSON.stringify(detailBody)).not.toContain(privateProviderMessage)
    expect(JSON.stringify(detailBody)).not.toContain(privateProviderCode)
    expect(detailBody!.state.warnings).toContainEqual(expect.objectContaining({ code: 'provider-warning' }))

    const transcript = await fetch(`${base}/api/v1/runs/${encodeURIComponent(runId)}/agents/agent_1/transcript`, {
      headers: { authorization: `Bearer ${daemon.tokens.web}` },
    })
    expect(transcript.status).toBe(200)
    const transcriptText = await transcript.text()
    expect(transcriptText).toContain('provider-warning')
    expect(transcriptText).not.toContain(privateProviderMessage)
    expect(transcriptText).not.toContain(privateProviderCode)
    expect(transcriptText).not.toContain('fake-session-1')
    expect(JSON.stringify(detailBody)).not.toContain('agentIds')

    const originalSnapshot = daemon.application.service.snapshot.bind(daemon.application.service)
    const privateErrorMessage = 'OPENAI_API_KEY=browser-leak /data/workspaces/hidden'
    Object.defineProperty(daemon.application.service, 'snapshot', {
      configurable: true,
      value: async () => {
        throw Object.assign(new Error(privateErrorMessage), { code: 'hostile-/data-error-code' })
      },
    })
    const failedDetail = await fetch(`${base}/api/v1/runs/${encodeURIComponent(runId)}`, {
      headers: { authorization: `Bearer ${daemon.tokens.web}` },
    })
    expect(failedDetail.status).toBe(500)
    const failedBody = await failedDetail.text()
    expect(failedBody).toContain('internal-error')
    expect(failedBody).not.toContain(privateErrorMessage)
    expect(failedBody).not.toContain('/data')
    Object.defineProperty(daemon.application.service, 'snapshot', {
      configurable: true,
      value: originalSnapshot,
    })

    const originalLifecycleState = daemon.application.service.lifecycleState.bind(daemon.application.service)
    Object.defineProperty(daemon.application.service, 'lifecycleState', {
      configurable: true,
      value: () => 'FAILED',
    })
    // Readiness is derived from the service lifecycle, not merely the startup-complete boolean. The
    // inherited-flock monitor changes the former asynchronously when its pathname is replaced.
    expect(daemon.ready()).toBe(false)
    expect((await fetch(`${base}/readyz`)).status).toBe(503)
    Object.defineProperty(daemon.application.service, 'lifecycleState', {
      configurable: true,
      value: originalLifecycleState,
    })

    await daemon.close('test container replacement')
    expect((await daemon.application.store.getManifest(runId))?.status).toBe('interrupted')
  }, 20_000)
})
