import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'

import type { WorkflowService, WorkflowServiceScope } from './workflowService.js'
import { registerWorkflowMcpTools, workflowMcpInstructions } from './workflowMcp.js'
import { WORKFLOW_MCP_VERSION } from './generatedBuildMetadata.js'

export type WorkflowMcpHttpServer = {
  host: '127.0.0.1' | '0.0.0.0'
  port: number
  url: string
  token: string
  close(): Promise<void>
}

export type WorkflowMcpHttpHandler = {
  /** Returns false without writing when another router owns this path. */
  handle(request: IncomingMessage, response: ServerResponse): Promise<boolean>
  close(): Promise<void>
}

export type WorkflowMcpServerOptions = { inlineAuthoring?: boolean }

function createServerWithTools(
  service: WorkflowService,
  scope: WorkflowServiceScope,
  options: WorkflowMcpServerOptions = {},
): McpServer {
  const server = new McpServer(
    { name: 'workflow-mcp', version: WORKFLOW_MCP_VERSION },
    {
      // MCP initialization instructions are the only guidance guaranteed to reach a client before
      // it chooses a tool. Keeping the authoring loop here prevents success from depending on a
      // model having read this repository or previously seen Claude's private Workflow prompt.
      instructions: workflowMcpInstructions(options.inlineAuthoring !== false),
    },
  )
  registerWorkflowMcpTools(server, service, scope, options.inlineAuthoring === undefined
    ? {}
    : { inlineAuthoring: options.inlineAuthoring })
  return server
}

export async function serveWorkflowMcpStdio(
  service: WorkflowService,
  scope: WorkflowServiceScope,
  options: WorkflowMcpServerOptions = {},
): Promise<{ close(): Promise<void> }> {
  const server = createServerWithTools(service, scope, options)
  const transport = new StdioServerTransport()
  await server.connect(transport)
  return { close: () => server.close() }
}

export async function serveWorkflowMcpHttp(
  service: WorkflowService,
  scope: WorkflowServiceScope,
  options: {
    port?: number
    token?: string
    host?: '127.0.0.1' | '0.0.0.0'
    inlineAuthoring?: boolean
  } = {},
): Promise<WorkflowMcpHttpServer> {
  const token = options.token ?? randomBytes(32).toString('base64url')
  const host = options.host ?? '127.0.0.1'
  const handler = createWorkflowMcpHttpHandler(
    service,
    scope,
    token,
    options.inlineAuthoring === undefined ? {} : { inlineAuthoring: options.inlineAuthoring },
  )

  const http = createServer((request, response) => {
    void handler.handle(request, response).then(handled => {
      if (!handled) json(response, 404, { error: 'not-found' })
    })
  })
  await listen(http, options.port ?? 0, host)
  const address = http.address()
  if (!address || typeof address === 'string') throw new Error('Workflow MCP HTTP server has no TCP address')
  const port = address.port
  return {
    host,
    port,
    url: `http://127.0.0.1:${port}/mcp`,
    token,
    async close(): Promise<void> {
      await handler.close()
      await closeHttp(http)
    },
  }
}

export function createWorkflowMcpHttpHandler(
  service: WorkflowService,
  scope: WorkflowServiceScope,
  token: string,
  options: WorkflowMcpServerOptions = {},
): WorkflowMcpHttpHandler {
  if (token.length < 24) throw new TypeError('HTTP bearer token must contain at least 24 characters')
  const transports = new Set<StreamableHTTPServerTransport>()
  const servers = new Set<McpServer>()
  return {
    handle: (request, response) => handleHttpRequest(
      request,
      response,
      token,
      service,
      scope,
      transports,
      servers,
      options,
    ),
    async close(): Promise<void> {
      await Promise.allSettled([...transports].map(transport => transport.close()))
      await Promise.allSettled([...servers].map(server => server.close()))
      transports.clear()
      servers.clear()
    },
  }
}

async function handleHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  token: string,
  service: WorkflowService,
  scope: WorkflowServiceScope,
  transports: Set<StreamableHTTPServerTransport>,
  servers: Set<McpServer>,
  options: WorkflowMcpServerOptions,
): Promise<boolean> {
  try {
    if (request.url?.split('?', 1)[0] !== '/mcp') return false
    if (!validOrigin(request.headers.origin)) {
      json(response, 403, { error: 'invalid-origin' })
      return true
    }
    if (!validBearer(request.headers.authorization, token)) {
      response.setHeader('WWW-Authenticate', 'Bearer')
      json(response, 401, { error: 'unauthorized' })
      return true
    }
    if (request.method !== 'POST' && request.method !== 'GET' && request.method !== 'DELETE') {
      response.setHeader('Allow', 'POST, GET, DELETE')
      json(response, 405, { error: 'method-not-allowed' })
      return true
    }

    // Stateless transports are intentional. Durable cursor tools own reconnect semantics, so MCP
    // transport sessions add no useful state and would make one dropped HTTP connection capable of
    // orphaning a run the service is explicitly designed to preserve.
    const mcp = createServerWithTools(service, scope, options)
    const transport = new StreamableHTTPServerTransport({
      enableJsonResponse: true,
    })
    transports.add(transport)
    servers.add(mcp)
    response.once('close', () => {
      transports.delete(transport)
      servers.delete(mcp)
      void transport.close()
      void mcp.close()
    })
    // SDK 1.x's node transport predates exactOptionalPropertyTypes on its callback properties. The
    // runtime object implements Transport; this cast only bridges that declaration mismatch.
    await mcp.connect(transport as unknown as Transport)
    await transport.handleRequest(request, response)
    return true
  } catch (error) {
    if (!response.headersSent) {
      json(response, 500, { error: error instanceof Error ? error.message : String(error) })
    } else if (!response.writableEnded) {
      response.end()
    }
    return true
  }
}

function validOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return true
  try {
    const hostname = new URL(origin).hostname
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1'
  } catch {
    return false
  }
}

function validBearer(header: string | undefined, expected: string): boolean {
  if (!header?.startsWith('Bearer ')) return false
  const actual = Buffer.from(header.slice('Bearer '.length), 'utf8')
  const wanted = Buffer.from(expected, 'utf8')
  return actual.length === wanted.length && timingSafeEqual(actual, wanted)
}

function json(response: ServerResponse, status: number, body: object): void {
  response.statusCode = status
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify(body))
}

function listen(
  server: HttpServer,
  port: number,
  host: '127.0.0.1' | '0.0.0.0',
): Promise<void> {
  return new Promise((resolveListen, reject) => {
    const onError = (error: Error): void => reject(error)
    server.once('error', onError)
    server.listen(port, host, () => {
      server.removeListener('error', onError)
      resolveListen()
    })
  })
}

function closeHttp(server: HttpServer): Promise<void> {
  return new Promise((resolveClose, reject) => {
    server.close((error) => error ? reject(error) : resolveClose())
  })
}
