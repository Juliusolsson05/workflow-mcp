import { constants } from 'node:fs'
import { lstat, mkdir, open, readFile, realpath } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'

import { findWorkflows, resolveWorkflowSearchLayout } from './findWorkflows.js'
import type { FoundWorkflow } from './findWorkflows.js'
import { loadWorkflowFile, parseWorkflowSource } from './loadWorkflow.js'

export class WorkflowAuthoringError extends Error {
  readonly code: 'path-forbidden' | 'name-conflict' | 'write-conflict'

  constructor(code: WorkflowAuthoringError['code'], message: string, options?: { cause?: unknown }) {
    super(message)
    if (options?.cause !== undefined) Object.defineProperty(this, 'cause', { value: options.cause })
    this.name = 'WorkflowAuthoringError'
    this.code = code
  }
}

/**
 * Resolve an explicitly named source file without turning workflow_run into an arbitrary file-read
 * primitive.
 *
 * WHY visibility is checked by directory rather than by `findWorkflows()` output: a malformed file
 * still needs to reach the normal parser so the caller gets the useful syntax/meta error. Requiring
 * it to have been discovered successfully first would incorrectly report every editing mistake as
 * a permissions problem. Real paths are compared so a symlink inside `.claude/workflows` cannot
 * escape the project and expose unrelated source.
 */
export async function loadScopedWorkflowPath(cwd: string, requestedPath: string): Promise<FoundWorkflow> {
  const layout = await resolveWorkflowSearchLayout({ cwd })
  const candidate = await realpath(resolve(cwd, requestedPath)).catch(() => resolve(cwd, requestedPath))
  const allowed = [layout.userDirectory, ...layout.projectDirectories]
  let location: FoundWorkflow['location'] | undefined

  for (const directory of allowed) {
    const boundary = await confinedWorkflowDirectory(directory).catch(() => undefined)
    if (boundary === undefined) continue
    if (!isInside(boundary, candidate)) continue
    location = directory === layout.userDirectory ? 'user' : 'project'
    break
  }

  if (location === undefined || extname(candidate) !== '.js') {
    throw new WorkflowAuthoringError(
      'path-forbidden',
      `workflow scriptPath must name a .js file under a visible .claude/workflows directory: ${candidate}`,
    )
  }

  return { ...(await loadWorkflowFile(candidate)), filePath: candidate, location }
}

/**
 * Persist inline source where both Claude Code and Agent Code will rediscover it.
 *
 * The private run store still receives its own immutable copy at execution time. This file is the
 * editable definition, not the audit record: iteration edits this returned path and executes it
 * again with `scriptPath`, while old runs remain reproducible from their private snapshots.
 */
export async function persistInlineWorkflow(cwd: string, source: string): Promise<FoundWorkflow> {
  // Parse before touching the filesystem. A half-authored workflow must not become a persistent
  // discovery issue merely because the model made a syntax error on its first attempt.
  const parsed = parseWorkflowSource(source)
  const visible = await findWorkflows({ cwd })
  const sameName = visible.workflows.find((workflow) => workflow.meta.name === parsed.meta.name)
  if (sameName) {
    if (sameName.sourceHash === parsed.sourceHash) return sameName
    throw new WorkflowAuthoringError(
      'name-conflict',
      `Workflow ${JSON.stringify(parsed.meta.name)} already exists at ${sameName.filePath}; edit that file and call workflow_run with scriptPath instead of replacing it implicitly`,
    )
  }

  const layout = await resolveWorkflowSearchLayout({ cwd })
  await mkdir(layout.authoredDirectory, { recursive: true })
  await confinedWorkflowDirectory(layout.authoredDirectory)
  const baseName = workflowFileName(parsed.meta.name)
  const preferred = join(layout.authoredDirectory, `${baseName}.js`)
  const filePath = await availablePath(preferred, parsed.sourceHash, source)

  let file
  try {
    // O_EXCL prevents a final-component symlink race and O_NOFOLLOW documents the invariant for
    // platforms which implement it. The parent is revalidated after opening because recursive
    // mkdir alone will happily traverse a concurrently substituted `.claude` symlink.
    file = await open(
      filePath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o644,
    )
    await confinedWorkflowDirectory(layout.authoredDirectory)
    await file.writeFile(source, { encoding: 'utf8' })
    await file.sync()
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause
    // Two MCP calls can author the same source concurrently. Treat byte-identical creation as one
    // idempotent definition, but never let the loser overwrite bytes selected by the winner.
    if ((await lstat(filePath)).isSymbolicLink()) {
      throw new WorkflowAuthoringError(
        'path-forbidden',
        `Workflow destination must not be a symbolic link: ${filePath}`,
        { cause },
      )
    }
    const existing = await readFile(filePath, 'utf8').catch(() => undefined)
    if (existing !== source) {
      throw new WorkflowAuthoringError(
        'write-conflict',
        `Workflow destination was created concurrently with different contents: ${filePath}`,
        { cause },
      )
    }
  } finally {
    await file?.close()
  }

  return {
    ...parseWorkflowSource(source, filePath),
    filePath,
    location: 'project',
  }
}

async function availablePath(preferred: string, sourceHash: string, source: string): Promise<string> {
  const info = await lstat(preferred).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (info?.isSymbolicLink()) {
    throw new WorkflowAuthoringError(
      'path-forbidden',
      `Workflow destination must not be a symbolic link: ${preferred}`,
    )
  }
  const existing = await readFile(preferred, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (existing === undefined || existing === source) return preferred

  // A sanitized filename is merely presentation; meta.name is the workflow identity. A short hash
  // avoids clobbering an unrelated definition whose name happens to sanitize to the same basename.
  return preferred.replace(/\.js$/, `-${sourceHash.slice(0, 10)}.js`)
}

async function confinedWorkflowDirectory(directory: string): Promise<string> {
  const scope = dirname(dirname(resolve(directory)))
  const canonicalScope = await realpath(scope)
  const expected = resolve(canonicalScope, '.claude', 'workflows')
  const actual = resolve(await realpath(directory))
  if (actual !== expected) {
    throw new WorkflowAuthoringError(
      'path-forbidden',
      `Workflow directory is redirected outside its project boundary: ${directory}`,
    )
  }
  return actual
}

function workflowFileName(name: string): string {
  const safe = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
  return safe.length === 0 ? 'workflow' : safe
}

function isInside(parent: string, candidate: string): boolean {
  const child = relative(resolve(parent), resolve(candidate))
  return child.length > 0 && !child.startsWith('..') && !isAbsolute(child)
}
