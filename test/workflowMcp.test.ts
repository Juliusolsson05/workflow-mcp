import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { describe, expect, it } from 'vitest'

import { FakeAgentProvider } from '../src/fakeProvider.js'
import { FileWorkflowStore } from '../src/fileWorkflowStore.js'
import { registerWorkflowMcpTools } from '../src/workflowMcp.js'
import { WorkflowService } from '../src/workflowService.js'

describe('workflow MCP facade', () => {
  it('registers the complete stable eight-tool surface', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'workflow-mcp-tools-'))
    const service = new WorkflowService({
      store: new FileWorkflowStore(join(cwd, 'state')),
      provider: new FakeAgentProvider([]),
    })
    await service.initialize()
    const server = new McpServer({ name: 'test-workflow-server', version: '1' })
    registerWorkflowMcpTools(server, service, { cwd })
    const client = new Client({ name: 'test-workflow-client', version: '1' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    const tools = await client.listTools()
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      'workflow_describe',
      'workflow_list',
      'workflow_resume',
      'workflow_run',
      'workflow_run_cancel',
      'workflow_run_events',
      'workflow_run_status',
      'workflow_validate',
    ])
    const listed = await client.callTool({ name: 'workflow_list', arguments: {} })
    expect(listed.structuredContent).toMatchObject({ ok: true })
    expect((listed.structuredContent as { workflows: unknown[] }).workflows).toEqual(expect.any(Array))

    // WHY this test deliberately does not assert an empty list: user-level workflows are valid
    // inputs to discovery even when the project fixture is empty. Depending on the developer's
    // real ~/.claude directory made this protocol-surface test fail on healthy machines and hid
    // actual regressions behind local-state pollution. Discovery precedence has dedicated tests;
    // this assertion only proves that the stable tool can be invoked and returns its typed shape.

    await client.close()
    await server.close()
    await service.stop()
  })

  it('round-trips run, status, events, cancel, and resume as structured and text JSON', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'workflow-mcp-roundtrip-'))
    const workflows = join(cwd, '.claude', 'workflows')
    await mkdir(workflows, { recursive: true })
    await writeFile(join(workflows, 'roundtrip.js'), `export const meta = {
      name: 'roundtrip', description: 'MCP roundtrip fixture'
    }
    return await agent('roundtrip agent')`)
    const providers = [
      new FakeAgentProvider([{ outcome: { type: 'wait-for-abort' } }]),
      new FakeAgentProvider([{
        expect: { sessionId: 'fake-session-1' },
        outcome: { type: 'result', output: { type: 'text', text: 'resumed' } },
      }]),
    ]
    const service = new WorkflowService({
      store: new FileWorkflowStore(join(cwd, 'state')),
      provider: () => {
        const provider = providers.shift()
        if (!provider) throw new Error('No fake provider remains')
        return provider
      },
    })
    await service.initialize()
    const server = new McpServer({ name: 'roundtrip-server', version: '1' })
    registerWorkflowMcpTools(server, service, { cwd })
    const client = new Client({ name: 'roundtrip-client', version: '1' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    const started = await client.callTool({
      name: 'workflow_run',
      arguments: { name: 'roundtrip', idempotencyKey: 'roundtrip-one' },
    })
    expect(JSON.parse((started.content[0] as { text: string }).text)).toEqual(started.structuredContent)
    const runId = (started.structuredContent as { run: { runId: string } }).run.runId
    let cursor = 0
    for (let index = 0; index < 100; index += 1) {
      const status = await client.callTool({ name: 'workflow_run_status', arguments: { runId } })
      cursor = (status.structuredContent as { run: { cursor: number } }).run.cursor
      if (cursor >= 5) break
      await new Promise((resolveWait) => setTimeout(resolveWait, 5))
    }
    const events = await client.callTool({
      name: 'workflow_run_events',
      arguments: { runId, after: 0, limit: 2 },
    })
    expect(events.structuredContent).toMatchObject({
      ok: true,
      page: { fromCursor: 0, toCursor: 2, hasMore: true },
    })

    const cancelled = await client.callTool({
      name: 'workflow_run_cancel',
      arguments: { runId, reason: 'MCP test cancel' },
    })
    expect(cancelled.structuredContent).toMatchObject({ ok: true, run: { status: 'cancelled' } })
    const resumed = await client.callTool({
      name: 'workflow_resume',
      arguments: { runId, idempotencyKey: 'roundtrip-resume' },
    })
    const resumedId = (resumed.structuredContent as { run: { runId: string } }).run.runId
    for (let index = 0; index < 100; index += 1) {
      const status = await client.callTool({
        name: 'workflow_run_status',
        arguments: { runId: resumedId },
      })
      if ((status.structuredContent as { run: { status: string } }).run.status === 'completed') break
      await new Promise((resolveWait) => setTimeout(resolveWait, 5))
    }
    const resumedStatus = await client.callTool({
      name: 'workflow_run_status',
      arguments: { runId: resumedId },
    })
    expect(resumedStatus.structuredContent).toMatchObject({
      ok: true,
      run: { status: 'completed', resumedFromRunId: runId },
      health: {
        status: 'completed',
        scheduler: { capacity: 9, active: 0 },
        providerCircuit: { state: 'closed' },
        lineageId: runId,
        recoveryMode: 'manual',
      },
    })

    await client.close()
    await server.close()
    await service.stop()
  })
})
