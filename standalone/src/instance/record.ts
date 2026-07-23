import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, win32 } from 'node:path'

const LOWERCASE_UUID_V4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/

export type StandaloneInstanceRecord = Readonly<{
  schemaVersion: 1
  instanceId: string
  composeProjectName: string
  projectDirectory: string
  projectHash: string
  dockerContext: string
  dockerEndpoint: string
  dockerDaemonFingerprint: string
  image: string
  createdAt: string
  webPort?: number
  authoring: boolean
  // WHY one recorded bit: `hardened` selects the whole original shipped posture (read-only
  // sources, durable approvals, token web, isolated auth). Recording the profile — instead of a
  // pile of per-feature booleans — means an upgrade or recovery reconstructs exactly the posture
  // the operator installed, and one subsystem can never drift from the others. Both fields are
  // optional in stored JSON so records written before the consumer-defaults release stay valid;
  // absent means false.
  hardened?: boolean
  hostCodexAuth?: boolean
  apiKeyFile?: string
}>

export function createInstanceRecord(input: {
  projectDirectory: string
  dockerContext: string
  dockerEndpoint: string
  dockerDaemonFingerprint: string
  image: string
  webPort?: number
  authoring?: boolean
  hardened?: boolean
  hostCodexAuth?: boolean
  apiKeyFile?: string
}): StandaloneInstanceRecord {
  return buildInstanceRecord({ ...input, instanceId: randomUUID() })
}

export function adoptInstanceRecord(input: {
  instanceId: string
  projectDirectory: string
  dockerContext: string
  dockerEndpoint: string
  dockerDaemonFingerprint: string
  image: string
  webPort?: number
  authoring?: boolean
  hardened?: boolean
  hostCodexAuth?: boolean
  apiKeyFile?: string
}): StandaloneInstanceRecord {
  if (!LOWERCASE_UUID_V4.test(input.instanceId)) {
    throw new Error('Adopted instance ID must be a lowercase UUIDv4')
  }
  // Adoption recreates only disposable host metadata. Reusing the original random identity is the
  // sole way to derive and attest the preserved volume name; inventing a new ID would orphan data
  // behind labels the replacement launcher can no longer prove it owns.
  return buildInstanceRecord(input)
}

function buildInstanceRecord(input: {
  instanceId: string
  projectDirectory: string
  dockerContext: string
  dockerEndpoint: string
  dockerDaemonFingerprint: string
  image: string
  webPort?: number
  authoring?: boolean
  hardened?: boolean
  hostCodexAuth?: boolean
  apiKeyFile?: string
}): StandaloneInstanceRecord {
  const projectDirectory = absolute(input.projectDirectory, 'project directory')
  const instanceId = input.instanceId
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
    dockerDaemonFingerprint: fingerprint(input.dockerDaemonFingerprint, 'Docker daemon fingerprint'),
    image: input.image,
    createdAt: new Date().toISOString(),
    ...(input.webPort === undefined ? {} : { webPort: input.webPort }),
    authoring: input.authoring ?? false,
    ...(input.hardened === true ? { hardened: true } : {}),
    ...(input.hostCodexAuth === true ? { hostCodexAuth: true } : {}),
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
    typeof value.instanceId !== 'string' || !LOWERCASE_UUID_V4.test(value.instanceId) ||
    typeof value.composeProjectName !== 'string' || !/^workflow-mcp-[a-f0-9]{16}$/.test(value.composeProjectName) ||
    typeof value.projectDirectory !== 'string' || !isHostAbsolute(value.projectDirectory) ||
    typeof value.projectHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.projectHash) ||
    typeof value.dockerContext !== 'string' || value.dockerContext.length === 0 ||
    typeof value.dockerEndpoint !== 'string' || value.dockerEndpoint.length === 0 ||
    typeof value.dockerDaemonFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.dockerDaemonFingerprint) ||
    typeof value.image !== 'string' || value.image.length === 0 ||
    typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) ||
    typeof value.authoring !== 'boolean' ||
    (value.hardened !== undefined && value.hardened !== true) ||
    (value.hostCodexAuth !== undefined && value.hostCodexAuth !== true) ||
    (value.webPort !== undefined && (!Number.isSafeInteger(value.webPort) || (value.webPort as number) < 1 || (value.webPort as number) > 65_535)) ||
    (value.apiKeyFile !== undefined && (typeof value.apiKeyFile !== 'string' || !isHostAbsolute(value.apiKeyFile)))
  ) throw new Error('Workflow MCP instance record is invalid or unsupported')
  if (value.projectDirectory !== absolute(value.projectDirectory, 'project directory') ||
    (value.apiKeyFile !== undefined && value.apiKeyFile !== absolute(value.apiKeyFile, 'API key file'))) {
    throw new Error('Instance record host paths are not canonical')
  }
  if (value.composeProjectName !== `workflow-mcp-${value.instanceId.replaceAll('-', '').slice(0, 16)}`) {
    throw new Error('Instance record project name does not derive from its identity')
  }
  if (value.projectHash !== hashProjectIdentity(value.projectDirectory)) {
    throw new Error('Instance record project hash does not match its canonical path')
  }
  return Object.freeze(value as StandaloneInstanceRecord)
}

