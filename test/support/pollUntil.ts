/**
 * Poll `read` until `done` holds.
 *
 * WHY there is no iteration count: the package's tests used
 * `for (index < 100) { ...; sleep 5 }` and then asserted. That is a wall-clock
 * budget, not a condition: under CI's Coverage and Tier jobs the run was still
 * `running` when it ran out, and "honors changed Claude resume args" failed on
 * main (ef995af) and on every PR (workflow-mcp#71). Worse, one such loop in
 * standaloneServer let the test go on to read events without ever having seen
 * the run finish. The condition is what a test is about; the only bound on a
 * real hang is the test's own timeout, which fails loudly by name.
 */
export async function pollUntil<T>(read: () => T | Promise<T>, done: (value: T) => boolean, intervalMs = 5): Promise<T> {
  for (;;) {
    const value = await read()
    if (done(value)) return value
    await new Promise((resolveWait) => setTimeout(resolveWait, intervalMs))
  }
}

/**
 * Every status the service treats as terminal (src/workflowService.ts,
 * TERMINAL_STATUSES). A wait for "the run finished" ends on ANY of them and the
 * test then asserts the one it expects, so an unexpected outcome fails at once,
 * by name, instead of polling a finished run until the test times out (review
 * of #71, c: `completed_with_errors` did exactly that).
 */
export const TERMINAL_RUN_STATUSES: readonly string[] = ['completed', 'completed_with_errors', 'failed', 'cancelled', 'interrupted']

export function isTerminalRunStatus(status: string): boolean {
  return TERMINAL_RUN_STATUSES.includes(status)
}
