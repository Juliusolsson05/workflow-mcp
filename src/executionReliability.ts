import { AgentProviderFailure } from './agentProvider.js'
import type { AgentProviderEvent } from './agentProvider.js'

export type AutomaticRetryMode = 'never' | 'safe'

export type WorkflowReliabilityPolicy = {
  maxAttempts: number
  maxRetryAttemptsPerRun: number
  startupTimeoutMs: number
  idleTimeoutMs: number
  activeOperationTimeoutMs: number
  attemptTimeoutMs: number
  retryBackoffBaseMs: number
  retryBackoffMaxMs: number
  retryJitterRatio: number
  hardTerminationGraceMs: number
  preparationTimeoutMs: number
  cleanupTimeoutMs: number
  workerStartupTimeoutMs: number
  workerHeartbeatTimeoutMs: number
  workerIdleTimeoutMs: number
  circuitBreakerThreshold: number
  circuitBreakerWindowMs: number
  circuitBreakerCooldownMs: number
  preparationConcurrency: number
  cleanupConcurrency: number
  underutilizationWarningMs: number
  automaticRetry: AutomaticRetryMode
}

export const DEFAULT_WORKFLOW_RELIABILITY_POLICY: Readonly<WorkflowReliabilityPolicy> = {
  maxAttempts: 3,
  maxRetryAttemptsPerRun: 100,
  startupTimeoutMs: 90_000,
  idleTimeoutMs: 6 * 60_000,
  activeOperationTimeoutMs: 20 * 60_000,
  attemptTimeoutMs: 45 * 60_000,
  retryBackoffBaseMs: 2_000,
  retryBackoffMaxMs: 30_000,
  retryJitterRatio: 0.2,
  hardTerminationGraceMs: 5_000,
  preparationTimeoutMs: 2 * 60_000,
  cleanupTimeoutMs: 30_000,
  workerStartupTimeoutMs: 30_000,
  workerHeartbeatTimeoutMs: 30_000,
  workerIdleTimeoutMs: 2 * 60_000,
  circuitBreakerThreshold: 5,
  circuitBreakerWindowMs: 2 * 60_000,
  circuitBreakerCooldownMs: 30_000,
  preparationConcurrency: 2,
  cleanupConcurrency: 2,
  underutilizationWarningMs: 30_000,
  automaticRetry: 'safe',
}

export type AttemptTimeoutKind = 'startup' | 'idle' | 'active-operation' | 'absolute'

export class AgentAttemptTimeoutError extends AgentProviderFailure {
  readonly kind: AttemptTimeoutKind
  readonly lastProgressAt: string
  readonly deadlineAt: string

  constructor(kind: AttemptTimeoutKind, lastProgressAt: string, deadlineAt: string) {
    super(timeoutMessage(kind), {
      code: `agent-${kind}-timeout`,
      retryable: true,
    })
    this.name = 'AgentAttemptTimeoutError'
    this.kind = kind
    this.lastProgressAt = lastProgressAt
    this.deadlineAt = deadlineAt
  }
}

export type AttemptLivenessSnapshot = {
  startedAt: string
  lastProgressAt: string
  deadlineAt: string
  phase: 'startup' | 'idle' | 'active-operation'
  openActivities: number
}

/**
 * Owns the liveness clock for exactly one provider attempt.
 *
 * WHY progress is driven by normalized provider events rather than CPU or process presence: a
 * child process can remain alive forever while its network stream is wedged. Conversely, a tool
 * call may legitimately use no CPU for minutes. The normalized event stream is the narrowest
 * provider-neutral evidence that the attempt is still advancing, while the longer active-operation
 * deadline avoids treating a known long-running command like ordinary unexplained silence.
 */
export class AttemptLivenessMonitor {
  readonly #controller: AbortController
  readonly #policy: WorkflowReliabilityPolicy
  readonly #startedAtMs: number
  readonly #openActivities = new Set<string>()
  readonly #timeout: Promise<never>
  #rejectTimeout!: (error: unknown) => void
  #lastProgressAtMs: number
  #sawProgress = false
  #timer: NodeJS.Timeout | undefined
  #stopped = false

  constructor(controller: AbortController, policy: WorkflowReliabilityPolicy, now = Date.now()) {
    this.#controller = controller
    this.#policy = policy
    this.#startedAtMs = now
    this.#lastProgressAtMs = now
    this.#timeout = new Promise<never>((_resolve, reject) => { this.#rejectTimeout = reject })
    this.#arm()
  }

  get timeout(): Promise<never> {
    return this.#timeout
  }

