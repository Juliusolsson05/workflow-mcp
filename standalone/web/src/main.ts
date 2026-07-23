import {
  StandaloneApiClient,
  StandaloneApiError,
  StandaloneTransportError,
  type InstanceSummary,
  type PublicRunState,
  type RunSummary,
} from '../../src/client/apiClient.js'
import { followProjectedRun } from '../../src/client/liveRun.js'
import './style.css'

const rootCandidate = document.querySelector<HTMLElement>('#app')
if (rootCandidate === null) throw new Error('Application root is missing')
const root: HTMLElement = rootCandidate
const CURSOR_HISTORY_LIMIT = 32

let client: StandaloneApiClient | undefined
let selectedRunId: string | undefined
let detailAbort: AbortController | undefined
let runCursorTrail: string[] = []
let runPageOrdinal = 1
let runNextCursor: string | undefined
let inventoryGeneration = 0
let dashboardRefreshInterval: number | undefined
let inventoryAbort: AbortController | undefined
const evidenceReconcileStates = new WeakMap<HTMLElement, { latest: RunSummary; running: boolean }>()

renderLogin()

function renderLogin(message?: string): void {
  stopDashboardRefresh()
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
    resetRunInventory()
    await renderDashboard(instance)
  } catch (error) {
    renderLogin(describeError(error))
  }
}

async function renderDashboard(instance: InstanceSummary): Promise<void> {
  if (client === undefined) return
  const dashboardClient = client
  // Authentication can be retried without reloading the tab. Keep exactly one
  // owner for polling so an old dashboard cannot keep refreshing detached DOM
  // (or retain a token-bearing client) after a later dashboard replaces it.
  stopDashboardRefresh()
  root.replaceChildren()
  const shell = element('div', 'shell')
  const header = element('header', 'topbar')
  const identity = element('div', 'identity')
  identity.append(element('div', 'product-mark compact', 'WM'), element('div', undefined, 'Workflow MCP'))
  const facts = element('div', 'instance-facts')
  renderInstanceFacts(facts, instance, true)
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
  // Reuse the already-authenticated instance DTO on the first inventory request, but still pass the
  // header's connection owner. Otherwise a disconnect in the small gap between `/instance` and
  // `/runs` leaves a contradictory LIVE badge beside an inventory error until the first timer tick.
  await refreshRuns(list, detail, false, facts, false)
  // The user can forget the token while the first inventory request is in
  // flight. Do not resurrect polling for a dashboard that has since been
  // detached or whose credential-bearing client is no longer current.
  if (client !== dashboardClient || !shell.isConnected) return
  dashboardRefreshInterval = window.setInterval(() => {
    if (document.visibilityState === 'visible') void refreshRuns(list, detail, true, facts)
  }, 4_000)
}

