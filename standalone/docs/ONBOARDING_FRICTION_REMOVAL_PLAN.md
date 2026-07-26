# Onboarding Friction Removal — plan (v0.1.4)

Status: PLAN, REVISED AFTER REVIEW. This file is the first commit on the branch; the full
implementation lands on top of it in the same PR. **No implementation is included yet — plan only.**

> **§0 below supersedes any conflicting text further down.** The original analysis (§1–§8) was
> confirmed by a 4-agent review (2 Claude, 2 Codex) for its *diagnoses*, but the review found real
> factual errors and unsafe proposals in the *fixes* and threat-model framing. §0 records that
> outcome and the corrected direction. Read §0 first; treat §1–§8 as the original draft it corrects.

---

## 0. Review outcome & corrected direction (authoritative)

Four independent reviewers verified this plan against source before implementation. Verdict:

- **Diagnoses of the failures: CONFIRMED.** Auth inheritance works; the pre-first-run status
  misreport is real; git-trust independently blocks non-git projects; the identity gates strand a
  single user; doctor's top-line stays green. All citations trace (with the nits in §0.3).
- **Fixes & framing: NEEDS REWORK.** Both Codex reviewers returned "needs rework / not sound as
  written." The plan over-relaxed **agent containment** (a real boundary) while trying to relax
  **operator-identity ceremony** (safe to relax). Corrected below.

### 0.1 The reframe was too broad — trusted operator ≠ trusted agent

The original §1 premise ("own project, no adversary") conflates the *operator* (trusted) with the
*agent* (a semi-trusted, prompt-injectable LLM). A developer routinely feeds the agent cloned repos,
PR branches, dependency code, issue text, and fetched web content — any of which can prompt-inject
it. The repo's accepted architecture already treats model commands as untrusted **even for a single
operator**: ADR `standalone/docs/adr/0001-runtime-topology.md:12,20` (mode 0600 "is not isolation";
the managed Codex sandbox is the boundary), threat-model summary
`docs/DOCKER_FIRST_CODEX_MCP_IMPLEMENTATION_PLAN.md:2316`, and the prior
`CONSUMER_SIMPLIFICATION_PLAN.md:134` deliberately retained the `.codex` mask for injection/write
protection.

**Corrected principle:** local-first relaxes **operator & installation identity ceremony**. It does
**not** relax **agent containment**. Anything that widens what the agent can read, write, or reach
stays behind an explicit, separately threat-modeled opt-in — never the default.

### 0.2 Two tranches (this is the real scope change)

**TRANCHE A — v0.1.4, safe to implement now** (identity ceremony + honesty + admission):

- **A1 (auth status honesty):** seed the isolated home **at daemon startup only**, then let
  `status` read it. **Do NOT** seed from `status()` and **do NOT** drop the active-runs guard for a
  path that can mutate auth state (kills the A1+A5+A7 race the reviewers flagged, `auth.ts:18,162`).
  The seed must be a **single-writer** design — startup seeds once; the provider's mtime-guarded
  sync (`processOwnedProviderHost.ts:419`) remains the only in-run writer.
- **I1 (git-trust):** `skipGitRepoCheck` — but **profile-gated**, threaded from the recorded profile
  through provider construction and process isolation (`codexProvider.ts:558`, `application.ts:174`),
  so `--hardened` and non-standalone consumers keep `false`. Safe (removes only the git-root
  prerequisite, not the sandbox), but not "one line."
- **Status/doctor consistency:** `doctor`'s `provider-authentication` check exists at the CLI level
  (`main.ts:78`), not in `health.ts` — so N1 is a **severity/consistency** fix, not "add a check":
  make the top-line reflect it (today `ok = every status !== 'fail'`, `health.ts:202`, so a `warn`
  stays green), fix the dangling `health.ts:150` comment, and fix the web `/api/v1/instance`
  `configured`-without-probe report (`router.ts:65-71`, which is mode-scoped, not unconditional).
- **Bootstrap resume + PowerShell parity:** make `install.sh` idempotent for a *valid-but-unhealthy*
  install (not just "no instance.json"), auth-aware final message; **every launcher change must be
  mirrored in `workflow-mcp-docker.ps1`** (auth auto-up, identity gates) — the original plan ignored
  Windows entirely.
- **Identity ceremony:** demote **same-daemon** context rename and path-casing to warn-and-reattach,
  and always allow `uninstall`. **Cross-daemon** movement (Docker Desktop reset / colima) is NOT a
  warn-and-continue — volumes are daemon-local and labels are copyable, so it needs an explicit
  backup/restore/import flow (Tranche B).
- **Error-message + resume UX:** turn `.codex` exit 77 and image-mismatch into clear, actionable
  messages. **Keep the `.codex` mask attached** (see 0.3 I2).
- **Decision, not code:** resolve the **full-project-write contradiction** (0.3, missed blocker).

**TRANCHE B — deferred to separate, threat-modeled PRs** (each widens the agent's reach or moves
data across trust boundaries):