export function hashProjectIdentity(projectDirectory: string): string {
  return createHash('sha256').update(
    `workflow-mcp-project-v1\0${normalizedHostIdentity(projectDirectory)}`,
  ).digest('hex')
}

export function hashDockerDaemonIdentity(daemonId: string): string {
  if (daemonId.length === 0 || daemonId.length > 1_024 || /[\r\n\0]/.test(daemonId)) {
    throw new Error('Docker daemon ID is invalid')
  }
  // Context names and socket endpoints are routing hints, not daemon identity: Docker Desktop can
  // recreate the engine behind the same endpoint, and another context can expose a copied labeled
  // volume. Persist only this domain-separated digest of Engine /info.ID so adoption proves it is
  // occurring against the daemon that originally created the volume without disclosing host IDs.
  return createHash('sha256').update(`workflow-mcp-docker-daemon-v1\0${daemonId}`).digest('hex')
}

export function replaceInstanceImage(
  record: StandaloneInstanceRecord,
  image: string,
): StandaloneInstanceRecord {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/@:-]{0,255}$/.test(image)) {
    throw new Error('Image reference contains unsupported characters')
  }
  // Instance/project/volume identity survives upgrades. Generating a fresh record would silently
  // orphan the old labeled volume and Codex stanza; replacing exactly one reviewed field keeps
  // every other attestation stable and makes rollback a one-record operation.
  return Object.freeze({ ...record, image })
}

export function renderPosixInstanceEnvironment(record: StandaloneInstanceRecord): string {
  const values = {
    instance_id: record.instanceId,
    compose_project: record.composeProjectName,
    project_hash: record.projectHash,
    recorded_context: record.dockerContext,
    recorded_endpoint: record.dockerEndpoint,
    recorded_daemon_fingerprint: record.dockerDaemonFingerprint,
    recorded_image: record.image,
    web_port: record.webPort === undefined ? '' : String(record.webPort),
    authoring: String(record.authoring),
    hardened: String(record.hardened ?? false),
    host_codex_auth: String(record.hostCodexAuth ?? false),
    api_key_file: record.apiKeyFile ?? '',
  }
  // The POSIX launcher intentionally has no host Node/Python dependency. These assignments are
  // emitted only after strict record validation by the pinned image, use fixed variable names, and
  // single-quote every value with the standard close/escaped-quote/reopen form. This is a parser
  // boundary, not an invitation to source user-controlled JSON with regexes.
  return `${Object.entries(values).map(([name, value]) => (
    `${name}='${value.replaceAll("'", "'\\''")}'`
  )).join('\n')}\n`
}

