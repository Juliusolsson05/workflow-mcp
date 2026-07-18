import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  ClaudeResumeError,
  claudeResumeSidecarPath,
  findClaudeWorkflowRunMetadata,
  loadClaudeWorkflowResume,
} from '../src/claudeResume.js'
import { FakeAgentProvider } from '../src/fakeProvider.js'
import { runWorkflow } from '../src/runWorkflow.js'
import { createJournalKey } from '../src/workflowJournal.js'
import type { WorkflowEvent } from '../src/workflowEvents.js'

const SOURCE = `export const meta = {
  name: 'resume-test',
  description: 'Claude resume fixture',
}
return await agent('first', { schema: { type: 'object' } })
`

describe('Claude persisted workflow resume', () => {
  it('discovers a Claude workflow metadata file by run ID within one project', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'workflow-claude-project-'))
    const metadataPath = join(projectRoot, 'session-one', 'workflows', 'wf_resume1.json')
    await mkdir(dirname(metadataPath), { recursive: true })
    await writeFile(metadataPath, JSON.stringify({
      runId: 'wf_resume1',
      workflowName: 'resume-test',
      scriptPath: '/tmp/resume-test.js',
    }))

    await expect(findClaudeWorkflowRunMetadata(projectRoot, 'wf_resume1')).resolves.toBe(metadataPath)
  })

  it('rejects identifiers that are not native Claude workflow run IDs', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'workflow-claude-project-'))

    await expect(
      findClaudeWorkflowRunMetadata(projectRoot, '../wf_escape'),
    ).rejects.toMatchObject<Partial<ClaudeResumeError>>({ code: 'invalid-run-id' })
  })

  it('fails closed when the same Claude run ID exists in multiple sessions', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'workflow-claude-project-'))
    for (const session of ['session-one', 'session-two']) {
      const metadataPath = join(projectRoot, session, 'workflows', 'wf_duplicate.json')
      await mkdir(dirname(metadataPath), { recursive: true })
      await writeFile(metadataPath, JSON.stringify({
        runId: 'wf_duplicate',
        workflowName: 'resume-test',
        scriptPath: '/tmp/resume-test.js',
      }))
    }

    await expect(
      findClaudeWorkflowRunMetadata(projectRoot, 'wf_duplicate'),
    ).rejects.toMatchObject<Partial<ClaudeResumeError>>({ code: 'ambiguous-run' })
  })

  it('rejects metadata whose embedded run ID differs from its filename', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'workflow-claude-project-'))
    const metadataPath = join(projectRoot, 'session-one', 'workflows', 'wf_expected.json')
    await mkdir(dirname(metadataPath), { recursive: true })
    await writeFile(metadataPath, JSON.stringify({
      runId: 'wf_different',
      workflowName: 'resume-test',
      scriptPath: '/tmp/resume-test.js',
    }))

    await expect(
      findClaudeWorkflowRunMetadata(projectRoot, 'wf_expected'),
    ).rejects.toMatchObject<Partial<ClaudeResumeError>>({ code: 'run-id-mismatch' })
  })

  it('reports a missing Claude project root as a missing run', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'workflow-claude-project-'))

    await expect(
      findClaudeWorkflowRunMetadata(join(parent, 'missing'), 'wf_missing1'),
    ).rejects.toMatchObject<Partial<ClaudeResumeError>>({ code: 'run-not-found' })
  })

  it('uses deterministic workflow-mcp-owned storage for resumed suffix state', () => {
    const first = claudeResumeSidecarPath('/tmp/claude/workflows/wf_one.json')
    expect(first).toBe(claudeResumeSidecarPath('/tmp/claude/workflows/wf_one.json'))
    expect(first).not.toBe(claudeResumeSidecarPath('/tmp/claude/workflows/wf_two.json'))
    expect(first).toContain('.workflow-mcp')
    expect(first).not.toContain('.claude')
  })

  it('imports v2 journal records and reuses the unchanged prefix without a provider call', async () => {
    const fixture = await createFixture(SOURCE)
    const loaded = await loadClaudeWorkflowResume(fixture.metadataPath, {
      workflowPath: fixture.liveWorkflowPath,
    })
    const provider = new FakeAgentProvider([])
    const run = runWorkflow({
      workflow: loaded.workflow,
      cwd: fixture.root,
      provider,
      journal: loaded.journal,
      sandbox: { mode: 'read-only', approvalPolicy: 'never', network: false },
    })
    const events: WorkflowEvent[] = []
    const consume = (async () => {
      for await (const event of run.events) events.push(event)
    })()

    await expect(run.result).resolves.toEqual({ imported: true })
    await consume
    expect(provider.calls).toHaveLength(0)
    expect(events.some((event) => event.type === 'agent.reused')).toBe(true)
    expect(loaded).toMatchObject({
      journalRecordCount: 2,
      importedPromptCount: 1,
      metadata: { runId: 'wf_test', workflowName: 'resume-test', status: 'stopped' },
    })
  })

  it('keeps chained-prefix resume available when a Claude transcript cannot be indexed', async () => {
    const fixture = await createFixture(SOURCE)
    await writeFile(
      join(dirname(fixture.journalPath), 'agent-claude-agent-1.jsonl'),
      'not-json\n',
    )
    const loaded = await loadClaudeWorkflowResume(fixture.metadataPath)
    const provider = new FakeAgentProvider([])
    const run = runWorkflow({
      workflow: loaded.workflow,
      cwd: fixture.root,
      provider,
      journal: loaded.journal,
      journalReuseMode: 'exact-source-sparse',
      sandbox: { mode: 'read-only', approvalPolicy: 'never', network: false },
    })

    await expect(run.result).resolves.toEqual({ imported: true })
    expect(loaded.importedPromptCount).toBe(0)
    expect(provider.calls).toHaveLength(0)
  })

  it('deduplicates retry start records when building the imported prompt index', async () => {
    const fixture = await createFixture(SOURCE)
    const journal = await readFile(fixture.journalPath, 'utf8')
    const key = createJournalKey('', 'first', { schema: { type: 'object' } })
    await writeFile(
      fixture.journalPath,
      `${journal}${JSON.stringify({
        type: 'started',
        key,
        agentId: 'claude-agent-1',
      })}\n`,
    )

    const loaded = await loadClaudeWorkflowResume(fixture.metadataPath)
    expect(loaded.importedPromptCount).toBe(1)
  })

  it('reuses completed verifier siblings when cached pipeline parents settle in a new order', async () => {
    const fixture = await createDynamicPipelineFixture()
    const loaded = await loadClaudeWorkflowResume(fixture.metadataPath)
    const provider = new FakeAgentProvider([{
      outcome: { type: 'result', output: { type: 'text', text: 'verified-slow-live' } },
    }])
    const run = runWorkflow({
      workflow: loaded.workflow,
      cwd: fixture.root,
      provider,
      journal: loaded.journal,
      journalReuseMode: 'exact-source-sparse',
      sandbox: { mode: 'read-only', approvalPolicy: 'never', network: false },
    })
    const events: WorkflowEvent[] = []
    const consume = (async () => {
      for await (const event of run.events) events.push(event)
    })()

    await expect(run.result).resolves.toEqual(['verified-slow-live', 'verified-fast-cached'])
    await consume
    expect(provider.calls.map((call) => call.request.prompt)).toEqual(['verify:slow:SLOW'])
    expect(events.filter((event) => event.type === 'agent.reused')).toHaveLength(3)
    expect(loaded.importedPromptCount).toBe(4)
    provider.assertExhausted()
  })

  it('refuses to apply a Claude journal to changed workflow source', async () => {
    const fixture = await createFixture(SOURCE)
    await writeFile(fixture.liveWorkflowPath, SOURCE.replace("'first'", "'changed'"))

    await expect(
      loadClaudeWorkflowResume(fixture.metadataPath, { workflowPath: fixture.liveWorkflowPath }),
    ).rejects.toMatchObject<Partial<ClaudeResumeError>>({ code: 'workflow-source-mismatch' })
  })

  it('rejects malformed journal identity before execution', async () => {
    const fixture = await createFixture(SOURCE)
    await writeFile(fixture.journalPath, '{"type":"started","key":"bad","agentId":"agent"}\n')

    await expect(loadClaudeWorkflowResume(fixture.metadataPath)).rejects.toMatchObject<
      Partial<ClaudeResumeError>
    >({ code: 'journal-invalid-record' })
  })

})