async function refreshRuns(
  list: HTMLElement,
  detail: HTMLElement,
  quiet = false,
  facts?: HTMLElement,
  refreshInstance = facts !== undefined,
): Promise<void> {
  if (client === undefined) return
  // A refresh interval is a freshness trigger, not permission to accumulate token-bearing
  // requests. Abort the prior inventory owner before replacing it.
  inventoryAbort?.abort()
  const controller = new AbortController()
  inventoryAbort = controller
  const generation = ++inventoryGeneration
  try {
    const cursor = runCursorTrail.at(-1)
    const [page, instance] = await Promise.all([
      client.runs({ limit: 100, ...(cursor === undefined ? {} : { cursor }) }, controller.signal),
      // Initial authentication already supplied the first instance DTO. Periodic reconciliation
      // refreshes it alongside inventory so version/lifecycle/uptime cannot remain from an old
      // daemon while the same tab successfully displays new runs after restart.
      facts === undefined || !refreshInstance
        ? Promise.resolve(undefined)
        : client.instance(controller.signal),
    ])
    if (generation !== inventoryGeneration) return
    if (facts !== undefined && instance !== undefined) renderInstanceFacts(facts, instance, true)
    runNextCursor = page.hasMore ? page.nextCursor : undefined
    const heading = element('div', 'section-heading')
    heading.append(
      document.createTextNode('RUNS'),
      element('span', 'count', `PAGE ${runPageOrdinal} · ${page.items.length}`),
    )
    const rows = element('div', 'run-rows')
    if (page.items.length === 0) rows.append(element('p', 'empty-copy', 'No durable runs yet. Start one from Codex through MCP.'))
    for (const run of [...page.items].reverse()) rows.append(runButton(run, detail))
    const navigation = paginationControls({
      pageOrdinal: runPageOrdinal,
      canPrevious: canNavigatePrevious(runPageOrdinal, runCursorTrail.length),
      canNext: runNextCursor !== undefined,
      onFirst: () => {
        runCursorTrail = []
        runPageOrdinal = 1
        runNextCursor = undefined
        clearSelectedRun(detail)
        void refreshRuns(list, detail)
      },
      onPrevious: () => {
        if (!canNavigatePrevious(runPageOrdinal, runCursorTrail.length)) return
        runCursorTrail = runCursorTrail.slice(0, -1)
        runPageOrdinal = Math.max(1, runPageOrdinal - 1)
        runNextCursor = undefined
        clearSelectedRun(detail)
        void refreshRuns(list, detail)
      },
      onNext: () => {
        if (runNextCursor === undefined) return
        runCursorTrail = appendCursor(runCursorTrail, runNextCursor)
        runPageOrdinal += 1
        runNextCursor = undefined
        clearSelectedRun(detail)
        void refreshRuns(list, detail)
      },
    })
    list.replaceChildren(heading, rows, navigation)
    if (selectedRunId !== undefined && !page.items.some(run => run.runId === selectedRunId)) {
      clearSelectedRun(detail)
      detail.replaceChildren(element('p', undefined, 'The selected run is outside this bounded page.'))
    }
  } catch (error) {
    if (!(error instanceof Error && error.name === 'AbortError') && generation === inventoryGeneration) {
      // Preserve last durable inventory/detail evidence while making staleness visible. A quiet
      // timer means "do not erase useful state", never "pretend disconnected state is current".
      if (facts !== undefined) renderConnectionState(facts, false, describeError(error))
      if (!quiet) list.replaceChildren(element('p', 'form-error', describeError(error)))
    }
  } finally {
    if (inventoryAbort === controller) inventoryAbort = undefined
  }
}

function renderInstanceFacts(facts: HTMLElement, instance: InstanceSummary, connected: boolean): void {
  facts.replaceChildren(
    pill(instance.lifecycle, instance.lifecycle === 'READY' ? 'good' : 'warn'),
    pill(instance.runtime.mountMode.replaceAll('-', ' ')),
    pill(instance.runtime.authentication.mode === 'api-key-secret' ? 'AUTH KEY' : 'AUTH BROKER'),
    pill(`CAP ${instance.runtime.providerCapacity}`),
    element('span', 'version', `${instance.version} · ${instance.revision.slice(0, 8)} · up ${formatDuration(instance.runtime.uptimeSeconds)}`),
  )
  renderConnectionState(facts, connected)
}

function renderConnectionState(facts: HTMLElement, connected: boolean, detail?: string): void {
  facts.querySelector('[data-role="connection-status"]')?.remove()
  const status = pill(
    connected ? 'LIVE' : `DISCONNECTED · RETRYING${detail === undefined ? '' : ` · ${detail}`}`,
    connected ? 'good' : 'warn',
  )
  status.dataset.role = 'connection-status'
  facts.append(status)
}

function resetRunInventory(): void {
  stopDashboardRefresh()
  runCursorTrail = []
  runPageOrdinal = 1
  runNextCursor = undefined
  selectedRunId = undefined
  inventoryGeneration += 1
  inventoryAbort?.abort()
  inventoryAbort = undefined
}

function stopDashboardRefresh(): void {
  if (dashboardRefreshInterval !== undefined) {
    window.clearInterval(dashboardRefreshInterval)
    dashboardRefreshInterval = undefined
  }
  inventoryAbort?.abort()
  inventoryAbort = undefined
}

function clearSelectedRun(detail: HTMLElement): void {
  detailAbort?.abort()
  selectedRunId = undefined
  detail.className = 'detail empty'
  detail.replaceChildren(element('p', undefined, 'Select a run from this bounded inventory page.'))
}