export async function createHostDoctorEnvelope(input: {
  instanceFile: string
  containerReportFile: string
  platform: 'posix' | 'windows'
  hostDescription: string
  dockerClientVersion: string
  dockerServerVersion: string
  composeVersion: string
  dockerContext: string
  dockerEndpoint: string
  dockerDaemonFingerprint: string
  volumeDriver: string
  volumeOptions: string
  volumeInstanceLabel: string
  volumeProjectLabel: string
  volumeDaemonLabel: string
}): Promise<Record<string, unknown>> {
  const record = await readInstanceRecord(input.instanceFile)
  const container = parseDoctorReport(JSON.parse(await readFile(input.containerReportFile, 'utf8')) as unknown)
  const hostValues = [
    input.hostDescription,
    input.dockerClientVersion,
    input.dockerServerVersion,
    input.composeVersion,
    input.dockerContext,
    input.dockerEndpoint,
    input.dockerDaemonFingerprint,
    input.volumeDriver,
    input.volumeOptions,
    input.volumeInstanceLabel,
    input.volumeProjectLabel,
    input.volumeDaemonLabel,
  ]
  if (hostValues.some(value => value.length === 0 || value.length > 1_024 || /[\r\n\0]/.test(value))) {
    throw new Error('Host doctor input is invalid')
  }
  if (input.dockerContext !== record.dockerContext || input.dockerEndpoint !== record.dockerEndpoint) {
    throw new Error('Host doctor context does not match the instance record')
  }
  if (input.dockerDaemonFingerprint !== record.dockerDaemonFingerprint) {
    throw new Error('Host doctor daemon identity does not match the instance record')
  }
  if (input.volumeDriver !== 'local' || (input.volumeOptions !== 'null' && input.volumeOptions !== '{}')) {
    throw new Error('Host doctor volume driver/options are unsupported')
  }
  if (
    input.volumeInstanceLabel !== record.instanceId ||
    input.volumeProjectLabel !== record.projectHash ||
    input.volumeDaemonLabel !== record.dockerDaemonFingerprint
  ) {
    throw new Error('Host doctor volume labels do not match the instance record')
  }
  // WHY: the shell launchers are the only components that can see both Docker-host facts and the
  // container's self-inspection. The pinned image performs the JSON composition so neither shell
  // needs a second JSON parser/escaper, and consumers always receive one versioned/redactable shape.
  return Object.freeze({
    schemaVersion: 1,
    ok: container.ok,
    host: {
      // WHY: a successful local probe establishes compatibility of this runtime, not a blanket
      // support promise for every filesystem/backend hidden behind the same OS family. Windows is
      // explicitly preview until its external release matrix is signed off; POSIX reports the
      // narrower fact this envelope can actually prove.
      status: input.platform === 'windows' ? 'preview' : 'runtime-compatible',
      platform: input.platform,
      description: input.hostDescription,
      docker: {
        clientVersion: input.dockerClientVersion,
        serverVersion: input.dockerServerVersion,
        composeVersion: input.composeVersion,
        context: input.dockerContext,
        endpoint: {
          kind: input.dockerEndpoint.startsWith('npipe://') ? 'local-npipe' : 'local-unix',
          fingerprint: createHash('sha256').update(input.dockerEndpoint).digest('hex').slice(0, 16),
        },
      },
      projectPathCanonical: true,
      webPublicationRequired: record.webPort !== undefined,
      volume: {
        name: `${record.composeProjectName}_workflow-mcp-data`,
        driver: input.volumeDriver,
        options: input.volumeOptions === '{}' ? {} : null,
      },
    },
    container,
    identityVerdict: {
      ok: true,
      instanceId: record.instanceId,
      composeProjectName: record.composeProjectName,
      projectHash: record.projectHash,
      contextMatchesRecord: true,
      daemonMatchesRecord: true,
      volumeLabelsMatchRecord: true,
    },
  })
}

