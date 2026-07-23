# Docker-First Codex MCP Standalone Package

Status: Proposed implementation plan

Date: 2026-07-23

Implementation branch: `feat/docker-first-standalone`

Release boundary: the standalone `workflow-mcp` repository, not the Agent Code application

Primary artifact: an OCI image published to Docker Hub

Primary runtime: one long-lived, project-scoped Docker Compose service

## 1. Purpose of this document

This is the implementation contract for turning the existing `workflow-mcp` runtime into a clean,
Docker-first Codex MCP product with three interfaces over one durable service:

1. an MCP interface for Codex and other MCP clients;
2. an interactive terminal UI launched with a Docker command; and
3. an optional local browser UI served by the same container.

The plan is intentionally larger than a normal feature note. A future implementation agent should
not have to rediscover why Compose owns the durable service, why the TUI must be a client, how a
Docker MCP Catalog launch differs from the full product, or what security properties are lost by
mounting a host Codex home. It records product decisions, current-code evidence, proposed file
layout, commands, protocols, rollout slices, tests, release mechanics, and unresolved decisions.

This document does not authorize a big-bang rewrite. The existing durable runtime is the asset.
The implementation should add a separately shaped product around it and move code only when a
specific boundary has tests and a compatibility path.

## 2. Reading conventions

The labels below distinguish evidence from intention:

- **CURRENT** means the behavior exists on `workflow-mcp` `origin/main` at planning time.
- **DECISION** means this plan selects the behavior unless implementation evidence proves it
  infeasible.
- **PROPOSED** means the shape is expected but can change without violating the product contract.
- **OPEN** means implementation must resolve and record the answer before the dependent milestone.

Normative words have their usual meaning: **must** is required for release, **should** is the
preferred tradeoff, and **may** is optional.

## 3. Executive decision

**DECISION:** the complete product is a long-running, per-project Compose service. The daemon is
the only owner of `WorkflowService`, the durable store, provider processes, and recovery. Codex,
the TUI, and the browser are clients of that daemon.

```text
Codex
  │ MCP stdio
  ▼
mcp-proxy ───────────────────────────────┐
                                         │
Terminal UI ── authenticated local API ──┼──> workflow-mcp daemon
                                         │          │
Browser UI ── authenticated HTTP API ────┘          ├──> FileWorkflowStore on /data
                                                    ├──> workflow workers
                                                    └──> isolated Codex provider hosts
```

The user-facing lifecycle is:

```bash
# Start or recover the project service.
docker compose up -d

# Paint an interactive terminal UI without creating another workflow owner.
docker compose exec workflow-mcp workflow-mcp ui

# Open the optional browser dashboard.
# http://127.0.0.1:7331

# Stop the service. A later start may recover safely interrupted work.
docker compose down
```

The product must not require a global Node installation, a globally installed npm package, or
Docker Desktop's MCP Toolkit. Those can be optional conveniences, not prerequisites.

## 4. Why this shape exists

### 4.1 A UI cannot own durable work

**CURRENT:** `WorkflowService` deliberately outlives individual MCP connections. It holds active
runs, one service-wide scheduler, provider circuit breakers, recovery state, subscribers, and the
store lease. `FileWorkflowStore` persists manifests, append-only event histories, immutable source
snapshots, results, agent results, and transcript mirrors.

If a TUI process constructed its own service, closing a terminal could end provider processes or
leave store ownership ambiguous. If the web server constructed a second service, it would contend
for the same single-writer lease. Both contradict the existing runtime's invariants.

**DECISION:** one daemon owns the service. `ui`, `mcp-proxy`, `status`, and future administrative
commands attach to it. They must fail clearly when the daemon is unavailable; they must never fall
back to silently constructing another service against the same `/data` directory.

### 4.2 Compose, the Docker MCP Gateway, and registries solve different problems

The current ecosystem has four distinct layers:

| Layer | What it provides | Role in this product |
| --- | --- | --- |
| Docker Hub | OCI artifact storage and tags/digests | Primary release artifact |
| Docker Compose | Stable process, volumes, project bind, ports, restart policy | Primary full installation |
| Docker MCP Catalog/Gateway | MCP discovery and container launch for supported clients | Compatibility/discovery mode |
| Official MCP Registry | Metadata that points to an npm, OCI, remote, or other package | Secondary discovery channel |

Docker's MCP Catalog and Toolkit are currently documented as Beta, Docker MCP Profiles as Early
Access, and the official MCP Registry as Preview. The ordinary Compose path therefore remains the
compatibility floor even if catalog integration becomes excellent. A moving discovery layer must
not become the owner of the product's durable state.

### 4.3 Docker changes project and process boundaries

A container does not inherit the host project's files or installed compilers. The selected project
must be bind-mounted at a fixed container path, and project-specific toolchains may require a
derived image. A remote Docker daemon also cannot bind-mount paths that only exist on the user's
laptop.

**DECISION:** version one supports a local Docker Engine or Docker Desktop with exactly one project
mounted at `/workspace`. A multi-project global daemon and remote-Docker project mounting are
explicit non-goals.

## 5. Product contract

### 5.1 Required user outcomes

A release is successful when a user can:

1. pull a versioned image on Linux amd64, Linux arm64, Intel macOS through Docker Desktop, and Apple
   Silicon macOS through Docker Desktop;
2. start one project-scoped daemon with Compose;
3. connect Codex to it as an MCP server without installing the project's Node dependencies on the
   host;
4. launch and close a TUI without affecting active workflows;
5. optionally inspect the same live and historical runs in a local browser;
6. restart or upgrade the container without losing durable run state;
7. see an explicit recovery-required state when work cannot be replayed safely;
8. authenticate Codex inside the container without mounting the host's complete `~/.codex`;
9. opt into narrowly defined project writes instead of receiving them accidentally; and
10. diagnose configuration, permissions, authentication, architecture, and daemon health with a
    single command.

### 5.2 Non-goals for version one

- A hosted multi-user control plane.
- Browser access from another machine.
- Kubernetes deployment.
- A daemon that dynamically acquires arbitrary host directories.
- Automatic access to tools installed only on the host.
- Mounting the Docker socket and launching per-agent sibling containers.
- Exactly-once semantics for unknown external mutations.
- A browser-based shell or arbitrary terminal execution.
- Replacing Agent Code's embedded integration.
- Making Docker Desktop MCP Toolkit a mandatory dependency.
- Publishing the core runtime to npm merely because the container is public.

### 5.3 Compatibility promise

The existing promise remains authoritative: workflow JavaScript is compatible with the observed
Claude Code dynamic-workflow contract, while provider credentials, execution state, MCP run IDs,
and UI state stay outside the portable workflow file.

The Docker product adds a deployment promise, not a new workflow language. No Docker-specific
global, path, metadata field, or provider option may enter portable workflow source.

## 6. Current implementation baseline

### 6.1 Assets to preserve

**CURRENT:** the repository already contains:

- a Claude-compatible workflow parser and restricted worker runtime;
- a provider-neutral `AgentProvider` seam and a Codex SDK adapter;
- per-attempt provider-host processes and termination supervision;
- a work-conserving service-wide scheduler with a default ceiling of nine;
- durable events, manifests, result artifacts, per-agent artifacts, and transcript mirrors;
- single-writer store leasing and crash-tail repair;
- automatic recovery for replay-safe interrupted work;
- source-hash authorization hooks and path confinement;
- thirteen stable MCP tools over STDIO or authenticated Streamable HTTP;
- a browser-safe `workflow-mcp/state` reducer and event/state types; and
- an embeddable `WorkflowService` used by Agent Code.

These are not prototypes to replace. The standalone product must compose them.

### 6.2 Existing MCP surface

The current tool surface is:

1. `workflow_list`
2. `workflow_describe`
3. `workflow_validate`
4. `workflow_run`
5. `workflow_run_status`
6. `workflow_run_events`
7. `workflow_result_read`
8. `workflow_run_cancel`
9. `workflow_resume`
10. `workflow_agent_list`
11. `workflow_agent_result_read`
12. `workflow_agent_results_read`
13. `workflow_agent_transcript_read`

**DECISION:** the containerization effort does not rename or fork these tools. New administrative
capabilities belong in the local control API or CLI unless an MCP model genuinely needs them.

