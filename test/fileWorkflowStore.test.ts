import { appendFile, mkdtemp, readFile } from 'node:fs/promises'
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
})
