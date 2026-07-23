import { createHash } from 'node:crypto'
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { prepareWorkflowDataLayout } from '../src/daemon/dataLayout.js'
import {
  createOfflineBackup,
  claimInterruptedRestore,
  commitHostBackup,
  restoreOfflineBackup,
  verifyOfflineBackup,
} from '../src/maintenance/backup.js'

const identity = Object.freeze({
  instanceId: '11111111-2222-3333-4444-555555555555',
  projectHash: 'a'.repeat(64),
})

describe('offline backup and restore', () => {
  it('round-trips private payload while excluding credentials and refusing identity transfer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-backup-'))
    const source = join(root, 'source')
    prepareWorkflowDataLayout(source)
    await writePrivate(join(source, 'store', 'evidence.txt'), 'durable evidence\n')
    await writePrivate(join(source, 'store', 'read-only.txt'), 'private read-only evidence\n')
    await chmod(join(source, 'store', 'read-only.txt'), 0o400)
    await writePrivate(join(source, 'secrets', 'mcp.token'), 'must-not-transfer\n')
    await writePrivate(join(source, 'codex-home', 'auth.json'), '{"secret":true}\n')
    const archive = join(root, 'instance.wmcp-backup')

    const created = await createOfflineBackup({ dataDirectory: source, outputPath: archive, identity })
    expect(created.entries).toBeGreaterThan(4)
    expect(await verifyOfflineBackup({ inputPath: archive, expectedIdentity: identity })).toEqual(created)
    await expect(verifyOfflineBackup({
      inputPath: archive,
      expectedIdentity: { ...identity, projectHash: 'b'.repeat(64) },
    })).rejects.toThrow(/identity does not match/)

    const restored = join(root, 'restored')
    await mkdir(join(restored, '.coordination'), { recursive: true, mode: 0o700 })
    await writePrivate(join(restored, '.coordination', 'owner.lock'), '')
    expect(await restoreOfflineBackup({
      dataDirectory: restored,
      inputPath: archive,
      identity,
    })).toEqual(created)
    expect(await readFile(join(restored, 'store', 'evidence.txt'), 'utf8')).toBe('durable evidence\n')
    expect(await readFile(join(restored, 'store', 'read-only.txt'), 'utf8')).toBe('private read-only evidence\n')
    await expect(access(join(restored, '.restore-in-progress.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(claimInterruptedRestore({ dataDirectory: restored, identity })).rejects.toThrow(/not marked/)
    await expect(access(join(restored, 'secrets', 'mcp.token'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(join(restored, 'codex-home', 'auth.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(restoreOfflineBackup({
      dataDirectory: restored,
      inputPath: archive,
      identity,
    })).rejects.toThrow(/not empty|unsupported state/)
  })

  it('rejects outer corruption and source symlinks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-backup-corrupt-'))
    const source = join(root, 'source')
    prepareWorkflowDataLayout(source)
    await writePrivate(join(source, 'store', 'value.txt'), 'value\n')
    const archive = join(root, 'good.wmcp-backup')
    await createOfflineBackup({ dataDirectory: source, outputPath: archive, identity })

    const corrupt = join(root, 'corrupt.wmcp-backup')
    await copyFile(archive, corrupt)
    await truncate(corrupt, Math.max(1, (await readFile(corrupt)).length - 8))
    const corruptBytes = await readFile(corrupt)
    await writeFile(
      `${corrupt}.sha256`,
      `${createHash('sha256').update(corruptBytes).digest('hex')}  ${basename(corrupt)}\n`,
      { mode: 0o600 },
    )
    await expect(verifyOfflineBackup({ inputPath: corrupt })).rejects.toThrow(/truncated|archive|unexpected/i)

    await symlink(join(source, 'layout.json'), join(source, 'store', 'redirect'))
    await expect(createOfflineBackup({
      dataDirectory: source,
      outputPath: join(root, 'symlink.wmcp-backup'),
      identity,
    })).rejects.toThrow(/ordinary single-link file/)
  })

  it('recognizes a partial pre-extraction marker as safely resettable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-restore-preparing-'))
    await writeFile(join(root, '.restore-in-progress.preparing'), '', { mode: 0o600 })
    await expect(claimInterruptedRestore({ dataDirectory: root, identity })).resolves.toBeUndefined()
    const claim = JSON.parse(await readFile(join(root, '.restore-reset-claimed.json'), 'utf8')) as unknown
    expect(claim).toMatchObject({ schemaVersion: 1, state: 'reset-claimed', ...identity })
    // A second reset invocation is an idempotent retry, but a new restore can no longer pass the
    // empty-target precondition after the first checker releases the shared owner flock.
    await expect(claimInterruptedRestore({ dataDirectory: root, identity })).resolves.toBeUndefined()
  })

  it('publishes host backup pairs durably without overwriting a concurrent destination', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-backup-commit-'))
    await writePrivate(join(root, 'archive.copy'), 'archive bytes')
    await writePrivate(join(root, 'checksum.copy'), 'checksum bytes')
    await commitHostBackup({
      directory: root,
      archiveTemporary: 'archive.copy',
      checksumTemporary: 'checksum.copy',
      archive: 'archive.backup',
      checksum: 'archive.backup.sha256',
    })
    expect(await readFile(join(root, 'archive.backup'), 'utf8')).toBe('archive bytes')
    expect(await readFile(join(root, 'archive.backup.sha256'), 'utf8')).toBe('checksum bytes')
    await writePrivate(join(root, 'archive.copy'), 'replacement')
    await writePrivate(join(root, 'checksum.copy'), 'replacement checksum')
    await expect(commitHostBackup({
      directory: root,
      archiveTemporary: 'archive.copy',
      checksumTemporary: 'checksum.copy',
      archive: 'archive.backup',
      checksum: 'archive.backup.sha256',
    })).rejects.toThrow(/already exists/)
  })

  it('rejects a 256-byte host leaf before filesystem operations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-backup-leaf-'))
    // NAME_MAX is a component limit, not merely a suggested archive-name limit. This exercises the
    // independently callable privileged commit boundary even if a future launcher regresses first.
    await expect(commitHostBackup({
      directory: root,
      archiveTemporary: 'a'.repeat(256),
      checksumTemporary: 'checksum.copy',
      archive: 'archive.backup',
      checksum: 'archive.backup.sha256',
    })).rejects.toThrow(/safe leaf/)
  })
})

async function writePrivate(path: string, contents: string): Promise<void> {
  await writeFile(path, contents, { mode: 0o600 })
  await chmod(path, 0o600)
}
