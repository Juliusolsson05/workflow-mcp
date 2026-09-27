import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

// Deterministic interleavings for FileWorkflowStore.deleteRun (review of workflow-mcp#65). The store's
// own fs/promises calls get a gate that can park ONE call at an exact await point, so each race runs
// the same way every time instead of depending on scheduling. Nothing else about the file system is
// faked.
const gate = vi.hoisted(() => ({
  park: null as null | { call: 'chmod' | 'stat'; match: (path: string) => boolean; reached: () => void; release: Promise<void> },
}))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const parked = <F extends (path: never, ...rest: never[]) => Promise<unknown>>(call: 'chmod' | 'stat', fn: F) =>
    (async (path: never, ...rest: never[]) => {
      const park = gate.park
      if (park?.call === call && park.match(String(path))) {
        gate.park = null
        // chmod parks AFTER the manifest rename (the real gap the reviewer found); stat parks after
        // the real stat has succeeded, i.e. after the reader's "the file is there" check.
        const result = await fn(path, ...rest)
        park.reached()
        await park.release
        return result
      }
      return fn(path, ...rest)
    }) as unknown as F
  return { ...actual, chmod: parked('chmod', actual.chmod), stat: parked('stat', actual.stat) }
})

const { FileWorkflowStore } = await import('../src/fileWorkflowStore.js')
const { parseWorkflowSource } = await import('../src/loadWorkflow.js')
type WorkflowEvent = import('../src/workflowEvents.js').WorkflowEvent

function loaded() {
  return parseWorkflowSource(`export const meta = { name: 'raced', description: 'Race fixture' }
    return 'ok'`)
}

function event(runId: string, sequence: number, type: WorkflowEvent['type'], payload: unknown): WorkflowEvent {
  return { schemaVersion: 1, runId, sequence, eventId: `event-${sequence}`, timestamp: new Date().toISOString(), type, payload } as WorkflowEvent
}

function park(call: 'chmod' | 'stat', match: (path: string) => boolean) {
  let reached!: () => void
  let release!: () => void
  const hit = new Promise<void>(resolve => { reached = resolve })
  const released = new Promise<void>(resolve => { release = resolve })
  gate.park = { call, match, reached, release: released }
  return { hit, release }
}

async function liveRun(runId: string) {
  const root = await mkdtemp(join(tmpdir(), 'workflow-store-delete-race-'))
  const store = new FileWorkflowStore(root)
  await store.acquireLease('delete-race')
  await store.initialize()
  await store.createRun({ runId, cwd: root, workflow: loaded() })
  await store.appendEvent(runId, event(runId, 1, 'run.started', { workflow: { name: 'raced', description: 'Race fixture' } }))
  return { root, store }
}

afterEach(() => { gate.park = null })

describe('deleteRun against concurrent writers and readers (review of #65)', () => {
  it('a delete during the ending append, after its manifest rename, leaves no ghost in listRuns', async () => {
    const { store } = await liveRun('run_raced')
    const parked = park('chmod', path => path.endsWith(join('run_raced', 'manifest.json')))
    const append = store.appendEvent('run_raced', event('run_raced', 2, 'run.cancelled', { reason: 'fixture' }))
    await parked.hit
    // The manifest on disk is terminal now; the append has not re-indexed yet.
    const deletion = store.deleteRun('run_raced')
    parked.release()
    await append
    await deletion
    expect((await store.listRuns({ limit: 10 })).items.map(item => item.runId)).not.toContain('run_raced')
    await expect(store.getManifest('run_raced')).resolves.toBeUndefined()
  })

  it('a reader whose file vanished under it gets run-not-found, not a raw ENOENT', async () => {
    const { root, store } = await liveRun('run_read')
    await store.appendEvent('run_read', event('run_read', 2, 'run.cancelled', { reason: 'fixture' }))
    const parked = park('stat', path => path === join(root, 'runs', 'run_read', 'events.jsonl'))
    const read = store.readEvents('run_read', 0, 10)
    await parked.hit
    await store.deleteRun('run_read')
    parked.release()
    await expect(read).rejects.toMatchObject({ code: expect.stringMatching(/run-not-found/) })
  })
})
