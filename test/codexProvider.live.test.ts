import { mkdtemp } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { CodexAgentProvider } from '../src/codexProvider.js'
import type { AgentProviderEvent, AgentRequest } from '../src/agentProvider.js'
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

  it('terminates one real Codex attempt boundary and resumes the same provider thread', async () => {
    const isolatedHome = await mkdtemp(join(tmpdir(), 'workflow-real-codex-host-'))
    const normalCodexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex')
    const provider = new CodexAgentProvider({
      configurationIsolation: {
        codexHome: isolatedHome,
        authenticationFile: join(normalCodexHome, 'auth.json'),
        effectiveConfigurationFingerprint: 'integration-fixture-reviewed-config',
      },
      capabilities: { inheritedMcpServers: 'disabled' },
    })
    const firstController = new AbortController()
    const firstEvents: AgentProviderEvent[] = []
    let sessionId: string | undefined
    const baseRequest: AgentRequest = {
      prompt: 'Run the shell command `sleep 30`, then reply with the single word FINISHED.',
      workingDirectory: process.cwd(),
      sandbox: { mode: 'read-only', approvalPolicy: 'never', network: false },
    }
    const firstIdentity = {
      runId: 'run_real_codex_recovery',
      agentId: 'agent_1',
      attemptId: 'agent_1_attempt_1',
      attemptNumber: 1,
    }
    const first = provider.execute(baseRequest, {
      signal: firstController.signal,
      attempt: firstIdentity,
      emit: async (event) => {
        firstEvents.push(event)
        if (event.type === 'session.started') sessionId = event.session.id
      },
    })

    for (let index = 0; index < 300 && sessionId === undefined; index += 1) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 100))
    }
    expect(sessionId).toBeTypeOf('string')
    firstController.abort('forced integration interruption')
    await provider.terminateAttempt?.(firstIdentity, {
      code: 'timeout',
      message: 'forced integration interruption',
    })
    await expect(first).rejects.toMatchObject({ name: 'AbortError' })

    const recoveryNote = 'The deliberate wait was interrupted for a lifecycle test. Do not run it again. Reply with exactly RECOVERED.'
    const second = await provider.execute({
      ...baseRequest,
      session: { provider: 'codex', id: sessionId! },
      recovery: {
        reason: 'forced integration interruption',
        previousAttemptNumber: 1,
        lastProgressAt: new Date().toISOString(),
        note: recoveryNote,
      },
    }, {
      signal: new AbortController().signal,
      attempt: { ...firstIdentity, attemptId: 'agent_1_attempt_2', attemptNumber: 2 },
      emit: async () => undefined,
    })

    expect(second.providerSession?.id).toBe(sessionId)
    expect(second.output).toEqual({ type: 'text', text: 'RECOVERED' })
    expect(firstEvents.some((event) => event.type === 'session.started')).toBe(true)
  }, 120_000)

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
