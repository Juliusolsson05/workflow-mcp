type JsonObject = Record<string, unknown>

type Projection =
  | { kind: 'identity' }
  | {
      kind: 'object'
      optionalNullKeys: ReadonlySet<string>
      properties: ReadonlyMap<string, Projection>
    }
  | { kind: 'array'; items: Projection }
  | { kind: 'composite'; projections: readonly Projection[] }
  | { kind: 'reference'; reference: string }

type AdaptState = {
  readonly references: Map<string, Projection>
  readonly ancestors: Set<object>
}

export type CodexOutputSchemaAdapter = {
  outputSchema: JsonObject
  restore(value: unknown): unknown
}

const IDENTITY: Projection = { kind: 'identity' }

/**
 * Convert the ordinary JSON Schema accepted by Claude workflows into the strict subset required by
 * Codex structured output.
 *
 * WHY this belongs at the provider edge: the workflow schema is part of the portable file format.
 * Requiring authors to add OpenAI-only `additionalProperties` and nullable placeholders would make
 * a file that runs in Claude change shape merely because Codex executes it. The adapter therefore
 * makes every declared object property required for Codex, represents a workflow-optional property
 * as `T | null`, and projects those synthetic nulls back to omission before the runtime validates
 * the result against the author's original schema.
 */
export function adaptCodexOutputSchema(schema: unknown): CodexOutputSchemaAdapter {
  if (!isJsonObject(schema)) {
    throw new TypeError('Codex structured output requires a JSON Schema object')
  }

  const state: AdaptState = { references: new Map(), ancestors: new Set() }
  const adapted = adaptNode(schema, '#', schema, state)
  if (!isJsonObject(adapted.schema)) {
    throw new TypeError('Codex structured output requires a JSON Schema object')
  }

  return {
    outputSchema: adapted.schema,
    restore(value: unknown): unknown {
      projectSyntheticNulls(value, adapted.projection, state.references, new Set())
      return value
    },
  }
}

function adaptNode(
  schema: unknown,
  pointer: string,
  root: JsonObject,
  state: AdaptState,
): { schema: unknown; projection: Projection } {
  if (typeof schema === 'boolean') {
    // The Codex CLI accepts a plain schema object, not boolean JSON Schemas. Failing here is safer
    // than turning `false` into a schema that can unexpectedly produce a value.
    throw new TypeError(`Boolean JSON Schemas are not supported by Codex at ${pointer}`)
  }
  if (!isJsonObject(schema)) throw new TypeError(`Invalid JSON Schema node at ${pointer}`)
  if (state.ancestors.has(schema)) throw new TypeError(`Circular JSON Schema at ${pointer}`)
  state.ancestors.add(schema)

  try {
    const output: JsonObject = { ...schema }
    const projections: Projection[] = []

    for (const keyword of ['$defs', 'definitions'] as const) {
      if (schema[keyword] === undefined) continue
      if (!isJsonObject(schema[keyword])) {
        throw new TypeError(`${keyword} must be an object at ${pointer}`)
      }
      const definitions: JsonObject = {}
      for (const [name, child] of Object.entries(schema[keyword])) {
        const childPointer = `${pointer}/${escapePointer(keyword)}/${escapePointer(name)}`
        const adapted = adaptNode(child, childPointer, root, state)
        definitions[name] = adapted.schema
        state.references.set(childPointer, adapted.projection)
      }
      output[keyword] = definitions
    }

    for (const keyword of ['allOf', 'anyOf', 'oneOf'] as const) {
      if (schema[keyword] === undefined) continue
      if (!Array.isArray(schema[keyword])) {
        throw new TypeError(`${keyword} must be an array at ${pointer}`)
      }
      const children = schema[keyword].map((child, index) =>
        adaptNode(child, `${pointer}/${keyword}/${index}`, root, state),
      )
      output[keyword] = children.map((child) => child.schema)
      projections.push(combineProjections(children.map((child) => child.projection)))
    }

    if (typeof schema.$ref === 'string') {
      projections.push({ kind: 'reference', reference: normalizeLocalReference(schema.$ref) })
    }

    const properties = schema.properties
    const objectLike = schema.type === 'object' || properties !== undefined
    if (objectLike) {
      if (properties !== undefined && !isJsonObject(properties)) {
        throw new TypeError(`properties must be an object at ${pointer}`)
      }
      const originalRequired = new Set(
        Array.isArray(schema.required)
          ? schema.required.filter((name): name is string => typeof name === 'string')
          : [],
      )
      const strictProperties: JsonObject = {}
      const propertyProjections = new Map<string, Projection>()
      const optionalNullKeys = new Set<string>()

      for (const [name, child] of Object.entries(properties ?? {})) {
        const adapted = adaptNode(child, `${pointer}/properties/${escapePointer(name)}`, root, state)
        const optional = !originalRequired.has(name)
        const needsSyntheticNull = optional && !schemaAllowsNull(child, root, new Set())
        strictProperties[name] = needsSyntheticNull
          ? { anyOf: [adapted.schema, { type: 'null' }] }
          : adapted.schema
        if (needsSyntheticNull) optionalNullKeys.add(name)
        propertyProjections.set(name, adapted.projection)
      }

      output.type = 'object'
      output.properties = strictProperties
      output.required = Object.keys(strictProperties)
      output.additionalProperties = false
      projections.push({
        kind: 'object',
        optionalNullKeys,
        properties: propertyProjections,
      })
    }

    if (schema.items !== undefined) {
      const adapted = adaptNode(schema.items, `${pointer}/items`, root, state)
      output.items = adapted.schema
      projections.push({ kind: 'array', items: adapted.projection })
    }

    return { schema: output, projection: combineProjections(projections) }
  } finally {
    state.ancestors.delete(schema)
  }
}