async function createFixture(source: string): Promise<{
  root: string
  metadataPath: string
  journalPath: string
  liveWorkflowPath: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'workflow-claude-resume-'))
  const session = join(root, 'session')
  const metadataPath = join(session, 'workflows', 'wf_test.json')
  const savedScriptPath = join(session, 'workflows', 'scripts', 'resume-test-wf_test.js')
  const journalPath = join(session, 'subagents', 'workflows', 'wf_test', 'journal.jsonl')
  const liveWorkflowPath = join(root, 'project', '.claude', 'workflows', 'resume-test.js')
  await Promise.all([
    mkdir(dirname(savedScriptPath), { recursive: true }),
    mkdir(dirname(journalPath), { recursive: true }),
    mkdir(dirname(liveWorkflowPath), { recursive: true }),
  ])
  await Promise.all([
    writeFile(savedScriptPath, source),
    writeFile(liveWorkflowPath, source),
    writeFile(
      metadataPath,
      JSON.stringify({
        runId: 'wf_test',
        workflowName: 'resume-test',
        status: 'stopped',
        scriptPath: savedScriptPath,
        script: source,
        agentCount: 1,
      }),
    ),
  ])
  const key = createJournalKey('', 'first', { schema: { type: 'object' } })
  await writeFile(
    journalPath,
    `${JSON.stringify({ type: 'started', key, agentId: 'claude-agent-1' })}\n${JSON.stringify({
      type: 'result',
      key,
      agentId: 'claude-agent-1',
      result: { imported: true },
    })}\n`,
  )
  await writeFile(
    join(dirname(journalPath), 'agent-claude-agent-1.jsonl'),
    `${JSON.stringify({
      type: 'user',
      agentId: 'claude-agent-1',
      message: { role: 'user', content: 'first' },
    })}\n`,
  )
  return { root, metadataPath, journalPath, liveWorkflowPath }
}

