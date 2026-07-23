import { reduceWorkflowState, type WorkflowSnapshot } from 'workflow-mcp/state'

import {
  StandaloneApiClient,
  StandaloneApiError,
  type InstanceSummary,
  type RunSummary,
} from '../../src/client/apiClient.js'
import './style.css'

const rootCandidate = document.querySelector<HTMLElement>('#app')
if (rootCandidate === null) throw new Error('Application root is missing')
const root: HTMLElement = rootCandidate

let client: StandaloneApiClient | undefined
let selectedRunId: string | undefined
let detailAbort: AbortController | undefined

renderLogin()

function renderLogin(message?: string): void {
  detailAbort?.abort()
  root.replaceChildren()
  const card = element('section', 'login-card')
  const mark = element('div', 'product-mark', 'WM')
  const eyebrow = element('p', 'eyebrow', 'LOCAL OBSERVABILITY')
  const title = element('h1', undefined, 'Workflow MCP')
  const copy = element('p', 'login-copy', 'Inspect durable runs without granting this browser permission to change them.')
  const form = document.createElement('form')
  const label = element('label', undefined, 'Web access token')
  label.htmlFor = 'token'
  const input = document.createElement('input')
  input.id = 'token'
  input.type = 'password'
  input.autocomplete = 'off'
  input.spellcheck = false
  input.placeholder = 'Paste token from workflow-mcp token show'
  const submit = document.createElement('button')
  submit.type = 'submit'
  submit.textContent = 'Open dashboard'
  form.append(label, input, submit)
  if (message !== undefined) form.append(element('p', 'form-error', message))
  form.addEventListener('submit', event => {
    event.preventDefault()
    const token = input.value.trim()
    if (token.length === 0) return
    void authenticate(token)
  })
  card.append(mark, eyebrow, title, copy, form, element('p', 'privacy-note', 'Held in this tab’s memory only. The API is read-only.'))
  root.append(card)
  input.focus()
}

async function authenticate(token: string): Promise<void> {
  const candidate = new StandaloneApiClient({ token })
  try {
    const instance = await candidate.instance()
    client = candidate
    await renderDashboard(instance)
  } catch (error) {
    renderLogin(describeError(error))
  }
}

async function renderDashboard(instance: InstanceSummary): Promise<void> {
  if (client === undefined) return
  root.replaceChildren()
  const shell = element('div', 'shell')
  const header = element('header', 'topbar')
  const identity = element('div', 'identity')
  identity.append(element('div', 'product-mark compact', 'WM'), element('div', undefined, 'Workflow MCP'))
  const facts = element('div', 'instance-facts')
  facts.append(
    pill(instance.lifecycle, instance.lifecycle === 'READY' ? 'good' : 'warn'),
    pill(instance.sourceMode.toUpperCase()),
    element('span', 'version', `${instance.version} · ${instance.revision.slice(0, 8)}`),
  )
  const forget = element('button', 'ghost-button', 'Forget token')
  forget.addEventListener('click', () => { client = undefined; renderLogin() })
  header.append(identity, facts, forget)
  const content = element('div', 'content')
  const list = element('aside', 'run-list')
  list.append(element('div', 'section-heading', 'RUNS'), element('div', 'loading', 'Loading durable inventory…'))
  const detail = element('section', 'detail empty')
  detail.append(element('p', undefined, 'Select a run to inspect phases, attempts, output, and recovery state.'))
  content.append(list, detail)
  shell.append(header, content)
  root.append(shell)
  await refreshRuns(list, detail)
  window.setInterval(() => { if (document.visibilityState === 'visible') void refreshRuns(list, detail, true) }, 4_000)
}

async function refreshRuns(list: HTMLElement, detail: HTMLElement, quiet = false): Promise<void> {
  if (client === undefined) return
  try {
    const page = await client.runs({ limit: 100 })
    const heading = element('div', 'section-heading')
    heading.append(document.createTextNode('RUNS'), element('span', 'count', String(page.items.length)))
    const rows = element('div', 'run-rows')
    if (page.items.length === 0) rows.append(element('p', 'empty-copy', 'No durable runs yet. Start one from Codex through MCP.'))
    for (const run of [...page.items].reverse()) rows.append(runButton(run, detail))
    list.replaceChildren(heading, rows)
    if (selectedRunId !== undefined && !page.items.some(run => run.runId === selectedRunId)) {
      selectedRunId = undefined
      detail.replaceChildren(element('p', undefined, 'The selected run is outside this bounded page.'))
    }
  } catch (error) {
    if (!quiet) list.replaceChildren(element('p', 'form-error', describeError(error)))
  }
}

function runButton(run: RunSummary, detail: HTMLElement): HTMLButtonElement {
  const button = element('button', `run-row${run.runId === selectedRunId ? ' selected' : ''}`) as HTMLButtonElement
  button.type = 'button'
  const top = element('span', 'run-row-top')
  top.append(element('strong', undefined, run.workflow.title ?? run.workflow.name), statusBadge(run.status))
  const bottom = element('span', 'run-row-bottom')
  bottom.append(element('span', undefined, shortId(run.runId)), element('time', undefined, relativeTime(run.updatedAt)))
  button.append(top, bottom)
  button.addEventListener('click', () => {
    selectedRunId = run.runId
    document.querySelectorAll('.run-row').forEach(node => node.classList.remove('selected'))
    button.classList.add('selected')
    void followRun(run.runId, detail)
  })
  return button
}

