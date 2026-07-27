import {
  StandaloneApiClient,
  type InstanceSummary,
  type PublicRunState,
  type RunSummary,
} from '../../src/client/apiClient.js'
import { activityGlyph, type AgentDetailContent } from '../../src/client/agentActivities.js'
import { followAgentActivity, followRun } from '../../src/client/liveWorkflow.js'
import './style.css'

/*
 * The web dashboard is deliberately the SAME thing as the Ink terminal, rendered to the DOM: a
 * two-line header, a runs list on the left, and a single-column run detail (status line, counts,
 * phases -> agent rows -> expand one agent). Like the Ink rebuild, an expanded agent's Prompt,
 * Activity and Result each live in their OWN bordered panel; the border turns accent on hover (the
 * mouse analog of Ink's keyboard focus) and Prompt/Result carry a "↗ fullscreen" affordance that
 * zooms the content into a scrollable overlay — the web analog of Ink's Enter-to-fullscreen. No
 * pills, no metric cards, no evidence readers. Tokyo Night base + agent-code green.
 */

const root = document.querySelector<HTMLElement>('#app')
if (root === null) throw new Error('Application root is missing')

type RunDetail = { run: RunSummary; state: PublicRunState }

let client: StandaloneApiClient | undefined
let instance: InstanceSummary | undefined
let runs: RunSummary[] = []
let selectedRunId: string | undefined
let detail: RunDetail | undefined
let expandedAgentId: string | undefined
let connectionError: string | undefined
// The panel currently zoomed fullscreen (Prompt/Result/Error), or undefined. Kept as state (not a
// detached node) so it survives the full-DOM re-render every poll tick — render() re-appends it.
let fullscreenPanel: { title: string; body: string; danger: boolean } | undefined
// Per-agent transcript content (prompt/activities/result), kept live by followExpandedAgent while an
// agent is open — NOT fetched once on expand (that was the freeze bug the live engine fixes).
const agentContent = new Map<string, AgentDetailContent>()
const expandedActivities = new Set<string>()
// stop() handles for the two live followers. Exactly one run follower and at most one agent follower
// run at a time; selecting a run / expanding an agent stops the previous one before starting the next.
let stopRunFollow: (() => void) | undefined
let stopAgentFollow: (() => void) | undefined

// Esc closes the fullscreen overlay (mirrors Ink's Esc-zooms-out). Registered once at module load.
window.addEventListener('keydown', event => {
  if (event.key === 'Escape' && fullscreenPanel !== undefined) { fullscreenPanel = undefined; render() }
})

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className !== undefined) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function statusClass(status: string): string {
  return `st-${status.replaceAll('_', '-')}`
}

function agentGlyph(status: string): string {
  if (status === 'failed') return '✗'
  if (status === 'running' || status === 'queued') return '◉'
  if (status === 'completed') return '✓'
  if (status === 'skipped') return '–'
  return '·'
}

