import {
  StandaloneApiClient,
  type InstanceSummary,
  type PublicAgentListPage,
  type PublicAgentResultPage,
  type PublicAgentTranscriptPage,
  type PublicRunState,
  type RunSummary,
} from '../client/apiClient.js'
import { terminalSafe } from '../cli/terminal.js'
import { runInkTerminalUi } from './InkApp.js'

const TUI_VIEWS = ['summary', 'workflow-result', 'agent-result', 'transcript', 'diagnostics'] as const
const PAGE_CURSOR_HISTORY_LIMIT = 32
const DIAGNOSTIC_ITEM_LIMIT = 50

export type TuiView = typeof TUI_VIEWS[number]
export type WorkflowResultPage = Awaited<ReturnType<StandaloneApiClient['result']>>

export type TuiEvidence = {
  agents?: PublicAgentListPage
  resultPage?: WorkflowResultPage | PublicAgentResultPage
  transcriptPage?: PublicAgentTranscriptPage
  error?: string
}

export type TuiRenderModel = {
  instance: InstanceSummary
  runs: RunSummary[]
  selectedRun: number
  run?: RunSummary
  state?: PublicRunState
  view: TuiView
  selectedAgent: number
  evidence: TuiEvidence
  runPageOrdinal: number
  runPageHasMore: boolean
  runPageCanPrevious: boolean
  pageOrdinal: number
  pageCanPrevious: boolean
  scroll: number
  columns: number
  rows: number
  color: boolean
}

export type RenderedTuiScreen = Readonly<{
  screen: string
  maxScroll: number
}>

export async function runTerminalUi(options: {
  endpoint: string
  token: string
  snapshot?: boolean
  input?: NodeJS.ReadStream
  output?: NodeJS.WriteStream
}): Promise<void> {
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  const client = new StandaloneApiClient({ baseUrl: options.endpoint, token: options.token })
  if (options.snapshot === true) {
    const [instance, page] = await Promise.all([client.instance(), client.runs({ limit: 50 })])
    output.write(`${renderTuiSnapshot(instance, page.items)}\n`)
    return
  }
  if (!input.isTTY || !output.isTTY) {
    throw new Error('Interactive UI requires a TTY; use workflow-mcp status --json or ui --snapshot')
  }

  await runInkTerminalUi({ client, input, output })
}

export function renderTuiSnapshot(instance: InstanceSummary, runs: RunSummary[]): string {
  const lines = [
    `Workflow MCP ${terminalSafe(instance.version)} (${terminalSafe(instance.revision.slice(0, 8))})`,
    `Lifecycle: ${terminalSafe(instance.lifecycle)}  Source: ${terminalSafe(instance.sourceMode)}  Browser mutations: disabled`,
    `Workspace: ${instance.runtime.workspace}  Mount: ${instance.runtime.mountMode}  Auth: ${instance.runtime.authentication.status}  Capacity: ${instance.runtime.providerCapacity}  Uptime: ${duration(instance.runtime.uptimeSeconds)}`,
    '',
  ]
  if (runs.length === 0) lines.push('No durable runs.')
  for (const run of runs) {
    lines.push(`${pad(run.status, 22)} ${terminalSafe(run.workflow.title ?? run.workflow.name)}  ${terminalSafe(run.runId)}  cursor=${run.cursor}`)
  }
  return lines.join('\n')
}

