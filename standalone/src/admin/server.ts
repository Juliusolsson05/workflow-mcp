import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { chmod, lstat, mkdir, rm } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { WorkflowService } from 'workflow-mcp'

import { sendJson } from '../api/router.js'
import type { StandaloneConfig } from '../config/schema.js'
import { approveVisibleWorkflow, type SourceApprovalStore } from '../daemon/sourceApprovals.js'
import { bearerMatches } from '../daemon/tokens.js'
import type { CodexCredentialBroker } from '../daemon/auth.js'

const MAX_ADMIN_BODY_BYTES = 64 * 1024

export type StandaloneAdminServer = {
  socketPath: string
  close(): Promise<void>
}

export async function startStandaloneAdminServer(options: {
  config: StandaloneConfig
  service: WorkflowService
  approvals: SourceApprovalStore
  auth: CodexCredentialBroker
  token: string
}): Promise<StandaloneAdminServer> {
  const socketPath = options.config.adminSocketPath
  await prepareSocketPath(socketPath)
  const requestControllers = new Set<AbortController>()
  let closing = false
  const server = createServer((request, response) => {
    if (closing) {
      sendJson(response, 503, { schemaVersion: 1, error: { code: 'service-stopping' } })
      return
    }
    // Every route gets a cancellation lifetime, not only device login. `codex login status` and
    // `codex logout` are external programs too, so either can wedge shutdown if a broken binary
    // ignores TERM. Keeping the controller at the HTTP boundary also cancels work when the caller
    // disconnects instead of holding the global administrative writer for an orphaned request.
    const controller = new AbortController()
    requestControllers.add(controller)
    response.once('close', () => {
      if (!response.writableEnded) controller.abort()
    })
    void routeAdminRequest(request, response, options, controller.signal).catch(error => {
      if (!response.headersSent) {
        sendJson(response, 500, adminError('internal-error', error))
      } else if (!response.writableEnded) response.end()
    }).finally(() => requestControllers.delete(controller))
  })
  await listen(server, socketPath)
  try {
    // Unix socket permissions are part of authentication, not a cosmetic hardening step. The
    // bearer token protects against accidental same-UID forwarding; 0600 prevents another local
    // container user from opening the control plane in the first place.
    await chmod(socketPath, 0o600)
  } catch (error) {
    await closeAndRemove(server, socketPath).catch(() => undefined)
    throw error
  }
  let closePromise: Promise<void> | undefined
  return {
    socketPath,
    close(): Promise<void> {
      if (closePromise === undefined) {
        // Device auth can legitimately wait for a human for minutes. Abort those requests before
        // server.close() so daemon shutdown is bounded by the broker's TERM→KILL reap policy rather
        // than Docker's outer grace timeout.
        closing = true
        for (const controller of requestControllers) controller.abort()
        closePromise = closeAndRemove(server, socketPath)
      }
      return closePromise
    },
  }
}

async function routeAdminRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: {
    config: StandaloneConfig
    service: WorkflowService
    approvals: SourceApprovalStore
    auth: CodexCredentialBroker
    token: string
  },
  signal: AbortSignal,
): Promise<void> {
  response.setHeader('cache-control', 'no-store')
  response.setHeader('x-content-type-options', 'nosniff')
  if (!bearerMatches(request.headers.authorization, options.token)) {
    response.setHeader('www-authenticate', 'Bearer')
    sendJson(response, 401, { schemaVersion: 1, error: { code: 'unauthorized' } })
    return
  }
  const url = new URL(request.url ?? '/', 'http://workflow-mcp-admin.invalid')
  try {
    if (request.method === 'POST' && url.pathname === '/v1/auth/login') {
      await streamAuthenticationLogin(request, response, options.auth, signal)
      return
    }
    if (request.method === 'GET' && url.pathname === '/v1/auth/status') {
      sendJson(response, 200, await options.auth.status(signal))
      return
    }
    if (request.method === 'POST' && url.pathname === '/v1/auth/logout') {
      await options.auth.logout(signal)
      sendJson(response, 200, { schemaVersion: 1, status: 'logged-out' })
      return
    }
    if (request.method === 'GET' && url.pathname === '/v1/status') {
      sendJson(response, 200, {
        schemaVersion: 1,
        lifecycle: options.service.lifecycleState(),
        activeRuns: options.service.hasActiveRuns(),
      })
      return
    }
    if (request.method === 'GET' && url.pathname === '/v1/source-approvals') {
      sendJson(response, 200, { schemaVersion: 1, items: options.approvals.list() })
      return
    }
    if (request.method === 'POST' && url.pathname === '/v1/source-approvals') {
      const body = await readJsonBody(request)
      if (!isObject(body) || typeof body.name !== 'string' || body.name.length === 0 || body.name.length > 256) {
        throw requestError('name must be a non-empty string of at most 256 characters')
      }
      if (body.expectedSourceHash !== undefined && (
        typeof body.expectedSourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(body.expectedSourceHash)
      )) throw requestError('expectedSourceHash must be a lowercase SHA-256 value')
      const approval = await approveVisibleWorkflow({
        service: options.service,
        approvals: options.approvals,
        workspace: options.config.workspace,
        workflowName: body.name,
        ...(body.expectedSourceHash === undefined ? {} : { expectedSourceHash: body.expectedSourceHash }),
      })
      sendJson(response, 201, { schemaVersion: 1, approval })
      return
    }
    sendJson(response, 404, { schemaVersion: 1, error: { code: 'not-found' } })
  } catch (error) {
    const code = publicErrorCode(error)
    const status = code === 'workflow-not-found' ? 404
      : code === 'source-changed' ? 409
        : code === 'auth-busy' || code === 'auth-mode-conflict' ? 409
          : code === 'authentication-failed' ? 401
        : code === 'service-stopping' || code === 'service-stopped' ? 503
          : code === 'invalid-request' ? 400
            : 500
    sendJson(response, status, adminError(code, error))
  }
}

