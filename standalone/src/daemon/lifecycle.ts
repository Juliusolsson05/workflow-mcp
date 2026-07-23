import { createServer, type Server as HttpServer } from 'node:http'

import {
  createWorkflowMcpHttpHandler,
  type AgentProvider,
  type WorkflowMcpHttpHandler,
} from 'workflow-mcp'

import { applySecurityHeaders, routeReadOnlyApi, sendJson, validLocalHost } from '../api/router.js'
import { startStandaloneAdminServer, type StandaloneAdminServer } from '../admin/server.js'
import type { StandaloneConfig } from '../config/schema.js'
import { createStandaloneApplication, type StandaloneApplication } from './application.js'
import { loadOrCreateTokens, type StandaloneTokens } from './tokens.js'
import { loadStaticWebRouter, type StaticWebRouter } from '../web/staticRouter.js'
import { CodexCredentialBroker } from './auth.js'

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
  const startedAt = new Date().toISOString()
  const environment = options.environment ?? process.env
  const apiKeySecret = (
    environment.WORKFLOW_MCP_OPENAI_API_KEY_FILE !== undefined ||
    environment.OPENAI_API_KEY !== undefined
  )
  let ready = false
  let application: StandaloneApplication | undefined
  let tokens: StandaloneTokens | undefined
  let mcp: WorkflowMcpHttpHandler | undefined
  let web: StaticWebRouter | undefined
  let admin: StandaloneAdminServer | undefined
  const isReady = (): boolean => ready && application?.service.lifecycleState() === 'READY'
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
        sendJson(response, isReady() ? 200 : 503, { status: isReady() ? 'ready' : 'not-ready' })
        return
      }
      if (!isReady() || application === undefined || tokens === undefined || mcp === undefined || web === undefined) {
        sendJson(response, 503, { status: 'not-ready' })
        return
      }
      if (await mcp.handle(request, response)) return
      if (await routeReadOnlyApi(request, response, {
        service: application.service,
        config,
        webToken: tokens.web,
        startedAt,
        authenticationMode: apiKeySecret ? 'api-key-secret' : 'interactive',
      })) return
      if (web.handle(request, response)) return
      sendJson(response, 404, { schemaVersion: 1, error: { code: 'not-found' } })
    })().catch(error => {
      if (!response.headersSent) {
        sendJson(response, 500, {
          schemaVersion: 1,
          // WHY: this is the last HTTP boundary and may catch provider/store exceptions containing
          // stderr, credential fragments, or private container paths. Detailed diagnostics stay in
          // the process error channel; clients receive a stable non-oracular response.
          error: { code: 'internal-error', message: 'Workflow MCP could not complete the request.' },
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
      {
        inlineAuthoring: config.sourceMode === 'authoring',
        providerCapacity: config.concurrency,
      },
    )
    web = await loadStaticWebRouter(config.webEnabled)
    const auth = new CodexCredentialBroker({
      service: application.service,
      codexExecutable: config.codexExecutable,
      dataDirectory: config.dataDirectory,
      apiKeySecret,
    })
    admin = await startStandaloneAdminServer({
      config,
      service: application.service,
      approvals: application.sourceApprovals,
      auth,
      token: tokens.admin,
    })
    ready = true
  } catch (error) {
    await admin?.close().catch(() => undefined)
    await mcp?.close().catch(() => undefined)
    await application?.quiesce('Standalone daemon startup failed').catch(() => undefined)
    await closeHttp(http)
    throw error
  }

  let closePromise: Promise<void> | undefined
  return {
    host: config.host,
    port,
    application,
    tokens,
    ready: isReady,
    close(reason = 'Standalone daemon is stopping'): Promise<void> {
      if (closePromise !== undefined) return closePromise
      ready = false
      closePromise = (async () => {
        // Quiescing first makes every admitted long-poll observe the typed service-stopping
        // transition. Closing the MCP transport concurrently was tempting, but it could replace a
        // useful protocol error with a generic socket reset precisely during operator shutdown.
        const outcomes: PromiseSettledResult<void>[] = []
        try {
          // Stop operator mutations before quiesce closes mutation admission. This produces one
          // crisp boundary: an admin request either completed under the current lease or never
          // entered, and clients cannot race a late approval against shutdown.
          await admin!.close()
          outcomes.push({ status: 'fulfilled', value: undefined })
        } catch (error) {
          outcomes.push({ status: 'rejected', reason: error })
        }
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
