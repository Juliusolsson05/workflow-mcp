export type ProjectedRunSnapshot<TRun, TState> = {
  run: TRun
  state: TState
  cursor: number
}

export async function followProjectedRun<TRun, TState>(options: {
  signal: AbortSignal
  readSnapshot(signal: AbortSignal): Promise<ProjectedRunSnapshot<TRun, TState>>
  waitForEvents(after: number, signal: AbortSignal): Promise<number>
  isTerminal(state: TState): boolean
  shouldRetry(error: unknown): boolean
  onSnapshot(snapshot: ProjectedRunSnapshot<TRun, TState>): void
  onRetry(error: unknown, delayMs: number): void
  retry?: { minimumMs: number; maximumMs: number }
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>
}): Promise<void> {
  const minimumMs = options.retry?.minimumMs ?? 500
  const maximumMs = options.retry?.maximumMs ?? 8_000
  let retryMs = minimumMs

  while (!options.signal.aborted) {
    try {
      let snapshot = await options.readSnapshot(options.signal)
      retryMs = minimumMs
      while (!options.signal.aborted) {
        options.onSnapshot(snapshot)
        if (options.isTerminal(snapshot.state)) return
        const wakeCursor = await options.waitForEvents(snapshot.cursor, options.signal)
        if (wakeCursor <= snapshot.cursor) continue
        // WHY: browser events are intentionally redacted wakeups, not reducer input. Refetching the
        // authoritative projection also makes reconnect lossless: the durable snapshot closes any
        // gap left while the daemon or network was unavailable.
        snapshot = await options.readSnapshot(options.signal)
      }
    } catch (error) {
      if (options.signal.aborted) return
      if (!options.shouldRetry(error)) throw error
      options.onRetry(error, retryMs)
      await (options.wait ?? waitForAbortableDelay)(retryMs, options.signal)
      retryMs = Math.min(maximumMs, Math.max(minimumMs, retryMs * 2))
    }
  }
}

function waitForAbortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
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
