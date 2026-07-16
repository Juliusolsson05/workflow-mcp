import { describe, expect, it } from 'vitest'

import {
  InMemoryWorkflowJournal,
  canonicalizeJournalValue,
  createJournalKey,
  type JournalAgentOptions,
  type JournalMiss,
  type JournalSnapshot,
} from '../src/workflowJournal.js'

const identity = { workflowId: 'project:review', sourceHash: 'source-a' }

function complete(
  journal: InMemoryWorkflowJournal,
  calls: ReadonlyArray<{
    prompt: string
    result: unknown
    options?: JournalAgentOptions
  }>,
): JournalSnapshot {
  const run = journal.beginRun(identity)
  calls.forEach((call, index) => {
    const decision = run.admit({
      agentId: `agent-${index}`,
      prompt: call.prompt,
      ...(call.options === undefined ? {} : { options: call.options }),
    })
    expect(decision.reused).toBe(false)
    run.recordResult(decision as JournalMiss, call.result)
  })
  return run.snapshot()
}

describe('journal key canonicalization', () => {
  it('sorts nested object keys while preserving array order and JSON function behavior', () => {
    expect(
      canonicalizeJournalValue({
        z: 1,
        a: {
          d: undefined,
          c: () => 'ignored',
          b: [{ z: 2, a: 1 }, () => 'array slot'],
        },
      }),
    ).toBe('{"a":{"b":[{"a":1,"z":2},null]},"z":1}')
  })

  it('matches JSON number semantics and rejects values JSON cannot persist deterministically', () => {
    expect(canonicalizeJournalValue({ negativeZero: -0, nan: Number.NaN, infinity: Infinity })).toBe(
      '{"infinity":null,"nan":null,"negativeZero":0}',
    )
    expect(() => canonicalizeJournalValue({ value: 1n })).toThrow(/bigint/)

    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(() => canonicalizeJournalValue(circular)).toThrow(/circular/)
  })

  it('produces a pinned v2 key and is independent of object insertion order', () => {
    const left = createJournalKey('', 'inspect', {
      schema: { required: ['name'], type: 'object', properties: { name: { type: 'string' } } },
      model: 'sonnet',
    })
    const right = createJournalKey('', 'inspect', {
      model: 'sonnet',
      schema: { properties: { name: { type: 'string' } }, type: 'object', required: ['name'] },
    })

    expect(left).toBe('v2:3226eede86adf0e56a931dbe2bc1a26d26ea074c6decbdaee315c25d4aaf5f0e')
    expect(right).toBe(left)
  })

  it.each(['schema', 'model', 'effort', 'isolation', 'agentType'] as const)(
    'includes execution-affecting option %s',
    (option) => {
      const baseline = createJournalKey('source:a', 'prompt', {})
      expect(createJournalKey('source:a', 'prompt', { [option]: 'changed' })).not.toBe(baseline)
    },
  )

  it('excludes labels, phases, unknown options, and function-valued known options', () => {
    const baseline = createJournalKey('source:a', 'prompt')
    expect(
      createJournalKey('source:a', 'prompt', {
        label: 'finder:one',
        phase: 'Find',
        futureUiHint: { expanded: true },
        model: () => 'not data',
      }),
    ).toBe(baseline)
  })

  it('changes when the prompt or preceding chain key changes', () => {
    const baseline = createJournalKey('source:a', 'prompt')
    expect(createJournalKey('source:a', 'different prompt')).not.toBe(baseline)
    expect(createJournalKey('source:b', 'prompt')).not.toBe(baseline)
  })
})

