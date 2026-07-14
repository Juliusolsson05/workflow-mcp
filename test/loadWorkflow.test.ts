import { mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  MAX_WORKFLOW_BYTES,
  WorkflowError,
  loadWorkflowFile,
  parseWorkflowSource,
} from '../src/loadWorkflow.js'

const minimal = `export const meta = {
  name: 'minimal',
  description: 'Small valid workflow',
  phases: [{ title: 'Run' }],
}
return { ok: true }
`

function expectCode(run: () => unknown, code: string): void {
  try {
    run()
    throw new Error('Expected workflow parsing to fail')
  } catch (error) {
    expect(error).toBeInstanceOf(WorkflowError)
    expect((error as WorkflowError).code).toBe(code)
  }
}

describe('parseWorkflowSource', () => {
  it('reads metadata and keeps the executable body', () => {
    const workflow = parseWorkflowSource(`\uFEFF// a BOM and comments may precede metadata\n${minimal}`)

    expect(workflow.meta).toEqual({
      name: 'minimal',
      description: 'Small valid workflow',
      phases: [{ title: 'Run' }],
    })
    expect(workflow.body).toContain('return { ok: true }')
    expect(workflow.sourceHash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('accepts top-level await and return', () => {
    expect(() =>
      parseWorkflowSource(`export const meta = { name: 'async', description: 'Async' }\nawait agent('work')\nreturn 1`),
    ).not.toThrow()
  })

  it('normalizes known metadata and discards unknown metadata', () => {
    const workflow = parseWorkflowSource(`export const meta = {
      name: 'details',
      description: 'Details',
      title: 'Details title',
      whenToUse: '',
      custom: { ignored: true },
      phases: [
        { title: 'One', detail: 'Detail', model: 'sonnet', ignored: true },
        { nope: true },
        'bad',
      ],
    }
    return null`)

    expect(workflow.meta).toEqual({
      name: 'details',
      description: 'Details',
      title: 'Details title',
      whenToUse: '',
      phases: [{ title: 'One', detail: 'Detail', model: 'sonnet' }],
    })
  })

  it('accepts the observed pure-literal families', () => {
    expect(() =>
      parseWorkflowSource(`export const meta = {
        name: 'literals',
        description: \`literal description\`,
        phases: [{ title: 'One', detail: null }],
        data: { string: 'x', number: -2, bool: true, nil: null, array: [1, false] },
      }
      return null`),
    ).not.toThrow()
  })

  it('matches Claude literal and non-trimming behavior', () => {
    const workflow = parseWorkflowSource(`export const meta = {
      name: ' ',
      description: ' ',
      title: ' ',
      phases: [{ title: '', detail: '', model: '' }],
      ignoredRegex: /workflows/gi,
      ignoredBigInt: 123n,
    }
    return null`)

    expect(workflow.meta).toEqual({
      name: ' ',
      description: ' ',
      title: ' ',
      phases: [{ title: '', detail: '', model: '' }],
    })
  })

  it('removes Claude workflow wrapper whitespace without rewriting the body', () => {
    const workflow = parseWorkflowSource(
      `export const meta = { name: 'body', description: 'Body' };\n\n  // body comment\nreturn '✓'`,
    )

    expect(workflow.body).toBe(`// body comment\nreturn '✓'`)
  })

  it.each([
    ['meta-not-first', `const before = true\n${minimal}`],
    ['meta-not-first', `;\n${minimal}`],
    ['meta-not-first', `export let meta = { name: 'x', description: 'x' }\nreturn null`],
    ['meta-not-first', `export const meta = { name: 'x', description: 'x' }, other = 1\nreturn null`],
    ['meta-not-first', `export const meta = makeMeta()\nreturn null`],
    ['meta-name-required', `export const meta = { name: '', description: 'x' }\nreturn null`],
    ['meta-description-required', `export const meta = { name: 'x', description: '' }\nreturn null`],
    ['meta-not-literal', `export const meta = { name: 'x', description: value }\nreturn null`],
    ['meta-not-literal', `export const meta = { name: 'x', description: \`hello \${name}\` }\nreturn null`],
    ['meta-not-literal', `export const meta = { name: 'x', description: 'x', data: [1,,2] }\nreturn null`],
    ['meta-not-literal', `export const meta = { name: 'x', description: 'x', ...extra }\nreturn null`],
    ['meta-not-literal', `export const meta = { name: 'x', description: 'x', constructor: {} }\nreturn null`],
    ['syntax-error', `export const meta = { name: 'x', description: 'x' \nreturn null`],
  ])('reports %s for incompatible source', (code, source) => {
    expectCode(() => parseWorkflowSource(source), code)
  })

  it('rejects source above the observed Claude size limit before parsing', () => {
    expectCode(() => parseWorkflowSource(' '.repeat(MAX_WORKFLOW_BYTES + 1)), 'file-too-large')
  })
})

describe('loadWorkflowFile', () => {
  it('loads .js files and follows a symlink to a regular file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'workflow-loader-'))
    const target = join(directory, 'target.js')
    const link = join(directory, 'link.js')
    await writeFile(target, minimal)
    await symlink(target, link)

    const workflow = await loadWorkflowFile(link)
    expect(workflow.meta.name).toBe('minimal')
    expect(workflow.filePath).toBe(link)
  })

  it('loads a direct path regardless of its extension', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'workflow-loader-'))
    const filePath = join(directory, 'workflow.mjs')
    await writeFile(filePath, minimal)

    await expect(loadWorkflowFile(filePath)).resolves.toMatchObject({ meta: { name: 'minimal' } })
  })

  it('reports unreadable paths as loader errors', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'workflow-loader-'))
    await expect(loadWorkflowFile(join(directory, 'missing.js'))).rejects.toMatchObject({ code: 'read-error' })
  })

  it('accepts exactly 524,288 file bytes and rejects 524,289', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'workflow-loader-'))
    const acceptedPath = join(directory, 'accepted.js')
    const rejectedPath = join(directory, 'rejected.js')
    const padding = (size: number): string => {
      const wrapperBytes = Buffer.byteLength(minimal) + 5
      return `${minimal}\n/*${'x'.repeat(size - wrapperBytes)}*/`
    }
    await writeFile(acceptedPath, padding(MAX_WORKFLOW_BYTES))
    await writeFile(rejectedPath, padding(MAX_WORKFLOW_BYTES + 1))

    await expect(loadWorkflowFile(acceptedPath)).resolves.toMatchObject({ meta: { name: 'minimal' } })
    await expect(loadWorkflowFile(rejectedPath)).rejects.toMatchObject({ code: 'file-too-large' })
  })
})