  progress(event: AgentProviderEvent, now = Date.now()): void {
    if (this.#stopped) return
    this.#sawProgress = true
    this.#lastProgressAtMs = now
    if (event.type === 'activity.started') this.#openActivities.add(event.activity.id)
    if (event.type === 'activity.completed') this.#openActivities.delete(event.activity.id)
    this.#arm()
  }

  snapshot(now = Date.now()): AttemptLivenessSnapshot {
    const phase = this.#phase()
    return {
      startedAt: new Date(this.#startedAtMs).toISOString(),
      lastProgressAt: new Date(this.#lastProgressAtMs).toISOString(),
      deadlineAt: new Date(this.#deadline(phase, now)).toISOString(),
      phase,
      openActivities: this.#openActivities.size,
    }
  }

  stop(): void {
    this.#stopped = true
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = undefined
  }

  #phase(): AttemptLivenessSnapshot['phase'] {
    if (!this.#sawProgress) return 'startup'
    return this.#openActivities.size > 0 ? 'active-operation' : 'idle'
  }

  #deadline(phase: AttemptLivenessSnapshot['phase'], _now: number): number {
    const inactivityDeadline = this.#lastProgressAtMs + (
      phase === 'startup'
        ? this.#policy.startupTimeoutMs
        : phase === 'active-operation'
          ? this.#policy.activeOperationTimeoutMs
          : this.#policy.idleTimeoutMs
    )
    return Math.min(inactivityDeadline, this.#startedAtMs + this.#policy.attemptTimeoutMs)
  }

  #arm(): void {
    if (this.#stopped) return
    if (this.#timer) clearTimeout(this.#timer)
    const now = Date.now()
    const phase = this.#phase()
    const deadline = this.#deadline(phase, now)
    this.#timer = setTimeout(() => {
      if (this.#stopped) return
      this.#stopped = true
      const absoluteWon = this.#startedAtMs + this.#policy.attemptTimeoutMs <= deadline
      const kind: AttemptTimeoutKind = absoluteWon ? 'absolute' : phase
      const error = new AgentAttemptTimeoutError(
        kind,
        new Date(this.#lastProgressAtMs).toISOString(),
        new Date(deadline).toISOString(),
      )
      // WHY reject before abort: an adapter normally rejects immediately when its signal aborts.
      // Settling the supervisor timeout first guarantees callers see the actionable stall reason
      // instead of a generic AbortError whose cause is impossible to classify for retry.
      this.#rejectTimeout(error)
      this.#controller.abort(error)
    }, Math.max(1, deadline - now))
    this.#timer.unref?.()
  }
}

export function normalizeReliabilityPolicy(
  overrides: Partial<WorkflowReliabilityPolicy> | undefined,
): WorkflowReliabilityPolicy {
  const result = { ...DEFAULT_WORKFLOW_RELIABILITY_POLICY, ...overrides }
  for (const name of [
    'maxAttempts',
    'maxRetryAttemptsPerRun',
    'startupTimeoutMs',
    'idleTimeoutMs',
    'activeOperationTimeoutMs',
    'attemptTimeoutMs',
    'retryBackoffBaseMs',
    'retryBackoffMaxMs',
    'hardTerminationGraceMs',
    'preparationTimeoutMs',
    'cleanupTimeoutMs',
    'workerStartupTimeoutMs',
    'workerHeartbeatTimeoutMs',
    'workerIdleTimeoutMs',
    'circuitBreakerThreshold',
    'circuitBreakerWindowMs',
    'circuitBreakerCooldownMs',
    'preparationConcurrency',
    'cleanupConcurrency',
    'underutilizationWarningMs',
  ] as const) {
    if (!Number.isSafeInteger(result[name]) || result[name] <= 0) {
      throw new TypeError(`Workflow reliability policy ${name} must be a positive safe integer`)
    }
  }
  if (!Number.isFinite(result.retryJitterRatio) || result.retryJitterRatio < 0 || result.retryJitterRatio > 1) {
    throw new TypeError('Workflow reliability policy retryJitterRatio must be between zero and one')
  }
  if (!['never', 'safe'].includes(result.automaticRetry)) {
    throw new TypeError(`Unsupported automatic retry mode ${JSON.stringify(result.automaticRetry)}`)
  }
  if (result.retryBackoffMaxMs < result.retryBackoffBaseMs) {
    throw new TypeError('retryBackoffMaxMs must be greater than or equal to retryBackoffBaseMs')
  }
  return result
}

export type ProviderCircuitSnapshot = {
  state: 'closed' | 'open' | 'half-open'
  recentFailures: number
  retryAt?: string
}

export type ProviderCircuitLease = {
  readonly probe: boolean
  /** Atomically revalidates a reservation after scheduler capacity has been obtained. */
  startAllowed(): boolean
  success(): void
  infrastructureFailure(): void
  neutral(): void
}

/**
 * Shared provider-outage admission gate with one half-open probe.
 *
 * WHY retries need a service-wide gate: nine agents seeing the same provider outage otherwise each
 * run their own exponential sequence, producing synchronized bursts and consuming the entire run
 * deadline. Open-circuit wait happens before scheduler admission, so a provider outage occupies no
 * scarce provider permits and healthy already-running attempts are never cancelled.
 */
export class ProviderCircuitBreaker {
  readonly #threshold: number
  readonly #windowMs: number
  readonly #cooldownMs: number
  readonly #failures: number[] = []
  #openUntil = 0
  #halfOpenProbe = false
  #generation = 0

  constructor(policy: Pick<
    WorkflowReliabilityPolicy,
    'circuitBreakerThreshold' | 'circuitBreakerWindowMs' | 'circuitBreakerCooldownMs'
  >) {
    this.#threshold = policy.circuitBreakerThreshold
    this.#windowMs = policy.circuitBreakerWindowMs
    this.#cooldownMs = policy.circuitBreakerCooldownMs
  }

  async enter(signal: AbortSignal): Promise<ProviderCircuitLease> {
    while (true) {
      if (signal.aborted) throw abortSignalError(signal)
      const now = Date.now()
      this.#prune(now)
      if (this.#openUntil === 0) return this.#lease(false)
      if (now >= this.#openUntil && !this.#halfOpenProbe) {
        this.#halfOpenProbe = true
        return this.#lease(true)
      }
      await waitForCircuit(
        this.#halfOpenProbe ? 100 : Math.max(1, this.#openUntil - now),
        signal,
      )
    }
  }

  snapshot(now = Date.now()): ProviderCircuitSnapshot {
    this.#prune(now)
    if (this.#openUntil === 0) return { state: 'closed', recentFailures: this.#failures.length }
    return {
      state: now >= this.#openUntil && this.#halfOpenProbe ? 'half-open' : 'open',
      recentFailures: this.#failures.length,
      retryAt: new Date(this.#openUntil).toISOString(),
    }
  }

  #lease(probe: boolean): ProviderCircuitLease {
    let settled = false
    const generation = this.#generation
    let startCommitted = false
    const startAllowed = (): boolean => {
      if (settled) return false
      if (startCommitted) return true
      const allowed = generation === this.#generation && (
        probe
          ? this.#halfOpenProbe && this.#openUntil !== 0
          : this.#openUntil === 0
      )
      if (allowed) startCommitted = true
      return allowed
    }
    const settle = (outcome: 'success' | 'failure' | 'neutral'): void => {
      if (settled) return
      settled = true
      const now = Date.now()
      if (outcome === 'success') {
        const changedCircuitState = probe || this.#openUntil !== 0
        this.#failures.length = 0
        this.#openUntil = 0
        this.#halfOpenProbe = false
        if (changedCircuitState) this.#generation += 1
        return
      }
      if (outcome === 'failure') {
        this.#failures.push(now)
        this.#prune(now)
        if (probe || this.#failures.length >= this.#threshold) {
          this.#openUntil = now + this.#cooldownMs
          this.#halfOpenProbe = false
          // Every circuit transition invalidates reservations which passed enter() but were still
          // waiting for scheduler capacity. Without this generation fence, a full nine-agent queue
          // can continue launching one stale request at a time throughout an outage.
          this.#generation += 1
        }
        return
      }
      if (probe) {
        // A deterministic request/schema failure says nothing about provider availability. Let a
        // different queued call probe immediately instead of holding the circuit half-open forever.
        this.#halfOpenProbe = false
        this.#openUntil = now
        this.#generation += 1
      }
    }
    return {
      probe,
      startAllowed,
      success: () => settle('success'),
      infrastructureFailure: () => settle('failure'),
      neutral: () => settle('neutral'),
    }
  }

  #prune(now: number): void {
    while (this.#failures.length > 0 && this.#failures[0]! < now - this.#windowMs) {
      this.#failures.shift()
    }
    if (this.#openUntil !== 0 && now >= this.#openUntil && !this.#halfOpenProbe) {
      // Keep the nonzero timestamp until enter() allocates the single probe. snapshot() can then
      // report open rather than claiming normal admission while no probe has proven recovery.
    }
  }
}

function waitForCircuit(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, Math.min(milliseconds, 1_000))
    timer.unref?.()
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(abortSignalError(signal))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function abortSignalError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason
  const error = new Error(typeof signal.reason === 'string' ? signal.reason : 'Operation aborted')
  error.name = 'AbortError'
  return error
}

export function retryDelayMs(
  policy: WorkflowReliabilityPolicy,
  completedAttemptNumber: number,
  random = Math.random,
): number {
  const exponential = Math.min(
    policy.retryBackoffMaxMs,
    policy.retryBackoffBaseMs * (2 ** Math.max(0, completedAttemptNumber - 1)),
  )
  const spread = exponential * policy.retryJitterRatio
  return Math.max(1, Math.round(exponential - spread + random() * spread * 2))
}

function timeoutMessage(kind: AttemptTimeoutKind): string {
  switch (kind) {
    case 'startup': return 'Agent provider did not start producing events before its startup deadline'
    case 'idle': return 'Agent provider stopped producing progress events before its idle deadline'
    case 'active-operation': return 'Agent provider activity exceeded its no-progress deadline'
    case 'absolute': return 'Agent provider attempt exceeded its absolute runtime deadline'
  }
}
