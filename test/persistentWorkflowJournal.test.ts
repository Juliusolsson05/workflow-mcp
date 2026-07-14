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
    expect(stored).toMatchObject({ format: 'workflow-mcp-journal', version: 1 })
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
