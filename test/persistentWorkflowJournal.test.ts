import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  PersistentJournalError,
  PersistentWorkflowJournal,
} from '../src/persistentWorkflowJournal.js'
import { createJournalKey, type JournalMiss, type JournalSnapshot } from '../src/workflowJournal.js'

const identity = { workflowId: 'project:workflow', sourceHash: 'source-a' }

describe('PersistentWorkflowJournal', () => {
  it('combines an imported Claude prefix with new results and reuses both after reopening', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-persistent-journal-'))
    const filePath = join(root, 'resume.json')
    const firstKey = createJournalKey('', 'one')
    const imported: JournalSnapshot = {
      ...identity,
      records: [
        { type: 'started', key: firstKey, agentId: 'claude-first' },
        { type: 'result', key: firstKey, agentId: 'claude-first', result: 'one-result' },
      ],
    }
    const journal = await PersistentWorkflowJournal.open(filePath, [imported])
    const run = journal.beginRun(identity)
    expect(run.admit({ agentId: 'current-first', prompt: 'one' })).toMatchObject({
      reused: true,
      result: 'one-result',
    })
    const second = run.admit({ agentId: 'current-second', prompt: 'two' }) as JournalMiss
    run.recordResult(second, { value: 'two-result' })

    const reopened = await PersistentWorkflowJournal.open(filePath, [imported])
    expect(reopened.getSnapshot(identity.workflowId)?.records).toHaveLength(4)
    const resumed = reopened.beginRun(identity)
    expect(resumed.admit({ agentId: 'next-first', prompt: 'one' })).toMatchObject({
      reused: true,
      result: 'one-result',
    })
    expect(resumed.admit({ agentId: 'next-second', prompt: 'two' })).toMatchObject({
      reused: true,
      result: { value: 'two-result' },
    })

    const stored = JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>
    expect(stored).toMatchObject({ format: 'workflow-mcp-journal', version: 2 })
  })

  it('persists an interrupted provider session so the next run resumes that thread', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-persistent-session-'))
    const filePath = join(root, 'resume.json')
    const journal = await PersistentWorkflowJournal.open(filePath)
    const run = journal.beginRun(identity)
    const interrupted = run.admit({ agentId: 'old', prompt: 'inspect' }) as JournalMiss
    run.recordProviderSession(interrupted, { provider: 'codex', id: 'thread-1' })

    const reopened = await PersistentWorkflowJournal.open(filePath)
    expect(reopened.beginRun(identity).admit({ agentId: 'new', prompt: 'inspect' })).toMatchObject({
      reused: false,
      providerSession: { provider: 'codex', id: 'thread-1' },
    })
  })

  it('retains the unvisited tail of an imported prefix after interruption during replay', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-persistent-import-tail-'))
    const filePath = join(root, 'resume.json')
    const firstKey = createJournalKey('', 'one')
    const secondKey = createJournalKey(firstKey, 'two')
    const imported: JournalSnapshot = {
      ...identity,
      records: [
        { type: 'started', key: firstKey, agentId: 'claude-first' },
        { type: 'result', key: firstKey, agentId: 'claude-first', result: 'one-result' },
        { type: 'started', key: secondKey, agentId: 'claude-second' },
        { type: 'result', key: secondKey, agentId: 'claude-second', result: 'two-result' },
      ],
    }
    const firstAttempt = await PersistentWorkflowJournal.open(filePath, [imported])
    expect(firstAttempt.beginRun(identity).admit({ agentId: 'current-first', prompt: 'one' }).reused).toBe(
      true,
    )

    const resumed = (await PersistentWorkflowJournal.open(filePath, [imported])).beginRun(identity)
    expect(resumed.admit({ agentId: 'next-first', prompt: 'one' }).reused).toBe(true)
    expect(resumed.admit({ agentId: 'next-second', prompt: 'two' })).toMatchObject({
      reused: true,
      result: 'two-result',
    })
  })

  it('retains an unvisited exact-source sparse tail without receiving the fallback again', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-persistent-sparse-tail-'))
    const filePath = join(root, 'resume.json')
    const firstKey = createJournalKey('', 'one')
    const secondKey = createJournalKey(firstKey, 'two')
    const thirdKey = createJournalKey(secondKey, 'three')
    const inherited: JournalSnapshot = {
      ...identity,
      records: [
        { type: 'started', key: firstKey, agentId: 'old-one' },
        { type: 'result', key: firstKey, agentId: 'old-one', result: 'one-result' },
        { type: 'started', key: secondKey, agentId: 'old-two' },
        { type: 'result', key: secondKey, agentId: 'old-two', result: 'two-result' },
        { type: 'started', key: thirdKey, agentId: 'old-three' },
        { type: 'result', key: thirdKey, agentId: 'old-three', result: 'three-result' },
      ],
    }
    const replacement = await PersistentWorkflowJournal.open(filePath, [inherited])
    const partial = replacement.beginRun(identity, { reuseMode: 'exact-source-sparse' })
    expect(partial.admit({ agentId: 'replacement-one', prompt: 'one' }).reused).toBe(true)

    const next = (await PersistentWorkflowJournal.open(filePath)).beginRun(identity, {
      reuseMode: 'exact-source-sparse',
    })
    expect(next.admit({ agentId: 'next-one', prompt: 'one' }).reused).toBe(true)
    expect(next.admit({ agentId: 'next-two', prompt: 'two' })).toMatchObject({
      reused: true,
      result: 'two-result',
    })
    expect(next.admit({ agentId: 'next-three', prompt: 'three' })).toMatchObject({
      reused: true,
      result: 'three-result',
    })
  })

  it('persists root and nested workflow histories regardless of their mutation order', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-persistent-lineage-'))
    const identities = [
      { workflowId: 'project:root', sourceHash: 'root-source' },
      { workflowId: 'project:child', sourceHash: 'child-source' },
    ] as const

    for (const [index, order] of [identities, [...identities].reverse()].entries()) {
      const filePath = join(root, `lineage-${index}.json`)
      const journal = await PersistentWorkflowJournal.open(filePath)
      for (const current of order) {
        const run = journal.beginRun(current)
        const decision = run.admit({ agentId: `old-${current.workflowId}`, prompt: current.workflowId }) as JournalMiss
        run.recordResult(decision, `${current.workflowId}-result`)
      }

      const reopened = await PersistentWorkflowJournal.open(filePath)
      expect(reopened.getSnapshots().map((snapshot) => snapshot.workflowId).sort()).toEqual([
        'project:child',
        'project:root',
      ])
      for (const current of identities) {
        expect(
          reopened.beginRun(current).admit({
            agentId: `new-${current.workflowId}`,
            prompt: current.workflowId,
          }),
        ).toMatchObject({ reused: true, result: `${current.workflowId}-result` })
      }
    }
  })

  it('migrates a version-1 root snapshot before any new admission', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-persistent-v1-'))
    const filePath = join(root, 'resume.json')
    const key = createJournalKey('', 'legacy')
    await writeFile(filePath, `${JSON.stringify({
      format: 'workflow-mcp-journal',
      version: 1,
      snapshot: {
        ...identity,
        records: [
          { type: 'started', key, agentId: 'legacy-agent' },
          { type: 'result', key, agentId: 'legacy-agent', result: 'legacy-result' },
        ],
      },
    })}\n`)

    const journal = await PersistentWorkflowJournal.open(filePath)
    expect(journal.getSnapshot(identity.workflowId)).toBeDefined()
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toMatchObject({
      format: 'workflow-mcp-journal',
      version: 2,
      snapshots: [{ workflowId: identity.workflowId }],
    })
  })

  it('fails closed for corrupt files and source-mismatched sidecars', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-persistent-invalid-'))
    const filePath = join(root, 'resume.json')
    await writeFile(filePath, 'not json')
    await expect(PersistentWorkflowJournal.open(filePath)).rejects.toMatchObject<
      Partial<PersistentJournalError>
    >({ code: 'invalid-json' })

    const validPath = join(root, 'valid.json')
    const journal = await PersistentWorkflowJournal.open(validPath)
    journal.beginRun(identity).admit({ agentId: 'persisted', prompt: 'persist me' })
    await expect(
      PersistentWorkflowJournal.open(validPath, [{ ...identity, sourceHash: 'changed', records: [] }]),
    ).rejects.toMatchObject<Partial<PersistentJournalError>>({ code: 'source-mismatch' })
  })
})
