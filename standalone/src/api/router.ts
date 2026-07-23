import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  WORKFLOW_MCP_REVISION,
  WORKFLOW_MCP_VERSION,
  type StoredWorkflowEvent,
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
    startedAt: string
    authenticationMode: 'api-key-secret' | 'interactive'
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
        runtime: {
          // WHY: embedded development tests may use a private host path, while the shipped product
          // always presents the fixed container scope below. The browser/TUI needs a useful mount
          // identity, not an authenticated oracle for a developer's absolute filesystem layout.
          workspace: '/workspace',
          mountMode: options.config.sourceMode === 'authoring' ? 'workflow-authoring' : 'project-read-only',
          authentication: {
            mode: options.authenticationMode,
            // API-key bytes were validated before readiness. Interactive Codex state can change
            // only through the admin broker, so this GET-only surface directs operators to the
            // authoritative auth command instead of running Codex on every two-second UI poll.
            status: options.authenticationMode === 'api-key-secret' ? 'configured' : 'operator-check-required',
          },
          startedAt: options.startedAt,
          uptimeSeconds: Math.max(0, Math.floor((Date.now() - Date.parse(options.startedAt)) / 1_000)),
          providerCapacity: options.config.concurrency,
        },
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
        state: publicState(snapshot.state),
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
      const { cwd: _privateCwd, events, ...publicPage } = page
      sendJson(response, 200, {
        schemaVersion: 1,
        ...publicPage,
        events: events.map(publicEvent),
      })
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
      sendJson(response, 200, {
        schemaVersion: 1,
        runId: page.runId,
        cursor: page.cursor,
        agents: page.agents.map(agent => ({
          agentId: agent.agentId,
          callIndex: agent.callIndex,
          label: agent.label,
          phaseId: agent.phaseId,
          status: agent.status,
          reused: agent.reused,
          coverageGap: agent.coverageGap,
          attempts: agent.attempts.map(attempt => ({
            attemptId: attempt.attemptId,
            number: attempt.attemptNumber,
            status: attempt.status,
            startedAt: attempt.startedAt,
            completedAt: attempt.completedAt,
          })),
          result: agent.result,
        })),
      })
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
      sendJson(response, 200, {
        schemaVersion: 1,
        ...page,
        // Unlike the wake-only run event feed, this explicit agent evidence reader deliberately
        // returns bounded prompt/output/log content. Its projection still strips workspace paths,
        // provider session IDs, cache keys, raw errors, diagnostics, and provider-native data.
        events: page.events.map(publicTranscriptEvent),
      })
      return true
    }
    return false
  } catch (error) {
    const publicError = publicApiError(error)
    sendJson(response, publicError.status, {
      schemaVersion: 1,
      error: { code: publicError.code, message: publicError.message },
    })
    return true
  }
}

// There are intentionally two run-status vocabularies in core: the reducer also has a transient
// `pending` state that can never be persisted in the standalone inventory. Deriving this type from
// the public list contract prevents the browser boundary from accidentally accepting that state.
type ProtocolRunStatus = NonNullable<WorkflowRunListInput['statuses']>[number]

export function applySecurityHeaders(response: ServerResponse): void {
  response.setHeader('content-security-policy', "default-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
  response.setHeader('x-content-type-options', 'nosniff')
  response.setHeader('x-frame-options', 'DENY')
  response.setHeader('referrer-policy', 'no-referrer')
  response.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()')
  response.setHeader('cross-origin-opener-policy', 'same-origin')
  response.setHeader('cross-origin-resource-policy', 'same-origin')
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
    ...(manifest.error === undefined ? {} : { error: { present: true } }),
  }
}

function publicState(
  state: Awaited<ReturnType<WorkflowService['snapshot']>>['state'],
): object {
  // Browser/TUI consumers need progress, not provider/session/worktree internals. This is a
  // deliberately enumerated DTO: spreading the core reducer state would make every future field a
  // public disclosure by default (workspace.path was the concrete failure that motivated it).
  return {
    schemaVersion: state.schemaVersion,
    runId: state.runId,
    status: state.status,
    sequence: state.sequence,
    workflow: state.workflow === undefined ? undefined : {
      name: state.workflow.name,
      title: state.workflow.title,
      description: state.workflow.description,
    },
    counts: state.counts,
    phases: state.phases.map(phase => ({
      id: phase.id,
      title: phase.title,
      status: phase.status,
      enteredAt: phase.enteredAt,
      completedAt: phase.completedAt,
      complete: phase.complete,
      agentCount: phase.agentIds.length,
    })),
    agents: state.agents.map(agent => ({
      id: agent.id,
      label: agent.label,
      phaseId: agent.phaseId,
      status: agent.status,
      attemptCount: agent.attempts.length,
      reused: agent.outcome?.source === 'journal',
    })),
    warnings: state.warnings.map(warning => ({
      eventId: warning.eventId,
      sequence: warning.sequence,
      timestamp: warning.timestamp,
      phaseId: warning.phaseId,
      agentId: warning.agentId,
      attemptId: warning.attemptId,
      ...publicWarning(warning.code),
    })),
  }
}

