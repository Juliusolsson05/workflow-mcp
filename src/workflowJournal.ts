import { createHash } from 'node:crypto'

import type { ProviderSessionReference } from './agentProvider.js'
import { isWorkflowAgentFailurePlaceholder } from './workflowEvents.js'

const EXECUTION_OPTION_KEYS = ['schema', 'model', 'effort', 'isolation', 'agentType'] as const
const OMIT = Symbol('omit-from-journal-key')
const MAX_IMPORTED_OPTION_PROOF_HASHES = 1_000_000

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
  /** Private recovery evidence; absent legacy/Claude null remains conservatively non-reusable. */
  successful?: boolean
  /**
   * A terminal logical assignment which intentionally produced a coverage-gap placeholder.
   *
   * WHY this is distinct from `successful`: automatic host-crash recovery must preserve the
   * casualty instead of replaying an unsafe/disposed physical attempt, while an explicit manual
   * resume must be allowed to try that logical assignment again. Treating the placeholder as an
   * ordinary success makes manual repair impossible; treating it as an ordinary failure makes
   * every post-completion host crash repeat work whose safety policy already said "do not replay".
   */
  coverageGap?: boolean
}

export type JournalSessionRecord = {
  key: string
  agentId: string
  session: ProviderSessionReference
}

/**
 * A privacy-preserving bridge from Claude's per-agent transcript to its v2 journal result.
 *
 * Claude's journal key is chained through the global call-admission order. A work-conserving
 * pipeline can legitimately admit its next stage in a different order when cached parents settle
 * faster than live parents did, so the chained key alone cannot identify those unchanged calls
 * across runtimes. The importer records only a hash of the exact prompt—not the prompt bytes—and
 * the runtime consults it only under the existing exact-source sparse gate.
 */
export type JournalImportedCall = {
  key: string
  agentId: string
  promptKey: string
}

export type JournalRecord = JournalStartedRecord | JournalResultRecord

export type JournalSnapshot = JournalIdentity & {
  records: readonly JournalRecord[]
  /** Runtime-owned resume metadata; kept outside Claude-compatible v2 record bytes. */
  sessions?: readonly JournalSessionRecord[]
  /** Runtime-owned prompt identities recovered from Claude's sibling transcript files. */
  importedCalls?: readonly JournalImportedCall[]
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
  /** Present only when automatic recovery deliberately reuses a terminal coverage gap. */
  coverageGap?: true
}

export type JournalDecision = JournalMiss | JournalHit

export interface WorkflowJournalRun {
  admit(call: JournalCall): JournalDecision
  recordProviderSession(decision: JournalMiss, session: ProviderSessionReference): void
  /** Remove a poisoned/abandoned provider thread before a fresh physical attempt is scheduled. */
  discardProviderSession(decision: JournalMiss): void
  recordResult(
    decision: JournalMiss,
    result: unknown,
    options?: { successful?: boolean; coverageGap?: boolean },
  ): void
  snapshot(): JournalSnapshot
}

export type JournalReuseMode = 'longest-prefix' | 'exact-source-sparse'

