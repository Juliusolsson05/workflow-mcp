import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { build } from 'esbuild'

const root = resolve(import.meta.dirname, '..')
const outputDirectory = resolve(root, 'dist', 'web')
await mkdir(outputDirectory, { recursive: true })
const result = await build({
  entryPoints: { app: resolve(root, 'web', 'src', 'main.ts') },
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  outdir: outputDirectory,
  entryNames: 'assets/[name]-[hash]',
  assetNames: 'assets/[name]-[hash]',
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  metafile: true,
})

const outputEntries = Object.entries(result.metafile.outputs)
const scriptOutput = outputEntries.find(([, details]) => details.entryPoint !== undefined)?.[0]
const styleOutput = outputEntries.find(([path]) => path.endsWith('.css'))?.[0]
if (scriptOutput === undefined || styleOutput === undefined) {
  throw new Error('Browser build did not produce both JavaScript and CSS')
}
const publicPath = path => `/${path.slice(outputDirectory.length + 1).replaceAll('\\', '/')}`
const script = publicPath(resolve(scriptOutput))
const style = publicPath(resolve(styleOutput))
const index = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="dark light">
  <title>Workflow MCP</title>
  <link rel="stylesheet" href="${style}">
</head>
<body>
  <main id="app" aria-live="polite"></main>
  <script type="module" src="${script}"></script>
</body>
</html>
`
await writeFile(resolve(outputDirectory, 'index.html'), index, 'utf8')

const candidates = ['index.html', script.slice(1), style.slice(1)]
const assets = await Promise.all(candidates.map(async path => {
  const bytes = await readFile(resolve(outputDirectory, path))
  return {
    path: `/${path}`,
    size: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    contentType: path.endsWith('.html')
      ? 'text/html; charset=utf-8'
      : path.endsWith('.css')
        ? 'text/css; charset=utf-8'
        : 'text/javascript; charset=utf-8',
  }
}))
// This allow-list is consumed by the daemon instead of treating the image filesystem as a web
// root. A malformed URL can therefore never escape into package sources, tokens, or /data.
await writeFile(
  resolve(outputDirectory, 'asset-manifest.json'),
  `${JSON.stringify({ schemaVersion: 1, assets })}\n`,
  'utf8',
)
