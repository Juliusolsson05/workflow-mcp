import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import {
  CodexAgentProvider,
  FileWorkflowStore,
  InheritedFlockLeaseBackend,
  WorkflowService,
  findWorkflows,
  type AgentProvider,
} from 'workflow-mcp'

import type { StandaloneConfig } from '../config/schema.js'
import { prepareWorkflowDataLayout, type WorkflowDataLayout } from './dataLayout.js'

export type StandaloneApplication = {
  config: StandaloneConfig
  layout: WorkflowDataLayout
  store: FileWorkflowStore
  service: WorkflowService
  quiesce(reason?: string): Promise<void>
}

export async function createStandaloneApplication(
  config: StandaloneConfig,
  options: { provider?: AgentProvider; environment?: NodeJS.ProcessEnv } = {},
): Promise<StandaloneApplication> {
  const environment = options.environment ?? process.env
  // The native image launcher already holds flock before Node starts. Only this global layout
  // decision is allowed before WorkflowService adopts the descriptor; FileWorkflowStore repair is
  // still deferred until after the injected backend has validated and activated writer permits.
  const layout = prepareWorkflowDataLayout(config.dataDirectory)
  const leaseBackend = config.leaseMode === 'inherited-flock'
    ? new InheritedFlockLeaseBackend({
        fd: config.lockFileDescriptor!,
        lockPath: config.lockPath!,
      })
    : undefined
  const store = new FileWorkflowStore(join(config.dataDirectory, 'store'), {
    ...(leaseBackend === undefined ? {} : { leaseBackend }),
  })
  const approvedSources = await startupSourceApprovals(config.workspace)
  const provider = options.provider ?? await createCodexProvider(config, environment)
  const service = new WorkflowService({
    store,
    provider,
    // A source is approved by canonical path plus immutable bytes. Startup discovery is the
    // read-only profile's review boundary; an inline file or one edited after startup cannot grant
    // itself execution authority merely by becoming visible in the project.
    authorizeWorkflowSource: request => (
      approvedSources.has(`${resolve(request.canonicalIdentity)}\0${request.sourceHash}`)
    ),
    sandbox: {
      mode: 'read-only',
      approvalPolicy: 'never',
      network: false,
    },
    recovery: {
      autoResumeOnInitialize: true,
      allowMutableSandbox: false,
    },
  })
  await service.initialize()
  return {
    config,
    layout,
    store,
    service,
    quiesce: reason => service.quiesce(reason),
  }
}

async function startupSourceApprovals(workspace: string): Promise<Set<string>> {
  const found = await findWorkflows({ cwd: workspace })
  const approved = await Promise.all(found.workflows.map(async workflow => (
    `${await realpath(workflow.filePath).catch(() => resolve(workflow.filePath))}\0${workflow.sourceHash}`
  )))
  return new Set(approved)
}

async function createCodexProvider(
  config: StandaloneConfig,
  environment: NodeJS.ProcessEnv,
): Promise<CodexAgentProvider> {
  const executableBytes = await readFile(config.codexExecutable)
  const effectiveConfigurationFingerprint =
    environment.WORKFLOW_MCP_CODEX_CONFIG_FINGERPRINT
  const isolation = {
    codexHome: join(config.dataDirectory, 'codex-home'),
    ...(effectiveConfigurationFingerprint === undefined
      ? {}
      : { effectiveConfigurationFingerprint }),
  }
  return new CodexAgentProvider({
    codexPathOverride: config.codexExecutable,
    configurationIsolation: isolation,
    capabilities: effectiveConfigurationFingerprint === undefined
      ? { inheritedMcpServers: 'unknown' }
      : { inheritedMcpServers: 'disabled', mcpServers: [] },
    executableEvidence: {
      path: config.codexExecutable,
      sha256: createHash('sha256').update(executableBytes).digest('hex'),
    },
  })
}
