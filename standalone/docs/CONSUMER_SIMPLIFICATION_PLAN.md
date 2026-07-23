# Consumer Simplification Plan — "Docker as packaging, not prison"

Status: PLAN — approved direction from the product owner (2026-07-23), not yet implemented.
Author basis: four parallel repository surveys (launcher/install machinery, auth/isolation,
MCP surface/approvals, release/distribution) performed against `main` at the
Docker-first-standalone merge (`847857b7`). Every claim below carries file:line evidence from
those surveys so the implementing session does not need to re-derive them.

---

## 1. The product thesis reset

The shipped v0-era posture treats the container as a security boundary protecting the user
from the product. The owner's actual product thesis is:

> The only consumer is a single person running this on their own computer. Docker exists so
> the client needs no host Node.js/Codex/toolchain — **easy installation** — not to isolate
> the product from the user's own machine. The user understands that running workflows runs
> agents; that is the point, not a threat.

Consequence — a hard sorting rule for every existing protection:

- **Visible security** (anything that interrupts the user: an extra command, a token to
  paste, an approval to type, a flag to learn) must justify itself against a realistic
  local-single-user threat **or be removed from the default path**.
- **Invisible security** (anything the user never notices: env scrubbing, deny-read rules,
  Host/Origin checks, volume-identity attestation, atomic upgrade transactions) stays. It
  costs nothing and still catches real mistakes.

Everything removed from the default remains available behind **one** flag: `--hardened`
(§8). Nothing is deleted from the codebase; defaults flip.

### What today costs the user (measured)

Nine distinct commands from zero to a Codex-connected daemon (`README.md:39-72` bootstrap =
7 commands, launcher `install` + `up` = 2 more, `auth login` = 1 more for interactive auth),
plus a per-source `source approve --name=…` for every authored workflow version, plus a
43-char bearer token pasted into the web UI. Observed live on 2026-07-23: the install
ceremony was mis-pasted (zsh `#` comment trap), the approval gate stalled the first real
Codex demo, the missing container login produced an opaque `EPIPE` agent failure, and the
web token paste picked up a line break that surfaced as "API temporarily unavailable".
Every one of those failures was friction-induced, none was an attack.

---

## 2. Target end state (the whole UX)

```
# one command, in the project directory:
curl -fsSL https://github.com/Juliusolsson05/workflow-mcp/releases/latest/download/install.sh | sh

# …or, equivalently, for people who already cloned/downloaded anything:
workflow-mcp install        # host shim, resolves project from cwd
```

After that single command:

- Daemon is up (install runs `up` itself).
- Codex is configured (stanza written, as today).
- **Auth already works**: the installer detected the host's `~/.codex/auth.json` and wired
  it through; no `auth login`, no API-key file, no ACLs. Fallbacks in order:
  `--api-key-file` if given → host `~/.codex/auth.json` if present → print one line telling
  the user to either run `codex login` on the host or `workflow-mcp auth login`.
- **Authoring works**: Codex can author + immediately run workflows through the MCP. No
  approval step exists in the default mode.
- **Web UI works**: `http://127.0.0.1:7331` opens straight into the dashboard. No token.
- `workflow-mcp <verb>` works from anywhere inside the project (PATH shim), so docs never
  again print `~/…/.workflow-mcp/workflow-mcp-docker`.
- `workflow-mcp mcp-proxy` auto-starts the daemon if it is down, so "restart Codex" is the
  only lifecycle action a user ever performs.

The hardened profile (`install --hardened`) restores exactly today's shipped behavior.

---

## 3. Workstream A — authoring by default, approvals removed from the default path

### 3.1 Facts (from the MCP/approvals survey)

- Default sourceMode is set in exactly two places: `standalone/src/config/loadConfig.ts:37-41`
  (`?? 'read-only'`) and `standalone/compose.yaml:14` (`WORKFLOW_MCP_SOURCE_MODE: read-only`),
  overlaid by `compose.authoring.yaml`.
