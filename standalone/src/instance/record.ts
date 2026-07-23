import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'

export type StandaloneInstanceRecord = Readonly<{
  schemaVersion: 1
  instanceId: string
  composeProjectName: string
  projectDirectory: string
  projectHash: string
  dockerContext: string
  dockerEndpoint: string
  image: string
  createdAt: string
  webPort?: number
  authoring: boolean
  apiKeyFile?: string
}>

export function createInstanceRecord(input: {
  projectDirectory: string
  dockerContext: string
  dockerEndpoint: string
  image: string
  webPort?: number
  authoring?: boolean
  apiKeyFile?: string
}): StandaloneInstanceRecord {
  const projectDirectory = absolute(input.projectDirectory, 'project directory')
  const instanceId = randomUUID()
  if (!/^[A-Za-z0-9][A-Za-z0-9._/@:-]{0,255}$/.test(input.image)) {
    throw new Error('Image reference contains unsupported characters')
  }
  if (input.webPort !== undefined && (!Number.isSafeInteger(input.webPort) || input.webPort < 1 || input.webPort > 65_535)) {
    throw new Error('Web port must be an integer from 1 through 65535')
  }
  return Object.freeze({
    schemaVersion: 1,
    instanceId,
    composeProjectName: `workflow-mcp-${instanceId.replaceAll('-', '').slice(0, 16)}`,
    projectDirectory,
    projectHash: hashProjectIdentity(projectDirectory),
    dockerContext: nonempty(input.dockerContext, 'Docker context'),
    dockerEndpoint: nonempty(input.dockerEndpoint, 'Docker endpoint'),
    image: input.image,
    createdAt: new Date().toISOString(),
    ...(input.webPort === undefined ? {} : { webPort: input.webPort }),
    authoring: input.authoring ?? false,
    ...(input.apiKeyFile === undefined ? {} : { apiKeyFile: absolute(input.apiKeyFile, 'API key file') }),
  })
}

export async function readInstanceRecord(path: string): Promise<StandaloneInstanceRecord> {
  const bytes = await readFile(path, 'utf8')
  if (Buffer.byteLength(bytes) > 64 * 1024) throw new Error('Instance record exceeds 64 KiB')
  return parseInstanceRecord(JSON.parse(bytes) as unknown)
}

export function parseInstanceRecord(value: unknown): StandaloneInstanceRecord {
  if (
    !isObject(value) || value.schemaVersion !== 1 ||
    typeof value.instanceId !== 'string' || !/^[a-f0-9-]{36}$/.test(value.instanceId) ||
    typeof value.composeProjectName !== 'string' || !/^workflow-mcp-[a-f0-9]{16}$/.test(value.composeProjectName) ||
    typeof value.projectDirectory !== 'string' || !isAbsolute(value.projectDirectory) ||
    typeof value.projectHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.projectHash) ||
    typeof value.dockerContext !== 'string' || value.dockerContext.length === 0 ||
    typeof value.dockerEndpoint !== 'string' || value.dockerEndpoint.length === 0 ||
    typeof value.image !== 'string' || value.image.length === 0 ||
    typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) ||
    typeof value.authoring !== 'boolean' ||
    (value.webPort !== undefined && (!Number.isSafeInteger(value.webPort) || (value.webPort as number) < 1 || (value.webPort as number) > 65_535)) ||
    (value.apiKeyFile !== undefined && (typeof value.apiKeyFile !== 'string' || !isAbsolute(value.apiKeyFile)))
  ) throw new Error('Workflow MCP instance record is invalid or unsupported')
  if (value.composeProjectName !== `workflow-mcp-${value.instanceId.replaceAll('-', '').slice(0, 16)}`) {
    throw new Error('Instance record project name does not derive from its identity')
  }
  if (value.projectHash !== hashProjectIdentity(resolve(value.projectDirectory))) {
    throw new Error('Instance record project hash does not match its canonical path')
  }
  return Object.freeze(value as StandaloneInstanceRecord)
}

export function hashProjectIdentity(projectDirectory: string): string {
  return createHash('sha256').update(`workflow-mcp-project-v1\0${resolve(projectDirectory)}`).digest('hex')
}

export function renderCodexMcpConfiguration(record: StandaloneInstanceRecord, composeFile: string): string {
  const args = [
    'compose', '-f', absolute(composeFile, 'Compose file'), '-p', record.composeProjectName,
    'exec', '-T', 'workflow-mcp', 'workflow-mcp', 'mcp-proxy',
  ]
  return `# BEGIN WORKFLOW MCP ${record.instanceId}\n` +
    `[mcp_servers.workflow_mcp]\n` +
    `command = "docker"\n` +
    `args = [${args.map(tomlString).join(', ')}]\n` +
    `cwd = ${tomlString(record.projectDirectory)}\n` +
    `# END WORKFLOW MCP ${record.instanceId}\n`
}

function tomlString(value: string): string {
  return JSON.stringify(value)
}

function absolute(value: string, name: string): string {
  if (!isAbsolute(value)) throw new Error(`${name} must be absolute`)
  return resolve(value)
}

function nonempty(value: string, name: string): string {
  if (value.length === 0 || /[\r\n\0]/.test(value)) throw new Error(`${name} is invalid`)
  return value
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
