import { createHash } from 'node:crypto'

import type { ProviderSessionReference } from './agentProvider.js'

const EXECUTION_OPTION_KEYS = ['schema', 'model', 'effort', 'isolation', 'agentType'] as const
const OMIT = Symbol('omit-from-journal-key')

type CanonicalValue = null | boolean | number | string | CanonicalValue[] | { [key: string]: CanonicalValue }

export type JournalIdentity = {
  /** A stable, resolved workflow identity. This namespaces history but is not hashed into call keys. */
  workflowId: string
  /** The loaded source hash. It gates reuse separately from both the storage identity and call key. */
  sourceHash: string
}

export type JournalAgentOptions = Readonly<
  {
    schema?: unknown
    model?: unknown
    effort?: unknown
    isolation?: unknown
    agentType?: unknown
  } & Record<string, unknown>
>

export type JournalCall = {
  agentId: string
  prompt: string
  options?: JournalAgentOptions
}

export type JournalStartedRecord = {
  type: 'started'
  key: string
  agentId: string
}

export type JournalResultRecord = {
  type: 'result'
  key: string
  agentId: string
  result: unknown
}

export type JournalSessionRecord = {
  key: string
  agentId: string
  session: ProviderSessionReference
}

export type JournalRecord = JournalStartedRecord | JournalResultRecord

export type JournalSnapshot = JournalIdentity & {
  records: readonly JournalRecord[]
  /** Runtime-owned resume metadata; kept outside Claude-compatible v2 record bytes. */
  sessions?: readonly JournalSessionRecord[]
}

type JournalDecisionBase = {
  callIndex: number
  key: string
  agentId: string
}

export type JournalMiss = JournalDecisionBase & {
  reused: false
  /** An interrupted matching prefix can resume a provider thread instead of replaying a result. */
  providerSession?: ProviderSessionReference
}

export type JournalHit = JournalDecisionBase & {
  reused: true
  /** The prior run's agent ID is useful for diagnostics, but never replaces this run's logical ID. */
  sourceAgentId: string
  result: unknown
}

export type JournalDecision = JournalMiss | JournalHit

export interface WorkflowJournalRun {
  admit(call: JournalCall): JournalDecision
  recordProviderSession(decision: JournalMiss, session: ProviderSessionReference): void
  recordResult(decision: JournalMiss, result: unknown): void
  snapshot(): JournalSnapshot
}

export interface WorkflowJournal {
  beginRun(identity: JournalIdentity): WorkflowJournalRun
  getSnapshot(workflowId: string): JournalSnapshot | undefined
}

function canonicalize(value: unknown, ancestors: Set<object>): CanonicalValue | typeof OMIT {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value

  if (typeof value === 'number') {
    // JSON is the compatibility boundary for schemas and journal records. Matching JSON's treatment
    // of non-finite numbers and negative zero keeps hashes stable across an in-memory run and a later
    // JSONL-backed implementation instead of giving the two stores subtly different identities.
    if (!Number.isFinite(value)) return null
    return Object.is(value, -0) ? 0 : value
  }

  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') {
    return OMIT
  }

  if (typeof value === 'bigint') {
    throw new TypeError('Workflow journal keys cannot contain bigint values')
  }

  if (typeof value !== 'object') return OMIT
  if (ancestors.has(value)) throw new TypeError('Workflow journal keys cannot contain circular values')

  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      return value.map((item) => {
        const normalized = canonicalize(item, ancestors)
        // This is deliberately JSON.stringify behavior: functions disappear from objects but occupy
        // a null slot in arrays. Compacting an array would change schema tuple positions and could make
        // two execution-distinct schemas share a key.
        return normalized === OMIT ? null : normalized
      })
    }

    // Raw UTF-16 ordering (`sort()` with no locale) is deterministic on every supported Node runtime.
    // Locale-aware ordering would make a cache key depend on the host's ICU data and user locale.
    const normalized: { [key: string]: CanonicalValue } = Object.create(null) as {
      [key: string]: CanonicalValue
    }
    for (const key of Object.keys(value).sort()) {
      const item = canonicalize((value as Record<string, unknown>)[key], ancestors)
      if (item !== OMIT) normalized[key] = item
    }
    return normalized
  } finally {
    ancestors.delete(value)
  }
}

/**
 * Produce the stable JSON representation used inside journal keys.
 *
 * This function is public because a future JSONL store needs exactly the same bytes as the in-memory
 * store. It is not a general serializer: workflow results keep their provider-defined representation,
 * while only execution identity is constrained to deterministic JSON data.
 */
export function canonicalizeJournalValue(value: unknown): string {
  const normalized = canonicalize(value, new Set())
  if (normalized === OMIT) {
    throw new TypeError('Workflow journal key values must have a JSON representation')
  }
  return JSON.stringify(normalized)
}