- Everything keyed on the mode: sandbox fs mode (`standalone/src/daemon/application.ts:79`),
  inline-authoring capability (`:77`, enforced `src/workflowService.ts:1410-1414`), startup
  approval snapshot vs empty set (`application.ts:57-59`), provider attempt profile env and
  policy fingerprint (`application.ts:139`, `:221`), MCP instructions + tool descriptions
  (`src/workflowMcp.ts:27-42`, `:101-108`; selected at `standalone/src/cli/main.ts:392` and
  `standalone/src/daemon/lifecycle.ts:106`), API capabilities/mountMode
  (`standalone/src/api/router.ts:52,58`), TUI display (`standalone/src/tui/application.ts:308,324`).
- The approval chain: inline script → `persistInlineWorkflow` writes
  `.claude/workflows/<name>.js` (`src/workflowAuthoring.ts:61-123`) → `#authorizeWorkflowSource`
  (`src/workflowService.ts:1518`, `:1734-1757`) → daemon callback
  (`standalone/src/daemon/application.ts:73-76`) → durable store
  (`standalone/src/daemon/sourceApprovals.ts:68-108`) → refusal until
  `source approve --name=…` (`standalone/src/cli/main.ts:366-374`,
  `standalone/src/admin/server.ts:124-140`).
- Authorship provenance (inline-authored vs appeared-on-disk) is **not recorded** anywhere;
  by authorization time the two are indistinguishable (`src/workflowService.ts:142-149`,
  `:1408-1418`).

### 3.2 Decision

Default mode = `authoring`, and in default mode the authorization callback returns **true
unconditionally** — no approval store consultation, no startup snapshot, no gate. The owner
was explicit: the user launched the MCP against their own project; requiring them to
re-authorize code their own agent wrote is friction without a threat.

