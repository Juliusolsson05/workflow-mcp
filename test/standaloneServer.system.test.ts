import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { describe, expect, it, vi } from 'vitest'

import { FakeAgentProvider } from '../src/fakeProvider.js'
import { FileWorkflowStore } from '../src/fileWorkflowStore.js'
import { serveWorkflowMcpHttp, serveWorkflowMcpStdio } from '../src/standaloneServer.js'
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
    const store = new FileWorkflowStore(join(cwd, 'state'))
    const service = new WorkflowService({
      store,
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

    const privateError = 'OPENAI_API_KEY=should-not-cross-http /private/store/path'
    const transportFailure = vi.spyOn(StreamableHTTPServerTransport.prototype, 'handleRequest')
      .mockRejectedValueOnce(new Error(privateError))
    const internalFailure = await fetch(server.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${server.token}`,
        'content-type': 'application/json',
      },
      body: '{}',
    })
    expect(internalFailure.status).toBe(500)
    const internalFailureBody = await internalFailure.text()
    expect(internalFailureBody).toContain('internal-error')
    expect(internalFailureBody).not.toContain(privateError)
    expect(internalFailureBody).not.toContain('/private/store/path')
    transportFailure.mockRestore()

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
  }, 20_000)
})

describe('standalone STDIO server', () => {
  it('flushes accepted responses and quiesces active ownership when the client closes input', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'workflow-stdio-eof-'))
    const directory = join(cwd, '.claude', 'workflows')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'wait.js'), `export const meta = {
      name: 'stdio-wait', description: 'STDIO EOF ownership fixture'
    }
    return await agent('wait until the session owner closes')`)
    const store = new FileWorkflowStore(join(cwd, 'state'))
    const service = new WorkflowService({
      store,
      provider: new FakeAgentProvider([{ outcome: { type: 'wait-for-abort' } }]),
    })
    await service.initialize()
    const input = new PassThrough()
    const output = new PassThrough()
    let transcript = ''
    output.on('data', chunk => { transcript += chunk.toString() })
    const server = await serveWorkflowMcpStdio(service, { cwd }, {
      input,
      output,
      onInputClose: () => service.quiesce('STDIO client disconnected'),
    })

    input.write(`${JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'eof-test', version: '1' } },
    })}\n`)
    await waitForResponse(() => transcript, 1)
    input.write('{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}\n')
    input.write(`${JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'workflow_run', arguments: { name: 'stdio-wait' } },
    })}\n`)
    const started = await waitForResponse(() => transcript, 2) as {
      result: { structuredContent: { run: { runId: string } } }
    }
    const runId = started.result.structuredContent.run.runId
    input.end()
    await server.closed

    expect(service.lifecycleState()).toBe('STOPPED')
    expect((await store.getManifest(runId))?.status).toBe('interrupted')
    expect(transcript).toContain('"id":2')
  }, 20_000)
})

async function httpClient(url: string, token: string, name: string) {
  const client = new Client({ name, version: '1' })
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  })
  await client.connect(transport)
  return { client, transport }
}

async function waitForResponse(read: () => string, id: number): Promise<unknown> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    for (const line of read().split('\n')) {
      if (line.length === 0) continue
      const message = JSON.parse(line) as { id?: unknown }
      if (message.id === id) return message
    }
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`Timed out waiting for STDIO response ${id}`)
}