### 6.3 Current standalone limitations relevant to Docker

**CURRENT:** `workflow-mcp serve --stdio` and `serve --http` each construct the durable service in
the CLI process. HTTP binds only to `127.0.0.1`, creates a random bearer token on every launch, and
prints the URL and token to stderr. The CLI snapshots discovered workflow source hashes at startup
and defaults agents to read-only, no approvals, and no tool network.

The gaps are:

- `127.0.0.1` inside a container is not reachable through a published Docker port;
- a freshly generated token is awkward for stable Codex and browser clients;
- STDIO server lifetime is tied to the MCP launcher;
- there is no daemon control API, TUI, or web app;
- graceful `WorkflowService.stop()` follows an explicit cancellation path, which is wrong for a
  restart or image upgrade that should remain recoverable;
- the default state path is a home-directory path rather than an explicit container volume;
- authoring inline workflows conflicts with a read-only project mount and startup-only approvals;
- the MCP server currently reports version `0.0.0` rather than an image/build version; and
- package verification covers npm contents, not OCI contents and runtime behavior.

## 7. Repository and package isolation

### 7.1 Release boundary

**DECISION:** all product-specific implementation and release material belongs in the standalone
`workflow-mcp` repository. Agent Code continues to consume the core runtime through the existing
submodule and public TypeScript API.

The parent Agent Code repository should receive only a later submodule-pointer update and any
deliberate integration changes. Dockerfiles, Compose files, web assets, registry metadata, and
standalone UI dependencies must not leak into Agent Code's root package.

### 7.2 Internal directory boundary

**DECISION:** create an isolated `standalone/` product package instead of growing more deployment
policy inside the current flat `src/` directory.

Proposed final shape:

```text
workflow-mcp/
├── src/                              # provider-neutral runtime/library
├── test/                             # runtime tests
├── docs/
│   └── DOCKER_FIRST_CODEX_MCP_IMPLEMENTATION_PLAN.md
├── standalone/
│   ├── README.md                     # operator-facing quick start
│   ├── package.json                  # private product package initially
│   ├── package-lock.json
│   ├── tsconfig.json
│   ├── src/
│   │   ├── cli/
│   │   │   ├── main.ts
│   │   │   ├── commands/
│   │   │   └── output.ts
│   │   ├── config/
│   │   │   ├── schema.ts
│   │   │   └── loadConfig.ts
│   │   ├── daemon/
│   │   │   ├── application.ts
│   │   │   ├── lifecycle.ts
│   │   │   ├── health.ts
│   │   │   └── tokens.ts
│   │   ├── api/
│   │   │   ├── router.ts
│   │   │   ├── auth.ts
│   │   │   └── dto.ts
│   │   ├── mcp/
│   │   │   ├── http.ts
│   │   │   └── proxy.ts
│   │   └── tui/
│   │       ├── application.ts
│   │       └── views/
│   ├── web/
│   │   ├── package.json
│   │   ├── src/
│   │   └── vite.config.ts
│   ├── test/
│   │   ├── unit/
│   │   ├── system/
│   │   └── fixtures/
│   ├── docker/
│   │   ├── Dockerfile
│   │   ├── Dockerfile.example-toolchain
│   │   ├── entrypoint.sh
│   │   └── docker-bake.hcl
│   ├── compose.yaml
│   ├── compose.authoring.yaml
│   ├── .dockerignore
│   └── distribution/
│       ├── mcp-registry/server.json
│       └── docker-mcp-catalog/
└── .github/workflows/                # GitHub requires workflows at repository root
    ├── container-ci.yml
    └── container-release.yml
```

The exact file names are proposed, but the boundary is normative:

- core runtime logic stays in the root package;
- standalone lifecycle, API, UI, Docker, and release policy stay under `standalone/`;
- GitHub workflow files are the only unavoidable root-level release exception; and
- web build output is generated, not committed.

### 7.3 Dependency direction

```text
standalone web ──> workflow-mcp/state only
standalone daemon/TUI ──> workflow-mcp public API
workflow-mcp core ──X──> standalone
Agent Code ──> workflow-mcp core
Agent Code ──X──> standalone web/TUI/container package
```

**DECISION:** standalone code must not reach into unexported root source paths. If the product needs
a primitive, first define and test the smallest provider-neutral public API. This makes the Docker
product prove the same embedding boundary Agent Code relies on.

### 7.4 Migration without a flag day

The current root CLI and `standaloneServer.ts` should not be deleted at the start.

1. Add the standalone package and compose existing public APIs.
2. Extract any missing neutral primitive with existing tests intact.
3. Add compatibility tests proving old `serve --stdio` and `serve --http` behavior.
4. Decide whether the root CLI becomes a compatibility shim, remains a developer CLI, or is
   superseded in a documented major release.
5. Only then remove duplicate composition.

## 8. Process and ownership model

### 8.1 Processes

The normal Compose deployment contains one service container. Inside it:

```text
tini (PID 1)
└── workflow-mcp daemon
    ├── workflow worker process(es)
    └── one Codex provider-host process per physical attempt
```

`docker compose exec` may temporarily add:

```text
workflow-mcp ui
workflow-mcp mcp-proxy
workflow-mcp doctor
workflow-mcp auth ...
```

Those processes are clients. They do not acquire the store lease or directly read mutable store
internals.

### 8.2 Why an init process is required

The daemon supervises native child processes. Generic MCP launchers may not add Docker's `--init`
flag, so the image should include a tiny init such as `tini` as its entrypoint rather than relying
only on Compose's `init: true`. The init forwards signals and reaps orphaned descendants. The image
must still implement bounded application shutdown; init is not a substitute for it.

### 8.3 Store ownership

Exactly one daemon acquires the `FileWorkflowStore` owner lease for `/data/store`. A second daemon
using the same volume must fail readiness with an actionable owner-conflict error. It must not
start in a read-only observer mode unless that mode is designed around immutable snapshots; direct
concurrent reads currently interact with crash-tail repair and are not automatically safe.

### 8.4 Shutdown semantics

This requires a new lifecycle distinction:

| Trigger | Meaning | Required run outcome |
| --- | --- | --- |
| MCP `workflow_run_cancel` | User intentionally cancels one run | Durable `cancelled` |
| Administrative cancel-all | User intentionally cancels selected/all runs | Durable `cancelled` |
| Daemon SIGTERM/SIGINT | Host is stopping or upgrading | Quiesced/interrupted and eligible for safe recovery |
| Kernel/container kill | No graceful window | Existing startup repair and recovery path |
| Provider cannot confirm termination | Ownership cannot safely transfer in-process | Fail shutdown honestly; process exit remains final OS boundary |

**DECISION:** add a restart-safe daemon quiesce operation rather than calling the current explicit
`WorkflowService.stop()` cancellation path unchanged. The operation must:

1. stop accepting new run mutations;
2. wake long polls with a service-stopping signal;
3. request bounded provider termination;
4. persist an interruption/recovery boundary rather than user cancellation;
5. retain accurate ambiguity evidence for unsafe external effects;
6. release the store lease only when provider ownership can transfer safely; and
7. exit within a documented Docker stop grace period.

The implementation must settle the exact core API—perhaps `quiesceForRestart()` or a shutdown mode
argument—before the Docker daemon is considered production-safe.

## 9. Container filesystem contract

### 9.1 Fixed paths

| Path | Ownership | Mutability | Purpose |
| --- | --- | --- | --- |
| `/workspace` | bind mount | read-only by default | one scoped project |
| `/data/store` | named volume | read/write, mode 0700 | workflow manifests/events/artifacts |
| `/data/codex-home` | named volume or dedicated subvolume | read/write, mode 0700 | isolated Codex authentication/config |
| `/data/config` | named volume | read/write, mode 0700 | generated instance configuration |
| `/data/secrets` | named volume | read/write, mode 0700 | stable local API/MCP tokens |
| `/data/workspaces` | named volume | read/write | future durable isolated agent workspaces |
| `/run/workflow-mcp` | tmpfs | read/write | PID/socket/ephemeral coordination only |
| `/tmp` | tmpfs | read/write | bounded temporary files |
| application filesystem | image | read-only at runtime | executable and static web assets |

State versioning must be explicit. A small `/data/config/layout-version` or equivalent must prevent
a newer daemon from silently mutating an unknown layout.