We deliberately do NOT build the provenance-tracking auto-approve middle ground (Option 1/2
in the survey). It is more code to build a weaker version of the hardened mode, and its
only beneficiary is a threat model (hostile files planted in the user's own checkout) that
the default explicitly does not serve. `--hardened` restores the full current two-model
system (startup snapshot for read-only, durable per-hash approvals for authoring), so the
machinery stays alive and tested.

### 3.3 Changes

1. `standalone/src/config/loadConfig.ts:38` — default `'authoring'`; add
   `WORKFLOW_MCP_APPROVAL_MODE` (`'none'` default | `'required'`), hardened sets `required`.
2. `standalone/src/daemon/application.ts:57-76` — when approvals are `none`, wire
   `authorizeWorkflowSource: () => true`; keep both existing models under `required`.
   Rewrite the thick WHY comment to document the *product* decision and the hardened
   escape hatch, per the sorting rule in §1.
3. `standalone/compose.yaml:14` — `WORKFLOW_MCP_SOURCE_MODE: ${WORKFLOW_MCP_SOURCE_MODE:-authoring}`;
   fold the writable workflows-dir bind (today's `compose.authoring.yaml:5-11`) into the
   default composition; `--hardened` swaps in the read-only arrangement instead.
   NOTE the launcher currently gates the authoring overlay behind a UID-10001 durability
   probe (`standalone/install/workflow-mcp-docker:455-490`); with authoring as default this
   probe runs on every install. Keep the probe (it is invisible when it passes) but change
   its failure from fail-closed refusal to a fail-open downgrade-with-warning: fall back to
   read-only mode and print the one ACL line to fix it. Native-Linux umask/ACL reality was
   the root cause of the 2026-07-23 CI saga (see `project_bind_mount_native_vs_desktop`
   memory and `launcher-smoke.sh` fixture WHY comment) — a Mac user must never be blocked
   by it.
4. **Workspace goes read-write by default.** `standalone/compose.yaml:28` drops
   `read_only: true` on the project bind (container root fs stays read-only). Rationale:
   the product's real use ("turn this HTML file into a real project") requires agents to
   edit project files; agent-code grants exactly this on the host with zero isolation. The
   sandbox mode is already `workspace-write` in authoring (`application.ts:79`). The
   project `.codex` mask overlay (`compose.project-codex-mask.yaml`) STAYS — it is
   invisible and blocks config/MCP-server injection into the inner Codex
   (`src/codexProvider.ts:186-195`, `src/processOwnedProviderHost.ts:331`); with a
   writable workspace it additionally prevents agents from *writing* project `.codex`.
   `--hardened` restores the read-only bind + narrow overlay.
5. MCP instruction/tool text: merge the two instruction variants
   (`src/workflowMcp.ts:15-42`) into: authoring default text without any approval language;
   hardened/read-only keeps the current gated text. Update `workflow_run` description
   branches (`:101-108`) and `authoring-disabled` message (`src/workflowService.ts:1412-1413`).
6. Registry/Catalog STDIO profiles (`standalone/distribution/*`) are **unchanged** — they
   are separate launch modes with their own metadata, and `validate-distribution.mjs:33-51`
   continues to enforce their stricter contract. This plan changes the Compose default only.

### 3.4 Ripples to catch

- Policy fingerprint includes sourceMode and maskedness (`application.ts:221`): existing
  installs that restart into a new default flip fingerprints. Fingerprint is derived, not
  stored identity — verify crash-replay/recovery tests
  (`test/processOwnedProviderHost.system.test.ts`) tolerate the transition; upgrades go
  through `upgrade` which quiesces first (`workflow-mcp-docker:641-727`).
- `standalone/scripts/container-smoke.sh` policy probes assert read-only-workspace
  behavior; they gain a default-profile variant (writable workspace, mask still enforced,
  `/data` + `/run/secrets` deny-read still enforced) alongside the hardened variant.
- `launcher-smoke.sh` loses its `source approve` leg in the default flow and gains a
  hardened-flagged leg exercising today's full sequence.

---

## 4. Workstream B — inherit host Codex authentication

### 4.1 Facts (from the auth survey)

- The container runs Codex out of `/data/codex-home` (`standalone/docker/Dockerfile:126,132-133`;
  broker `standalone/src/daemon/auth.ts:39,124-125`; provider isolation
  `standalone/src/daemon/application.ts:129`). Interactive login writes a rotating
  `auth.json` there; API-key mode forwards only a file path
  (`application.ts:160-202`, `compose.auth-api-key.yaml`, reopened per-process by
  `standalone/docker/codex-isolated.sh:32-43`).
- **The SDK already ships the required mechanism**: `configurationIsolation.authenticationFile`
  seeds the writable isolated home from a source file, preserves newer isolated state when
  rotation happens, and treats source-file deletion as durable logout
  (`README.md:261-266`, `test/processOwnedProviderHost.system.test.ts:116-206`). The
  standalone daemon simply never passes it (`application.ts:128-133`).
- Read-only-mount refresh problem: Codex rewrites `auth.json` on token refresh; both the
  SDK and agent-code solve it by never letting the child write the source — agent-code
  additionally snapshots access-only credentials (`refresh_token: ''`), single-flight
  refreshes before attempts, and fails closed near expiry
  (`agent-code CodexWorkflowAuthenticationBroker.ts:48-131`, `createWorkflowService.ts:33-41`).
- `operator-check-required` is a UI placeholder computed at
  `standalone/src/api/router.ts:64` meaning "poll surface won't run Codex to check".
- Credential confidentiality is enforced independently of auth mode: env scrub list
  (`standalone/docker/codex-policy-launcher.mjs:9-19`), `/data` + `/run/secrets` +
  `/proc` deny-read (`standalone/docker/codex-requirements.toml:18-20,30-35,42-45`),
  probe-time proof (`codex-policy-launcher.mjs:228-238`).

### 4.2 Decision

Default auth = host inheritance. Install auto-detects `~/.codex/auth.json` (respecting
`$CODEX_HOME`); if present, mounts it **read-only** and passes it as the SDK's
`authenticationFile`. Rotation happens container-side in `/data/codex-home`; the host file
is never written. Explicit `--api-key-file` still wins when given. If neither exists,
install completes and prints exactly one actionable line.

We do NOT port agent-code's access-only-snapshot broker in v1 of this change. The SDK's
seed-and-preserve semantics are sufficient for a single-user machine; the snapshot broker
is a refinement (protects the host's refresh lineage from concurrent rotation races) that
can follow if real users report host/container login races.

### 4.3 Changes

1. New overlay `standalone/compose.auth-host-codex.yaml`: bind
   `${WORKFLOW_MCP_HOST_CODEX_AUTH}` → `/run/workflow-mcp-host-auth/auth.json`
   `read_only: true`, env `WORKFLOW_MCP_CODEX_AUTH_FILE=<that path>`.
2. `standalone/src/daemon/application.ts:128-133` — pass
   `authenticationFile: environment.WORKFLOW_MCP_CODEX_AUTH_FILE` into
   `configurationIsolation` when set.
3. Broker third mode (`standalone/src/daemon/auth.ts`): parallel the existing
   `#apiKeySecret` disables (`:70-73,89-92`) — `login`/`logout` refuse with "auth is
   inherited from the host; run codex login/logout on the host"; `status()` validates the
   mounted file (shape + expiry read, no Codex spawn). Thread a `hostCodexAuth` flag
   through `standalone/src/daemon/lifecycle.ts:32-35,69,111-116`; API `authentication.mode`
   gains `'host-codex'` with status `'configured'` (`standalone/src/api/router.ts:60-64`,
   type `standalone/src/client/apiClient.ts:147`).
4. Launcher: install-time detection (host side): resolve `$CODEX_HOME ?? ~/.codex` /
   `auth.json`, record `hostCodexAuth: true` + the path in `instance.json`
   (`src/instance/record.ts:7-21` schema bump), select the overlay in `compose()`
   (`standalone/install/workflow-mcp-docker:293-307`) exactly like the api-key overlay.
   Re-validate path at every `up` like `require_runtime_api_key` (`:280-291`) — but
   missing host auth downgrades to interactive mode with a warning, never refuses `up`.
5. Confidentiality follow-through (invisible, keep): add `WORKFLOW_MCP_CODEX_AUTH_FILE` to
   the env scrub list (`codex-policy-launcher.mjs:9-19`) and the mounted path to the
   probe's deny-read set (`:228-238` alongside the `configuredCredential` append); doctor
   gains a `codex-auth-readable` pathCheck (`standalone/src/daemon/health.ts:258-276`).
6. Docs: delete the `setfacl` ceremony from the default path (`README.md:143-151` moves
   under hardened/API-key); README's "host Codex home is never mounted" (`:138`) is
   rewritten to describe the read-only seed + container-side rotation honestly.

---

## 5. Workstream C — tokenless read-only web UI

### 5.1 Facts

- Web API auth = bearer token per request (`standalone/src/api/router.ts:32-36`), token
  minted into the volume, surfaced via `token --purpose=web` which refuses non-TTY without
  `--force` (`launcher-smoke.sh` exercised this). Frontend stores the pasted token
  (`standalone/web/src/main.ts:40-57`). A pasted line-break makes browser `fetch` throw and
  the UI misreports it as "API temporarily unavailable"
  (`standalone/src/client/apiClient.ts:282-294`; reproduced live 2026-07-23).
- Already-invisible protections that stay: loopback publish only (`compose.web.yaml`),
  Host allowlist (`standalone/src/daemon/lifecycle.ts:47-49`,
  `standalone/src/api/router.ts:221`), Origin check (`router.ts:28-31`), GET-only
  (`:37-40`), CSP/security headers (`router.ts:208-217`), no mutation routes at all
  (`capabilities.browserMutations: false`), Engine ≥ 28.3.3 floor for the loopback-publish
  bug (README `:219-222` — keep; it gates on modern Docker, not on the user).

### 5.2 Decision

Drop the bearer token from the web API **by default**. DNS-rebinding is already defeated by
the Host allowlist (a rebound hostname arrives with the attacker's Host header, which fails
`validLocalHost`), and cross-site fetch by the Origin check; both are invisible. The token
protected against other local processes reading run transcripts — on a single-user machine
that is the user reading their own data. `--hardened` keeps token auth. The MCP bearer
token (`tokens.mcp`) is untouched: it is machine-wired through the proxy, invisible, and
keeps arbitrary local processes from *driving* runs through the HTTP MCP endpoint.

### 5.3 Changes

1. `standalone/src/api/router.ts:32-36` — skip `bearerMatches` when the daemon runs with
   `WORKFLOW_MCP_WEB_AUTH=none` (default when web enabled and not hardened); keep
   Host/Origin/GET/headers unconditionally.
2. `standalone/web/src/main.ts` — when `/api/v1/instance` answers without auth, skip the
   token screen entirely and mount the dashboard. Keep the token form only for hardened
   daemons (401 → show form). Fix the misclassification while here: strip all whitespace
   from pasted tokens and surface invalid-character input as its own message instead of
   transport-unavailable (`apiClient.ts:282-294` classification stands; the *input* is
   sanitized).
3. Launcher `token --purpose=web` prints a notice in default mode ("web UI runs without a
   token on this instance").
4. Web UI can then be enabled by default at install (`--web-port` default 7331, `--no-web`
   to opt out) — it is now zero-interaction. Keep the Engine floor: install without web
   when the engine is old, with a one-line upgrade hint, never a refusal of the whole install.

---

## 6. Workstream D — one-command install

### 6.1 Facts (from the release/distribution survey)

- Image publishes to `docker.io/juliusolsson05/workflow-mcp` (`container-release.yml:20`),
  immutable `:X.Y.Z` first (`:589-607`), then `:X.Y` and `:latest` (`:707-718`);
  multi-arch, cosign-signed, SBOM/provenance-attested. **No release exists yet**; ten
  external prerequisites are open (`RELEASE_PREREQUISITES.md:6-38` — Docker Hub repo +
  immutability rule + token, GitHub immutable releases, tag ruleset, two protected
  environments + admin-read PAT, private-vuln-reporting toggle, two owner attestation
  variables, platform qualification evidence).
- The install tar.gz is the only artifact carrying the host launcher; the image never runs
  install (`entrypoint.sh:7-46`; verdict section of the launcher survey). An in-container
  `setup` verb cannot drive the host daemon without the Docker socket and cannot know the
  host-canonical project path that `hashProjectIdentity` (`src/instance/record.ts:127-131`)
  and the Codex stanza must encode.
- Nothing in the pipeline constrains *how* a user obtains/verifies the bundle — the
  ceremony is documentation-level (`README.md:73-76` states the piping-to-shell principle
  as a choice).
- No npm surface exists or is planned anywhere.

### 6.2 Decision

The one command is a **host-side bootstrap script shipped as a release asset** (and
mirrored at a stable URL):

```
curl -fsSL https://github.com/Juliusolsson05/workflow-mcp/releases/latest/download/install.sh | sh
```

`install.sh` does, silently: preflight Docker; `docker pull` the pinned image **by digest**
(the script is generated per-release with the digest baked in, so the mutable
`latest/download` URL still yields an integrity-pinned install); `docker run --rm
-v <tmp>:/out IMAGE bundle-render` to materialize the verified bundle
(`entrypoint.sh:8-14`, `build-install-bundle.mjs:46-89` — already fully supported); run
`bundle/workflow-mcp-docker install "$PWD"` with host-auth auto-detection (§4) and web
default (§5); `up`; install the PATH shim; print three lines: daemon ready, web URL,
"restart Codex in this directory". The gh-attestation ceremony moves to
`SECURITY.md`/hardened docs as the *optional* high-assurance path — the pipeline keeps
producing all attestations unchanged.

Supporting changes:

- **PATH shim**: `install.sh` links `~/.local/bin/workflow-mcp` (fallback: prints the
  alias line) to a tiny resolver that walks up from `$PWD` to the nearest `.workflow-mcp/`
  and execs the project launcher (the launcher already self-resolves its project from its
  own location, `workflow-mcp-docker:191-201` — the shim only finds the right launcher).
- **Auto-up**: `mcp-proxy` verb checks daemon liveness and runs the `up` sequence first
  when down (`workflow-mcp-docker:986` gains the same create/attest/up prelude). Codex
  connecting is then sufficient to start everything.
- npx wrapper: explicitly deferred. It adds a Node-on-host requirement the thesis rejects,
  for no capability curl-pipe doesn't already give.

### 6.3 Release-prerequisite work (external, unchanged in shape)

The ten items in `RELEASE_PREREQUISITES.md` still gate the first tag. None are affected by
this plan except: release asset list gains `install.sh` (generated in
`container-release.yml:480-531` asset step, digest-pinned, attested like the rest), and
`release-smoke` (`:720-777`) gains an `install.sh`-path smoke replacing the manual
bootstrap it currently replays. Cosign identity pinning to the workflow filename
(`container-release.yml:211,316,511,759`) — do not rename the workflow file.

---

## 7. Workstream E — MCP authoring guidance for constrained modes

Read-only instances currently tell the client only "authoring disabled"
(`src/workflowMcp.ts:31-37`), which forced live Codex to reverse-engineer file formats and
web-search the DSL (observed 2026-07-23). With authoring default this mostly evaporates,
but the hardened/read-only instructions must still carry the full authoring handbook with
"write this file on the host, then restart" instead of a dead end. Same text source as the
authoring instructions (`:15-25`), different delivery clause.

---

## 8. `--hardened` — one flag, today's product

`install --hardened` records `hardened: true` in `instance.json` and restores, together:
read-only sourceMode + startup-snapshot/approval-store gating (§3), isolated container
auth only (§4), token-gated web (§5), read-only workspace bind + narrow authoring overlay,
and the documented gh-verified bootstrap as the supported install path. Existing
protections that never left (all modes): non-root fixed UID, cap-drop, no-new-privileges,
read-only root fs, no Docker socket, resource limits, inner Codex sandbox + policy probe,
env scrubbing, `/data`+`/run/secrets` deny-read, `.codex` mask, volume identity
attestation, transactional upgrades, instance-record verification, terminal-safe path
handling. The hardened flag is a *profile*, not scattered flags — one bit in the instance
record that every mode-branch reads.

---

## 9. Delivery order

| PR | Content | Depends on |
|----|---------|-----------|
| 1 | §3 authoring default + approval removal + writable workspace + instruction text + smoke updates | — |
| 2 | §4 host Codex auth (overlay, SDK option, broker mode, scrub/deny/doctor, launcher detection) | — (parallel with 1) |
| 3 | §5 tokenless web + web-by-default + paste-bug fix | 1 (profile bit) |
| 4 | §8 `--hardened` profile consolidation (turn PR1-3's mode switches into one recorded bit) | 1–3 |
| 5 | §6 `install.sh` + PATH shim + auto-up + README rewrite around the one-liner | 1–4 |
| 6 | Release: prerequisites checklist execution + `install.sh` in pipeline + release-smoke update | 5 + external setup |

Each PR keeps `container-smoke.sh` and `launcher-smoke.sh` green by updating their
default-profile expectations in the same PR (the CI contract job list is in
`.github/workflows/container-ci.yml:84-107`). PR1 and PR2 are independent and can land in
either order; everything else is sequential.

## 10. Risks and their answers

- **Existing installs flip behavior on upgrade.** Solved through the record encoding rather
  than an upgrade flag: every record written by this release carries an explicit
  `hardened: true|false`, so a record where the field is ABSENT is by construction from a
  pre-profile release — and the launchers map that absence to hardened, preserving the
  installed posture across upgrades forever. Adopting the relaxed defaults is an explicit
  `uninstall` (data preserved) + `install --adopt-instance=<id>`. Upgrade staging/rollback
  also treats the two new overlay files as optional-when-absent so a pre-profile bundle can
  actually reach this release.
- **Writable workspace + agent mistakes.** That is agent-code parity and the accepted
  product trade; the `.codex` mask and `/data` denials still stand, and every run's diffs
  are ordinary project-file edits the user reviews in git like any agent edit.
- **Host auth file races container rotation.** SDK preserves newer isolated state and
  treats source deletion as logout (survey §2); if real-world races appear, adopt
  agent-code's access-only snapshot broker as the follow-up.
- **Tokenless web on a multi-user machine.** Documented limitation; hardened restores the
  token. Host/Origin checks still block everything cross-origin/cross-host.
- **curl-pipe install offends the old principle.** The principle moves to the hardened
  docs; the pipeline's attestations still exist for anyone who wants to verify, and the
  script itself is digest-pinned per release.
