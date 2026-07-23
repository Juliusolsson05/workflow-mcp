import { describe, expect, it } from 'vitest'

import {
  appendBoundedPageCursor,
  canNavigateToPreviousPage,
  renderInteractiveTui,
  renderTuiSnapshot,
  type TuiRenderModel,
} from '../src/tui/application.js'
import { terminalSafe } from '../src/cli/terminal.js'

const instance = {
  schemaVersion: 1 as const,
  version: '1.2.3',
  revision: '0123456789abcdef',
  lifecycle: 'READY',
  sourceMode: 'read-only',
  capabilities: { browserMutations: false as const, authoring: false },
  runtime: {
    workspace: '/workspace' as const,
    mountMode: 'project-read-only' as const,
    authentication: { mode: 'interactive' as const, status: 'operator-check-required' as const },
    startedAt: '2026-01-01T00:00:00.000Z',
    uptimeSeconds: 65,
    providerCapacity: 1,
  },
}

const run = {
  schemaVersion: 1 as const,
  runId: 'run_example',
  workflow: { name: 'review', description: 'Review the project' },
  status: 'running',
  cursor: 42,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:01.000Z',
  lineageId: 'run_example',
  result: { artifactId: 'result_sha256_example', mediaType: 'text/plain', sizeBytes: 4_096, lineCount: 100 },
}

const state = {
  schemaVersion: 1 as const,
  runId: run.runId,
  status: 'running' as const,
  sequence: 42,
  workflow: run.workflow,
  counts: {
    total: 2,
    admitted: 2,
    queued: 0,
    running: 1,
    completed: 1,
    failed: 0,
    recovery_required: 0,
    skipped: 0,
    cancelled: 0,
    reused: 0,
    attempts: 2,
  },
  phases: [{ id: 'phase_1', title: 'Inspect', status: 'running', complete: false, agentCount: 2 }],
  agents: [
    { id: 'agent_1', label: 'Scout', phaseId: 'phase_1', status: 'completed', attemptCount: 1, reused: false },
    { id: 'agent_2', label: 'Reviewer', phaseId: 'phase_1', status: 'running', attemptCount: 1, reused: false },
  ],
  warnings: [],
}

const agentPage = {
  schemaVersion: 1 as const,
  runId: run.runId,
  cursor: 42,
  agents: [
    {
      agentId: 'agent_1',
      callIndex: 0,
      label: 'Scout',
      phaseId: 'phase_1',
      status: 'completed',
      reused: false,
      coverageGap: false,
      attempts: [{ attemptId: 'attempt_1', number: 1, status: 'completed', startedAt: '2026-01-01T00:00:00.000Z' }],
      result: {
        available: true,
        source: 'artifact',
        artifactId: 'agent_result_sha256_one',
        mediaType: 'text/plain',
        sizeBytes: 100,
        lineCount: 2,
      },
    },
    {
      agentId: 'agent_2',
      callIndex: 1,
      label: 'Reviewer',
      phaseId: 'phase_1',
      status: 'recovery_required',
      reused: false,
      coverageGap: true,
      attempts: [{ attemptId: 'attempt_2', number: 1, status: 'failed', startedAt: '2026-01-01T00:00:00.000Z' }],
      result: { available: true, source: 'journal' },
    },
  ],
}

function model(overrides: Partial<TuiRenderModel> = {}): TuiRenderModel {
  return {
    instance,
    runs: [run],
    selectedRun: 0,
    run,
    state,
    view: 'summary',
    selectedAgent: 0,
    evidence: {},
    runPageOrdinal: 1,
    runPageHasMore: false,
    runPageCanPrevious: false,
    pageOrdinal: 1,
    pageCanPrevious: false,
    scroll: 0,
    columns: 90,
    rows: 18,
    color: false,
    ...overrides,
  }
}

function resultPage(content: string, hasMore = false) {
  return {
    schemaVersion: 1 as const,
    runId: run.runId,
    artifact: {
      artifactId: run.result.artifactId,
      mediaType: 'text/plain',
      sizeBytes: 4_096,
      lineCount: 100,
      checksum: { algorithm: 'sha256' as const, value: 'a'.repeat(64) },
    },
    encoding: 'utf-8' as const,
    fromByte: 0,
    toByte: content.length,
    content,
    hasMore,
    ...(hasMore ? { nextCursor: 'cursor_next' } : {}),
  }
}