### 9.2 Project mount policy

The default Compose file mounts `${WORKFLOW_MCP_PROJECT_DIR:-.}` at `/workspace` read-only.

An authoring override may make only `/workspace/.claude/workflows` writable when the host path can
be created safely. A separate, clearly named mutation profile may mount the complete workspace
read/write for agent edits. The CLI and UIs must display the active capability prominently.

Do not attempt to change ownership recursively on `/workspace`. On Linux that could rewrite host
ownership; on Docker Desktop it is unnecessary and expensive. Startup diagnostics should report
UID/GID and failed path access without mutating the project.

### 9.3 Derived images for project toolchains

The base image cannot promise access to host compilers or package managers. Publish an example:

```dockerfile
FROM docker.io/<owner>/workflow-mcp:0.1.0

USER root
# Install the toolchain required by this project and clean package-manager caches.
USER workflow
```

The base image should include only the tools required for Workflow MCP and broadly useful source
inspection: the pinned Node runtime, Codex runtime dependencies, Git, ripgrep, a POSIX shell,
certificate roots, and the init process. Every extra interpreter increases image size and security
maintenance and therefore needs a documented product reason.

## 10. Container image contract

### 10.1 Base and build

Use a multi-stage Dockerfile:

1. dependency stage with lockfile-enforced installs;
2. core build stage;
3. standalone web build stage;
4. standalone server/TUI build stage;
5. minimal Debian-slim-style runtime stage.

A distroless final image is not the initial target because Codex agents and diagnostic commands
need ordinary process, shell, certificate, and source-control facilities. Revisit only after live
provider and project-toolchain tests show it is viable.

### 10.2 User and permissions

- Run as a fixed non-root UID/GID, proposed `10001:10001`.
- Own `/data` in the image only as a mount point; initialize new volume directories narrowly.
- Never require privileged mode.
- Drop all Linux capabilities.
- Set `no-new-privileges`.
- Support a read-only root filesystem with tmpfs mounts for `/tmp` and `/run/workflow-mcp`.
- Never mount `/var/run/docker.sock`.

### 10.3 Entrypoint and default command

Proposed image metadata:

```dockerfile
ENTRYPOINT ["/usr/bin/tini", "--", "workflow-mcp"]
CMD ["serve", "--stdio", "/workspace"]
```

The STDIO default makes the image directly usable by generic OCI-aware MCP launchers. The Compose
file overrides the command with the durable daemon mode:

```yaml
command:
  - daemon
  - --host=0.0.0.0
  - --port=7331
  - --workspace=/workspace
  - --data-dir=/data
```

**OPEN:** verify whether Docker MCP Catalog submission expects a particular command declaration
that should override the image `CMD`. If it always declares an explicit command, prefer the daemon
as the image default for direct users. Record the result in an ADR before release candidate 1.

### 10.4 OCI metadata

The image must contain at least:

- `org.opencontainers.image.title`
- `org.opencontainers.image.description`
- `org.opencontainers.image.source`
- `org.opencontainers.image.revision`
- `org.opencontainers.image.version`
- `org.opencontainers.image.licenses`
- `io.modelcontextprotocol.server.name`

The MCP server's runtime version must be injected from the release version/revision rather than
remaining hard-coded as `0.0.0`.

## 11. Compose contract

Proposed base file:

```yaml
name: workflow-mcp

services:
  workflow-mcp:
    image: docker.io/<owner>/workflow-mcp:${WORKFLOW_MCP_VERSION:-0.1.0}
    command:
      - daemon
      - --host=0.0.0.0
      - --port=7331
      - --workspace=/workspace
      - --data-dir=/data
    restart: unless-stopped
    stop_grace_period: 120s
    ports:
      - 127.0.0.1:${WORKFLOW_MCP_PORT:-7331}:7331
    volumes:
      - workflow-mcp-data:/data
      - type: bind
        source: ${WORKFLOW_MCP_PROJECT_DIR:-.}
        target: /workspace
        read_only: true
    read_only: true
    tmpfs:
      - /tmp:size=256m,mode=1777
      - /run/workflow-mcp:size=16m,mode=0700
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    healthcheck:
      test: ["CMD", "workflow-mcp", "healthcheck"]
      interval: 10s
      timeout: 3s
      retries: 6
      start_period: 20s

volumes:
  workflow-mcp-data:
```

This is an illustrative target, not ready-to-copy configuration. CI must prove each hardening
option is compatible with Codex subprocesses, Git inspection, provider authentication, temporary
files, and clean shutdown before it becomes the published default.

### 11.1 Port behavior

The daemon listens on `0.0.0.0` inside the network namespace because container loopback is not
reachable through Docker port publication. Compose publishes it only on host `127.0.0.1`; an
unqualified `7331:7331` mapping would expose the service on every host interface by default.

Users running several project daemons choose distinct host ports through `WORKFLOW_MCP_PORT`.
Compose project names keep containers and volumes separate; the documentation must not prescribe a
fixed `container_name`, because that would prevent parallel projects.

### 11.2 Browser UI optionality

Version one may always serve the static web assets while treating browser use as optional. Keeping
one localhost port published is simpler than maintaining two nearly identical Compose topologies,
and the port is also useful for readiness and direct HTTP MCP.

If security review requires no published port by default, add a `compose.web.yaml` override that
adds the port. Do not create a second web container with a second workflow service.

## 12. CLI contract

### 12.1 Commands inside the image

Proposed stable surface:

```text
workflow-mcp daemon [options]
workflow-mcp serve --stdio [workspace]
workflow-mcp serve --http [workspace] [port]
workflow-mcp mcp-proxy [options]
workflow-mcp ui [options]
workflow-mcp status [--json]
workflow-mcp doctor [--json]
workflow-mcp healthcheck
workflow-mcp auth login
workflow-mcp auth status [--json]
workflow-mcp auth logout
workflow-mcp token show --purpose <mcp|web>
workflow-mcp validate <workflow.js>
workflow-mcp list [directory]
workflow-mcp run <workflow.js> [args-json]
workflow-mcp resume <claude-run.json> [workflow.js]
```

The legacy direct commands remain useful for development and one-shot automation. Documentation
must make clear that direct `run` is not managed by the long-lived daemon unless a future `--daemon`
mode is explicitly added.

### 12.2 Output discipline

- MCP proxy stdout is exclusively MCP JSON-RPC framing. All diagnostics go to stderr.
- `--json` produces one documented schema and no human prefixes.
- Human commands use actionable errors and name the failed path, permission, endpoint, or daemon
  state without printing tokens.
- Secret-showing commands require an interactive terminal unless `--force` is deliberately
  supplied for automation.
- CLI exit codes distinguish usage, unavailable daemon, authentication, policy rejection, and
  internal failure.

### 12.3 Host convenience command

Docker-first means the host does not need a `workflow-mcp` binary. The documented commands use
`docker compose` directly.

An optional thin host installer or npm package may later provide commands such as `workflow-mcp
docker init`, but it must only orchestrate Docker and write reviewed project files. It must not
become a second runtime implementation or a prerequisite for Codex connection.

## 13. Codex MCP integration

### 13.1 Preferred full-product connection: STDIO proxy

The project-local Codex configuration should launch a proxy inside the already-running Compose
service:

```toml
[mcp_servers.workflow_mcp]
command = "docker"
args = [
  "compose",
  "exec",
  "-T",
  "workflow-mcp",
  "workflow-mcp",
  "mcp-proxy"
]
```

Why this is preferred:

- Codex gets the broadly supported STDIO transport.
- The host does not need the Node package.
- The durable daemon remains alive when Codex exits.
- The host Codex config does not contain a bearer token.
- Compose scopes the connection to the current project service.

The proxy reads a container-local MCP token or uses a root-owned local channel, connects to the
daemon's MCP endpoint, and relays messages. It does not read the workflow store and does not create
a `WorkflowService`.

**OPEN acceptance question:** confirm with current Codex that a project-local MCP subprocess starts
with the project as its working directory so `docker compose` resolves the correct file. If not,
the installer must generate an explicit `--project-directory` or absolute `-f` path. Do not assume
this behavior from a manual test in only one Codex surface; verify CLI, IDE, and desktop where
supported.

### 13.2 Direct Streamable HTTP connection

