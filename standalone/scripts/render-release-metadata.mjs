import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const options = Object.fromEntries(process.argv.slice(2).map(value => {
  const match = /^--(version|revision|digest|output)=(.+)$/.exec(value)
  if (match === null) throw new Error(`Unknown release metadata option: ${value}`)
  return [match[1], match[2]]
}))
if (!/^\d+\.\d+\.\d+$/.test(options.version ?? '')) throw new Error('Release version must be stable SemVer')
if (!/^[a-f0-9]{40}$/.test(options.revision ?? '')) throw new Error('Release revision must be a full Git SHA')
if (!/^sha256:[a-f0-9]{64}$/.test(options.digest ?? '')) throw new Error('Release digest must be a sha256 index digest')
if (options.output === undefined) throw new Error('Release metadata output is required')
const packageDocument = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
if (packageDocument.version !== options.version) {
  throw new Error(`Release ${options.version} differs from standalone package ${packageDocument.version}`)
}

const output = resolve(options.output)
await mkdir(output, { recursive: true, mode: 0o700 })
const server = JSON.parse(await readFile(join(root, 'distribution/mcp-registry/server.json'), 'utf8'))
server.version = options.version
server.packages[0].identifier = `docker.io/juliusolsson/workflow-mcp@${options.digest}`
await writeFile(join(output, 'server.json'), `${JSON.stringify(server, null, 2)}\n`, { mode: 0o600 })

const template = await readFile(join(root, 'distribution/docker-catalog/server.template.yaml'), 'utf8')
const catalog = template
  .replaceAll('${VERSION}', options.version)
  .replaceAll('${REVISION}', options.revision)
if (catalog.includes('${')) throw new Error('Docker Catalog release metadata has an unresolved token')
await writeFile(join(output, 'docker-catalog-server.yaml'), catalog, { mode: 0o600 })
const catalogDirectory = join(output, 'docker-catalog', 'workflow-mcp')
await mkdir(catalogDirectory, { recursive: true, mode: 0o700 })
await writeFile(join(catalogDirectory, 'server.yaml'), catalog, { mode: 0o600 })
await copyFile(join(root, 'distribution/docker-catalog/tools.json'), join(catalogDirectory, 'tools.json'))
await copyFile(join(root, 'distribution/docker-catalog/readme.md'), join(catalogDirectory, 'readme.md'))
process.stdout.write(`${output}\n`)
