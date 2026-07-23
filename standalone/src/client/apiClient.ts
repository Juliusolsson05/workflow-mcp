import type {
  StoredWorkflowEvent,
  WorkflowResultPage,
  WorkflowSnapshot,
} from 'workflow-mcp/state'

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

  instance(signal?: AbortSignal): Promise<InstanceSummary> {
    return this.#get('/api/v1/instance', signal)
  }

  runs(options: { cursor?: string; limit?: number; statuses?: string[] } = {}, signal?: AbortSignal): Promise<RunInventoryPage> {
    const query = new URLSearchParams()
    if (options.cursor !== undefined) query.set('cursor', options.cursor)
    query.set('limit', String(options.limit ?? 50))
    for (const status of options.statuses ?? []) query.append('status', status)
    return this.#get(`/api/v1/runs?${query}`, signal)
  }

  run(runId: string, signal?: AbortSignal): Promise<{
    schemaVersion: 1
    run: RunSummary
    cursor: number
    state: WorkflowSnapshot
  }> {
    return this.#get(`/api/v1/runs/${encodeURIComponent(runId)}`, signal)
  }

  events(runId: string, after: number, options: { limit?: number; waitMs?: number } = {}, signal?: AbortSignal): Promise<{
    schemaVersion: 1
    runId: string
    fromCursor: number
    toCursor: number
    events: StoredWorkflowEvent[]
    hasMore: boolean
  }> {
    const query = new URLSearchParams({
      after: String(after),
      limit: String(options.limit ?? 200),
      waitMs: String(options.waitMs ?? 0),
    })
    return this.#get(`/api/v1/runs/${encodeURIComponent(runId)}/events?${query}`, signal)
  }

  result(runId: string, artifactId: string, cursor?: string, signal?: AbortSignal): Promise<WorkflowResultPage & { schemaVersion: 1 }> {
    const query = new URLSearchParams({ artifactId, maxBytes: String(64 * 1024) })
    if (cursor !== undefined) query.set('cursor', cursor)
    return this.#get(`/api/v1/runs/${encodeURIComponent(runId)}/result?${query}`, signal)
  }

  agents(runId: string, signal?: AbortSignal): Promise<Record<string, unknown> & { schemaVersion: 1 }> {
    return this.#get(`/api/v1/runs/${encodeURIComponent(runId)}/agents`, signal)
  }

  async #get<T>(path: string, signal?: AbortSignal): Promise<T> {
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      headers: { authorization: `Bearer ${this.#token}` },
      ...(signal === undefined ? {} : { signal }),
    })
    const body = await response.json().catch(() => undefined) as unknown
    if (!response.ok) {
      const error = isObject(body) && isObject(body.error) ? body.error : undefined
      const code = error !== undefined && typeof error.code === 'string' ? error.code : `http-${response.status}`
      const message = error !== undefined && typeof error.message === 'string'
        ? error.message
        : `Workflow MCP API returned HTTP ${response.status}`
      throw new StandaloneApiError(response.status, code, message)
    }
    return body as T
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
