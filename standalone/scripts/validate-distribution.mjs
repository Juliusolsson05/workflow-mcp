import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const json = async path => JSON.parse(await readFile(join(root, path), 'utf8'))
const packageDocument = await json('package.json')
const server = await json('distribution/mcp-registry/server.json')
const tools = await json('distribution/docker-catalog/tools.json')
const dockerfile = await readFile(join(root, 'docker/Dockerfile'), 'utf8')
const compose = await readFile(join(root, 'compose.yaml'), 'utf8')
const catalog = await readFile(join(root, 'distribution/docker-catalog/server.template.yaml'), 'utf8')
const catalogReadme = await readFile(join(root, 'distribution/docker-catalog/readme.md'), 'utf8')
const bundleBuilder = await readFile(join(root, 'scripts/build-install-bundle.mjs'), 'utf8')
const containerSmoke = await readFile(join(root, 'scripts/container-smoke.sh'), 'utf8')
const posixLauncher = await readFile(join(root, 'install/workflow-mcp-docker'), 'utf8')
const powershellLauncher = await readFile(join(root, 'install/workflow-mcp-docker.ps1'), 'utf8')
const grypeConfiguration = await readFile(join(root, '../.grype.yaml'), 'utf8')
const releaseWorkflow = await readFile(join(root, '../.github/workflows/container-release.yml'), 'utf8')

if (server.$schema !== 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json') {
  throw new Error('MCP Registry metadata must pin the reviewed 2025-12-11 schema')
}
if (server.name !== 'io.github.Juliusolsson05/workflow-mcp') throw new Error('MCP server name drifted')
if (server.version !== packageDocument.version) throw new Error('Standalone and MCP Registry versions differ')
if (server.packages?.length !== 1 || server.packages[0]?.registryType !== 'oci') {
  throw new Error('MCP Registry metadata must contain one OCI package')
}
const registryPackage = server.packages[0]
if (!registryPackage.environmentVariables?.some(input => (
  input.name === 'OPENAI_API_KEY' && input.isRequired === true && input.isSecret === true
))) throw new Error('MCP Registry OCI package must declare the required OpenAI secret')
if (registryPackage.runtimeHint !== 'docker' || !registryPackage.runtimeArguments?.some(argument => (
  argument.name === '--mount' && argument.value?.includes('target=/workspace') && argument.value?.includes('readonly')
))) throw new Error('MCP Registry OCI package must request an explicit read-only workspace mount')
for (const [name, value] of [
  ['--read-only', 'true'],
  ['--user', '10001:10001'],
  ['--cap-drop', 'ALL'],
  ['--security-opt', 'no-new-privileges:true'],
  ['--security-opt', 'seccomp=unconfined'],
  ['--security-opt', 'apparmor=unconfined'],
  ['--pids-limit', '256'],
  ['--memory', '2g'],
  ['--cpus', '1'],
  ['--mount', 'type=volume,target=/data'],
]) {
  if (!registryPackage.runtimeArguments.some(argument => argument.name === name && argument.value === value)) {
    throw new Error(`MCP Registry Docker profile lost hardened runtime argument ${name}`)
  }
}
if (!server.description.includes('Session-bound') || !server.description.includes('State is discarded')) {
  throw new Error('MCP Registry metadata must disclose its ephemeral compatibility lifecycle')
}
if (server.packages[0].identifier !== `docker.io/juliusolsson/workflow-mcp:${packageDocument.version}`) {
  throw new Error('MCP Registry image/version differs from the standalone release')
}
if (!/io\.modelcontextprotocol\.server\.name="io\.github\.Juliusolsson05\/workflow-mcp"/.test(dockerfile)) {
  throw new Error('OCI image lacks the exact MCP ownership label')
}
if (!dockerfile.includes('https://github.com/Juliusolsson05/workflow-mcp')) {
  throw new Error('OCI source label does not name the actual repository')
}
if (!/read_only:\s+true/.test(compose) || /^\s*ports:/m.test(compose)) {
  throw new Error('Base Compose profile must remain read-only and unpublished')
}
if (!bundleBuilder.includes("['../LICENSE', 'LICENSE']")) {
  throw new Error('Install bundle must carry the repository MIT license and checksum it')
}
if (bundleBuilder.includes('rm(output') || !bundleBuilder.includes('Bundle output already exists')) {
  throw new Error('Install bundle renderer must fail closed instead of replacing caller-owned output')
}
if (!containerSmoke.includes('Dockerfile.example-toolchain') || !containerSmoke.includes('/usr/bin/make')) {
  throw new Error('Final-image smoke must build and execute the documented derived toolchain image')
}
if (!posixLauncher.includes('write_installed_checksums') || !powershellLauncher.includes('Write-InstalledChecksumManifest')) {
  throw new Error('Both launchers must preserve authenticated checksums after installation and upgrade')
}
if (!compose.includes('io.workflow-mcp.docker-daemon-fingerprint') ||
    !posixLauncher.includes('instance verify-policy --directory=/bundle') ||
    !powershellLauncher.includes('instance verify-policy --directory=/bundle')) {
  throw new Error('Compose/adoption/recovery authority must remain bound to daemon identity and immutable image policy')
}
if (!posixLauncher.includes('validate_codex_removal_path') ||
    !powershellLauncher.includes('Test-CodexRemovalPath') ||
    !posixLauncher.includes('compose exec -T workflow-mcp workflow-mcp token show') ||
    !powershellLauncher.includes('@("exec", "-T")')) {
  throw new Error('Both launchers must preserve uninstall path preflights and host token TTY semantics')
}
if (!powershellLauncher.includes('instance inspect --file=/bundle/instance.json')) {
  throw new Error('PowerShell launcher must route instance command authority through the pinned strict parser')
}
if (
  !releaseWorkflow.includes('--output "sarif=workflow-mcp-${arch}.sarif"') ||
  !releaseWorkflow.includes('--output "json=workflow-mcp-${arch}.json"') ||
  !releaseWorkflow.includes('(.ignoredMatches | length) == 1')
) {
  throw new Error('Release scan must retain same-evaluation SARIF/JSON and prove the exact waiver')
}
if (
  !releaseWorkflow.includes('"refs/heads/$DEFAULT_BRANCH:refs/remotes/origin/$DEFAULT_BRANCH"') ||
  !releaseWorkflow.includes('git merge-base --is-ancestor "$GITHUB_SHA" "refs/remotes/origin/$DEFAULT_BRANCH"')
) {
  throw new Error('Trusted release tags must identify commits on the freshly fetched default branch')
}
// WHY: the endpoint requires Administration(read), which GITHUB_TOKEN cannot express. Giving that
// capability to the publication environment would unnecessarily combine repository administration
// visibility with Docker/release authority. Preserve the separate environment, secret, empty job
// permissions, and dependency ordering as one static trust-boundary assertion.
const releaseControlPreflight = releaseWorkflow.indexOf('\n  release-control-preflight:')
const protectedBuildJob = releaseWorkflow.indexOf('\n  build:')
const preflightBody = releaseControlPreflight >= 0 && protectedBuildJob > releaseControlPreflight
  ? releaseWorkflow.slice(releaseControlPreflight, protectedBuildJob)
  : ''