export function renderCodexMcpConfiguration(record: StandaloneInstanceRecord, composeFile: string): string {
  const canonicalComposeFile = absolute(composeFile, 'Compose file')
  const windowsHost = isWindowsDriveAbsolute(record.projectDirectory)
  const expectedComposeFile = windowsHost
    ? win32.join(record.projectDirectory, '.workflow-mcp', 'compose.yaml')
    : join(record.projectDirectory, '.workflow-mcp', 'compose.yaml')
  if (normalizedHostIdentity(canonicalComposeFile) !== normalizedHostIdentity(expectedComposeFile)) {
    throw new Error('Compose file must be the installed project-scoped Workflow MCP bundle')
  }
  const installation = windowsHost ? win32.dirname(canonicalComposeFile) : dirname(canonicalComposeFile)
  // The launcher is the instance policy boundary: it reconstructs every optional Compose overlay,
  // validates the recorded Docker context and image, and rechecks project identity. A raw `docker
  // compose exec` stanza would work only when a caller happened to inherit installer-only env vars
  // and, worse, could silently omit the API-key/authoring/Codex-mask overlays.
  const command = windowsHost ? 'pwsh' : join(installation, 'workflow-mcp-docker')
  const args = windowsHost
    ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', win32.join(installation, 'workflow-mcp-docker.ps1'), 'mcp-proxy']
    : ['mcp-proxy']
  return `# BEGIN WORKFLOW MCP ${record.instanceId}\n` +
    `[mcp_servers.workflow_mcp]\n` +
    `command = ${tomlString(command)}\n` +
    `args = [${args.map(tomlString).join(', ')}]\n` +
    `cwd = ${tomlString(record.projectDirectory)}\n` +
    `# END WORKFLOW MCP ${record.instanceId}\n`
}

function tomlString(value: string): string {
  return JSON.stringify(value)
}

function absolute(value: string, name: string): string {
  if (!isHostAbsolute(value)) throw new Error(`${name} must be absolute`)
  return isWindowsDriveAbsolute(value) ? normalizedWindowsDisplayPath(value) : resolve(value)
}

function isHostAbsolute(value: string): boolean {
  return isAbsolute(value) || isWindowsDriveAbsolute(value)
}

function isWindowsDriveAbsolute(value: string): boolean {
  // Instance metadata is generated inside a Linux image even when Docker Desktop and Codex run on
  // Windows. node:path therefore cannot recognize `C:\\project`. Supporting an explicit drive path
  // keeps the host launcher Docker-only; UNC/device-relative forms stay rejected because their
  // Docker Desktop sharing and canonical-identity behavior needs a separate support proof.
  return /^[A-Za-z]:[\\/]/.test(value) && !/[\r\n\0]/.test(value)
}

function normalizedWindowsDisplayPath(value: string): string {
  const normalized = win32.normalize(value)
  const withCanonicalDrive = `${normalized[0]!.toUpperCase()}${normalized.slice(1)}`
  return withCanonicalDrive.length > 3 ? withCanonicalDrive.replace(/\\+$/, '') : withCanonicalDrive
}

function normalizedHostIdentity(value: string): string {
  if (!isHostAbsolute(value)) throw new Error('project directory must be absolute')
  // Windows' normal Docker Desktop project filesystem is case-insensitive. Hashing the normalized
  // drive path case-insensitively prevents two spellings of one directory from manufacturing two
  // instance identities, while the record retains a display/bind path with canonical separators.
  return isWindowsDriveAbsolute(value)
    ? normalizedWindowsDisplayPath(value).toLocaleLowerCase('en-US')
    : resolve(value)
}

function nonempty(value: string, name: string): string {
  if (value.length === 0 || /[\r\n\0]/.test(value)) throw new Error(`${name} is invalid`)
  return value
}

function fingerprint(value: string, name: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${name} is invalid`)
  return value
}

function parseDoctorReport(value: unknown): Record<string, unknown> & { ok: boolean } {
  if (
    !isObject(value) || value.schemaVersion !== 1 || typeof value.ok !== 'boolean' ||
    typeof value.version !== 'string' || typeof value.revision !== 'string' ||
    !isObject(value.dependencies) || !Array.isArray(value.checks) ||
    !value.checks.every(check => isObject(check) && typeof check.id === 'string' &&
      (check.status === 'pass' || check.status === 'warn' || check.status === 'fail') &&
      typeof check.message === 'string')
  ) throw new Error('Container doctor report is invalid or unsupported')
  return value as Record<string, unknown> & { ok: boolean }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