Codex also supports Streamable HTTP and bearer-token environment variables. The secondary setup is:

```toml
[mcp_servers.workflow_mcp]
url = "http://127.0.0.1:7331/mcp"
bearer_token_env_var = "WORKFLOW_MCP_TOKEN"
```

This is appropriate for clients that cannot run `docker compose exec`, but onboarding must explain
how to obtain and export a stable token without putting it in a committed project configuration or
shell history.

### 13.3 MCP instructions

Codex consumes server instructions, and clients may truncate them. The existing instruction block
is detailed and valuable, but the first 512 characters should remain a self-contained summary of
the safe invocation loop. Add a test that guards the critical prefix separately from the full text.

### 13.4 Docker MCP Catalog mode

Catalog/Gateway mode launches the OCI image as an MCP server, normally over STDIO. That lifecycle
is not equivalent to the Compose daemon:

- ending the gateway can end the server container;
- persistent volumes and project mounts require catalog configuration;
- browser port publication is not the catalog's primary contract;
- a TUI cannot be assumed to have an attached terminal; and
- the gateway's documented default per-server resource limit is one CPU and 2 GiB, which may be
  too small for nine native Codex attempts.

The catalog entry must describe this as **MCP compatibility mode**. If supported, document
`docker mcp gateway run --long-lived` and persistent storage, but do not claim that it provides the
complete durable UI product. Consider a lower default concurrency for gateway-launched instances
or document the required gateway resource override.

## 14. Authentication and configuration isolation

### 14.1 Never mount the complete host Codex home

Mounting `~/.codex` would import unrelated MCP definitions, user settings, and possibly recursive
references back to Workflow MCP. It also makes provider recovery evidence dependent on mutable
host configuration outside the container.

**DECISION:** set `CODEX_HOME=/data/codex-home` and populate it only through supported container
commands or narrowly scoped secret import. The image and startup code must attest that no managed
or system Codex configuration is inherited before claiming MCP/tool isolation.

### 14.2 Supported credential paths

1. **Interactive Codex login:**

   ```bash
   docker compose exec workflow-mcp workflow-mcp auth login
   ```

   This must be validated on Linux Docker Engine and Docker Desktop because browser/device-login
   behavior may differ.

2. **API key secret:** Compose grants the service an explicit secret file. Startup passes the value
   to the provider without logging it or persisting it into workflow-visible files.

Ordinary environment variables may remain an emergency compatibility path, but published examples
should prefer Compose secrets for credentials.

### 14.3 Separate local tokens

Use distinct generated tokens for:

- MCP HTTP clients;
- web/control API clients; and
- future mutation-capable administration.

Tokens are created once with cryptographic randomness, stored mode 0600 under `/data/secrets`, and
survive container replacement. Rotation is explicit and invalidates existing clients. Tokens must
never appear in URLs, health responses, normal logs, HTML, event payloads, or diagnostics bundles.

## 15. Local HTTP and control API

### 15.1 Route groups

Proposed routes:

```text
GET  /healthz                         unauthenticated, no sensitive detail
GET  /readyz                          unauthenticated, coarse readiness only
POST /mcp                             bearer-authenticated Streamable HTTP MCP
GET  /api/v1/instance                 authenticated instance/capability summary
GET  /api/v1/runs                     authenticated run summaries
GET  /api/v1/runs/:runId              authenticated projected snapshot
GET  /api/v1/runs/:runId/events       authenticated cursor/long-poll events
GET  /api/v1/runs/:runId/result       authenticated bounded result pages
GET  /api/v1/runs/:runId/agents       authenticated agent summaries
GET  /api/v1/runs/:runId/agents/:id/result
GET  /api/v1/runs/:runId/agents/:id/transcript
GET  /                               static browser application
GET  /assets/*                        content-addressed static assets
```

Version-one browser and TUI APIs should be read-only. Workflow launch/cancel/resume already have a
defined MCP authorization surface; adding browser mutations requires a separate permission and
CSRF design. Read-only interfaces still require authentication because prompts, results, paths,
and transcripts are sensitive.

### 15.2 Reuse durable cursor semantics

Do not introduce WebSocket-owned state. The API should expose the same bounded event cursor and
long-poll behavior as `workflow_run_events`. A client reconstructs state with
`workflow-mcp/state`, remembers the last durable cursor, reconnects, and continues.

This preserves the product's central invariant: network connection state is disposable; the event
store is authoritative.

### 15.3 API DTO rules

- Reuse stable protocol/event types where they are browser-safe.
- Do not serialize internal filesystem paths unless the operator genuinely needs them.
- Use opaque artifact IDs, never arbitrary read paths.
- Bound page sizes, wait times, list sizes, and transcript sizes.
- Include a schema version and daemon version.
- Return structured error codes that the TUI and web UI can map consistently.
- Keep provider credentials and raw environment data out of every response.

### 15.4 Browser security

- Validate `Host` as well as `Origin`; do not rely only on the host's loopback port mapping.
- Permit only the configured loopback origins by default.
- Do not enable wildcard CORS.
- Set a restrictive Content Security Policy.
- Use `X-Content-Type-Options: nosniff` and deny framing.
- Keep bearer tokens in memory or session storage, not persistent local storage.
- Serve source maps only in development images.
- Redact secrets from errors and diagnostics.
- Require a separate design review before adding state-changing browser endpoints.

## 16. Terminal UI

### 16.1 Launch and lifetime

```bash
docker compose exec workflow-mcp workflow-mcp ui
```

Compose normally allocates a TTY for an interactive `exec`; documentation should include explicit
`docker exec -it` equivalents only as troubleshooting. The TUI exits cleanly on Ctrl-C and leaves
the daemon and all workflows untouched.

### 16.2 Version-one screens

1. Instance header: version, workspace, mount mode, auth status, daemon uptime, provider capacity.
2. Run list: status, workflow name, age, cursor, agent counts, error/coverage-gap indicator.
3. Run detail: phases, logical agents, attempt history, current activity, warnings, scheduler health.
4. Result reader: complete paginated run or agent output, never only bounded previews.
5. Transcript reader: paginated provider transcript through the service API.
6. Diagnostics view: quarantined histories, provider circuit state, store and recovery warnings.

### 16.3 Rendering architecture

Both UIs should consume a small shared client package that handles:

- authenticated requests;
- event cursor long polling;
- reconnect/backoff;
- version negotiation;
- state reduction; and
- bounded artifact/transcript paging.

The terminal and web renderers remain separate. Sharing API/state logic is useful; forcing DOM and
ANSI rendering through one component abstraction is not.

**OPEN:** select the TUI rendering library in a time-boxed spike. Criteria are maintained Node
support, deterministic testing, correct resize/alternate-screen cleanup, accessible non-color
fallback, dependency size, and license. The product contract must not depend on the choice.

## 17. Browser UI

### 17.1 Scope

The browser UI is an optional local dashboard, not a hosted web application. It is compiled into
static assets in the image and served by the daemon.

Version one is observational:

- list live and historical runs;
- show aggregate and phase progress;
- inspect logical agents and physical attempts;
- follow activity and warnings;
- read complete paginated results;
- read transcripts; and
- display recovery and configuration diagnostics.

Do not include a workflow editor, terminal emulator, arbitrary file browser, login secret manager,
or mutation buttons in the first slice.

### 17.2 State model

The web app imports only `workflow-mcp/state` from the core package. That entry is already designed
to exclude filesystem, process, MCP, and Codex SDK code from browser bundles.

On load:

1. fetch the current projected snapshot and cursor;
2. reduce subsequent durable events in sequence;
3. discard duplicates by cursor;
4. refetch the snapshot on a detected gap or schema mismatch; and
5. continue long polling after network or tab suspension.

### 17.3 Token onboarding

Initial release flow:

```bash
docker compose exec workflow-mcp workflow-mcp token show --purpose web
```

The browser presents a token-entry screen and holds the token for the tab session. A later one-time
fragment exchange and secure cookie flow may improve usability, but must not put a bearer token in
server request URLs or browser history.

## 18. Workflow source and write policy

### 18.1 Default safe mode

The project mount is read-only, agent sandbox mode is read-only, approval policy is `never`, and
agent tool network remains disabled unless product policy changes it deliberately. Existing visible
workflow files can be listed, validated, and run.