describe('terminal UI', () => {
  it('renders a deterministic non-ANSI snapshot for logs and accessibility fallbacks', () => {
    const output = renderTuiSnapshot({
      schemaVersion: 1,
      version: '1.2.3',
      revision: '0123456789abcdef',
      lifecycle: 'READY',
      sourceMode: 'read-only',
      capabilities: { browserMutations: false, authoring: false },
      runtime: instance.runtime,
    }, [{
      schemaVersion: 1,
      runId: 'run_example',
      workflow: { name: 'review', description: 'Review the project' },
      status: 'running',
      cursor: 42,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:01.000Z',
      lineageId: 'run_example',
    }])
    expect(output).toContain('Workflow MCP 1.2.3 (01234567)')
    expect(output).toContain('running')
    expect(output).toContain('run_example')
    expect(output).not.toContain('\u001b[')
  })

  it('renders workflow and provider text without terminal or bidi control authority', () => {
    const hostile = 'review\u001b]52;c;stolen\u0007\u001b[2J\rspoof\nline\u202Etxt'
    const output = renderTuiSnapshot({
      schemaVersion: 1,
      version: hostile,
      revision: hostile,
      lifecycle: 'READY',
      sourceMode: 'read-only',
      capabilities: { browserMutations: false, authoring: false },
      runtime: instance.runtime,
    }, [{
      schemaVersion: 1,
      runId: hostile,
      workflow: { name: hostile, description: hostile },
      status: 'running',
      cursor: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:01.000Z',
      lineageId: hostile,
    }])
    expect(output).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]|\p{Cf}/u)
    expect(output).toContain('\uFFFD')
    expect(terminalSafe('first\r\nsecond\u001b[31m', { multiline: true })).toBe('first\nsecond�[31m')
  })

  it('renders and scrolls only the current bounded workflow-result page', () => {
    const page = resultPage(Array.from({ length: 40 }, (_, index) => `result-line-${index}`).join('\n'), true)
    const first = renderInteractiveTui(model({
      view: 'workflow-result',
      evidence: { resultPage: page },
      pageOrdinal: 7,
      pageCanPrevious: true,
    }))
    expect(first.screen).toContain('Workflow result · page 7')
    expect(first.screen).toContain('result-line-0')
    expect(first.screen).not.toContain('result-line-39')
    expect(first.maxScroll).toBeGreaterThan(0)

    const last = renderInteractiveTui(model({
      view: 'workflow-result',
      evidence: { resultPage: page },
      pageOrdinal: 7,
      pageCanPrevious: true,
      scroll: first.maxScroll,
    }))
    expect(last.screen).toContain('result-line-39')
    expect(last.screen.split('\n')).toHaveLength(18)
  })

  it('renders selected agent results and transcript pages without terminal control authority', () => {
    const hostile = 'journal result\u001b]52;c;stolen\u0007\nsecond line\u202Etxt'
    const agentResult = {
      ...resultPage(hostile, false),
      agentId: 'agent_2',
      source: 'journal' as const,
    }
    const result = renderInteractiveTui(model({
      view: 'agent-result',
      selectedAgent: 1,
      evidence: { agents: agentPage, resultPage: agentResult },
    })).screen
    expect(result).toContain('Agent 2/2: Reviewer')
    expect(result).toContain('Agent result · journal')
    expect(result).toContain('journal result�]52;c;stolen�')
    expect(result).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]|\p{Cf}/u)

    const transcript = renderInteractiveTui(model({
      view: 'transcript',
      selectedAgent: 1,
      pageOrdinal: 3,
      pageCanPrevious: true,
      evidence: {
        agents: agentPage,
        transcriptPage: {
          schemaVersion: 1,
          runId: run.runId,
          agentId: 'agent_2',
          fromCursor: 10,
          toCursor: 11,
          hasMore: true,
          events: [{
            runId: run.runId,
            cursor: 11,
            recordedAt: '2026-01-01T00:00:01.000Z',
            event: {
              schemaVersion: 1,
              type: 'warning',
              runId: run.runId,
              sequence: 11,
              eventId: 'event_11',
              timestamp: '2026-01-01T00:00:01.000Z',
              agentId: 'agent_2',
              payload: { code: 'provider-warning', message: 'Projected diagnostic' },
            },
          }],
        },
      },
    })).screen
    expect(transcript).toContain('Transcript · page 3 · cursor 10-11')
    expect(transcript).toContain('provider-warning')
    expect(transcript).toContain('Next page available: n')
    expect(transcript).toContain('p previous')
  })

  it('bounds diagnostics to recent projected warnings and keeps recovery evidence navigable', () => {
    const warnings = Array.from({ length: 60 }, (_, index) => ({
      eventId: `event_${index}`,
      sequence: index,
      timestamp: '2026-01-01T00:00:01.000Z',
      agentId: 'agent_2',
      code: 'provider-warning',
      message: `diagnostic-${index}`,
    }))
    const diagnosticState = { ...state, warnings }
    const first = renderInteractiveTui(model({
      view: 'diagnostics',
      state: diagnosticState,
      evidence: { agents: agentPage },
    }))
    expect(first.screen).toContain('Projected warnings: 50 latest of 60')
    expect(first.screen).toContain('diagnostic-10')
    expect(first.screen).not.toContain('diagnostic-0')
    expect(first.maxScroll).toBeGreaterThan(0)

    const last = renderInteractiveTui(model({
      view: 'diagnostics',
      state: diagnosticState,
      evidence: { agents: agentPage },
      scroll: first.maxScroll,
    })).screen
    expect(last).toContain('diagnostic-59')
    expect(last).toContain('coverage-gap Reviewer')
    expect(last).toContain('Detailed private provider diagnostics remain')
  })

  it('keeps previous-page navigation cursor-only and fixed-size', () => {
    let trail: Array<string | number> = []
    for (let cursor = 0; cursor < 100; cursor += 1) trail = appendBoundedPageCursor(trail, cursor)
    expect(trail).toHaveLength(32)
    expect(trail.at(0)).toBe(68)
    expect(trail.at(-1)).toBe(99)
    expect(trail.every(cursor => typeof cursor === 'number')).toBe(true)
    expect(canNavigateToPreviousPage(3, 1)).toBe(false)
    expect(canNavigateToPreviousPage(2, 1)).toBe(true)
    expect(canNavigateToPreviousPage(34, 32)).toBe(true)
  })

  it('renders truthful bounded run-inventory page navigation', () => {
    const output = renderInteractiveTui(model({
      runPageOrdinal: 34,
      runPageHasMore: true,
      runPageCanPrevious: true,
    })).screen
    expect(output).toContain('Run inventory page 34')
    expect(output).toContain('p previous')
    expect(output).toContain('n next')
    expect(output).toContain('g first')
  })

  it('does not advertise evidence history after the bounded cursor trail reaches its floor', () => {
    const firstPage = renderInteractiveTui(model({
      view: 'workflow-result',
      evidence: { resultPage: resultPage('first page', true) },
    })).screen
    expect(firstPage).toContain('p unavailable')
    expect(firstPage).not.toContain('p previous')

    const boundedFloor = renderInteractiveTui(model({
      view: 'workflow-result',
      evidence: { resultPage: resultPage('oldest retained page') },
      pageOrdinal: 34,
      pageCanPrevious: false,
    })).screen
    expect(boundedFloor).toContain('Workflow result · page 34')
    expect(boundedFloor).toContain('p unavailable')
  })

  it('honors a narrow terminal instead of rendering a hidden wider canvas', () => {
    const rendered = renderInteractiveTui(model({
      columns: 40,
      rows: 10,
      color: true,
      runs: [{ ...run, workflow: { ...run.workflow, title: `${'界'.repeat(30)}🙂e\u0301` } }],
      run: { ...run, workflow: { ...run.workflow, title: `${'界'.repeat(30)}🙂e\u0301` } },
    }))
    const lines = rendered.screen.split('\n')
    expect(lines).toHaveLength(10)
    for (const line of lines) {
      expect(testTerminalCells(line.replaceAll(/\u001b\[[0-9;]*m/g, ''))).toBeLessThanOrEqual(40)
    }
    expect(lines.some(line => line.includes('─'.repeat(40)))).toBe(true)
  })
})

function testTerminalCells(value: string): number {
  let width = 0
  for (const { segment } of new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(value)) {
    if (/\p{Extended_Pictographic}/u.test(segment)) { width += 2; continue }
    const base = [...segment].find(character => !/\p{Mark}/u.test(character))
    if (base === undefined) continue
    const point = base.codePointAt(0)!
    width += point >= 0x1100 && (point <= 0x115F || (point >= 0x2E80 && point <= 0xA4CF) ||
      (point >= 0xAC00 && point <= 0xD7A3) || (point >= 0xF900 && point <= 0xFAFF)) ? 2 : 1
  }
  return width
}
