import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
   * Seam for the setup-failure test only: the real writer unless a test injects one that fails
   * after creating the file. Nothing else about the file system is injectable on purpose.
   */
  writeSnapshot?: (path: string, contents: string) => Promise<void>
}

export async function createIsolatedCodexLogin(
  sourceCodexHome: string,
  options: IsolatedCodexLoginOptions = {},
): Promise<IsolatedCodexLogin> {
  const now = options.now ?? Date.now
  const writeSnapshot = options.writeSnapshot ?? ((path, contents) => writeFile(path, contents, { mode: 0o600 }))
  // Parse and validate BEFORE creating anything, so a refused login strands nothing on disk.
  const snapshot = accessOnlySnapshot(await readSourceLogin(sourceCodexHome), now())

  const root = await mkdtemp(join(tmpdir(), 'workflow-live-codex-'))
  const dispose = () => rm(root, { recursive: true, force: true })
  const codexHome = join(root, 'codex-home')
  const authenticationFile = join(root, 'auth-snapshot.json')
  try {
    // mkdtemp already creates 0700 on POSIX; the explicit chmod documents the requirement and covers
    // platforms whose default differs. The snapshot is still a live bearer token for its lifetime.
    await chmod(root, 0o700)
    await mkdir(codexHome, { mode: 0o700 })
    await writeSnapshot(authenticationFile, `${JSON.stringify(snapshot)}\n`)
  } catch (error) {
    // WHY cleanup here and not only in the caller's `finally` (steering q43): the caller only gets
    // `dispose` if this function RETURNS. A write that creates the file and then fails (disk full,
    // EIO) would otherwise strand a partial access-token file in $TMPDIR with nobody holding a
    // handle to remove it.
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
      `Codex live test needs a file-backed login at ${join(sourceCodexHome, 'auth.json')}`,
      { cause },
    )
  }
  const value: unknown = JSON.parse(serialized)
  if (typeof value !== 'object' || value === null) throw new Error('Codex auth.json must be a JSON object')
  return value as AuthDocument
}

function accessOnlySnapshot(document: AuthDocument, nowMs: number): unknown {
  if (typeof document.OPENAI_API_KEY === 'string' && document.OPENAI_API_KEY.length > 0) {
    // An API key has no rotating lineage, so passing it through cannot log anyone out.
    return { auth_mode: 'apikey', OPENAI_API_KEY: document.OPENAI_API_KEY, tokens: null, last_refresh: null }
  }
  const tokens = document.tokens
  if (!tokens || typeof tokens.access_token !== 'string' || tokens.access_token.length === 0 || !tokens.account_id) {
    throw new Error('Codex live test needs an API key or a ChatGPT login with an access token and account id')
  }
  if (expiresSoon(tokens.access_token, nowMs)) {
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

function expiresSoon(token: string, nowMs: number): boolean {
  const payload = token.split('.')[1]
  if (payload === undefined) return false
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: unknown }
    return typeof claims.exp === 'number' && claims.exp * 1_000 <= nowMs + REFRESH_SKEW_MS
  } catch {
    // Opaque tokens cannot be inspected; the provider reports an auth failure instead of a guess.
    return false
  }
}
