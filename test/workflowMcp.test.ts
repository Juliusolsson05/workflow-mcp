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
import { createJournalKey } from '../src/workflowJournal.js'

describe('workflow MCP facade', () => {
  it('registers the complete stable nine-tool surface', async () => {
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
      'workflow_result_read',
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
      run: {
        status: 'completed',
        resumedFromRunId: runId,
        result: {
          artifactId: expect.stringMatching(/^result_sha256_[a-f0-9]{64}$/),
          mediaType: 'text/plain',
          sizeBytes: 7,
          lineCount: 1,
          checksum: { algorithm: 'sha256', value: expect.stringMatching(/^[a-f0-9]{64}$/) },
        },
      },
      health: {
        status: 'completed',
        scheduler: { capacity: 9, active: 0 },
        providerCircuit: { state: 'closed' },
        lineageId: runId,
        recoveryMode: 'manual',
      },
    })
    const resultReference = (resumedStatus.structuredContent as {
      run: { result: { artifactId: string } }
    }).run.result
    const firstResultPage = await client.callTool({
      name: 'workflow_result_read',
      arguments: { runId: resumedId, artifactId: resultReference.artifactId, maxBytes: 4 },
    })
    expect(JSON.parse((firstResultPage.content[0] as { text: string }).text)).toEqual(
      firstResultPage.structuredContent,
    )
    expect(firstResultPage.structuredContent).toMatchObject({
      ok: true,
      page: {
        runId: resumedId,
        content: 'resu',
        fromByte: 0,
        toByte: 4,
        hasMore: true,
        nextCursor: expect.any(String),
      },
    })
    const nextCursor = (firstResultPage.structuredContent as {
      page: { nextCursor: string }
    }).page.nextCursor
    const finalResultPage = await client.callTool({
      name: 'workflow_result_read',
      arguments: {
        runId: resumedId,
        artifactId: resultReference.artifactId,
        cursor: nextCursor,
        maxBytes: 4,
      },
    })
    expect(finalResultPage.structuredContent).toMatchObject({
      page: { content: 'med', fromByte: 4, toByte: 7, hasMore: false },
    })
    const malformed = await client.callTool({
      name: 'workflow_result_read',
      arguments: {
        runId: resumedId,
        artifactId: resultReference.artifactId,
        cursor: 'not-a-result-cursor',
      },
    })
    expect(malformed.isError).toBe(true)

    await client.close()
    await server.close()
    await service.stop()
  })

  it.each([
    ['workflow_resume', 'wf_resume1'],
    ['workflow_run', 'wf_run001'],
  ] as const)('continues a real Claude run by ID through %s', async (toolName, claudeRunId) => {
    const fixture = await createClaudeRunIdFixture(claudeRunId)
    const provider = new FakeAgentProvider([])
    const service = new WorkflowService({
      store: new FileWorkflowStore(join(fixture.root, 'state')),
      provider,
      claudeProjectsRoot: fixture.claudeProjectsRoot,
    })
    await service.initialize()
    const server = new McpServer({ name: 'claude-resume-server', version: '1' })
    registerWorkflowMcpTools(server, service, { cwd: fixture.cwd })
    const client = new Client({ name: 'claude-resume-client', version: '1' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    const resumed = await client.callTool({
      name: toolName,
      arguments: toolName === 'workflow_resume'
        ? { runId: claudeRunId }
        : { resumeFromRunId: claudeRunId },
    })
    expect(resumed.structuredContent, JSON.stringify(resumed)).toBeDefined()
    const runId = (resumed.structuredContent as { run: { runId: string } }).run.runId
    let terminalStatus: string | undefined
    for (let index = 0; index < 100; index += 1) {
      const status = await client.callTool({ name: 'workflow_run_status', arguments: { runId } })
      terminalStatus = (status.structuredContent as { run: { status: string } }).run.status
      if (terminalStatus === 'completed') break
      await new Promise((resolveWait) => setTimeout(resolveWait, 5))
    }

    expect(terminalStatus).toBe('completed')
    expect(resumed.structuredContent).toMatchObject({
      ok: true,
      run: {
        runId: expect.stringMatching(/^run_/),
        resumedFromRunId: claudeRunId,
        lineageId: claudeRunId,
        recoveryMode: 'manual',
      },
    })
    expect(provider.calls).toHaveLength(0)

    await client.close()
    await server.close()
    await service.stop()
  })
})

const CLAUDE_RESUME_SOURCE = `export const meta = {
  name: 'claude-run-id-resume',
  description: 'Claude run ID resume fixture',
}
return await agent('cached result', { schema: { type: 'object' } })
`

async function createClaudeRunIdFixture(runId: string): Promise<{
  root: string
  cwd: string
  claudeProjectsRoot: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'workflow-mcp-claude-id-'))
  const cwd = join(root, 'project')
  const claudeProjectsRoot = join(root, 'claude-projects')
  const projectKey = cwd.replace(/[^A-Za-z0-9]/g, '-')
  const sessionRoot = join(claudeProjectsRoot, projectKey, 'session-one')
  const metadataPath = join(sessionRoot, 'workflows', `${runId}.json`)
  const scriptPath = join(sessionRoot, 'workflows', 'scripts', `claude-run-id-resume-${runId}.js`)
  const journalPath = join(sessionRoot, 'subagents', 'workflows', runId, 'journal.jsonl')
  await Promise.all([
    mkdir(cwd, { recursive: true }),
    mkdir(join(sessionRoot, 'workflows', 'scripts'), { recursive: true }),
    mkdir(join(sessionRoot, 'subagents', 'workflows', runId), { recursive: true }),
  ])
  const key = createJournalKey('', 'cached result', { schema: { type: 'object' } })
  await Promise.all([
    writeFile(scriptPath, CLAUDE_RESUME_SOURCE),
    writeFile(metadataPath, JSON.stringify({
      runId,
      workflowName: 'claude-run-id-resume',
      status: 'completed',
      scriptPath,
      script: CLAUDE_RESUME_SOURCE,
      agentCount: 1,
    })),
    writeFile(journalPath, `${JSON.stringify({
      type: 'started',
      key,
      agentId: 'claude-agent-one',
    })}\n${JSON.stringify({
      type: 'result',
      key,
      agentId: 'claude-agent-one',
      result: { cached: true },
    })}\n`),
  ])
  return { root, cwd, claudeProjectsRoot }
}