function executionOptions(options: JournalAgentOptions | undefined): Record<string, unknown> {
  const selected: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  if (!options) return selected

  // Do not spread the options object. Claude's resume identity intentionally ignores presentation
  // (`label`, `phase`) and forward-compatible unknown options. An allowlist here means adding a new UI
  // hint cannot unexpectedly invalidate an expensive 76-agent prefix.
  for (const key of EXECUTION_OPTION_KEYS) {
    if (Object.prototype.hasOwnProperty.call(options, key)) selected[key] = options[key]
  }
  return selected
}

export function createJournalKey(
  previousKey: string,
  prompt: string,
  options?: JournalAgentOptions,
): string {
  // The NUL framing and empty initial key are observed Claude v2 behavior, not a home-grown envelope.
  // Keep source identity outside this digest: Claude first checks that the stored workflow source is
  // compatible, then computes call keys from the sequential calls alone. That separation also lets a
  // durable store inspect why reuse failed (different workflow, source, or call) without reverse hashing.
  const payload = `${previousKey}\0${prompt}\0${canonicalizeJournalValue(executionOptions(options))}`
  return `v2:${createHash('sha256').update(payload, 'utf8').digest('hex')}`
}

type HistoricalCall = {
  key: string
  agentId: string
  hasResult: boolean
  result?: unknown
  providerSession?: ProviderSessionReference
}

function historicalCalls(snapshot: JournalSnapshot): HistoricalCall[] {
  const calls: HistoricalCall[] = []
  const pending = new Map<string, HistoricalCall[]>()

  for (const record of snapshot.records) {
    const recordId = `${record.key}\0${record.agentId}`
    if (record.type === 'started') {
      const call: HistoricalCall = {
        key: record.key,
        agentId: record.agentId,
        hasResult: false,
      }
      calls.push(call)
      const matches = pending.get(recordId)
      if (matches) matches.push(call)
      else pending.set(recordId, [call])
      continue
    }

    const matches = pending.get(recordId)
    const call = matches?.shift()
    // A result without a matching start cannot prove a reusable logical call. Ignoring it mirrors a
    // truncated append-only journal safely; guessing its position could replay a result for the wrong
    // prompt and poison every later chained lookup.
    if (!call) continue
    call.hasResult = true
    call.result = record.result
    if (matches?.length === 0) pending.delete(recordId)
  }

  for (const record of snapshot.sessions ?? []) {
    const call = calls.find(
      (candidate) => candidate.key === record.key && candidate.agentId === record.agentId,
    )
    if (call) call.providerSession = { ...record.session }
  }

  return calls
}

class InMemoryWorkflowJournalRun implements WorkflowJournalRun {
  readonly #identity: JournalIdentity
  readonly #previous: ReadonlyMap<string, readonly HistoricalCall[]>
  readonly #records: JournalRecord[]
  readonly #sessions: JournalSessionRecord[]
  readonly #pending = new Map<number, JournalMiss & { completed: boolean }>()
  #previousKey: string
  #nextCallIndex = 0
  #canReusePrefix: boolean

  constructor(
    identity: JournalIdentity,
    previous: JournalSnapshot | undefined,
    records: JournalRecord[],
    sessions: JournalSessionRecord[],
  ) {
    this.#identity = identity
    // Claude resumes by the longest unchanged sequence of `(prompt, opts)` calls after the script
    // is edited. The source hash is retained for audit/diagnostics, but it cannot be a reuse gate:
    // making it one invalidates the entire journal on the exact edit-and-resume path the Workflow
    // tool is designed around. Workflow identity still selects the namespace, and the chained keys
    // invalidate the suffix after the first behaviorally changed call.
    const historical = previous === undefined ? [] : historicalCalls(previous)
    const byKey = new Map<string, HistoricalCall[]>()
    for (const call of historical) {
      const matches = byKey.get(call.key)
      if (matches) matches.push(call)
      else byKey.set(call.key, [call])
    }
    this.#previous = byKey
    this.#records = records
    this.#sessions = sessions
    this.#previousKey = ''
    this.#canReusePrefix = previous !== undefined
  }