async function createDynamicPipelineFixture(): Promise<{
  root: string
  metadataPath: string
}> {
  const source = `export const meta = {
  name: 'dynamic-resume-test',
  description: 'Completion-order resume fixture',
}
return await pipeline(
  ['slow', 'fast'],
  item => agent('find:' + item),
  (found, item) => agent('verify:' + item + ':' + found),
)
`
  const root = await mkdtemp(join(tmpdir(), 'workflow-claude-dynamic-'))
  const session = join(root, 'session')
  const metadataPath = join(session, 'workflows', 'wf_dynamic.json')
  const scriptPath = join(session, 'workflows', 'scripts', 'dynamic-resume-wf_dynamic.js')
  const runDirectory = join(session, 'subagents', 'workflows', 'wf_dynamic')
  const journalPath = join(runDirectory, 'journal.jsonl')
  await Promise.all([
    mkdir(dirname(scriptPath), { recursive: true }),
    mkdir(runDirectory, { recursive: true }),
  ])
  await Promise.all([
    writeFile(scriptPath, source),
    writeFile(metadataPath, JSON.stringify({
      runId: 'wf_dynamic',
      workflowName: 'dynamic-resume-test',
      status: 'stopped',
      scriptPath,
      script: source,
      agentCount: 4,
    })),
  ])

  const calls = [
    { agentId: 'find-slow', prompt: 'find:slow', result: 'SLOW' },
    { agentId: 'find-fast', prompt: 'find:fast', result: 'FAST' },
    // The live fast finder completed first, so its verifier was historically admitted first.
    { agentId: 'verify-fast', prompt: 'verify:fast:FAST', result: 'verified-fast-cached' },
    { agentId: 'verify-slow', prompt: 'verify:slow:SLOW' },
  ]
  let previousKey = ''
  const keyed = calls.map((call) => {
    const key = createJournalKey(previousKey, call.prompt)
    previousKey = key
    return { ...call, key }
  })
  const journalRecords = [
    ...keyed.map(({ key, agentId }) => ({ type: 'started', key, agentId })),
    ...keyed.flatMap(({ key, agentId, result }) => (
      result === undefined ? [] : [{ type: 'result', key, agentId, result }]
    )),
  ]
  await Promise.all([
    writeFile(journalPath, `${journalRecords.map((record) => JSON.stringify(record)).join('\n')}\n`),
    ...keyed.map(({ agentId, prompt }) => writeFile(
      join(runDirectory, `agent-${agentId}.jsonl`),
      `${JSON.stringify({
        type: 'user',
        agentId,
        message: { role: 'user', content: prompt },
      })}\n`,
    )),
  ])
  return { root, metadataPath }
}
