import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, render, useApp, useInput, useStdout } from 'ink'

import {
  StandaloneApiClient,
  type InstanceSummary,
  type PublicRunState,
  type RunSummary,
} from '../client/apiClient.js'
import { activityGlyph as activityKindGlyph, type AgentDetailContent } from '../client/agentActivities.js'
import { followAgentActivity, followRun } from '../client/liveWorkflow.js'

/*
 * Ink (React) terminal UI. Mostly white/gray with a restrained agent-code accent: the palette is
 * white (primary), a lighter white for secondary, gray borders/dim, and the agent-code default green
 * (#7dd3a0) for brand, selection, section titles and keybinds — plus Tokyo Night status hues so an
 * agent's state reads at a glance. Ink renders hex via chalk, so these are the same values the web
 * dashboard uses; we keep them sparse so the UI stays legible, not a color salad. Bordered boxes
 * separate every region — header, runs list, agent list, and (inside a focused agent) the Prompt,
 * Activity and Result each get their own border. Three focus levels: runs list -> agent list ->
 * focused agent (Enter descends, Esc/Left ascends; j/k acts on the focused level, scrolling the
 * focused agent's Result/Activity panel).
 *
 * Re-renders happen ONLY when the fetched data actually changes (signature compare), so a static or
 * completed run does not repaint on every poll tick — that repaint was the full-screen black flash.
 */

const C = {
  bright: 'whiteBright' as const, // primary text + emphasis (with bold)
  text: 'white' as const,         // secondary text (still light, not dark gray)
  border: 'gray' as const,        // box borders + the footer hint only
  accent: '#7dd3a0' as const,     // agent-code default green — brand, selection, titles, keybinds
  running: '#7dd3a0' as const,    // in-flight agent
  success: '#9ece6a' as const,    // completed (Tokyo Night green)
  danger: '#f7768e' as const,     // failed (Tokyo Night red)
  warning: '#e0af68' as const,    // queued / skipped (Tokyo Night yellow)
}