if (
  !releaseWorkflow.includes('github-immutable-v1+protected-tags-v1+protected-preflight-v1+protected-publication-v1+private-reporting-v1') ||
  !preflightBody.includes('environment: workflow-mcp-release-preflight') ||
  !preflightBody.includes('permissions: {}') ||
  !preflightBody.includes('GH_TOKEN: ${{ secrets.WORKFLOW_MCP_GITHUB_ADMIN_READ_TOKEN }}') ||
  !preflightBody.includes('"repos/$GITHUB_REPOSITORY/immutable-releases"') ||
  !preflightBody.includes('"repos/$GITHUB_REPOSITORY/private-vulnerability-reporting"') ||
  !preflightBody.includes("--jq '.enabled == true'") ||
  !releaseWorkflow.includes('needs: [validate, release-control-preflight]')
) {
  throw new Error('Read-only GitHub administration preflight must remain isolated ahead of publication credentials')
}
if (
  !releaseWorkflow.includes('settings.rules.every(value=>typeof value==="string")') ||
  !releaseWorkflow.includes('[...settings.rules].sort()') ||
  !releaseWorkflow.includes('const expectedRules=[rule];') ||
  !releaseWorkflow.includes('JSON.stringify(rules)!==JSON.stringify(expectedRules)')
) {
  throw new Error('Docker Hub immutable-tag policy must equal the one reviewed full-SemVer rule')
}
if (
  !releaseWorkflow.includes('const referenceDigest="vnd.docker.reference.digest";') ||
  !releaseWorkflow.includes('if(children.length!==2||attestations.length!==2)') ||
  !releaseWorkflow.includes('attestationByChild.has(child)')
) {
  throw new Error('Release identity gate must bind exactly one attestation descriptor to each native child')
}
// WHY: a source-controlled scanner exception is executable release policy. Comparing every active
// YAML line prevents a convenient future wildcard, second CVE, or dropped version constraint from
// quietly weakening the HIGH gate while preserving explanatory comments for human reviewers.
const activeGrypeConfiguration = grypeConfiguration
  .split('\n')
  .filter(line => line.trim().length > 0 && !line.trimStart().startsWith('#'))
  .join('\n')