async function streamAuthenticationLogin(
  request: IncomingMessage,
  response: ServerResponse,
  auth: CodexCredentialBroker,
  signal: AbortSignal,
): Promise<void> {
  response.statusCode = 200
  response.setHeader('content-type', 'application/x-ndjson; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  const frame = (value: object): void => {
    if (!response.destroyed) response.write(`${JSON.stringify(value)}\n`)
  }
  try {
    await auth.login((stream, text) => frame({ type: 'output', stream, text }), signal)
    frame({ type: 'complete' })
  } catch (error) {
    const code = publicErrorCode(error)
    frame({
      type: 'error',
      code,
      message: publicErrorMessage(code, error),
    })
  } finally {
    if (!response.writableEnded) response.end()
    request.resume()
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const declared = request.headers['content-length']
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > MAX_ADMIN_BODY_BYTES)) {
    throw requestError('request body exceeds 64 KiB')
  }
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > MAX_ADMIN_BODY_BYTES) throw requestError('request body exceeds 64 KiB')
    chunks.push(buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch (cause) {
    throw requestError('request body is not valid JSON', cause)
  }
}

async function prepareSocketPath(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const parent = await lstat(dirname(path))
  if (!parent.isDirectory() || parent.isSymbolicLink()) {
    throw new Error('Admin socket parent is not an ordinary directory')
  }
  try {
    const existing = await lstat(path)
    if (!existing.isSocket() || existing.isSymbolicLink()) {
      throw new Error('Refusing to replace a non-socket admin path')
    }
    // Store ownership was acquired before this function runs. An existing socket can therefore
    // only be stale; another live owner would have failed the lease rather than reaching cleanup.
    await rm(path)
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
  }
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolveListen, rejectListen) => {
    const onError = (error: Error): void => rejectListen(error)
    server.once('error', onError)
    server.listen(socketPath, () => {
      server.removeListener('error', onError)
      resolveListen()
    })
  })
}

async function closeAndRemove(server: Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close(error => error ? rejectClose(error) : resolveClose())
  })
  try {
    const info = await lstat(socketPath)
    if (info.isSocket() && !info.isSymbolicLink()) await rm(socketPath)
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
  }
}

function requestError(message: string, cause?: unknown): Error & { code: 'invalid-request' } {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), {
    code: 'invalid-request' as const,
  })
}

const PUBLIC_ADMIN_ERROR_CODES = new Set([
  'workflow-not-found',
  'source-changed',
  'auth-busy',
  'auth-mode-conflict',
  'authentication-failed',
  'authentication-cancelled',
  'service-stopping',
  'service-stopped',
  'invalid-request',
])

function publicErrorCode(error: unknown): string {
  const candidate = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined
  // WHY: an arbitrary `.code` property does not make a provider/store exception public. Both the
  // code and message can contain credential fragments or private paths, so only the deliberately
  // documented administrative vocabulary crosses the authenticated socket boundary. Everything
  // else collapses to the same non-oracular failure used by the browser and MCP transports.
  return candidate !== undefined && PUBLIC_ADMIN_ERROR_CODES.has(candidate) ? candidate : 'internal-error'
}

function adminError(code: string, error: unknown): object {
  return {
    schemaVersion: 1,
    error: { code, message: publicErrorMessage(code, error) },
  }
}

function publicErrorMessage(code: string, error: unknown): string {
  if (code === 'internal-error') return 'Workflow MCP could not complete the request.'
  return error instanceof Error ? error.message : String(error)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
