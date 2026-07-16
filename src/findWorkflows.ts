import { readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'

import { loadWorkflowFile, WorkflowError } from './loadWorkflow.js'
import type { LoadedWorkflow } from './loadWorkflow.js'

export type WorkflowLocation = 'user' | 'project'

export type FoundWorkflow = LoadedWorkflow & {
  filePath: string
  location: WorkflowLocation
}

export type WorkflowIssue = {
  filePath: string
  code: string
  message: string
}

export type FindWorkflowsOptions = {
  cwd?: string
  homeDir?: string
  projectRoot?: string
}

export type FindWorkflowsResult = {
  workflows: FoundWorkflow[]
  issues: WorkflowIssue[]
  nearMisses: string[]
}

export type WorkflowSearchLayout = {
  cwd: string
  home: string
  userDirectory: string
  projectDirectories: string[]
  /** Stable project-level destination for workflow source authored through MCP. */
  authoredDirectory: string
}

const NEAR_MISS_EXTENSIONS = new Set(['.mjs', '.cjs', '.ts'])

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

type ProjectBoundary = {
  path: string
  includeBoundary: boolean
}

async function detectProjectBoundary(cwd: string, home: string): Promise<ProjectBoundary> {
  let current = resolve(cwd)
  while (true) {
    if (await pathExists(join(current, '.git'))) return { path: current, includeBoundary: true }
    // ~/.claude/workflows is the personal layer, not a project directory. Stop before treating it
    // as both user and project input when a non-Git directory is searched beneath the home folder.
    if (current === home) return { path: home, includeBoundary: false }
    const parent = dirname(current)
    if (parent === current) return { path: current, includeBoundary: false }
    current = parent
  }
}

export async function resolveWorkflowSearchLayout(
  options: FindWorkflowsOptions = {},
): Promise<WorkflowSearchLayout> {
  const cwd = resolve(options.cwd ?? process.cwd())
  const home = resolve(options.homeDir ?? homedir())
  const detectedBoundary = options.projectRoot === undefined
    ? await detectProjectBoundary(cwd, home)
    : undefined
  const root = resolve(options.projectRoot ?? detectedBoundary?.path ?? cwd)
  const includeRoot = options.projectRoot === undefined
    ? (detectedBoundary?.includeBoundary ?? true)
    : true
  const directories = projectDirectories(root, cwd, includeRoot)

  return {
    cwd,
    home,
    userDirectory: join(home, '.claude', 'workflows'),
    projectDirectories: directories,
    // WHY a non-Git directory authors next to the requested cwd: the filesystem root or the
    // user's home is only a discovery boundary, not a project identity. Writing `/.claude` or
    // `~/.claude` here would unexpectedly turn a one-project inline workflow into global state.
    // A real Git boundary, however, is stable when the caller starts Agent Code in a subfolder.
    authoredDirectory: join(
      detectedBoundary?.includeBoundary === true || options.projectRoot !== undefined ? root : cwd,
      '.claude',
      'workflows',
    ),
  }
}

function projectDirectories(root: string, cwd: string, includeRoot: boolean): string[] {
  const absoluteRoot = resolve(root)
  const absoluteCwd = resolve(cwd)
  const pathFromRoot = relative(absoluteRoot, absoluteCwd)
  if (pathFromRoot === '..' || pathFromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(pathFromRoot)) {
    throw new Error(`Project root ${absoluteRoot} is not an ancestor of ${absoluteCwd}`)
  }
  const result: string[] = []
  let current = absoluteCwd

  while (true) {
    if (current !== absoluteRoot || includeRoot) result.push(join(current, '.claude', 'workflows'))
    if (current === absoluteRoot) break
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }

  // Claude applies the farthest project directory first and lets definitions closer to the
  // current working directory overwrite it. Reversing here makes that precedence visible rather
  // than burying it in a later numeric priority system.
  return result.reverse()
}

function issue(filePath: string, error: unknown): WorkflowIssue {
  if (error instanceof WorkflowError) {
    return { filePath, code: error.code, message: error.message }
  }
  return {
    filePath,
    code: 'read-error',
    message: error instanceof Error ? error.message : String(error),
  }
}

async function readDirectory(
  directory: string,
  location: WorkflowLocation,
  workflows: Map<string, FoundWorkflow>,
  issues: WorkflowIssue[],
  nearMisses: string[],
): Promise<void> {
  const canonicalDirectory = await confinedWorkflowDirectory(directory).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    issues.push(issue(directory, error))
    return undefined
  })
  if (canonicalDirectory === undefined) return
  if (canonicalDirectory !== await resolveExpectedWorkflowDirectory(directory)) {
    // Workflow source executes as code. Letting `.claude` or `workflows` redirect through a
    // symlink turns repository discovery into execution from an unrelated filesystem location.
    // Individual file symlinks remain usable only when their canonical target stays in this root.
    issues.push({
      filePath: directory,
      code: 'path-forbidden',
      message: `Workflow directory is redirected outside its project boundary: ${directory}`,
    })
    return
  }
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    issues.push(issue(directory, error))
    return
  }

  const namesInDirectory = new Set<string>()
  for (const entry of entries) {
    const filePath = join(directory, entry.name)
    const extension = extname(entry.name)
    if (NEAR_MISS_EXTENSIONS.has(extension)) {
      nearMisses.push(filePath)
      continue
    }
    if (extension !== '.js' || (!entry.isFile() && !entry.isSymbolicLink())) continue

    try {
      const canonicalFile = await realpath(filePath)
      if (!isInside(canonicalDirectory, canonicalFile)) {
        issues.push({
          filePath,
          code: 'path-forbidden',
          message: `Workflow file symlink leaves its visible workflow directory: ${filePath}`,
        })
        continue
      }
      const loaded = await loadWorkflowFile(canonicalFile)
      if (namesInDirectory.has(loaded.meta.name)) {
        // Claude lets readdir order decide this ambiguous case. Reporting it is important because
        // sorting filenames here would create a deterministic but incompatible winner.
        issues.push({
          filePath,
          code: 'duplicate-name',
          message: `Multiple workflows in ${directory} declare the exact name ${JSON.stringify(loaded.meta.name)}`,
        })
      }
      namesInDirectory.add(loaded.meta.name)
      workflows.set(loaded.meta.name, {
        ...loaded,
        // Preserve the user-visible definition path. Execution approval separately canonicalizes
        // this identity, so a harmless /tmp -> /private/tmp alias does not churn returned paths.
        filePath,
        location,
      })
    } catch (error) {
      issues.push(issue(filePath, error))
    }
  }
}

