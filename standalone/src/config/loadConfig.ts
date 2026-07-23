import { isAbsolute, resolve } from 'node:path'

import {
  StandaloneConfigurationError,
  type StandaloneConfig,
  type StandaloneLeaseMode,
  type StandaloneSourceMode,
} from './schema.js'

export function loadStandaloneConfig(
  flags: Readonly<Record<string, string | boolean>>,
  environment: NodeJS.ProcessEnv = process.env,
): StandaloneConfig {
  const workspace = absolutePath(
    stringFlag(flags, 'workspace') ?? environment.WORKFLOW_MCP_WORKSPACE ?? '/workspace',
    'workspace',
  )
  const dataDirectory = absolutePath(
    stringFlag(flags, 'data-dir') ?? environment.WORKFLOW_MCP_DATA_DIR ?? '/data',
    'data-dir',
  )
  const hostValue = stringFlag(flags, 'host') ?? environment.WORKFLOW_MCP_HOST ?? '127.0.0.1'
  if (hostValue !== '127.0.0.1' && hostValue !== '0.0.0.0') {
    throw new StandaloneConfigurationError('host must be 127.0.0.1 or 0.0.0.0')
  }
  const port = integer(
    stringFlag(flags, 'port') ?? environment.WORKFLOW_MCP_PORT ?? '7331',
    'port',
    1,
    65_535,
  )
  const sourceMode = enumValue<StandaloneSourceMode>(
    stringFlag(flags, 'source-mode') ?? environment.WORKFLOW_MCP_SOURCE_MODE ?? 'read-only',
    'source-mode',
    ['read-only', 'authoring'],
  )
  const defaultLease = process.platform === 'linux' ? 'inherited-flock' : 'embedded'
  const leaseMode = enumValue<StandaloneLeaseMode>(
    stringFlag(flags, 'lease') ?? environment.WORKFLOW_MCP_LEASE_MODE ?? defaultLease,
    'lease',
    ['inherited-flock', 'embedded'],
  )
  // Client-only processes run in the same image but never receive the owner's descriptor. Keep
  // configuration parseable for healthcheck/proxy/doctor and let the application composition root
  // reject a missing descriptor before it touches durable state.
  const lockFileDescriptor = leaseMode === 'inherited-flock' && environment.WORKFLOW_MCP_LOCK_FD !== undefined
    ? integer(environment.WORKFLOW_MCP_LOCK_FD, 'WORKFLOW_MCP_LOCK_FD', 3, 1_024)
    : undefined
  const lockPath = leaseMode === 'inherited-flock'
    ? absolutePath(
        environment.WORKFLOW_MCP_LOCK_PATH ?? `${dataDirectory}/.coordination/owner.lock`,
        'WORKFLOW_MCP_LOCK_PATH',
      )
    : undefined
  const codexExecutable = absolutePath(
    environment.WORKFLOW_MCP_CODEX_PATH ?? '/opt/workflow-mcp/bin/codex-isolated',
    'WORKFLOW_MCP_CODEX_PATH',
  )
  const webEnabled = booleanValue(
    stringFlag(flags, 'web') ?? environment.WORKFLOW_MCP_WEB_ENABLED ?? 'false',
    'web',
  )

  const config: StandaloneConfig = {
    workspace,
    dataDirectory,
    host: hostValue,
    port,
    sourceMode,
    leaseMode,
    ...(lockFileDescriptor === undefined ? {} : { lockFileDescriptor }),
    ...(lockPath === undefined ? {} : { lockPath }),
    codexExecutable,
    webEnabled,
  }
  return Object.freeze(config)
}

function stringFlag(
  flags: Readonly<Record<string, string | boolean>>,
  name: string,
): string | undefined {
  const value = flags[name]
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw new StandaloneConfigurationError(`--${name} requires a value`)
  }
  return value
}

function absolutePath(value: string, name: string): string {
  if (!isAbsolute(value)) throw new StandaloneConfigurationError(`${name} must be an absolute path`)
  return resolve(value)
}

function integer(value: string, name: string, minimum: number, maximum: number): number {
  if (!/^\d+$/.test(value)) {
    throw new StandaloneConfigurationError(`${name} must be an integer from ${minimum} through ${maximum}`)
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new StandaloneConfigurationError(`${name} must be an integer from ${minimum} through ${maximum}`)
  }
  return parsed
}

function enumValue<T extends string>(
  value: string,
  name: string,
  accepted: readonly T[],
): T {
  if (!accepted.includes(value as T)) {
    throw new StandaloneConfigurationError(`${name} must be one of ${accepted.join(', ')}`)
  }
  return value as T
}

function booleanValue(value: string, name: string): boolean {
  if (value === 'true' || value === '1') return true
  if (value === 'false' || value === '0') return false
  throw new StandaloneConfigurationError(`${name} must be true or false`)
}
