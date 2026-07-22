import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

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
  it('registers the complete stable thirteen-tool surface', async () => {
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
      'workflow_agent_list',
      'workflow_agent_result_read',
      'workflow_agent_results_read',
      'workflow_agent_transcript_read',
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

  it('keeps completed dynamic siblings cached through the service-level Claude resume path', async () => {
    const fixture = await createClaudeDynamicRunIdFixture()
    const provider = new FakeAgentProvider([{
      outcome: { type: 'result', output: { type: 'text', text: 'verified-slow-live' } },
    }])
    const service = new WorkflowService({
      store: new FileWorkflowStore(join(fixture.root, 'state')),
      provider,
      claudeProjectsRoot: fixture.claudeProjectsRoot,
    })
    await service.initialize()
    const started = await service.resume(
      { cwd: fixture.cwd },
      { runId: fixture.runId },
    )

    await expect.poll(
      async () => (await service.status({ cwd: fixture.cwd }, started.runId)).status,
      { timeout: 5_000, interval: 25 },
    ).toBe('completed')
    expect(provider.calls.map((call) => call.request.prompt)).toEqual(['verify:slow:SLOW'])
    provider.assertExhausted()
    await service.stop()
  })

  it('honors changed Claude resume args without enabling imported sparse reuse', async () => {
    const fixture = await createClaudeDynamicRunIdFixture()
    const provider = new FakeAgentProvider([
      { outcome: { type: 'result', output: { type: 'text', text: 'FAST-LIVE' } } },
      { outcome: { type: 'result', output: { type: 'text', text: 'verified-fast-live' } } },
    ])
    const service = new WorkflowService({
      store: new FileWorkflowStore(join(fixture.root, 'changed-state')),
      provider,
      claudeProjectsRoot: fixture.claudeProjectsRoot,
    })
    await service.initialize()
    const started = await service.start({ cwd: fixture.cwd }, {
      resumeFromRunId: fixture.runId,
      args: { items: ['fast'] },
    })

    let status = await service.status({ cwd: fixture.cwd }, started.runId)
    for (let index = 0; index < 100 && status.status !== 'completed'; index += 1) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 5))
      status = await service.status({ cwd: fixture.cwd }, started.runId)
    }

    expect(status.status).toBe('completed')
    expect(provider.calls.map((call) => call.request.prompt)).toEqual([
      'find:fast',
      'verify:fast:FAST-LIVE',
    ])
    provider.assertExhausted()
    await service.stop()
  })

  it('exposes each agent result in full even though agent.completed is truncated', async () => {
    // The regression this whole surface exists for: a result larger than the event-stream cap.
    // 50 000 characters is comfortably past DEFAULT_LIMITS.maxLogCharacters (10 000), so the event
    // copy MUST be truncated while the tools MUST still return every byte.
    const large = 'x'.repeat(50_000)
    const cwd = await mkdtemp(join(tmpdir(), 'workflow-mcp-agent-results-'))
    const workflows = join(cwd, '.claude', 'workflows')
    await mkdir(workflows, { recursive: true })
    await writeFile(join(workflows, 'fanout.js'), `export const meta = {
      name: 'fanout', description: 'agent result fixture', phases: [{ title: 'Collect' }]
    }
    phase('Collect')
    const both = await parallel([
      () => agent('big one', { label: 'big' }),
      () => agent('small one', { label: 'small' }),
    ])
    return both.length`)
    const service = new WorkflowService({
      store: new FileWorkflowStore(join(cwd, 'state')),
      provider: new FakeAgentProvider([
        { outcome: { type: 'result', output: { type: 'text', text: large } } },
        { outcome: { type: 'result', output: { type: 'text', text: 'tiny' } } },
      ]),
    })
    await service.initialize()
    const server = new McpServer({ name: 'agent-results-server', version: '1' })
    registerWorkflowMcpTools(server, service, { cwd })
    const client = new Client({ name: 'agent-results-client', version: '1' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    const started = await client.callTool({ name: 'workflow_run', arguments: { name: 'fanout' } })
    const runId = (started.structuredContent as { run: { runId: string } }).run.runId
    for (let index = 0; index < 400; index += 1) {
      const status = await client.callTool({ name: 'workflow_run_status', arguments: { runId } })
      const state = (status.structuredContent as { run: { status: string } }).run.status
      if (state === 'completed' || state === 'completed_with_errors') break
      await new Promise((resolveWait) => setTimeout(resolveWait, 5))
    }

    const listed = await client.callTool({ name: 'workflow_agent_list', arguments: { runId } })
    const agents = (listed.structuredContent as {
      agents: {
        agents: {
          agentId: string
          label: string
          phaseTitle?: string
          status: string
          coverageGap: boolean
          attempts: unknown[]
          result: { available: boolean; source: string; sizeBytes?: number }
        }[]
      }
    }).agents.agents
    expect(agents).toHaveLength(2)
    expect(agents.map((agent) => agent.label).sort()).toEqual(['big', 'small'])
    for (const agent of agents) {
      expect(agent.status).toBe('completed')
      expect(agent.coverageGap).toBe(false)
      expect(agent.phaseTitle).toBe('Collect')
      expect(agent.attempts).toHaveLength(1)
      expect(agent.result.available).toBe(true)
    }
    const big = agents.find((agent) => agent.label === 'big')!
    expect(big.result.source).toBe('artifact')
    expect(big.result.sizeBytes).toBe(50_000)

    // Prove the premise: the event stream really is bounded for this agent.
    const events = await client.callTool({
      name: 'workflow_run_events',
      arguments: { runId, after: 0, limit: 500 },
    })
    const completed = (events.structuredContent as {
      page: { events: { event: { type: string; agentId?: string; payload?: { result?: { truncated?: boolean; content?: string } } } }[] }
    }).page.events.find((stored) =>
      stored.event.type === 'agent.completed' && stored.event.agentId === big.agentId)
    expect(completed?.event.payload?.result?.truncated).toBe(true)
    expect((completed?.event.payload?.result?.content as string).length).toBeLessThan(large.length)

    // Page the full value back and prove concatenation reproduces it byte for byte.
    let assembled = ''
    let cursor: string | undefined
    for (let page = 0; page < 100; page += 1) {
      const read = await client.callTool({
        name: 'workflow_agent_result_read',
        arguments: { runId, agentId: big.agentId, maxBytes: 4_096, ...(cursor === undefined ? {} : { cursor }) },
      })
      const value = (read.structuredContent as {
        page: { content: string; hasMore: boolean; nextCursor?: string; agentId: string; source: string }
      }).page
      expect(value.agentId).toBe(big.agentId)
      assembled += value.content
      if (!value.hasMore) break
      cursor = value.nextCursor
    }
    expect(assembled).toBe(large)

    // A cursor whose embedded checksum does not match must be refused rather than silently
    // reinterpreted against different content.
    const stale = await client.callTool({
      name: 'workflow_agent_result_read',
      arguments: { runId, agentId: big.agentId, cursor: `v1.${'0'.repeat(64)}.0` },
    })
    expect(stale.isError).toBe(true)

    const unknown = await client.callTool({
      name: 'workflow_agent_result_read',
      arguments: { runId, agentId: 'agent_9999' },
    })
    expect(unknown.isError).toBe(true)

    // Bulk sweep reaches both agents and keeps each one's bytes contiguous.
    const collected = new Map<string, string>()
    let bulkCursor: string | undefined
    for (let page = 0; page < 100; page += 1) {
      const bulk = await client.callTool({
        name: 'workflow_agent_results_read',
        arguments: { runId, maxBytes: 8_192, ...(bulkCursor === undefined ? {} : { cursor: bulkCursor }) },
      })
      const value = (bulk.structuredContent as {
        page: { items: { agentId: string; content: string }[]; hasMore: boolean; nextCursor?: string }
      }).page
      for (const item of value.items) {
        collected.set(item.agentId, (collected.get(item.agentId) ?? '') + item.content)
      }
      if (!value.hasMore) break
      bulkCursor = value.nextCursor
    }
    expect(collected.get(big.agentId)).toBe(large)
    expect([...collected.values()]).toContain('tiny')

    // Journal fallback. Deleting the artifact simulates both a run created before per-agent
    // artifacts existed and a completion whose best-effort write was dropped — the case that lets
    // persistAgentResult fail without failing an agent. The same bytes must still come back.
    await rm(join(cwd, 'state', 'runs', runId, 'artifacts', `agent-${big.agentId}.data`))
    await rm(join(cwd, 'state', 'runs', runId, 'artifacts', `agent-${big.agentId}.json`))
    let fallback = ''
    let fallbackCursor: string | undefined
    let fallbackSource = ''
    for (let page = 0; page < 100; page += 1) {
      const read = await client.callTool({
        name: 'workflow_agent_result_read',
        arguments: {
          runId,
          agentId: big.agentId,
          maxBytes: 16_384,
          ...(fallbackCursor === undefined ? {} : { cursor: fallbackCursor }),
        },
      })
      const value = (read.structuredContent as {
        page: { content: string; hasMore: boolean; nextCursor?: string; source: string }
      }).page
      fallbackSource = value.source
      fallback += value.content
      if (!value.hasMore) break
      fallbackCursor = value.nextCursor
    }
    expect(fallbackSource).toBe('journal')
    expect(fallback).toBe(large)
    const relisted = await client.callTool({ name: 'workflow_agent_list', arguments: { runId } })
    const relistedBig = (relisted.structuredContent as {
      agents: { agents: { agentId: string; result: { source: string; available: boolean } }[] }
    }).agents.agents.find((agent) => agent.agentId === big.agentId)!
    expect(relistedBig.result).toMatchObject({ available: true, source: 'journal' })

    // Review blocker: a lineage journal keeps its PREDECESSOR's agent ids until each key is
    // re-admitted, and agent ids are positional, so a stale agent_N routinely names a different
    // logical call. Joining on agentId served that predecessor value as this agent's result — with
    // the list advertising available: true beside it. Rewriting this run's journal so its records
    // carry a foreign key must now make the agent unreadable, not confidently wrong.
    const journalPath = join(cwd, 'state', 'runs', runId, 'transcripts', 'journal.jsonl')
    const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
      snapshots: { records: { type: string; key: string; agentId: string; result?: unknown }[] }[]
    }
    for (const snapshot of journal.snapshots) {
      for (const record of snapshot.records) {
        if (record.type === 'result') record.key = `v2:${'e'.repeat(64)}`
      }
    }
    await writeFile(journalPath, JSON.stringify(journal), 'utf8')
    const foreign = await client.callTool({
      name: 'workflow_agent_result_read',
      arguments: { runId, agentId: big.agentId },
    })
    expect(foreign.isError).toBe(true)

    // The transcript is the agent's slice of the canonical stream, not the best-effort mirror.
    const transcript = await client.callTool({
      name: 'workflow_agent_transcript_read',
      arguments: { runId, agentId: big.agentId },
    })
    const page = (transcript.structuredContent as {
      page: { events: { cursor: number; event: { type: string; agentId: string } }[]; agentId: string }
    }).page
    expect(page.agentId).toBe(big.agentId)
    expect(page.events.length).toBeGreaterThan(0)
    expect(page.events.every((stored) => stored.event.agentId === big.agentId)).toBe(true)
    expect(page.events.map((stored) => stored.event.type)).toContain('agent.completed')

    // Review blocker: paging the transcript dropped events. toCursor reported the SCAN position,
    // which had already advanced past the whole 500-event batch, so when the per-page budget filled
    // mid-batch the matching events behind it were skipped — silently, with hasMore correctly true.
    // Drive it exactly as the tool description instructs and require every event back.
    const paged: number[] = []
    let after = 0
    for (let round = 0; round < 50; round += 1) {
      const chunk = await client.callTool({
        name: 'workflow_agent_transcript_read',
        arguments: { runId, agentId: big.agentId, after, limit: 2 },
      })
      const value = (chunk.structuredContent as {
        page: { events: { cursor: number }[]; toCursor: number; hasMore: boolean }
      }).page
      paged.push(...value.events.map((stored) => stored.cursor))
      if (!value.hasMore) break
      expect(value.toCursor).toBeGreaterThanOrEqual(after)
      after = value.toCursor
    }
    const everyCursor = page.events.map((stored) => stored.cursor)
    expect(paged).toEqual(everyCursor)

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

async function createClaudeDynamicRunIdFixture(): Promise<{
  root: string
  cwd: string
  claudeProjectsRoot: string
  runId: string
}> {
  const runId = 'wf_dynamic1'
  const source = `export const meta = {
  name: 'claude-dynamic-resume',
  description: 'Dynamic service resume fixture',
}
return await pipeline(
  args.items,
  item => agent('find:' + item),
  (found, item) => agent('verify:' + item + ':' + found),
)
`
  const root = await mkdtemp(join(tmpdir(), 'workflow-mcp-claude-dynamic-'))
  const cwd = join(root, 'project')
  const claudeProjectsRoot = join(root, 'claude-projects')
  const projectKey = cwd.replace(/[^A-Za-z0-9]/g, '-')
  const sessionRoot = join(claudeProjectsRoot, projectKey, 'session-one')
  const metadataPath = join(sessionRoot, 'workflows', `${runId}.json`)
  const scriptPath = join(sessionRoot, 'workflows', 'scripts', `claude-dynamic-${runId}.js`)
  const runDirectory = join(sessionRoot, 'subagents', 'workflows', runId)
  const calls = [
    { agentId: 'find-slow', prompt: 'find:slow', result: 'SLOW' },
    { agentId: 'find-fast', prompt: 'find:fast', result: 'FAST' },
    { agentId: 'verify-fast', prompt: 'verify:fast:FAST', result: 'verified-fast-cached' },
    { agentId: 'verify-slow', prompt: 'verify:slow:SLOW' },
  ]
  let previousKey = ''
  const keyed = calls.map((call) => {
    const key = createJournalKey(previousKey, call.prompt)
    previousKey = key
    return { ...call, key }
  })
  const records = [
    ...keyed.map(({ key, agentId }) => ({ type: 'started', key, agentId })),
    ...keyed.flatMap(({ key, agentId, result }) => (
      result === undefined ? [] : [{ type: 'result', key, agentId, result }]
    )),
  ]
  await Promise.all([
    mkdir(cwd, { recursive: true }),
    mkdir(dirname(scriptPath), { recursive: true }),
    mkdir(runDirectory, { recursive: true }),
  ])
  await Promise.all([
    writeFile(scriptPath, source),
    writeFile(metadataPath, JSON.stringify({
      runId,
      workflowName: 'claude-dynamic-resume',
      status: 'completed',
      scriptPath,
      script: source,
      agentCount: 4,
      args: { items: ['slow', 'fast'] },
    })),
    writeFile(
      join(runDirectory, 'journal.jsonl'),
      `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    ),
    ...keyed.map(({ agentId, prompt }) => writeFile(
      join(runDirectory, `agent-${agentId}.jsonl`),
      `${JSON.stringify({
        type: 'user',
        agentId,
        message: { role: 'user', content: prompt },
      })}\n`,
    )),
  ])
  return { root, cwd, claudeProjectsRoot, runId }
}
