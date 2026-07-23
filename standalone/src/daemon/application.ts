import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

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
import { writeDataDurabilityProof } from './durabilityProof.js'
import { SourceApprovalStore } from './sourceApprovals.js'
import { requireSupportedResourceProfile } from './resourceProfile.js'

export type StandaloneApplication = {
  config: StandaloneConfig
  layout: WorkflowDataLayout
  store: FileWorkflowStore
  service: WorkflowService
  sourceApprovals: SourceApprovalStore
  quiesce(reason?: string): Promise<void>
}

export async function createStandaloneApplication(
  config: StandaloneConfig,
  options: { provider?: AgentProvider; environment?: NodeJS.ProcessEnv } = {},
): Promise<StandaloneApplication> {
  const environment = options.environment ?? process.env
  await requireSupportedResourceProfile(config)
  // The native image launcher already holds flock before Node starts. Only this global layout
  // decision is allowed before WorkflowService adopts the descriptor; FileWorkflowStore repair is
  // still deferred until after the injected backend has validated and activated writer permits.
  if (config.leaseMode === 'inherited-flock' && config.lockFileDescriptor === undefined) {
    throw new Error(
      'Durable owner startup requires WORKFLOW_MCP_LOCK_FD from the native image launcher',
    )
  }
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
  // Read-only installations treat the operator-controlled checkout present at daemon startup as
  // their review boundary. Authoring deliberately cannot inherit that shortcut: its own MCP/API
  // can persist executable bytes, so re-snapshotting on restart would turn "write, restart" into
  // an approval bypass and would also resurrect an approval after the reviewed hash was edited.
  const approvedSources = config.sourceMode === 'read-only'
    ? await startupSourceApprovals(config.workspace)
    : new Set<string>()
  const sourceApprovals = new SourceApprovalStore(config.dataDirectory, config.projectHash)
  sourceApprovals.initialize()
  // Authentication status is part of daemon readiness even when a test/derived composition
  // supplies another provider. Validate it once here so the broker and actual provider cannot
  // disagree about whether a configured external credential is usable.
  const credentialEnvironment = await providerCredentialEnvironment(environment)
  const provider = options.provider ?? await createCodexProvider(config, environment, credentialEnvironment)
  const service = new WorkflowService({
    store,
    provider,
    // A source is approved by canonical path plus immutable bytes. Startup discovery is only the
    // read-only profile's review boundary; authoring relies exclusively on the durable two-step
    // approval store, including across restarts, because it can create its own visible files.
    authorizeWorkflowSource: request => (
      approvedSources.has(`${resolve(request.canonicalIdentity)}\0${request.sourceHash}`) ||
      sourceApprovals.isApproved(request.canonicalIdentity, request.sourceHash)
    ),
    allowInlineWorkflowAuthoring: config.sourceMode === 'authoring',
    sandbox: {
      mode: config.sourceMode === 'authoring' ? 'workspace-write' : 'read-only',
      approvalPolicy: 'never',
      network: false,
    },
    recovery: {
      autoResumeOnInitialize: true,
      allowMutableSandbox: false,
    },
    limits: { concurrency: config.concurrency },
  })
  try {
    await service.initialize()
    // Doctor is a client and must never become a second /data writer merely to test fsync. Cache
    // the proof here, after the service owns the lease and inside the exact writer generation that
    // guarded repair/recovery; startup fails rather than advertising readiness without durability.
    await service.runAdministrativeMutation(async () => {
      await writeDataDurabilityProof(config.dataDirectory)
    })
  } catch (error) {
    // A failed post-initialize proof still owns the store lease. Relinquish it through normal
    // interruption semantics so another healthy daemon can retry instead of waiting for process exit.
    await service.quiesce('Standalone durability proof failed').catch(() => undefined)
    throw error
  }
  return {
    config,
    layout,
    store,
    service,
    sourceApprovals,
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
  credentialEnvironment: Readonly<Record<string, string>>,
): Promise<CodexAgentProvider> {
  const executableBytes = await readFile(config.codexExecutable)
  const effectiveConfigurationFingerprint = await codexPolicyFingerprint(config, environment)
  const isolation = {
    codexHome: join(config.dataDirectory, 'codex-home'),
    ...(effectiveConfigurationFingerprint === undefined
      ? {}
      : { effectiveConfigurationFingerprint }),
  }
  return new CodexAgentProvider({
    codexPathOverride: config.codexExecutable,
    // The outer service selects the source capability; the policy launcher
    // independently checks that the SDK's requested sandbox cannot exceed it.
    env: {
      WORKFLOW_MCP_ATTEMPT_PROFILE: config.sourceMode,
      // The Compose secret is deliberately a file path, while Docker MCP Catalog can currently
      // express only an environment secret. Both enter the provider's explicit SDK environment;
      // neither is inherited by agent shell tools under the managed policy below.
      ...credentialEnvironment,
    },
    configurationIsolation: isolation,
    capabilities: effectiveConfigurationFingerprint === undefined
      ? { inheritedMcpServers: 'unknown' }
      : {
          inheritedMcpServers: 'disabled',
          attemptContainment: 'codex-bwrap-pid-v1',
          mcpServers: [],
        },
    executableEvidence: {
      path: config.codexExecutable,
      sha256: createHash('sha256').update(executableBytes).digest('hex'),
    },
  })
}

export async function providerCredentialEnvironment(
  environment: NodeJS.ProcessEnv,
): Promise<Readonly<Record<string, string>>> {
  const file = environment.WORKFLOW_MCP_OPENAI_API_KEY_FILE
  const direct = environment.OPENAI_API_KEY
  if (file !== undefined && direct !== undefined) {
    throw credentialError('auth-mode-conflict', 'Configure either an API-key file or OPENAI_API_KEY, not both')
  }
  if (direct !== undefined) {
    if (Buffer.byteLength(direct) > 16 * 1024 || !/^\S+$/.test(direct)) {
      throw credentialError('authentication-failed', 'OPENAI_API_KEY is empty, contains whitespace, or exceeds 16 KiB')
    }
    return Object.freeze({ OPENAI_API_KEY: direct })
  }
  if (file === undefined) return Object.freeze({})
  if (!isAbsolute(file)) {
    throw credentialError('authentication-failed', 'API-key secret path must be absolute inside the container')
  }

  // Status must not claim a configured secret is usable merely because an environment variable
  // names it. Validate the exact mounted inode before readiness, but pass only the path onward so
  // the daemon never retains another JavaScript string copy of the key. The wrapper reopens it for
  // each provider process, which makes host-side rotation take effect after container restart.
  const metadata = await lstat(file).catch(() => undefined)
  if (metadata === undefined || !metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 16 * 1024) {
    throw credentialError('authentication-failed', 'API-key secret must be a readable ordinary file no larger than 16 KiB')
  }
  const bytes = await readFile(file).catch(() => undefined)
  if (bytes === undefined) {
    throw credentialError('authentication-failed', 'API-key secret is not readable by UID 10001')
  }
  try {
    const value = bytes.toString('utf8')
    if (!/^\S+\n?$/.test(value)) {
      throw credentialError('authentication-failed', 'API-key secret must contain exactly one non-empty line')
    }
  } finally {
    // Buffer zeroing cannot erase filesystem/cache copies, but it avoids retaining the validation
    // copy in V8 after the only decision we need (valid/invalid) has been made.
    bytes.fill(0)
  }
  return Object.freeze({ WORKFLOW_MCP_OPENAI_API_KEY_FILE: file })
}

function credentialError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}

async function codexPolicyFingerprint(
  config: StandaloneConfig,
  environment: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const policyFiles = [
    '/etc/codex/requirements.toml',
    '/opt/workflow-mcp/bin/codex-policy-launcher.mjs',
  ]
  const contents = await Promise.all(policyFiles.map(path => readFile(path).catch(() => undefined)))
  if (contents.some(value => value === undefined)) return undefined
  const evidence = {
    schemaVersion: 1,
    sourceMode: config.sourceMode,
    projectCodexMasked: environment.WORKFLOW_MCP_PROJECT_CODEX_MASKED === 'true',
    policyFiles: policyFiles.map((path, index) => ({
      path,
      sha256: createHash('sha256').update(contents[index]!).digest('hex'),
    })),
  }
  return createHash('sha256').update(JSON.stringify(evidence)).digest('hex')
}
