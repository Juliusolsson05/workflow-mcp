# ADR 0001: Runtime topology and agent isolation

Status: accepted for layout v1.

## Decision

One long-lived `workflow-mcp daemon` owns the run store, provider attempts, HTTP MCP endpoint,
read-only API, tokens, and private admin Unix socket. Codex clients launch a stateless STDIO proxy
with `docker compose exec`; TUI, status, and browser clients read the daemon. Generic OCI execution
may run session-bound STDIO directly, but it does not inherit the daemon durability claim.

The daemon and Codex use the fixed container UID 10001. Agent commands are separated from daemon
credentials/control by Codex's managed permission profile: `/data`, `/run/secrets`,
`/run/workflow-mcp`, and `/proc` are denied; command network, apps, plugins, image generation,
multi-agent features, login shells, user config, and rules are disabled; shell credential variables
are excluded; every command starts inside Codex Bubblewrap's PID namespace.

## Why

Per-MCP-session ownership made a disconnected editor the accidental run lifetime and allowed two
clients to repair/write one store. A second provider container/UID looked cleaner but would require
a credential/session broker protocol before the core could resume exact Codex threads. Mode 0600
inside one UID was explicitly rejected as an isolation claim. The pinned Codex sandbox is the
smallest boundary that hides credentials/control while keeping SDK/session semantics intact.

## Proof and invalidation

`codex-isolated policy-probe` executes the real pinned sandbox, tries to read the MCP token, starts a
double-detached `setsid` sleeper, and scans host `/proc` for escape. Doctor and container CI require
both probes to pass. The provider attests `codex-bwrap-pid-v1` only when executable and effective
policy fingerprints exist. A Codex/SDK/policy/mask/tool change invalidates automatic-recovery
evidence and requires the hostile probe again.

The design is wrong if a model command can read a token/auth file, connect to daemon control, retain
a descendant after cancellation, inherit project Codex capability, or if proxy disconnect stops a
daemon-owned run.
