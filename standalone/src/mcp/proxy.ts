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
  localServer.setRequestHandler(ListToolsRequestSchema, request => (
    remote.listTools(request.params, { timeout: 30_000 })
  ))
  let inFlight = 0
  localServer.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    if (inFlight >= MAX_IN_FLIGHT_TOOL_CALLS) {
      throw new Error(`Workflow MCP proxy has ${MAX_IN_FLIGHT_TOOL_CALLS} tool calls in flight`)
    }
    inFlight += 1
    try {
      return await remote.callTool(request.params, undefined, {
        signal: extra.signal,
        timeout: 60_000,
        maxTotalTimeout: 24 * 60 * 60 * 1_000,
      })
    } finally {
      inFlight -= 1
    }
  })

  const stdio = new StdioServerTransport()
  await localServer.connect(stdio)
  let closePromise: Promise<void> | undefined
  return {
    close(): Promise<void> {
      if (closePromise !== undefined) return closePromise
      closePromise = (async () => {
        await Promise.allSettled([localServer!.close(), remote.close()])
      })()
      return closePromise
    },
  }
}