export function renderInteractiveTui(model: TuiRenderModel): RenderedTuiScreen {
  const width = Math.max(1, Math.floor(model.columns))
  const height = Math.max(1, Math.floor(model.rows))
  const paint = (code: number, value: string): string => model.color ? `\u001b[${code}m${value}\u001b[0m` : value
  const lines = [
    `${paint(1, 'Workflow MCP')} ${paint(90, terminalSafe(model.instance.version))}  ${paint(model.instance.lifecycle === 'READY' ? 32 : 33, terminalSafe(model.instance.lifecycle))}  ${terminalSafe(model.instance.sourceMode)}`,
    paint(90, `${model.instance.runtime.workspace} · ${model.instance.runtime.mountMode} · auth ${model.instance.runtime.authentication.status} · capacity ${model.instance.runtime.providerCapacity} · up ${duration(model.instance.runtime.uptimeSeconds)}`),
    `${viewLabel('summary', '1 Runs', model.view, paint)}  ${viewLabel('workflow-result', '2 Workflow result', model.view, paint)}  ${viewLabel('agent-result', '3 Agent result', model.view, paint)}`,
    `${viewLabel('transcript', '4 Transcript', model.view, paint)}  ${viewLabel('diagnostics', '5 Diagnostics', model.view, paint)}`,
    paint(90, model.view === 'summary'
      ? '↑/↓ select run · n/p inventory page · g first · ←/→ view · r refresh · q quit'
      : '[/] run · ↑/↓ scroll · PgUp/PgDn · n/p page · g first · ←/→ view · q quit'),
    '─'.repeat(width),
  ]
  if (model.view === 'summary') {
    lines.push(...renderSummary(model, width, height - lines.length, paint))
    return finishRenderedTui(lines, width, height, 0)
  }

  const run = model.run ?? model.runs.at(model.selectedRun)
  if (run === undefined || model.state === undefined) {
    lines.push('', '  No durable run is selected.')
    return finishRenderedTui(lines, width, height, 0)
  }
  lines.push(`${paint(1, truncate(run.workflow.title ?? run.workflow.name, Math.max(8, width - 30)))}  ${paint(statusColor(model.state.status), terminalSafe(model.state.status))}  ${terminalSafe(run.runId)}`)
  const evidence = renderEvidence(model, run, width, paint)
  lines.push(...evidence.headers)
  const available = Math.max(1, height - lines.length)
  const maxScroll = Math.max(0, evidence.content.length - available)
  const scroll = clamp(model.scroll, 0, maxScroll)
  lines.push(...evidence.content.slice(scroll, scroll + available))
  return finishRenderedTui(lines, width, height, maxScroll)
}

function finishRenderedTui(lines: readonly string[], width: number, height: number, maxScroll: number): RenderedTuiScreen {
  // WHY: forcing a convenient minimum canvas makes separators and headings physically wrap on a
  // narrower terminal, invalidating the row budget and sometimes scrolling key help off-screen.
  // Crop only SGR-decorated display text to the actual positive terminal width; control sequences
  // remain zero-width and a final reset prevents a cropped color span from leaking into the shell.
  return {
    screen: lines.slice(0, height).map(line => cropAnsiLine(line, width)).join('\n'),
    maxScroll,
  }
}