describe('InMemoryWorkflowJournal', () => {
  it('reuses terminal coverage gaps only for automatic crash recovery', () => {
    const journal = new InMemoryWorkflowJournal()
    const first = journal.beginRun(identity)
    const decision = first.admit({ agentId: 'casualty', prompt: 'inspect unsafe state' }) as JournalMiss
    const placeholder = {
      __workflowAgentFailure: {
        schemaVersion: 1,
        agentId: 'casualty',
        label: 'casualty',
        status: 'recovery_required',
        message: 'fixture coverage gap',
        attempts: 1,
        coverageGap: true,
      },
    }
    first.recordProviderSession(decision, { provider: 'codex', id: 'poisoned-gap-thread' })
    first.recordResult(decision, placeholder, { successful: false, coverageGap: true })

    const automatic = journal.beginRun(identity, { reuseCoverageGaps: true })
    expect(automatic.admit({ agentId: 'automatic', prompt: 'inspect unsafe state' })).toMatchObject({
      reused: true,
      coverageGap: true,
      result: placeholder,
    })
    expect(automatic.snapshot().records.at(-1)).toMatchObject({
      type: 'result',
      successful: false,
      coverageGap: true,
    })

    const manual = journal.beginRun(identity, {
      reuseMode: 'exact-source-sparse',
      reuseCoverageGaps: false,
    })
    expect(manual.admit({ agentId: 'manual', prompt: 'inspect unsafe state' })).toMatchObject({
      reused: false,
    })
    expect(manual.snapshot().sessions).toBeUndefined()
  })

  it('rejects malformed imported and newly recorded coverage gaps', () => {
    const key = createJournalKey('', 'corrupt')
    expect(() => new InMemoryWorkflowJournal([{
      ...identity,
      records: [
        { type: 'started', key, agentId: 'old' },
        {
          type: 'result',
          key,
          agentId: 'old',
          result: 'not a placeholder',
          successful: false,
          coverageGap: true,
        },
      ],
    }])).toThrow(/coverage-gap results/i)

    const journal = new InMemoryWorkflowJournal()
    const run = journal.beginRun(identity)
    const decision = run.admit({ agentId: 'new', prompt: 'corrupt' }) as JournalMiss
    expect(() => run.recordResult(decision, 'not a placeholder', {
      successful: false,
      coverageGap: true,
    })).toThrow(/coverage-gap results/i)
  })

  it('durably discards an abandoned provider session before a fresh retry', () => {
    const journal = new InMemoryWorkflowJournal()
    const first = journal.beginRun(identity)
    const decision = first.admit({ agentId: 'old', prompt: 'retry me' }) as JournalMiss
    first.recordProviderSession(decision, { provider: 'codex', id: 'poisoned-thread' })
    first.discardProviderSession(decision)

    expect(first.snapshot().sessions).toBeUndefined()
    const recovered = journal.beginRun(identity)
    const recoveredDecision = recovered.admit({ agentId: 'new', prompt: 'retry me' })
    expect(recoveredDecision.reused).toBe(false)
    expect('providerSession' in recoveredDecision).toBe(false)
  })

  it('reuses a complete unchanged prefix and materializes it into the new snapshot', () => {
    const journal = new InMemoryWorkflowJournal()
    complete(journal, [
      { prompt: 'one', result: { value: 1 } },
      { prompt: 'two', result: 'second' },
    ])

    const resumed = journal.beginRun(identity)
    const first = resumed.admit({ agentId: 'current-1', prompt: 'one' })
    const second = resumed.admit({ agentId: 'current-2', prompt: 'two' })

    expect(first).toMatchObject({ reused: true, result: { value: 1 }, sourceAgentId: 'agent-0' })
    expect(second).toMatchObject({ reused: true, result: 'second', sourceAgentId: 'agent-1' })
    expect(resumed.snapshot().records).toEqual([
      { type: 'started', key: first.key, agentId: 'current-1' },
      {
        type: 'result',
        key: first.key,
        agentId: 'current-1',
        result: { value: 1 },
        successful: true,
      },
      { type: 'started', key: second.key, agentId: 'current-2' },
      { type: 'result', key: second.key, agentId: 'current-2', result: 'second', successful: true },
    ])

    const third = journal.beginRun(identity)
    expect(third.admit({ agentId: 'third-1', prompt: 'one' }).reused).toBe(true)
    expect(third.admit({ agentId: 'third-2', prompt: 'two' }).reused).toBe(true)
  })

  it('reuses only the longest unchanged prefix', () => {
    const journal = new InMemoryWorkflowJournal()
    complete(journal, [
      { prompt: 'one', result: 1 },
      { prompt: 'two', result: 2 },
      { prompt: 'three', result: 3 },
    ])

    const resumed = journal.beginRun(identity)
    expect(resumed.admit({ agentId: 'a', prompt: 'one' }).reused).toBe(true)
    expect(resumed.admit({ agentId: 'b', prompt: 'changed' }).reused).toBe(false)
    expect(resumed.admit({ agentId: 'c', prompt: 'three' }).reused).toBe(false)
  })

  it('invalidates later exact keys after a null result causes the first miss', () => {
    const journal = new InMemoryWorkflowJournal()
    complete(journal, [
      { prompt: 'one', result: null },
      { prompt: 'two', result: 'historical-but-unsafe' },
    ])

    const resumed = journal.beginRun(identity)
    const first = resumed.admit({ agentId: 'a', prompt: 'one' })
    const second = resumed.admit({ agentId: 'b', prompt: 'two' })

    expect(first.reused).toBe(false)
    expect(second.reused).toBe(false)
  })

  it('treats a started call without a result as a miss and invalidates the suffix', () => {
    const journal = new InMemoryWorkflowJournal()
    const interrupted = journal.beginRun(identity)
    interrupted.admit({ agentId: 'old-1', prompt: 'one' })
    const oldSecond = interrupted.admit({ agentId: 'old-2', prompt: 'two' })
    interrupted.recordResult(oldSecond as JournalMiss, 'two')

    const resumed = journal.beginRun(identity)
    expect(resumed.admit({ agentId: 'new-1', prompt: 'one' }).reused).toBe(false)
    expect(resumed.admit({ agentId: 'new-2', prompt: 'two' }).reused).toBe(false)
  })

  it('reuses exact-source completed siblings beyond one interrupted call only in sparse recovery', () => {
    const original = new InMemoryWorkflowJournal()
    const interrupted = original.beginRun(identity)
    const decisions = Array.from({ length: 9 }, (_, index) => (
      interrupted.admit({ agentId: `old-${index}`, prompt: `call-${index}` }) as JournalMiss
    ))
    decisions.forEach((decision, index) => {
      if (index !== 4) interrupted.recordResult(decision, `result-${index}`)
    })
    const snapshot = interrupted.snapshot()

    const prefix = new InMemoryWorkflowJournal([snapshot]).beginRun(identity)
    const prefixHits = Array.from({ length: 9 }, (_, index) => (
      prefix.admit({ agentId: `prefix-${index}`, prompt: `call-${index}` }).reused
    ))
    expect(prefixHits).toEqual([true, true, true, true, false, false, false, false, false])

    const sparse = new InMemoryWorkflowJournal([snapshot]).beginRun(identity, {
      reuseMode: 'exact-source-sparse',
    })
    const sparseHits = Array.from({ length: 9 }, (_, index) => (
      sparse.admit({ agentId: `sparse-${index}`, prompt: `call-${index}` }).reused
    ))
    expect(sparseHits).toEqual([true, true, true, true, false, true, true, true, true])
  })

  it('distinguishes a successful null from the legacy provider-failure null sentinel', () => {
    const original = new InMemoryWorkflowJournal()
    const run = original.beginRun(identity)
    const decision = run.admit({ agentId: 'old', prompt: 'valid null' }) as JournalMiss
    run.recordResult(decision, null, { successful: true })

    const resumed = new InMemoryWorkflowJournal([run.snapshot()]).beginRun(identity)
    expect(resumed.admit({ agentId: 'new', prompt: 'valid null' })).toMatchObject({
      reused: true,
      result: null,
    })
  })

  it('does not invalidate for label, phase, or unknown-option changes', () => {
    const journal = new InMemoryWorkflowJournal()
    complete(journal, [
      {
        prompt: 'same',
        result: 'cached',
        options: { label: 'old label', phase: 'Old', unknown: 'old' },
      },
    ])

    const resumed = journal.beginRun(identity)
    expect(
      resumed.admit({
        agentId: 'new',
        prompt: 'same',
        options: { label: 'new label', phase: 'New', unknown: 'new' },
      }),
    ).toMatchObject({ reused: true, result: 'cached' })
  })

  it.each(['schema', 'model', 'effort', 'isolation', 'agentType'] as const)(
    'misses when %s changes',
    (option) => {
      const journal = new InMemoryWorkflowJournal()
      complete(journal, [{ prompt: 'same', result: 'cached', options: { [option]: 'old' } }])

      const resumed = journal.beginRun(identity)
      expect(
        resumed.admit({ agentId: 'new', prompt: 'same', options: { [option]: 'new' } }).reused,
      ).toBe(false)
    },
  )

  it('uses workflow identity as the namespace while edited source reuses unchanged call prefixes', () => {
    const journal = new InMemoryWorkflowJournal()
    const original = complete(journal, [{ prompt: 'same', result: 'cached' }])

    const differentSource = journal.beginRun({ ...identity, sourceHash: 'source-b' })
    const sourceHit = differentSource.admit({ agentId: 'new-source', prompt: 'same' })
    expect(sourceHit.reused).toBe(true)
    expect(sourceHit.key).toBe(original.records[0]?.key)

    const otherWorkflow = journal.beginRun({ workflowId: 'project:other', sourceHash: 'source-a' })
    const workflowMiss = otherWorkflow.admit({ agentId: 'new-workflow', prompt: 'same' })
    expect(workflowMiss.reused).toBe(false)
    // Workflow identity selects a history namespace; it is intentionally absent from the key itself.
    expect(workflowMiss.key).toBe(original.records[0]?.key)
  })

  it('invalidates around inserted and deleted calls', () => {
    const insertedJournal = new InMemoryWorkflowJournal()
    complete(insertedJournal, [
      { prompt: 'one', result: 1 },
      { prompt: 'two', result: 2 },
    ])
    const inserted = insertedJournal.beginRun(identity)
    expect(inserted.admit({ agentId: 'a', prompt: 'inserted' }).reused).toBe(false)
    expect(inserted.admit({ agentId: 'b', prompt: 'one' }).reused).toBe(false)
    expect(inserted.admit({ agentId: 'c', prompt: 'two' }).reused).toBe(false)

    const deletedJournal = new InMemoryWorkflowJournal()
    complete(deletedJournal, [
      { prompt: 'one', result: 1 },
      { prompt: 'two', result: 2 },
      { prompt: 'three', result: 3 },
    ])
    const deleted = deletedJournal.beginRun(identity)
    expect(deleted.admit({ agentId: 'a', prompt: 'one' }).reused).toBe(true)
    expect(deleted.admit({ agentId: 'c', prompt: 'three' }).reused).toBe(false)
  })

  it('records parallel completions in completion order while restoring calls in start order', () => {
    const journal = new InMemoryWorkflowJournal()
    const run = journal.beginRun(identity)
    const first = run.admit({ agentId: 'first', prompt: 'one' }) as JournalMiss
    const second = run.admit({ agentId: 'second', prompt: 'two' }) as JournalMiss
    run.recordResult(second, 'two')
    run.recordResult(first, 'one')

    const snapshot = run.snapshot()
    expect(snapshot.records.map((record) => `${record.type}:${record.agentId}`)).toEqual([
      'started:first',
      'started:second',
      'result:second',
      'result:first',
    ])

    const restored = new InMemoryWorkflowJournal([snapshot]).beginRun(identity)
    expect(restored.admit({ agentId: 'new-first', prompt: 'one' })).toMatchObject({
      reused: true,
      result: 'one',
    })
    expect(restored.admit({ agentId: 'new-second', prompt: 'two' })).toMatchObject({
      reused: true,
      result: 'two',
    })
  })

  it('restores parallel calls by their chained keys when persisted starts arrive out of order', () => {
    const firstKey = createJournalKey('', 'one')
    const secondKey = createJournalKey(firstKey, 'two')

    // Claude persists these records from concurrent scheduler callbacks. A faster second launch can
    // therefore reach the journal before the first launch even though workflow JavaScript admitted
    // them in the opposite order. Sorting or trusting file position would silently discard a valid
    // resume prefix; the chained key is the durable statement of logical order.
    const capturedClaudeSnapshot: JournalSnapshot = {
      ...identity,
      records: [
        { type: 'started', key: secondKey, agentId: 'old-second' },
        { type: 'started', key: firstKey, agentId: 'old-first' },
        { type: 'result', key: secondKey, agentId: 'old-second', result: 'two' },
        { type: 'result', key: firstKey, agentId: 'old-first', result: 'one' },
      ],
    }

    const restored = new InMemoryWorkflowJournal([capturedClaudeSnapshot]).beginRun(identity)
    expect(restored.admit({ agentId: 'new-first', prompt: 'one' })).toMatchObject({
      reused: true,
      result: 'one',
    })
    expect(restored.admit({ agentId: 'new-second', prompt: 'two' })).toMatchObject({
      reused: true,
      result: 'two',
    })
  })

  it('exposes interrupted state immediately and guards result ownership', () => {
    const journal = new InMemoryWorkflowJournal()
    const run = journal.beginRun(identity)
    const miss = run.admit({ agentId: 'agent', prompt: 'one' }) as JournalMiss

    expect(journal.getSnapshot(identity.workflowId)?.records).toEqual([
      { type: 'started', key: miss.key, agentId: 'agent' },
    ])

    run.recordResult(miss, 'done')
    expect(() => run.recordResult(miss, 'again')).toThrow(/unfinished call/)
    expect(() =>
      run.recordResult({ ...miss, key: createJournalKey('wrong', 'wrong') }, 'forged'),
    ).toThrow(/unfinished call/)
  })

  it('requires non-empty storage and source identities', () => {
    const journal = new InMemoryWorkflowJournal()
    expect(() => journal.beginRun({ workflowId: '', sourceHash: 'source' })).toThrow(/workflowId/)
    expect(() => journal.beginRun({ workflowId: 'workflow', sourceHash: '' })).toThrow(/sourceHash/)
  })
})
