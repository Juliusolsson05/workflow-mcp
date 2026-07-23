import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

const execute = promisify(execFile)

describe('installation release bundle', () => {
  it('is content-reproducible, self-checksummed, and shell-parseable', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'workflow-mcp-bundle-'))
    const first = join(temporary, 'first')
    const second = join(temporary, 'second')
    const script = resolve('scripts/build-install-bundle.mjs')
    for (const output of [first, second]) {
      await execute(process.execPath, [
        script,
        `--output=${output}`,
        '--version=1.2.3',
        '--revision=0123456789012345678901234567890123456789',
        '--image=docker.io/example/workflow-mcp@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        '--release',
      ], { env: { ...process.env, SOURCE_DATE_EPOCH: '123456789' } })
    }

    const firstFiles = (await readdir(first)).sort()
    expect(firstFiles).toEqual((await readdir(second)).sort())
    for (const file of firstFiles) {
      expect(await readFile(join(first, file))).toEqual(await readFile(join(second, file)))
    }

    const checksums = (await readFile(join(first, 'SHA256SUMS'), 'utf8')).trim().split('\n')
    expect(checksums).toHaveLength(firstFiles.length - 1)
    for (const line of checksums) {
      const match = /^([0-9a-f]{64})  ([A-Za-z0-9._-]+)$/.exec(line)
      expect(match).not.toBeNull()
      const bytes = await readFile(join(first, match![2]!))
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(match![1])
    }
    await execute('sh', ['-n', join(first, 'workflow-mcp-docker')])
  })

  it('refuses mutable image references in release mode', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'workflow-mcp-bundle-invalid-'))
    await expect(execute(process.execPath, [
      resolve('scripts/build-install-bundle.mjs'),
      `--output=${join(temporary, 'output')}`,
      '--version=1.2.3',
      '--revision=0123456789012345678901234567890123456789',
      '--image=example/workflow-mcp:latest',
      '--release',
    ])).rejects.toThrow(/Release image must use an immutable index digest/)
  })
})