Inline workflow authoring is unavailable in this mode because it must persist a Claude-visible file
under `.claude/workflows`. The MCP response must state that authoring mode is disabled instead of
surfacing a generic `EROFS` error.

### 18.2 Workflow-authoring mode

An override may bind the project's `.claude/workflows` directory read/write while leaving the rest
of the project read-only. Startup must:

- verify that the host path maps to the expected canonical project subdirectory;
- reject symlink redirection;
- report that workflow definitions are writable; and
- preserve the existing no-overwrite and source-hash authorization rules.

The source-approval design must evolve beyond a startup-only set if newly authored sources are to
run immediately. A safe choice is a durable approval record keyed by canonical project identity and
source hash, granted only by an explicit local operator action. MCP-authored source must not approve
itself merely because it arrived through an authenticated model connection.

### 18.3 Full workspace mutation mode

Full project writes are a distinct profile. The TUI/web header and run records must show it. Safe
automatic replay remains constrained by existing external-effect and mutable-workspace evidence.

Git worktree isolation inside a container needs a dedicated later design: a read-only source bind
cannot create worktrees, and a worktree often needs writes to repository administrative state or a
sibling directory. Do not claim isolated mutation support until container restart, ownership,
cleanup, and host-repository behavior have system tests.

## 19. Network policy

There are two different networks and they must not be conflated:

1. the container needs outbound network access for the Codex provider to reach OpenAI; and
2. an agent's tool sandbox may deny network access to commands it runs.

Docker-level `--network=none` would also block the provider and is not a valid default. The runtime
must continue passing its explicit agent sandbox policy, while the container network is limited by
documented operator controls where practical. A Docker MCP Gateway `--block-network` configuration
is incompatible with an in-container remote Codex provider unless a separate provider path exists.

## 20. Configuration model

### 20.1 Precedence

Proposed order, highest first:

1. explicit CLI flag;
2. environment variable;
3. `/data/config/config.json` or TOML;
4. built-in safe default.

Secrets never belong in the ordinary config file. Every effective setting reported by `doctor`
should include its non-secret source.

### 20.2 Required settings

```text
workspace path                 /workspace
data directory                 /data
listen host                    0.0.0.0 in container daemon mode
listen port                    7331
provider concurrency           9 in full Compose mode
agent sandbox mode             read-only
agent approval policy          never
agent tool network             false
automatic recovery            enabled only where evidence permits
source authorization mode      fail closed
Codex home                     /data/codex-home
```

Do not turn environment variables into an untyped sprawl. Parse once into a validated immutable
configuration object and pass that through composition.

## 21. Health, diagnostics, and observability

### 21.1 Health meanings

- **Liveness** means the process can answer and its event loop is not wedged.
- **Readiness** means configuration is valid, the workspace boundary is established, the store
  lease is held, the store initialized, and the service accepts appropriate requests.
- Provider authentication may be reported as a degraded capability rather than making historical
  run inspection unavailable.

### 21.2 `doctor`

`workflow-mcp doctor` checks:

- CPU architecture and image version;
- workspace existence, canonical path, Git root, and read/write mode;
- `/data` ownership, free space, layout version, and lease state;
- ability to create and fsync a private probe in allowed state directories;
- isolated Codex home and absence of inherited MCP configuration;
- provider authentication status without making a billable model call;
- daemon endpoint and version compatibility;
- TTY/color capabilities for the TUI;
- configured concurrency versus detected CPU/memory guidance;
- published-port and origin configuration; and
- whether a newer state layout would make downgrade unsafe.

The JSON form is suitable for support bundles. It must redact credentials, tokens, prompts,
results, environment values, and private absolute host paths.

### 21.3 Logs and metrics

Default logs go to stdout/stderr for Docker collection and are structured enough to correlate:

- daemon instance;
- run;
- logical agent;
- physical attempt;
- MCP/control request; and
- recovery lineage.

Never log prompt/result bodies by default. A later OpenTelemetry export may use the existing
runtime's event identities, but adding an external telemetry destination is opt-in.

## 22. Release and distribution

### 22.1 Docker Hub

Initial repository placeholder:

```text
docker.io/<owner>/workflow-mcp
```

Tag policy:

- `0.1.0`: immutable release tag;
- `0.1`: movable compatible minor tag;
- `latest`: newest stable release;
- `edge`: optional main-branch build, clearly unsupported for durable production state.

Documentation and generated Compose files pin an exact semantic version or digest. They do not use
`latest` in reproducible examples.

### 22.2 Architectures

Publish one manifest list for `linux/amd64` and `linux/arm64`. CI must run an actual container smoke
test for both architectures; merely producing a manifest is insufficient because the Codex SDK or
bundled native executable may have architecture-specific packaging.

Emulation can validate startup for the non-native architecture, while scheduled/native runners
should cover at least one live Codex authentication/execution smoke before declaring that
architecture supported.

### 22.3 Supply-chain outputs

Release automation should produce:

- image digest;
- provenance attestation;
- SBOM;
- vulnerability scan result;
- source revision labels;
- signed image where the selected registry/signing workflow supports it; and
- release notes including state-layout and migration compatibility.

Pin build actions and base images according to repository policy. Rebuild regularly for base-image
security updates even when application code is unchanged.

### 22.4 Official MCP Registry

The official registry stores metadata; it does not host the image. Publish a `server.json` whose
OCI package points to the Docker Hub image and describes STDIO transport. Add the required
`io.modelcontextprotocol.server.name` OCI label with the final reverse-DNS-style server name.

Because the registry is Preview, validate metadata in CI but do not make installation depend on a
successful registry lookup.

### 22.5 Docker MCP Catalog

Submit only after the image command, secrets, volumes, supported architectures, and STDIO behavior
are stable. The catalog contribution should declare:

- the project workspace mount;
- persistent state volume;
- provider credential secret(s);
- the STDIO command;
- resource guidance; and
- the limitation that full TUI/web durability uses Compose.

Docker's registry contribution workflow can build an `mcp/*` image with Docker-managed signing,
provenance, and SBOM, or reference a maintainer image. Decide which identity is canonical before
submission so users do not face two undocumented images with different update policies.

### 22.6 npm

Npm is secondary. The core package is currently private and versioned `0.0.0`; Docker release does
not require changing that immediately. If a public npm package is later desired, its package
contract, binary ownership, native Codex dependency, and support policy need a separate release
decision.

## 23. Test strategy

### 23.1 Unit tests

- immutable config parsing and precedence;
- stable token create/read/rotate permissions;
- Host, Origin, bearer, and route authorization;
- daemon lifecycle state machine;
- shutdown mode mapping;
- API DTO redaction and page bounds;
- MCP proxy framing and stdout purity;
- shared client cursor/reconnect behavior;
- TUI state/view model;
- web reducer integration; and
- image version/OCI metadata generation.

### 23.2 Standalone system tests with fake provider

- daemon acquires one store lease and becomes ready;
- second daemon on the same data root fails closed;
- Codex-like MCP client connects through `mcp-proxy`;
- direct HTTP MCP still requires bearer auth;
- dropped MCP, TUI, and web clients do not stop a run;
- two UI clients see identical cursor-derived state;
- TUI exit leaves daemon and run alive;
- daemon replacement preserves historical results;
- SIGTERM creates recoverable interruption, not cancellation;
- SIGKILL recovery preserves existing single-writer and replay rules;
- corrupt one-run history is quarantined without losing service readiness;
- read-only mode rejects authoring with a policy error;
- authoring profile grants only its documented path;
- result and transcript paging never accepts raw paths; and
- tokens do not appear in logs or API payloads.

### 23.3 Docker contract tests

Build and run the actual image to prove:

- the final user is non-root;
- root filesystem can be read-only;
- only declared tmpfs and volume paths are written;
- no Docker socket is present;
- healthcheck transitions are correct;
- localhost host-port publication works;
- an unqualified remote interface is not published by the supplied Compose file;
- named-volume state survives container deletion/recreation;
- project bind is read-only by default;
- amd64 and arm64 entrypoints select functioning Codex binaries;
- signals reach and reap provider descendants;
- image contents omit tests, raw references, local state, source maps, and development secrets;
- OCI labels match the release; and
- the documented derived-image pattern can install and use a sample toolchain.

### 23.4 Browser tests

Use a real browser against a containerized fake-provider daemon:

- token gate;
- CSP and origin behavior;
- initial snapshot plus event continuation;
- reconnect after daemon restart;
- tab suspension/cursor continuation;
- large paginated run result;
- agent attempt/coverage-gap rendering;
- narrow and wide layouts; and
- no mutation controls in observational mode.

### 23.5 TUI tests

- deterministic rendering from recorded state snapshots;
- keyboard navigation;
- resize handling;
- non-color mode;
- terminal cleanup after normal exit and signal;
- daemon disconnect/reconnect;
- large result paging without loading all bytes; and
- no daemon shutdown on TUI exit.

### 23.6 Live and ecosystem tests

Keep live tests opt-in and credential-aware:

- isolated Codex login or API-key execution in the image;
- nine-agent measured concurrency on a documented resource class;
- current Codex CLI MCP connection through the proxy;
- current Codex direct Streamable HTTP connection;
- Docker MCP Gateway launch over STDIO;
- official MCP Registry metadata validation; and
- Docker MCP Catalog validation tooling when available.

## 24. Resource model

The full Compose product may preserve the current default concurrency of nine, but documentation
must state a recommended memory/CPU envelope based on measurement. Native Codex subprocesses are
not lightweight JavaScript promises.

At minimum record:

- idle daemon RSS;
- per-idle and active provider-host RSS;
- peak memory for nine agents;
- startup and shutdown latency;
- event-store write throughput;
- image compressed/uncompressed size; and
- UI polling overhead with several clients.

Catalog mode must not quietly use nine when the gateway grants one CPU and 2 GiB. Select a safe
mode-specific default or fail `doctor` with clear resource guidance.

## 25. Implementation slices

Each slice must leave main releasable and preserve the existing core test contract.

### Slice 0 — Freeze contracts and add decision records

Deliverables:

- this plan accepted as the live roadmap;
- ADR for standalone directory/package boundary;
- ADR for daemon-versus-catalog lifecycle;
- ADR for STDIO proxy connection;
- ADR for restart-safe shutdown semantics; and
- a current-state test that demonstrates explicit cancellation versus host stop.

Exit criteria:

- no unresolved ownership ambiguity;
- package dependency direction is agreed; and
- shutdown behavior is specified in event terms.

### Slice 1 — Isolated standalone package skeleton

Deliverables:

- `standalone/package.json`, build, typecheck, unit-test, and package checks;
- root scripts that invoke standalone checks without merging dependencies into Agent Code;
- immutable validated configuration;
- version injection; and
- placeholder `daemon`, `doctor`, `healthcheck`, and `status` commands.

Exit criteria:

- standalone imports only the public root package API;
- root package cannot import standalone code; and
- clean checkout runs both core and standalone checks.

### Slice 2 — Long-lived daemon and lifecycle

Deliverables:

- daemon composition root;
- fixed workspace scope and `/data` layout;
- stable token management;
- health/readiness endpoints;
- store lease failure diagnostics;
- bounded restart-safe quiesce; and
- fake-provider lifecycle system tests.

Exit criteria:

- SIGTERM and SIGKILL tests prove their distinct recovery paths;
- a UI/proxy process can exit without touching service ownership; and
- a second daemon cannot mutate the store.

### Slice 3 — MCP proxy and Codex onboarding

Deliverables:

- daemon-owned Streamable HTTP MCP endpoint;
- STDIO-to-daemon `mcp-proxy`;
- Codex project configuration template/generator;
- direct HTTP setup documentation;
- instruction-prefix compatibility test; and
- current Codex CLI smoke test.

Exit criteria:

- `docker compose exec -T ... mcp-proxy` passes the existing MCP tool suite;
- proxy stdout contains no diagnostic bytes; and
- disconnecting Codex does not stop a run.

### Slice 4 — Production container and Compose

Deliverables:

- multi-stage Dockerfile;
- baked init, non-root runtime, healthcheck;
- base and authoring Compose files;
- Docker contract test harness;
- documented derived image; and
- multi-architecture CI build without publication.

Exit criteria:

- read-only-root and read-only-project tests pass;
- volume replacement/recovery tests pass;
- image inventory contains only intended artifacts; and
- both target architectures start successfully.

### Slice 5 — Read-only control API and shared client

Deliverables:

- versioned authenticated `/api/v1` routes;
- client library with cursor continuation;
- DTO/redaction tests;
- Host/Origin/CSP hardening; and
- large-artifact pagination.

Exit criteria:

- no API path bypasses service scope or artifact IDs;
- multiple clients observe identical state; and
- long polls survive restart and cursor replay.

### Slice 6 — Terminal UI

Deliverables:

- TUI library spike and ADR;
- instance/run/detail/result/transcript/diagnostics views;
- resize, no-color, and disconnect behavior; and
- `docker compose exec` documentation.

Exit criteria:

- active run survives repeated TUI attach/detach;
- large output remains bounded in memory; and
- terminal state is restored on every tested exit path.

### Slice 7 — Browser UI

Deliverables:

- static application using `workflow-mcp/state` only from the core;
- token-entry session flow;
- run and agent inspection views;
- production asset embedding;
- real-browser system tests; and
- browser-specific security headers.

Exit criteria:

- UI reconstructs state after refresh/restart;
- source maps and secrets are absent from production assets; and
- version one exposes no mutating browser route or control.

### Slice 8 — Authentication and authoring profile

Deliverables:

- isolated `CODEX_HOME` initialization and evidence;
- interactive login and API-key secret paths;
- auth diagnostics;
- narrow writable workflow-definition profile;
- explicit durable source approval; and
- policy-focused UI messages.

Exit criteria:

- host `~/.codex` is never required or mounted;
- a source edit invalidates its approval;
- read-only mode never writes the project; and
- authoring mode cannot escape `.claude/workflows`.

### Slice 9 — Docker Hub release

Deliverables:

- release workflow with amd64/arm64 manifest;
- semantic tags and immutable digest;
- SBOM, provenance, scan, and signing decision;
- release notes/migration section; and
- clean-machine installation smoke test.

Exit criteria:

- a user can follow only the published standalone README;
- exact-tag Compose startup works on Linux and Docker Desktop;
- persistence survives an image update; and
- rollback behavior is documented and tested where supported.

### Slice 10 — Registry integrations

Deliverables:

- official MCP Registry `server.json` and OCI label validation;
- Docker MCP Catalog entry and secret/volume declarations;
- gateway resource/lifecycle documentation; and
- scheduled compatibility smoke tests.

Exit criteria:

- Registry installation reaches the STDIO MCP server;
- Catalog launch exposes the same thirteen tools; and
- neither integration is described as the full durable UI product unless it actually preserves
  daemon lifecycle, storage, and port access.

### Slice 11 — Optional mutation profile

This is intentionally last. It needs a separate threat model and acceptance plan covering durable
workspaces, Git metadata, replay ambiguity, cleanup, host UID/GID, and derived project toolchains.

It is not required for the first read-only Docker release.

## 26. Documentation deliverables

Before stable release, documentation must include:

- five-minute Compose quick start;
- Codex MCP configuration for proxy and HTTP modes;
- TUI and browser usage;
- authentication setup and rotation;
- safe/read-only, authoring, and mutation capability matrix;
- project toolchain derived-image guide;
- Docker Desktop versus Linux notes;
- multi-project port/project-name guide;
- storage backup, restore, upgrade, downgrade, and deletion guide;
- `doctor` troubleshooting matrix;
- Docker MCP Catalog limitations;
- official MCP Registry installation;
- security model and reporting policy; and
- compatibility/version table.

Every command in the quick start must run in CI or a release smoke script. Examples that contain a
placeholder must say so visibly.

## 27. Upgrade, backup, and recovery

### 27.1 State migrations

- Every durable layout has a version.
- Migrations are forward, transactional, and tested from every supported release.
- Backup is taken or explicitly recommended before a destructive migration.
- A migration failure leaves the previous bytes recoverable and readiness false.
- Release notes state the newest version to which downgrade remains safe.

### 27.2 Backup

Provide a daemon-quiesced volume export command. Copying live files while the event log and manifest
are between fsync/rename boundaries may create a misleading backup, even if startup repair can
handle normal crash tails.

