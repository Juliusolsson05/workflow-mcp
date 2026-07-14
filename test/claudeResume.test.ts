import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  ClaudeResumeError,
  claudeResumeSidecarPath,
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
      metadata: { runId: 'wf_test', workflowName: 'resume-test', status: 'stopped' },
    })
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

  it.skipIf(
    process.env.WORKFLOW_CLAUDE_RESUME_METADATA === undefined ||
    process.env.WORKFLOW_CLAUDE_RESUME_FILE === undefined,
  )('resumes a real captured Claude run at its first missing prefix call', async () => {
    const loaded = await loadClaudeWorkflowResume(
      process.env.WORKFLOW_CLAUDE_RESUME_METADATA as string,
      { workflowPath: process.env.WORKFLOW_CLAUDE_RESUME_FILE as string },
    )
    const scripts = Array.from({ length: 9 }, () => ({
      outcome: { type: 'result' as const, output: { type: 'structured' as const, value: { findings: [] } } },
    })).concat([
      {
        // The eight cached finders contain real findings, so the workflow reaches dedup even when
        // every newly executed suffix finder reports nothing. Keeping this response empty makes
        // the captured-corpus test deterministic while still exercising the post-resume join.
        outcome: {
          type: 'result' as const,
          output: { type: 'structured' as const, value: { merged: [] } },
        },
      },
    ])
    const provider = new FakeAgentProvider(scripts)
    const run = runWorkflow({
      workflow: loaded.workflow,
      cwd: process.cwd(),
      provider,
      journal: loaded.journal,
      sandbox: { mode: 'read-only', approvalPolicy: 'never', network: false },
    })
    const events: WorkflowEvent[] = []
    const consume = (async () => {
      for await (const event of run.events) events.push(event)
    })()

    await expect(run.result).resolves.toEqual({ confirmed: [], refuted: [] })
    await consume
    expect(events.filter((event) => event.type === 'agent.reused')).toHaveLength(8)
    expect(provider.calls).toHaveLength(10)
    expect(provider.calls[0]?.request.prompt).toContain('Your beat: src/renderer/src/rendering/')
    provider.assertExhausted()
  }, 20_000)
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
  return { root, metadataPath, journalPath, liveWorkflowPath }
}
