#!/usr/bin/env node

import { serveWorkflowMcpStdio } from 'workflow-mcp'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'

import { loadStandaloneConfig } from '../config/loadConfig.js'
import { StandaloneConfigurationError } from '../config/schema.js'
import { createStandaloneApplication } from '../daemon/application.js'
import { inspectContainer } from '../daemon/health.js'
import { startStandaloneDaemon } from '../daemon/lifecycle.js'
import { printDoctor } from './output.js'
import { startWorkflowMcpProxy } from '../mcp/proxy.js'
import { StandaloneApiClient } from '../client/apiClient.js'
import { runTerminalUi } from '../tui/application.js'
import {
  createInstanceRecord,
  hashProjectIdentity,
  readInstanceRecord,
  renderCodexMcpConfiguration,
} from '../instance/record.js'

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
  if (command === 'instance') {
    const action = parsed.positionals[0]
    if (action === 'create') {
      const projectDirectory = requiredStringArgument(parsed.flags, 'project')
      const webPortValue = stringArgument(parsed.flags, 'web-port')
      const record = createInstanceRecord({
        projectDirectory,
        dockerContext: requiredStringArgument(parsed.flags, 'docker-context'),
        dockerEndpoint: requiredStringArgument(parsed.flags, 'docker-endpoint'),
        image: requiredStringArgument(parsed.flags, 'image'),
        ...(webPortValue === undefined ? {} : { webPort: parsePort(webPortValue, 'web-port') }),
        authoring: parsed.flags.authoring === true,
        ...(stringArgument(parsed.flags, 'api-key-file') === undefined
          ? {}
          : { apiKeyFile: stringArgument(parsed.flags, 'api-key-file')! }),
      })
      process.stdout.write(`${JSON.stringify(record)}\n`)
      return
    }
    if (action === 'inspect') {
      const record = await readInstanceRecord(requiredStringArgument(parsed.flags, 'file'))
      const field = stringArgument(parsed.flags, 'field')
      if (field === undefined) process.stdout.write(`${JSON.stringify(record)}\n`)
      else if (['instanceId', 'composeProjectName', 'projectHash', 'dockerContext', 'dockerEndpoint', 'image', 'webPort', 'authoring', 'apiKeyFile'].includes(field)) {
        const value = record[field as keyof typeof record]
        process.stdout.write(value === undefined ? '' : `${String(value)}\n`)
      } else throw new StandaloneConfigurationError('Unsupported instance field')
      return
    }
    if (action === 'hash') {
      process.stdout.write(`${hashProjectIdentity(requiredStringArgument(parsed.flags, 'project'))}\n`)
      return
    }
    if (action === 'codex-config') {
      const record = await readInstanceRecord(requiredStringArgument(parsed.flags, 'file'))
      process.stdout.write(renderCodexMcpConfiguration(
        record,
        requiredStringArgument(parsed.flags, 'compose-file'),
      ))
      return
    }
    throw new StandaloneConfigurationError('instance requires create, inspect, hash, or codex-config')
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
  if (command === 'status') {
    const config = loadStandaloneConfig(parsed.flags)
    const token = await readAudienceToken(config.dataDirectory, 'web')
    const client = new StandaloneApiClient({
      baseUrl: process.env.WORKFLOW_MCP_ENDPOINT ?? `http://127.0.0.1:${config.port}`,
      token,
    })
    const [instance, runs] = await Promise.all([client.instance(), client.runs({ limit: 50 })])
    if (parsed.flags.json === true) process.stdout.write(`${JSON.stringify({ instance, runs })}\n`)
    else process.stdout.write(`${instance.lifecycle} · ${instance.version} · ${runs.items.length} runs\n`)
    return
  }
  if (command === 'ui') {
    const config = loadStandaloneConfig(parsed.flags)
    await runTerminalUi({
      endpoint: process.env.WORKFLOW_MCP_ENDPOINT ?? `http://127.0.0.1:${config.port}`,
      token: await readAudienceToken(config.dataDirectory, 'web'),
      snapshot: parsed.flags.snapshot === true,
    })
    return
  }
  if (command === 'token' && parsed.positionals[0] === 'show') {
    const config = loadStandaloneConfig(parsed.flags)
    const purpose = stringArgument(parsed.flags, 'purpose')
    if (purpose !== 'mcp' && purpose !== 'web') {
      throw new StandaloneConfigurationError('--purpose must be mcp or web')
    }
    if (!process.stdout.isTTY && parsed.flags.force !== true) {
      throw new StandaloneConfigurationError('Refusing to print a token without a TTY; pass --force for deliberate automation')
    }
    process.stdout.write(`${await readAudienceToken(config.dataDirectory, purpose)}\n`)
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

async function readAudienceToken(dataDirectory: string, purpose: 'mcp' | 'web'): Promise<string> {
  const value = await readFile(join(dataDirectory, 'secrets', `${purpose}.token`), 'utf8')
  return value.trim()
}

function stringArgument(flags: Readonly<Record<string, string | boolean>>, name: string): string | undefined {
  const value = flags[name]
  return typeof value === 'string' ? value : undefined
}

function requiredStringArgument(flags: Readonly<Record<string, string | boolean>>, name: string): string {
  const value = stringArgument(flags, name)
  if (value === undefined) throw new StandaloneConfigurationError(`--${name} requires a value`)
  return value
}

function parsePort(value: string, name: string): number {
  if (!/^\d+$/.test(value)) throw new StandaloneConfigurationError(`--${name} must be a TCP port`)
  const port = Number(value)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new StandaloneConfigurationError(`--${name} must be a TCP port`)
  }
  return port
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
  workflow-mcp status [--json] [--port=7331]
  workflow-mcp ui [--snapshot] [--port=7331]
  workflow-mcp token show --purpose=mcp|web [--force]
  workflow-mcp instance create|inspect|hash|codex-config [options]
`)
}