if (activeGrypeConfiguration !== [
  'ignore:',
  '  - vulnerability: CVE-2026-32631',
  '    package:',
  '      type: apk',
  '      name: git',
  '      version: 2.52.0-r0',
].join('\n')) {
  throw new Error('Grype suppression must remain the one exact Linux-inapplicable Git for Windows advisory')
}
if (!catalog.includes('image: docker.io/juliusolsson/workflow-mcp:${VERSION}') || !catalog.includes('commit: ${REVISION}')) {
  throw new Error('Docker Catalog metadata must retain explicit release substitution tokens')
}
const renderedCatalog = catalog
  .replaceAll('${VERSION}', packageDocument.version)
  .replaceAll('${REVISION}', '0123456789012345678901234567890123456789')
if (renderedCatalog.includes('${')) {
  throw new Error('Docker Catalog template contains an unresolved release token after rendering')
}
if (!/^  title: Workflow$/m.test(catalog) || /^  title: .*\b(?:MCP|Server)\b/m.test(catalog)) {
  throw new Error('Docker Catalog title must satisfy the upstream no-MCP/no-Server title rule')
}
if (!catalog.includes('{{workflow-mcp.project|volume-target}}:/workspace:ro')) {
  throw new Error('Docker Catalog project bind must retain the reviewed host-volume parameter form')
}
if (/workflow-mcp-codex-mask|WORKFLOW_MCP_PROJECT_CODEX_MASKED/.test(catalog)) {
  throw new Error('Docker Catalog must not share a cross-container project-Codex mask volume')
}
if (/workflow-mcp-data:\/data/.test(catalog)) {
  throw new Error('Session-bound Docker Catalog metadata must not share one global durable data volume')
}
if (
  !catalogReadme.includes('session-bound STDIO') ||
  !catalogReadme.includes('Compose/launcher bundle') ||
  !catalogReadme.includes('does not contain `.codex`')
) {
  throw new Error('Docker Catalog readme must disclose its lifecycle boundary and durable alternative')
}
if (!Array.isArray(tools) || tools.length !== 13 || new Set(tools.map(tool => tool.name)).size !== 13) {
  throw new Error('Docker Catalog tool inventory must name all thirteen stable MCP tools exactly once')
}
for (const tool of tools) {
  if (!Array.isArray(tool.arguments)) throw new Error(`Docker Catalog tool ${tool.name} has no argument inventory`)
  if (
    typeof tool.annotations !== 'object' || tool.annotations === null ||
    typeof tool.annotations.readOnlyHint !== 'boolean' ||
    typeof tool.annotations.destructiveHint !== 'boolean' ||
    tool.annotations.openWorldHint !== false
  ) throw new Error(`Docker Catalog tool ${tool.name} lost its reviewed MCP annotations`)
  for (const argument of tool.arguments) {
    if (
      typeof argument.name !== 'string' || typeof argument.type !== 'string' ||
      typeof argument.desc !== 'string' ||
      (argument.optional !== undefined && argument.optional !== true)
    ) throw new Error(`Docker Catalog tool ${tool.name} has an invalid argument descriptor`)
  }
}
if (tools.find(tool => tool.name === 'workflow_run_cancel')?.annotations.destructiveHint !== true) {
  throw new Error('Docker Catalog cancellation must retain its destructive annotation')
}
if (!catalogReadme.includes('no `unknown` JSON type')) {
  throw new Error('Docker Catalog must disclose the static workflow_run.args approximation')
}
for (const required of ['workflow_describe', 'workflow_validate', 'workflow_run_status', 'workflow_run_events']) {
  if (tools.find(tool => tool.name === required)?.arguments.length === 0) {
    throw new Error(`Docker Catalog tool ${required} lost its required arguments`)
  }
}
process.stdout.write('Standalone distribution metadata is internally consistent.\n')
