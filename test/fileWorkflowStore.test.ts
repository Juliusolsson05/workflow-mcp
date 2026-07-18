import { appendFile, mkdtemp, readFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { FileWorkflowStore } from '../src/fileWorkflowStore.js'
import { parseWorkflowSource } from '../src/loadWorkflow.js'
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
    expect(snapshot).toMatchObject({ cursor: 1, state: { status: 'running', sequence: 1 } })
    await expect(store.loadArgs('run_store')).resolves.toEqual({ provided: true, value: { a: 1 } })
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