function runButton(run: RunSummary, detail: HTMLElement): HTMLButtonElement {
  const button = element('button', `run-row${run.runId === selectedRunId ? ' selected' : ''}`) as HTMLButtonElement
  button.type = 'button'
  const top = element('span', 'run-row-top')
  top.append(element('strong', undefined, run.workflow.title ?? run.workflow.name), statusBadge(run.status))
  const bottom = element('span', 'run-row-bottom')
  bottom.append(
    element('span', undefined, `${shortId(run.runId)} · cursor ${run.cursor}${run.error === undefined ? '' : ' · error'}`),
    element('time', undefined, relativeTime(run.updatedAt)),
  )
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
  const detailClient = client!
  try {
    await followProjectedRun({
      signal: controller.signal,
      readSnapshot: signal => detailClient.run(runId, signal),
      waitForEvents: async (after, signal) => (
        await detailClient.events(runId, after, { waitMs: 20_000 }, signal)
      ).toCursor,
      isTerminal: state => isTerminal(state.status),
      shouldRetry: isRetryableBrowserError,
      onSnapshot: snapshot => {
        if (selectedRunId === runId) renderRunDetail(snapshot.run, snapshot.state, detail)
      },
      onRetry: (error, delayMs) => {
        showDetailConnectionStatus(detail, `Connection interrupted: ${describeError(error)} · retrying in ${Math.ceil(delayMs / 1_000)}s`)
      },
    })
  } catch (error) {
    if (!controller.signal.aborted) showDetailConnectionStatus(detail, describeError(error))
  }
}

function renderRunDetail(run: RunSummary, state: PublicRunState, detail: HTMLElement): void {
  const sameRun = detail.dataset.runId === run.runId
  let connection = sameRun ? detail.querySelector<HTMLElement>('[data-role="detail-connection"]') : null
  let summary = sameRun ? detail.querySelector<HTMLElement>('[data-role="detail-summary"]') : null
  let evidence = sameRun ? detail.querySelector<HTMLElement>('[data-role="detail-evidence"]') : null
  if (connection === null || summary === null || evidence === null) {
    connection = element('p', 'form-error')
    connection.dataset.role = 'detail-connection'
    connection.hidden = true
    summary = element('div', 'detail-summary')
    summary.dataset.role = 'detail-summary'
    evidence = element('div', 'detail-evidence')
    evidence.dataset.role = 'detail-evidence'
    detail.replaceChildren(connection, summary, evidence)
    detail.dataset.runId = run.runId
  }
  connection.hidden = true
  connection.textContent = ''
  // Reconcile newly admitted agents/results by stable keys on every projection while preserving
  // existing reader nodes, cursor trails, expansion, output, and scroll state.
  void appendEvidenceReaders(run, evidence, detailAbort?.signal)
  const heading = element('div', 'detail-heading')
  const titleBlock = element('div')
  titleBlock.append(element('p', 'eyebrow', shortId(run.runId)), element('h2', undefined, run.workflow.title ?? run.workflow.name))
  heading.append(titleBlock, statusBadge(state.status))
  const metrics = element('div', 'metrics')
  const counts = state.counts
  metrics.append(
    metric('Agents', `${settledAgentCount(counts)}/${counts.total}`),
    metric('Attempts', String(counts.attempts)),
    metric('Reused', String(counts.reused)),
    metric('Cursor', String(state.sequence)),
  )
  const phases = element('section', 'panel')
  phases.append(element('h3', undefined, 'Phases'))
  if (state.phases.length === 0) phases.append(element('p', 'empty-copy', 'No phase boundary has been recorded.'))
  for (const phase of state.phases) {
    const row = element('div', 'phase-row')
    row.append(statusDot(phase.status), element('strong', undefined, phase.title), element('span', 'muted', `${phase.agentCount} agents`))
    phases.append(row)
  }
  const agents = element('section', 'panel')
  agents.append(element('h3', undefined, 'Logical agents'))
  if (state.agents.length === 0) agents.append(element('p', 'empty-copy', 'Waiting for agent admission.'))
  for (const agent of state.agents) {
    const row = element('div', 'agent-row')
    const copy = element('div')
    copy.append(element('strong', undefined, agent.label || agent.id), element('span', 'muted block', `${agent.attemptCount} attempt${agent.attemptCount === 1 ? '' : 's'}${agent.reused ? ' · reused' : ''}`))
    row.append(statusDot(agent.status), copy, statusBadge(agent.status))
    agents.append(row)
  }
  const warnings = element('section', 'panel')
  warnings.append(element('h3', undefined, 'Warnings & recovery'))
  const recovery = run.resumedFromRunId === undefined ? 'Original lineage run' : `Resumed from ${shortId(run.resumedFromRunId)}`
  warnings.append(element('p', 'muted', recovery))
  for (const warning of state.warnings) warnings.append(element('p', 'warning-copy', warning.message))
  if (state.warnings.length === 0) warnings.append(element('p', 'empty-copy', 'No projected warnings.'))
  summary.replaceChildren(heading, metrics, phases, agents, warnings)
}