function schemaAllowsNull(schema: unknown, root: JsonObject, references: Set<string>): boolean {
  if (schema === true) return true
  if (schema === false || !isJsonObject(schema)) return false

  if (typeof schema.$ref === 'string') {
    const reference = normalizeLocalReference(schema.$ref)
    if (references.has(reference)) return false
    const target = resolveLocalReference(root, reference)
    if (target === undefined) return false
    references.add(reference)
    const allowed = schemaAllowsNull(target, root, references)
    references.delete(reference)
    return allowed
  }

  if (schema.const !== undefined) return schema.const === null
  if (Array.isArray(schema.enum)) return schema.enum.includes(null)
  if (typeof schema.type === 'string') return schema.type === 'null'
  if (Array.isArray(schema.type)) return schema.type.includes('null')
  if (Array.isArray(schema.allOf)) {
    return schema.allOf.every((child) => schemaAllowsNull(child, root, references))
  }
  if (Array.isArray(schema.anyOf)) {
    return schema.anyOf.some((child) => schemaAllowsNull(child, root, references))
  }
  if (Array.isArray(schema.oneOf)) {
    return schema.oneOf.filter((child) => schemaAllowsNull(child, root, references)).length === 1
  }

  // Type-specific constraints such as properties, items, minimum, and pattern do not reject null
  // unless `type` (or a combinator above) says they do. Preserving that JSON Schema rule prevents
  // us from deleting a null value that the workflow author intentionally allowed.
  return true
}

function projectSyntheticNulls(
  value: unknown,
  projection: Projection,
  references: ReadonlyMap<string, Projection>,
  activeReferences: Set<string>,
): void {
  switch (projection.kind) {
    case 'identity':
      return
    case 'object':
      if (!isJsonObject(value)) return
      for (const key of projection.optionalNullKeys) {
        if (value[key] === null) delete value[key]
      }
      for (const [key, child] of projection.properties) {
        if (Object.prototype.hasOwnProperty.call(value, key)) {
          projectSyntheticNulls(value[key], child, references, activeReferences)
        }
      }
      return
    case 'array':
      if (!Array.isArray(value)) return
      for (const item of value) projectSyntheticNulls(item, projection.items, references, activeReferences)
      return
    case 'composite':
      for (const child of projection.projections) {
        projectSyntheticNulls(value, child, references, activeReferences)
      }
      return
    case 'reference': {
      if (activeReferences.has(projection.reference)) return
      const target = references.get(projection.reference)
      if (target === undefined) return
      activeReferences.add(projection.reference)
      projectSyntheticNulls(value, target, references, activeReferences)
      activeReferences.delete(projection.reference)
    }
  }
}

function combineProjections(projections: readonly Projection[]): Projection {
  const active = projections.filter((projection) => projection.kind !== 'identity')
  if (active.length === 0) return IDENTITY
  if (active.length === 1) return active[0] as Projection
  return { kind: 'composite', projections: active }
}

function normalizeLocalReference(reference: string): string {
  if (!reference.startsWith('#')) {
    throw new TypeError(`External JSON Schema references are not supported by Codex: ${reference}`)
  }
  return reference.length === 1 ? '#' : reference
}

function resolveLocalReference(root: JsonObject, reference: string): unknown {
  if (reference === '#') return root
  if (!reference.startsWith('#/')) return undefined
  let value: unknown = root
  for (const encoded of reference.slice(2).split('/')) {
    if (!isJsonObject(value)) return undefined
    const key = encoded.replace(/~1/g, '/').replace(/~0/g, '~')
    value = value[key]
  }
  return value
}

function escapePointer(value: string): string {
  return value.replace(/~/g, '~0').replace(/\//g, '~1')
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