function publicWarning(code: string | undefined): { code: string; message: string } {
  const known: Readonly<Record<string, string>> = {
    'workflow-budget-exceeded': 'The workflow token budget is exhausted; further agent calls are blocked.',
    'model-alias-mapped': 'A workflow model alias was resolved by the configured provider policy.',
    'working-directory-preserved-for-recovery': 'An isolated working directory was preserved for operator recovery.',
    'working-directory-preserved': 'An isolated working directory with changes was preserved for operator review.',
    'working-directory-cleanup-failed': 'An isolated working directory could not be cleaned up automatically.',
    'agent-soft-stall': 'An agent is quiet long enough to warrant observation; its hard deadline has not fired.',
    'provider-termination-unconfirmed': 'The provider execution boundary could not prove every descendant stopped.',
    'workflow-capacity-unfilled-no-runnable-work': 'Provider capacity is available but no additional work has been admitted.',
  }
  if (code !== undefined && Object.prototype.hasOwnProperty.call(known, code)) {
    return { code, message: known[code]! }
  }
  // WHY: provider warnings and failures may include raw stderr, commands, environment values, or
  // private `/data/workspaces` paths in both message and code. Replacing only the public project
  // path is not a security boundary. Browser/TUI gets a stable classification; the separately
  // authenticated MCP evidence surface retains the complete diagnostic.
  return {
    code: 'provider-warning',
    message: 'A provider warning was recorded; inspect the authenticated MCP evidence for details.',
  }
}

function publicEvent(stored: StoredWorkflowEvent): object {
  // Event payloads can contain provider activity commands, warning details, prompts, and workspace
  // metadata. The read-only browser surface exposes chronology/identity only; complete evidence
  // remains available to the separately authenticated MCP surface and paged result endpoints.
  return {
    runId: stored.runId,
    cursor: stored.cursor,
    recordedAt: stored.recordedAt,
    event: {
      schemaVersion: stored.event.schemaVersion,
      type: stored.event.type,
      runId: stored.event.runId,
      sequence: stored.event.sequence,
      eventId: stored.event.eventId,
      timestamp: stored.event.timestamp,
      ...('phaseId' in stored.event && stored.event.phaseId !== undefined ? { phaseId: stored.event.phaseId } : {}),
      ...('agentId' in stored.event && stored.event.agentId !== undefined ? { agentId: stored.event.agentId } : {}),
      ...('attemptId' in stored.event && stored.event.attemptId !== undefined ? { attemptId: stored.event.attemptId } : {}),
    },
  }
}

