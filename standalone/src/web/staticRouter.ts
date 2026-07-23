import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { resolve } from 'node:path'

import { applySecurityHeaders, sendJson } from '../api/router.js'

type StaticAsset = { body: Buffer; contentType: string; etag: string }

export type StaticWebRouter = {
  handle(request: IncomingMessage, response: ServerResponse): boolean
}

export async function loadStaticWebRouter(enabled: boolean): Promise<StaticWebRouter> {
  if (!enabled) return { handle: () => false }
  // Vitest executes TypeScript from src/, while the image executes compiled JavaScript beside the
  // generated assets in dist/web. Checking these two closed candidates keeps tests realistic
  // without accepting a caller-controlled web root.
  const candidates = [
    resolve(import.meta.dirname, '..', 'web'),
    resolve(import.meta.dirname, '..', '..', 'dist', 'web'),
  ]
  const root = candidates.find(candidate => existsSync(resolve(candidate, 'asset-manifest.json')))
  if (root === undefined) throw new Error('Static web bundle is missing its asset manifest')
  const manifestBytes = await readFile(resolve(root, 'asset-manifest.json'), 'utf8')
  const manifest = parseManifest(manifestBytes)
  const assets = new Map<string, StaticAsset>()
  let totalBytes = 0
  for (const item of manifest.assets) {
    const relative = item.path.slice(1)
    const body = await readFile(resolve(root, relative))
    totalBytes += body.byteLength
    if (totalBytes > 10 * 1024 * 1024) throw new Error('Static web bundle exceeds 10 MiB limit')
    const actual = createHash('sha256').update(body).digest('hex')
    if (actual !== item.sha256 || body.byteLength !== item.size) {
      throw new Error(`Static web asset does not match build manifest: ${item.path}`)
    }
    assets.set(item.path, { body, contentType: item.contentType, etag: `"sha256-${actual}"` })
  }
  return {
    handle(request, response): boolean {
      const path = request.url?.split('?', 1)[0] === '/' ? '/index.html' : request.url?.split('?', 1)[0]
      if (path === undefined || (path !== '/index.html' && !path.startsWith('/assets/'))) return false
      applySecurityHeaders(response)
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.setHeader('allow', 'GET, HEAD')
        sendJson(response, 405, { schemaVersion: 1, error: { code: 'read-only-web' } })
        return true
      }
      const asset = assets.get(path)
      if (asset === undefined) {
        sendJson(response, 404, { schemaVersion: 1, error: { code: 'not-found' } })
        return true
      }
      response.statusCode = 200
      response.setHeader('content-type', asset.contentType)
      response.setHeader('content-length', asset.body.byteLength)
      response.setHeader('etag', asset.etag)
      response.setHeader('cache-control', path === '/index.html'
        ? 'no-store'
        : 'public, max-age=31536000, immutable')
      response.end(request.method === 'HEAD' ? undefined : asset.body)
      return true
    },
  }
}

function parseManifest(value: string): { assets: Array<{ path: string; size: number; sha256: string; contentType: string }> } {
  const parsed = JSON.parse(value) as unknown
  if (!isObject(parsed) || parsed.schemaVersion !== 1 || !Array.isArray(parsed.assets)) {
    throw new Error('Static web asset manifest is invalid')
  }
  const assets = parsed.assets.map(item => {
    if (
      !isObject(item) ||
      typeof item.path !== 'string' ||
      !/^\/(?:index\.html|assets\/[A-Za-z0-9_-]+\.(?:js|css))$/.test(item.path) ||
      typeof item.size !== 'number' || !Number.isSafeInteger(item.size) || item.size < 0 ||
      typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256) ||
      typeof item.contentType !== 'string'
    ) throw new Error('Static web asset manifest entry is invalid')
    return { path: item.path, size: item.size, sha256: item.sha256, contentType: item.contentType }
  })
  return { assets }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