async function confinedWorkflowDirectory(directory: string): Promise<string> {
  return resolve(await realpath(directory))
}

async function resolveExpectedWorkflowDirectory(directory: string): Promise<string> {
  // `directory` always has the shape <scope>/.claude/workflows. Canonicalizing only <scope> keeps
  // legitimate project aliases working while making any redirect in the security-sensitive final
  // two components observable as a mismatch.
  const scope = dirname(dirname(resolve(directory)))
  return resolve(await realpath(scope), '.claude', 'workflows')
}

function isInside(parent: string, candidate: string): boolean {
  const child = relative(resolve(parent), resolve(candidate))
  return child.length > 0 && !child.startsWith('..') && !isAbsolute(child)
}

export async function findWorkflows(options: FindWorkflowsOptions = {}): Promise<FindWorkflowsResult> {
  const layout = await resolveWorkflowSearchLayout(options)
  const workflows = new Map<string, FoundWorkflow>()
  const issues: WorkflowIssue[] = []
  const nearMisses: string[] = []

  // Map insertion order is deliberately irrelevant: every layer may replace the same name, and
  // the public result is sorted afterward. This matches how users reason about precedence while
  // preventing filesystem enumeration order from leaking into the UI.
  await readDirectory(layout.userDirectory, 'user', workflows, issues, nearMisses)
  for (const directory of layout.projectDirectories) {
    await readDirectory(directory, 'project', workflows, issues, nearMisses)
  }

  return {
    workflows: [...workflows.values()].sort((left, right) => left.meta.name.localeCompare(right.meta.name)),
    issues: issues.sort((left, right) => left.filePath.localeCompare(right.filePath)),
    nearMisses: nearMisses.sort(),
  }
}

export function workflowLabel(workflow: FoundWorkflow): string {
  return `${workflow.meta.name} (${workflow.location}: ${basename(workflow.filePath)})`
}
