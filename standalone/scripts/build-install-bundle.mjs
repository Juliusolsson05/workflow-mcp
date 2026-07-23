import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, stat, utimes, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const standaloneRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const arguments_ = parseArguments(process.argv.slice(2))
const output = resolve(arguments_.output ?? join(standaloneRoot, 'dist', 'install-bundle'))
const version = arguments_.version ?? '0.1.0-dev'
const revision = arguments_.revision ?? 'development'
const image = arguments_.image ?? 'workflow-mcp:development'
const release = arguments_.release === true

// WHY: an explicit output is caller-owned and may be a durable mount such as `/data`, not a
// disposable build leaf. Path-shape validation cannot tell those meanings apart, so recursively
// replacing an existing target would turn a harmless typo into data loss. An atomic, non-recursive
// mkdir below claims only a previously nonexistent leaf and also closes the check/create race.
if (!isAbsolute(output) || basename(output) === '' || output === dirname(output)) {
  throw new Error(`Unsafe bundle output path: ${output}`)
}
if (relative(standaloneRoot, output).split(sep).includes('..') && arguments_.output === undefined) {
  throw new Error('The default bundle output escaped the standalone directory')
}
if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`Invalid bundle version: ${version}`)
}
if (release) {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) throw new Error('Release version must be stable SemVer')
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error('Release revision must be a full lowercase Git SHA')
  if (!/@sha256:[0-9a-f]{64}$/.test(image)) throw new Error('Release image must use an immutable index digest')
}

const inputs = Object.freeze([
  ['../LICENSE', 'LICENSE'],
  ['compose.yaml', 'compose.yaml'],
  ['compose.web.yaml', 'compose.web.yaml'],
  ['compose.authoring.yaml', 'compose.authoring.yaml'],
  ['compose.auth-api-key.yaml', 'compose.auth-api-key.yaml'],
  ['compose.project-codex-mask.yaml', 'compose.project-codex-mask.yaml'],
  ['install/workflow-mcp-docker', 'workflow-mcp-docker'],
  ['install/workflow-mcp-docker.ps1', 'workflow-mcp-docker.ps1'],
  ['scripts/launcher-smoke.sh', 'launcher-smoke.sh'],
  ['install/bundle.gitignore', '.gitignore'],
])

await mkdir(dirname(output), { recursive: true, mode: 0o700 })
try {
  await mkdir(output, { recursive: false, mode: 0o700 })
} catch (error) {
  if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
    throw new Error(`Bundle output already exists: ${output}`)
  }
  throw error
}
for (const [sourceName, targetName] of inputs) {
  const bytes = await readFile(join(standaloneRoot, sourceName))
  await writeFile(join(output, targetName), bytes, {
    mode: ['workflow-mcp-docker', 'launcher-smoke.sh'].includes(targetName) ? 0o755 : 0o600,
  })
}
await writeFile(join(output, 'version.env'), [
  '# Generated release metadata. This file is covered by SHA256SUMS.',
  `WORKFLOW_MCP_BUNDLE_VERSION=${version}`,
  `WORKFLOW_MCP_BUNDLE_REVISION=${revision}`,
  `WORKFLOW_MCP_IMAGE=${image}`,
  '',
].join('\n'), { mode: 0o600 })

const files = [...inputs.map(([, target]) => target), 'version.env'].sort()
const checksumLines = []
for (const file of files) {
  const bytes = await readFile(join(output, file))
  checksumLines.push(`${createHash('sha256').update(bytes).digest('hex')}  ${file}`)
}
await writeFile(join(output, 'SHA256SUMS'), `${checksumLines.join('\n')}\n`, { mode: 0o600 })

// Reproducible content is the primary contract, but normalized mtimes also make
// a caller's deterministic tar invocation independent of checkout timestamps.
const epochSeconds = Number(process.env.SOURCE_DATE_EPOCH ?? '0')
if (!Number.isSafeInteger(epochSeconds) || epochSeconds < 0) throw new Error('SOURCE_DATE_EPOCH must be a non-negative integer')
const timestamp = new Date(epochSeconds * 1_000)
for (const file of [...files, 'SHA256SUMS']) await utimes(join(output, file), timestamp, timestamp)
await utimes(output, timestamp, timestamp)
await chmod(join(output, 'workflow-mcp-docker'), 0o755)
await chmod(join(output, 'launcher-smoke.sh'), 0o755)

const outputStat = await stat(output)
if (!outputStat.isDirectory()) throw new Error('Bundle output is not a directory')
process.stdout.write(`${output}\n`)

function parseArguments(values) {
  const result = {}
  for (const value of values) {
    if (value === '--release') {
      result.release = true
      continue
    }
    const match = /^--(output|version|revision|image)=(.+)$/.exec(value)
    if (match === null) throw new Error(`Unknown bundle option: ${value}`)
    result[match[1]] = match[2]
  }
  return result
}
