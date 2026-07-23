import { createServer, type Server as HttpServer } from 'node:http'

import {
  createWorkflowMcpHttpHandler,
  type AgentProvider,
  type WorkflowMcpHttpHandler,
} from 'workflow-mcp'

import { applySecurityHeaders, routeReadOnlyApi, sendJson, validLocalHost } from '../api/router.js'
import type { StandaloneConfig } from '../config/schema.js'
import { createStandaloneApplication, type StandaloneApplication } from './application.js'
import { loadOrCreateTokens, type StandaloneTokens } from './tokens.js'

export type StandaloneDaemon = {
  host: StandaloneConfig['host']
  port: number
  application: StandaloneApplication
  tokens: StandaloneTokens
  ready(): boolean
  close(reason?: string): Promise<void>
}

export async function startStandaloneDaemon(
  config: StandaloneConfig,
  options: { provider?: AgentProvider; environment?: NodeJS.ProcessEnv } = {},
): Promise<StandaloneDaemon> {
  let ready = false
  let application: StandaloneApplication | undefined
  let tokens: StandaloneTokens | undefined
  let mcp: WorkflowMcpHttpHandler | undefined
  const http = createServer((request, response) => {
    void (async () => {
      applySecurityHeaders(response)
      const path = request.url?.split('?', 1)[0]
      if (!validLocalHost(request.headers.host)) {
        sendJson(response, 421, { status: 'invalid-host' })
        return
      }
      if (path === '/healthz') {
        sendJson(response, 200, { status: 'live' })
        return
      }
      if (path === '/readyz') {
        sendJson(response, ready ? 200 : 503, { status: ready ? 'ready' : 'not-ready' })
        return
      }
      if (!ready || application === undefined || tokens === undefined || mcp === undefined) {
        sendJson(response, 503, { status: 'not-ready' })
        return
      }
      if (await mcp.handle(request, response)) return
      if (await routeReadOnlyApi(request, response, {
        service: application.service,
        config,
        webToken: tokens.web,
      })) return
      sendJson(response, 404, { schemaVersion: 1, error: { code: 'not-found' } })
    })().catch(error => {
      if (!response.headersSent) {
        sendJson(response, 500, {
          schemaVersion: 1,
          error: { code: 'internal-error', message: error instanceof Error ? error.message : String(error) },
        })
      } else if (!response.writableEnded) response.end()
    })
  })

  // Bind before acquiring durable ownership. A typo or port collision must not leave a perfectly
  // healthy store owner running but unreachable to Codex, doctor, or the shutdown controller.
  await listen(http, config.host, config.port)
  const address = http.address()
  if (address === null || typeof address === 'string') {
    await closeHttp(http)
    throw new Error('Standalone daemon has no TCP address')
  }
  const port = address.port
  try {
    application = await createStandaloneApplication(config, options)
    tokens = loadOrCreateTokens(
      config.dataDirectory,
      application.store.journalWriteCoordinator(),
    )
    mcp = createWorkflowMcpHttpHandler(
      application.service,
      { cwd: config.workspace },
      tokens.mcp,
    )
    ready = true
  } catch (error) {
    await closeHttp(http)
    throw error
  }

  let closePromise: Promise<void> | undefined
  return {
    host: config.host,
    port,
    application,
    tokens,
    ready: () => ready,
    close(reason = 'Standalone daemon is stopping'): Promise<void> {
      if (closePromise !== undefined) return closePromise
      ready = false
      closePromise = (async () => {
        // Quiescing first makes every admitted long-poll observe the typed service-stopping
        // transition. Closing the MCP transport concurrently was tempting, but it could replace a
        // useful protocol error with a generic socket reset precisely during operator shutdown.
        const outcomes: PromiseSettledResult<void>[] = []
        try {
          await application!.quiesce(reason)
          outcomes.push({ status: 'fulfilled', value: undefined })
        } catch (error) {
          outcomes.push({ status: 'rejected', reason: error })
        }
        try {
          await mcp!.close()
          outcomes.push({ status: 'fulfilled', value: undefined })
        } catch (error) {
          outcomes.push({ status: 'rejected', reason: error })
        }
        await closeHttp(http)
        const failures = outcomes
          .filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
          .map(outcome => outcome.reason)
        if (failures.length > 0) throw new AggregateError(failures, 'Standalone daemon shutdown failed')
      })()
      return closePromise
    },
  }
}

function listen(
  server: HttpServer,
  host: StandaloneConfig['host'],
  port: number,
): Promise<void> {
  return new Promise((resolveListen, rejectListen) => {
    const onError = (error: Error): void => rejectListen(error)
    server.once('error', onError)
    server.listen(port, host, () => {
      server.removeListener('error', onError)
      resolveListen()
    })
  })
}

function closeHttp(server: HttpServer): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
    server.close(error => error ? rejectClose(error) : resolveClose())
  })
}
