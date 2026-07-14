import { appendFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { FileWorkflowStore } from '../src/fileWorkflowStore.js'
import { parseWorkflowSource } from '../src/loadWorkflow.js'
import type { WorkflowEvent } from '../src/workflowEvents.js'

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
  it('fsyncs append-only events and reconstructs a reducer snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-store-'))
    const store = new FileWorkflowStore(root)
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
    await store.initialize()
    await store.createRun({ runId: 'run_recover', cwd: root, workflow: loaded() })
    await store.appendEvent('run_recover', started('run_recover'))
    await appendFile(join(root, 'runs', 'run_recover', 'events.jsonl'), '{"runId":"run_recover"')

    const reopened = new FileWorkflowStore(root)
    await reopened.initialize()

    await expect(reopened.readEvents('run_recover', 0, 10)).resolves.toMatchObject({
      toCursor: 1,
      hasMore: false,
      events: [{ cursor: 1 }],
    })
  })

  it('rejects corruption before the final torn record', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-store-corrupt-'))
    const store = new FileWorkflowStore(root)
    await store.initialize()
    await store.createRun({ runId: 'run_corrupt', cwd: root, workflow: loaded() })
    await store.appendEvent('run_corrupt', started('run_corrupt'))
    await appendFile(join(root, 'runs', 'run_corrupt', 'events.jsonl'), '{bad json}\n{"also":"data"}\n')

    await expect(new FileWorkflowStore(root).initialize()).rejects.toMatchObject({
      code: 'corrupt-store',
    })
  })

  it('rebuilds a stale manifest from events that were fsynced before a crash', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-store-manifest-'))
    const store = new FileWorkflowStore(root)
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

    const reopened = new FileWorkflowStore(root)
    await reopened.initialize()
    await expect(reopened.getManifest('run_manifest')).resolves.toMatchObject({
      cursor: 2,
      status: 'completed',
    })
  })
})
