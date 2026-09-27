import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A throwaway CODEX_HOME plus an access-only login for opt-in live tests (agent-code#1295).
 *
 * WHY live tests must not hand `CodexAgentProvider` the developer's real `auth.json`:
 * `synchronizeIsolatedAuthentication` COPIES the file, refresh token included, into the isolated
 * home. Codex may then rotate that one-time refresh token inside the temp home. The server marks the
 * old token used, the real `~/.codex/auth.json` still holds it, and the next interactive refresh
 * fails with `refresh_token_reused` — the developer is logged out by running a test. The earlier
 * test also never deleted the temp home, stranding a full ChatGPT login in `$TMPDIR`.
 *
 * WHY an access-only snapshot and not "skip OAuth logins" (Pi's live-test approach): Agent Code's
 * own workflow broker (`src/main/workflows/CodexWorkflowAuthenticationBroker.ts` in agent-code)
 * already feeds production workflow children exactly this shape. Mirroring it keeps the live test
 * exercising the real production credential contract instead of a test-only one, and a child that
 * holds no refresh token cannot rotate anything no matter what Codex decides to do.
 *
 * WHY API-key logins are REFUSED (round 2 of #63, steering q55): an API key cannot rotate, so it
 * could never cause the logout above — but it never expires either. A run killed after writing
 * its snapshot (SIGINT, a Vitest worker kill) leaves the key in $TMPDIR until something removes
 * it, and nothing guarantees another run ever will. A ChatGPT access token left the same way
 * expires on its own. Only credentials with a bounded lifetime enter this test's temp files.
 *
 * WHY there is no fallback to copying the full file when the access token is unusable: that
 * fallback IS the bug. An explicit opt-in run fails loudly with the same instruction the product
 * broker gives (refresh interactive Codex first) rather than silently skipping, because a skipped
 * opt-in run would claim coverage it did not provide.
 */
export type IsolatedCodexLogin = {
  /** Private, empty-at-start CODEX_HOME for the provider under test. */
  codexHome: string
  /** Access-only snapshot to pass as `configurationIsolation.authenticationFile`. */
  authenticationFile: string
  /** Removes the snapshot and the isolated home. Idempotent; call it in `finally`. */
  dispose(): Promise<void>
}

type AuthDocument = {
  OPENAI_API_KEY?: string | null
  tokens?: { access_token?: string; account_id?: string } | null
}

// Same skew as the product broker: a token that expires mid-attempt is as bad as an expired one.
const REFRESH_SKEW_MS = 5 * 60_000

export type IsolatedCodexLoginOptions = {
  now?: () => number
  /**
   * Directory under which the helper creates its OWN private parent (default: the OS temp dir).
   * Tests pass a synthetic one so nothing they do can touch a real run.
   */
  baseDirectory?: string
  /** Seams for the setup-failure tests only; the real fs calls unless a test injects a failure. */
  writeSnapshot?: (path: string, contents: string) => Promise<void>
  createHome?: (path: string) => Promise<void>
}

/** The helper's own parent directory: nothing outside it is ever deleted. */
export const PARENT_NAME = 'workflow-live-codex'
const ROOT_PREFIX = 'root-'
const LEASE_FILE = 'lease.json'

export async function createIsolatedCodexLogin(
  sourceCodexHome: string,
  options: IsolatedCodexLoginOptions = {},
): Promise<IsolatedCodexLogin> {
  const now = options.now ?? Date.now
  const writeSnapshot = options.writeSnapshot ?? ((path, contents) => writeFile(path, contents, { mode: 0o600 }))
  const createHome = options.createHome ?? (path => mkdir(path).then(() => undefined))
  const parent = await ownedParent(options.baseDirectory ?? tmpdir())

  // WHY the sweep runs FIRST, before the source login is even read (round 2 of #63): a killed run
  // strands its snapshot and nothing in the dying process can remove it. When validation came
  // first, a later run whose source login was missing, malformed or near expiry refused before
  // cleaning up, so the residue survived every future attempt.
  await sweepAbandonedRoots(parent)

  // Parse and validate BEFORE creating a root, so a refused login creates nothing.
  const snapshot = accessOnlySnapshot(await readSourceLogin(sourceCodexHome), now())

  const root = await mkdtemp(join(parent, ROOT_PREFIX))
  const dispose = () => rm(root, { recursive: true, force: true })
  const codexHome = join(root, 'codex-home')
  const authenticationFile = join(root, 'auth-snapshot.json')
  try {
    // The lease goes in BEFORE any credential: a root without one holds nothing worth sweeping,
    // so the sweep can leave lease-less roots alone (they may be mid-setup in another process).
    await writeFile(join(root, LEASE_FILE), JSON.stringify({ pid: process.pid }), { mode: 0o600 })
    await createHome(codexHome)
    await writeSnapshot(authenticationFile, `${JSON.stringify(snapshot)}\n`)
  } catch (error) {
    // WHY cleanup here and not only in the caller's `finally` (steering q43): the caller only gets
    // `dispose` if this function RETURNS. A write that creates the file and then fails (disk full,
    // EIO) would otherwise strand a partial access-token file with nobody holding a handle to it.
    await dispose()
    throw error
  }

  return { codexHome, authenticationFile, dispose }
}

/**
 * `<base>/workflow-live-codex`, created 0700 and verified to be a real directory owned by us.
 *
 * WHY a private parent (round 2 of #63, steering q55): the first sweep deleted anything in the
 * shared temp dir whose NAME matched and whose mtime was an hour old. That removed an unrelated
 * user directory and a live run's root (a root's mtime does not move when Codex writes inside it).
 * Everything this helper may ever delete now lives under one directory it owns, and a symlink or a
 * foreign-owned directory at that path is refused rather than trusted.
 */
async function ownedParent(base: string): Promise<string> {
  const parent = join(base, PARENT_NAME)
  await mkdir(parent, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error
  })
  const info = await lstat(parent)
  const uid = process.getuid?.()
  if (!info.isDirectory() || (uid !== undefined && info.uid !== uid)) {
    throw new Error(`Refusing to use ${parent}: not a directory owned by this user`)
  }
  await chmod(parent, 0o700)
  return parent
}

/**
 * Remove roots under the private parent whose lease names a process that no longer exists.
 *
 * Liveness is the lease's pid, never a name or an age: an old root whose owner is alive (a paused
 * debugger, a stalled provider) is kept. A root without a readable lease is kept too — the lease
 * is written before any credential, so such a root holds none. A reused pid only makes us keep a
 * dead root longer; it can never make us delete a live one.
 */
async function sweepAbandonedRoots(parent: string): Promise<void> {
  for (const name of await readdir(parent)) {
    if (!name.startsWith(ROOT_PREFIX)) continue
    const root = join(parent, name)
    let pid: unknown
    try {
      pid = (JSON.parse(await readFile(join(root, LEASE_FILE), 'utf8')) as { pid?: unknown }).pid
    } catch {
      continue
    }
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0 || processIsAlive(pid)) continue
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: it exists but belongs to someone else — alive, keep the root.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

async function readSourceLogin(sourceCodexHome: string): Promise<AuthDocument> {
  let serialized: string
  try {
    serialized = await readFile(join(sourceCodexHome, 'auth.json'), 'utf8')
  } catch (cause) {
    // WHY only the file store: a keyring-backed login has no auth.json, and reading the macOS
    // keychain from a test is more reach than this tier needs. Say so instead of proceeding
    // without authentication and failing later with an opaque provider error.
    throw new Error(
      `Codex live test needs a file-backed login at ${join(sourceCodexHome, 'auth.json')}: set ` +
        '`cli_auth_credentials_store = "file"` in that Codex home\'s config.toml, sign in with `codex login`, ' +
        'then rerun (or point CODEX_HOME at a home that already uses the file store)',
      { cause },
    )
  }
  const value: unknown = JSON.parse(serialized)
  if (typeof value !== 'object' || value === null) throw new Error('Codex auth.json must be a JSON object')
  return value as AuthDocument
}

function accessOnlySnapshot(document: AuthDocument, nowMs: number): unknown {
  if (typeof document.OPENAI_API_KEY === 'string' && document.OPENAI_API_KEY.length > 0) {
    throw new Error(
      'Codex live test refuses API-key logins: a key never expires, and a killed run would leave it in a temp file. ' +
        'Sign in with ChatGPT (`codex login`) in a file-backed Codex home to run it',
    )
  }
  const tokens = document.tokens
  if (!tokens || typeof tokens.access_token !== 'string' || tokens.access_token.length === 0 || !tokens.account_id) {
    throw new Error('Codex live test needs a ChatGPT login with an access token and account id')
  }
  const expiresAt = tokenExpiry(tokens.access_token)
  if (expiresAt === null) {
    // Ambiguity fails closed: a token whose lifetime we cannot read is not known to be bounded.
    throw new Error('Codex live test refuses an access token without a readable expiry')
  }
  if (expiresAt <= nowMs + REFRESH_SKEW_MS) {
    throw new Error(
      'Codex access token is near expiry; run or reopen interactive Codex to refresh it, then rerun the live test',
    )
  }
  return {
    auth_mode: 'chatgptAuthTokens',
    OPENAI_API_KEY: null,
    tokens: {
      id_token: tokens.access_token,
      access_token: tokens.access_token,
      // The whole point: the child never receives the rotating credential.
      refresh_token: '',
      account_id: tokens.account_id,
    },
    last_refresh: new Date(nowMs).toISOString(),
  }
}

/** Expiry in ms from a JWT's `exp`, or null when the token is opaque or has none. */
function tokenExpiry(token: string): number | null {
  const payload = token.split('.')[1]
  if (payload === undefined) return null
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: unknown }
    return typeof claims.exp === 'number' ? claims.exp * 1_000 : null
  } catch {
    return null
  }
}
