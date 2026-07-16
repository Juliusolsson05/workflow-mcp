<h1 align="center">workflow-mcp</h1>

<p align="center">
  Run Claude Code dynamic-workflow files through any agent provider — as a durable, resumable Model Context Protocol server.
</p>

<p align="center">
  <a href="https://github.com/Juliusolsson05/workflow-mcp/stargazers"><img src="https://img.shields.io/github/stars/Juliusolsson05/workflow-mcp?style=flat" alt="Stars"></a>
  <a href="https://github.com/Juliusolsson05/workflow-mcp/network/members"><img src="https://img.shields.io/github/forks/Juliusolsson05/workflow-mcp?style=flat" alt="Forks"></a>
  <a href="https://github.com/Juliusolsson05/workflow-mcp/issues"><img src="https://img.shields.io/github/issues/Juliusolsson05/workflow-mcp?style=flat" alt="Issues"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/Juliusolsson05/workflow-mcp?style=flat" alt="License"></a>
  <a href="https://github.com/Juliusolsson05/workflow-mcp/commits/main"><img src="https://img.shields.io/github/last-commit/Juliusolsson05/workflow-mcp?style=flat" alt="Last commit"></a>
</p>

---

`workflow-mcp` is a standalone runtime and MCP server that executes Claude Code
**dynamic workflow files** — the JavaScript orchestration programs that fan out
dozens or hundreds of agent calls and return a single result — without requiring
Claude to run them.

The whole project hangs on one promise:

> A workflow authored for `workflow-mcp` can be copied into
> `.claude/workflows/<name>.js` and run by a compatible Claude Code release
> without changing the file — and a real Claude workflow file runs through this
> runtime without any importer or translation step.

Everything that _isn't_ portable — which provider executes the agents, its
credentials, the durable run cache, MCP run IDs, and UI state — lives in the
runtime, never inside the `.js` file.

## Why it exists

Claude Code workflows are a strong primitive: the JavaScript owns the loops,
branches, fan-out, and aggregation, while each `agent()` call owns the model
reasoning and side effects — keeping hundreds of intermediate results out of the
parent conversation. But out of the box they come with three constraints:

- **Claude executes every agent node.** There is no seam for another provider.
- **A run belongs to a Claude session.** Its state lives inside that session
  directory, and it does not survive as an independently controllable object.
- **There is no server surface.** Other tools cannot discover, launch, follow,
  or resume a run.

`workflow-mcp` keeps the exact same workflow file and lifts those constraints:
the same `.js` runs through a provider-neutral engine (Codex today), every run
is a durable object that survives restarts, and any MCP-capable host can drive
it over a stable set of tools.

## How it works

Two kinds of portability are kept deliberately separate — MCP solves the first,
the provider interface solves the second:

```text
MCP-capable host
      │  workflow_list · workflow_run · workflow_run_events · …
      ▼
WorkflowService  +  durable event store   ← the long-lived owner of runs
      ▼
Claude-compatible JavaScript runtime       ← agent/parallel/pipeline/phase/…
      ▼
provider-neutral AgentProvider
      ├─ Codex SDK  (@openai/codex-sdk)
      ├─ fake       (deterministic tests)
      └─ future providers
```

- **Claude-compatible runtime.** A restricted, killable Node/V8 context that
  exposes exactly the globals Claude injects (`agent`, `parallel`, `pipeline`,
  `phase`, `log`, `workflow`, `args`, `budget`, top-level `await`/`return`) with
  the same discovery rules, metadata grammar, and cache identity. The behaviour
  is pinned to an observed Claude Code profile so future Claude releases add a
  _new_ profile instead of silently breaking old runs.
- **Durable service.** The `WorkflowService` — not any single MCP connection —
  owns runs. Every event is appended and fsynced **before** any subscriber sees
  it, so a run can be reconstructed after a renderer reload, a provider
  reconnect, or a process restart by replaying a strict event cursor.
- **Provider-neutral execution.** The engine only knows an `AgentProvider`
  interface. The first real adapter drives the official Codex SDK; a
  deterministic fake provider runs the conformance suite. Model aliases
  (`haiku`/`sonnet`/`opus`) are host policy, never guessed.
- **Reliability.** One work-conserving scheduler across all runs, supervised
  per-agent retries, one process-owned Codex host per attempt, a shared provider
  circuit breaker, single-writer fencing, and interrupted-run recovery that
  sparsely reuses already-completed siblings.

## What you get

- **Portable workflow files** — the same `.js` runs here and in Claude Code.
- **A durable MCP server** — eight stable tools (`workflow_list`,
  `workflow_describe`, `workflow_validate`, `workflow_run`,
  `workflow_run_status`, `workflow_run_events`, `workflow_run_cancel`,
  `workflow_resume`) over stdio or an authenticated loopback HTTP transport.
- **Immediate run handles** — `workflow_run` returns a run ID at once; clients
  follow progress by polling a durable cursor, not a transport-specific push.