- Network egress (I3), extra writable dirs (I4), Bubblewrap fallback (I5, likely never — see 0.3),
  cross-daemon reattach/migration (N2/N8 migration half), direct API-key persistence (A4 storage
  half), and removing the `.codex` mask (I2). Per-command checksum removal (N7) stays advisory —
  keep it unless latency is measured.

### 0.3 Factual corrections to §1–§8 (verified against source)

- **I5 Bubblewrap — REFUTE the fallback.** bwrap is the *actual* enforcement of `deny_read`/network/
  write against same-UID descendants, not a PID-reaping nicety; the outer container runs
  `seccomp=unconfined`+`apparmor=unconfined` (`compose.yaml:48`) *specifically* so bwrap can install
  the inner boundary. "Degrade gracefully" would pair an unconfined outer container with same-UID
  credential access — do not. Also factually: `policy-probe` runs in `doctor` (`health.ts:103`),
  **not at startup**; and `attemptContainment: 'codex-bwrap-pid-v1'` (`application.ts:186`) is
  declared from file-hash availability, so it is a **false attestation** that does not prove bwrap is
  effective — worth fixing separately.
- **I2 `.codex` mask — rationale was false.** `--ignore-user-config` ignores only
  `$CODEX_HOME/config.toml`; the project `.codex` **is** read (its layer is disabled via the
  trust-less isolated config), so "not even read" is wrong. Exit 77 already prints an explicit reason
  (`codex-isolated.sh:21`) — it is a UX defect, not opaque. **Keep the mask**; only improve the error.
- **N1 — check exists.** `provider-authentication` is appended by the CLI (`main.ts:78`); `health.ts`
  has none. Reframe as severity/consistency (above), not "doctor has no auth check."
- **A3 — credential copy is unsafe.** `.workflow-mcp` is under `/workspace` (agent-visible, same UID,
  not in the deny list `codex-requirements.toml:42`); with network it is exfiltratable. Auto-`setfacl`
  durably grants UID 10001 the host credential. Use a **private broker / named-volume import**, never
  a copy under the workspace.
- **A1/A5/A7 conflict.** Copying the host seed creates two consumers of one rotating refresh token;
  documentation can't fix that (`processOwnedProviderHost.ts:419`). A5's acceptance must be
  **deterministic refresh-order tests**, not "documented guidance." Startup-only seeding fixes the
  status bug; `status` must not mutate auth state, and the exclusive/active-runs guard stays for any
  mutating path.
- **§2b ordering — imprecise.** The seed is copied **before** the provider fork
  (`processOwnedProviderHost.ts:146,358`); the git-root gate precedes the model request; and
  `codex login status` only reads **local** storage (no remote call). So the non-git run proves
  seeding + git-trust independence, **not** that a remote auth call succeeded first. The git run
  separately proves the credential was usable. Independence conclusion stands; the "auth succeeds
  then git-trust kills" phrasing is corrected to "seeding precedes an independent git-trust refusal."
- Minor citation fixes: `/data` is denied by per-profile fs entries, not global `deny_read`
  (`codex-requirements.toml`); `codexProvider.ts:244` blocks *replay*, not execution; launcher `:393`
  points at `setfacl`, not `auth login`.

### 0.4 Missed blockers surfaced by review (add to catalog)

- **HEADLINE — full-project writes are denied.** Default requests `workspace-write`, but the launcher
  forces the `workflow_mcp_authoring` profile that opens writes only to `.claude/workflows`
  (`codex-requirements.toml:22`), and the policy self-test *requires* all other project writes to
  fail (`codex-policy-launcher.mjs:301`). This contradicts the README/compose claim that editing the
  user's project is the product (`compose.yaml:33`, `README.md:55`). **After auth+git are fixed, a
  workflow asked to edit project files still fails.** The plan must decide: workflow-authoring-only,
  or genuinely project-authoring (and then align permissions, UI, recovery, docs). This is arguably
  the biggest functional gap and the original draft missed it.
- **`allowMutableSandbox: false`** disables automatic restart recovery (`application.ts:93`) — a real
  usage hole to surface in MCP/TUI/web/docs.
- **`concurrency: 1`** default caps a multi-agent product at one provider turn (`compose.yaml:21`) —
  expose as a recorded option / size from Docker resources.
- **`hostCodexAuth: false` is sticky** — if host auth was absent at install, a later host login does
  not enable inheritance (`record.ts:20`); needs a re-detect path.
- **Verification plan is far too small** — must add POSIX/PowerShell parity, credential
  invalid/expired/absent/concurrent-refresh, partial/unhealthy-install resume, bwrap-unavailable,
  hardened git behavior, and web/TUI auth truthfulness. Commit the experiment harness into the branch
  (`standalone/scripts/`), not the session scratchpad.

### 0.5 Corrected priority (supersedes §3)