function cropAnsiLine(value: string, width: number): string {
  let index = 0
  let visible = 0
  let output = ''
  let decorated = false
  while (index < value.length && visible < width) {
    if (value[index] === '\u001b') {
      const match = /^\u001b\[[0-9;]*m/.exec(value.slice(index))
      if (match !== null) {
        output += match[0]
        index += match[0].length
        decorated = true
        continue
      }
    }
    const nextEscape = value.indexOf('\u001b', index)
    const end = nextEscape === -1 ? value.length : nextEscape
    for (const { segment } of terminalGraphemes(value.slice(index, end))) {
      const cells = graphemeCellWidth(segment)
      if (visible + cells > width) return decorated ? `${output}\u001b[0m` : output
      output += segment
      visible += cells
    }
    index = end
  }
  return decorated ? `${output}\u001b[0m` : output
}

/**
 * Keep only opaque cursors, never the result/transcript bytes behind them.
 *
 * WHY: complete evidence can contain millions of API pages. Previous-page navigation is useful,
 * but retaining every visited cursor would turn an otherwise page-bounded TUI into an unbounded
 * long-session allocation. The first-page `g` shortcut remains available after old history falls
 * out of this deliberately small sliding window.
 */
export function appendBoundedPageCursor<T extends string | number>(
  trail: readonly T[],
  cursor: T,
): T[] {
  return [...trail, cursor].slice(-PAGE_CURSOR_HISTORY_LIMIT)
}

/** Whether popping one cursor still names a page retained in the sliding window. */
export function canNavigateToPreviousPage(pageOrdinal: number, trailLength: number): boolean {
  // WHY: once the fixed cursor window has dropped early pages, popping its final cursor would make
  // the loader interpret an empty trail as page one while the ordinal still names a later page.
  // Stop at that retained floor and keep `g` as the explicit, truthful jump back to page one.
  return trailLength > 1 || (trailLength === 1 && pageOrdinal === trailLength + 1)
}

function renderSummary(
  model: TuiRenderModel,
  width: number,
  availableRows: number,
  paint: (code: number, value: string) => string,
): string[] {
  const pageNavigation = `Run inventory page ${model.runPageOrdinal} · ${model.runPageCanPrevious ? 'p previous' : 'p unavailable'} · ${model.runPageHasMore ? 'n next' : 'n unavailable'} · g first`
  if (model.runs.length === 0) return [pageNavigation, '', '  No durable runs on this page.']
  const detailReserve = model.state === undefined ? 0 : Math.min(7, Math.max(3, Math.floor(availableRows / 2)))
  const inventoryRows = Math.max(1, availableRows - detailReserve)
  const start = clamp(model.selectedRun - Math.floor(inventoryRows / 2), 0, Math.max(0, model.runs.length - inventoryRows))
  const visibleRuns = model.runs.slice(start, start + inventoryRows)
  const lines: string[] = [pageNavigation]
  for (const [offset, run] of visibleRuns.entries()) {
    const index = start + offset
    const cursor = index === model.selectedRun ? paint(36, '›') : ' '
    const status = pad(run.status.replaceAll('_', ' '), 22)
    const indicator = run.error !== undefined || run.status === 'completed_with_errors' ? paint(33, '!') : ' '
    const suffix = `c${run.cursor} ${relativeAge(run.updatedAt)}`
    const nameWidth = Math.max(8, width - 37 - suffix.length)
    const name = truncate(run.workflow.title ?? run.workflow.name, nameWidth)
    lines.push(`${cursor}${indicator} ${paint(statusColor(run.status), status)} ${pad(name, nameWidth)} ${suffix}`)
  }
  if (model.state !== undefined && detailReserve > 0) {
    lines.push('─'.repeat(width))
    lines.push(`Status ${terminalSafe(model.state.status)}  sequence ${model.state.sequence}  agents ${terminalAgentCount(model.state)}/${model.state.counts.total}  attempts ${model.state.counts.attempts}`)
    for (const phase of model.state.phases.slice(0, Math.max(0, detailReserve - 3))) {
      lines.push(`  ${pad(phase.status, 10)} ${truncate(phase.title, width - 15)} (${phase.agentCount})`)
    }
    const warning = model.state.warnings.at(-1)
    if (warning !== undefined) lines.push(paint(33, `  ! ${truncate(warning.message, width - 4)}`))
  }
  return lines
}

function renderEvidence(
  model: TuiRenderModel,
  run: RunSummary,
  width: number,
  paint: (code: number, value: string) => string,
): { headers: string[]; content: string[] } {
  const error = model.evidence.error
  if (error !== undefined) {
    return {
      headers: [paint(31, `${viewTitle(model.view)} unavailable`) ],
      content: wrapTerminalText(error, width),
    }
  }
  if (model.view === 'workflow-result') return renderResultEvidence(model, run, width, 'Workflow result')
  if (model.view === 'agent-result') return renderAgentResultEvidence(model, width)
  if (model.view === 'transcript') return renderTranscriptEvidence(model, width)
  return renderDiagnosticsEvidence(model, run, width, paint)
}

function renderResultEvidence(
  model: TuiRenderModel,
  run: RunSummary,
  width: number,
  label: string,
): { headers: string[]; content: string[] } {
  if (run.result === undefined) {
    return { headers: [`${label} · no artifact recorded`], content: ['The workflow has not committed a readable result.'] }
  }
  const page = model.evidence.resultPage
  if (page === undefined) return { headers: [`${label} · loading`], content: ['Waiting for the bounded result page.'] }
  return {
    headers: [
      `${label} · page ${model.pageOrdinal} · bytes ${page.fromByte}-${page.toByte}/${page.artifact.sizeBytes} · ${page.artifact.mediaType}`,
      renderEvidencePageNavigation(page.hasMore, model.pageCanPrevious),
    ],
    content: wrapTerminalText(page.content.length === 0 ? '(empty result page)' : page.content, width),
  }
}

function renderAgentResultEvidence(
  model: TuiRenderModel,
  width: number,
): { headers: string[]; content: string[] } {
  const agent = model.evidence.agents?.agents.at(model.selectedAgent)
  if (agent === undefined) return { headers: ['Agent result · no agent selected'], content: ['No logical agent has been admitted.'] }
  const selector = `Agent ${model.selectedAgent + 1}/${model.evidence.agents!.agents.length}: ${truncate(agent.label || agent.agentId, Math.max(8, width - 35))} · ${agent.status} · Tab/Shift-Tab select`
  if (!agent.result.available) {
    return { headers: [selector, `Agent result · ${agent.result.source}`], content: ['This agent has not committed a readable result.'] }
  }
  const page = model.evidence.resultPage
  if (page === undefined) return { headers: [selector, 'Agent result · loading'], content: ['Waiting for the bounded result page.'] }
  const source = 'source' in page ? page.source : agent.result.source
  return {
    headers: [
      selector,
      `Agent result · ${source} · page ${model.pageOrdinal} · bytes ${page.fromByte}-${page.toByte}/${page.artifact.sizeBytes}`,
      renderEvidencePageNavigation(page.hasMore, model.pageCanPrevious),
    ],
    content: wrapTerminalText(page.content.length === 0 ? '(empty result page)' : page.content, width),
  }
}

function renderTranscriptEvidence(
  model: TuiRenderModel,
  width: number,
): { headers: string[]; content: string[] } {
  const agent = model.evidence.agents?.agents.at(model.selectedAgent)
  if (agent === undefined) return { headers: ['Transcript · no agent selected'], content: ['No logical agent has been admitted.'] }
  const selector = `Agent ${model.selectedAgent + 1}/${model.evidence.agents!.agents.length}: ${truncate(agent.label || agent.agentId, Math.max(8, width - 35))} · ${agent.status} · Tab/Shift-Tab select`
  const page = model.evidence.transcriptPage
  if (page === undefined) return { headers: [selector, 'Transcript · loading'], content: ['Waiting for the bounded transcript page.'] }
  const events = page.events.flatMap(stored => {
    const payload = JSON.stringify(stored.event.payload)
    return wrapTerminalText(`${stored.cursor}  ${stored.event.type}  sequence=${stored.event.sequence}  ${payload}`, width)
  })
  return {
    headers: [
      selector,
      `Transcript · page ${model.pageOrdinal} · cursor ${page.fromCursor}-${page.toCursor} · ${page.events.length} event${page.events.length === 1 ? '' : 's'}`,
      renderEvidencePageNavigation(page.hasMore, model.pageCanPrevious),
    ],
    content: events.length === 0 ? ['(no transcript events on this page)'] : events,
  }
}

function renderEvidencePageNavigation(hasMore: boolean, canPrevious: boolean): string {
  // WHY: page ordinals survive after the bounded cursor trail drops its oldest entries. Advertising
  // `p previous` from the ordinal alone would promise a cursor the client deliberately no longer
  // retains, so render the same capability predicate that the key handler enforces.
  return `${hasMore ? 'Next page available: n' : 'Final page'}  ·  ${canPrevious ? 'p previous' : 'p unavailable'}  ·  g first`
}

function renderDiagnosticsEvidence(
  model: TuiRenderModel,
  run: RunSummary,
  width: number,
  paint: (code: number, value: string) => string,
): { headers: string[]; content: string[] } {
  const state = model.state!
  const warnings = state.warnings.slice(-DIAGNOSTIC_ITEM_LIMIT)
  const agents = (model.evidence.agents?.agents ?? []).slice(-DIAGNOSTIC_ITEM_LIMIT)
  const content = [
    `Recovery: ${run.resumedFromRunId === undefined ? 'original lineage run' : `resumed from ${run.resumedFromRunId}`}  mode=${run.recoveryMode ?? 'none'}`,
    `Scheduler: ${state.status}  sequence=${state.sequence}  attempts=${state.counts.attempts}  reused=${state.counts.reused}`,
    `Projected warnings: ${warnings.length}${state.warnings.length > warnings.length ? ` latest of ${state.warnings.length}` : ''}`,
  ]
  for (const warning of warnings) {
    content.push(...wrapTerminalText(
      `! sequence=${warning.sequence} ${warning.code ?? 'warning'}${warning.agentId === undefined ? '' : ` agent=${warning.agentId}`}: ${warning.message}`,
      width,
    ))
  }
  if (warnings.length === 0) content.push('  No projected store, provider, or recovery warnings.')
  content.push(`Agent histories: ${agents.length}${(model.evidence.agents?.agents.length ?? 0) > agents.length ? ' latest' : ''}`)
  for (const agent of agents) {
    const attempts = agent.attempts.slice(-5).map(attempt => `#${attempt.number}:${attempt.status}`).join(' ')
    content.push(...wrapTerminalText(
      `${agent.coverageGap ? '! coverage-gap ' : ''}${agent.label || agent.agentId} · ${agent.status} · ${attempts || 'no attempts'}`,
      width,
    ))
  }
  if (agents.length === 0) content.push('  No logical-agent history has been recorded.')
  // The browser/TUI API deliberately projects safe diagnostics. This reminder prevents operators
  // from mistaking a redacted local-observability view for the credential-bearing private logs.
  content.push(...wrapTerminalText(
    'Detailed private provider diagnostics remain in authenticated MCP evidence and container logs.',
    width,
  ).map(line => paint(90, line)))
  return {
    headers: [`Diagnostics · bounded to ${DIAGNOSTIC_ITEM_LIMIT} recent warnings and agents`],
    content,
  }
}

function viewLabel(
  view: TuiView,
  label: string,
  selected: TuiView,
  paint: (code: number, value: string) => string,
): string {
  return view === selected ? paint(36, `[${label}]`) : label
}

function viewTitle(view: TuiView): string {
  if (view === 'workflow-result') return 'Workflow result'
  if (view === 'agent-result') return 'Agent result'
  if (view === 'transcript') return 'Transcript'
  if (view === 'diagnostics') return 'Diagnostics'
  return 'Runs'
}

function wrapTerminalText(value: unknown, width: number): string[] {
  const safe = terminalSafe(value, { multiline: true })
  const lines: string[] = []
  for (const logical of safe.split('\n')) {
    if (logical.length === 0) {
      lines.push('')
      continue
    }
    let line = ''
    let cells = 0
    for (const { segment } of terminalGraphemes(logical)) {
      const segmentCells = graphemeCellWidth(segment)
      if (cells > 0 && cells + segmentCells > width) {
        lines.push(line)
        line = ''
        cells = 0
      }
      line += segment
      cells += segmentCells
    }
    if (line.length > 0) lines.push(line)
  }
  return lines
}

function terminalAgentCount(state: PublicRunState): number {
  return state.counts.completed + state.counts.failed + state.counts.cancelled + state.counts.skipped + state.counts.recovery_required
}

function statusColor(status: string): number {
  if (status === 'completed') return 32
  if (status === 'running' || status === 'queued') return 36
  if (status === 'failed' || status === 'cancelled' || status === 'interrupted') return 31
  return 33
}

function pad(value: string, width: number): string {
  const truncated = truncate(value, width)
  return `${truncated}${' '.repeat(Math.max(0, width - terminalCellWidth(truncated)))}`
}

function truncate(value: string, width: number): string {
  const safe = terminalSafe(value)
  if (width <= 0) return ''
  if (terminalCellWidth(safe) <= width) return safe
  const target = Math.max(0, width - 1)
  let cells = 0
  let output = ''
  for (const { segment } of terminalGraphemes(safe)) {
    const segmentCells = graphemeCellWidth(segment)
    if (cells + segmentCells > target) break
    output += segment
    cells += segmentCells
  }
  return `${output}…`
}

function terminalCellWidth(value: string): number {
  let width = 0
  for (const { segment } of terminalGraphemes(value)) width += graphemeCellWidth(segment)
  return width
}

function terminalGraphemes(value: string): Iterable<{ segment: string }> {
  return new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(value)
}

function graphemeCellWidth(value: string): number {
  // A grapheme is indivisible for cropping. Emoji presentation and East Asian wide/full-width
  // bases occupy two terminal cells; combining-only clusters occupy none. This intentionally small
  // wcwidth table covers the Unicode ranges terminals conventionally treat as double-width without
  // adding a mutable runtime dependency to the credential-bearing image.
  if (/\p{Extended_Pictographic}/u.test(value)) return 2
  let width = 0
  for (const character of value) {
    if (/\p{Mark}/u.test(character) || character === '\uFE0F') continue
    const point = character.codePointAt(0)!
    width = Math.max(width, isWideCodePoint(point) ? 2 : 1)
  }
  return width
}

function isWideCodePoint(point: number): boolean {
  return point >= 0x1100 && (
    point <= 0x115F || point === 0x2329 || point === 0x232A ||
    (point >= 0x2E80 && point <= 0xA4CF && point !== 0x303F) ||
    (point >= 0xAC00 && point <= 0xD7A3) ||
    (point >= 0xF900 && point <= 0xFAFF) ||
    (point >= 0xFE10 && point <= 0xFE19) ||
    (point >= 0xFE30 && point <= 0xFE6F) ||
    (point >= 0xFF00 && point <= 0xFF60) ||
    (point >= 0xFFE0 && point <= 0xFFE6) ||
    (point >= 0x20000 && point <= 0x3FFFD)
  )
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function relativeAge(value: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 1_000))
  return Number.isFinite(seconds) ? duration(seconds) : 'unknown'
}

function duration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h`
  return `${Math.floor(seconds / 86_400)}d`
}

