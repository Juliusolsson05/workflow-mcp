import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..', 'src')
const files = []
const walk = async directory => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) await walk(path)
    else if (entry.name.endsWith('.ts')) files.push(path)
  }
}
await walk(root)
for (const file of files) {
  const source = await readFile(file, 'utf8')
  if (/from\s+['"](?:\.\.\/)+src\//.test(source) || /from\s+['"]workflow-mcp\/dist\//.test(source)) {
    throw new Error(`Standalone must import only workflow-mcp public exports: ${file}`)
  }
}
process.stdout.write(`Standalone public-import boundary satisfied for ${files.length} files\n`)