function publicTranscriptEvent(stored: StoredWorkflowEvent): object {
  const event = stored.event
  const envelope = {
    schemaVersion: event.schemaVersion,
    type: event.type,
    runId: event.runId,
    sequence: event.sequence,
    eventId: event.eventId,
    timestamp: event.timestamp,
    ...('phaseId' in event && event.phaseId !== undefined ? { phaseId: event.phaseId } : {}),
    ...('agentId' in event && event.agentId !== undefined ? { agentId: event.agentId } : {}),
    ...('attemptId' in event && event.attemptId !== undefined ? { attemptId: event.attemptId } : {}),
  }
  let payload: object
  switch (event.type) {
    case 'agent.admitted':
      payload = {
        callIndex: event.payload.callIndex,
        label: event.payload.label,
        prompt: publicContent(event.payload.prompt),
        options: {
          model: event.payload.options.model,
          effort: event.payload.options.effort,
          agentType: event.payload.options.agentType,
        },
      }
      break
    case 'agent.started':
      payload = {
        attemptNumber: event.payload.attemptNumber,
        source: event.payload.source,
        provider: event.payload.provider,
        startupDeadlineAt: event.payload.startupDeadlineAt,
        absoluteDeadlineAt: event.payload.absoluteDeadlineAt,
      }
      break
    case 'agent.workspace.prepared':
      payload = { reused: event.payload.reused }
      break
    case 'agent.session.started':
      payload = { established: true }
      break
    case 'agent.activity.started':
      payload = {
        activity: {
          activityId: event.payload.activity.activityId,
          kind: event.payload.activity.kind,
          title: event.payload.activity.title,
          ...(event.payload.activity.content === undefined ? {} : { content: publicContent(event.payload.activity.content) }),
        },
      }
      break
    case 'agent.activity.updated':
    case 'agent.activity.completed':
      payload = {
        activityId: event.payload.activityId,
        title: event.payload.title,
        ...(event.payload.content === undefined ? {} : { content: publicContent(event.payload.content) }),
        ...('error' in event.payload && event.payload.error !== undefined ? { error: { present: true } } : {}),
      }
      break
    case 'agent.completed':
    case 'agent.reused':
      payload = {
        source: event.payload.source,
        result: publicContent(event.payload.result),
        structured: event.payload.structured,
        usage: event.payload.usage,
      }
      break
    case 'agent.failed':
      payload = { error: { present: true }, retrying: event.payload.retrying }
      break
    case 'agent.retry_scheduled':
      payload = {
        completedAttemptNumber: event.payload.completedAttemptNumber,
        nextAttemptNumber: event.payload.nextAttemptNumber,
        delayMs: event.payload.delayMs,
        retryAt: event.payload.retryAt,
        reason: { present: true },
      }
      break
    case 'agent.recovery_required':
      payload = { error: { present: true }, replaySafety: { automatic: event.payload.replaySafety.automatic } }
      break
    case 'warning':
      payload = publicWarning(event.payload.code)
      break
    case 'log':
      payload = { level: event.payload.level, message: publicContent(event.payload.message) }
      break
    case 'agent.queued':
    case 'agent.skipped':
    case 'agent.cancelled':
      payload = {}
      break
    case 'agent.stalled':
      payload = {
        kind: event.payload.kind,
        lastProgressAt: event.payload.lastProgressAt,
        deadlineAt: event.payload.deadlineAt,
      }
      break
    case 'agent.termination_confirmed':
      payload = { reason: event.payload.reason, boundary: event.payload.boundary }
      break
    case 'agent.recovery_started':
    case 'agent.recovery_completed':
      payload = { previousAttemptId: event.payload.previousAttemptId }
      break
    case 'artifact.created':
      payload = {
        artifactId: event.payload.artifactId,
        name: event.payload.name,
        mediaType: event.payload.mediaType,
        sizeBytes: event.payload.sizeBytes,
      }
      break
    default:
      // Agent transcript filtering should keep run/phase events out. An additive future event is
      // still visible by identity/type, but its payload starts closed until explicitly reviewed.
      payload = {}
  }
  return { runId: stored.runId, cursor: stored.cursor, recordedAt: stored.recordedAt, event: { ...envelope, payload } }
}

function publicContent(value: {
  preview: string
  lineCount: number
  content?: unknown
  artifactId?: string
  mediaType?: string
  truncated?: boolean
  sizeBytes?: number
  checksum?: unknown
}): object {
  return {
    preview: value.preview,
    lineCount: value.lineCount,
    ...(value.content === undefined ? {} : { content: value.content }),
    ...(value.artifactId === undefined ? {} : { artifactId: value.artifactId }),
    ...(value.mediaType === undefined ? {} : { mediaType: value.mediaType }),
    ...(value.truncated === undefined ? {} : { truncated: value.truncated }),
    ...(value.sizeBytes === undefined ? {} : { sizeBytes: value.sizeBytes }),
    ...(value.checksum === undefined ? {} : { checksum: value.checksum }),
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

function publicApiError(error: unknown): { status: number; code: string; message: string } {
  const rawCode = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : 'internal-error'
  const known: Readonly<Record<string, { status: number; message: string }>> = {
    'run-not-found': { status: 404, message: 'Workflow run was not found.' },
    'agent-not-found': { status: 404, message: 'Workflow agent was not found.' },
    'scope-forbidden': { status: 403, message: 'The requested workflow object is outside this project scope.' },
    'service-stopping': { status: 503, message: 'Workflow MCP is stopping; retry after it restarts.' },
    'service-stopped': { status: 503, message: 'Workflow MCP is stopped; retry after it restarts.' },
    'invalid-request': { status: 400, message: 'Request parameters are invalid.' },
    'invalid-cursor': { status: 400, message: 'The supplied cursor is invalid or stale.' },
    'cursor-ahead': { status: 400, message: 'The supplied cursor is ahead of the durable event stream.' },
  }
  const selected = known[rawCode]
  if (selected !== undefined) return { code: rawCode, ...selected }
  // WHY: exception messages and even custom error codes can originate in providers or filesystem
  // errors and carry stderr, secret values, or `/data` paths. The HTTP response is a public DTO;
  // full diagnostics belong in private structured logs and authenticated MCP evidence.
  return { status: 500, code: 'internal-error', message: 'Workflow MCP could not complete the request.' }
}

export function sendJson(response: ServerResponse, status: number, body: object): void {
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.end(JSON.stringify(body))
}
