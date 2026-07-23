import type {
  WorkflowAgentCounts,
  WorkflowResultPage,
  WorkflowRunStatus,
} from 'workflow-mcp/state'

// The browser and TUI intentionally do not receive the core reducer snapshot. Core state contains
// prompts, provider references, workspace paths, and future fields that must not become public by
// accident. Keep this DTO colocated with the only transport client that consumes it so renderers
// cannot type-assert the hardened API back into the privileged internal shape.
export type PublicRunState = {
  schemaVersion: 1
  runId: string
  status: WorkflowRunStatus
  sequence: number
  workflow?: { name: string; title?: string; description: string }
  counts: WorkflowAgentCounts
  phases: Array<{
    id: string
    title: string
    status: string
    enteredAt?: string
    completedAt?: string
    complete: boolean
    agentCount: number
  }>
  agents: Array<{
    id: string
    label: string
    phaseId?: string
    status: string
    attemptCount: number
    reused: boolean
  }>
  warnings: Array<{
    eventId: string
    sequence: number
    timestamp: string
    phaseId?: string
    agentId?: string
    attemptId?: string
    code?: string
    message: string
  }>
}

export type PublicStoredWorkflowEvent = {
  runId: string
  cursor: number
  recordedAt: string
  event: {
    schemaVersion: 1
    type: string
    runId: string
    sequence: number
    eventId: string
    timestamp: string
    phaseId?: string
    agentId?: string
    attemptId?: string
  }
}

export type RunSummary = {
  schemaVersion: 1
  runId: string
  workflow: { name: string; title?: string; description: string; sourceHash?: string }
  status: string
  cursor: number
  createdAt: string
  updatedAt: string
  lineageId: string
  resumedFromRunId?: string
  recoveryMode?: string
  result?: { artifactId: string; mediaType: string; sizeBytes: number; lineCount: number }
  error?: { present: true }
}

export type PublicAgentListPage = {
  schemaVersion: 1
  runId: string
  cursor: number
  agents: Array<{
    agentId: string
    callIndex: number
    label: string
    phaseId?: string
    status: string
    reused: boolean
    coverageGap: boolean
    attempts: Array<{
      attemptId: string
      number: number
      status: string
      startedAt?: string
      completedAt?: string
    }>
    result: {
      available: boolean
      source: string
      artifactId?: string
      mediaType?: string
      sizeBytes?: number
      lineCount?: number
    }
  }>
}

export type PublicAgentResultPage = WorkflowResultPage & {
  schemaVersion: 1
  runId: string
  agentId: string
  source: 'artifact' | 'journal'
}

export type PublicAgentTranscriptPage = {
  schemaVersion: 1
  runId: string
  agentId: string
  fromCursor: number
  toCursor: number
  events: Array<PublicStoredWorkflowEvent & {
    event: PublicStoredWorkflowEvent['event'] & { payload: unknown }
  }>
  hasMore: boolean
}

export type RunInventoryPage = {
  schemaVersion: 1
  items: RunSummary[]
  nextCursor?: string
  hasMore: boolean
}

export type InstanceSummary = {
  schemaVersion: 1
  version: string
  revision: string
  lifecycle: string
  sourceMode: string
  capabilities: { browserMutations: false; authoring: boolean }
  runtime: {
    workspace: '/workspace'
    mountMode: 'project-read-only' | 'workflow-authoring'
    authentication: {
      mode: 'api-key-secret' | 'host-codex' | 'interactive'
      status: 'configured' | 'operator-check-required'
    }
    startedAt: string
    uptimeSeconds: number
    providerCapacity: number
  }
}

export class StandaloneApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'StandaloneApiError'
    this.status = status
    this.code = code
  }
}

export class StandaloneTransportError extends Error {
  constructor(cause: unknown) {
    super('Workflow MCP API is temporarily unavailable', { cause })
    this.name = 'StandaloneTransportError'
  }
}

/** Transport-only client shared by ANSI and DOM renderers; durable state still comes from core. */
export class StandaloneApiClient {
  readonly #baseUrl: string
  readonly #token: string
  readonly #fetch: typeof fetch

  constructor(options: { baseUrl?: string; token: string; fetch?: typeof fetch }) {
    this.#baseUrl = (options.baseUrl ?? '').replace(/\/$/, '')
    this.#token = options.token
    this.#fetch = options.fetch ?? globalThis.fetch
  }

  async instance(signal?: AbortSignal): Promise<InstanceSummary> {
    return this.#get<InstanceSummary>('/api/v1/instance', signal)
  }

  async runs(options: { cursor?: string; limit?: number; statuses?: string[] } = {}, signal?: AbortSignal): Promise<RunInventoryPage> {
    const query = new URLSearchParams()
    if (options.cursor !== undefined) query.set('cursor', options.cursor)
    query.set('limit', String(options.limit ?? 50))
    for (const status of options.statuses ?? []) query.append('status', status)
    const page = await this.#get<RunInventoryPage>(`/api/v1/runs?${query}`, signal)
    for (const run of apiArray(page.items, 'run inventory')) requireApiSchema<RunSummary>(run, 'run summary')
    return page
  }

