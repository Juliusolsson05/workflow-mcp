import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { findWorkflows } from '../src/findWorkflows.js'

function source(name: string, description: string): string {
  return `export const meta = { name: ${JSON.stringify(name)}, description: ${JSON.stringify(description)} }\nreturn null\n`
}

async function put(directory: string, fileName: string, contents: string): Promise<void> {
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, fileName), contents)
}

describe('findWorkflows', () => {
  it('applies user, far-project, and near-project precedence', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'workflow-discovery-'))
    const home = join(directory, 'home')
    const repository = join(directory, 'repo')
    const cwd = join(repository, 'packages', 'app')
    await mkdir(join(repository, '.git'), { recursive: true })
    await mkdir(cwd, { recursive: true })

    await put(join(home, '.claude', 'workflows'), 'same.js', source('same', 'user'))
    await put(join(repository, '.claude', 'workflows'), 'same.js', source('same', 'far project'))
    await put(join(cwd, '.claude', 'workflows'), 'same.js', source('same', 'near project'))

    const result = await findWorkflows({ cwd, homeDir: home })

    expect(result.workflows).toHaveLength(1)
    expect(result.workflows[0]?.meta.description).toBe('near project')
    expect(result.workflows[0]?.location).toBe('project')
  })

  it('sorts names, records invalid files, and reports near-miss extensions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'workflow-discovery-'))
    const repository = join(directory, 'repo')
    const workflowDirectory = join(repository, '.claude', 'workflows')
    await mkdir(join(repository, '.git'), { recursive: true })
    await put(workflowDirectory, 'z.js', source('zebra', 'Z'))
    await put(workflowDirectory, 'a.js', source('alpha', 'A'))
    await put(workflowDirectory, 'broken.js', `export const meta = nope`)
    await put(workflowDirectory, 'near.mjs', source('near', 'Near miss'))
    await put(workflowDirectory, 'also-near.cjs', source('near-cjs', 'Near miss'))
    await put(workflowDirectory, 'typed.ts', source('near-ts', 'Near miss'))
    await put(workflowDirectory, 'upper.JS', source('upper', 'Ignored'))
    await put(workflowDirectory, 'valid.workflow.js', source('middle', 'Double extension is valid'))
    await put(workflowDirectory, 'notes.md', 'not a workflow')

    const result = await findWorkflows({ cwd: repository, homeDir: join(directory, 'home') })

    expect(result.workflows.map((workflow) => workflow.meta.name)).toEqual(['alpha', 'middle', 'zebra'])
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0]?.filePath).toBe(join(workflowDirectory, 'broken.js'))
    expect(result.nearMisses).toEqual([
      join(workflowDirectory, 'also-near.cjs'),
      join(workflowDirectory, 'near.mjs'),
      join(workflowDirectory, 'typed.ts'),
    ])
  })

  it('walks toward the supplied home boundary outside a Git repository', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'workflow-discovery-'))
    const home = join(directory, 'home')
    const cwd = join(home, 'plain-project')
    await put(join(cwd, '.claude', 'workflows'), 'plain.js', source('plain', 'Plain project'))

    const result = await findWorkflows({ cwd, homeDir: home })

    expect(result.workflows.map((workflow) => workflow.meta.name)).toEqual(['plain'])
  })

  it('treats names as exact and reports ambiguous duplicates in one directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'workflow-discovery-'))
    const repository = join(directory, 'repo')
    const workflowDirectory = join(repository, '.claude', 'workflows')
    await mkdir(join(repository, '.git'), { recursive: true })
    await put(workflowDirectory, 'first.js', source('same', 'First'))
    await put(workflowDirectory, 'second.js', source('same', 'Second'))
    await put(workflowDirectory, 'case.js', source('Same', 'Case-sensitive distinct name'))
    await put(workflowDirectory, 'different-file-name.js', source('declared-name', 'Filename is irrelevant'))

    const result = await findWorkflows({ cwd: repository, homeDir: join(directory, 'home') })

    expect(result.workflows.map((workflow) => workflow.meta.name)).toEqual(
      ['declared-name', 'same', 'Same'].sort((left, right) => left.localeCompare(right)),
    )
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0]).toMatchObject({ code: 'duplicate-name' })
    expect([join(workflowDirectory, 'first.js'), join(workflowDirectory, 'second.js')]).toContain(
      result.issues[0]?.filePath,
    )
  })

  it('rejects a project workflow root redirected through a symlink', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'workflow-discovery-symlink-root-'))
    const repository = join(directory, 'repo')
    const external = join(directory, 'external-workflows')
    await mkdir(join(repository, '.git'), { recursive: true })
    await mkdir(join(repository, '.claude'), { recursive: true })
    await put(external, 'outside.js', source('outside', 'Must not execute'))
    await symlink(external, join(repository, '.claude', 'workflows'))

    const result = await findWorkflows({ cwd: repository, homeDir: join(directory, 'home') })

    expect(result.workflows).toEqual([])
    expect(result.issues).toContainEqual(expect.objectContaining({
      filePath: join(repository, '.claude', 'workflows'),
      code: 'path-forbidden',
    }))
  })
})
