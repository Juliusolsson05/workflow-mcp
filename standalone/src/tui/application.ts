import { emitKeypressEvents } from 'node:readline'

import type { WorkflowSnapshot } from 'workflow-mcp/state'

import {
  StandaloneApiClient,
  type InstanceSummary,
  type RunSummary,
} from '../client/apiClient.js'

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

  let selected = 0
  let stopped = false
  let refreshRequested = true
  let controller: AbortController | undefined
  const color = process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb'
  const alternate = process.env.WORKFLOW_MCP_PLAIN_TUI !== 'true'
  const wake = createWakeup()
  const onResize = (): void => { refreshRequested = true; wake.signal() }
  const onKeypress = (_text: string, key: { name?: string; ctrl?: boolean }): void => {
    if ((key.ctrl === true && key.name === 'c') || key.name === 'q') stopped = true
    else if (key.name === 'up' || key.name === 'k') selected = Math.max(0, selected - 1)
    else if (key.name === 'down' || key.name === 'j') selected += 1
    else if (key.name === 'r') refreshRequested = true
    controller?.abort()
    wake.signal()
  }

  emitKeypressEvents(input)
  input.on('keypress', onKeypress)
  output.on('resize', onResize)
  input.setRawMode(true)
  input.resume()
  if (alternate) output.write('\u001b[?1049h')
  output.write('\u001b[?25l')
  try {
    while (!stopped) {
      controller = new AbortController()
      try {
        const [instance, page] = await Promise.all([
          client.instance(controller.signal),
          client.runs({ limit: 50 }, controller.signal),
        ])
        selected = Math.min(selected, Math.max(0, page.items.length - 1))
        const selectedRun = page.items.at(selected)
        const detail = selectedRun === undefined
          ? undefined
          : await client.run(selectedRun.runId, controller.signal).catch(() => undefined)
        drawScreen(output, renderInteractive(instance, page.items, selected, detail?.state, output.columns ?? 100, color))
      } catch (error) {
        if (!(error instanceof Error && error.name === 'AbortError')) {
          drawScreen(output, `Workflow MCP UI\n\nDisconnected: ${error instanceof Error ? error.message : String(error)}\n\n[r]etry  [q]uit`)
        }
      }
      refreshRequested = false
      await Promise.race([delay(2_000), wake.wait()])
      if (refreshRequested) continue
    }
  } finally {
    controller?.abort()
    input.removeListener('keypress', onKeypress)
    output.removeListener('resize', onResize)
    input.setRawMode(false)
    output.write('\u001b[0m\u001b[?25h')
    if (alternate) output.write('\u001b[?1049l')
  }
}

export function renderTuiSnapshot(instance: InstanceSummary, runs: RunSummary[]): string {
  const lines = [
    `Workflow MCP ${instance.version} (${instance.revision.slice(0, 8)})`,
    `Lifecycle: ${instance.lifecycle}  Source: ${instance.sourceMode}  Browser mutations: disabled`,
    '',
  ]
  if (runs.length === 0) lines.push('No durable runs.')
  for (const run of runs) {
    lines.push(`${pad(run.status, 22)} ${run.workflow.title ?? run.workflow.name}  ${run.runId}  cursor=${run.cursor}`)
  }
  return lines.join('\n')
}

function renderInteractive(
  instance: InstanceSummary,
  runs: RunSummary[],
  selected: number,
  state: WorkflowSnapshot | undefined,
  columns: number,
  color: boolean,
): string {
  const width = Math.max(50, columns)
  const paint = (code: number, value: string): string => color ? `\u001b[${code}m${value}\u001b[0m` : value
  const lines = [
    `${paint(1, 'Workflow MCP')} ${paint(90, instance.version)}  ${paint(instance.lifecycle === 'READY' ? 32 : 33, instance.lifecycle)}  ${instance.sourceMode}`,
    paint(90, 'Durable runs · ↑/↓ or j/k select · r refresh · q quit'),
    '─'.repeat(width),
  ]
  if (runs.length === 0) lines.push('', '  No durable runs. Start one from Codex through MCP.')
  for (const [index, run] of runs.entries()) {
    const cursor = index === selected ? paint(36, '›') : ' '
    const status = pad(run.status.replaceAll('_', ' '), 22)
    const name = truncate(run.workflow.title ?? run.workflow.name, Math.max(8, width - 48))
    lines.push(`${cursor} ${paint(statusColor(run.status), status)} ${pad(name, Math.max(8, width - 48))} ${run.runId.slice(0, 18)}`)
  }
  if (state !== undefined) {
    lines.push('─'.repeat(width), paint(1, `Selected: ${state.workflow?.title ?? state.workflow?.name ?? state.runId}`))
    lines.push(`Status ${state.status}  sequence ${state.sequence}  agents ${state.counts.completed + state.counts.failed + state.counts.cancelled + state.counts.skipped + state.counts.recovery_required}/${state.counts.total}  attempts ${state.counts.attempts}`)
    for (const phase of state.phases.slice(0, 8)) {
      lines.push(`  ${pad(phase.status, 10)} ${truncate(phase.title, width - 15)} (${phase.agentIds.length})`)
    }
    for (const warning of state.warnings.slice(-3)) lines.push(paint(33, `  ! ${truncate(warning.message, width - 4)}`))
  }
  return lines.join('\n')
}

function drawScreen(output: NodeJS.WriteStream, screen: string): void {
  output.write(`\u001b[H\u001b[2J${screen}`)
}

function statusColor(status: string): number {
  if (status === 'completed') return 32
  if (status === 'running' || status === 'queued') return 36
  if (status === 'failed' || status === 'cancelled' || status === 'interrupted') return 31
  return 33
}

function pad(value: string, width: number): string {
  return truncate(value, width).padEnd(width)
}

function truncate(value: string, width: number): string {
  return value.length <= width ? value : `${value.slice(0, Math.max(0, width - 1))}…`
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds))
}

function createWakeup(): { signal(): void; wait(): Promise<void> } {
  let resolveWait: (() => void) | undefined
  return {
    signal(): void { resolveWait?.(); resolveWait = undefined },
    wait(): Promise<void> { return new Promise(resolve => { resolveWait = resolve }) },
  }
}
