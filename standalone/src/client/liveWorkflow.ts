/*
 * The live-update engine shared by the Ink terminal and the web dashboard. Both renderers used to be
 * dumb fixed-interval pollers that also fetched a focused agent's transcript exactly ONCE on expand
 * and cached it forever — so a running agent you were watching never showed new tool calls, the
 * streaming result, or the running->completed flip. This wires the primitives that already existed
 * but had zero callers: the cursor-based `events` long-poll (server blocks up to 30s) and the
 * incremental `agentTranscript` pager, folded through `reduceAgentTranscript`.
 *
 * Design (mirrors Agent Code's reference renderer, adapted to HTTP long-poll instead of IPC push):
 *   - Events are WAKE-ONLY signals, never render input. On a wake we refetch the authoritative
 *     snapshot/transcript. That makes reconnect lossless — the durable projection closes any gap
 *     left while the daemon or network was unavailable — and keeps the redacted event feed from
 *     becoming a path oracle. This is exactly what `followProjectedRun` in liveRun.ts assumes.
 *   - `followRun` tracks one selected run's snapshot; `followAgentActivity` tracks one expanded
 *     agent's transcript. Each returns a `stop()` the renderer calls on unmount / run-change /
 *     collapse so nothing leaks.
 */

import {
  StandaloneApiClient,
  StandaloneTransportError,
  type PublicAgentTranscriptPage,
  type PublicRunState,
  type RunSummary,
} from './apiClient.js'
import { reduceAgentTranscript, type AgentDetailContent } from './agentActivities.js'
import { followProjectedRun } from './liveRun.js'

// The single source of truth for "this run/agent will never change again", used to stop the loops.
const TERMINAL_STATUSES = new Set(['completed', 'completed_with_errors', 'failed', 'cancelled', 'interrupted'])
export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status)
}

export type LiveRunSnapshot = { run: RunSummary; state: PublicRunState; cursor: number }

/*
 * Follow one run's authoritative snapshot in real time. `onSnapshot` fires on the initial read and
 * again every time the event cursor advances (a server long-poll wake), then the loop exits once the
 * run reaches a terminal status — a completed run never changes, so we stop polling it entirely.
 * Returns a stop() that aborts the in-flight long-poll immediately.
 */
export function followRun(
  client: StandaloneApiClient,
  runId: string,
  handlers: { onSnapshot: (snapshot: LiveRunSnapshot) => void; onError?: (error: unknown) => void },
): () => void {
  const controller = new AbortController()
  void followProjectedRun<RunSummary, PublicRunState>({
    signal: controller.signal,
    readSnapshot: async signal => {
      const snapshot = await client.run(runId, signal)
      return { run: snapshot.run, state: snapshot.state, cursor: snapshot.cursor }
    },
    // A 25s ceiling stays comfortably under the server's 30s cap; on a real timeout the feed returns
    // the same cursor and followProjectedRun simply re-arms the long-poll — a wake, not a repaint.
    waitForEvents: async (after, signal) => {
      const page = await client.events(runId, after, { waitMs: 25_000 }, signal)
      return page.toCursor
    },
    isTerminal: state => isTerminalStatus(state.status),
    // Only connectivity blips are retryable; a programming/schema defect must surface, not spin.
    shouldRetry: error => error instanceof StandaloneTransportError,
    onSnapshot: handlers.onSnapshot,
    onRetry: error => handlers.onError?.(error),
  }).catch(error => {
    if (!controller.signal.aborted) handlers.onError?.(error)
  })
  return () => controller.abort()
}

/*
 * Follow one agent's transcript in real time. The transcript endpoint has no long-poll (unlike
 * /events), so this pages incrementally from its own cursor on a short interval, re-reducing the
 * accumulated events into the same {prompt, activities, result} shape the panels render. It is
 * self-terminating: once the reduced content carries a terminal result/error the agent is done and
 * nothing more will arrive, so we stop rather than keep polling a finished agent. The renderer also
 * calls stop() when the agent is collapsed or the run changes.
 *
 * WHY re-reduce the full accumulated list each tick instead of folding incrementally: transcripts are
 * bounded and we only ever follow the ONE expanded agent, so a full reduce is cheap and keeps the
 * reducer the single, tested definition of the panel content — no second, drift-prone merge path.
 */
export function followAgentActivity(
  client: StandaloneApiClient,
  runId: string,
  agentId: string,
  handlers: { onUpdate: (content: AgentDetailContent) => void; onError?: (error: unknown) => void },
  options: { intervalMs?: number } = {},
): () => void {
  const controller = new AbortController()
  const intervalMs = options.intervalMs ?? 800
  void (async () => {
    const accumulated: PublicAgentTranscriptPage['events'] = []
    let cursor = 0
    try {
      while (!controller.signal.aborted) {
        // Drain every page currently available from our cursor before re-rendering, so one tick
        // reflects all new events even when they span multiple 200-event pages.
        let advanced = false
        for (;;) {
          const page = await client.agentTranscript(runId, agentId, cursor, controller.signal)
          if (page.events.length > 0) {
            accumulated.push(...page.events)
            advanced = true
          }
          cursor = page.toCursor
          if (!page.hasMore) break
        }
        if (advanced) {
          const content = reduceAgentTranscript(accumulated)
          handlers.onUpdate(content)
          if (content.result !== undefined || content.error !== undefined) return
        }
        await abortableDelay(intervalMs, controller.signal)
      }
    } catch (error) {
      if (!controller.signal.aborted) handlers.onError?.(error)
    }
  })()
  return () => controller.abort()
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(finish, milliseconds)
    function finish(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    signal.addEventListener('abort', finish, { once: true })
  })
}
