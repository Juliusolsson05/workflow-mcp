import { readFile } from 'node:fs/promises'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

import { WORKFLOW_MCP_VERSION } from 'workflow-mcp'

const MAX_IN_FLIGHT_TOOL_CALLS = 128

export type WorkflowMcpProxy = {
  close(): Promise<void>
}

export async function startWorkflowMcpProxy(options: {
  endpoint: string
  tokenFile: string
}): Promise<WorkflowMcpProxy> {
  const token = (await readFile(options.tokenFile, 'utf8')).trim()
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(token)) {
    throw new Error(`Workflow MCP proxy token is malformed: ${options.tokenFile}`)
  }
  let localServer: Server | undefined
  const remote = new Client(
    { name: 'workflow-mcp-stdio-proxy', version: WORKFLOW_MCP_VERSION },
    {
      capabilities: {},
      listChanged: {
        tools: {
          onChanged: error => {
            if (error === null || error === undefined) void localServer?.sendToolListChanged()
          },
        },
      },
    },
  )
  const remoteTransport = new StreamableHTTPClientTransport(new URL(options.endpoint), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  })
  // SDK 1.x predates exactOptionalPropertyTypes on its transport callback declarations.
  await remote.connect(remoteTransport as unknown as Transport)
  const remoteCapabilities = remote.getServerCapabilities()
  const instructions = remote.getInstructions()
  localServer = new Server(
    { name: 'workflow-mcp', version: WORKFLOW_MCP_VERSION },
    {
      // The adapter deliberately advertises only the capability it implements end-to-end. A
      // daemon which later gains sampling/elicitation cannot accidentally send a request through a
      // Codex client that never negotiated it; adding one requires an explicit routing test here.
      capabilities: { tools: remoteCapabilities?.tools ?? {} },
      ...(instructions === undefined ? {} : { instructions }),
    },
  )
  let activeRequests = 0
  const drainWaiters = new Set<() => void>()
  const withActiveRequest = async <T>(operation: () => Promise<T>): Promise<T> => {
    activeRequests += 1
    try {
      return await operation()
    } finally {
      activeRequests -= 1
      if (activeRequests === 0) {
        for (const resolve of drainWaiters) resolve()
        drainWaiters.clear()
      }
    }
  }
  localServer.setRequestHandler(ListToolsRequestSchema, request => withActiveRequest(() => (
    remote.listTools(request.params, { timeout: 30_000 })
  )))
  let inFlightToolCalls = 0
  localServer.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    if (inFlightToolCalls >= MAX_IN_FLIGHT_TOOL_CALLS) {
      throw new Error(`Workflow MCP proxy has ${MAX_IN_FLIGHT_TOOL_CALLS} tool calls in flight`)
    }
    inFlightToolCalls += 1
    return withActiveRequest(async () => {
      return await remote.callTool(request.params, undefined, {
        signal: extra.signal,
        timeout: 60_000,
        maxTotalTimeout: 24 * 60 * 60 * 1_000,
      })
    }).finally(() => { inFlightToolCalls -= 1 })
  })

  const stdio = new StdioServerTransport()
  await localServer.connect(stdio)
  let closePromise: Promise<void> | undefined
  const closeProxy = (drainInput: boolean): Promise<void> => {
    if (closePromise !== undefined) return closePromise
    closePromise = (async () => {
      process.stdin.off('end', closeAfterInput)
      process.stdin.off('close', closeAfterInput)
      if (drainInput && activeRequests > 0) {
        await new Promise<void>(resolve => { drainWaiters.add(resolve) })
      }
      // Request handlers settle before the SDK serializes their JSON-RPC responses. One event-loop
      // turn lets that continuation flush stdout before transport.close clears the stdio buffer.
      if (drainInput) await new Promise<void>(resolve => { setImmediate(resolve) })
      await Promise.allSettled([localServer!.close(), remote.close()])
    })()
    return closePromise
  }
  const close = (): Promise<void> => closeProxy(false)
  const closeAfterInput = (): void => { void closeProxy(true) }
  // SDK 1.29's StdioServerTransport listens for data/error but not EOF. In a Docker `compose exec
  // -T` proxy that leaves the process (and release/host client) alive forever after the MCP client
  // closes stdin. Treating both end and close as an idempotent transport disconnect preserves the
  // daemon's independent lifetime while allowing the tiny per-client adapter to terminate.
  process.stdin.once('end', closeAfterInput)
  process.stdin.once('close', closeAfterInput)
  return { close }
}