function showDetailConnectionStatus(detail: HTMLElement, message: string): void {
  let connection = detail.querySelector<HTMLElement>('[data-role="detail-connection"]')
  if (connection === null) {
    connection = element('p', 'form-error')
    connection.dataset.role = 'detail-connection'
    detail.prepend(connection)
  }
  // Keep the last durable summary and any operator-selected evidence page in place while the
  // connection is disposable. A successful snapshot hides this banner without rebuilding either.
  connection.hidden = false
  connection.textContent = message
}

async function appendEvidenceReaders(run: RunSummary, detail: HTMLElement, signal?: AbortSignal): Promise<void> {
  if (client === undefined || signal === undefined) return
  const evidenceClient = client
  const runId = run.runId
  let panel = detail.querySelector<HTMLElement>('[data-role="evidence-panel"]')
  if (panel === null) {
    panel = element('section', 'panel evidence-panel')
    panel.dataset.role = 'evidence-panel'
    panel.append(element('h3', undefined, 'Results & transcripts'))
    const status = element('p', 'loading', 'Loading agent evidence index…')
    status.dataset.role = 'evidence-index-status'
    panel.append(status)
    detail.append(panel)
  }
  reconcileWorkflowResult(run, panel, evidenceClient, signal)
  const existing = evidenceReconcileStates.get(detail)
  const state = existing ?? { latest: run, running: false }
  state.latest = run
  evidenceReconcileStates.set(detail, state)
  if (state.running) return
  state.running = true
  let retryMs = 500
  try {
    while (!signal.aborted && panel.isConnected && selectedRunId === runId) {
      const target = state.latest
      let listing: Awaited<ReturnType<StandaloneApiClient['agents']>>
      try {
        listing = await evidenceClient.agents(runId, signal)
        retryMs = 500
      } catch (error) {
        if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) return
        const status = panel.querySelector<HTMLElement>('[data-role="evidence-index-status"]')
        if (status !== null) {
          status.className = 'form-error'
          status.textContent = isRetryableBrowserError(error)
            ? `Evidence index interrupted: ${describeError(error)} · retrying in ${Math.ceil(retryMs / 1_000)}s`
            : describeError(error)
        }
        if (!isRetryableBrowserError(error)) return
        await waitForBrowserRetry(retryMs, signal)
        retryMs = Math.min(8_000, retryMs * 2)
        continue
      }
      if (!panel.isConnected || selectedRunId !== runId) return
      reconcileAgentReaders(listing, panel, evidenceClient, signal)
      const status = panel.querySelector<HTMLElement>('[data-role="evidence-index-status"]')
      if (status !== null) {
        status.className = listing.agents.length === 0 && target.result === undefined ? 'empty-copy' : 'page-status'
        status.textContent = listing.agents.length === 0 && target.result === undefined
          ? 'No readable result or transcript has been recorded.'
          : `Evidence index current at cursor ${listing.cursor}`
      }
      if (state.latest.cursor === target.cursor) break
      // A live projection arrived while `/agents` was in flight. Serialize one catch-up request
      // rather than overlapping index calls; stable keyed nodes below preserve reader state.
    }
  } finally {
    state.running = false
  }
}

function reconcileWorkflowResult(
  run: RunSummary,
  panel: HTMLElement,
  client: StandaloneApiClient,
  signal: AbortSignal,
): void {
  if (run.result === undefined) return
  const key = `workflow:${run.result.artifactId}`
  if (evidenceNode(panel, key) !== undefined) return
  const artifactId = run.result.artifactId
  const wrapper = element('div')
  wrapper.dataset.evidenceKey = key
  wrapper.append(resultReader('Workflow result', async cursor => {
    const page = await client.result(run.runId, artifactId, cursor, signal)
    return {
      content: page.content,
      hasMore: page.hasMore,
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    }
  }))
  const status = panel.querySelector<HTMLElement>('[data-role="evidence-index-status"]')
  panel.insertBefore(wrapper, status)
}

