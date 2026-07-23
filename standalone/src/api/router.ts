import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  WORKFLOW_MCP_REVISION,
  WORKFLOW_MCP_VERSION,
  type WorkflowRunListInput,
  type WorkflowService,
} from 'workflow-mcp'

import type { StandaloneConfig } from '../config/schema.js'
import { bearerMatches } from '../daemon/tokens.js'

export async function routeReadOnlyApi(
  request: IncomingMessage,
  response: ServerResponse,
  options: {
    service: WorkflowService
    config: StandaloneConfig
    webToken: string
  },
): Promise<boolean> {
  const url = new URL(request.url ?? '/', 'http://localhost')
  if (!url.pathname.startsWith('/api/v1/')) return false
  applySecurityHeaders(response)
  if (!validLocalOrigin(request.headers.origin)) {
    sendJson(response, 403, { schemaVersion: 1, error: { code: 'invalid-origin' } })
    return true
  }
  if (!bearerMatches(request.headers.authorization, options.webToken)) {
    response.setHeader('www-authenticate', 'Bearer')
    sendJson(response, 401, { schemaVersion: 1, error: { code: 'unauthorized' } })
    return true
  }
  if (request.method !== 'GET') {
    response.setHeader('allow', 'GET')
    sendJson(response, 405, { schemaVersion: 1, error: { code: 'read-only-api' } })
    return true
  }

  const scope = { cwd: options.config.workspace }
  try {
    if (url.pathname === '/api/v1/instance') {
      sendJson(response, 200, {
        schemaVersion: 1,
        version: WORKFLOW_MCP_VERSION,
        revision: WORKFLOW_MCP_REVISION,
        lifecycle: options.service.lifecycleState(),
        sourceMode: options.config.sourceMode,
        capabilities: { browserMutations: false, authoring: options.config.sourceMode === 'authoring' },
      })
      return true
    }
    if (url.pathname === '/api/v1/runs') {
      const statuses = url.searchParams.getAll('status')
      const page = await options.service.listRuns({
        ...(url.searchParams.get('cursor') === null
          ? {}
          : { cursor: url.searchParams.get('cursor')! }),
        limit: queryInteger(url, 'limit', 50, 1, 200),
        ...(statuses.length === 0 ? {} : { statuses: statuses as ProtocolRunStatus[] }),
      })
      sendJson(response, 200, { schemaVersion: 1, ...page })
      return true
    }
    const match = /^\/api\/v1\/runs\/(run_[A-Za-z0-9_-]+)(?:\/(.*))?$/.exec(url.pathname)
    if (match === null) return false
    const runId = match[1]!
    const tail = match[2]
    if (tail === undefined) {
      const snapshot = await options.service.snapshot(scope, runId)
      sendJson(response, 200, {
        schemaVersion: 1,
        run: sanitizeManifest(snapshot.manifest),
        cursor: snapshot.cursor,
        state: snapshot.state,
      })
      return true
    }
    if (tail === 'events') {
      const page = await options.service.readEvents(scope, {
        runId,
        after: queryInteger(url, 'after', 0, 0, Number.MAX_SAFE_INTEGER),
        limit: queryInteger(url, 'limit', 200, 1, 1_000),
        waitMs: queryInteger(url, 'waitMs', 0, 0, 30_000),
      })
      // The core service deliberately returns cwd because it is also consumed by trusted embedded
      // hosts. This boundary is less trusted: even an authenticated browser response must not turn
      // the API into a convenient absolute-path oracle for copied diagnostics or extensions.
      const { cwd: _privateCwd, ...publicPage } = page
      sendJson(response, 200, { schemaVersion: 1, ...publicPage })
      return true
    }
    if (tail === 'result') {
      const artifactId = url.searchParams.get('artifactId')
      if (artifactId === null) throw requestError('artifactId is required')
      const page = await options.service.readResult(scope, {
        runId,
        artifactId,
        ...(url.searchParams.get('cursor') === null
          ? {}
          : { cursor: url.searchParams.get('cursor')! }),
        maxBytes: queryInteger(url, 'maxBytes', 16 * 1024, 4, 64 * 1024),
      })
      sendJson(response, 200, { schemaVersion: 1, ...page })
      return true
    }
    if (tail === 'agents') {
      const page = await options.service.listAgents(scope, {
        runId,
      })
      sendJson(response, 200, { schemaVersion: 1, ...page })
      return true
    }
    const agentMatch = /^agents\/(agent_[0-9]+)\/(result|transcript)$/.exec(tail)
    if (agentMatch !== null && agentMatch[2] === 'result') {
      const page = await options.service.readAgentResult(scope, {
        runId,
        agentId: agentMatch[1]!,
        ...(url.searchParams.get('artifactId') === null
          ? {}
          : { artifactId: url.searchParams.get('artifactId')! }),
        ...(url.searchParams.get('cursor') === null
          ? {}
          : { cursor: url.searchParams.get('cursor')! }),
        maxBytes: queryInteger(url, 'maxBytes', 16 * 1024, 4, 64 * 1024),
      })
      sendJson(response, 200, { schemaVersion: 1, ...page })
      return true
    }
    if (agentMatch !== null) {
      const page = await options.service.readAgentTranscript(scope, {
        runId,
        agentId: agentMatch[1]!,
        after: queryInteger(url, 'after', 0, 0, Number.MAX_SAFE_INTEGER),
        limit: queryInteger(url, 'limit', 200, 1, 1_000),
      })
      sendJson(response, 200, { schemaVersion: 1, ...page })
      return true
    }
    return false
  } catch (error) {
    const code = errorCode(error)
    const status = code === 'run-not-found' || code === 'agent-not-found' ? 404
      : code === 'scope-forbidden' ? 403
        : code === 'service-stopping' || code === 'service-stopped' ? 503
          : code === 'invalid-request' || code === 'invalid-cursor' || code === 'cursor-ahead' ? 400
            : 500
    sendJson(response, status, {
      schemaVersion: 1,
      error: { code, message: error instanceof Error ? error.message : String(error) },
    })
    return true
  }
}

