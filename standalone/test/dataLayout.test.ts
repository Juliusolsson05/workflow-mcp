import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  inspectWorkflowDataLayout,
  prepareWorkflowDataLayout,
} from '../src/daemon/dataLayout.js'

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
})
