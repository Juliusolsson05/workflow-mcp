import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { synchronizeIsolatedAuthentication } from '../src/processOwnedProviderHost.js'
import { STALE_ROOT_MS, createIsolatedCodexLogin } from './support/isolatedCodexLogin.js'

// WHY this deterministic test exists for a helper that only live tests use (agent-code#1295): the
// live tier is opt-in and never runs in CI, so the one property that protects the developer's real
// login — the isolated Codex home never receives a refresh token — would otherwise be checked by
// nobody. It drives the REAL package boundary (`synchronizeIsolatedAuthentication`, the function
// every attempt runs) with the helper's output, so it fails if either side regresses.
//
// The source login mirrors the key set of a real ChatGPT-mode `~/.codex/auth.json` (auth_mode,
// OPENAI_API_KEY null, tokens.{id_token,access_token,refresh_token,account_id}, last_refresh), read
// from the owner's machine for SHAPE only; every value is synthetic.

const NOW = Date.parse('2026-09-26T12:00:00.000Z')
const roots: string[] = []
// Each test gets its own parent for the helper's roots, so the "nothing was created" and sweep checks
// cannot see a root that another runner or a real live run put in $TMPDIR (review of #63).
let parent: string

beforeEach(async () => {
  parent = await mkdtemp(join(tmpdir(), 'workflow-live-parent-'))
  roots.push(parent)
})

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

function jwt(expSeconds: number): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${part({ alg: 'none' })}.${part({ exp: expSeconds })}.signature`
}

async function sourceHome(auth: unknown): Promise<{ home: string; serialized: string }> {
  const home = await mkdtemp(join(tmpdir(), 'workflow-live-source-'))
  roots.push(home)
  const serialized = `${JSON.stringify(auth)}\n`
  await writeFile(join(home, 'auth.json'), serialized)
  return { home, serialized }
}

// A refused login must strand nothing: no temp home, no half-written snapshot.
async function isolatedRoots(): Promise<string[]> {
  return (await readdir(parent)).filter(name => name.startsWith('workflow-live-codex-')).sort()
}

const chatgptLogin = (accessToken: string) => ({
  auth_mode: 'chatgpt',
  OPENAI_API_KEY: null,
  tokens: {
    id_token: 'fixture-id-token',
    access_token: accessToken,
    refresh_token: 'fixture-one-time-refresh-token',
    account_id: 'fixture-account',
  },
  last_refresh: '2026-09-26T11:00:00.000Z',
})

describe('isolated Codex login for live tests', () => {
  it('never lets the refresh token reach the isolated home, and leaves the source untouched', async () => {
    const accessToken = jwt(NOW / 1_000 + 3_600)
    const source = await sourceHome(chatgptLogin(accessToken))
    const login = await createIsolatedCodexLogin(source.home, { now: () => NOW, parentDirectory: parent })
    roots.push(dirname(login.codexHome))

    // Exactly what every attempt does before starting Codex (prepareIsolatedCodexAttempt).
    synchronizeIsolatedAuthentication(login.authenticationFile, join(login.codexHome, 'auth.json'))

    const isolated = await readFile(join(login.codexHome, 'auth.json'), 'utf8')
    expect(isolated).not.toContain('fixture-one-time-refresh-token')
    // Exact shape, mirroring Agent Code's CodexWorkflowAuthenticationBroker: the id_token is the
    // bounded access token too, never the source's own id_token (review of #63 found that mutation
    // surviving a partial match).
    expect(JSON.parse(isolated)).toEqual({
      auth_mode: 'chatgptAuthTokens',
      OPENAI_API_KEY: null,
      tokens: { id_token: accessToken, access_token: accessToken, refresh_token: '', account_id: 'fixture-account' },
      last_refresh: new Date(NOW).toISOString(),
    })
    // The snapshot is a sibling temp file, never a path inside the developer's real home.
    expect(relative(source.home, login.authenticationFile).startsWith('..')).toBe(true)
    expect(await readFile(join(source.home, 'auth.json'), 'utf8')).toBe(source.serialized)
    expect((await stat(login.authenticationFile)).mode & 0o077).toBe(0)

    await login.dispose()
    await expect(stat(login.codexHome)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(login.authenticationFile)).rejects.toMatchObject({ code: 'ENOENT' })
    await login.dispose()
  })

  it('passes an API-key login through, since it has no rotating lineage', async () => {
    const source = await sourceHome({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-fixture', tokens: null })
    const login = await createIsolatedCodexLogin(source.home, { now: () => NOW, parentDirectory: parent })
    roots.push(dirname(login.codexHome))
    expect(JSON.parse(await readFile(login.authenticationFile, 'utf8'))).toEqual({
      auth_mode: 'apikey', OPENAI_API_KEY: 'sk-fixture', tokens: null, last_refresh: null,
    })
    await login.dispose()
  })

  it.each([
    ['a near-expiry access token', chatgptLogin(jwt(NOW / 1_000 + 60)), /near expiry/],
    ['a login without an access token', { tokens: { refresh_token: 'fixture-one-time-refresh-token' } }, /access token/],
  ])('refuses %s instead of falling back to the full file', async (_label, auth, message) => {
    const source = await sourceHome(auth)
    const before = await isolatedRoots()
    await expect(createIsolatedCodexLogin(source.home, { now: () => NOW, parentDirectory: parent })).rejects.toThrow(message)
    expect(await isolatedRoots()).toEqual(before)
  })

  it('removes a partially written snapshot when setup fails after the file exists', async () => {
    const source = await sourceHome(chatgptLogin(jwt(NOW / 1_000 + 3_600)))
    const before = await isolatedRoots()
    let createdPath: string | undefined
    await expect(createIsolatedCodexLogin(source.home, {
      now: () => NOW,
      parentDirectory: parent,
      // Half the token reaches disk, then the write fails — the disk-full shape.
      writeSnapshot: async (path, contents) => {
        createdPath = path
        await writeFile(path, contents.slice(0, contents.length / 2), { mode: 0o600 })
        throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
      },
    })).rejects.toMatchObject({ code: 'ENOSPC' })
    expect(createdPath).toBeTypeOf('string')
    await expect(stat(createdPath!)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await isolatedRoots()).toEqual(before)
  })

  it('sweeps roots stranded by a killed run, and leaves a live run\'s root alone', async () => {
    const stale = join(parent, 'workflow-live-codex-killed')
    const live = join(parent, 'workflow-live-codex-running')
    for (const dir of [stale, live]) {
      await mkdir(dir)
      await writeFile(join(dir, 'auth-snapshot.json'), 'fixture bearer bytes')
    }
    const staleTime = new Date(Date.now() - STALE_ROOT_MS - 60_000)
    await utimes(stale, staleTime, staleTime)
    const source = await sourceHome(chatgptLogin(jwt(NOW / 1_000 + 3_600)))
    const login = await createIsolatedCodexLogin(source.home, { now: () => NOW, parentDirectory: parent })
    await expect(stat(stale)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await stat(live)).isDirectory()).toBe(true)
    await login.dispose()
  })

  it('refuses a missing file-backed login without creating anything', async () => {
    const home = await mkdtemp(join(tmpdir(), 'workflow-live-source-'))
    roots.push(home)
    const before = await isolatedRoots()
    await expect(createIsolatedCodexLogin(home, { now: () => NOW, parentDirectory: parent })).rejects.toThrow(/file-backed login.*cli_auth_credentials_store = "file"/)
    expect(await isolatedRoots()).toEqual(before)
  })
})
