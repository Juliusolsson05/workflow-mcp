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
})

async function writePrivate(path: string, contents: string): Promise<void> {
  await writeFile(path, contents, { mode: 0o600 })
  await chmod(path, 0o600)
}