The backup contract includes `/data/store`, `/data/config`, and optionally encrypted/explicitly
handled `/data/codex-home` and `/data/secrets`. Documentation must warn that those latter paths
contain credentials.

### 27.3 Removal

`docker compose down` removes containers and networks but not the named volume by default. Removing
the volume is a separate destructive command and documentation must state that it permanently
deletes runs, artifacts, tokens, configuration, and container-owned Codex login.

## 28. Security threat model summary

| Threat | Required control |
| --- | --- |
| Malicious website reaches localhost | bearer auth, Host/Origin validation, CSP, no wildcard CORS |
| Leaked web token controls workflows | version-one API read-only; separate future admin token |
| MCP client requests arbitrary files | fixed project scope, canonical path confinement, opaque artifacts |
| Workflow source changes after approval | approval keyed by canonical identity and source hash |
| Container compromise controls Docker host | no Docker socket, non-root, capabilities dropped |
| Host Codex configuration creates recursive MCP | isolated container `CODEX_HOME`, no whole-home mount |
| Two daemons execute same lineage | store lease/fencing and fail-closed readiness |
| Restart duplicates unsafe side effects | existing replay evidence and explicit recovery-required state |
| Token leaks through tooling | stable 0600 files, redaction, no URL/query/log placement |
| Writable bind corrupts host project | read-only default and separately named opt-in profiles |
| Supply-chain substitution | digests, provenance, SBOM, signing, pinned build inputs |

The restricted JavaScript workflow runtime and Codex sandbox reduce risk but are not treated as a
perfect hostile-code boundary. The container itself is a defense-in-depth boundary around the
service; a full writable project mount still grants meaningful access to host-owned source.

## 29. Risks and mitigations

### 29.1 Codex login does not work cleanly in a container

Mitigation: support API-key secret mode first, test device/browser login on every documented
platform, and make `doctor` detect incomplete login without a billable turn.

### 29.2 The Codex SDK or CLI native package is missing for an architecture

Mitigation: build and execute the actual final image on both architectures before publishing a
manifest. Do not infer support from TypeScript compilation.

### 29.3 Nine agents exceed common Docker Desktop resources

Mitigation: measure, expose concurrency configuration, warn in `doctor`, publish conservative
profiles, and use a lower default in constrained Catalog mode.

### 29.4 Compose STDIO proxy resolution depends on client working directory

Mitigation: verify every Codex surface; generate explicit `--project-directory` or compose path if
necessary; keep direct HTTP as a supported alternative.

### 29.5 Graceful Docker stop turns into permanent cancellation

Mitigation: implement and system-test restart-safe quiesce before calling the image durable.

### 29.6 A read-only project disappoints users expecting coding agents

Mitigation: state the mode prominently, ship the narrow authoring override, document the later
mutation profile, and return policy-specific errors instead of filesystem noise.

### 29.7 Two distribution images confuse users

Mitigation: declare one canonical Docker Hub identity. If Docker publishes an `mcp/*` image, explain
whether it is a verified mirror/build and how versions correspond.

### 29.8 UI development contaminates the core runtime

Mitigation: enforce the standalone directory and one-way dependency graph in test/build scripts;
web code imports only the browser-safe state entry.

## 30. Open decisions requiring explicit ADRs

1. Final Docker Hub organization and canonical image name.
2. Final official MCP reverse-DNS server name and case normalization.
3. Whether image `CMD` defaults to STDIO compatibility or durable daemon mode.
4. Exact restart-safe `WorkflowService` lifecycle API and event semantics.
5. Whether browser assets are served/published by default or through a Compose override.
6. TUI rendering library.
7. Stable token UX for direct HTTP Codex clients.
8. Codex login flow supported on each platform.
9. Minimum recommended CPU/memory and mode-specific concurrency defaults.
10. Whether standalone becomes an npm workspace/package or is built as a private subproject without
    changing the root package manager shape.
11. State layout and migration tool.
12. Canonical Docker MCP Catalog image ownership: maintainer image versus Docker-built `mcp/*`.
13. When, if ever, mutation controls enter the TUI or web UI.

An open item may not be answered implicitly by the first implementation patch. Record the decision
and why the rejected alternative fails a requirement.

## 31. Definition of done for the first stable Docker release

All items below are required:

- standalone product code and material are isolated under `standalone/`;
- the core package remains usable by Agent Code without standalone UI/container dependencies;
- one Compose daemon is the only durable service/store owner;
- Codex connects through the documented STDIO proxy and direct HTTP fallback;
- closing Codex, the TUI, or the browser does not stop workflows;
- SIGTERM, SIGKILL, restart, and upgrade recovery semantics are tested;
- project mount is read-only by default;
- container is non-root, capability-dropped, socket-free, and supports a read-only root filesystem;
- credentials use isolated Codex state or explicit secrets, never the whole host Codex home;
- TUI and browser inspect the same cursor-derived durable state;
- browser/API security controls pass system tests;
- amd64 and arm64 images are exercised, not merely built;
- Docker Hub publishes versioned multi-architecture artifacts with supply-chain metadata;
- clean-machine documentation is release-tested;
- exact state backup, migration, and destructive-removal behavior is documented; and
- registry/catalog metadata never overstates the lifecycle guarantees of session-bound STDIO mode.

## 32. Primary research sources

These are the official sources used for ecosystem and deployment decisions. They should be
rechecked near implementation and release because several surfaces are explicitly Beta, Early
Access, or Preview.

### Codex and MCP