// There are intentionally two run-status vocabularies in core: the reducer also has a transient
// `pending` state that can never be persisted in the standalone inventory. Deriving this type from
// the public list contract prevents the browser boundary from accidentally accepting that state.
type ProtocolRunStatus = NonNullable<WorkflowRunListInput['statuses']>[number]

export function applySecurityHeaders(response: ServerResponse): void {
  response.setHeader('content-security-policy', "default-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'")
  response.setHeader('x-content-type-options', 'nosniff')
  response.setHeader('x-frame-options', 'DENY')
  response.setHeader('referrer-policy', 'no-referrer')
  response.setHeader('cache-control', 'no-store')
}

export function validLocalHost(host: string | undefined): boolean {
  if (host === undefined) return false
  const hostname = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':', 1)[0]
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1'
}

function validLocalOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return true
  try {
    const hostname = new URL(origin).hostname
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1'
  } catch {
    return false
  }
}

function sanitizeManifest(manifest: Awaited<ReturnType<WorkflowService['status']>>): object {
  return {
    schemaVersion: manifest.schemaVersion,
    runId: manifest.runId,
    workflow: {
      name: manifest.workflow.name,
      title: manifest.workflow.title,
      description: manifest.workflow.description,
      sourceHash: manifest.workflow.sourceHash,
    },
    status: manifest.status,
    cursor: manifest.cursor,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
    lineageId: manifest.lineageId ?? manifest.runId,
    resumedFromRunId: manifest.resumedFromRunId,
    recoveryMode: manifest.recoveryMode,
    result: manifest.result,
    error: manifest.error,
  }
}

function queryInteger(
  url: URL,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = url.searchParams.get(name)
  if (raw === null) return fallback
  if (!/^\d+$/.test(raw)) throw requestError(`${name} must be an integer`)
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw requestError(`${name} must be from ${minimum} through ${maximum}`)
  }
  return value
}

function requestError(message: string): Error & { code: 'invalid-request' } {
  return Object.assign(new Error(message), { code: 'invalid-request' as const })
}

function errorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : 'internal-error'
}

export function sendJson(response: ServerResponse, status: number, body: object): void {
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.end(JSON.stringify(body))
}