async function followRun(runId: string, detail: HTMLElement): Promise<void> {
  detailAbort?.abort()
  const controller = new AbortController()
  detailAbort = controller
  detail.className = 'detail'
  detail.replaceChildren(element('div', 'loading', 'Reconstructing durable state…'))
  try {
    const snapshot = await client!.run(runId, controller.signal)
    let state = snapshot.state
    let cursor = snapshot.cursor
    renderRunDetail(snapshot.run, state, detail)
    while (!controller.signal.aborted && selectedRunId === runId && !isTerminal(state.status)) {
      const page = await client!.events(runId, cursor, { waitMs: 20_000 }, controller.signal)
      for (const stored of page.events) {
        if (stored.cursor <= cursor) continue
        state = reduceWorkflowState(state, stored.event)
        cursor = stored.cursor
      }
      renderRunDetail(snapshot.run, state, detail)
    }
  } catch (error) {
    if (!controller.signal.aborted) detail.replaceChildren(element('p', 'form-error', describeError(error)))
  }
}

function renderRunDetail(run: RunSummary, state: WorkflowSnapshot, detail: HTMLElement): void {
  const heading = element('div', 'detail-heading')
  const titleBlock = element('div')
  titleBlock.append(element('p', 'eyebrow', shortId(run.runId)), element('h2', undefined, run.workflow.title ?? run.workflow.name))
  heading.append(titleBlock, statusBadge(state.status))
  const metrics = element('div', 'metrics')
  const counts = state.counts
  metrics.append(
    metric('Agents', `${counts.completed + counts.failed + counts.cancelled + counts.skipped}/${counts.total}`),
    metric('Attempts', String(counts.attempts)),
    metric('Reused', String(counts.reused)),
    metric('Cursor', String(state.sequence)),
  )
  const phases = element('section', 'panel')
  phases.append(element('h3', undefined, 'Phases'))
  if (state.phases.length === 0) phases.append(element('p', 'empty-copy', 'No phase boundary has been recorded.'))
  for (const phase of state.phases) {
    const row = element('div', 'phase-row')
    row.append(statusDot(phase.status), element('strong', undefined, phase.title), element('span', 'muted', `${phase.agentIds.length} agents`))
    phases.append(row)
  }
  const agents = element('section', 'panel')
  agents.append(element('h3', undefined, 'Logical agents'))
  if (state.agents.length === 0) agents.append(element('p', 'empty-copy', 'Waiting for agent admission.'))
  for (const agent of state.agents) {
    const row = element('div', 'agent-row')
    const copy = element('div')
    copy.append(element('strong', undefined, agent.label ?? agent.id), element('span', 'muted block', `${agent.attempts.length} attempt${agent.attempts.length === 1 ? '' : 's'}${agent.outcome?.source === 'journal' ? ' · reused' : ''}`))
    row.append(statusDot(agent.status), copy, statusBadge(agent.status))
    agents.append(row)
  }
  const warnings = element('section', 'panel')
  warnings.append(element('h3', undefined, 'Warnings & recovery'))
  const recovery = run.resumedFromRunId === undefined ? 'Original lineage run' : `Resumed from ${shortId(run.resumedFromRunId)}`
  warnings.append(element('p', 'muted', recovery))
  for (const warning of state.warnings) warnings.append(element('p', 'warning-copy', warning.message))
  if (state.warnings.length === 0) warnings.append(element('p', 'empty-copy', 'No projected warnings.'))
  detail.replaceChildren(heading, metrics, phases, agents, warnings)
}

function metric(label: string, value: string): HTMLElement {
  const node = element('div', 'metric')
  node.append(element('span', 'metric-label', label), element('strong', undefined, value))
  return node
}

function pill(text: string, kind = ''): HTMLElement {
  return element('span', `pill ${kind}`.trim(), text)
}

function statusBadge(status: string): HTMLElement {
  return element('span', `status status-${status.replaceAll('_', '-')}`, status.replaceAll('_', ' '))
}

function statusDot(status: string): HTMLElement {
  return element('span', `status-dot status-${status.replaceAll('_', '-')}`)
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className !== undefined) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function shortId(value: string): string {
  return value.length > 18 ? `${value.slice(0, 14)}…` : value
}

function relativeTime(value: string): string {
  const delta = Date.now() - Date.parse(value)
  if (!Number.isFinite(delta)) return value
  if (delta < 60_000) return 'just now'
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`
  return `${Math.floor(delta / 86_400_000)}d ago`
}

function isTerminal(status: string): boolean {
  return ['completed', 'completed_with_errors', 'failed', 'cancelled', 'interrupted'].includes(status)
}

function describeError(error: unknown): string {
  if (error instanceof StandaloneApiError && error.status === 401) return 'That token was not accepted.'
  if (error instanceof Error && error.name === 'AbortError') return 'Request cancelled.'
  return error instanceof Error ? error.message : String(error)
}
