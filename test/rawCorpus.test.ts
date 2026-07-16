import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { loadWorkflowFile } from '../src/loadWorkflow.js'

const rawDirectory = resolve('references/raw')
const committedDirectory = resolve('test/fixtures/workflow-corpus')

async function javascriptFiles(directory: string): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await javascriptFiles(path)))
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(path)
  }
  return files
}

async function expectCorpusLoads(files: string[]): Promise<void> {
  expect(files.length).toBeGreaterThan(0)
  const failures: Array<{ file: string; error: string }> = []
  for (const file of files) {
    try {
      await loadWorkflowFile(file)
    } catch (error) {
      failures.push({ file, error: error instanceof Error ? error.message : String(error) })
    }
  }
  expect(failures).toEqual([])
}

describe('committed sanitized workflow corpus', () => {
  it('is non-empty and loads every positive JavaScript fixture', async () => {
    await expectCorpusLoads(await javascriptFiles(committedDirectory))
  })
})

describe.skipIf(!existsSync(rawDirectory))('optional raw reference corpus', () => {
  it('loads every positive JavaScript workflow reference', async () => {
    const files = await javascriptFiles(rawDirectory)
    expect(files.length).toBeGreaterThan(20)
    await expectCorpusLoads(files)
  })
})
