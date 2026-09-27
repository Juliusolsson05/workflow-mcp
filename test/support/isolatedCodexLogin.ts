import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
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
 * WHY API-key logins are REFUSED (round 2 of #63, steering q55/q57): an API key cannot rotate, so
 * it could never cause the logout above — but it never expires either. A run killed after writing
 * its snapshot leaves its root behind (see createIsolatedCodexLogin for why nothing sweeps it), so
 * only credentials with a bounded lifetime may enter this test's temp files.
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
// Measured 2026-09-26: a real Codex ChatGPT access token's exp - iat is exactly 10 days. 31 days
// leaves room for a longer server policy while keeping any residue short-lived.
const MAX_TOKEN_LIFETIME_MS = 31 * 24 * 60 * 60_000

export type IsolatedCodexLoginOptions = {
  now?: () => number
  /**
   * Directory the throwaway root is created in (default: the OS temp dir). Tests pass a synthetic
   * one so nothing they do can touch a real run.
   */
  baseDirectory?: string
  /** Seams for the setup-failure tests only; the real fs calls unless a test injects a failure. */
  writeSnapshot?: (path: string, contents: string) => Promise<void>
  createHome?: (path: string) => Promise<void>
}

/**
 * WHY this helper removes the root it created and never sweeps leftovers (steering q55/q57):
 * two sweep designs were tried and both deleted data they did not own. Name + one-hour mtime
 * removed an unrelated temp directory and a live run's root (a root's mtime does not move when
 * Codex writes inside it). A private parent + pid lease still removed a same-user
 * `root-project-notes` directory whose lease named a dead pid — a location and a liveness hint are
 * not ownership, and nothing on disk can prove it. So there is no sweep.
 *
 * The residue that leaves, stated plainly: a run KILLED before its `finally` (SIGINT, a Vitest
 * worker kill) leaves one 0700 `workflow-live-codex-*` directory holding an access-only snapshot.
 * That token expires on its own (a readable `exp` is required below) and carries no refresh token,
 * and API keys are refused outright, so no non-expiring credential can ever be left behind.
 */
export async function createIsolatedCodexLogin(
  sourceCodexHome: string,
  options: IsolatedCodexLoginOptions = {},
): Promise<IsolatedCodexLogin> {
  const now = options.now ?? Date.now
  const writeSnapshot = options.writeSnapshot ?? ((path, contents) => writeFile(path, contents, { mode: 0o600 }))
  const createHome = options.createHome ?? (path => mkdir(path).then(() => undefined))
  // Parse and validate BEFORE creating anything, so a refused login creates nothing to clean up.
  const snapshot = accessOnlySnapshot(await readSourceLogin(sourceCodexHome), now())

  // mkdtemp creates a fresh, uniquely named 0700 directory owned by us; it is the directory this
  // helper means to remove. Everything below lives inside it.
  //
  // KNOWN RACES (a same-user process acting within them can still misdirect cleanup; the owner
  // decides whether that is in scope — steering q59):
  //   1. mkdtemp -> lstat: a swap of the new root before `created` is recorded makes the helper
  //      adopt the replacement as its root, write the snapshot there, and later remove it, leaving
  //      the real root behind.
  //   2. lstat -> rm inside dispose(): a swap after the identity check is removed anyway.
  // Outside those windows, a root replaced by a DIFFERENT directory is refused, not removed. The
  // identity is dev+inode, which the OS may reuse after the original is deleted, so a delete-then-
  // recreate at the same path can also pass the check.
  //
  // WHY realpath first and an identity check in dispose (round 4 of #63, steering q58): the root
  // was created and later removed through the same pathname. With a symlinked base retargeted in
  // between, `rm` followed the new target and deleted an unrelated same-named directory there,
  // while the real snapshot stayed behind. The base is resolved once, so the root's path holds no
  // symlink, and dispose removes the directory only if it is still the very inode mkdtemp created.
  const base = await realpath(options.baseDirectory ?? tmpdir())
  const root = await mkdtemp(join(base, 'workflow-live-codex-'))
  const created = await lstat(root)
  const dispose = async () => {
    const now = await lstat(root).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (now === null) return
    if (!now.isDirectory() || now.dev !== created.dev || now.ino !== created.ino) {
      // Refuse loudly rather than delete something else. The caller's own snapshot may then remain;
      // it is an expiring access-only token (see above), and the message says where.
      throw new Error(`Refusing to remove ${root}: it is no longer the directory this run created`)
    }
    await rm(root, { recursive: true, force: true })
  }
  const codexHome = join(root, 'codex-home')
  const authenticationFile = join(root, 'auth-snapshot.json')
  try {
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
  if (expiresAt > nowMs + MAX_TOKEN_LIFETIME_MS) {
    // A finite `exp` can still be absurd (1e16 s is ~300 million years) and would make killed-run
    // residue effectively permanent (round 5 of #63). Real ChatGPT access tokens live 10 days.
    throw new Error('Codex live test refuses an access token that claims to live longer than 31 days')
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
    // Finite only (round 4 of #63): `exp: 1e309` parses as Infinity, which is a number and would
    // pass as "expires later" — an unbounded residue if a run is killed.
    // Checked AFTER the seconds-to-ms conversion: `exp: 1e308` is finite but overflows to Infinity.
    const expiresAt = typeof claims.exp === 'number' ? claims.exp * 1_000 : Number.NaN
    return Number.isFinite(expiresAt) ? expiresAt : null
  } catch {
    return null
  }
}
