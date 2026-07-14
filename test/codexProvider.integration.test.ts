import { describe, expect, it } from 'vitest'

import { CodexAgentProvider } from '../src/codexProvider.js'
import { parseWorkflowSource } from '../src/loadWorkflow.js'
import { runWorkflow } from '../src/runWorkflow.js'
import type { WorkflowEvent } from '../src/workflowEvents.js'

describe.skipIf(process.env.WORKFLOW_CODEX_INTEGRATION !== '1')('Codex SDK integration', () => {
  it('runs one portable workflow through the authenticated read-only SDK boundary', async () => {
    const provider = new CodexAgentProvider()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort('Codex integration timeout'), 60_000)
    const workflow = parseWorkflowSource(`
      export const meta = {
        name: 'codex-integration',
        description: 'One real provider turn through the complete runtime',
      }
      return await agent('Reply with exactly WORKFLOW_CODEX_OK and do not use tools.')
    `)

    try {
      const run = runWorkflow({
        workflow,
        cwd: process.cwd(),
        provider,
        sandbox: { mode: 'read-only', approvalPolicy: 'never', network: false },
        signal: controller.signal,
      })
      const events: WorkflowEvent[] = []
      const consume = (async () => {
        for await (const event of run.events) events.push(event)
      })()
      await expect(run.result).resolves.toBe('WORKFLOW_CODEX_OK')
      await consume
      expect(events.some((event) => event.type === 'agent.session.started')).toBe(true)
      expect(events.at(-1)?.type).toBe('run.completed')
    } finally {
      clearTimeout(timer)
    }
  }, 70_000)

  it('runs a Claude-style schema with an optional field through Codex strict output', async () => {
    const provider = new CodexAgentProvider()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort('Codex schema integration timeout'), 60_000)
    const workflow = parseWorkflowSource(`
      export const meta = {
        name: 'codex-schema-integration',
        description: 'Real strict-schema compatibility check',
      }
      return await agent('Return value WORKFLOW_SCHEMA_OK. There is no optional value, so return null for it. Do not use tools.', {
        schema: {
          type: 'object',
          required: ['value'],
          properties: {
            value: { type: 'string' },
            optional: { type: 'string', description: 'No value exists; return null.' },
          },
        },
      })
    `)

    try {
      const run = runWorkflow({
        workflow,
        cwd: process.cwd(),
        provider,
        sandbox: { mode: 'read-only', approvalPolicy: 'never', network: false },
        signal: controller.signal,
      })
      const consume = (async () => {
        for await (const _event of run.events) {
          // Draining is required even when this focused assertion does not inspect event payloads.
        }
      })()
      await expect(run.result).resolves.toEqual({ value: 'WORKFLOW_SCHEMA_OK' })
      await consume
    } finally {
      clearTimeout(timer)
    }
  }, 70_000)
})