1. **Auth status honesty** via startup-only single-writer seed (A1, corrected).
2. **Profile-gated `skipGitRepoCheck`** (I1, corrected — not one line).
3. **Resolve the full-project-write contradiction** (missed headline blocker) — decision first.
4. **Doctor/web status consistency** (N1, corrected) + clearer `.codex`/image-mismatch errors.
5. **Bootstrap idempotent resume + PowerShell parity + same-daemon identity reattach**; `uninstall`
   always proceeds.

Everything that widens agent reach (network, writable dirs, bwrap fallback, cross-daemon, key
persistence, mask removal) → **Tranche B**, separately threat-modeled. Overall review verdict:
**implement Tranche A with these corrections; do not implement §1–§8 as originally written.**

---

Origin: a real onboarding attempt (`html-test`) where a logged-in ChatGPT/Codex user could not run
a single workflow. Debugging surfaced a pattern much larger than one bug: workflow-mcp is armored
against a **multi-tenant, untrusted-operator** threat model, but it actually ships as a **single
developer running it on their own machine, against their own project, with their own Codex login**.
Almost every hard gate below defends a threat that does not exist in that deployment, and several of
them *strand the legitimate user with no in-product recovery*.

This plan is evidence-first. Every claim carries a `file:line` citation, and the two load-bearing
behaviors (auth inheritance works; non-git projects are refused) were **proven empirically in
throwaway installs**, not reasoned about. The experiment harness is preserved (§7) so the fixes can
be validated the same way.

---

## 1. The threat-model reframe (the whole point)

The product's realistic deployment has these properties:

- **One operator.** The person installing is the person using it and owns the machine.
- **Own project.** The project author and the operator are the same human. There is no adversarial
  `.codex`, no hostile workflow file, no untrusted checked-in config.
- **Own credential.** The user is already logged into Codex on the host.
- **Docker is packaging, not a boundary.** The user chose Docker for a one-command install, not to
  isolate themselves from their own agents.

Under that model, an entire class of controls is **defending nothing while blocking someone**:

- Masking a project-controlled `.codex` — the user *is* the project author.
- Refusing a non-git working directory — the user deliberately pointed the tool at their own dir and
  already granted write via the bind mount.
- Four stacked identity gates (context, daemon fingerprint, project-hash, volume labels) that guard
  "copied/tampered state adopted through a look-alike route" — a multi-tenant threat.
- Per-command checksum re-verification of the user's own files on their own disk.
- Fixed-UID credential-read gates that defend the host from the user's own container.

The organizing decision of this plan: introduce an explicit **local-first (single-user) posture as
the default**, and keep every existing gate available — unchanged — under the already-shipped
`--hardened` profile. We are not deleting the armor; we are making it opt-in for the people who
actually face that threat model, and getting it out of the way of everyone else.

**Nothing in this plan weakens `--hardened`.** Hardened keeps the mask refusal, the strict identity
gates, the no-network sandbox, the bwrap hard-gate, and the checksum re-verification.

---

## 2. Empirical evidence (captured in throwaway installs)

Two experiments were run against fresh installs of the released v0.1.3 image
(`docker.io/juliusolsson/workflow-mcp@sha256:fceac1e3…`). Scripts live in the session scratchpad
and are reproduced in §7.

### 2a. Auth inheritance WORKS end-to-end — the only bug is a pre-first-run misreport

Fresh install into a **git** temp project, host ChatGPT login present, no manual seeding:

```
PRE-RUN  auth status → "Not authenticated · Inherited host credential is not usable… run `auth login`"
codex-home/auth.json → absent (not seeded yet)
run one-agent workflow via MCP (exactly as Codex drives it):
  run.started → agent.started (provider: codex, source: live) → agent returned "AUTH_OK" → run.completed
codex-home/auth.json → NOW PRESENT (SDK seeded it on the attempt)
POST-RUN auth status → "Authenticated · Codex credentials inherited from the host login are usable"
```

Conclusion: the inherited host login authenticates a **real** agent, **unattended, with zero
device-code and zero manual steps**. The SDK seeds `codex-home/auth.json` from the mounted host file
on the first attempt (`src/processOwnedProviderHost.ts:358`) and Codex authenticates. The
`auth status`/`auth login` path checks the *unseeded* home *before* any attempt and therefore
misreports "not authenticated," then points the user at `auth login` → device-code → a flow that is
**off by default** in ChatGPT security settings. That misdirect — not the inheritance — is the
onboarding killer.

### 2b. Non-git projects are refused (the git-trust wall) — independent of auth

The identical one-agent workflow, same host login, into a **non-git** temp project:

```
PRE-RUN  auth status → same misdirect as 2a
run one-agent workflow via MCP:
  agent.started (provider: codex, source: live)
  agent.recovery_required → "Codex Exec exited with code 1: … Not inside a trusted directory
                             and --skip-git-repo-check was not specified."
  run → completed_with_errors (__workflowAgentFailure, coverageGap)
codex-home/auth.json → PRESENT   ← the SDK still seeded auth successfully
POST-RUN auth status → "Authenticated · inherited from the host login"
```