export interface WorkflowJournal {
  beginRun(
    identity: JournalIdentity,
    options?: { reuseMode?: JournalReuseMode; reuseCoverageGaps?: boolean },
  ): WorkflowJournalRun
  getSnapshot(workflowId: string): JournalSnapshot | undefined
  /** Return every workflow identity in this lineage, including nested workflows. */
  getSnapshots(): readonly JournalSnapshot[]
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

export function createImportedPromptKey(prompt: string): string {
  // Do not persist provider prompts merely to repair an ordering artifact. The imported result
  // already contains potentially sensitive data and lives in a 0600 sidecar, but hashing here
  // keeps the new compatibility index from duplicating entire review prompts (often hundreds of
  // kilobytes each) or making them easier to discover in generic state inspection.
  return `ip1:${createHash('sha256').update(prompt, 'utf8').digest('hex')}`
}

type HistoricalCall = {
  key: string
  agentId: string
  hasResult: boolean
  reusable: boolean
  coverageGap: boolean
  result?: unknown
  providerSession?: ProviderSessionReference
  importedPromptKey?: string
}

function assertCoverageGapRecord(record: JournalRecord): void {
  if (record.type !== 'result' || record.coverageGap !== true) return
  if (record.successful !== false || !isWorkflowAgentFailurePlaceholder(record.result)) {
    // WHY this guard also lives in the in-memory implementation: imported snapshots are a public
    // recovery seam and do not necessarily pass through PersistentWorkflowJournal's JSON parser.
    // A coverage-gap bit authorizes schema bypass and automatic reuse, so accepting a partial marker
    // here would make an in-memory fallback less trustworthy than the on-disk source it mirrors.
    throw new TypeError(
      'Journal coverage-gap results must be unsuccessful versioned workflow failure placeholders',
    )
  }
}

function assertImportedCalls(snapshot: JournalSnapshot): void {
  if (snapshot.importedCalls === undefined) return
  const starts = new Set(
    snapshot.records
      .filter((record) => record.type === 'started')
      .map((record) => `${record.key}\0${record.agentId}`),
  )
  const seen = new Set<string>()
  for (const imported of snapshot.importedCalls) {
    const identity = `${imported.key}\0${imported.agentId}`
    if (
      !/^v2:[a-f0-9]{64}$/.test(imported.key) ||
      imported.agentId.length === 0 ||
      !/^ip1:[a-f0-9]{64}$/.test(imported.promptKey) ||
      !starts.has(identity) ||
      seen.has(identity)
    ) {
      // Imported prompt identities authorize reuse when the ordinary chained key does not match.
      // Validate this capability in the in-memory seam as well as the durable parser because tests,
      // embedders, and the Claude importer can inject snapshots without touching disk first.
      throw new TypeError('Journal imported calls must uniquely identify started records')
    }
    seen.add(identity)
  }
}

function historicalCalls(snapshot: JournalSnapshot): HistoricalCall[] {
  const calls: HistoricalCall[] = []
  const pending = new Map<string, HistoricalCall[]>()
  const byIdentity = new Map<string, HistoricalCall[]>()

  for (const record of snapshot.records) {
    assertCoverageGapRecord(record)
    const recordId = `${record.key}\0${record.agentId}`
    if (record.type === 'started') {
      const call: HistoricalCall = {
        key: record.key,
        agentId: record.agentId,
        hasResult: false,
        reusable: false,
        coverageGap: false,
      }
      calls.push(call)
      const matches = pending.get(recordId)
      if (matches) matches.push(call)
      else pending.set(recordId, [call])
      const identityMatches = byIdentity.get(recordId)
      if (identityMatches) identityMatches.push(call)
      else byIdentity.set(recordId, [call])
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
    call.coverageGap = record.coverageGap === true
    // Claude and version-1 sidecars cannot distinguish a successful null from the historical
    // "provider failed => null" sentinel, so absence of the bit preserves conservative behavior.
    call.reusable = call.coverageGap ? false : (record.successful ?? record.result !== null)
    if (matches?.length === 0) pending.delete(recordId)
  }

  for (const record of snapshot.sessions ?? []) {
    const call = byIdentity.get(`${record.key}\0${record.agentId}`)?.[0]
    if (call) call.providerSession = { ...record.session }
  }

  for (const record of snapshot.importedCalls ?? []) {
    const call = byIdentity.get(`${record.key}\0${record.agentId}`)?.[0]
    if (call) call.importedPromptKey = record.promptKey
  }

  return calls
}

class InMemoryWorkflowJournalRun implements WorkflowJournalRun {
  readonly #identity: JournalIdentity
  readonly #previous: ReadonlyMap<string, readonly HistoricalCall[]>
  readonly #previousImported: ReadonlyMap<string, readonly HistoricalCall[]>
  readonly #historicalKeys: readonly string[]
  readonly #records: JournalRecord[]
  readonly #sessions: JournalSessionRecord[]
  readonly #importedCalls: JournalImportedCall[]
  readonly #pending = new Map<number, JournalMiss & { completed: boolean }>()
  readonly #consumedHistorical = new Set<HistoricalCall>()
  #previousKey: string
  #nextCallIndex = 0
  #canReusePrefix: boolean
  readonly #exactSourceSparse: boolean
  readonly #retainSparseHistory: boolean
  readonly #reuseCoverageGaps: boolean
  readonly #trackImportedPrompts: boolean
  #remainingImportedOptionProofHashes = MAX_IMPORTED_OPTION_PROOF_HASHES

  constructor(
    identity: JournalIdentity,
    previous: JournalSnapshot | undefined,
    records: JournalRecord[],
    sessions: JournalSessionRecord[],
    importedCalls: JournalImportedCall[],
    reuseMode: JournalReuseMode,
    retainSparseHistory = false,
    reuseCoverageGaps = false,
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
    const byImportedPrompt = new Map<string, HistoricalCall[]>()
    for (const call of historical) {
      if (call.importedPromptKey === undefined) continue
      const matches = byImportedPrompt.get(call.importedPromptKey)
      if (matches) matches.push(call)
      else byImportedPrompt.set(call.importedPromptKey, [call])
    }
    this.#previous = byKey
    this.#previousImported = byImportedPrompt
    this.#historicalKeys = ['', ...new Set(historical.map((call) => call.key))]
    this.#records = records
    this.#sessions = sessions
    this.#importedCalls = importedCalls
    this.#previousKey = ''
    this.#canReusePrefix = previous !== undefined
    this.#exactSourceSparse =
      reuseMode === 'exact-source-sparse' &&
      previous !== undefined &&
      previous.sourceHash === identity.sourceHash
    this.#retainSparseHistory = retainSparseHistory
    this.#reuseCoverageGaps = reuseCoverageGaps
    this.#trackImportedPrompts = previous?.importedCalls !== undefined
  }

  admit(call: JournalCall): JournalDecision {
    const callIndex = this.#nextCallIndex++
    const key = createJournalKey(this.#previousKey, call.prompt, call.options)
    this.#previousKey = key

    // Parallel calls are admitted in deterministic JavaScript order, but Claude appends `started`
    // records when scheduler/provider work actually begins. File order is therefore not call order.
    // The chained v2 key commits to every preceding call and remains the primary compatibility
    // identity. Claude-import prompt hashes below are a narrowly gated repair for one case that the
    // global chain cannot survive: a dynamic pipeline admitting unchanged children in a new order.
    const candidates = this.#previous.get(key) ?? []
    const mayReuse = this.#canReusePrefix || this.#exactSourceSparse
    let historicalResult = mayReuse
      ? candidates.find((candidate) => (
          !this.#consumedHistorical.has(candidate) &&
          candidate.hasResult &&
          (candidate.reusable || (this.#reuseCoverageGaps && candidate.coverageGap))
        ))
      : undefined
    const promptKey = this.#trackImportedPrompts ? createImportedPromptKey(call.prompt) : undefined
    let importedMatch: HistoricalCall | undefined
    if (historicalResult === undefined && this.#exactSourceSparse && promptKey !== undefined) {
      const importedCandidates = this.#previousImported.get(promptKey) ?? []
      // A prompt hash is deliberately weaker than Claude's chained key because Claude does not
      // persist execution options beside the transcript. Requiring one unique historical call
      // prevents same-prompt branches from donating each other's result; the chained-key proof in
      // importedOptionsMatch then verifies every execution-affecting option before reuse.
      const candidate = importedCandidates.length === 1 ? importedCandidates[0] : undefined
      if (
        candidate !== undefined &&
        !this.#consumedHistorical.has(candidate) &&
        this.#importedOptionsMatch(candidate, call)
      ) {
        importedMatch = candidate
      }
      if (
        importedMatch !== undefined &&
        importedMatch.hasResult &&
        (importedMatch.reusable || (this.#reuseCoverageGaps && importedMatch.coverageGap))
      ) {
        historicalResult = importedMatch
      }
    }
    const historicalSession = mayReuse
      ? candidates.find((candidate) => candidate.providerSession !== undefined)
      : undefined

    if (this.#retainSparseHistory) {
      // Replace this visited key's inherited representation with the current generation's record,
      // while leaving not-yet-visited parallel siblings intact. Without per-key compaction, copying
      // the predecessor would preserve crash safety but grow the journal on every restart.
      for (let index = this.#records.length - 1; index >= 0; index -= 1) {
        if (this.#records[index]?.key === key) this.#records.splice(index, 1)
      }
      for (let index = this.#sessions.length - 1; index >= 0; index -= 1) {
        if (this.#sessions[index]?.key === key) this.#sessions.splice(index, 1)
      }
    }
    const replacedHistorical = historicalResult ?? importedMatch
    if (replacedHistorical !== undefined) {
      this.#consumedHistorical.add(replacedHistorical)
      if (this.#retainSparseHistory && replacedHistorical.key !== key) {
        // A semantic Claude-import hit replaces a historical call whose chained key was computed
        // under a different pipeline completion order. Remove that exact source call only after we
        // know its result will be materialized under the current key below; untouched imported tail
        // calls remain available if the host crashes before JavaScript reaches them.
        for (let index = this.#records.length - 1; index >= 0; index -= 1) {
          const record = this.#records[index]
          if (record?.key === replacedHistorical.key && record.agentId === replacedHistorical.agentId) {
            this.#records.splice(index, 1)
          }
        }
      }
    }
    if (promptKey !== undefined) {
      for (let index = this.#importedCalls.length - 1; index >= 0; index -= 1) {
        const imported = this.#importedCalls[index]
        if (
          imported?.key === key ||
          (replacedHistorical !== undefined &&
            imported?.key === replacedHistorical.key &&
            imported.agentId === replacedHistorical.agentId)
        ) {
          this.#importedCalls.splice(index, 1)
        }
      }
      this.#importedCalls.push({ key, agentId: call.agentId, promptKey })
    }
    this.#records.push({ type: 'started', key, agentId: call.agentId })

    if (historicalResult !== undefined) {
      this.#records.push({
        type: 'result',
        key,
        agentId: call.agentId,
        result: historicalResult.result,
        successful: !historicalResult.coverageGap,
        ...(historicalResult.coverageGap ? { coverageGap: true } : {}),
      })
      return {
        callIndex,
        key,
        agentId: call.agentId,
        reused: true,
        sourceAgentId: historicalResult.agentId,
        result: historicalResult.result,
        ...(historicalResult.coverageGap ? { coverageGap: true as const } : {}),
      }
    }

    // Prefix invalidation is stateful rather than a per-key lookup. Even if a later call happens to
    // produce a historical key (a null/missing result is the common case), everything after the first
    // miss must run live because earlier outputs may have influenced its prompt or side effects.
    if (!this.#exactSourceSparse) this.#canReusePrefix = false
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

  #importedOptionsMatch(candidate: HistoricalCall, call: JournalCall): boolean {
    // Claude's transcript gives us the exact prompt but not the agent() options. We can still prove
    // option identity without guessing or persisting raw schemas: candidate.key was SHA-256 over
    // (historical predecessor, prompt, execution options), and its real predecessor must be one of
    // the journal's started-call keys (or empty for call zero). Trying the current options against
    // that finite set succeeds only when schema/model/effort/isolation/agentType match the capture.
    //
    // A malicious near-limit journal must not turn this compatibility proof into quadratic CPU
    // denial of service. Once the lineage-wide hash budget is spent, remaining semantic candidates
    // simply rerun through the provider; correctness never depends on the optimization.
    for (const previousKey of this.#historicalKeys) {
      if (this.#remainingImportedOptionProofHashes <= 0) return false
      this.#remainingImportedOptionProofHashes -= 1
      if (createJournalKey(previousKey, call.prompt, call.options) === candidate.key) return true
    }
    return false
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

  discardProviderSession(decision: JournalMiss): void {
    const pending = this.#pending.get(decision.callIndex)
    if (!pending || pending.completed || pending.key !== decision.key || pending.agentId !== decision.agentId) {
      throw new Error('Journal provider session does not belong to an unfinished call in this run')
    }
    // WHY deletion is keyed by the logical call rather than a provider thread ID: an adapter can
    // replace its thread reference during one attempt. The current journal pointer is the only
    // value crash recovery will consume, so removing every pointer for this call is the atomic
    // statement that the next physical attempt must start fresh.
    for (let index = this.#sessions.length - 1; index >= 0; index -= 1) {
      const record = this.#sessions[index]
      if (record?.key === pending.key && record.agentId === pending.agentId) {
        this.#sessions.splice(index, 1)
      }
    }
  }

  recordResult(
    decision: JournalMiss,
    result: unknown,
    options: { successful?: boolean; coverageGap?: boolean } = {},
  ): void {
    const pending = this.#pending.get(decision.callIndex)
    if (
      !pending ||
      pending.completed ||
      pending.key !== decision.key ||
      pending.agentId !== decision.agentId
    ) {
      throw new Error('Journal result does not belong to an unfinished call in this run')
    }

    if (options.coverageGap === true) {
      if (options.successful !== false || !isWorkflowAgentFailurePlaceholder(result)) {
        throw new TypeError(
          'Journal coverage-gap results must be unsuccessful versioned workflow failure placeholders',
        )
      }
      // WHY terminal disposition and session invalidation share one journal mutation: a durable
      // adapter persists recordResult only after this method returns. Performing a separate
      // discard first leaves a crash window containing an unfinished call with no session, which
      // automatic recovery would replay even though policy had already classified it unsafe.
      // Mutating both pieces here makes one persistent snapshot the linearization point.
      for (let index = this.#sessions.length - 1; index >= 0; index -= 1) {
        const record = this.#sessions[index]
        if (record?.key === pending.key && record.agentId === pending.agentId) {
          this.#sessions.splice(index, 1)
        }
      }
    }
    pending.completed = true
    this.#records.push({
      type: 'result',
      key: pending.key,
      agentId: pending.agentId,
      result,
      successful: options.successful ?? result !== null,
      ...(options.coverageGap === true ? { coverageGap: true } : {}),
    })
  }

  snapshot(): JournalSnapshot {
    return {
      ...this.#identity,
      records: [...this.#records],
      ...(this.#sessions.length === 0
        ? {}
        : { sessions: this.#sessions.map((record) => ({ ...record, session: { ...record.session } })) }),
      ...(this.#importedCalls.length === 0
        ? {}
        : { importedCalls: this.#importedCalls.map((record) => ({ ...record })) }),
    }
  }
}

export class InMemoryWorkflowJournal implements WorkflowJournal {
  readonly #snapshots = new Map<string, JournalSnapshot>()

  constructor(snapshots: Iterable<JournalSnapshot> = []) {
    for (const snapshot of snapshots) {
      for (const record of snapshot.records) assertCoverageGapRecord(record)
      assertImportedCalls(snapshot)
      this.#snapshots.set(snapshot.workflowId, copySnapshot(snapshot))
    }
  }

  beginRun(
    identity: JournalIdentity,
    options: { reuseMode?: JournalReuseMode; reuseCoverageGaps?: boolean } = {},
  ): WorkflowJournalRun {
    if (identity.workflowId.length === 0) throw new TypeError('Journal workflowId must not be empty')
    if (identity.sourceHash.length === 0) throw new TypeError('Journal sourceHash must not be empty')

    const previous = this.#snapshots.get(identity.workflowId)
    const retainSparseHistory =
      options.reuseMode === 'exact-source-sparse' &&
      previous !== undefined &&
      previous.sourceHash === identity.sourceHash
    // WHY sparse recovery starts with the complete predecessor: if this host crashes after
    // re-admitting only the first sibling, an empty current generation would erase successful
    // siblings later in the deterministic call order. InMemoryWorkflowJournalRun replaces visited
    // keys in place, so the retained tail is durable without accumulating duplicate generations.
    const records: JournalRecord[] = retainSparseHistory
      ? previous.records.map((record) => ({ ...record }))
      : []
    const sessions: JournalSessionRecord[] = retainSparseHistory
      ? (previous.sessions ?? []).map((record) => ({ ...record, session: { ...record.session } }))
      : []
    const importedCalls: JournalImportedCall[] = retainSparseHistory
      ? (previous.importedCalls ?? []).map((record) => ({ ...record }))
      : []
    // Install the new append-only record array immediately. If the process stops after admission but
    // before provider completion, getSnapshot() must expose the started-only record that forces respawn.
    const current: JournalSnapshot = {
      ...identity,
      records,
      sessions,
      ...(previous?.importedCalls === undefined ? {} : { importedCalls }),
    }
    this.#snapshots.set(identity.workflowId, current)
    return new InMemoryWorkflowJournalRun(
      identity,
      previous,
      records,
      sessions,
      importedCalls,
      options.reuseMode ?? 'longest-prefix',
      retainSparseHistory,
      options.reuseCoverageGaps ?? false,
    )
  }

  getSnapshot(workflowId: string): JournalSnapshot | undefined {
    const snapshot = this.#snapshots.get(workflowId)
    return snapshot ? copySnapshot(snapshot) : undefined
  }

  getSnapshots(): readonly JournalSnapshot[] {
    return [...this.#snapshots.values()].map(copySnapshot)
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
    ...(snapshot.importedCalls === undefined
      ? {}
      : { importedCalls: snapshot.importedCalls.map((record) => ({ ...record })) }),
  }
}
