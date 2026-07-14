import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

import { parse } from 'acorn'
import type { Node, Program } from 'acorn'

export const MAX_WORKFLOW_BYTES = 524_288

export type WorkflowPhase = {
  title: string
  detail?: string
  model?: string
}

export type WorkflowMeta = {
  name: string
  description: string
  title?: string
  whenToUse?: string
  phases?: WorkflowPhase[]
}

export type LoadedWorkflow = {
  filePath?: string
  source: string
  body: string
  meta: WorkflowMeta
  sourceHash: string
}

export type WorkflowErrorCode =
  | 'not-a-file'
  | 'read-error'
  | 'file-too-large'
  | 'syntax-error'
  | 'meta-not-first'
  | 'meta-not-literal'
  | 'meta-name-required'
  | 'meta-description-required'

export class WorkflowError extends Error {
  readonly code: WorkflowErrorCode
  readonly filePath?: string

  constructor(
    code: WorkflowErrorCode,
    message: string,
    options?: { filePath?: string | undefined; cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'WorkflowError'
    this.code = code
    if (options?.filePath !== undefined) this.filePath = options.filePath
  }
}

type AstNode = Node & Record<string, unknown>
type LiteralObject = Record<string, unknown>

const BLOCKED_META_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function failLiteral(filePath: string | undefined, detail: string): never {
  throw new WorkflowError('meta-not-literal', `Workflow meta must be a pure literal: ${detail}`, {
    filePath,
  })
}

function propertyName(node: AstNode, filePath: string | undefined): string {
  if (node.type === 'Identifier' && typeof node.name === 'string') return node.name

  if (node.type === 'Literal') {
    const value = node.value
    if (value !== undefined) return String(value)
  }

  return failLiteral(filePath, 'object keys must be plain identifiers or literals')
}

function readLiteral(node: AstNode, filePath: string | undefined): unknown {
  switch (node.type) {
    case 'Literal': {
      // Claude returns Acorn's literal value directly. That includes regexp and bigint literals,
      // even though the recognized metadata fields cannot use those types. Restricting this to
      // JSON primitives would incorrectly reject an otherwise ignored custom literal field.
      return node.value
    }

    case 'UnaryExpression': {
      if (node.operator !== '-' || node.prefix !== true) {
        return failLiteral(filePath, 'only negative numeric unary literals are supported')
      }
      const argument = node.argument as AstNode | undefined
      if (argument?.type !== 'Literal' || typeof argument.value !== 'number') {
        return failLiteral(filePath, 'a negative literal must contain a number')
      }
      return -argument.value
    }

    case 'TemplateLiteral': {
      const expressions = node.expressions as AstNode[] | undefined
      const quasis = node.quasis as Array<AstNode & { value?: { cooked?: string | null; raw?: string } }> | undefined
      if (expressions?.length !== 0 || quasis?.length !== 1) {
        return failLiteral(filePath, 'template interpolation is unsupported')
      }
      const value = quasis[0]?.value
      if (!value || value.cooked === null) return failLiteral(filePath, 'template literal is invalid')
      return value.cooked ?? value.raw ?? ''
    }

    case 'ArrayExpression': {
      const elements = node.elements as Array<AstNode | null> | undefined
      if (!elements) return failLiteral(filePath, 'array literal is malformed')
      return elements.map((element) => {
        if (element === null) return failLiteral(filePath, 'sparse arrays are unsupported')
        if (element.type === 'SpreadElement') return failLiteral(filePath, 'array spreads are unsupported')
        return readLiteral(element, filePath)
      })
    }

    case 'ObjectExpression': {
      const properties = node.properties as AstNode[] | undefined
      if (!properties) return failLiteral(filePath, 'object literal is malformed')

      // A null prototype is not an implementation flourish. Metadata is untrusted source, and
      // Claude rejects prototype-shaping keys; preserving that invariant here prevents the parser
      // from turning a harmless metadata object into an object-prototype mutation.
      const result: LiteralObject = Object.create(null) as LiteralObject
      for (const property of properties) {
        if (
          property.type !== 'Property' ||
          property.kind !== 'init' ||
          property.method === true ||
          property.computed === true ||
          property.shorthand === true
        ) {
          return failLiteral(filePath, 'spreads, computed keys, methods, accessors, and shorthand are unsupported')
        }

        const key = propertyName(property.key as AstNode, filePath)
        if (BLOCKED_META_KEYS.has(key)) return failLiteral(filePath, `metadata key ${JSON.stringify(key)} is blocked`)
        result[key] = readLiteral(property.value as AstNode, filePath)
      }
      return result
    }

    default:
      return failLiteral(filePath, `${node.type} is not a literal value`)
  }
}

function isObject(value: unknown): value is LiteralObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeMeta(value: unknown, filePath: string | undefined): WorkflowMeta {
  if (!isObject(value)) return failLiteral(filePath, 'meta must be an object')

  if (typeof value.name !== 'string' || value.name.length === 0) {
    throw new WorkflowError('meta-name-required', 'Workflow meta.name must be a non-empty string', {
      filePath,
    })
  }
  if (typeof value.description !== 'string' || value.description.length === 0) {
    throw new WorkflowError(
      'meta-description-required',
      'Workflow meta.description must be a non-empty string',
      { filePath },
    )
  }

  const meta: WorkflowMeta = {
    name: value.name,
    description: value.description,
  }

  if (typeof value.title === 'string' && value.title.length > 0) meta.title = value.title
  if (typeof value.whenToUse === 'string') meta.whenToUse = value.whenToUse

  if (Array.isArray(value.phases)) {
    const phases: WorkflowPhase[] = []
    for (const candidate of value.phases) {
      if (!isObject(candidate) || typeof candidate.title !== 'string') continue
      const phase: WorkflowPhase = { title: candidate.title }
      if (typeof candidate.detail === 'string') phase.detail = candidate.detail
      if (typeof candidate.model === 'string') phase.model = candidate.model
      phases.push(phase)
    }
    meta.phases = phases
  }

  return meta
}

function findMeta(program: Program, filePath: string | undefined): { declaration: AstNode; value: AstNode } {
  const statement = program.body[0] as AstNode | undefined
  if (!statement || statement.type !== 'ExportNamedDeclaration') {
    throw new WorkflowError('meta-not-first', 'The first statement must be export const meta = { ... }', {
      filePath,
    })
  }

  const declaration = statement.declaration as AstNode | null | undefined
  const declarations = declaration?.declarations as AstNode[] | undefined
  const declarator = declarations?.[0]
  const id = declarator?.id as AstNode | undefined
  const value = declarator?.init as AstNode | null | undefined
  if (
    declaration?.type !== 'VariableDeclaration' ||
    declaration.kind !== 'const' ||
    declarations?.length !== 1 ||
    declarator?.type !== 'VariableDeclarator' ||
    id?.type !== 'Identifier' ||
    id.name !== 'meta' ||
    value?.type !== 'ObjectExpression'
  ) {
    throw new WorkflowError('meta-not-first', 'The first statement must be export const meta = { ... }', {
      filePath,
    })
  }

  return { declaration: statement, value }
}

export function parseWorkflowSource(source: string, filePath?: string): LoadedWorkflow {
  // Inline Workflow tool input is already a JavaScript string when Claude checks it, so this
  // limit is measured in UTF-16 code units. File loading separately enforces the byte limit.
  if (source.length > MAX_WORKFLOW_BYTES) {
    throw new WorkflowError('file-too-large', `Workflow exceeds ${MAX_WORKFLOW_BYTES} bytes`, {
      filePath,
    })
  }

  let program: Program
  try {
    program = parse(source, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
    })
  } catch (cause) {
    throw new WorkflowError('syntax-error', cause instanceof Error ? cause.message : 'Workflow syntax is invalid', {
      filePath,
      cause,
    })
  }

