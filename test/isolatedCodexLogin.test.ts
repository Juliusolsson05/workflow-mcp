import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { synchronizeIsolatedAuthentication } from '../src/processOwnedProviderHost.js'
import { createIsolatedCodexLogin } from './support/isolatedCodexLogin.js'

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
// Each test gets its own synthetic base directory, so nothing here can touch a real run's roots in
// $TMPDIR (review of #63).
let base: string

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'workflow-live-base-'))
  roots.push(base)
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
  return (await readdir(base)).filter(name => name.startsWith('workflow-live-codex-')).sort()
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
    const login = await createIsolatedCodexLogin(source.home, { now: () => NOW, baseDirectory: base })
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

  // Round 2 of #63 (q55): an API key never expires, so a killed run would leave a usable key in a
  // temp file indefinitely. Refused before anything is created.
  it('refuses an API-key login, creating nothing', async () => {
    const source = await sourceHome({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-fixture', tokens: null })
    await expect(createIsolatedCodexLogin(source.home, { now: () => NOW, baseDirectory: base })).rejects.toThrow(/refuses API-key logins/)
    expect(await isolatedRoots()).toEqual([])
  })

  it.each([
    ['a near-expiry access token', chatgptLogin(jwt(NOW / 1_000 + 60)), /near expiry/],
    ['a login without an access token', { tokens: { refresh_token: 'fixture-one-time-refresh-token' } }, /access token/],
    ['an opaque access token whose expiry cannot be read', chatgptLogin('opaque-token'), /readable expiry/],
  ])('refuses %s instead of falling back to the full file', async (_label, auth, message) => {
    const source = await sourceHome(auth)
    const before = await isolatedRoots()
    await expect(createIsolatedCodexLogin(source.home, { now: () => NOW, baseDirectory: base })).rejects.toThrow(message)
    expect(await isolatedRoots()).toEqual(before)
  })

  it('removes a partially written snapshot when setup fails after the file exists', async () => {
    const source = await sourceHome(chatgptLogin(jwt(NOW / 1_000 + 3_600)))
    const before = await isolatedRoots()
    let createdPath: string | undefined
    await expect(createIsolatedCodexLogin(source.home, {
      now: () => NOW,
      baseDirectory: base,
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

  it('removes the root when creating the isolated home fails', async () => {
    const source = await sourceHome(chatgptLogin(jwt(NOW / 1_000 + 3_600)))
    await expect(createIsolatedCodexLogin(source.home, {
      now: () => NOW,
      baseDirectory: base,
      createHome: async () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }) },
    })).rejects.toMatchObject({ code: 'EIO' })
    expect(await isolatedRoots()).toEqual([])
  })

  // Steering q55/q57: two sweep designs deleted data they did not own — name + mtime, then a private
  // parent + pid lease that still removed a same-user `root-project-notes` with a dead-pid lease.
  // The helper now removes only the root it created. Everything that existed before survives,
  // whatever it is named, however old, whatever lease it carries.
  it('never deletes anything that existed before it ran', async () => {
    const deadPid = Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout)
    const old = new Date(Date.now() - 24 * 60 * 60_000)
    const preexisting = [
      join(base, 'workflow-live-codex', 'root-project-notes'),
      join(base, 'workflow-live-codex-killed-run'),
      join(base, 'workflow-live-codex-unrelated-data'),
    ]
    for (const dir of preexisting) {
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'lease.json'), JSON.stringify({ pid: deadPid }))
      await writeFile(join(dir, 'keep.txt'), 'user data')
      await utimes(dir, old, old)
    }
    const source = await sourceHome(chatgptLogin(jwt(NOW / 1_000 + 3_600)))
    const login = await createIsolatedCodexLogin(source.home, { now: () => NOW, baseDirectory: base })
    await login.dispose()
    // A refused run must not delete them either.
    const empty = await mkdtemp(join(tmpdir(), 'workflow-live-source-'))
    roots.push(empty)
    await expect(createIsolatedCodexLogin(empty, { now: () => NOW, baseDirectory: base })).rejects.toThrow(/file-backed login/)
    for (const dir of preexisting) expect(await readFile(join(dir, 'keep.txt'), 'utf8')).toBe('user data')
    // And its own root is the one thing gone.
    await expect(stat(dirname(login.codexHome))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses a missing file-backed login without creating anything', async () => {
    const home = await mkdtemp(join(tmpdir(), 'workflow-live-source-'))
    roots.push(home)
    const before = await isolatedRoots()
    await expect(createIsolatedCodexLogin(home, { now: () => NOW, baseDirectory: base })).rejects.toThrow(/file-backed login.*cli_auth_credentials_store = "file"/)
    expect(await isolatedRoots()).toEqual(before)
  })
})