The critical observation: **auth and git-trust are independent, ordered failures.** In the non-git
run the SDK seeded the host credential and `auth status` went green afterwards — auth was never the
problem — yet Codex still died on the git-repo check. Contrast with 2a (git project, same workflow):
the agent returned `AUTH_OK` and the run completed. So:

- Auth inheritance works in **both** cases (seeded, `Authenticated` post-run).
- Git-trust independently kills **every** non-git workflow, *after* auth has already succeeded.

This is why the original `html-test` failure was so confusing: it is a non-git project, so even once
auth is sorted the workflow still dies — on a different gate, with a different (buried) error. The
code matches exactly (§4 Isolation #1): `codexThreadOptions()` never sets `skipGitRepoCheck`, and the
Codex binary refuses an untrusted non-git working directory.

---

## 3. Priority: the 5 changes that unblock the most users

Ranked by how many fresh installs they unblock, smallest-diff first.

1. **Set `skipGitRepoCheck: true`** in `codexThreadOptions()` (`src/codexProvider.ts:568`). One line.
   Unblocks 100% of non-git projects. (§4 Isolation #1)
2. **Seed host auth before the broker probes it** (`standalone/src/daemon/auth.ts:76-94`, share
   `synchronizeIsolatedAuthentication`). Makes `auth status` tell the truth on a fresh install and
   stops routing logged-in users to the device-code dead end. (§4 Auth #1)
3. **Add an `authentication` check to `doctor`** (`standalone/src/daemon/health.ts`). The one command
   users are told to run currently reports fully green while auth is unusable. (§4 Install #1)
4. **Relax the `.codex` mask refusal for the default profile** (`standalone/docker/codex-isolated.sh`).
   The Docker path already runs Codex with `--ignore-user-config`, so the mask defends nothing for a
   single owner; keep the refusal under `--hardened`. (§4 Isolation #2)
5. **Demote daemon-fingerprint / context / casing mismatches from hard-fail to warn-and-reattach**
   in the local profile (`standalone/install/workflow-mcp-docker`), and always let `uninstall`
   proceed. Today a routine Docker Desktop reset permanently strands the user *including from
   uninstalling their own install*. (§4 Install #2, #3, #8)

---

## 4. Full blocker catalog

Each entry: evidence (`file:line`), trigger, user-facing failure, verdict under the single-user
model, and the v0.1.4 fix. Grouped by subsystem, most-blocking first. Sourced from three independent
read passes plus the empirical runs.

### Auth & credentials

**A1 — `auth status` probes the unseeded isolated home → fresh host-auth install always reports "not
authenticated" and points at the one login that doesn't work.**
- Evidence: broker home `auth.ts:42`; host-codex branch reads the mounted seed only to confirm
  existence then runs `codex login status` against the never-seeded `codex-home`
  (`auth.ts:56-94`, env `auth.ts:186-187`); the only seeder is per-attempt
  (`src/processOwnedProviderHost.ts:358`); startup only validates, does not seed
  (`standalone/src/daemon/application.ts:148-164`); CLI prints `Not authenticated` + exit 3
  (`standalone/src/cli/main.ts:329-334`). Web dashboard contradicts it, reporting `configured`
  unconditionally (`standalone/src/api/router.ts:65-72`).
- Trigger: fresh default install with a detected host login; user checks `auth status` before the
  first workflow.
- Failure: "Not authenticated · Inherited host credential is not usable… run `auth login`" — proven
  in §2a even though the seed is valid.
- Verdict: not essential; actively misleads the target user. **Highest-value auth fix.**
- Fix: seed before probing — factor `synchronizeIsolatedAuthentication` into a shared module and call
  it in `status()` (and ideally once at daemon startup) so broker and provider agree on the home.

**A2 — `login` is `--device-auth`-only; the fallback every downgrade path points to is a dead end.**
- Evidence: `auth.ts:128-137` spawns `['login','--device-auth']` unconditionally; launcher routes
  `auth login` here (`workflow-mcp-docker:1256`).
- Trigger: any user funneled to `auth login` whose ChatGPT org has device-code off (the default).
- Failure: device code is rejected; `authentication-failed` thrown. No in-product way out.
- Verdict: mechanism fine; being the *only* mechanism is the problem (it is load-bearing across
  install/downgrade notes at `:337`,`:393`,`:787-789`).
- Fix: fix A1 so host-login users never arrive here; detect the "device auth disabled" stderr and
  emit an actionable message ("your host login is already inherited") instead of a raw failure; add a
  non-device path where viable. Do not remove the device path.

**A3 — Native-Linux host `auth.json` unreadable by UID 10001 → inheritance silently dropped → user
funneled into the broken device path.**
- Evidence: launcher UID-10001 read probe (`workflow-mcp-docker:380-396`, `:717-724`) unsets the var
  on failure; daemon re-gate throws (`application.ts:156-162`); seed is a file-secret preserving host
  `0600` (`compose.auth-host-codex.yaml:11-18`). Docker Desktop rewrites ownership, so this is the
  classic macOS-passes / Linux-fails split.
- Trigger: native Linux Docker Engine, default profile, normal `0600` host login.
- Failure: "not readable by UID 10001… setfacl…"; inheritance dropped → interactive mode → A1 → A2.
- Verdict: not essential (defends host from the user's own container). Friction, and it chains into
  the dead end.
- Fix: in the default profile, read the credential as the host UID or copy it into the private
  `.workflow-mcp` with a UID-10001-readable mode at install; or auto-apply the `setfacl` the way
  `default_authoring_setup` already self-heals ACLs (`workflow-mcp-docker:620-631`), instead of only
  printing it.

**A4 — API-key mode is file-only and hard-fails on a missing/rotated/CRLF key; the env path the core
already supports is never exposed.**
- Evidence: core handles `OPENAI_API_KEY` env (`application.ts:203-213`) but launcher only accepts
  `--api-key-file` and injects a file secret; hard-fails on missing/moved key
  (`workflow-mcp-docker:342-353`, `:525-547`), single-line shape gate (`:539`, `application.ts:233`).
- Trigger: user rotates/moves the file, supplies a CRLF/commented file, or just wants to paste a key.
- Failure: `up`/`mcp-proxy`/`upgrade` abort.
- Verdict: not retaining the key is fine; forbidding an env flow and making rotation a hard start
  failure is friction.
- Fix: expose `--api-key`/`OPENAI_API_KEY` (core already supports it); strip a trailing `\r`/newline
  before the shape check; keep file mode as the default-secure option.

**A5 — Sharing one seed between host and container Codex can trigger `refresh_token_reused`.**
- Evidence: mtime guard prevents *resurrection* within a container lifetime
  (`src/processOwnedProviderHost.ts:419-426`); startup does not seed (`application.ts:148-164`). The
  residual hazard is initial one-time-token sharing: host consumes RT0→RT1 while the container still
  holds seeded RT0.
- Trigger: default inheritance install where the user keeps using host Codex; container attempt after
  the host rotated and the container's access token expired.
- Failure: intermittent provider failure (`processOwnedProviderHost.ts:313-318`) with no obvious
  cause; remedy `auth login` dead-ends (A2).
- Verdict: inherent to reusing one credential in two places; low-frequency but real.
- Fix: document that the container obtains its own credential lineage; make `auth login` viable
  (fix A2); optionally emit a specific "re-run auth login" message on a detected reuse error.

**A6 — `auth` subcommands require an already-running container (no auto-up).**
- Evidence: `workflow-mcp-docker:1256` uses `compose exec`; contrast `mcp-proxy` auto-up
  (`:1226-1244`).
- Trigger: `auth login/status` after a reboot or before `up`.
- Failure: raw Docker "service not running" error.
- Fix: give `auth` the same auto-up preamble, or a clear "run `up` first" message.

**A7 — Read-only `auth status` is blocked whenever any run is active.**
- Evidence: `#exclusive` gates every op behind `hasActiveRuns()` (`auth.ts:162-169`), including
  `status` (`auth.ts:76`).
- Trigger: checking auth while a workflow runs.
- Failure: `auth-busy` instead of an answer, exactly when the user cares.
- Fix: run `status()` without the active-runs guard; keep the exclusive lock only for `login`/`logout`.

### Codex isolation & sandbox

**I1 — GIT-TRUST: Codex refuses a non-git `/workspace`; hits 100% of non-git projects, every attempt.**
- Evidence: `codexThreadOptions()` builds every `ThreadOptions` field but never sets
  `skipGitRepoCheck` (`src/codexProvider.ts:558-588`); grep for `skipGitRepoCheck` → no matches; SDK
  emits `--skip-git-repo-check` only when truthy
  (`node_modules/@openai/codex-sdk/dist/index.js:198-200`); the Codex binary refuses with "Not inside
  a trusted directory and --skip-git-repo-check was not specified." `ISOLATED_CODEX_CONFIG` adds no
  trust entry (`src/processOwnedProviderHost.ts:328-343`), and the launcher passes
  `--ignore-user-config` so no trust entry could be inherited (`codex-policy-launcher.mjs:112`). The
  Dockerfile's `safe.directory /workspace` (`Dockerfile:93`) is a *different* (dubious-ownership)
  check and does not help.
- Trigger: workflow against any non-git directory (new project, docs folder, scratch dir).
- Failure: Codex exits immediately → `codex-provider-host-exited` (`processOwnedProviderHost.ts:315-318`)
  → agent `recovery_required`; "agents stop before inspection." Proven in §2b.
- Verdict: an upstream rail for unversioned trees; pure friction for a deliberate single owner who
  already granted write via the bind.
- Fix: set `skipGitRepoCheck: true` in `codexThreadOptions()`. Highest-value onboarding fix. **One line.**

**I2 — `.codex` mask: opaque `exit 77` when a project `.codex` exists but is not a proven read-only mount.**
- Evidence: `codex-isolated.sh:21-55` requires `/workspace/.codex` be an ordinary dir, provably
  empty, and a kernel read-only mount (mountinfo field 6 `ro`) else `exit 77`. A default install
  *creates* `<project>/.codex` for the MCP stanza (`workflow-mcp-docker:801-815`). The launcher only
  attaches the mask overlay when `.codex` pre-exists and is not a symlink (`:355-358`). The header
  comment (`codex-isolated.sh:7-20`) documents this class already broke 100% of installs once.
- Trigger: `.codex` present but the mask isn't attached (raw `docker compose`, Docker MCP Catalog,
  symlinked `.codex`, or a storage driver whose `mountinfo` doesn't surface `ro` as parsed).
- Failure: `exit 77` → EPIPE; nothing tells the user their project has a `.codex`.
- Verdict: the whole mask defends a malicious project author; the single owner is the author. The
  provider path already runs `--ignore-user-config`/`--ignore-rules`
  (`codex-policy-launcher.mjs:112-113`), so a project `.codex` is not even read.
- Fix: drop the hard refusal for the default profile (config is already ignored); keep mask +
  refusal under `--hardened`; at minimum convert `exit 77` into a clear stderr message naming
  `.codex` and the one-line fix.

**I3 — Network access is a hard wall with no supported opt-in.**
- Evidence: launcher rejects any `sandbox_workspace_write.*` override incl. enabling network
  (`codex-policy-launcher.mjs:135-186`); image policy `network_proxy=false`
  (`codex-requirements.toml:53`); profiles extend `:read-only` (`:14-28`); provider marks any network
  request non-replay-safe (`src/codexProvider.ts:255-261`).
- Trigger: a workflow whose agent legitimately needs the network.
- Failure: request stripped, or "Provider attempted to override immutable sandbox policy"; no flag to
  grant egress.
- Verdict: no-egress defends an untrusted agent exfiltrating secrets, but confidentiality is already
  covered by `deny_read` on `/run/secrets` and `/data` (`codex-requirements.toml:37-45`) and env
  exclusion (`codex-policy-launcher.mjs:9-20`). A single owner has ordinary reason to want network.
- Fix: add a supported opt-in profile (env toggle) that stops stripping
  `network_access=true` and flips `network_proxy`; default stays no-egress; hardened forces no-egress.
  Keep the replay-safety downgrade (correctness, not a wall).

**I4 — `--add-dir` (extra writable dirs) and `danger-full-access` are hard-refused.**
- Evidence: `--add-dir` throws "Additional writable directories are not supported"
  (`codex-policy-launcher.mjs:54-57`); non-`read-only`/`workspace-write` modes throw (`:97-99`);
  `--yolo`/bypass throw (`:58-60`); replay layer also blocks (`src/codexProvider.ts:244-272`).
- Trigger: a workflow needing to write a sibling output/cache dir, or `danger-full-access`.
- Failure: launcher throws; no config re-opens those dirs.
- Verdict: keeping `danger-full-access`/`--yolo` off is reasonable even solo; the flat `--add-dir`
  refusal is over-tight with no allowlist.
- Fix: keep `danger-full-access` forbidden; replace the blanket `--add-dir` throw with an
  operator-configured allowlist of already-bind-mounted absolute paths.

**I5 — bwrap nested sandbox adds startup fragility and requires `seccomp/apparmor=unconfined`.**
- Evidence: nested containment attested `codex-bwrap-pid-v1` (`application.ts:186-192`,
  `codexProvider.ts:228-241`); requires outer `seccomp=unconfined`+`apparmor=unconfined`
  (`compose.yaml:50-57`); proven at startup by `policy-probe` self-test that throws on PID-namespace
  escape etc. (`codex-policy-launcher.mjs:189-347`, `codex-isolated.sh:78-84`).
- Trigger: runtimes without nested userns/PID or mount propagation (gVisor/Kata/runsc, rootless
  userns edge cases, daemons that ignore `security_opt`, mandatory-seccomp images).
- Failure: self-test throws → container unhealthy / refuses to serve; opaque startup crash. If
  skipped, termination silently degrades (`codexProvider.ts:240`).
- Verdict: bwrap's unique value (guaranteed PID-namespace reaping) is nice-to-have for one owner;
  credential confidentiality is already covered by `deny_read`+env exclusion, and the requirement
  weakens the outer container.
- Fix: for the default profile, degrade gracefully to the settlement/process-group boundary with a
  one-line warning instead of a startup hard-fail; keep the strict gate under `--hardened`; document
  the `unconfined` requirement prominently.

### Install, identity, doctor & docs

**N1 — `doctor` never checks authentication → reports healthy while the user cannot run a workflow.**
- Evidence: `standalone/src/daemon/health.ts` check list has no login/credential-usability check; the
  `agent-startup` probe runs `--version` and explicitly disclaims credentials (health.ts:148-153),
  deferring to `auth status` — a command `doctor` never invokes.
- Trigger: default install with no usable host credential; user runs `doctor` as the docs instruct.
- Failure: `ok: true`, all green; first workflow dies. The one honest signal lives elsewhere.
- Verdict: the reliability plan (§4) claims doctor closes this class; today it does not. This is
  exactly where a solo user looks.
- Fix: add an `authentication` check running the same isolated `codex login status` path, surfacing
  "not logged in — run `auth login`" as warn/fail. (Pairs with A1: once the broker seeds, this is
  honest.)

**N2 — Docker daemon fingerprint change = total, unrecoverable lockout (including uninstall).**
- Evidence: `load_instance` hard-fails on fingerprint mismatch (`workflow-mcp-docker:278-279`);
  fingerprint is SHA256 of Engine `/info.ID` (`record.ts:156-165`); `uninstall`/`upgrade` both call
  `load_instance` (`:824`,`:864`); `attest_volume`/`preflight_adoption` re-check the label
  (`:435-438`,`:519-522`), so `--adopt-instance` also refuses.
- Trigger: Docker Desktop factory reset / reinstall / major upgrade / engine switch — routine on a
  dev machine, not an attack.
- Failure: every verb incl. `uninstall` hard-fails; data intact but inaccessible; no documented
  recovery.
- Verdict: guards a copied-labeled-volume multi-tenant threat that does not exist for one owner
  adopting their own volume.
- Fix: in the local profile, demote fingerprint mismatch to a warning with a `--reattach-daemon`
  re-fingerprint path (after confirming instance+project labels match); at minimum let `uninstall`
  proceed so data is recoverable.

**N3 — `--adopt-instance` reattach still refuses from a differently-cased path.**
- Evidence: documented known limitation (`AGENT_STARTUP_RELIABILITY_PLAN.md §3`); `hashProjectIdentity`
  hashes `resolve(value)` case-sensitively (`record.ts:150-154`); the `-ef` fallback exists only in
  `load_instance` (`workflow-mcp-docker:299-307`), not `preflight_adoption` (`:501-523`), which
  recomputes from the freshly-typed path; after uninstall `instance.json` is gone.
- Trigger: macOS case-insensitive volume; reattach from `~/desktop/proj` after installing from
  `~/Desktop/proj`.
- Failure: "preserved volume labels do not match…"; only escape is the exact casing on the uninstall
  receipt.
- Fix: carry the recorded on-disk spelling in a volume label
  (`io.workflow-mcp.project-directory`) so `preflight_adoption` runs the same `-ef` fallback. Already
  named as the intended follow-up in the reliability plan.

**N4 — `install.sh` prints "Workflow MCP is ready" while the user is unauthenticated.**
- Evidence: bootstrap closes with "ready" + "restart Codex" and no auth step
  (`install.sh:102-104`); the launcher's honest "run auth login once" note is emitted earlier to
  stderr and visually overridden (`workflow-mcp-docker:786-790`); README line 47 underplays
  inheritance as guaranteed.
- Trigger: one-paste install on a machine with no usable host credential.
- Failure: user follows the closing text, runs a workflow, it fails on auth with no hint a login was
  needed.
- Fix: inspect auth state after `up` and print the actual next step prominently when no usable
  credential is present; soften README line 47.

**N5 — Any pre-existing `.workflow-mcp/` hard-fails re-install with no resume path.**
- Evidence: `workflow-mcp-docker:663-665` fails if the install path exists at all; no `--force`/resume.
- Trigger: Ctrl-C mid-install (after `mkdir -m 700` at `:746`), then re-run the same command.
- Failure: "installation path already exists…"; user must know to `rm -rf .workflow-mcp` manually.
- Fix: detect an incomplete install (no valid `instance.json`) and offer clean/resume; keep the
  refusal only when a valid install already exists.

**N6 — Docker Compose 2.32.0 is an absolute floor for every command, not just web.**
- Evidence: `workflow-mcp-docker:185` inside `host_doctor`, which runs on every `load_instance`
  (`:227`); contrast the Engine 28.3.3 floor that is correctly web-only and degrades at install
  (`:196`,`:673-677`).
- Trigger: slightly older but working Compose.
- Failure: hard-fail on any verb incl. `doctor`/`uninstall`.
- Fix: scope the Compose floor to operations that require it (mirror the engine-version degrade).

**N7 — Per-command SHA256SUMS re-verification.**
- Evidence: `verify_bundle` runs on every invocation (`workflow-mcp-docker:82-96`, called `:96`);
  hard-fails if neither `sha256sum` nor `shasum` exists (`:92`).
- Trigger: every command on a released install.
- Failure/cost: a fork + full re-hash per command; hard block if no checksum tool present.
- Verdict: the real bytes are already pinned by the immutable image digest (`install.sh:8-9`); the
  installed files are the user's own. Only catches local disk corruption.
- Fix: verify at install/upgrade only; drop the per-invocation re-check and the hard tool requirement
  in the local profile.

**N8 — Cross-context refusal strands intentional same-machine migration.**
- Evidence: `workflow-mcp-docker:270-271` fails on context/endpoint mismatch.
- Trigger: migrating the same machine's data from Docker Desktop to colima, or a context rename.
- Failure: refusal recoverable only if the original context still exists.
- Fix: allow same-daemon context rename/migration (re-record after confirming fingerprint + labels).

**N9 — Lower-severity friction:** image-mismatch hard-fail until `upgrade` (`load_instance:254-256`);
elaborate `terminal_safe_path` scanner rejecting unusual-but-harmless codepoints with no recovery
guidance (`workflow-mcp-docker:114-153`); upgrade exact file-set refusal (`:896-900`,`:257-264`) whose
brittleness already needed the `optional_upgrade_names` patch (`:16-27`).

---

## 5. Implementation shape for v0.1.4 (built on top of this file, same PR)

The profile machinery already exists (`WORKFLOW_MCP_PROFILE=default|hardened`,
`standalone/src/config/schema.ts`). This work threads the single-user posture through it rather than
adding a new axis.

- **Provider:** `skipGitRepoCheck: true` (I1); optional network profile (I3); `--add-dir` allowlist
  (I4). All gated so `--hardened` keeps today's behavior.
- **Auth broker/daemon:** shared seed module used by `status()` and startup (A1); device-disabled
  detection + message (A2); default-profile credential-read fallback (A3); `--api-key`/env option +
  newline-tolerant shape (A4); `status()` off the active-runs lock (A7); `auth` auto-up (A6).
- **Isolation:** default-profile `.codex` refusal relaxed to a clear message; mask kept under
  hardened (I2); bwrap degrade-gracefully on default, strict under hardened (I5).
- **Doctor:** add the `authentication` check (N1).
- **Launcher:** fingerprint/context/casing mismatches → warn-and-reattach in the local profile, and
  `uninstall` always proceeds (N2, N3, N8); resume incomplete installs (N5); scope Compose floor
  (N6); checksum at install/upgrade only (N7); friendlier `terminal_safe_path`/image-mismatch
  messaging (N9).
- **Docs/bootstrap:** auth-aware final message (N4); README correction.

Sequencing: land §3's five first (they unblock the most and are the smallest diffs), then the rest.

---

## 6. Explicitly NOT in scope / preserved

- **`--hardened` is untouched.** Every gate relaxed here stays exactly as-is under hardened: mask
  refusal, strict identity gates, no-network sandbox, bwrap hard-gate, per-command checksum.
- Not weakening credential confidentiality: `deny_read` on `/run/secrets` and `/data` and the env
  exclusion policy remain in every profile.
- Not removing the device-code login; adding paths around it.
- Not changing durable-state layout, backup/restore, or the release pipeline.

---

## 7. Verification plan (empirical, not asserted)

The throwaway-install harness that produced §2 is the acceptance test for the fixes. Keep it; run it
against a locally built `--build-arg` image carrying the changes.

- **Auth honesty (A1):** fresh git install → `auth status` reports **Authenticated** *before* any run
  (currently reports the misdirect). Re-run §2a.
- **Git-trust (I1):** fresh **non-git** install → the one-agent workflow **completes** (currently
  fails). Re-run §2b as the pass condition.
- **Doctor honesty (N1):** on an install with no usable credential, `doctor` reports the auth check
  as warn/fail, not green.
- **Daemon reattach (N2):** simulate a fingerprint change → `uninstall` still works; `--reattach`
  path recovers the instance.
- **Hardened unchanged:** the existing container-smoke mask/refusal assertions still pass under
  `--hardened` (regression guard that we relaxed only the default profile).
- **refresh-token (A5):** exercise host-then-container refresh ordering; confirm no
  `refresh_token_reused` under the documented guidance, or that the emitted message is actionable.

Experiment scripts (in the session scratchpad, to be committed under `standalone/scripts/` or an
experiments note during implementation):
- `exp-auth-e2e.sh <proj> <git|nogit>` — full install → run → auth-state capture.
- `mcpcli.mjs` — minimal MCP stdio client that drives `workflow_run` exactly as Codex does.

---

## 8. Open questions for implementation

1. Should the single-user posture be the literal `default` profile, or a new explicit
   `local`/`solo` value with `default` kept as today's middle ground? (Leaning: make `default`
   local-first, since that is what every consumer install already selects.)
2. Network opt-in granularity: per-install env toggle vs per-workflow request honored. (Leaning:
   per-install profile; per-workflow stays replay-unsafe as today.)
3. A3 fix: run-as-host-UID for the credential read vs install-time readable copy. (Leaning: readable
   copy into `.workflow-mcp`, since it avoids changing the container UID model.)
