import { describe, expect, it } from 'vitest'

import { AgentProviderFailure } from '../src/agentProvider.js'
import type {
  AgentProvider,
  AgentProviderExecutionContext,
  AgentProviderResult,
  AgentRequest,
} from '../src/agentProvider.js'
import { parseWorkflowSource } from '../src/loadWorkflow.js'
import { runWorkflow } from '../src/runWorkflow.js'
import type { WorkflowRun } from '../src/runWorkflow.js'
import { projectWorkflowState } from '../src/workflowState.js'
import type { WorkflowEvent } from '../src/workflowEvents.js'

function workflow(body: string) {
  return parseWorkflowSource(`export const meta = {
    name: 'unattended-soak',
    description: 'Deterministic unattended completion soak',
  }
  ${body}`)
}

function collect(run: WorkflowRun): Promise<WorkflowEvent[]> {
  return (async () => {
    const events: WorkflowEvent[] = []
    for await (const event of run.events) events.push(event)
    return events
  })()
}

const FAST_RETRY = {
  maxAttempts: 3,
  startupTimeoutMs: 100,
  idleTimeoutMs: 100,
  activeOperationTimeoutMs: 100,
  attemptTimeoutMs: 1_000,
  retryBackoffBaseMs: 1,
  retryBackoffMaxMs: 1,
  retryJitterRatio: 0,
  hardTerminationGraceMs: 5,
  underutilizationWarningMs: 10,
} as const

describe('unattended best-effort completion', () => {
  it('makes all 200 logical assignments terminal and always runs synthesis', async () => {
    const attempts = new Map<string, number>()
    let active = 0
    let maxActive = 0
    let synthesisRan = false
    const provider: AgentProvider = {
      name: 'deterministic-soak',
      automaticReplaySafety: 'safe',
      assessReplaySafety: (request) => request.prompt.includes('unsafe-ambiguous')
        ? {
            automatic: false,
            risk: 'unknown_external',
            reason: 'fixture models an assignment with an unknown external mutation',
          }
        : {
            automatic: true,
            risk: 'read_only',
            reason: 'fixture assignment is read-only',
          },
      execute: async (request): Promise<AgentProviderResult> => {
        active += 1
        maxActive = Math.max(maxActive, active)
        try {
          await new Promise((resolveWait) => setTimeout(resolveWait, 1))
          if (request.prompt.startsWith('synthesize ')) {
            synthesisRan = true
            return { output: { type: 'text', text: 'synthesis-complete' } }
          }
          const count = (attempts.get(request.prompt) ?? 0) + 1
          attempts.set(request.prompt, count)
          if (request.prompt.includes('unsafe-ambiguous')) {
            throw new AgentProviderFailure('unknown external outcome', { retryable: true })
          }
          if (request.prompt.includes('terminal-contract')) {
            throw new AgentProviderFailure('malformed structured output', {
              code: 'structured-output-invalid',
              terminalDisposition: 'reject',
            })
          }
          if (request.prompt.includes('retry-once') && count === 1) {
            throw new AgentProviderFailure('transient stream failure', {
              code: 'stream-failed',
              retryable: true,
            })
          }
          return { output: { type: 'text', text: `completed:${request.prompt}` } }
        } finally {
          active -= 1
        }
      },
    }
    const run = runWorkflow({
      workflow: workflow(`
        const results = await parallel(Array.from({ length: 200 }, (_, index) => () => {
          const kind = index % 53 === 0
            ? 'unsafe-ambiguous'
            : index % 37 === 0
              ? 'terminal-contract'
              : index % 20 === 0
                ? 'retry-once'
                : 'healthy'
          return agent(kind + '-' + index)
        }))
        const gaps = results.filter((value) => value && value.__workflowAgentFailure)
        const synthesis = await agent('synthesize ' + JSON.stringify({ total: results.length, gaps }))
        return { results, synthesis }
      `),
      cwd: process.cwd(),
      provider,
      sandbox: { mode: 'read-only', network: false },
      limits: { concurrency: 9, maxAgentCalls: 220 },
      reliability: FAST_RETRY,
    })
    const events = collect(run)

    const result = await run.result as { results: unknown[]; synthesis: string }
    const state = projectWorkflowState(run.id, await events)
    const gaps = result.results.filter((value) => (
      typeof value === 'object' && value !== null && '__workflowAgentFailure' in value
    ))

    expect(result.results).toHaveLength(200)
    expect(gaps).toHaveLength(9)
    expect(result.synthesis).toBe('synthesis-complete')
    expect(synthesisRan).toBe(true)
    expect(maxActive).toBe(9)
    expect(state.status).toBe('completed_with_errors')
    expect(state.counts.total).toBe(201)
    expect(state.counts.completed + state.counts.failed + state.counts.recovery_required).toBe(201)
    expect(state.counts.failed).toBe(5)
    expect(state.counts.recovery_required).toBe(4)
  })

  it('retries an unconfirmed read-only timeout in a fresh thread without fencing the run', async () => {
    let calls = 0
    const provider: AgentProvider = {
      name: 'unconfirmed-read-only',
      automaticReplaySafety: 'safe',
      terminationBoundary: 'unconfirmed-descendants',
      execute: async (
        request: AgentRequest,
        _context: AgentProviderExecutionContext,
      ): Promise<AgentProviderResult> => {
        calls += 1
        if (calls === 1) return await new Promise<AgentProviderResult>(() => undefined)
        expect(request.session).toBeUndefined()
        return { output: { type: 'text', text: 'fresh-thread-recovered' } }
      },
    }
    const run = runWorkflow({
      workflow: workflow(`return await agent('read-only timeout')`),
      cwd: process.cwd(),
      provider,
      sandbox: { mode: 'read-only', network: false },
      limits: { cancellationGraceMs: 2 },
      reliability: { ...FAST_RETRY, idleTimeoutMs: 5 },
    })
    const events = collect(run)

    await expect(run.result).resolves.toBe('fresh-thread-recovered')
    const state = projectWorkflowState(run.id, await events)
    expect(calls).toBe(2)
    expect(state.status).toBe('completed')
    expect(state.agents[0]?.attempts.map((attempt) => attempt.status)).toEqual(['failed', 'completed'])
    expect(run.ownershipReleaseSafe?.()).toBe(true)
  })
})
