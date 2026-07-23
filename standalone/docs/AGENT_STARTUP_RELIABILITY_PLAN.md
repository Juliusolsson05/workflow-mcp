# Agent Startup Reliability — plan

Status: PLAN, then implemented on this branch.
Origin: a live v0.1.2 install where **every agent died with an unreadable `EPIPE`**, the daemon
reported `READY` and `auth configured`, and `auth login` — the documented fix — also failed. Three
separate defects stacked to produce that, each individually shippable-looking. All three are fixed
here, with evidence captured from the real broken installation rather than reasoning.

---

## 1. Evidence

Captured from the operator's actual failing project (`html-test`) before writing any code:

```
$ .workflow-mcp/workflow-mcp-docker auth status
Not authenticated · Inherited host credential is not usable by the containerized Codex;
run `auth login` … codex-isolated: refusing unmasked project /workspace/.codex configuration

$ docker exec <daemon> printenv WORKFLOW_MCP_PROJECT_CODEX_MASKED
true                                   # the mask IS applied to the container
$ docker exec <daemon> ls -la /workspace/.codex
dr-xr-xr-x 2 workflow workflow 40      # empty, read-only tmpfs — a correct mask
$ docker exec <daemone> /opt/workflow-mcp/bin/codex-isolated --version
codex-cli 0.144.6                      # the wrapper runs fine with the container's own env
```

So the mask was correct and the wrapper worked — yet the wrapper refused when the **credential
broker** invoked it. And separately:

```
$ pwd -P                       /Users/juliusolsson/Desktop/Development/html-test
$ instance.json projectDirectory   /Users/juliusolsson/desktop/development/html-test
$ .workflow-mcp/workflow-mcp-docker auth status      # from the true-case path
workflow-mcp-docker: instance.json belongs to a different canonical project path
```

## 2. Defect A — the broker scrubs the mask attestation (breaks EVERY default install)

`CodexCredentialBroker.#environment()` (`standalone/src/daemon/auth.ts`) rebuilds a minimal
environment for Codex — `PATH`, `LANG`, `TERM`, `HOME`, `CODEX_HOME` — to keep credentials out of
a login child. It therefore also drops `WORKFLOW_MCP_PROJECT_CODEX_MASKED`.

`codex-isolated.sh` refuses to run when `/workspace/.codex` exists without that attestation. A
default install **always** creates `<project>/.codex` (that is where the Codex MCP stanza is
written), so `/workspace/.codex` always exists. Therefore `auth status` and `auth login` fail on
every default installation. The wrapper exits 77, the SDK writes to the dead process, and the
operator sees `EPIPE`.

This is not an edge case; it is 100% of default installs that reach `auth login`.

### Fix

The env bit was only ever an *attestation request*; the mount is the actual security boundary —
`codex-isolated.sh` already re-proves it (ordinary directory, empty, mounted, non-writable). So:

- **`codex-isolated.sh` trusts evidence over declaration.** When `/workspace/.codex` exists, prove
  the mask directly from `/proc/self/mountinfo` + emptiness + non-writability. A proven mask is
  accepted whether or not the attestation env var survived the caller's environment handling; an
  unproven `.codex` is still refused. This closes the whole class of "some caller scrubbed the
  flag", not just the broker instance of it.
- **The broker forwards the attestation anyway** so the declaration stays accurate and the
  refusal message stays precise. It is policy state, not a credential — forwarding it leaks
  nothing.

## 3. Defect B — path case is recorded as typed, not as it exists on disk

macOS filesystems are case-insensitive but case-preserving. `cd ~/desktop` succeeds while the
directory is really `Desktop`. Installation records `projectDirectory` from the path as resolved
through the *typed* spelling, and instance identity is a hash of that string. Every later command
recomputes the hash from however the path resolved *that* time. When the two spellings differ the
launcher hard-fails with `instance.json belongs to a different canonical project path`, and the
install is only usable from the exact casing used at install time.

Worse, it is silent and intermittent: the PATH shim resolves from `$PWD` (whatever the user typed),
so the same install works in one terminal and refuses in another.

### Fix

Normalize the recorded project directory to the filesystem's own spelling at record time. The
identity hash then describes the directory that actually exists, not a spelling of it, and every
later resolution — typed in any case on a case-insensitive volume — agrees. Case-sensitive
filesystems are unaffected because there the typed spelling *is* the on-disk spelling.

Implementation note: resolution must not invent a path. It reads the real directory entries to
recover the true spelling component-by-component, and falls back to the given path unchanged when
a component cannot be read, so a permission-restricted parent can never turn into a wrong identity.

## 4. Defect C — the daemon reports healthy while agents cannot start

The healthcheck is `/readyz`, which proves the HTTP surface and store ownership. It says nothing
about whether Codex can actually execute. So a daemon whose every agent will fail still comes up
green, the dashboard looks fine, and the failure only appears later as an unreadable provider
stack trace. Every hour of the originating debugging session was spent on this gap.

### Fix

`doctor` already runs a real `codex-policy` probe. Add an explicit, cheap **agent-startup** check
that runs the same `codex-isolated` entry the provider uses and reports the wrapper's own refusal
text when it fails. `doctor` is the command an operator is told to run, so the actionable message
("project `.codex` is not masked", "not logged in — run `auth login`") lands where they look,
instead of surfacing as EPIPE inside a workflow result hours later.

## 5. Scope explicitly NOT taken

- Not weakening the mask. An unproven project `.codex` is still refused; only the *source of
  truth* moves from a forwarded boolean to the mount itself.
- Not changing the credential-scrubbing intent of the broker. Credentials stay out; one
  non-credential policy flag is forwarded.
- Not touching host-auth inheritance semantics beyond what v0.1.2 already shipped.

## 6. Verification

- Regression test for Defect A: a broker-shaped minimal environment must still satisfy the mask
  gate when the mask is genuinely mounted.
- Regression test for Defect B: a record written through a differently-cased spelling of a real
  directory resolves to one identity.
- Container smoke keeps proving the hostile cases: contaminated mask refused, unmasked `.codex`
  refused, writable mask refused.
- The originating operator scenario re-run end to end: default install → `auth login` → agents
  actually start.
