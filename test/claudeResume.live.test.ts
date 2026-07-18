import { describe, expect, it } from 'vitest'

import { loadClaudeWorkflowResume } from '../src/claudeResume.js'
import { FakeAgentProvider } from '../src/fakeProvider.js'
import { runWorkflow } from '../src/runWorkflow.js'
import type { WorkflowEvent } from '../src/workflowEvents.js'

describe.skipIf(
  process.env.WORKFLOW_CLAUDE_RESUME_METADATA === undefined ||
  process.env.WORKFLOW_CLAUDE_RESUME_FILE === undefined,
)('captured Claude workflow resume', () => {
  it('resumes a real captured run at its first missing prefix call', async () => {
    const loaded = await loadClaudeWorkflowResume(
      process.env.WORKFLOW_CLAUDE_RESUME_METADATA as string,
      { workflowPath: process.env.WORKFLOW_CLAUDE_RESUME_FILE as string },
    )
    const scripts = Array.from({ length: 9 }, () => ({
      outcome: {
        type: 'result' as const,
        output: { type: 'structured' as const, value: { findings: [] } },
      },
    })).concat([{
      outcome: {
        type: 'result' as const,
        output: { type: 'structured' as const, value: { merged: [] } },
      },
    }])
    const provider = new FakeAgentProvider(scripts)
    const run = runWorkflow({
      workflow: loaded.workflow,
      ...(Object.prototype.hasOwnProperty.call(loaded.metadata, 'args')
        ? { args: loaded.metadata.args }
        : {}),
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
