import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { loadWorkflowFile } from '../src/loadWorkflow.js'

const rawDirectory = resolve('references/raw')

async function javascriptFiles(directory: string): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await javascriptFiles(path)))
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(path)
  }
  return files
}

describe.skipIf(!existsSync(rawDirectory))('raw reference corpus', () => {
  it('loads every positive JavaScript workflow reference', async () => {
    const files = await javascriptFiles(rawDirectory)
    expect(files.length).toBeGreaterThan(20)

    const failures: Array<{ file: string; error: string }> = []
    for (const file of files) {
      try {
        await loadWorkflowFile(file)
      } catch (error) {
        failures.push({ file, error: error instanceof Error ? error.message : String(error) })
      }
    }

    expect(failures).toEqual([])
  })
})
