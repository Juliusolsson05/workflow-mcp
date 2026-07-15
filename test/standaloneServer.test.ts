import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { describe, expect, it } from 'vitest'

import { FakeAgentProvider } from '../src/fakeProvider.js'
import { FileWorkflowStore } from '../src/fileWorkflowStore.js'
import { serveWorkflowMcpHttp } from '../src/standaloneServer.js'
import { WorkflowService } from '../src/workflowService.js'

describe('standalone Streamable HTTP server', () => {
  it('requires bearer auth, rejects non-loopback Origin, and reconnects through durable cursors', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'workflow-http-'))
    const directory = join(cwd, '.claude', 'workflows')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'http.js'), `export const meta = {
      name: 'http-fixture', description: 'HTTP fixture'
    }
    return 'durable result'`)
    const service = new WorkflowService({
      store: new FileWorkflowStore(join(cwd, 'state')),
      provider: new FakeAgentProvider([]),
    })
    await service.initialize()
    const server = await serveWorkflowMcpHttp(service, { cwd }, { token: 'a'.repeat(32) })

    const unauthorized = await fetch(server.url, { method: 'POST' })
    expect(unauthorized.status).toBe(401)
    const hostileOrigin = await fetch(server.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${server.token}`, origin: 'https://attacker.example' },
    })
    expect(hostileOrigin.status).toBe(403)

    const first = await httpClient(server.url, server.token, 'first-http-client')
    expect(first.client.getInstructions()).toContain('scriptPath overrides script, which overrides name')
    const started = await first.client.callTool({
      name: 'workflow_run',
      arguments: { name: 'http-fixture' },
    })
    const runId = (started.structuredContent as { run: { runId: string } }).run.runId
    for (let index = 0; index < 100; index += 1) {
      const status = await first.client.callTool({ name: 'workflow_run_status', arguments: { runId } })
      if ((status.structuredContent as { run: { status: string } }).run.status === 'completed') break
      await new Promise((resolveWait) => setTimeout(resolveWait, 5))
    }
    const firstPage = await first.client.callTool({
      name: 'workflow_run_events',
      arguments: { runId, after: 0, limit: 1 },
    })
    const firstCursor = (firstPage.structuredContent as { page: { toCursor: number } }).page.toCursor
    expect(firstCursor).toBe(1)
    await first.client.close()

    const second = await httpClient(server.url, server.token, 'second-http-client')
    const remainder = await second.client.callTool({
      name: 'workflow_run_events',
      arguments: { runId, after: firstCursor, limit: 1_000 },
    })
    expect(remainder.structuredContent).toMatchObject({
      ok: true,
      page: { fromCursor: 1, hasMore: false },
    })
    expect(
      (remainder.structuredContent as { page: { events: unknown[] } }).page.events.length,
    ).toBeGreaterThan(0)

    await second.client.close()
    await server.close()
    await service.stop()
  })
})

async function httpClient(url: string, token: string, name: string) {
  const client = new Client({ name, version: '1' })
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  })
  await client.connect(transport)
  return { client, transport }
}