- [OpenAI Codex MCP documentation](https://learn.chatgpt.com/docs/extend/mcp) — current Codex STDIO,
  Streamable HTTP, configuration, authentication, and project-config behavior.
- [MCP Registry quickstart](https://modelcontextprotocol.io/registry/quickstart) — registry Preview
  status and publication model.
- [MCP Registry package types](https://modelcontextprotocol.io/registry/package-types) — OCI package
  metadata, supported registries, STDIO transport, and required image label.

### Docker MCP ecosystem

- [Docker MCP Catalog and Toolkit](https://docs.docker.com/ai/mcp-catalog-and-toolkit/) — current
  product status and gateway/catalog model.
- [Docker MCP Catalog](https://docs.docker.com/ai/mcp-catalog-and-toolkit/catalog/) — containerized
  server catalog, provenance, SBOM, signing, and Docker Hub distribution.
- [Docker MCP Gateway](https://docs.docker.com/ai/mcp-catalog-and-toolkit/mcp-gateway/) — gateway role
  and client orchestration.
- [Docker MCP Gateway run reference](https://docs.docker.com/reference/cli/docker/mcp/gateway/run/)
  — long-lived mode, transports, resource defaults, network/secrets controls, and profiles.
- [Docker MCP CLI reference](https://docs.docker.com/ai/mcp-catalog-and-toolkit/cli/) — profiles,
  catalogs, OCI sharing, and `catalog://`, `docker://`, and file-backed server references.
- [Docker MCP Profiles](https://docs.docker.com/ai/mcp-catalog-and-toolkit/profiles/) — current Early
  Access profile behavior.
- [Docker MCP Registry contribution guide](https://github.com/docker/mcp-registry/blob/main/CONTRIBUTING.md)
  — local container server requirements, image ownership choices, secrets, volumes, validation, and
  review workflow.

### Docker runtime and release

- [Docker bind mounts](https://docs.docker.com/engine/storage/bind-mounts/) — daemon-host path
  semantics, default write access, read-only mounts, and Docker Desktop behavior.
- [Docker volumes](https://docs.docker.com/engine/storage/volumes/) — Docker-managed persistent
  state.
- [Docker port publishing](https://docs.docker.com/engine/network/port-publishing/) — all-interface
  publication defaults and loopback host binding.
- [Docker exec](https://docs.docker.com/reference/cli/docker/container/exec/) — interactive processes
  attached to a running container, which underpins the TUI lifecycle.
- [Docker run](https://docs.docker.com/reference/cli/docker/container/run/) — init and container
  runtime behavior.
- [Docker Compose secrets](https://docs.docker.com/reference/compose-file/secrets/) — explicit
  service grants and file-backed secrets.
- [Docker multi-stage builds](https://docs.docker.com/build/building/multi-stage/) — separating
  build dependencies from the runtime image.
- [Docker multi-platform GitHub Actions](https://docs.docker.com/build/ci/github-actions/multi-platform/)
  — Buildx/QEMU multi-platform publication workflow.

## 33. Repository evidence map

Future implementation should start from these current files:

| Concern | Current source of truth |
| --- | --- |
| CLI and standalone composition | `src/cli.ts` |
| STDIO and authenticated HTTP MCP | `src/standaloneServer.ts` |
| MCP tools and initialization instructions | `src/workflowMcp.ts` |
| Durable service ownership/recovery | `src/workflowService.ts` |
| Store lease, run layout, artifacts | `src/fileWorkflowStore.ts` |
| Store abstraction | `src/workflowStore.ts` |
| Browser-safe state projection | `src/state.ts`, `src/workflowState.ts` |
| Provider isolation and effects | `src/codexProvider.ts`, `src/processOwnedProviderHost.ts` |
| Scheduler/retries/timeouts | `src/workConservingScheduler.ts`, `src/executionReliability.ts` |
| Source discovery and authoring | `src/findWorkflows.ts`, `src/workflowAuthoring.ts` |
| HTTP security baseline test | `test/standaloneServer.system.test.ts` |
| Persistence/recovery tests | `test/fileWorkflowStore.system.test.ts`, `test/reliability.system.test.ts` |
| Package contract | `package.json`, `scripts/test-package.mjs`, `scripts/check-test-contract.mjs` |

This map is a starting point, not permission to couple the standalone product to private
implementation details. Public seams should stay small, reasoned, and tested.

## 34. Anticipated core seams and no-change zones

The standalone package should be implementable through a small number of explicit additions to the
core. These are anticipated changes, not pre-approved signatures; each must retain its existing
embedding behavior and tests.

| Core area | Anticipated seam | Why standalone needs it | Compatibility constraint |
| --- | --- | --- | --- |
| `WorkflowService` lifecycle | Restart-safe quiesce/shutdown mode | Container stop must not mean user cancellation | Existing explicit `stop()` callers retain documented behavior until deliberately migrated |
| MCP assembly | Public factory or registrar that can mount tools on a daemon-owned transport | Proxy/HTTP modes need the same tools without copying registration | One canonical tool list, schemas, and instructions |
| HTTP serving | Configurable bind address and composable route handling | Container listens on `0.0.0.0`; old direct server remains loopback-safe | Default for existing API stays `127.0.0.1` |
| Build metadata | Injected server/product version | OCI, health, MCP initialize, and UI must agree | Development builds report an explicit development revision, not a false release |
| Provider factory | Validated isolated Codex home/environment evidence | Container must prove it did not inherit host MCP configuration | Recovery fingerprint remains fail-closed |
| Run inventory/events | Daemon-facing read model using existing service/store contracts | TUI/web need historical and live runs | No direct raw-store access from clients |
| Source authorization | Durable operator-owned source-hash approvals | Authoring profile creates source after startup | Workflow source cannot approve itself |
| Browser protocol | Stable DTOs around existing snapshots/events | UI must avoid Node-only types and private paths | `workflow-mcp/state` remains browser-safe |

No-change zones for the first Docker release:

- the portable workflow language and metadata grammar;
- the thirteen MCP tool names and their source precedence;
- logical-agent versus physical-attempt identity;
- durable cursor semantics;
- single-writer fencing;
- artifact IDs instead of arbitrary read paths;
- replay-risk honesty for mutable or externally effectful work; and
- the dependency rule that browser consumers import only `workflow-mcp/state`.

If implementation pressure appears to require weakening one of these, stop the slice and write an
ADR. Container convenience is not sufficient reason to weaken a runtime correctness boundary.

## 35. Critical lifecycle sequences

### 35.1 Daemon startup

```text
PID 1/init starts daemon
  -> parse and validate configuration
  -> canonicalize /workspace and determine mount capabilities
  -> create/verify private /data directories and stable tokens
  -> verify isolated Codex configuration boundary
  -> reserve HTTP listener in not-ready state
  -> construct FileWorkflowStore and WorkflowService
  -> acquire store lease
  -> initialize/repair store and schedule evidence-safe recovery
  -> expose MCP/control routes
  -> mark readiness true
```

Reserving the listener before acquiring long-lived ownership avoids a daemon holding the store
lease and then discovering its configured port is unavailable. Until initialization succeeds, all
routes except coarse liveness/readiness return a bounded service-unavailable response. Any startup
failure closes the listener and releases only the lease generation that this initializer owns.

### 35.2 Codex MCP connection through the proxy

```text
Codex starts configured stdio command
  -> docker compose exec -T starts mcp-proxy in running container
  -> proxy obtains its container-local credential without printing it
  -> proxy opens daemon MCP transport
  -> MCP initialize returns canonical version + instructions + tools
  -> proxy relays JSON-RPC bytes until Codex disconnects
  -> proxy closes only its transport
  -> daemon, store lease, and workflows continue
```

The proxy must not buffer an unbounded stream, reinterpret tool payloads, or synthesize run state.
It is a transport adapter, not another control plane.

### 35.3 Browser/TUI reconstruction

```text
client authenticates
  -> GET projected run snapshot and durable cursor N
  -> render snapshot through shared DTO/state adapter
  -> long-poll events after N
  -> reduce strictly ordered events and advance cursor
  -> reconnect after timeout/disconnect/tab sleep
  -> refetch snapshot only on gap, version mismatch, or explicit compaction signal
```

This sequence keeps clients disposable and prevents an in-memory UI subscription from becoming the
source of truth.

### 35.4 Restart-safe shutdown

```text
daemon receives SIGTERM
  -> readiness false; reject new mutations
  -> notify/wake local clients that service is stopping
  -> quiesce active workflow evaluators and provider hosts
  -> persist interruption and replay evidence
  -> confirm descendants terminated or retain honest unsafe-ownership state
  -> flush bounded persistence work
  -> release store lease only when ownership transfer is safe
  -> close listener
  -> exit before Docker grace period
```

A hard kill at any point is handled by existing filesystem durability, tail repair, lease removal by
process death, and initialization recovery. Tests should inject termination between every durable
boundary that materially changes the next owner's decision.

## 36. Requirements traceability

| Requirement | Design owner | Primary verification |
| --- | --- | --- |
| One durable owner | Daemon composition + store lease | second-daemon and client-detach system tests |
| Docker-first, no host Node | OCI image + Compose + proxy | clean-machine install smoke |
| Project isolation | fixed `/workspace` scope | path-confinement and cross-project denial tests |
| Read-only default | Compose mount + sandbox policy | attempted-write system tests |
| Durable restart | `/data` volume + quiesce/recovery | SIGTERM/SIGKILL/recreate tests |
| Codex compatibility | STDIO proxy + HTTP endpoint | current Codex CLI/IDE/Desktop matrix where available |
| TUI does not own work | API client-only architecture | repeated attach/detach during live run |
| Optional local web UI | static assets + authenticated read API | real-browser container test |
| No host Codex recursion | isolated `CODEX_HOME` | configuration-evidence and negative inheritance tests |
| Stable MCP surface | canonical registrar | existing MCP suite through every transport |
| Multi-architecture release | Buildx manifest + native smoke | amd64/arm64 entrypoint/provider tests |
| Safe discovery integrations | Registry/Catalog metadata | validators and gateway smoke tests |
| Clean package boundary | `standalone/` dependency graph | build-time import-boundary check |
| Supportable operation | health, doctor, structured logs | failure-injection diagnostics assertions |

## 37. Planning handoff checklist

Before implementation starts, the next agent should:

1. read this plan, `README.md`, `docs/ARCHITECTURE.md`, and the status header of
   `docs/RELIABILITY_IMPLEMENTATION_PLAN.md`;
2. inspect the current code named in the repository evidence map rather than trusting line numbers;
3. recheck the official Codex, Docker MCP, and MCP Registry sources because their statuses are
   time-sensitive;
4. confirm the selected work begins at the first incomplete implementation slice;
5. add or update the relevant ADR before resolving an open decision in code;
6. preserve thick WHY comments for lifecycle, security, durability, and packaging decisions;
7. keep changes inside the standalone repository and product boundary; and
8. finish each slice with the documented tests and an update to this plan's status.

The plan should remain live until the first stable Docker release. Completed slices should be
marked with revision references; superseded decisions should remain readable with a pointer to the
replacement ADR rather than being silently rewritten out of history.
