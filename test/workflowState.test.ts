import { describe, expect, it } from 'vitest'

import type { ContentReference, WorkflowEvent } from '../src/workflowEvents.js'
import {
  createWorkflowState,
  projectWorkflowState,
  reduceWorkflowState,
} from '../src/workflowState.js'

const runId = 'run-fat-bug-hunt'

function content(value: unknown, preview = String(value), lineCount = 1): ContentReference {
  return { preview, lineCount, content: value }
}

function eventFactory(): {
  emit(event: Omit<WorkflowEvent, 'schemaVersion' | 'runId' | 'sequence' | 'eventId' | 'timestamp'>): void
  events: WorkflowEvent[]
} {
  let sequence = 0
  const events: WorkflowEvent[] = []

  return {
    events,
    emit(event) {
      sequence += 1
      events.push({
        ...event,
        schemaVersion: 1,
        runId,
        sequence,
        eventId: `event-${sequence}`,
        timestamp: new Date(Date.UTC(2026, 6, 14, 10, 0, sequence)).toISOString(),
      } as WorkflowEvent)
    },
  }
}

describe('workflow state projection', () => {
  it('represents the complete fat-bug-hunt-shaped inspector without terminal-shaped strings', () => {
    const fixture = eventFactory()
    fixture.emit({
      type: 'run.started',
      payload: {
        workflow: {
          name: 'fat-bug-hunt',
          title: 'Deep multi-agent hunt',
          description: 'Find, verify, and report bugs',
          sourceHash: 'abc123',
        },
      },
    })
    fixture.emit({
      type: 'phase.discovered',
      phaseId: 'phase-find',
      payload: { title: 'Find', detail: 'Parallel source analysis', source: 'metadata' },
    })
    fixture.emit({
      type: 'phase.discovered',
      phaseId: 'phase-verify',
      payload: { title: 'Verify', source: 'metadata' },
    })
    fixture.emit({
      type: 'phase.entered',
      phaseId: 'phase-find',
      payload: { title: 'Find' },
    })

    // Admit the first phase in reverse event order. The parent normally assigns call indexes and
    // emits synchronously, but concurrent replay must still derive Claude's stable `1/17` order
    // from identity rather than whichever event happened to be delivered first.
    for (let index = 16; index >= 0; index -= 1) {
      fixture.emit({
        type: 'agent.admitted',
        agentId: `find-${index}`,
        phaseId: 'phase-find',
        payload: {
          callIndex: index,
          label: index === 0 ? 'find:main-sessions' : `find:area-${index}`,
          prompt: content(
            Array.from({ length: 49 }, (_, line) => `Prompt line ${line + 1}`).join('\n'),
            'You are one finder in a large parallel bug hunt…',
            49,
          ),
          options: { model: 'sonnet', schema: { type: 'object' } },
          cacheKey: `cache-${index}`,
        },
      })
      fixture.emit({
        type: 'agent.queued',
        agentId: `find-${index}`,
        phaseId: 'phase-find',
        payload: {},
      })
    }

    // The full run admits 76 logical agents over multiple pipeline phases. This denominator is
    // intentionally independent from the 17-member phase denominator used by agent navigation.
    for (let index = 17; index < 76; index += 1) {
      fixture.emit({
        type: 'agent.admitted',
        agentId: `verify-${index}`,
        phaseId: 'phase-verify',
        payload: {
          callIndex: index,
          label: `verify:${index}`,
          prompt: content(`Verify candidate ${index}`),
          options: { schema: { type: 'object' } },
          cacheKey: `cache-${index}`,
        },
      })
      fixture.emit({
        type: 'agent.queued',
        agentId: `verify-${index}`,
        phaseId: 'phase-verify',
        payload: {},
      })
    }

    // A retry creates another attempt under find-0. It must not create another logical agent or
    // disturb its position in the phase.
    fixture.emit({
      type: 'agent.started',
      agentId: 'find-0',
      phaseId: 'phase-find',
      attemptId: 'attempt-0-1',
      payload: { attemptNumber: 1, source: 'live', provider: 'codex' },
    })
    fixture.emit({
      type: 'agent.failed',
      agentId: 'find-0',
      phaseId: 'phase-find',
      attemptId: 'attempt-0-1',
      payload: { error: { message: 'transient provider disconnect' }, retrying: true },
    })
    fixture.emit({
      type: 'agent.started',
      agentId: 'find-0',
      phaseId: 'phase-find',
      attemptId: 'attempt-0-2',
      payload: {
        attemptNumber: 2,
        source: 'provider-resume',
        provider: 'codex',
        providerSession: { provider: 'codex', id: 'thread-123' },
      },
    })

    for (let index = 0; index < 28; index += 1) {
      fixture.emit({
        type: 'agent.activity.started',
        agentId: 'find-0',
        phaseId: 'phase-find',
        attemptId: 'attempt-0-2',
        payload: {
          activity: {
            activityId: `activity-${index}`,
            kind: index === 27 ? 'tool_call' : 'command',
            title: `Bash(command-${index})`,
          },
        },
      })
      fixture.emit({
        type: 'agent.activity.completed',
        agentId: 'find-0',
        phaseId: 'phase-find',
        attemptId: 'attempt-0-2',
        payload: {
          activityId: `activity-${index}`,
          content: content(`command ${index} output`),
        },
      })
    }

    const structuredFinding = {
      findings: [
        {
          file: 'src/main/sessions/forwarder.ts',
          line: 39,
          title: 'Late JSONL entry resurrects an orphan watcher',
        },
      ],
    }
    fixture.emit({
      type: 'agent.completed',
      agentId: 'find-0',
      phaseId: 'phase-find',
      attemptId: 'attempt-0-2',
      payload: {
        source: 'provider-resume',
        result: content(structuredFinding, '{ "findings": […] }', 9),
        structured: true,
        usage: { inputTokens: 200, outputTokens: 80, totalTokens: 280 },
        providerSession: { provider: 'codex', id: 'thread-123' },
      },
    })

    fixture.emit({
      type: 'agent.reused',
      agentId: 'find-8',
      phaseId: 'phase-find',
      payload: {
        source: 'journal',
        result: content({ findings: [] }, '{ "findings": [] }'),
        structured: true,
      },
    })

    for (let index = 1; index < 76; index += 1) {
      if (index === 8) continue
      const inFindPhase = index < 17
      fixture.emit({
        type: 'agent.skipped',
        agentId: inFindPhase ? `find-${index}` : `verify-${index}`,
        phaseId: inFindPhase ? 'phase-find' : 'phase-verify',
        payload: { reason: 'fixture does not execute remaining calls' },
      })
    }

    fixture.emit({
      type: 'run.completed',
      payload: {
        result: content({ report: 'done' }, '{ "report": "done" }'),
        withErrors: true,
      },
    })

    const state = projectWorkflowState(runId, fixture.events)
    const findPhase = state.phases[0]
    const selected = state.agents.find((agent) => agent.id === 'find-0')
    const journalAgent = state.agents.find((agent) => agent.id === 'find-8')

    expect(state.workflow).toMatchObject({
      name: 'fat-bug-hunt',
      title: 'Deep multi-agent hunt',
      description: 'Find, verify, and report bugs',
    })
    expect(state.status).toBe('completed_with_errors')
    expect(state.counts).toEqual({
      total: 76,
      admitted: 0,
      queued: 0,
      running: 0,
      completed: 2,
      failed: 0,
      recovery_required: 0,
      skipped: 74,
      cancelled: 0,
      reused: 1,
      attempts: 2,
    })
    expect(findPhase?.agentIds).toEqual(Array.from({ length: 17 }, (_, index) => `find-${index}`))
    expect(findPhase?.complete).toBe(true)

    expect(selected?.prompt.lineCount).toBe(49)
    expect(String(selected?.prompt.content).split('\n')).toHaveLength(49)
    expect(selected?.attempts).toHaveLength(2)
    expect(selected?.attempts[0]?.status).toBe('failed')
    expect(selected?.attempts[1]?.source).toBe('provider-resume')
    expect(selected?.error).toBeUndefined()
    expect(selected?.attempts[1]?.activities).toHaveLength(28)
    expect(selected?.attempts[1]?.activities.slice(-3).map((activity) => activity.activityId)).toEqual(
      ['activity-25', 'activity-26', 'activity-27'],
    )
    expect(selected?.outcome?.structured).toBe(true)
    expect(selected?.outcome?.result.content).toEqual(structuredFinding)

    expect(journalAgent?.status).toBe('completed')
    expect(journalAgent?.outcome?.source).toBe('journal')
    expect(journalAgent?.attempts).toEqual([])
  })

  it('keeps activity identity and order while folding updates into the original record', () => {
    const fixture = eventFactory()
    fixture.emit({
      type: 'run.started',
      payload: { workflow: { name: 'activity', description: 'Activity updates' } },
    })
    fixture.emit({
      type: 'agent.admitted',
      agentId: 'agent-1',
      payload: {
        callIndex: 0,
        label: 'inspect',
        prompt: content('Inspect it'),
        options: {},
        cacheKey: 'key',
      },
    })
    fixture.emit({
      type: 'agent.started',
      agentId: 'agent-1',
      attemptId: 'attempt-1',
      payload: { attemptNumber: 1, source: 'live', provider: 'fake' },
    })
    fixture.emit({
      type: 'agent.activity.started',
      agentId: 'agent-1',
      attemptId: 'attempt-1',
      payload: {
        activity: { activityId: 'command-1', kind: 'command', title: 'Bash(npm test)' },
      },
    })
    fixture.emit({
      type: 'agent.activity.updated',
      agentId: 'agent-1',
      attemptId: 'attempt-1',
      payload: { activityId: 'command-1', content: content('half') },
    })
    fixture.emit({
      type: 'agent.activity.updated',
      agentId: 'agent-1',
      attemptId: 'attempt-1',
      payload: { activityId: 'command-1', content: content('complete') },
    })
    fixture.emit({
      type: 'agent.activity.completed',
      agentId: 'agent-1',
      attemptId: 'attempt-1',
      payload: { activityId: 'command-1', data: { exitCode: 0 } },
    })

    const state = projectWorkflowState(runId, fixture.events)
    const activities = state.agents[0]?.attempts[0]?.activities

    expect(activities).toHaveLength(1)
    expect(activities?.[0]).toMatchObject({
      activityId: 'command-1',
      status: 'completed',
      updateCount: 2,
      content: { content: 'complete' },
      data: { exitCode: 0 },
    })
  })

  it('projects and clears the concrete reason an admitted agent is still queued', () => {
    const fixture = eventFactory()
    fixture.emit({
      type: 'run.started',
      payload: { workflow: { name: 'circuit-wait', description: 'Circuit wait visibility' } },
    })
    fixture.emit({
      type: 'agent.admitted',
      agentId: 'agent-1',
      payload: {
        callIndex: 0,
        label: 'review',
        prompt: content('Review the runtime'),
        options: {},
        cacheKey: 'review-key',
      },
    })
    fixture.emit({
      type: 'agent.queued',
      agentId: 'agent-1',
      payload: { reason: 'Waiting for codex provider health probe' },
    })

    let state = projectWorkflowState(runId, fixture.events)
    expect(state.agents[0]?.queueReason).toBe('Waiting for codex provider health probe')

    fixture.emit({
      type: 'agent.started',
      agentId: 'agent-1',
      attemptId: 'attempt-1',
      payload: { attemptNumber: 1, source: 'live', provider: 'codex' },
    })
    state = projectWorkflowState(runId, fixture.events)
    expect(state.agents[0]?.queueReason).toBeUndefined()
  })

  it('projects cancellation, warnings, logs, artifacts, and failed activity as data', () => {
    const fixture = eventFactory()
    fixture.emit({
      type: 'run.started',
      payload: { workflow: { name: 'cancel', description: 'Cancellation projection' } },
    })
    fixture.emit({
      type: 'log',
      payload: { level: 'info', message: content('Starting verification') },
    })
    fixture.emit({
      type: 'warning',
      payload: { code: 'BUDGET_LOW', message: 'Token budget is nearly exhausted' },
    })
    fixture.emit({
      type: 'artifact.created',
      payload: { artifactId: 'report-1', name: 'report.json', mediaType: 'application/json' },
    })
    fixture.emit({
      type: 'run.cancellation_requested',
      payload: { reason: 'user stopped the run' },
    })
    fixture.emit({
      type: 'run.cancelled',
      payload: { reason: 'user stopped the run' },
    })

    const state = projectWorkflowState(runId, fixture.events)

    expect(state.status).toBe('cancelled')
    expect(state.cancellationReason).toBe('user stopped the run')
    expect(state.logs[0]).toMatchObject({ level: 'info', message: { content: 'Starting verification' } })
    expect(state.warnings[0]).toMatchObject({ code: 'BUDGET_LOW' })
    expect(state.artifacts[0]).toMatchObject({ artifactId: 'report-1', name: 'report.json' })
  })

  it('is immutable and rejects corrupt event ordering or identities', () => {
    const fixture = eventFactory()
    fixture.emit({
      type: 'run.started',
      payload: { workflow: { name: 'pure', description: 'Pure projection' } },
    })
    const initial = createWorkflowState(runId)
    const started = reduceWorkflowState(initial, fixture.events[0]!)

    expect(initial.status).toBe('pending')
    expect(initial.sequence).toBe(0)
    expect(started).not.toBe(initial)
    expect(() => reduceWorkflowState(started, fixture.events[0]!)).toThrow(/sequence/)

    const otherRunEvent = { ...fixture.events[0]!, runId: 'another-run', sequence: 2 }
    expect(() => reduceWorkflowState(started, otherRunEvent)).toThrow(/another-run/)

    const unknownAgent: WorkflowEvent = {
      schemaVersion: 1,
      runId,
      sequence: 2,
      eventId: 'event-2',
      timestamp: '2026-07-14T10:00:02.000Z',
      type: 'agent.queued',
      agentId: 'missing',
      payload: {},
    }
    expect(() => reduceWorkflowState(started, unknownAgent)).toThrow(/unknown agent/)
  })
})
