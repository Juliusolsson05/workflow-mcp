#!/usr/bin/env node

import { serveWorkflowMcpStdio } from 'workflow-mcp'
import { join } from 'node:path'

import { loadStandaloneConfig } from '../config/loadConfig.js'
import { StandaloneConfigurationError } from '../config/schema.js'
import { createStandaloneApplication } from '../daemon/application.js'
import { inspectContainer } from '../daemon/health.js'
import { startStandaloneDaemon } from '../daemon/lifecycle.js'
import { printDoctor } from './output.js'
import { startWorkflowMcpProxy } from '../mcp/proxy.js'

const EXIT_USAGE = 2
const EXIT_UNAVAILABLE = 3
const EXIT_INTERNAL = 10

void main(process.argv.slice(2)).catch(error => {
  const usageError = error instanceof StandaloneConfigurationError
  process.stderr.write(`workflow-mcp: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = usageError ? EXIT_USAGE : EXIT_INTERNAL
})

async function main(arguments_: string[]): Promise<void> {
  const [command = 'help', ...rest] = arguments_
  const parsed = parseArguments(rest)
  if (command === 'help' || parsed.flags.help === true) {
    usage()
    return
  }
  if (command === 'doctor') {
    const config = loadStandaloneConfig(parsed.flags)
    const report = await inspectContainer(config)
    printDoctor(report, parsed.flags.json === true)
    if (!report.ok) process.exitCode = EXIT_UNAVAILABLE
    return
  }
  if (command === 'daemon') {
    const config = loadStandaloneConfig(parsed.flags)
    const daemon = await startStandaloneDaemon(config)
    process.stderr.write(`workflow-mcp daemon ready on ${daemon.host}:${daemon.port}\n`)
    installShutdown(signal => daemon.close(`Standalone daemon received ${signal}`))
    return
  }
  if (command === 'healthcheck') {
    const config = loadStandaloneConfig(parsed.flags)
    const response = await fetch(`http://127.0.0.1:${config.port}/readyz`, {
      headers: { host: `127.0.0.1:${config.port}` },
      signal: AbortSignal.timeout(2_500),
    })
    if (!response.ok) process.exitCode = EXIT_UNAVAILABLE
    return
  }
  if (command === 'mcp-proxy') {
    const config = loadStandaloneConfig(parsed.flags)
    const proxy = await startWorkflowMcpProxy({
      endpoint: process.env.WORKFLOW_MCP_ENDPOINT ?? `http://127.0.0.1:${config.port}/mcp`,
      tokenFile: process.env.WORKFLOW_MCP_MCP_TOKEN_FILE ?? join(config.dataDirectory, 'secrets', 'mcp.token'),
    })
    installShutdown(() => proxy.close())
    return
  }
  if (command === 'serve') {
    if (parsed.positionals[0] !== undefined && parsed.positionals[0] !== '--stdio') {
      parsed.flags.workspace = parsed.positionals[0]
    }
    const config = loadStandaloneConfig(parsed.flags)
    const application = await createStandaloneApplication(config)
    const server = await serveWorkflowMcpStdio(application.service, { cwd: config.workspace })
    installShutdown(async signal => {
      await server.close()
      await application.quiesce(`Standalone STDIO received ${signal}`)
    })
    return
  }
  throw new StandaloneConfigurationError(`Unknown command ${JSON.stringify(command)}`)
}

function installShutdown(shutdown: (signal: string) => Promise<void>): void {
  let stopping: Promise<void> | undefined
  const begin = (signal: string): void => {
    if (stopping !== undefined) return
    stopping = shutdown(signal)
    void stopping.then(
      () => { process.exitCode = 0 },
      error => {
        process.stderr.write(`workflow-mcp: shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`)
        process.exitCode = EXIT_INTERNAL
      },
    )
  }
  process.once('SIGTERM', () => begin('SIGTERM'))
  process.once('SIGINT', () => begin('SIGINT'))
}

function parseArguments(arguments_: string[]): {
  flags: Record<string, string | boolean>
  positionals: string[]
} {
  const flags: Record<string, string | boolean> = {}
  const positionals: string[] = []
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!
    if (!argument.startsWith('--')) {
      positionals.push(argument)
      continue
    }
    const equal = argument.indexOf('=')
    if (equal >= 0) {
      flags[argument.slice(2, equal)] = argument.slice(equal + 1)
      continue
    }
    const name = argument.slice(2)
    const next = arguments_[index + 1]
    if (next !== undefined && !next.startsWith('--')) {
      flags[name] = next
      index += 1
    } else {
      flags[name] = true
    }
  }
  return { flags, positionals }
}

function usage(): void {
  process.stdout.write(`Workflow MCP standalone

Usage:
  workflow-mcp daemon [--host=0.0.0.0] [--port=7331] [--workspace=/workspace] [--data-dir=/data]
  workflow-mcp serve --stdio [workspace] [--data-dir=/data]
  workflow-mcp doctor --container [--json] [--workspace=/workspace] [--data-dir=/data]
  workflow-mcp healthcheck [--port=7331]
  workflow-mcp mcp-proxy [--port=7331]
`)
}