function relativeTime(iso: string): string {
  const delta = Date.now() - Date.parse(iso)
  if (!Number.isFinite(delta)) return ''
  if (delta < 60_000) return 'just now'
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m`
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h`
  return `${Math.floor(delta / 86_400_000)}d`
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h`
  return `${Math.floor(seconds / 86_400)}d`
}

void start()

async function start(): Promise<void> {
  // Tokenless by default: probe once. On the hardened profile /instance is 401 with no token, so a
  // single line asks for one; every other failure is a transient connection error, shown inline.
  const candidate = new StandaloneApiClient({ token: '' })
  try {
    instance = await candidate.instance()
    client = candidate
    void poll()
  } catch (error) {
    renderTokenPrompt(describeError(error))
  }
}

function renderTokenPrompt(message?: string): void {
  root!.replaceChildren()
  const box = el('div', 'token-prompt')
  box.append(el('div', 'tp-title', 'Workflow MCP'))
  box.append(el('div', 'tp-copy', 'This daemon requires a web token (hardened profile). Run: workflow-mcp token show'))
  const form = el('form')
  const input = el('input')
  input.type = 'password'
  input.placeholder = 'web token'
  const submit = el('button', undefined, 'Open')
  submit.type = 'submit'
  form.append(input, submit)
  if (message !== undefined) form.append(el('div', 'tp-error', message))
  form.addEventListener('submit', event => {
    event.preventDefault()
    const token = input.value.replace(/\s+/g, '')
    if (token.length === 0) return
    void authenticate(token)
  })
  box.append(form)
  root!.append(box)
  input.focus()
}

async function authenticate(token: string): Promise<void> {
  const candidate = new StandaloneApiClient({ token })
  try {
    instance = await candidate.instance()
    client = candidate
    void poll()
  } catch (error) {
    renderTokenPrompt(describeError(error))
  }
}

async function poll(): Promise<void> {
  await refreshTop()
  followSelectedRun() // live-follow whatever run refreshTop auto-selected
  render()
  // The runs inventory + instance change slowly and have no per-run event feed, so they stay on a
  // light interval. The SELECTED run and the EXPANDED agent are followed live, not polled here.
  window.setInterval(() => { if (document.visibilityState === 'visible') void refreshTop().then(render) }, 3_000)
}

async function refreshTop(): Promise<void> {
  if (client === undefined) return
  try {
    const [inst, page] = await Promise.all([client.instance(), client.runs({ limit: 100 })])
    instance = inst
    runs = page.items
    connectionError = undefined
    // Auto-select the newest run on first sighting and begin following it immediately.
    if (selectedRunId === undefined && runs[0] !== undefined) { selectedRunId = runs[0].runId; followSelectedRun() }
  } catch (error) {
    connectionError = describeError(error)
  }
}

// Live-follow the selected run: long-poll the event feed and refetch the authoritative snapshot on
// each wake (see followRun), replacing the old fixed 2s detail poll. Stops any previous follower.
function followSelectedRun(): void {
  stopRunFollow?.()
  stopRunFollow = undefined
  if (client === undefined || selectedRunId === undefined) { detail = undefined; return }
  stopRunFollow = followRun(client, selectedRunId, {
    onSnapshot: snapshot => { detail = { run: snapshot.run, state: snapshot.state }; render() },
  })
}

// Live-follow the expanded agent's transcript so a running agent's new tool calls and streaming
// result appear without re-expanding. Stops any previous follower; starts one only when an agent is
// open. The follower self-terminates once the agent is done (see followAgentActivity).
function followExpandedAgent(): void {
  stopAgentFollow?.()
  stopAgentFollow = undefined
  if (client === undefined || detail === undefined || expandedAgentId === undefined) return
  const agentId = expandedAgentId
  stopAgentFollow = followAgentActivity(client, detail.run.runId, agentId, {
    onUpdate: content => { agentContent.set(agentId, content); render() },
  })
}

function render(): void {
  if (client === undefined || instance === undefined) return
  // Preserve scroll across full re-renders (this component rebuilds on each poll tick).
  const runsScroll = document.querySelector('.tui-runs')?.scrollTop ?? 0
  const detailScroll = document.querySelector('.tui-detail')?.scrollTop ?? 0
  const fsScroll = document.querySelector('.fs-body')?.scrollTop ?? 0
  root!.replaceChildren(header(instance), body(), footer())
  const ov = overlay()
  if (ov !== null) root!.append(ov)
  const runsEl = document.querySelector('.tui-runs')
  const detailEl = document.querySelector('.tui-detail')
  const fsEl = document.querySelector('.fs-body')
  if (runsEl instanceof HTMLElement) runsEl.scrollTop = runsScroll
  if (detailEl instanceof HTMLElement) detailEl.scrollTop = detailScroll
  if (fsEl instanceof HTMLElement) fsEl.scrollTop = fsScroll
}

// The fullscreen overlay: one panel's content zoomed to fill the viewport, scrollable. Click the
// backdrop or the close button (or press Esc) to zoom back out — the same content, just unclipped.
function overlay(): HTMLElement | null {
  if (fullscreenPanel === undefined) return null
  const dismiss = (): void => { fullscreenPanel = undefined; render() }
  const backdrop = el('div', 'fs-backdrop')
  const modal = el('div', 'fs-modal')
  const head = el('div', 'fs-head')
  head.append(el('span', `fs-title${fullscreenPanel.danger ? ' err' : ''}`, fullscreenPanel.title))
  const close = el('button', 'fs-close', '✕ esc')
  close.addEventListener('click', dismiss)
  head.append(close)
  modal.append(head, el('pre', 'fs-body', fullscreenPanel.body))
  backdrop.append(modal)
  backdrop.addEventListener('click', event => { if (event.target === backdrop) dismiss() })
  return backdrop
}

function header(inst: InstanceSummary): HTMLElement {
  const box = el('header', 'tui-header')
  const line1 = el('div', 'h1')
  const dot = (): HTMLElement => el('span', 'h-sep', '·')
  line1.append(
    el('span', 'h-title', 'Workflow MCP'),
    el('span', 'h-ver', inst.version),
    dot(), el('span', inst.lifecycle === 'READY' ? 'h-ready' : 'h-warn', inst.lifecycle),
    dot(), el('span', 'h-mode', inst.sourceMode),
  )
  if (connectionError !== undefined) line1.append(dot(), el('span', 'h-err', connectionError))
  const r = inst.runtime
  const line2 = el('div', 'h2', `${r.workspace} · ${r.mountMode} · auth ${r.authentication.status} · cap ${r.providerCapacity} · up ${formatUptime(r.uptimeSeconds)}`)
  box.append(line1, line2)
  return box
}

function body(): HTMLElement {
  const box = el('div', 'tui-body')
  box.append(runsList(), runDetail())
  return box
}

function runsList(): HTMLElement {
  const nav = el('nav', 'tui-runs')
  nav.append(el('div', 'runs-head', `RUNS${runs.length > 0 ? ` · ${runs.length}` : ''}`))
  if (runs.length === 0) {
    nav.append(el('div', 'muted pad', 'No durable runs. Start one from Codex.'))
    return nav
  }
  for (const run of runs) {
    const selected = run.runId === selectedRunId
    const btn = el('button', `run-row${selected ? ' selected' : ''}`)
    btn.append(el('span', 'cursor', selected ? '›' : ' '))
    const col = el('div', 'run-col')
    col.append(el('div', 'run-title', run.workflow.title ?? run.workflow.name))
    const sub = el('div', 'run-sub')
    sub.append(el('span', statusClass(run.status), run.status.replaceAll('_', ' ')), el('span', 'muted', ` · ${relativeTime(run.updatedAt)}`))
    col.append(sub)
    btn.append(col)
    btn.addEventListener('click', () => {
      selectedRunId = run.runId
      expandedAgentId = undefined
      detail = undefined
      // Agent IDs (agent_1, …) repeat across runs; drop cached transcripts so a new run's agents
      // don't show the previous run's content.
      agentContent.clear()
      expandedActivities.clear()
      followSelectedRun()   // start following the new run
      followExpandedAgent() // stop the old agent follower (expandedAgentId is now undefined)
      render()
    })
    nav.append(btn)
  }
  return nav
}

function runDetail(): HTMLElement {
  const section = el('section', 'tui-detail')
  if (detail === undefined) {
    section.append(el('div', 'muted pad', 'Select a run to inspect its phases and agents.'))
    return section
  }
  const state = detail.state
  const workflow = state.workflow ?? detail.run.workflow
  const counts = state.counts

  const title = el('div', 'detail-title')
  title.append(el('span', 'dt-name', workflow.title ?? workflow.name), el('span', statusClass(state.status), state.status.replaceAll('_', ' ')))
  section.append(title)

  const summary = [`${counts.completed}/${counts.total} agents`]
  if (counts.running > 0) summary.push(`${counts.running} running`)
  if (counts.failed > 0) summary.push(`${counts.failed} failed`)
  if (counts.reused > 0) summary.push(`${counts.reused} cached`)
  section.append(el('div', 'detail-counts', summary.join(' · ')))

  const byPhase = new Map<string, PublicRunState['agents']>()
  for (const phase of state.phases) byPhase.set(phase.id, [])
  byPhase.set('__unassigned__', [])
  for (const agent of state.agents) {
    const key = agent.phaseId !== undefined && byPhase.has(agent.phaseId) ? agent.phaseId : '__unassigned__'
    byPhase.get(key)!.push(agent)
  }
  const blocks = [
    ...state.phases.map(phase => ({ id: phase.id, title: phase.title, agents: byPhase.get(phase.id) ?? [] })),
    { id: '__unassigned__', title: 'Agents', agents: byPhase.get('__unassigned__') ?? [] },
  ].filter(block => block.agents.length > 0)

  for (const block of blocks) {
    const phaseBox = el('div', 'phase')
    phaseBox.append(el('div', 'phase-title', block.title))
    for (const agent of block.agents) {
      const expanded = expandedAgentId === agent.id
      const row = el('button', `agent-row${expanded ? ' expanded' : ''}`)
      row.append(
        el('span', `glyph ${statusClass(agent.status)}`, agentGlyph(agent.status)),
        el('span', 'agent-label', agent.label || agent.id),
        el('span', 'agent-status muted', agent.status.replaceAll('_', ' ')),
      )
      if (agent.reused) row.append(el('span', 'muted', ' · cached'))
      row.addEventListener('click', () => {
        expandedAgentId = expanded ? undefined : agent.id
        followExpandedAgent() // start/stop the live transcript follower for the newly (un)expanded agent
        render()
      })
      phaseBox.append(row)
      if (expanded) phaseBox.append(agentContentEl(agent.id))
    }
    section.append(phaseBox)
  }

  if (state.warnings.length > 0) {
    const warn = el('div', 'phase')
    warn.append(el('div', 'phase-title warn', 'Warnings'))
    for (const warning of state.warnings.slice(-3)) warn.append(el('div', 'warn-line', `! ${warning.message}`))
    section.append(warn)
  }
  return section
}

function agentContentEl(agentId: string): HTMLElement {
  const wrap = el('div', 'agent-detail')
  const content = agentContent.get(agentId)
  if (content === undefined) {
    wrap.append(el('div', 'muted', 'Loading transcript…'))
    return wrap
  }
  // Prompt / Activity / Result — each its own bordered panel, matching the Ink rebuild's three boxes.
  if (content.prompt !== undefined) wrap.append(textPanel('PROMPT', content.prompt))
  if (content.activities.length > 0) wrap.append(activityPanel(agentId, content.activities))
  if (content.result !== undefined) wrap.append(textPanel('RESULT', content.result))
  if (content.error !== undefined) wrap.append(textPanel('ERROR', content.error, true))
  return wrap
}

// A bordered panel with an accent title; `fullscreen` panels also carry a ⤢ button that zooms the
// whole body into the overlay. Long bodies are clipped to a preview here (max-height in CSS) — the
// clip is exactly why the fullscreen affordance exists.
function panel(label: string, danger: boolean, fullscreenBody?: string): { box: HTMLElement } {
  const box = el('div', `panel${danger ? ' err' : ''}`)
  const head = el('div', 'panel-head')
  head.append(el('span', `panel-title${danger ? ' err' : ''}`, label))
  if (fullscreenBody !== undefined) {
    const fs = el('button', 'panel-fs', '↗ fullscreen')
    fs.addEventListener('click', event => {
      event.stopPropagation()
      fullscreenPanel = { title: label, body: fullscreenBody, danger }
      render()
    })
    head.append(fs)
  }
  box.append(head)
  return { box }
}

function textPanel(label: string, body: string, danger = false): HTMLElement {
  const { box } = panel(label, danger, body)
  box.append(el('pre', 'panel-body', body))
  return box
}

function activityPanel(agentId: string, activities: AgentDetailContent['activities']): HTMLElement {
  const { box } = panel('ACTIVITY', false)
  const list = el('div', 'activities')
  for (const activity of activities) {
    const key = `${agentId}:${activity.activityId}`
    const open = expandedActivities.has(key)
    const row = el('button', 'activity-row')
    row.append(
      el('span', `glyph ${statusClass(activity.status)}`, activityGlyph(activity)),
      el('span', 'act-kind', activity.kind.replaceAll('_', ' ')),
      el('span', 'act-summary', activity.summary),
      el('span', 'act-caret muted', open ? '▾' : '▸'),
    )
    row.addEventListener('click', () => {
      if (expandedActivities.has(key)) expandedActivities.delete(key)
      else expandedActivities.add(key)
      render()
    })
    list.append(row)
    if (open && activity.content.length > 0) list.append(el('pre', 'act-body', activity.content))
  }
  box.append(list)
  return box
}

function footer(): HTMLElement {
  return el('footer', 'tui-footer', 'click a run · click an agent · ↗ fullscreen prompt/result · esc to close · read-only')
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
