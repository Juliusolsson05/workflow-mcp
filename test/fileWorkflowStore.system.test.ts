import { appendFile, chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { FileWorkflowStore } from '../src/fileWorkflowStore.js'
import { parseWorkflowSource } from '../src/loadWorkflow.js'
import { PersistentWorkflowJournal } from '../src/persistentWorkflowJournal.js'
import type { WorkflowEvent } from '../src/workflowEvents.js'
import { createJournalKey } from '../src/workflowJournal.js'

function loaded() {
  return parseWorkflowSource(`export const meta = { name: 'stored', description: 'Stored workflow' }
    return 'ok'`)
}

function started(runId: string): WorkflowEvent {
  return {
    schemaVersion: 1,
    runId,
    sequence: 1,
    eventId: 'event-1',
    timestamp: new Date().toISOString(),
    type: 'run.started',
    payload: { workflow: { name: 'stored', description: 'Stored workflow' } },
  }
}

function event(runId: string, sequence: number, type: WorkflowEvent['type'], payload: unknown): WorkflowEvent {
  return {
    schemaVersion: 1,
    runId,
    sequence,
    eventId: `event-${sequence}`,
    timestamp: new Date().toISOString(),
    type,
    payload,
  } as WorkflowEvent
}

describe('FileWorkflowStore', () => {
  it('publishes a successor manifest only after inherited journal lineage is seeded', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-store-journal-seed-'))
    const store = new FileWorkflowStore(root)
    await store.acquireLease('seeded-successor')
    await store.initialize()
    const key = createJournalKey('', 'already complete')
    await store.createRun({
      runId: 'run_seeded',
      cwd: root,
      workflow: loaded(),
      journalSnapshots: [{
        workflowId: 'root',
        sourceHash: 'root-source',
        records: [
          { type: 'started', key, agentId: 'old' },
          { type: 'result', key, agentId: 'old', result: 'done', successful: true },
        ],
      }],
    })

    const journal = JSON.parse(
      await readFile(join(root, 'runs', 'run_seeded', 'transcripts', 'journal.jsonl'), 'utf8'),
    ) as { version: number; snapshots: Array<{ workflowId: string }> }
    expect(journal).toMatchObject({ version: 2, snapshots: [{ workflowId: 'root' }] })
    await expect(store.getManifest('run_seeded')).resolves.toMatchObject({ status: 'queued' })
  })

  it('fsyncs append-only events and reconstructs a reducer snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-store-'))
    const store = new FileWorkflowStore(root)
    await store.acquireLease('test-store')
    await store.initialize()
    await store.createRun({ runId: 'run_store', cwd: root, workflow: loaded(), args: { a: 1 } })

    const stored = await store.appendEvent('run_store', started('run_store'))
    const page = await store.readEvents('run_store', 0, 10)
    const snapshot = await store.snapshot('run_store')

    expect(stored.cursor).toBe(1)
    expect(page).toMatchObject({ fromCursor: 0, toCursor: 1, hasMore: false })
    await expect(store.readEvents('run_store', 1, 10)).resolves.toMatchObject({
      fromCursor: 1,
      toCursor: 1,
      events: [],
      hasMore: false,
    })
    await expect(store.readEvents('run_store', 2, 10)).rejects.toMatchObject({
      code: 'cursor-ahead',
    })
    expect(snapshot).toMatchObject({ cursor: 1, state: { status: 'running', sequence: 1 } })
    await expect(store.loadArgs('run_store')).resolves.toEqual({ provided: true, value: { a: 1 } })
  })

  it('fences store and persistent-journal writers before releasing ownership', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-store-writer-fence-'))
    const store = new FileWorkflowStore(root)
    const lease = await store.acquireLease('fenced-writer')
    await store.initialize()
    await store.createRun({ runId: 'run_fenced', cwd: root, workflow: loaded() })
    const journal = await PersistentWorkflowJournal.open(
      store.journalPath('run_fenced'),
      [],
      store.journalWriteCoordinator(),
    )
    const run = journal.beginRun({ workflowId: 'root', sourceHash: loaded().sourceHash })
    run.admit({ agentId: 'agent_1', prompt: 'before release' })

    await lease.release()

    await expect(store.appendEvent('run_fenced', started('run_fenced'))).rejects.toMatchObject({
      code: 'owner-conflict',
    })
    expect(() => run.admit({ agentId: 'agent_2', prompt: 'after release' })).toThrow(
      expect.objectContaining({ code: 'owner-conflict' }),
    )
  })

  it('paginates a path-redacted run inventory with filter-bound keyset cursors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-store-inventory-'))
    const store = new FileWorkflowStore(root)
    await store.acquireLease('inventory-writer')
    await store.initialize()
    for (const runId of ['run_a', 'run_b', 'run_c']) {
      await store.createRun({ runId, cwd: join(root, 'private-project'), workflow: loaded() })
    }
    await store.appendEvent('run_b', started('run_b'))

    const collected: string[] = []
    let cursor: string | undefined
    do {
      const page = await store.listRuns({ limit: 1, ...(cursor === undefined ? {} : { cursor }) })
      collected.push(...page.items.map(item => item.runId))
      expect(JSON.stringify(page.items)).not.toContain('private-project')
      cursor = page.nextCursor
      if (!page.hasMore) break
    } while (true)
    expect(collected).toEqual(['run_a', 'run_b', 'run_c'])

    const running = await store.listRuns({ statuses: ['running'], limit: 10 })
    expect(running.items).toEqual([expect.objectContaining({ runId: 'run_b', status: 'running' })])
    const first = await store.listRuns({ limit: 1 })
    await expect(store.listRuns({
      cursor: first.nextCursor!,
      limit: 1,
      statuses: ['running'],
    })).rejects.toMatchObject({ code: 'invalid-cursor' })
  })

  it('truncates only a torn final JSONL append during startup recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-store-recover-'))
    const store = new FileWorkflowStore(root)
    const lease = await store.acquireLease('seed-store')
    await store.initialize()
    await store.createRun({ runId: 'run_recover', cwd: root, workflow: loaded() })
    await store.appendEvent('run_recover', started('run_recover'))
    await appendFile(join(root, 'runs', 'run_recover', 'events.jsonl'), '{"runId":"run_recover"')
    await lease.release()

    const reopened = new FileWorkflowStore(root)
    await reopened.acquireLease('recovery-store')
    await reopened.initialize()

    await expect(reopened.readEvents('run_recover', 0, 10)).resolves.toMatchObject({
      toCursor: 1,
      hasMore: false,
      events: [{ cursor: 1 }],
    })
  })

  it('quarantines corruption before the final torn record without blocking healthy runs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-store-corrupt-'))
    const store = new FileWorkflowStore(root)
    const lease = await store.acquireLease('seed-store')
    await store.initialize()
    await store.createRun({ runId: 'run_corrupt', cwd: root, workflow: loaded() })
    await store.appendEvent('run_corrupt', started('run_corrupt'))
    await appendFile(join(root, 'runs', 'run_corrupt', 'events.jsonl'), '{bad json}\n{"also":"data"}\n')
    await store.createRun({ runId: 'run_healthy', cwd: root, workflow: loaded() })
    await store.appendEvent('run_healthy', started('run_healthy'))
    await lease.release()

    const reopened = new FileWorkflowStore(root)
    await reopened.acquireLease('corruption-reader')
    await expect(reopened.initialize()).resolves.toBeUndefined()
    expect(reopened.listQuarantinedRuns()).toContainEqual(expect.objectContaining({
      runId: 'run_corrupt',
      code: 'corrupt-store',
    }))
    await expect(reopened.getManifest('run_corrupt')).rejects.toMatchObject({ code: 'corrupt-store' })
    await expect(reopened.readEvents('run_healthy', 0, 10)).resolves.toMatchObject({ toCursor: 1 })
    await expect(reopened.listManifests()).resolves.toEqual([
      expect.objectContaining({ runId: 'run_healthy' }),
    ])
  })

  it('rejects a projected cap-crossing append and keeps every acknowledged cursor readable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-store-cap-'))
    const store = new FileWorkflowStore(root, { maxEventFileBytes: 900 })
    const lease = await store.acquireLease('cap-writer')
    await store.initialize()
    await store.createRun({ runId: 'run_capped', cwd: root, workflow: loaded() })
    await store.createRun({ runId: 'run_other', cwd: root, workflow: loaded() })
    await store.appendEvent('run_capped', started('run_capped'))
    await store.appendEvent('run_other', started('run_other'))
    const oversized: WorkflowEvent = {
      schemaVersion: 1,
      runId: 'run_capped',
      sequence: 2,
      eventId: 'event-too-large',
      timestamp: new Date().toISOString(),
      type: 'warning',
      payload: { message: 'x'.repeat(800) },
    }
    await expect(store.appendEvent('run_capped', oversized)).rejects.toMatchObject({
      code: 'event-log-full',
    })
    await expect(store.readEvents('run_capped', 0, 10)).resolves.toMatchObject({
      toCursor: 1,
      hasMore: false,
    })
    await lease.release()

    const reopened = new FileWorkflowStore(root, { maxEventFileBytes: 900 })
    await reopened.acquireLease('cap-reader')
    await expect(reopened.initialize()).resolves.toBeUndefined()
    expect(reopened.listQuarantinedRuns()).toEqual([])
    await expect(reopened.readEvents('run_capped', 0, 10)).resolves.toMatchObject({ toCursor: 1 })
    await expect(reopened.readEvents('run_other', 0, 10)).resolves.toMatchObject({ toCursor: 1 })
  })

  it('rebuilds a stale manifest from events that were fsynced before a crash', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-store-manifest-'))
    const store = new FileWorkflowStore(root)
    const lease = await store.acquireLease('seed-store')
    await store.initialize()
    await store.createRun({ runId: 'run_manifest', cwd: root, workflow: loaded() })
    await store.appendEvent('run_manifest', started('run_manifest'))
    const completed: WorkflowEvent = {
      schemaVersion: 1,
      runId: 'run_manifest',
      sequence: 2,
      eventId: 'event-2',
      timestamp: new Date().toISOString(),
      type: 'run.completed',
      payload: { result: { preview: 'ok', lineCount: 1, content: 'ok' } },
    }
    await appendFile(
      join(root, 'runs', 'run_manifest', 'events.jsonl'),
      `${JSON.stringify({
        runId: 'run_manifest',
        cursor: 2,
        recordedAt: new Date().toISOString(),
        event: completed,
      })}\n`,
    )
    await lease.release()

    const reopened = new FileWorkflowStore(root)
    await reopened.acquireLease('recovery-store')
    await reopened.initialize()
    await expect(reopened.getManifest('run_manifest')).resolves.toMatchObject({
      cursor: 2,
      status: 'completed',
    })
  })

  it('persists an immutable result and streams UTF-8-safe checksum-bound pages after restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-store-result-'))
    const store = new FileWorkflowStore(root)
    const lease = await store.acquireLease('result-writer')
    await store.initialize()
    await store.createRun({ runId: 'run_result', cwd: root, workflow: loaded() })
    const serializedContent = `\uFEFF${'😀'.repeat(5)}\nsecond line\nthird line`
    const reference = await store.persistResult('run_result', {
      serializedContent,
      reference: {
        preview: serializedContent.slice(0, 4),
        content: serializedContent.slice(0, 10),
        mediaType: 'text/plain',
        lineCount: 3,
        truncated: true,
      },
    })
    expect(reference).toMatchObject({
      artifactId: expect.stringMatching(/^result_sha256_[a-f0-9]{64}$/),
      mediaType: 'text/plain',
      sizeBytes: Buffer.byteLength(serializedContent),
      lineCount: 3,
      checksum: { algorithm: 'sha256', value: expect.stringMatching(/^[a-f0-9]{64}$/) },
    })
    await lease.release()

    const reopened = new FileWorkflowStore(root)
    await reopened.acquireLease('result-reader')
    await reopened.initialize()
    let cursor: string | undefined
    let reconstructed = ''
    do {
      const page = await reopened.readResult('run_result', {
        artifactId: reference.artifactId!,
        maxBytes: 4,
        ...(cursor === undefined ? {} : { cursor }),
      })
      expect(Buffer.byteLength(page.content, 'utf8')).toBeLessThanOrEqual(4)
      expect(page.content).not.toContain('\uFFFD')
      reconstructed += page.content
      cursor = page.nextCursor
      if (!page.hasMore) break
      expect(cursor).toEqual(expect.any(String))
    } while (true)
    expect(reconstructed).toBe(serializedContent)
  })

  it('rejects stale, forged, and non-boundary result cursors without using artifact IDs as paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-store-result-cursor-'))
    const store = new FileWorkflowStore(root)
    await store.acquireLease('cursor-writer')
    await store.initialize()
    await store.createRun({ runId: 'run_cursor', cwd: root, workflow: loaded() })
    const reference = await store.persistResult('run_cursor', {
      serializedContent: '😀suffix',
      reference: {
        preview: '😀suffix',
        content: '😀suffix',
        mediaType: 'text/plain',
        lineCount: 1,
      },
    })
    const digest = reference.checksum!.value

    await expect(store.readResult('run_cursor', {
      artifactId: '../manifest.json',
      maxBytes: 16,
    })).rejects.toMatchObject({ code: 'result-not-found' })
    await expect(store.readResult('../run_cursor', {
      artifactId: reference.artifactId!,
      maxBytes: 16,
    })).rejects.toThrow(/Invalid workflow run ID/)
    await expect(store.readResult('run_cursor', {
      artifactId: reference.artifactId!,
      cursor: 'not-a-cursor',
      maxBytes: 16,
    })).rejects.toMatchObject({ code: 'invalid-cursor' })
    await expect(store.readResult('run_cursor', {
      artifactId: reference.artifactId!,
      cursor: `v1.${'0'.repeat(64)}.0`,
      maxBytes: 16,
    })).rejects.toMatchObject({ code: 'invalid-cursor' })
    await expect(store.readResult('run_cursor', {
      artifactId: reference.artifactId!,
      cursor: `v1.${digest}.1`,
      maxBytes: 16,
    })).rejects.toMatchObject({ code: 'invalid-cursor' })
  })

  it('fails before completion when a result exceeds its durable storage bound', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-store-result-cap-'))
    const store = new FileWorkflowStore(root, { maxResultBytes: 4 })
    await store.acquireLease('result-cap-writer')
    await store.initialize()
    await store.createRun({ runId: 'run_result_cap', cwd: root, workflow: loaded() })

    await expect(store.persistResult('run_result_cap', {
      serializedContent: '12345',
      reference: {
        preview: '12345',
        content: '12345',
        mediaType: 'text/plain',
        lineCount: 1,
      },
    })).rejects.toMatchObject({ code: 'result-too-large' })
    await expect(store.getManifest('run_result_cap')).resolves.toMatchObject({ status: 'queued' })
  })

  it('rejects a top-level string which cannot round-trip through UTF-8', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-store-result-utf8-'))
    const store = new FileWorkflowStore(root)
    await store.acquireLease('result-utf8-writer')
    await store.initialize()
    await store.createRun({ runId: 'run_result_utf8', cwd: root, workflow: loaded() })

    await expect(store.persistResult('run_result_utf8', {
      serializedContent: '\uD800',
      reference: {
        preview: '\uD800',
        content: '\uD800',
        mediaType: 'text/plain',
        lineCount: 1,
      },
    })).rejects.toMatchObject({ code: 'invalid-result' })
  })

  it('reports a published result whose retained bytes were removed as missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-store-result-missing-'))
    const store = new FileWorkflowStore(root)
    await store.acquireLease('result-missing-writer')
    await store.initialize()
    await store.createRun({ runId: 'run_result_missing', cwd: root, workflow: loaded() })
    const reference = await store.persistResult('run_result_missing', {
      serializedContent: 'retained',
      reference: {
        preview: 'retained',
        content: 'retained',
        mediaType: 'text/plain',
        lineCount: 1,
      },
    })
    await unlink(join(root, 'runs', 'run_result_missing', 'artifacts', 'workflow-result.data'))

    await expect(store.readResult('run_result_missing', {
      artifactId: reference.artifactId!,
      maxBytes: 16,
    })).rejects.toMatchObject({ code: 'result-not-found' })
  })
})