- **Unattended best-effort completion** — retryable read-only work restarts in a
  fresh provider thread. An exhausted or unsafe logical assignment becomes a
  versioned `__workflowAgentFailure` coverage gap, while independent siblings
  and final synthesis continue. Such runs finish as `completed_with_errors`;
  only persistence or supervisor faults fail the complete run.
- **Resume** — continue a managed run, or import-and-resume a real Claude run
  after verifying its source and journal byte-identity. Exact source/arguments
  reuse completed calls sparsely; automatic crash recovery also preserves
  terminal coverage gaps, while an explicit manual resume retries those gaps.
  Edited source retains the longest unchanged prefix. Claude's own files are
  never rewritten.
- **An embeddable service** — the same `WorkflowService` and tool registrar that
  the CLI uses can be mounted inside another host (this is how
  [Agent Code](https://github.com/Juliusolsson05/agent-code) renders each run as
  a live feed card) instead of starting a second server.
- **A browser-safe state entry** — `workflow-mcp/state` exposes the event union
  and pure reducer with no filesystem, MCP, or Codex code, so a renderer can
  project run state without pulling server code into its bundle.

## Getting started

Requires Node ≥ 20.14. Codex execution reuses your existing Codex CLI login or
the SDK's API-key mode.

```bash
npm install --include=dev
npm run build
npm run check
```

Then drive a workflow from the CLI:

```bash
# Validate one workflow file (direct paths do not need a .js extension).
node dist/cli.js validate ./path/to/workflow.js

# List personal and project workflows visible from a directory.
node dist/cli.js list ./path/to/project

# Run through the Codex SDK. Events are JSONL on stderr; the final result is
# JSON on stdout. The optional second argument is one JSON value exposed as `args`.
node dist/cli.js run ./path/to/workflow.js '{"files":["src/index.ts"]}'

# Resume a persisted Claude run (imported runs are read-only).
node dist/cli.js resume /path/to/claude/session/workflows/wf_id.json

# Serve over stdio, scoped to one project.
node dist/cli.js serve --stdio /path/to/project

# Serve over an authenticated loopback Streamable HTTP endpoint (URL + bearer
# token are printed once to stderr).
node dist/cli.js serve --http /path/to/project 0
```

## Embedding

The public API uses plain names and hands the host full control of the MCP
server, transport, and authentication lifecycle:

```ts
import {
  CodexAgentProvider,
  FileWorkflowStore,
  WorkflowService,
  registerWorkflowMcpTools,
} from 'workflow-mcp'

const service = new WorkflowService({
  store: new FileWorkflowStore('/private/application/state/workflows'),
  provider: () => new CodexAgentProvider({
    codexPathOverride: '/approved/codex',
    // Required before a host may attest that normal user/project MCP servers cannot leak into
    // an automatically replayed read-only workflow attempt.
    configurationIsolation: {
      codexHome: '/private/application/state/workflow-codex',
      authenticationFile: '/home/user/.codex/auth.json',
      // This must come from inspection of the exact executable plus user/project/system/managed
      // configuration layers. Omit it and use "unknown" below when the host cannot prove that.
      effectiveConfigurationFingerprint: verifiedCodexPolicyDigest,
    },
    capabilities: { inheritedMcpServers: 'disabled' },
  }),
  sandbox: { mode: 'read-only', approvalPolicy: 'never', network: false },
})
await service.initialize()

// The host still owns McpServer and its transport/authentication.
registerWorkflowMcpTools(mcpServer, service, { cwd: projectDirectory, clientId: sessionId })
```

## Documentation

- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — the full technical
  reference: the pinned Claude-workflow compatibility profile, the exact runtime
  realm, discovery/precedence, cache and resume mechanics, the MCP architecture,
  the Codex SDK findings, and the conformance matrix.
- **[docs/EXECUTION_PLAN.md](docs/EXECUTION_PLAN.md)** — the phased build decisions.
- **[docs/RELIABILITY_IMPLEMENTATION_PLAN.md](docs/RELIABILITY_IMPLEMENTATION_PLAN.md)** —
  the unattended-execution and failure-domain plan.

## Built for Agent Code

`workflow-mcp` was built as a feature of
[**Agent Code**](https://github.com/Juliusolsson05/agent-code) — an open-source
Electron IDE for driving the real Claude Code and Codex CLIs across a
multi-agent workspace. Agent Code embeds this runtime through its existing MCP
host and renders each run as a live, first-class feed card: phases and agents as
vertical lists, with prompt, activity, and outcome expandable inline.

That embedded path is the most polished way to use `workflow-mcp` today. The
runtime was designed from the start to stand on its own — the CLI and the
standalone stdio / loopback-HTTP MCP server already run workflows outside Agent
Code — but **better support for standalone execution is on its way**: a
supervised host so runs keep progressing across restarts without a desktop app
present, smoother first-run setup, and more provider adapters beyond Codex.

## Status

Early. The loader, execution runtime, durable service, MCP facade, standalone
server, deterministic fake provider, and pinned Codex adapter are in place;
Agent Code embeds the same service. Compatibility is pinned to an **observed**
Claude Code profile — a snapshot of a fast-moving upstream, not a promise about
future versions.

## License

[MIT](LICENSE)