  async run(runId: string, signal?: AbortSignal): Promise<{
    schemaVersion: 1
    run: RunSummary
    cursor: number
    state: PublicRunState
  }> {
    const snapshot = await this.#get<{
      schemaVersion: 1
      run: RunSummary
      cursor: number
      state: PublicRunState
    }>(`/api/v1/runs/${encodeURIComponent(runId)}`, signal)
    requireApiSchema<RunSummary>(snapshot.run, 'run summary')
    requireApiSchema<PublicRunState>(snapshot.state, 'run state')
    return snapshot
  }

  async events(runId: string, after: number, options: { limit?: number; waitMs?: number } = {}, signal?: AbortSignal): Promise<{
    schemaVersion: 1
    runId: string
    fromCursor: number
    toCursor: number
    events: PublicStoredWorkflowEvent[]
    hasMore: boolean
  }> {
    const query = new URLSearchParams({
      after: String(after),
      limit: String(options.limit ?? 200),
      waitMs: String(options.waitMs ?? 0),
    })
    const page = await this.#get<{
      schemaVersion: 1
      runId: string
      fromCursor: number
      toCursor: number
      events: PublicStoredWorkflowEvent[]
      hasMore: boolean
    }>(`/api/v1/runs/${encodeURIComponent(runId)}/events?${query}`, signal)
    validateEventEnvelopes(page.events, 'run event')
    return page
  }

  result(runId: string, artifactId: string, cursor?: string, signal?: AbortSignal): Promise<WorkflowResultPage & { schemaVersion: 1 }> {
    const query = new URLSearchParams({ artifactId, maxBytes: String(64 * 1024) })
    if (cursor !== undefined) query.set('cursor', cursor)
    return this.#get(`/api/v1/runs/${encodeURIComponent(runId)}/result?${query}`, signal)
  }

  agents(runId: string, signal?: AbortSignal): Promise<PublicAgentListPage> {
    return this.#get(`/api/v1/runs/${encodeURIComponent(runId)}/agents`, signal)
  }

  agentResult(
    runId: string,
    agentId: string,
    options: { artifactId?: string; cursor?: string } = {},
    signal?: AbortSignal,
  ): Promise<PublicAgentResultPage> {
    const query = new URLSearchParams({ maxBytes: String(64 * 1024) })
    if (options.artifactId !== undefined) query.set('artifactId', options.artifactId)
    if (options.cursor !== undefined) query.set('cursor', options.cursor)
    return this.#get(`/api/v1/runs/${encodeURIComponent(runId)}/agents/${encodeURIComponent(agentId)}/result?${query}`, signal)
  }

  async agentTranscript(
    runId: string,
    agentId: string,
    after = 0,
    signal?: AbortSignal,
  ): Promise<PublicAgentTranscriptPage> {
    const query = new URLSearchParams({ after: String(after), limit: '200' })
    const page = await this.#get<PublicAgentTranscriptPage>(
      `/api/v1/runs/${encodeURIComponent(runId)}/agents/${encodeURIComponent(agentId)}/transcript?${query}`,
      signal,
    )
    // Transcript payload is intentionally operator-visible arbitrary data and may itself contain a
    // domain field named `schemaVersion`. Validate only the API-owned outer event envelope; a blind
    // recursive walk would reject perfectly valid workflow output that happens to describe v2 data.
    validateEventEnvelopes(page.events, 'agent transcript event')
    return page
  }

  async #get<T>(path: string, signal?: AbortSignal): Promise<T> {
    let response: Response
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        headers: { authorization: `Bearer ${this.#token}` },
        ...(signal === undefined ? {} : { signal }),
      })
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error
      // A distinct transport class lets browser reconnect policy retry connectivity without also
      // hiding renderer/programming defects behind an infinite "network" loop.
      throw new StandaloneTransportError(error)
    }
    const body = await response.json().catch(() => undefined) as unknown
    if (!response.ok) {
      const error = isObject(body) && isObject(body.error) ? body.error : undefined
      const code = error !== undefined && typeof error.code === 'string' ? error.code : `http-${response.status}`
      const message = error !== undefined && typeof error.message === 'string'
        ? error.message
        : `Workflow MCP API returned HTTP ${response.status}`
      throw new StandaloneApiError(response.status, code, message)
    }
    // Browser assets and the TUI can outlive a daemon upgrade. Every successful endpoint is a
    // versioned envelope, so accepting only `/instance` while type-asserting the others lets an old
    // renderer silently consume a newer inventory/result protocol.
    return requireApiSchema<T>(body, 'response')
  }
}

function validateEventEnvelopes(value: unknown, subject: string): void {
  for (const stored of apiArray(value, `${subject} collection`)) {
    if (!isObject(stored)) throw incompatibleSchema(`${subject} wrapper`)
    requireApiSchema(stored.event, subject)
  }
}

function apiArray(value: unknown, subject: string): unknown[] {
  if (!Array.isArray(value)) throw incompatibleSchema(subject)
  return value
}

function requireApiSchema<T>(value: unknown, subject: string): T {
  if (!isObject(value) || value.schemaVersion !== 1) throw incompatibleSchema(subject)
  return value as T
}

function incompatibleSchema(subject: string): StandaloneApiError {
  return new StandaloneApiError(
    502,
    'incompatible-schema',
    `Workflow MCP ${subject} schema is incompatible with this client; reload after upgrading.`,
  )
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
