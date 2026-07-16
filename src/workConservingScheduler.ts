export type SchedulerSnapshot = {
  capacity: number
  active: number
  queued: number
  available: number
}

export type SchedulerLease = {
  release(): void
}

export interface AgentScheduler {
  /** Fairness key lets one shared scheduler rotate among runs instead of draining one burst first. */
  acquire(signal: AbortSignal, fairnessKey?: string): Promise<SchedulerLease>
  snapshot(): SchedulerSnapshot
}

type Waiter = {
  fairnessKey: string
  signal: AbortSignal
  resolve(lease: SchedulerLease): void
  reject(error: unknown): void
  onAbort(): void
}

/**
 * A FIFO, work-conserving provider scheduler.
 *
 * WHY this is a named runtime component rather than an anonymous semaphore in runWorkflow: the
 * concurrency number is an operational promise, not merely an implementation detail. A service
 * must be able to share one scheduler across runs, inspect whether capacity is genuinely full, and
 * distinguish "the queue is empty because workflow JavaScript has not admitted more work" from
 * "runnable work is waiting while a permit is idle". Keeping those counters inside the admission
 * authority makes that distinction testable instead of reconstructing it from event timing.
 */
export class WorkConservingScheduler implements AgentScheduler {
  readonly #capacity: number
  readonly #waiters: Waiter[] = []
  readonly #onStateChange: ((snapshot: SchedulerSnapshot) => void) | undefined
  #active = 0
  #lastGrantedKey: string | undefined

  constructor(capacity: number, onStateChange?: (snapshot: SchedulerSnapshot) => void) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      throw new TypeError('Scheduler capacity must be a positive safe integer')
    }
    this.#capacity = capacity
    this.#onStateChange = onStateChange
  }

  acquire(signal: AbortSignal, fairnessKey = 'default'): Promise<SchedulerLease> {
    if (signal.aborted) return Promise.reject(abortError(signal.reason))
    if (this.#active < this.#capacity && this.#waiters.length === 0) {
      this.#active += 1
      this.#lastGrantedKey = fairnessKey
      this.#changed()
      return Promise.resolve(this.#lease())
    }

    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        fairnessKey,
        signal,
        resolve,
        reject,
        onAbort: () => {
          const index = this.#waiters.indexOf(waiter)
          if (index !== -1) this.#waiters.splice(index, 1)
          reject(abortError(signal.reason))
          this.#changed()
        },
      }
      signal.addEventListener('abort', waiter.onAbort, { once: true })
      this.#waiters.push(waiter)
      this.#changed()
      this.#drain()
    })
  }

  snapshot(): SchedulerSnapshot {
    return {
      capacity: this.#capacity,
      active: this.#active,
      queued: this.#waiters.length,
      available: Math.max(0, this.#capacity - this.#active),
    }
  }

  #lease(): SchedulerLease {
    let released = false
    return {
      release: () => {
        if (released) return
        released = true
        this.#active = Math.max(0, this.#active - 1)
        this.#drain()
        this.#changed()
      },
    }
  }

  #drain(): void {
    while (this.#active < this.#capacity && this.#waiters.length > 0) {
      // WHY this chooses the next *key* in queue order instead of merely the first key different
      // from the previous grant: with A,A,A,B,B,B,C, "different from last" alternates A/B until
      // both bursts drain and never gives C a round-robin turn. Rebuilding the small unique-key
      // ring from live waiters also makes aborted/emptied keys disappear without a second mutable
      // queue whose bookkeeping could drift from the actual waiter authority.
      const keys = [...new Set(this.#waiters.map((candidate) => candidate.fairnessKey))]
      const previousKeyIndex = this.#lastGrantedKey === undefined
        ? -1
        : keys.indexOf(this.#lastGrantedKey)
      const nextKey = keys[(previousKeyIndex + 1) % keys.length]
      const index = this.#waiters.findIndex((candidate) => candidate.fairnessKey === nextKey)
      const [waiter] = this.#waiters.splice(index, 1)
      if (!waiter) break
      waiter.signal.removeEventListener('abort', waiter.onAbort)
      if (waiter.signal.aborted) {
        waiter.reject(abortError(waiter.signal.reason))
        continue
      }
      // WHY active is incremented before resolving: promise continuations run later. Deferring the
      // increment until the waiter wakes lets one release hand the same final permit to multiple
      // queued callers during a burst.
      this.#active += 1
      this.#lastGrantedKey = waiter.fairnessKey
      waiter.resolve(this.#lease())
    }
  }

  #changed(): void {
    this.#onStateChange?.(this.snapshot())
  }
}

function abortError(reason: unknown): Error {
  const error = new Error(
    reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : 'Scheduler acquisition aborted',
  )
  error.name = 'AbortError'
  return error
}