  const { declaration, value } = findMeta(program, filePath)
  const meta = normalizeMeta(readLiteral(value, filePath), filePath)

  return {
    ...(filePath === undefined ? {} : { filePath }),
    source,
    body: source.slice(declaration.end).replace(/^[;\s]*\n/, '').trimStart(),
    meta,
    sourceHash: createHash('sha256').update(source, 'utf8').digest('hex'),
  }
}

export async function loadWorkflowFile(filePath: string): Promise<LoadedWorkflow> {
  const absolutePath = resolve(filePath)
  let file
  try {
    file = await stat(absolutePath)
  } catch (cause) {
    throw new WorkflowError('read-error', `Cannot read workflow file: ${absolutePath}`, {
      filePath: absolutePath,
      cause,
    })
  }
  if (!file.isFile()) {
    throw new WorkflowError('not-a-file', 'Workflow path must point to a regular file', {
      filePath: absolutePath,
    })
  }
  if (file.size > MAX_WORKFLOW_BYTES) {
    throw new WorkflowError('file-too-large', `Workflow exceeds ${MAX_WORKFLOW_BYTES} bytes`, {
      filePath: absolutePath,
    })
  }

  let bytes
  try {
    bytes = await readFile(absolutePath)
  } catch (cause) {
    throw new WorkflowError('read-error', `Cannot read workflow file: ${absolutePath}`, {
      filePath: absolutePath,
      cause,
    })
  }
  // Recheck after reading because a file may grow between stat and read.
  if (bytes.length > MAX_WORKFLOW_BYTES) {
    throw new WorkflowError('file-too-large', `Workflow exceeds ${MAX_WORKFLOW_BYTES} bytes`, {
      filePath: absolutePath,
    })
  }
  const source = bytes.toString('utf8')

  const workflow = parseWorkflowSource(source, absolutePath)
  return {
    ...workflow,
    // File identity must describe the approved bytes, not a decoded/re-encoded approximation.
    // This matters for approval invalidation and later cache namespaces when malformed encodings
    // or byte-order marks would otherwise make two distinct files look identical.
    sourceHash: createHash('sha256').update(bytes).digest('hex'),
  }
}
