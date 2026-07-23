import { describe, expect, it } from 'vitest'

import { followProjectedRun } from '../src/client/liveRun.js'

describe('browser live-run follower', () => {
  it('reconstructs from the durable snapshot after a transient disconnect', async () => {
    const controller = new AbortController()
    const snapshots = [
      { run: 'run', state: 'running', cursor: 4 },
      { run: 'run', state: 'completed', cursor: 9 },
    ]
    const rendered: number[] = []
    const retries: number[] = []
    let waits = 0
    await followProjectedRun({
      signal: controller.signal,
      readSnapshot: async () => snapshots.shift()!,
      waitForEvents: async () => {
        waits += 1
        throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } })
      },
      isTerminal: state => state === 'completed',
      shouldRetry: () => true,
      onSnapshot: snapshot => rendered.push(snapshot.cursor),
      onRetry: (_error, delayMs) => retries.push(delayMs),
      wait: async () => undefined,
    })
    expect(waits).toBe(1)
    expect(rendered).toEqual([4, 9])
    expect(retries).toEqual([500])
  })

  it('does not retry permanent API failures', async () => {
    const denied = Object.assign(new Error('denied'), { status: 401 })
    await expect(followProjectedRun({
      signal: new AbortController().signal,
      readSnapshot: async () => { throw denied },
      waitForEvents: async () => 0,
      isTerminal: () => false,
      shouldRetry: error => (error as { status?: number }).status !== 401,
      onSnapshot: () => undefined,
      onRetry: () => undefined,
      wait: async () => undefined,
    })).rejects.toBe(denied)
  })
})