// The status hue for an agent/run — mirrors the web dashboard's status classes so both UIs read the
// same. Anything not clearly in-flight/done/failed falls back to plain text (no invented color).
function statusColor(status: string): string {
  if (status === 'failed') return C.danger
  if (status === 'completed') return C.success
  if (status === 'running' || status === 'queued') return C.running
  if (status === 'skipped') return C.warning
  return C.text
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

function truncate(value: string, width: number): string {
  if (width <= 1) return ''
  return value.length <= width ? value : `${value.slice(0, width - 1)}…`
}

// Wrap plain text (respecting existing newlines) to a column width, for the scrollable agent pane.
function wrapText(text: string, width: number): string[] {
  const out: string[] = []
  for (const raw of text.replace(/\t/g, '  ').split('\n')) {
    if (raw.length === 0) { out.push(''); continue }
    for (let index = 0; index < raw.length; index += width) out.push(raw.slice(index, index + width))
  }
  return out
}


type RunDetail = { run: RunSummary; state: PublicRunState }
// Focus levels, each shown by an accent border on the active region so "where am I" is always visible:
//   list   -> runs list box is accent
//   detail -> agent list box is accent
//   agent  -> a focused agent; one of its Prompt/Activity/Result panels is accent (panelCursor)
//   full   -> that one panel fills the detail area and scrolls (Enter zooms in, Esc zooms out)
type Focus = 'list' | 'detail' | 'agent' | 'full'

type PanelKey = 'prompt' | 'activity' | 'result' | 'error'

// The panels present for an agent, in fixed top-to-bottom order. panelCursor indexes into THIS list,
// so both the App (cursor bounds, which panel to fullscreen) and AgentFocus (which border is accent)
// agree on ordering. 'error' replaces 'result' when the agent failed.
function presentPanels(content: AgentDetailContent | undefined): PanelKey[] {
  if (content === undefined) return []
  const keys: PanelKey[] = []
  if (content.prompt !== undefined) keys.push('prompt')
  if (content.activities.length > 0) keys.push('activity')
  if (content.error !== undefined) keys.push('error')
  else if (content.result !== undefined) keys.push('result')
  return keys
}

// Title + wrapped lines + accent for one panel. Shared by the inline AgentFocus previews and the
// fullscreen view so both render identical content from the identical reducer output.
function panelData(key: PanelKey, content: AgentDetailContent, width: number): { title: string; lines: string[]; accent: string } {
  if (key === 'prompt') return { title: 'PROMPT', lines: wrapText(content.prompt ?? '', width), accent: C.accent }
  if (key === 'activity') return {
    title: 'ACTIVITY',
    // Only the START of each tool call (glyph + kind + one-line summary), matching the web view.
    lines: content.activities.map(a => truncate(`${activityKindGlyph(a)} ${a.kind}  ${a.summary}`, width)),
    accent: C.accent,
  }
  if (key === 'error') return { title: 'ERROR', lines: wrapText(content.error ?? '', width), accent: C.danger }
  return { title: 'RESULT', lines: wrapText(content.result ?? '', width), accent: C.accent }
}

function App({ client }: { client: StandaloneApiClient }): React.JSX.Element {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const [rows, setRows] = useState(stdout.rows ?? 24)
  const [cols, setCols] = useState(stdout.columns ?? 80)
  useEffect(() => {
    const onResize = (): void => { setRows(stdout.rows ?? 24); setCols(stdout.columns ?? 80) }
    stdout.on('resize', onResize)
    return () => { stdout.off('resize', onResize) }
  }, [stdout])

  const [instance, setInstance] = useState<InstanceSummary | undefined>(undefined)
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [selected, setSelected] = useState(0)
  const [focus, setFocus] = useState<Focus>('list')
  const [detail, setDetail] = useState<RunDetail | undefined>(undefined)
  const [agentCursor, setAgentCursor] = useState(0)
  const [panelCursor, setPanelCursor] = useState(0) // which panel (prompt/activity/result) is focused
  const [agentScroll, setAgentScroll] = useState(0) // scroll offset inside the fullscreen panel
  const [agentContent, setAgentContent] = useState<Record<string, AgentDetailContent>>({})
  const [quitArmed, setQuitArmed] = useState(false)

  // Require a second `q` to quit so a stray keypress cannot drop the operator out of the UI. The
  // armed state auto-clears so a forgotten first `q` never leaves a live trap.
  useEffect(() => {
    if (!quitArmed) return
    const timer = setTimeout(() => setQuitArmed(false), 2_500)
    return () => clearTimeout(timer)
  }, [quitArmed])

  // Signatures gate re-render: only push state when the meaningful data changed, so poll ticks that
  // return identical data (a completed run) never repaint — this removes the full-screen flash.
  const runsSig = useRef('')
  const instanceSig = useRef('')
  const detailSig = useRef('')

  useEffect(() => {
    let alive = true
    const loadTop = async (): Promise<void> => {
      try {
        const [inst, page] = await Promise.all([client.instance(), client.runs({ limit: 100 })])
        if (!alive) return
        const iSig = `${inst.version}|${inst.lifecycle}|${inst.sourceMode}|${inst.runtime.authentication.status}|${inst.runtime.providerCapacity}`
        if (iSig !== instanceSig.current) { instanceSig.current = iSig; setInstance(inst) }
        else if (instance === undefined) setInstance(inst)
        const rSig = page.items.map(r => `${r.runId}:${r.status}:${r.updatedAt}`).join(',')
        if (rSig !== runsSig.current) { runsSig.current = rSig; setRuns(page.items) }
      } catch { /* header shows nothing new; keep last */ }
    }
    void loadTop()
    const timer = setInterval(() => void loadTop(), 3_000)
    return () => { alive = false; clearInterval(timer) }
  }, [client, instance])

  const selectedRun = runs[selected]
  const selectedRunId = selectedRun?.runId

  // Live-follow the selected run instead of polling on a timer: followRun long-polls the event feed
  // (server blocks up to 25s) and refetches the authoritative snapshot on every cursor advance, then
  // self-stops once the run is terminal. detailSig still gates re-render so identical snapshots never
  // repaint (anti-flicker). Reset the signature on run-change so the new run's first snapshot applies.
  useEffect(() => {
    detailSig.current = ''
    if (selectedRunId === undefined) { setDetail(undefined); return }
    return followRun(client, selectedRunId, {
      onSnapshot: snapshot => {
        const s = snapshot.state
        const dSig = `${s.runId}:${s.sequence}:${s.status}:${s.agents.map(a => `${a.id}${a.status}`).join('')}`
        if (dSig !== detailSig.current) { detailSig.current = dSig; setDetail({ run: snapshot.run, state: snapshot.state }) }
      },
    })
  }, [client, selectedRunId])

  useEffect(() => { setAgentCursor(0); setAgentScroll(0); setAgentContent({}) }, [selectedRunId])

  const agents = detail?.state.agents ?? []
  const focusedAgent = (focus === 'agent' || focus === 'full') ? agents[agentCursor] : undefined
  const focusedContent = focusedAgent === undefined ? undefined : agentContent[focusedAgent.id]
  const focusedPanels = presentPanels(focusedContent)
  // Clamp the panel cursor into range as the transcript loads (present panels appear over time).
  const panelIndex = Math.min(panelCursor, Math.max(0, focusedPanels.length - 1))

  // Live-follow the focused agent's transcript: new tool calls, the streaming result, and the
  // running->completed flip appear WITHOUT re-expanding — the old code fetched once on expand and
  // cached forever, which is exactly why a running agent looked frozen. The follower self-terminates
  // once the agent is done; the effect cleanup stops it on collapse (focus leaves the agent) and on
  // run-change (focusedAgentId/run become undefined). agentContent is keyed by agent id so each
  // agent keeps its own live-reduced content.
  const focusedAgentId = focusedAgent?.id
  const followRunId = detail?.run.runId
  useEffect(() => {
    if (followRunId === undefined || focusedAgentId === undefined) return
    return followAgentActivity(client, followRunId, focusedAgentId, {
      onUpdate: content => setAgentContent(prev => ({ ...prev, [focusedAgentId]: content })),
    })
  }, [client, followRunId, focusedAgentId])

  useInput((input, key) => {
    if (key.ctrl && input === 'c') { exit(); return }
    if (input === 'q') { if (quitArmed) exit(); else setQuitArmed(true); return }
    if (quitArmed) setQuitArmed(false) // any other key cancels a pending quit

    if (focus === 'list') {
      if (key.upArrow || input === 'k') setSelected(v => Math.max(0, v - 1))
      else if (key.downArrow || input === 'j') setSelected(v => Math.min(Math.max(0, runs.length - 1), v + 1))
      else if (key.return || key.rightArrow) { if (detail !== undefined) { setFocus('detail'); setAgentCursor(0) } }
      return
    }

    if (focus === 'detail') {
      if (key.escape || key.leftArrow || input === 'h') { setFocus('list'); return }
      if (key.upArrow || input === 'k') setAgentCursor(v => Math.max(0, v - 1))
      else if (key.downArrow || input === 'j') setAgentCursor(v => Math.min(Math.max(0, agents.length - 1), v + 1))
      else if (key.return || key.rightArrow) {
        const agent = agents[agentCursor]
        if (agent === undefined) return
        // Just enter the agent; the focused-agent live-follow effect fetches and keeps its transcript
        // current (see followAgentActivity above). No once-on-expand fetch — that was the freeze bug.
        setFocus('agent')
        setPanelCursor(0)
        setAgentScroll(0)
      }
      return
    }

    if (focus === 'agent') {
      // Navigate BETWEEN the Prompt/Activity/Result panels; the focused one gets the accent border.
      // Enter zooms it fullscreen (that's where scrolling happens); esc/left returns to the agent list.
      if (key.escape || key.leftArrow || input === 'h') { setFocus('detail'); return }
      if (key.upArrow || input === 'k') setPanelCursor(v => Math.max(0, v - 1))
      else if (key.downArrow || input === 'j') setPanelCursor(v => Math.min(Math.max(0, focusedPanels.length - 1), v + 1))
      else if (key.return || key.rightArrow) { if (focusedPanels.length > 0) { setFocus('full'); setAgentScroll(0) } }
      return
    }

    // focus === 'full' — the focused panel fills the pane; j/k scroll, esc/left zoom back out.
    if (key.escape || key.leftArrow || input === 'h') { setFocus('agent'); setAgentScroll(0); return }
    if (key.upArrow || input === 'k') setAgentScroll(v => Math.max(0, v - 1))
    else if (key.downArrow || input === 'j') setAgentScroll(v => v + 1)
    else if (input === ' ') setAgentScroll(v => v + 10)
  })

  const listWidth = Math.min(38, Math.max(24, Math.floor(cols * 0.30)))
  // WHY rows-1: Ink flickers/full-clears when the rendered height is EXACTLY stdout.rows
  // (vadimdemedes/ink#450); rendering one row short makes it use incremental line updates instead.
  const appHeight = Math.max(6, rows - 1)
  const bodyHeight = Math.max(3, appHeight - 5) // header box (4) + footer (1)
  const paneInnerHeight = Math.max(1, bodyHeight - 2) // inside the detail border

  return (
    <Box flexDirection="column" width={cols} height={appHeight}>
      <Header instance={instance} />
      <Box flexGrow={1} minHeight={0}>
        <RunsList runs={runs} selected={selected} focus={focus} width={listWidth} height={bodyHeight} />
        <Box borderStyle="single" borderColor={focus === 'detail' ? C.accent : C.border} flexGrow={1} flexDirection="column" paddingX={1} overflow="hidden">
          {detail === undefined ? (
            <Text color={C.text}>Select a run and press Enter.</Text>
          ) : focus === 'full' && focusedAgent !== undefined && focusedContent !== undefined ? (
            <FullPanel content={focusedContent} panelKey={focusedPanels[panelIndex] ?? 'result'} scroll={agentScroll} height={paneInnerHeight} width={Math.max(20, cols - listWidth - 4)} />
          ) : (focus === 'agent' || focus === 'full') && focusedAgent !== undefined ? (
            <AgentFocus agent={focusedAgent} content={focusedContent} focusedPanel={panelIndex} height={paneInnerHeight} width={Math.max(20, cols - listWidth - 4)} />
          ) : (
            <AgentList detail={detail} agentCursor={agentCursor} active={focus === 'detail'} height={paneInnerHeight} width={Math.max(20, cols - listWidth - 4)} />
          )}
        </Box>
      </Box>
      <Footer focus={focus} quitArmed={quitArmed} />
    </Box>
  )
}

function Header({ instance }: { instance?: InstanceSummary | undefined }): React.JSX.Element {
  return (
    <Box borderStyle="single" borderColor={C.border} paddingX={1} flexDirection="column">
      {instance === undefined ? (
        <Text color={C.text}>Workflow MCP · connecting…</Text>
      ) : (
        <>
          <Box>
            <Text color={C.accent} bold>Workflow MCP </Text>
            <Text color={C.text}>{instance.version} · </Text>
            <Text color={C.bright} bold>{instance.lifecycle}</Text>
            <Text color={C.text}> · {instance.sourceMode}</Text>
          </Box>
          <Text color={C.text}>
            {instance.runtime.workspace} · {instance.runtime.mountMode} · auth {instance.runtime.authentication.status} · cap {instance.runtime.providerCapacity} · up {formatUptime(instance.runtime.uptimeSeconds)}
          </Text>
        </>
      )}
    </Box>
  )
}

function RunsList({
  runs, selected, focus, width, height,
}: { runs: RunSummary[]; selected: number; focus: Focus; width: number; height: number }): React.JSX.Element {
  const inner = Math.max(1, height - 2)
  const perRow = 2
  const capacity = Math.max(1, Math.floor(inner / perRow))
  const start = Math.min(Math.max(0, selected - Math.floor(capacity / 2)), Math.max(0, runs.length - capacity))
  const visible = runs.slice(start, start + capacity)
  return (
    <Box borderStyle="single" borderColor={focus === 'list' ? C.accent : C.border} width={width} flexDirection="column" paddingX={1} overflow="hidden">
      <Text color={focus === 'list' ? C.accent : C.bright} bold>RUNS{runs.length > 0 ? ` · ${runs.length}` : ''}</Text>
      {runs.length === 0 ? <Text color={C.text}>No durable runs.</Text> : visible.map((run, index) => {
        const isSelected = start + index === selected
        return (
          <Box key={run.runId} flexDirection="column">
            <Box>
              <Text color={C.accent} bold>{isSelected ? '❯' : ' '} </Text>
              <Text color={isSelected ? C.accent : C.bright} bold={isSelected} underline={isSelected}>{truncate(run.workflow.title ?? run.workflow.name, width - 5)}</Text>
            </Box>
            <Box>
              <Text color={statusColor(run.status)}>  {run.status.replace(/_/g, ' ')}</Text>
              <Text color={C.text}> · {relativeTime(run.updatedAt)}</Text>
            </Box>
          </Box>
        )
      })}
    </Box>
  )
}

function AgentList({
  detail, agentCursor, active, height, width,
}: { detail: RunDetail; agentCursor: number; active: boolean; height: number; width: number }): React.JSX.Element {
  const state = detail.state
  const workflow = state.workflow ?? detail.run.workflow
  const counts = state.counts
  const byPhase = useMemo(() => {
    const map = new Map<string, PublicRunState['agents']>()
    for (const phase of state.phases) map.set(phase.id, [])
    map.set('__unassigned__', [])
    for (const agent of state.agents) {
      const key = agent.phaseId !== undefined && map.has(agent.phaseId) ? agent.phaseId : '__unassigned__'
      map.get(key)!.push(agent)
    }
    return map
  }, [state.agents, state.phases])
  const blocks = [
    ...state.phases.map(p => ({ id: p.id, title: p.title, agents: byPhase.get(p.id) ?? [] })),
    { id: '__unassigned__', title: 'Agents', agents: byPhase.get('__unassigned__') ?? [] },
  ].filter(b => b.agents.length > 0)

  const summary = [`${counts.completed}/${counts.total} agents`]
  if (counts.running > 0) summary.push(`${counts.running} running`)
  if (counts.failed > 0) summary.push(`${counts.failed} failed`)
  if (counts.reused > 0) summary.push(`${counts.reused} cached`)

  let flat = -1
  return (
    <Box flexDirection="column" height={height} overflow="hidden">
      <Box>
        <Text color={C.bright} bold>{truncate(workflow.title ?? workflow.name, width - 14)} </Text>
        <Text color={C.text}>{state.status.replace(/_/g, ' ')}</Text>
      </Box>
      <Text color={C.text}>{summary.join(' · ')}</Text>
      <Text> </Text>
      {blocks.map(block => (
        <Box key={block.id} flexDirection="column">
          <Text color={C.bright} bold>{block.title}</Text>
          {block.agents.map(agent => {
            flat += 1
            const highlighted = active && flat === agentCursor
            return (
              <Box key={agent.id}>
                <Text color={C.accent} bold>{highlighted ? '❯' : ' '} </Text>
                <Text color={statusColor(agent.status)}>{agentGlyph(agent.status)} </Text>
                <Text color={highlighted ? C.accent : C.bright} bold={highlighted} underline={highlighted}>{truncate(agent.label || agent.id, width - 20)}</Text>
                <Text color={statusColor(agent.status)}> {agent.status.replace(/_/g, ' ')}</Text>
              </Box>
            )
          })}
        </Box>
      ))}
      <Text> </Text>
      <Text color={C.border}>{active ? 'Enter: open agent · ←: runs' : '→ or Enter to browse agents'}</Text>
    </Box>
  )
}

// One bordered section (Prompt / Activity / Result). It shows `contentHeight` lines starting at
// `scroll`; the title carries a "↑…↓ N" hint when there is more above/below so a clipped or scrolled
// panel never looks complete. When `focused`, the border turns accent and (if given) `hint` — e.g.
// "↵ fullscreen" — is shown inside the border so the affordance lives where the eye already is.
function Panel({
  title, lines, contentHeight, scroll = 0, width, accent = C.accent, focused = false, hint,
}: {
  title: string; lines: string[]; contentHeight: number; scroll?: number; width: number
  accent?: string | undefined; focused?: boolean; hint?: string | undefined
}): React.JSX.Element {
  const h = Math.max(1, contentHeight)
  const maxScroll = Math.max(0, lines.length - h)
  const start = Math.min(Math.max(0, scroll), maxScroll)
  const window = lines.slice(start, start + h)
  const more = (start > 0 ? '↑' : '') + (start + window.length < lines.length ? '↓' : '')
  return (
    <Box borderStyle="single" borderColor={focused ? accent : C.border} flexDirection="column" paddingX={1} overflow="hidden">
      <Box>
        <Text color={accent} bold>{title}</Text>
        {more.length > 0 ? <Text color={C.border}>  {more} {lines.length}</Text> : null}
        {focused && hint !== undefined ? <Text color={accent} bold>   {hint}</Text> : null}
      </Box>
      {window.map((line, index) => (
        <Text key={start + index} color={C.text}>{line.length === 0 ? ' ' : truncate(line, width)}</Text>
      ))}
    </Box>
  )
}

// Focused agent: the header line plus Prompt / Activity / Result, EACH in its own bordered Panel.
// panelCursor (focusedPanel) picks one — it gets the accent border + an "↵ fullscreen" affordance —
// and every non-tail panel is a capped PREVIEW; you press Enter to fullscreen the focused one to read
// it whole and scroll. The last panel absorbs the remaining height so nothing is left dangling.
function AgentFocus({
  agent, content, focusedPanel, height, width,
}: { agent: PublicRunState['agents'][number]; content?: AgentDetailContent | undefined; focusedPanel: number; height: number; width: number }): React.JSX.Element {
  const innerW = Math.max(10, width - 4) // panel border (2) + paddingX (2)
  const header = (
    <Box>
      <Text color={statusColor(agent.status)} bold>{agentGlyph(agent.status)} </Text>
      <Text color={C.bright} bold>{truncate(agent.label || agent.id, width - 18)}</Text>
      <Text color={statusColor(agent.status)}> {agent.status.replace(/_/g, ' ')}</Text>
    </Box>
  )
  if (content === undefined) {
    return (
      <Box flexDirection="column" height={height} overflow="hidden">
        {header}
        <Box borderStyle="single" borderColor={C.border} paddingX={1}><Text color={C.text}>Loading transcript…</Text></Box>
      </Box>
    )
  }

  const keys = presentPanels(content)
  const focusedKey = keys[focusedPanel]
  const items = keys.map(k => ({ key: k, ...panelData(k, content, innerW) }))

  // Chrome per panel = border(2) + title(1) = 3 rows. Earlier panels are capped previews (≤6 lines);
  // the LAST present panel (Result, or Activity for a still-running agent) takes what's left.
  const avail = Math.max(6, height - 1)
  const heights: number[] = []
  let used = 0
  for (const [index, item] of items.entries()) {
    if (index < items.length - 1) {
      const ch = Math.min(item.lines.length, 6)
      heights.push(ch)
      used += ch + 3
    } else {
      heights.push(Math.max(3, avail - used - 3))
    }
  }

  return (
    <Box flexDirection="column" height={height} overflow="hidden">
      {header}
      {items.map((item, index) => (
        <Panel
          key={item.key}
          title={item.title}
          lines={item.lines}
          contentHeight={heights[index] ?? 3}
          width={innerW}
          accent={item.accent}
          focused={item.key === focusedKey}
          hint="↵ fullscreen"
        />
      ))}
    </Box>
  )
}

// The focused panel zoomed to fill the whole detail pane, scrollable with j/k. Reached with Enter
// from AgentFocus; Esc zooms back out. Same panelData source as the inline preview, so the fullscreen
// view is literally the same content unclipped.
function FullPanel({
  content, panelKey, scroll, height, width,
}: { content: AgentDetailContent; panelKey: PanelKey; scroll: number; height: number; width: number }): React.JSX.Element {
  const innerW = Math.max(10, width - 4)
  const data = panelData(panelKey, content, innerW)
  return (
    <Panel
      title={data.title}
      lines={data.lines}
      contentHeight={Math.max(1, height - 3)}
      scroll={scroll}
      width={innerW}
      accent={data.accent}
      focused
      hint="esc back · j/k scroll"
    />
  )
}

function Footer({ focus, quitArmed }: { focus: Focus; quitArmed: boolean }): React.JSX.Element {
  const hints: Array<[string, string]> = focus === 'list'
    ? [['↑/↓ j/k', 'runs'], ['Enter', 'open run']]
    : focus === 'detail'
      ? [['↑/↓ j/k', 'agents'], ['Enter', 'focus'], ['Esc', 'back']]
      : focus === 'agent'
        ? [['↑/↓ j/k', 'panels'], ['Enter', 'fullscreen'], ['Esc', 'back']]
        : [['↑/↓ j/k', 'scroll'], ['Space', 'page'], ['Esc', 'back']]
  if (quitArmed) {
    return <Box paddingX={1}><Text color={C.warning} bold>Press q again to quit</Text></Box>
  }
  return (
    <Box paddingX={1}>
      {hints.map(([keyName, label]) => (
        <React.Fragment key={keyName}>
          <Text color={C.accent} bold>{keyName}</Text>
          <Text color={C.text}> {label}</Text>
          <Text color={C.border}>   </Text>
        </React.Fragment>
      ))}
      <Text color={C.accent} bold>q</Text>
      <Text color={C.text}> quit</Text>
    </Box>
  )
}

export async function runInkTerminalUi(options: {
  client: StandaloneApiClient
  input?: NodeJS.ReadStream
  output?: NodeJS.WriteStream
}): Promise<void> {
  const output = options.output ?? process.stdout
  const input = options.input ?? process.stdin
  output.write('\u001b[?1049h\u001b[?25l')
  const app = render(<App client={options.client} />, { stdin: input, stdout: output, exitOnCtrlC: false })
  try {
    await app.waitUntilExit()
  } finally {
    output.write('\u001b[?25h\u001b[?1049l')
  }
}