function reconcileAgentReaders(
  listing: Awaited<ReturnType<StandaloneApiClient['agents']>>,
  panel: HTMLElement,
  client: StandaloneApiClient,
  signal: AbortSignal,
): void {
  for (const agent of listing.agents) {
    const key = `agent:${agent.agentId}`
    let group = evidenceNode(panel, key) as HTMLDetailsElement | undefined
    if (group === undefined) {
      group = document.createElement('details')
      group.className = 'evidence-group'
      group.dataset.evidenceKey = key
      const summary = document.createElement('summary')
      summary.dataset.role = 'agent-evidence-summary'
      group.append(summary, transcriptReader(client, listing.runId, agent.agentId, signal))
      panel.append(group)
    }
    const summary = group.querySelector<HTMLElement>('[data-role="agent-evidence-summary"]')!
    summary.textContent = `${agent.label || agent.agentId} · ${agent.status} · ${agent.attempts.length} attempt${agent.attempts.length === 1 ? '' : 's'}`
    if (agent.result.available && group.querySelector('[data-role="agent-result-reader"]') === null) {
      const result = element('div')
      result.dataset.role = 'agent-result-reader'
      const artifactId = agent.result.artifactId
      result.append(resultReader('Agent result', async cursor => {
        const page = await client.agentResult(listing.runId, agent.agentId, {
          ...(artifactId === undefined ? {} : { artifactId }),
          ...(cursor === undefined ? {} : { cursor }),
        }, signal)
        return {
          content: page.content,
          hasMore: page.hasMore,
          ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
        }
      }))
      // Result precedes transcript visually, but inserting a sibling never replaces either reader.
      group.insertBefore(result, group.children[1] ?? null)
    }
  }
}

function evidenceNode(parent: HTMLElement, key: string): HTMLElement | undefined {
  return [...parent.querySelectorAll<HTMLElement>('[data-evidence-key]')]
    .find(node => node.dataset.evidenceKey === key)
}

function resultReader(
  label: string,
  load: (cursor?: string) => Promise<{ content: string; hasMore: boolean; nextCursor?: string }>,
): HTMLElement {
  return pagedEvidenceReader<string>(label, undefined, load)
}

function transcriptReader(client: StandaloneApiClient, runId: string, agentId: string, signal: AbortSignal): HTMLElement {
  return pagedEvidenceReader<number>('Transcript', 0, async after => {
    const page = await client.agentTranscript(runId, agentId, after ?? 0, signal)
    const content = page.events.map(stored => JSON.stringify(stored.event)).join('\n')
    return {
      content: content.length === 0 ? '(no transcript events on this page)' : content,
      hasMore: page.hasMore,
      ...(page.hasMore && page.toCursor > (after ?? 0) ? { nextCursor: page.toCursor } : {}),
    }
  })
}

function pagedEvidenceReader<T extends string | number>(
  label: string,
  firstCursor: T | undefined,
  load: (cursor: T | undefined) => Promise<{ content: string; hasMore: boolean; nextCursor?: T }>,
): HTMLElement {
  const reader = element('div', 'evidence-reader')
  const controls = element('div', 'pagination-controls')
  const loadButton = controlButton(`Load ${label.toLowerCase()}`)
  const firstButton = controlButton('First', true)
  const previousButton = controlButton('Previous', true)
  const nextButton = controlButton('Next', true)
  const status = element('span', 'page-status', 'Not loaded')
  const output = document.createElement('pre')
  output.className = 'evidence-output'
  let trail: T[] = []
  let pageOrdinal = 1
  let nextCursor: T | undefined
  let loaded = false

  const synchronizeControls = (busy = false): void => {
    loadButton.disabled = busy
    firstButton.disabled = busy || !loaded || pageOrdinal === 1
    previousButton.disabled = busy || !loaded || !canNavigatePrevious(pageOrdinal, trail.length)
    nextButton.disabled = busy || !loaded || nextCursor === undefined
    loadButton.textContent = loaded ? `Reload ${label.toLowerCase()} page` : `Load ${label.toLowerCase()}`
  }
  const showCurrentPage = async (): Promise<void> => {
    synchronizeControls(true)
    status.textContent = `Loading page ${pageOrdinal}…`
    try {
      const cursor = trail.length === 0 ? firstCursor : trail.at(-1)!
      const page = await load(cursor)
      // WHY: replacing text is the browser-side memory boundary. Appending looks convenient, but a
      // complete multi-gigabyte artifact/transcript would otherwise leave every previous page in the
      // DOM forever even though the HTTP API itself is bounded. Cursor-only history preserves useful
      // navigation while the one current response becomes collectible after this assignment.
      output.textContent = page.content
      output.scrollTop = 0
      loaded = true
      nextCursor = page.hasMore ? page.nextCursor : undefined
      status.textContent = `Page ${pageOrdinal} · ${page.hasMore ? 'more available' : 'complete'}`
    } catch (error) {
      output.textContent = describeError(error)
      output.scrollTop = 0
      loaded = true
      nextCursor = undefined
      status.textContent = `Page ${pageOrdinal} unavailable`
    } finally {
      synchronizeControls()
    }
  }
  loadButton.addEventListener('click', () => { void showCurrentPage() })
  firstButton.addEventListener('click', () => {
    trail = []
    pageOrdinal = 1
    nextCursor = undefined
    void showCurrentPage()
  })
  previousButton.addEventListener('click', () => {
    if (!canNavigatePrevious(pageOrdinal, trail.length)) return
    trail = trail.slice(0, -1)
    pageOrdinal = Math.max(1, pageOrdinal - 1)
    nextCursor = undefined
    void showCurrentPage()
  })
  nextButton.addEventListener('click', () => {
    if (nextCursor === undefined) return
    trail = appendCursor(trail, nextCursor)
    pageOrdinal += 1
    nextCursor = undefined
    void showCurrentPage()
  })
  controls.append(loadButton, firstButton, previousButton, nextButton, status)
  reader.append(controls, output)
  return reader
}

