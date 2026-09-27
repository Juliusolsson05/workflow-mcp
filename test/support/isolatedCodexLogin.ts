import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
 * WHY this helper deletes ONLY the root it created, and never sweeps leftovers (steering q55/q57):
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

  // mkdtemp creates a fresh, uniquely named 0700 directory owned by us — the only directory this
  // helper will ever remove. Everything below lives inside it.
  const root = await mkdtemp(join(options.baseDirectory ?? tmpdir(), 'workflow-live-codex-'))
  const dispose = () => rm(root, { recursive: true, force: true })
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