describe('FileWorkflowStore.deleteRun (agent-code #1275)', () => {
  async function storeWithLineage() {
    const root = await mkdtemp(join(tmpdir(), 'workflow-store-delete-'))
    const store = new FileWorkflowStore(root)
    const lease = await store.acquireLease('retention-test')
    await store.initialize()
    // An interrupted run and its (cancelled) successor, created through the real paths.
    await store.createRun({ runId: 'run_first', cwd: root, workflow: loaded() })
    await store.appendEvent('run_first', started('run_first'))
    await store.appendEvent('run_first', event('run_first', 2, 'run.interrupted', { reason: 'fixture' }))
    await store.createRun({
      runId: 'run_second', cwd: root, workflow: loaded(), resumedFromRunId: 'run_first', lineageId: 'run_first',
    })
    await store.appendEvent('run_second', started('run_second'))
    await store.appendEvent('run_second', event('run_second', 2, 'run.cancelled', { reason: 'fixture' }))
    await store.createRun({ runId: 'run_live', cwd: root, workflow: loaded() })
    await store.appendEvent('run_live', started('run_live'))
    return { root, store, lease }
  }

  it('removes a terminal run from disk and from every index', async () => {
    const { root, store, lease } = await storeWithLineage()
    await expect(store.findLatestSuccessor('run_first')).resolves.toMatchObject({ runId: 'run_second' })
    await store.deleteRun('run_second')
    await expect(stat(join(root, 'runs', 'run_second'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(store.getManifest('run_second')).resolves.toBeUndefined()
    await expect(store.findLatestSuccessor('run_first')).resolves.toBeUndefined()
    const all = await store.listRuns({ limit: 10 })
    expect(all.items.map(item => item.runId)).toEqual(['run_first', 'run_live'])
    const cancelled = await store.listRuns({ statuses: ['cancelled'], limit: 10 })
    expect(cancelled.items).toEqual([])
    // A deleted run leaves nothing that a fresh store would index either.
    await lease.release()
    const reopened = new FileWorkflowStore(root)
    await reopened.acquireLease('retention-reopen')
    await reopened.initialize()
    expect((await reopened.listRuns({ limit: 10 })).items.map(item => item.runId)).toEqual(['run_first', 'run_live'])
  })

  it('refuses a run that is still live, and one that does not exist', async () => {
    const { root, store } = await storeWithLineage()
    await expect(store.deleteRun('run_live')).rejects.toMatchObject({ code: 'run-not-terminal' })
    expect((await stat(join(root, 'runs', 'run_live'))).isDirectory()).toBe(true)
    await expect(store.deleteRun('run_missing')).rejects.toMatchObject({ code: 'run-not-found' })
    await expect(store.deleteRun('../escape')).rejects.toThrow(/Invalid workflow run ID/)
  })

  // Review of #65: a delete issued while the append that ENDS the run is in flight waits for it
  // (it joins the run's append tail), then deletes — never refuses a run that is about to be
  // terminal, and never races it (the deterministic interleavings are in
  // fileWorkflowStore.deleteRace.system.test.ts).
  it('waits for the append that ends the run, then deletes it', async () => {
    const { store } = await storeWithLineage()
    const append = store.appendEvent('run_live', event('run_live', 2, 'run.cancelled', { reason: 'fixture' }))
    await store.deleteRun('run_live')
    await append
    await expect(store.getManifest('run_live')).resolves.toBeUndefined()
    expect((await store.listRuns({ limit: 10 })).items.map(item => item.runId)).not.toContain('run_live')
  })

  // Rounds 1-3 of #65. deleteRun renames the run to `runs/.deleted-…` (atomic, same parent) before
  // removing anything, so a run is either whole under its name or gone from it; initialize sweeps
  // whatever the removal could not reclaim. These three helpers observe that from outside.
  async function runsEntries(root: string): Promise<string[]> {
    return (await readdir(join(root, 'runs'))).sort()
  }
  async function reopen(root: string, lease: { release(): Promise<void> }) {
    await lease.release()
    const store = new FileWorkflowStore(root)
    const nextLease = await store.acquireLease('retention-reopen')
    await store.initialize()
    return { store, lease: nextLease }
  }
  const listed = async (store: FileWorkflowStore) => (await store.listRuns({ limit: 10 })).items.map(item => item.runId)

  // Round 3 of #65 (reviewer C): rm unlinks entries one by one, so a removal that failed on a
  // locked subdirectory after manifest.json was gone left a manifest-less run directory. After a
  // restart no index held it, nothing quarantined it, and deleteRun said run-not-found: debris
  // no store call could ever remove. Now the run leaves its name first, and the leftovers are a
  // `.deleted-` directory that the next start reclaims.
  it('deletes a run whose removal fails part-way, and reclaims the leftovers on the next start', async () => {
    const { root, store, lease } = await storeWithLineage()
    const locked = join(root, 'runs', 'run_second', 'transcripts', 'locked')
    await mkdir(locked, { recursive: true })
    await writeFile(join(locked, 'agent.jsonl'), '{}\n')
    await chmod(locked, 0o500)
    let trash: string | undefined
    try {
      await store.deleteRun('run_second')
      expect(await listed(store)).not.toContain('run_second')
      await expect(stat(join(root, 'runs', 'run_second'))).rejects.toMatchObject({ code: 'ENOENT' })
      // The shape under test: the removal really did fail part-way and left bytes behind.
      trash = (await runsEntries(root)).find(name => name.startsWith('.deleted-run_second-'))
      expect(trash).toBeDefined()
      await expect(stat(join(root, 'runs', trash!, 'manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' })
      // Nothing that walks `runs/` may trip over the leftovers (a `.deleted-` name is not a run id).
      expect((await store.listManifests()).map(manifest => manifest.runId)).toEqual(['run_first', 'run_live'])
      // Round 4 (reviewer C): the leftovers are not silent. The caller can see them...
      expect(store.listUnreclaimedDeletions()).toEqual([trash])
      // ...and a restart while they are still locked neither indexes nor quarantines them, but
      // still reports them, and a reclaim says how many remain.
      const again = await reopen(root, lease)
      expect(await listed(again.store)).toEqual(['run_first', 'run_live'])
      expect(again.store.listQuarantinedRuns()).toEqual([])
      expect(again.store.listUnreclaimedDeletions()).toEqual([trash])
      await expect(again.store.reclaimDeletedRuns()).resolves.toEqual({ reclaimed: 0, remaining: 1 })
      await expect(again.store.deleteRun('run_second')).rejects.toMatchObject({ code: 'run-not-found' })
      await chmod(join(root, 'runs', trash!, 'transcripts', 'locked'), 0o700)
      // Once the leftovers can be removed, the next reclaim removes them...
      await expect(again.store.reclaimDeletedRuns()).resolves.toEqual({ reclaimed: 1, remaining: 0 })
      expect(again.store.listUnreclaimedDeletions()).toEqual([])
      expect(await runsEntries(root)).toEqual(['run_first', 'run_live'])
      // ...and a start with nothing left over reports nothing.
      const third = await reopen(root, again.lease)
      expect(third.store.listQuarantinedRuns()).toEqual([])
      expect(third.store.listUnreclaimedDeletions()).toEqual([])
    } finally {
      await chmod(trash === undefined ? locked : join(root, 'runs', trash, 'transcripts', 'locked'), 0o700).catch(() => undefined)
    }
  })

  // Round 5 of #65 (C): the sweep recursively removes what it matches, and a bare `.deleted-`
  // prefix erased an unrelated directory. Only names deleteRun generates are reclaimed; anything
  // else stays on disk and is quarantined, so it is visible rather than gone.
  it('never sweeps a directory whose name deleteRun could not have generated', async () => {
    const { root, lease } = await storeWithLineage()
    const unrelated = join(root, 'runs', '.deleted-unrelated')
    await mkdir(unrelated)
    await writeFile(join(unrelated, 'payload'), 'keep me')
    const reopened = await reopen(root, lease)
    await expect(readFile(join(unrelated, 'payload'), 'utf8')).resolves.toBe('keep me')
    expect(reopened.store.listQuarantinedRuns().map(entry => entry.runId)).toEqual(['.deleted-unrelated'])
    await expect(reopened.store.reclaimDeletedRuns()).resolves.toEqual({ reclaimed: 0, remaining: 0 })
    await expect(readFile(join(unrelated, 'payload'), 'utf8')).resolves.toBe('keep me')
  })

  // Round 5 of #65 (C), a surviving mutation: reclaiming mutates the store's disk, so it needs the
  // lease like every other write.
  it('refuses to reclaim without the lease', async () => {
    const { lease, store } = await storeWithLineage()
    await lease.release()
    await expect(store.reclaimDeletedRuns()).rejects.toMatchObject({ code: 'owner-conflict' })
  })

  // Rounds 1-2 of #65: a run whose directory cannot be moved (here `runs/` loses its write and
  // search permission between the manifest read and the move) must stay whole, indexed and
  // retryable — never hidden while it is still on disk.
  it('keeps a run indexed and retryable when it cannot be moved aside', async () => {
    const { root, store } = await storeWithLineage()
    const runs = join(root, 'runs')
    const read = store.getManifest.bind(store)
    const spy = vi.spyOn(store, 'getManifest').mockImplementationOnce(async (runId) => {
      const manifest = await read(runId)
      await chmod(runs, 0o000)
      return manifest
    })
    try {
      await expect(store.deleteRun('run_second')).rejects.toMatchObject({ code: 'io-error' })
    } finally {
      await chmod(runs, 0o700)
      spy.mockRestore()
    }
    expect(await listed(store)).toContain('run_second')
    await expect(store.getManifest('run_second')).resolves.toMatchObject({ status: 'cancelled' })
    await store.deleteRun('run_second')
    expect(await listed(store)).not.toContain('run_second')
    expect(await runsEntries(root)).toEqual(['run_first', 'run_live'])
  })

  // Round 2 of #65: a run directory that lost its own permissions between the manifest read and
  // the removal. The same-parent move needs only `runs/` to be writable, so the run is deleted;
  // its unreadable bytes wait in `.deleted-` for a start that can remove them.
  it('deletes a run whose own directory became unreadable', async () => {
    const { root, store, lease } = await storeWithLineage()
    const directory = join(root, 'runs', 'run_second')
    const read = store.getManifest.bind(store)
    const spy = vi.spyOn(store, 'getManifest').mockImplementationOnce(async (runId) => {
      const manifest = await read(runId)
      await chmod(directory, 0o000)
      return manifest
    })
    let trash: string | undefined
    try {
      await store.deleteRun('run_second')
      expect(await listed(store)).not.toContain('run_second')
      trash = (await runsEntries(root)).find(name => name.startsWith('.deleted-run_second-'))
      expect(trash).toBeDefined()
    } finally {
      spy.mockRestore()
      await chmod(trash === undefined ? directory : join(root, 'runs', trash), 0o700).catch(() => undefined)
    }
    await reopen(root, lease)
    expect(await runsEntries(root)).toEqual(['run_first', 'run_live'])
  })

  // Round 2 of #65: the resume path reads workflow.js and args.json after its manifest check. A
  // delete landing in between surfaced a raw ENOENT; it is run-not-found like any deleted run.
  // A file missing next to a manifest that is still there is a broken run, not a deleted one.
  it.each(['loadWorkflow', 'loadArgs'] as const)('%s reports a run deleted under it as run-not-found', async (method) => {
    const { root, store } = await storeWithLineage()
    const read = store.getManifest.bind(store)
    vi.spyOn(store, 'getManifest').mockImplementationOnce(async (runId) => {
      const manifest = await read(runId)
      await rm(join(root, 'runs', runId), { recursive: true, force: true })
      return manifest
    })
    await expect(store[method]('run_second')).rejects.toMatchObject({ code: 'run-not-found' })
    await unlink(join(root, 'runs', 'run_first', method === 'loadWorkflow' ? 'workflow.js' : 'args.json'))
    await expect(store[method]('run_first')).rejects.toMatchObject({ code: 'corrupt-store' })
  })

  // The per-run caches are keyed by run id. A run recreated under a deleted id must
  // never be served the deleted run's snapshot or event byte offsets.
  it('serves nothing cached from a deleted run to a new run with the same id', async () => {
    const { root, store } = await storeWithLineage()
    const before = await store.snapshot('run_second')
    expect(before.state.status).toBe('cancelled')
    await store.readEvents('run_second', 0, 10)
    await store.deleteRun('run_second')
    await store.createRun({ runId: 'run_second', cwd: root, workflow: loaded() })
    await store.appendEvent('run_second', started('run_second'))
    await store.appendEvent('run_second', event('run_second', 2, 'run.failed', {
      error: { code: 'fixture', message: 'the recreated run' },
    }))
    const after = await store.snapshot('run_second')
    expect(after.state.status).toBe('failed')
    const page = await store.readEvents('run_second', 0, 10)
    expect(page.events.map(stored => stored.event.type)).toEqual(['run.started', 'run.failed'])
  })

  it('cannot delete after the lease is released', async () => {
    const { root, store, lease } = await storeWithLineage()
    await lease.release()
    await expect(store.deleteRun('run_second')).rejects.toMatchObject({ code: 'owner-conflict' })
    expect((await stat(join(root, 'runs', 'run_second'))).isDirectory()).toBe(true)
  })
})
