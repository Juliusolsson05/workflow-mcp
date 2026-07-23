import { readFile, readdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const packageRoot = resolve(import.meta.dirname, '..')
const roots = [resolve(packageRoot, 'src'), resolve(packageRoot, 'web', 'src')]
const files = []
const walk = async directory => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) await walk(path)
    else if (entry.name.endsWith('.ts')) files.push(path)
  }
}
for (const root of roots) await walk(root)
for (const file of files) {
  const source = await readFile(file, 'utf8')
  if (/from\s+['"]workflow-mcp\/dist\//.test(source)) {
    throw new Error(`Standalone must import only workflow-mcp public exports: ${file}`)
  }
  for (const match of source.matchAll(/from\s+['"]((?:\.\.\/)+src\/[^'"]+)['"]/g)) {
    const target = resolve(dirname(file), match[1])
    if (!target.startsWith(resolve(packageRoot, 'src'))) {
      throw new Error(`Standalone reached outside its package boundary: ${file}`)
    }
  }
  if (file.startsWith(resolve(packageRoot, 'web')) && /from\s+['"]workflow-mcp['"]/.test(source)) {
    throw new Error(`Browser code may import workflow-mcp/state but never the Node root: ${file}`)
  }
}
const bundleDirectory = resolve(packageRoot, 'dist', 'web', 'assets')
for (const entry of await readdir(bundleDirectory)) {
  if (!entry.endsWith('.js')) continue
  const bundle = await readFile(resolve(bundleDirectory, entry), 'utf8')
  if (bundle.includes('@openai/codex') || bundle.includes('node:fs') || bundle.includes('@modelcontextprotocol/sdk')) {
    throw new Error(`Browser bundle contains a server-only dependency: ${entry}`)
  }
}
process.stdout.write(`Standalone public-import boundary satisfied for ${files.length} files\n`)
