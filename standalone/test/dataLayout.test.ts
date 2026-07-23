import { access, chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  inspectWorkflowDataLayout,
  prepareWorkflowDataLayout,
} from '../src/daemon/dataLayout.js'
import { inspectContainer } from '../src/daemon/health.js'
import type { StandaloneConfig } from '../src/config/schema.js'

describe('workflow data layout', () => {
  it('publishes one global selector last and reopens it before returning', async () => {
    const root = join(await mkdtemp(join(tmpdir(), 'workflow-layout-')), 'data')
    expect(inspectWorkflowDataLayout(root).state).toBe('fresh')
    const layout = prepareWorkflowDataLayout(root)
    expect(layout).toMatchObject({
      format: 'workflow-mcp-installation',
      version: 1,
      formats: {
        store: 1,
        journal: 2,
        indexes: 1,
        approvals: 1,
        tokens: 1,
        configuration: 1,
        credentials: 1,
        workspaces: 1,
        backups: 1,
      },
    })
    expect(inspectWorkflowDataLayout(root)).toMatchObject({ state: 'ready', layout })
  })

  it('refuses an unknown newer selector without changing its bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-layout-newer-'))
    await mkdir(join(root, '.coordination'))
    const path = join(root, 'layout.json')
    const original = '{"format":"future","version":999,"future":true}\n'
    await writeFile(path, original, { mode: 0o600 })

    expect(() => prepareWorkflowDataLayout(root)).toThrow(
      expect.objectContaining({ code: 'layout-newer' }),
    )
    expect(await readFile(path, 'utf8')).toBe(original)
  })

  it('keeps doctor read-only for every unknown-newer entry and symlink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-layout-doctor-newer-'))
    const workspace = join(root, 'workspace')
    const data = join(root, 'data')
    await mkdir(workspace)
    await mkdir(join(data, 'future-payload'), { recursive: true })
    await writeFile(join(data, 'layout.json'), '{"format":"future","version":999}\n', { mode: 0o640 })
    await writeFile(join(data, 'future-payload', 'bytes'), 'future owner bytes\n', { mode: 0o604 })
    await symlink('future-payload/bytes', join(data, 'future-link'))
    const probeInvocation = join(root, 'policy-probe-was-invoked')
    const executable = join(root, 'codex-isolated')
    await writeFile(executable, `#!/bin/sh
: > ${JSON.stringify(probeInvocation)}
printf 'codex-policy-ok network=not-configured\\n'
`)
    await chmod(executable, 0o700)
    const before = await treeIdentity(data)
    const config: StandaloneConfig = Object.freeze({
      workspace,
      projectHash: 'a'.repeat(64),
      dataDirectory: data,
      host: '127.0.0.1',
      port: 0,
      sourceMode: 'read-only',
      leaseMode: 'embedded',
      adminSocketPath: join(root, 'run', 'admin.sock'),
      codexExecutable: executable,
      webEnabled: false,
      concurrency: 1,
    })

    const report = await inspectContainer(config)
    expect(report.checks).toContainEqual(expect.objectContaining({ id: 'data-layout', status: 'fail' }))
    expect(report.checks).toContainEqual(expect.objectContaining({ id: 'data-fsync', status: 'fail' }))
    // On Linux this executable has the exact final-image basename, so absence is direct evidence
    // that the unknown selector stopped doctor before the external policy boundary. Other hosts
    // intentionally use the embedded warning branch and preserve the same no-touch assertion.
    await expect(access(probeInvocation)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await treeIdentity(data)).toEqual(before)
  })

  it.skipIf(process.platform !== 'linux')(
    'isolates final-image policy probe state from a validated durable data tree',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'workflow-layout-doctor-policy-'))
      const workspace = join(root, 'workspace')
      const data = join(root, 'data')
      const executable = join(root, 'codex-isolated')
      await mkdir(workspace)
      prepareWorkflowDataLayout(data)
      await writeFile(executable, `#!/bin/sh
set -eu
case "$HOME" in ${JSON.stringify(data)}|${JSON.stringify(`${data}/`)}*) exit 41 ;; esac
case "$CODEX_HOME" in ${JSON.stringify(data)}|${JSON.stringify(`${data}/`)}*) exit 42 ;; esac
case "$TMPDIR" in ${JSON.stringify(data)}|${JSON.stringify(`${data}/`)}*) exit 43 ;; esac
mkdir -p "$HOME/tmp/arg0" "$CODEX_HOME/cache" "$XDG_CACHE_HOME/runtime"
: > "$HOME/tmp/arg0/.lock"
: > "$CODEX_HOME/cache/session"
: > "$XDG_CACHE_HOME/runtime/probe"
printf 'codex-policy-ok network=not-configured\\n'
`)
      await chmod(executable, 0o700)
      const before = await treeIdentity(data)
      const config: StandaloneConfig = Object.freeze({
        workspace,
        projectHash: 'a'.repeat(64),
        dataDirectory: data,
        host: '127.0.0.1',
        port: 0,
        sourceMode: 'read-only',
        leaseMode: 'embedded',
        adminSocketPath: join(root, 'run', 'admin.sock'),
        codexExecutable: executable,
        webEnabled: false,
        concurrency: 1,
      })

      const report = await inspectContainer(config)
      expect(report.checks).toContainEqual(expect.objectContaining({ id: 'codex-policy', status: 'pass' }))
      // The fake behaves like the real Codex launcher by creating lock, temp, and cache material.
      // Byte/type/mode/entry/mtime identity proves every one of those writes stayed in disposable
      // probe state rather than falling back to the image's durable /data/codex-home.
      expect(await treeIdentity(data)).toEqual(before)
    },
  )

  it('refuses any tree carrying a durable interrupted-restore marker', async () => {
    const root = join(await mkdtemp(join(tmpdir(), 'workflow-layout-restore-')), 'data')
    prepareWorkflowDataLayout(root)
    await writeFile(join(root, '.restore-in-progress.json'), '{"schemaVersion":1}\n', { mode: 0o600 })
    expect(() => inspectWorkflowDataLayout(root)).toThrow(/restore is incomplete/)
  })
})

async function treeIdentity(root: string): Promise<unknown[]> {
  const walk = async (path: string, relativePath: string): Promise<unknown[]> => {
    const info = await lstat(path)
    const entry = {
      path: relativePath,
      mode: info.mode,
      size: info.size,
      mtimeMs: info.mtimeMs,
      type: info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'directory' : 'file',
      ...(info.isSymbolicLink() ? { target: await readlink(path) } : {}),
      ...(info.isFile() ? { bytes: await readFile(path, 'hex') } : {}),
    }
    if (!info.isDirectory() || info.isSymbolicLink()) return [entry]
    const children = (await readdir(path)).sort()
    return [entry, ...(await Promise.all(children.map(child =>
      walk(join(path, child), relativePath.length === 0 ? child : `${relativePath}/${child}`),
    ))).flat()]
  }
  return walk(root, '')
}