function paginationControls(options: {
  pageOrdinal: number
  canPrevious: boolean
  canNext: boolean
  onFirst(): void
  onPrevious(): void
  onNext(): void
}): HTMLElement {
  const controls = element('div', 'pagination-controls run-pagination')
  const first = controlButton('First', options.pageOrdinal === 1)
  const previous = controlButton('Previous', !options.canPrevious)
  const next = controlButton('Next', !options.canNext)
  first.addEventListener('click', options.onFirst)
  previous.addEventListener('click', options.onPrevious)
  next.addEventListener('click', options.onNext)
  controls.append(first, previous, next, element('span', 'page-status', `Page ${options.pageOrdinal}`))
  return controls
}

function controlButton(label: string, disabled = false): HTMLButtonElement {
  const button = element('button', 'ghost-button', label) as HTMLButtonElement
  button.type = 'button'
  button.disabled = disabled
  return button
}

function appendCursor<T extends string | number>(trail: readonly T[], cursor: T): T[] {
  // Cursor histories are intentionally fixed-size in both inventory and evidence readers. An
  // explicit First button remains truthful after the oldest previous-page cursor is discarded.
  return [...trail, cursor].slice(-CURSOR_HISTORY_LIMIT)
}

function canNavigatePrevious(pageOrdinal: number, trailLength: number): boolean {
  return trailLength > 1 || (trailLength === 1 && pageOrdinal === trailLength + 1)
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

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h`
  return `${Math.floor(seconds / 86_400)}d`
}

function isTerminal(status: string): boolean {
  return ['completed', 'completed_with_errors', 'failed', 'cancelled', 'interrupted'].includes(status)
}

function settledAgentCount(counts: PublicRunState['counts']): number {
  return counts.completed + counts.failed + counts.cancelled + counts.skipped + counts.recovery_required
}

function isRetryableBrowserError(error: unknown): boolean {
  // A 502 normally represents a disposable upstream failure, but incompatible-schema is generated
  // locally after a successful response. Retrying the same stale JavaScript forever cannot repair
  // that contract; the visible reload/upgrade instruction must remain the terminal diagnosis.
  return error instanceof StandaloneTransportError || (
    error instanceof StandaloneApiError && error.code !== 'incompatible-schema' &&
    (error.status >= 500 || error.status === 408 || error.status === 429)
  )
}

function waitForBrowserRetry(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const timer = window.setTimeout(finish, milliseconds)
    function finish(): void {
      window.clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    signal.addEventListener('abort', finish, { once: true })
  })
}

function describeError(error: unknown): string {
  if (error instanceof StandaloneApiError && error.status === 401) return 'That token was not accepted.'
  if (error instanceof Error && error.name === 'AbortError') return 'Request cancelled.'
  return error instanceof Error ? error.message : String(error)
}