  admit(call: JournalCall): JournalDecision {
    const callIndex = this.#nextCallIndex++
    const key = createJournalKey(this.#previousKey, call.prompt, call.options)
    this.#previousKey = key

    // Parallel calls are admitted in deterministic JavaScript order, but Claude appends `started`
    // records when scheduler/provider work actually begins. File order is therefore not call order.
    // The chained v2 key already commits to every preceding call, so key lookup is both sufficient
    // and the only ordering rule that survives a saturated or retried parallel phase.
    const candidates = this.#previous.get(key) ?? []
    const historicalResult = this.#canReusePrefix
      ? candidates.find((candidate) => candidate.hasResult && candidate.result !== null)
      : undefined
    const historicalSession = this.#canReusePrefix
      ? candidates.find((candidate) => candidate.providerSession !== undefined)
      : undefined

    this.#records.push({ type: 'started', key, agentId: call.agentId })

    if (historicalResult !== undefined) {
      this.#records.push({ type: 'result', key, agentId: call.agentId, result: historicalResult.result })
      return {
        callIndex,
        key,
        agentId: call.agentId,
        reused: true,
        sourceAgentId: historicalResult.agentId,
        result: historicalResult.result,
      }
    }

    // Prefix invalidation is stateful rather than a per-key lookup. Even if a later call happens to
    // produce a historical key (a null/missing result is the common case), everything after the first
    // miss must run live because earlier outputs may have influenced its prompt or side effects.
    this.#canReusePrefix = false
    const decision: JournalMiss = {
      callIndex,
      key,
      agentId: call.agentId,
      reused: false,
      ...(historicalSession?.providerSession === undefined
        ? {}
        : { providerSession: { ...historicalSession.providerSession } }),
    }
    this.#pending.set(callIndex, { ...decision, completed: false })
    return decision
  }

  recordProviderSession(decision: JournalMiss, session: ProviderSessionReference): void {
    const pending = this.#pending.get(decision.callIndex)
    if (!pending || pending.completed || pending.key !== decision.key || pending.agentId !== decision.agentId) {
      throw new Error('Journal provider session does not belong to an unfinished call in this run')
    }
    const existing = this.#sessions.find(
      (record) => record.key === pending.key && record.agentId === pending.agentId,
    )
    if (existing) {
      existing.session = { ...session }
      return
    }
    this.#sessions.push({ key: pending.key, agentId: pending.agentId, session: { ...session } })
  }

  recordResult(decision: JournalMiss, result: unknown): void {
    const pending = this.#pending.get(decision.callIndex)
    if (
      !pending ||
      pending.completed ||
      pending.key !== decision.key ||
      pending.agentId !== decision.agentId
    ) {
      throw new Error('Journal result does not belong to an unfinished call in this run')
    }

    pending.completed = true
    this.#records.push({
      type: 'result',
      key: pending.key,
      agentId: pending.agentId,
      result,
    })
  }

  snapshot(): JournalSnapshot {
    return {
      ...this.#identity,
      records: [...this.#records],
      ...(this.#sessions.length === 0
        ? {}
        : { sessions: this.#sessions.map((record) => ({ ...record, session: { ...record.session } })) }),
    }
  }
}

export class InMemoryWorkflowJournal implements WorkflowJournal {
  readonly #snapshots = new Map<string, JournalSnapshot>()

  constructor(snapshots: Iterable<JournalSnapshot> = []) {
    for (const snapshot of snapshots) this.#snapshots.set(snapshot.workflowId, copySnapshot(snapshot))
  }

  beginRun(identity: JournalIdentity): WorkflowJournalRun {
    if (identity.workflowId.length === 0) throw new TypeError('Journal workflowId must not be empty')
    if (identity.sourceHash.length === 0) throw new TypeError('Journal sourceHash must not be empty')

    const previous = this.#snapshots.get(identity.workflowId)
    const records: JournalRecord[] = []
    const sessions: JournalSessionRecord[] = []
    // Install the new append-only record array immediately. If the process stops after admission but
    // before provider completion, getSnapshot() must expose the started-only record that forces respawn.
    const current: JournalSnapshot = { ...identity, records, sessions }
    this.#snapshots.set(identity.workflowId, current)
    return new InMemoryWorkflowJournalRun(identity, previous, records, sessions)
  }

  getSnapshot(workflowId: string): JournalSnapshot | undefined {
    const snapshot = this.#snapshots.get(workflowId)
    return snapshot ? copySnapshot(snapshot) : undefined
  }
}

function copySnapshot(snapshot: JournalSnapshot): JournalSnapshot {
  // Results are intentionally not deep-cloned. Providers may return large structured artifacts and the
  // journal's job is sequencing, not object ownership. Durable stores will serialize at their boundary;
  // callers that mutate a result after recording it already violate the provider-result contract.
  return {
    workflowId: snapshot.workflowId,
    sourceHash: snapshot.sourceHash,
    records: snapshot.records.map((record) => ({ ...record })),
    ...(snapshot.sessions === undefined
      ? {}
      : { sessions: snapshot.sessions.map((record) => ({ ...record, session: { ...record.session } })) }),
  }
}
