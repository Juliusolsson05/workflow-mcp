# Docker-First Codex MCP Standalone Package

Status: Revised implementation plan after two four-agent adversarial rounds and post-edit verification

Date: 2026-07-23

Implementation branch: `feat/docker-first-standalone`

Release boundary: the standalone `workflow-mcp` repository, not the Agent Code application

Primary artifact: an OCI image published to Docker Hub

Installation unit: the image plus a version-matched, checksummed Compose bundle published as a
release asset and reproducible from the image

Primary runtime: one long-lived, project-scoped Docker Compose service

## 1. Purpose of this document

This is the implementation contract for turning the existing `workflow-mcp` runtime into a clean,
Docker-first Codex MCP product with three interfaces over one durable service:

1. an MCP interface for Codex and other MCP clients;
2. an interactive terminal UI launched with a Docker command; and
3. an optional local browser UI served by the same container.

The plan is intentionally larger than a normal feature note. A future maintainer should not have
to rediscover why Compose owns the durable service, why the TUI must be a client, how a
Docker MCP Catalog launch differs from the full product, or what security properties are lost by
mounting a host Codex home. It records product decisions, current-code evidence, proposed file
layout, commands, protocols, rollout slices, tests, release mechanics, and the decisions resolved
during implementation.

This document does not authorize a big-bang rewrite. The existing durable runtime is the asset.
The implementation should add a separately shaped product around it and move code only when a
specific boundary has tests and a compatibility path.

### 1.1 Implementation ledger

The implementation now exists on `feat/docker-first-standalone`; the plan remains normative for
release qualification and future migrations. Compact accepted decisions live in
[`standalone/docs/adr`](../standalone/docs/adr/README.md), while implementation WHYs remain beside
the enforcing code. This ledger distinguishes code-complete work from evidence that can exist only
on protected release infrastructure.

| Slice | Implementation status | Primary evidence |
| --- | --- | --- |
| 0–1 contracts/core durability | Implemented | ADRs; kernel owner/CLOEXEC helpers; lifecycle, cursor, index, migration, and writer-permit suites |
| 2–4 package/daemon/MCP | Implemented | isolated package boundary; daemon/admin/API servers; SDK-backed HTTP/STDIO conformance suites |
| 5 container/install | Implemented | fixed-UID hardened image; Compose overlays; POSIX/PowerShell launchers; reproducible bundle; final-image smoke |
| 6–8 API/TUI/web | Implemented; real-browser qualification pending | bounded read model; dependency-free ANSI TUI; hashed static browser app; auth/header/API/asset and DOM lifecycle tests |
| 9 auth/authoring | Implemented | API-key and broker paths; managed Codex isolation; hostile policy probe; two-step byte-exact approval |
| 10 release | Implemented, infrastructure qualification pending | build-once multi-arch workflow; native architecture smoke/scan; SBOM/provenance/signature; immutable bundle workflow |
| 11 registries | Implemented, publication pending | current MCP Registry schema validator; OCI ownership label; Docker Catalog template/tool inventory/limitations |
| 12 broad mutation | Deliberately deferred | outside the first read-only/narrow-authoring release contract |

Repository settings, Docker Hub namespace/tag immutability, protected environments, publication
accounts, real Docker Desktop runners, and a real-browser container run are external qualification
prerequisites: code can enforce and record their protocols but cannot truthfully claim evidence
that has not run in those environments. The
platform evidence protocol is [`standalone/docs/PLATFORM_VALIDATION.md`](../standalone/docs/PLATFORM_VALIDATION.md).
The 2026-07-23 owner audit found immutable GitHub releases disabled, no protected preflight or
publication environments, no tag ruleset, and no public Docker Hub repository, so release is
currently blocked. The exact
remediation and workflow attestation gate are recorded in
[`standalone/docs/RELEASE_PREREQUISITES.md`](../standalone/docs/RELEASE_PREREQUISITES.md).

## 2. Reading conventions

The labels below distinguish evidence from intention:

- **CURRENT** means the behavior exists on `workflow-mcp` `origin/main` at planning time.
- **DECISION** means this plan selects the behavior unless implementation evidence proves it
  infeasible.
- **PROPOSED** means the shape is expected but can change without violating the product contract.
- **OPEN** means implementation must resolve and record the answer before the dependent milestone.
- **GATE** means implementation must not enter the dependent slice until the requirement has an
  accepted design, failing-then-passing test evidence, and no unresolved data-safety ambiguity.

Normative words have their usual meaning: **must** is required for release, **should** is the
preferred tradeoff, and **may** is optional.

## 3. Executive decision

**DECISION:** the complete product is a long-running, per-project Compose application. One daemon is
the only owner of `WorkflowService`, the durable store, provider processes, and recovery. Codex,
the TUI, and the browser are clients of that daemon. The distributable product is not the image
alone: clean-machine installation requires the exact Compose contract, launcher metadata, and
checksums that match that image version.

```text
Codex
  │ MCP stdio
  ▼
mcp-proxy (protocol adapter) ────────────┐
                                         │
Terminal UI ── authenticated local API ──┼──> workflow-mcp daemon
                                         │          │
Browser UI ── authenticated HTTP API ────┘          ├──> FileWorkflowStore on /data
                                                    ├──> workflow workers
                                                    └──> isolated Codex provider execution boundary
```

The user-facing lifecycle is:

```bash
# Start or recover the project service through the versioned launcher. It supplies an absolute
# Compose file, a stable per-project name, and an absolute project bind.
./workflow-mcp-docker up

# Paint an interactive terminal UI without creating another workflow owner.
./workflow-mcp-docker ui

# Open the optional browser dashboard.
# http://127.0.0.1:7331

# Stop the service. A later start may recover safely interrupted work.
./workflow-mcp-docker down
```

The launcher is a reviewed POSIX/PowerShell release asset, not a second runtime. It only resolves
the installation directory and canonical project path, supplies `-f`, `-p`, and
`--project-directory`, and invokes Docker Compose. The product must not require a global Node
installation, a globally installed npm package, or Docker Desktop's MCP Toolkit. Those can be
optional conveniences, not prerequisites.

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

**DECISION:** Docker Hub is the canonical image registry, while versioned GitHub Release assets
carry the Compose bundle. Docker MCP Catalog and the official MCP Registry are downstream
discovery integrations. Neither is allowed to define the full product's state, mount, credential,
or lifecycle contract.

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

1. pull a versioned image on Linux amd64, Linux arm64, Intel macOS through Docker Desktop, Apple
   Silicon macOS through Docker Desktop, and x86-64 Windows through Docker Desktop/WSL2;
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
    single command;
11. install without cloning the source repository and without guessing how to obtain a compatible
    Compose file;
12. run two installations for two projects without sharing a container, network, volume, token,
    approval, or recovery lineage; and
13. receive a fail-closed error, rather than duplicate execution, when another container already
    owns the same durable state;
14. remove the generated Codex entry and local installation material without accidentally deleting
    durable state; and
15. use the published PowerShell launcher on a declared Windows Docker Desktop support tier, rather
    than mistaking an untested script for a platform promise.

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

The adversarial review also established the following **CURRENT** correctness gaps that must be
fixed before the container daemon is allowed to claim durability:

- the store owner lease decides liveness using a PID and `ps`, which is invalid across container
  PID namespaces;
- shutdown has only initialized/stopped booleans and can race newly admitted mutations across its
  active-run snapshot;
- `CodexAgentProvider` can classify replay safety but does not expose the complete deterministic
  recovery fingerprint required for automatic restart recovery;
- a private `CODEX_HOME` does not suppress trusted-project `.codex/config.toml`, hooks, or rules;
- file-backed Codex authentication is copied per attempt without a standalone single-owner refresh
  broker;
- a future event cursor is accepted and echoed, which can strand a client until the durable stream
  catches up;
- the app-host inventory reads every manifest and returns internal absolute paths; and
- store initialization may repair bytes before a future layout migration has been selected.

These are core-runtime prerequisites, not standalone-package conveniences. Section 25 places them
before the daemon, proxy, and UI slices.

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
│   │   ├── Dockerfile.dockerignore
│   │   ├── Dockerfile.example-toolchain
│   │   ├── entrypoint.sh
│   │   └── docker-bake.hcl
│   ├── compose.yaml
│   ├── compose.web.yaml
│   ├── compose.authoring.yaml
│   ├── compose.auth-api-key.yaml
│   ├── install/
│   │   ├── workflow-mcp-docker
│   │   ├── workflow-mcp-docker.ps1
│   │   └── SHA256SUMS.template
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

**DECISION:** the Docker build context is the repository root so the image can build the core and
standalone packages from one audited source tree. Because Docker reads ignore rules from the
context root or a Dockerfile-specific sibling, `standalone/docker/Dockerfile.dockerignore` is the
normative ignore file. A generic `standalone/.dockerignore` would be ignored with this context and
must not be used as a security boundary.

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

The smallest candidate deployment contains one service container. Inside it:

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

Those processes are clients. They do not acquire the installation lock or directly read mutable store
internals.

**GATE:** “one container” is not a product invariant. The invariant is one durable workflow owner.
If Slice 0 proves that provider commands cannot be isolated from daemon credentials/control under
one UID/container, the final Compose application must add a narrowly scoped provider/broker service
or other kernel boundary. That service may execute attempts but may not become a second
`WorkflowService` or direct store owner. The executive diagram is logical; the security-topology ADR
owns the final container/process placement before Compose freezes.

**RESOLUTION:** the final image passed the one-container gate with Codex's managed Bubblewrap PID
namespace plus the generated deny policy, the Compose-only project `.codex` mask (and fail-closed
absence requirement in Catalog mode), private Codex home, disabled
network, and a release-blocking hostile probe that attempts token access and a detached `setsid`
escape. The daemon/admin capability is outside that managed mount namespace. The shared Unix UID is
therefore not presented as the boundary; if the pinned Codex mechanism stops enforcing the probe,
the image fails release and the separate-provider-service branch above becomes mandatory.

### 8.2 Why an init process is required

The daemon supervises native child processes. Generic MCP launchers may not add Docker's `--init`
flag, so the image should include a tiny init such as `tini` as its entrypoint rather than relying
only on Compose's `init: true`. The init forwards signals and reaps orphaned descendants. The image
must still implement bounded application shutdown; init is not a substitute for it.

An init process and process groups are also not a lifetime boundary for an attempt. A command can
double-fork, call `setsid`, ignore termination, keep an inherited file descriptor open, or leave a
grandchild after its provider-host exits. **GATE — per-attempt kernel containment:** Slice 0 must
prototype a cgroup, delegated sub-cgroup, PID-namespace, or equivalently kernel-enforced mechanism
under the exact non-root, capability-dropped, rootless, and Docker Desktop topology. The daemon must
be able to enumerate and terminate every descendant of a physical attempt and prove capacity is not
released until all of them are gone. If no reviewed mechanism survives the final hardening profile,
the long-lived daemon is unsupported; `tini` plus best-effort process-group signalling is not an
acceptable durability claim.

### 8.3 Store ownership

Exactly one daemon acquires the installation owner lease for all durable state under `/data`, not
only `/data/store`. A second daemon or a direct-STDIO server using the same volume must fail
readiness with a typed actionable owner-conflict error. It must not start in a read-only observer
mode unless that mode is designed around immutable snapshots; direct
concurrent reads currently interact with crash-tail repair and are not automatically safe.

**GATE — replace PID-liveness ownership before daemon work:** the current lock-directory scheme
uses `process.pid`, `process.kill(pid, 0)`, and `ps`. A PID is meaningful only inside its PID
namespace, so a contender in another container can classify a live owner as stale. The token check
reduces stale writes but does not prevent the new owner from recovering or executing while the old
provider is still alive.

The Linux container backend must instead hold a non-blocking exclusive `flock(2)` on one dedicated,
immutable coordination file for the owner lifetime. That file lives outside every migratable,
restorable, replaceable, or garbage-collected data generation; its pathname and inode are never
unlinked, renamed, or replaced. Open it with `O_RDWR|O_CREAT|O_CLOEXEC|O_NOFOLLOW`, then `fstat`
that it is an owner-only regular file before taking `LOCK_EX|LOCK_NB`. No provider, worker, UI,
maintenance, or other child may inherit the descriptor. Kernel release on the final descriptor
close or owner/container death is the liveness authority. PID, process-start time, owner ID, image
revision, and acquisition time belong in separate replaceable diagnostic metadata and are never
used to break the lock. The owner periodically compares the descriptor and path device/inode; a
mismatch transitions the service to `FAILED` and closes admission rather than continuing on an
orphaned inode.

The implementation may use a small audited native binding or another equally direct mechanism,
but it must not emulate liveness with timestamps, heartbeats, rename-only locks, or a helper process
that can outlive the daemon. The Linux `flock` backend is injected behind the existing lease seam;
Agent Code and other non-container embedders retain the current supported cross-platform backend.
Adding restart-safe `quiesce()` is likewise additive and does not silently redefine the existing
explicit-cancellation semantics of `stop()`.

Version one supports this lease only on a verified ordinary local named volume under the local
Linux kernel/Docker Desktop VM. The word `local` is insufficient by itself: Docker's local driver
can be configured with NFS, CIFS, bind, and other mount options. The launcher resolves the exact
Compose volume, inspects its driver/options/labels, initially accepts only `Driver=local` with an
empty reviewed option set, and passes an attestation to startup. The daemon independently inspects
mount information/filesystem type and runs a real two-process non-blocking-lock probe before
readiness. NFS, SMB, clustered, remote, optioned-local, and third-party drivers fail closed until
their lock and durability semantics receive explicit support. Raw Compose usage must provide the
same attestation or is diagnosed as unsupported; this does not justify mounting the Docker socket.

The kernel lock is the cross-process fence. A token comparison is durable generation evidence, not
a compare-and-swap primitive for ordinary filesystem calls. Every persistent syscall must execute
through a lease-scoped writer permit held from the first `open`/write through the final file and
parent-directory `fsync`. Quiesce first closes the writer gate, drains every issued permit, and only
then may release the kernel lock. No caller can mint or retain a permit after its generation ends.

The audit includes run creation, event append, result and agent-result persistence, manifest repair,
journal migration, transcripts, artifacts, indexes, approvals, tokens, configuration, backup,
credential-broker state, and any future durable path. `PersistentWorkflowJournal` must sit behind
the store/write coordinator or receive an unforgeable permit. **CURRENT:** the journal's synchronous
atomic-write helpers have no lease token, writer permit, or coordinator at all. More generally, even
a token check before a chain of filesystem calls would be insufficient. Deterministic fault hooks
pause before and after every authoritative open, write, `fsync`, rename, and directory `fsync` so
takeover/quiesce tests can prove a stale writer never resumes into a new generation.

### 8.4 Shutdown semantics

This requires a new lifecycle distinction:

| Trigger | Meaning | Required run outcome |
| --- | --- | --- |
| MCP `workflow_run_cancel` | User intentionally cancels one run | Durable `cancelled` |
| Administrative cancel-all | User intentionally cancels selected/all runs | Durable `cancelled` |
| Daemon SIGTERM/SIGINT | Host is stopping or upgrading | Quiesced/interrupted and eligible for safe recovery |
| Kernel/container kill | No graceful window | Existing startup repair and recovery path |
| Provider cannot confirm termination | Ownership cannot safely transfer in-process | Fail shutdown honestly; process exit remains final OS boundary |

**GATE — explicit service lifecycle and mutation admission:** replace the initialized/stopped
booleans with a single state machine:

```text
NEW -> INITIALIZING -> READY -> QUIESCING -> STOPPED
          |              |          |
          +-----------> FAILED <-----+
```

Every externally initiated mutation—start, resume, cancel, source approval, token rotation, backup,
and future administration—must enter one admission barrier before its first await and leave it in a
`finally` block. Transitioning to `QUIESCING` atomically closes admission, then waits for already
admitted operations either to register their owned run/provider or unwind. A one-time
`#assertAvailable()` before asynchronous source resolution does not satisfy this requirement.

**DECISION:** add a restart-safe daemon quiesce operation rather than calling the current explicit
`WorkflowService.stop()` cancellation path unchanged. The operation must:

1. stop accepting new run mutations;
2. wake long polls with a service-stopping signal;
3. request bounded provider termination;
4. persist an interruption/recovery boundary rather than user cancellation;
5. retain accurate ambiguity evidence for unsafe external effects;
6. release the installation lock only when provider and persistent-writer ownership can transfer
   safely; and
7. exit within a documented Docker stop grace period.

The first supported budget is 90 seconds for provider termination plus writer-permit drain inside
the published 120-second Docker grace period, reserving 30 seconds for final durable flush, listener
close, and process exit. Measurement may lower the default, but configuration may never erase the
reserve or report success while descendants or writer permits remain. A timeout leaves an honest
unclean-interruption record and process exit, not a false clean handoff.

Restart interruption must be owned by the workflow runtime so the final evaluator/provider event
sequence remains single-authored. It must not be synthesized concurrently by `WorkflowService`
while `runWorkflow()` still owns sequence numbers. User cancellation and restart interruption
remain observably different events and terminal states. A timed-out descendant which cannot be
proven dead keeps the fence until process exit; the daemon must not report a clean transferable
shutdown merely because its direct child promise settled.

Long polls awakened by quiesce return a typed `service-stopping` outcome and never masquerade as an
ordinary empty event page. The implementation must settle the exact core API and event vocabulary
in an ADR before the daemon is considered production-safe.

## 9. Container filesystem contract

### 9.1 Fixed paths

| Path | Ownership | Mutability | Purpose |
| --- | --- | --- | --- |
| `/workspace` | bind mount | read-only by default | one scoped project |
| `/data/.coordination/owner.lock` | named volume | immutable inode, mode 0600 | installation-wide kernel lock; excluded from payload operations |
| `/data/.coordination/owner.json` | named volume | replaceable, mode 0600 | non-authoritative owner diagnostics |
| `/data/store` | named volume | read/write, mode 0700 | selected workflow-state generation |
| `/data/codex-home` | named volume or dedicated subvolume | read/write, mode 0700 | isolated Codex authentication/config |
| `/data/config` | named volume | read/write, mode 0700 | generated instance configuration |
| `/data/secrets` | named volume | read/write, mode 0700 | stable local API/MCP tokens |
| `/data/workspaces` | named volume | read/write | future durable isolated agent workspaces |
| `/run/workflow-mcp` | tmpfs | read/write | PID/socket/ephemeral coordination only |
| `/tmp` | tmpfs | read/write | bounded temporary files |
| `/dev/shm` | container-runtime tmpfs | read/write, bounded | ephemeral shared memory only; never durable state |
| application filesystem | image | read-only at runtime | executable and static web assets |

State versioning must be explicit. One global layout definition enumerates every subordinate format,
including store, journal, indexes, approvals, tokens, configuration, and credential-broker state.
A single durable selector/transaction record points at the active same-filesystem generation; its
version is not duplicated across independently mutable files. A newer daemon therefore cannot
silently mutate an unknown layout, and ordinary readers may not perform lazy migrations.

The image sets one installation-root contract, `WORKFLOW_MCP_DATA_DIR=/data`, for daemon and direct
STDIO modes; `/data/store` and all other durable paths derive from it. The CLI flag is
`--data-dir=/data` in both modes. Switching transports inside the same mounted installation must
not silently switch to `~/.workflow-mcp`, and simultaneous daemon/direct-STDIO ownership fails with
the same typed conflict. A Catalog/Gateway launch without a declared persistent volume is
explicitly ephemeral and must emit a durability warning in startup diagnostics as well as docs.

Layout inspection precedes ordinary store initialization:

```text
acquire kernel lock
  -> read layout/version without repair or schema mutation
  -> reject unknown-newer layouts
  -> choose no-op or whole-layout transactional migration
  -> stage and fsync a complete same-filesystem generation
  -> atomically switch and directory-fsync one selector/transaction record
  -> deterministically resume or roll back an interrupted switch
  -> initialize/repair the selected current layout
  -> recover runs
```

No constructor or `initialize()` call may create, repair, or rewrite old-layout state before the
migration decision. Staging cleanup happens only after reopening and validating the selected
generation. Migration and backup tests inject failure between every stage, `fsync`, rename,
selector commit, reopen, and cleanup boundary. The coordination directory and immutable lock inode
are never part of a generation and are excluded from migration, restore, and garbage collection.

### 9.2 Project mount policy

The published Compose file requires an absolute `WORKFLOW_MCP_PROJECT_DIR`; it does not default to
`.`. The launcher canonicalizes the selected project on the host, rejects a remote Docker context,
and supplies that absolute path at `/workspace` read-only. This avoids Compose resolving a relative
bind from the Compose file's directory instead of the user's intended project.

An authoring override may make only `/workspace/.claude/workflows` writable when the host path can
be created safely. A separate, clearly named mutation profile may mount the complete workspace
read/write for agent edits. The CLI and UIs must display the active capability prominently.

Do not attempt to change ownership recursively on `/workspace`. On Linux that could rewrite host
ownership; on Docker Desktop it is unnecessary and expensive. Startup diagnostics should report
UID/GID and failed path access without mutating the project.

The fixed runtime identity `10001:10001` is an image identity and a safe default for read-only
inspection, not a promise that host authoring binds are writable. Before enabling authoring, the
launcher and a one-shot container perform real create/write/rename/file-fsync/directory-fsync/delete
probes under the effective user-namespace mapping. The selected design may use deliberate host ACLs,
a documented dynamic UID/GID variant, or a narrow broker; it may not recursively chown the project.
If no design passes rootful, rootless, and Docker Desktop tests without surprising host ownership,
Linux host authoring is deferred rather than run as root. The supported-platform matrix must state
how ordinary Linux, rootless Docker, Docker Desktop, owner-only repositories, and supplementary
groups behave. `doctor` must fail with an
actionable message when `/workspace` cannot be traversed/read or `/data` cannot be written. It must
never repair those conditions by starting the daemon as root or recursively changing a host bind.

Every `/data` subdirectory is pre-created and owned by `10001:10001` in the image so a fresh named
volume is populated with the correct contract. Restored, pre-created empty, and wrong-owner volumes
require an explicit one-shot repair/migration command whose target is the resolved Workflow MCP
volume only. Repair requires the daemon stopped, re-verifies the instance/volume labels, uses the
pinned image digest with no network and no workspace mount, and runs root only with the minimum
`CHOWN`/`FOWNER` capability needed for the named-volume payload. It is never privileged and never
part of normal daemon startup. Rootful, rootless, restored, mislabeled, wrong-instance, and partially
wrong-owned cases prove both the allowed repair and every refusal. System Git configuration may add
exactly `/workspace` as `safe.directory` after the launcher has established it as the project root;
wildcard trust is forbidden.

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
certificate roots, `bubblewrap`, and the init process. Every extra interpreter increases image size
and security maintenance and therefore needs a documented product reason.

`bubblewrap` is normative for the Linux image, not an inferred transitive dependency. The bundled
Codex fallback depends on unprivileged user namespaces, whose interaction with Docker seccomp and
host policy varies. The final-image gate must prove the exact pinned Codex runtime starts under the
published `cap_drop`, `no-new-privileges`, default seccomp, read-only-root, and tmpfs settings while
keeping provider egress available and agent shell network/project writes denied. Privileged mode,
`seccomp=unconfined`, and `danger-full-access` are not acceptable compatibility fixes.

## 10. Container image contract

### 10.1 Base and build

Use a multi-stage Dockerfile:

1. dependency stage with lockfile-enforced installs;
2. core build stage;
3. standalone web build stage;
4. standalone server/TUI build stage;
5. minimal Alpine/musl runtime stage using Codex's native musl artifacts.

The repository root is the sole build context and
`standalone/docker/Dockerfile.dockerignore` is the ignore contract. Base images are pinned by
digest with a human-readable version comment. Production dependencies containing native or
architecture-specific optional packages are installed/pruned for `$TARGETPLATFORM`; a
`$BUILDPLATFORM` `node_modules` tree must never be copied blindly into the final image. Each
manifest member runs both `codex --version` and an SDK-launched fake/safe provider startup check.

A distroless final image is not the initial target because Codex agents and diagnostic commands
need ordinary process, shell, certificate, and source-control facilities. Revisit only after live
provider and project-toolchain tests show it is viable.

### 10.2 User and permissions

- Run as a fixed non-root UID/GID, proposed `10001:10001`.
- Pre-create and own the documented `/data` directory tree as `10001:10001`, mode 0700 where
  private, so Docker's fresh-volume copy-up produces writable state without a root entrypoint.
- Never require privileged mode.
- Drop all Linux capabilities.
- Set `no-new-privileges`.
- Support a read-only root filesystem with tmpfs mounts for `/tmp` and `/run/workflow-mcp`.
- Never mount `/var/run/docker.sock`.

### 10.3 Entrypoint and default command

Proposed image metadata:

```dockerfile
ENTRYPOINT ["/sbin/tini", "--", "workflow-mcp"]
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

**DECISION:** retain STDIO as the image default for generic OCI and registry compatibility, but
rebuild it on the same standalone composition root as daemon mode. It must use the same `/data`
layout, source mode, Codex isolation, provider fingerprint, instructions, version injection, and
shutdown discipline; the only intentional difference is that its service lifetime belongs to the
STDIO client. The old root CLI composition is not an acceptable image default. Compose continues
to override `CMD` with `daemon`.

Docker Catalog metadata may declare an explicit command. CI must compare that command with the
image entrypoint and run a real tool call in both forms so a catalog override cannot select a
legacy or policy-incomplete path.

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

One generated build-metadata module is authoritative for package diagnostics, MCP initialize,
health/doctor, OCI labels, Compose bundle naming, Registry metadata, Catalog metadata, the Codex
SDK version, the `@modelcontextprotocol/sdk` version, and the MCP protocol revision(s) the build has
actually negotiated in conformance tests. The implementation and each release recheck the current
stable MCP specification and pinned SDK; a future release-candidate protocol revision is not
accepted merely because it exists. The existing `package.json`/`CODEX_SDK_VERSION` mismatch is a
release blocker, not a cosmetic diagnostic discrepancy.

**CURRENT at plan date:** this repository pins `@modelcontextprotocol/sdk` 1.29.0, which is also the
current stable v1 package, and the MCP documentation names `2025-11-25` as the current protocol.
The TypeScript SDK's v2 packages and `2026-07-28` wire are prerelease. Treat them as a compatibility
watch item, not a silent upgrade target; stable support changes only through the recorded
conformance/negotiation gate.

## 11. Compose contract

Proposed base file:

```yaml
services:
  workflow-mcp:
    image: ${WORKFLOW_MCP_IMAGE:?set by the versioned installation bundle}
    user: "10001:10001"
    command:
      - daemon
      - --host=0.0.0.0
      - --port=7331
      - --workspace=/workspace
      - --data-dir=/data
    restart: unless-stopped
    stop_grace_period: 120s
    expose:
      - "7331"
    volumes:
      - workflow-mcp-data:/data
      - type: bind
        source: ${WORKFLOW_MCP_PROJECT_DIR:?absolute project path required}
        target: /workspace
        read_only: true
        bind:
          create_host_path: false
    read_only: true
    tmpfs:
      - /tmp:size=256m,mode=1777
      - /run/workflow-mcp:size=16m,mode=0700,uid=10001,gid=10001
    shm_size: 64m
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
    pids_limit: ${WORKFLOW_MCP_PIDS_LIMIT:-512}
    logging:
      driver: local
      options:
        max-size: "10m"
        max-file: "5"

volumes:
  workflow-mcp-data:
```

This is an illustrative target, not ready-to-copy configuration. CI must prove each hardening
option is compatible with Codex subprocesses, Git inspection, provider authentication, temporary
files, and clean shutdown before it becomes the published default.

The top-level Compose `name` is intentionally absent. The canonical installation directory is
`<project>/.workflow-mcp/`; onboarding creates it with a self-contained ignore rule, proves it with
`git check-ignore`, and never silently edits a user's tracked root `.gitignore`. It rejects any
secret material in the directory. The directory contains only the public version-matched Compose/
launcher bundle and a non-secret `instance.json`. The launcher creates a stable random installation
ID once, stores it in
that owner-only uncommitted instance file (`0600` on POSIX and a current-user ACL on Windows),
derives a valid `COMPOSE_PROJECT_NAME`, and passes the same explicit `-p` value to every `up`,
`down`, `exec`, `logs`, `backup`, `restore`, `auth`, and MCP-proxy command. Copying an installation
requires generating a new ID unless the operator explicitly intends to move the same instance.
The generated Codex MCP entry contains that project name and the absolute Compose path, so it
cannot attach to whichever similarly named project happens to be in the launch directory.

The instance schema is versioned and records the instance ID, canonical project identity, and
Docker context/daemon identity. The daemon identity is a domain-separated digest of Docker
`/info.ID`, because a context name and endpoint can survive an Engine reset. The named volume
carries the instance ID plus non-sensitive project-identity and daemon-identity hashes in
reverse-DNS labels. Every launcher command resolves and compares the instance file, volume labels,
project path, active Docker context, and current daemon fingerprint before acting. A missing or
copied file beside labeled state fails closed. Version one implements random identity creation plus
same-canonical-project `--adopt-instance`; cross-path/context moves are explicitly unsupported
because changing the project-hash label would otherwise turn relocation into an ownership bypass.
The launcher never silently regenerates identity around an existing labeled volume.

The published constrained profile is one concurrent attempt, 1 CPU, 2 GiB, 512 PIDs, 64 MiB shared
memory, and 256 MiB tmpfs. Readiness reads cgroup v1/v2 CPU and memory limits and refuses a profile
smaller than one CPU plus `(concurrency + 1)` GiB. Higher concurrency remains unsupported unless
all three operator-set values are raised together and qualified; the runtime never claims that the
core library's historical capacity of nine fits a default Docker Desktop allocation. Bounded
local-driver logs and state-retention/disk-full behavior remain release requirements.

### 11.1 Port behavior

The daemon listens on `0.0.0.0` inside the network namespace because container loopback is not
reachable through Docker port publication. When the web/direct-HTTP override is selected, Compose
publishes it only on host `127.0.0.1`; an unqualified `7331:7331` mapping would expose the service
on every host interface by default.

Users running several project daemons choose distinct explicit ports with `--web-port`. Version one
does not publish a port at all when that option is absent, avoiding a racy reserve-then-bind protocol
and keeping terminal/MCP operation private to the container. An explicit port collision fails
before the daemon becomes ready; it is never allowed
to leave the daemon owning `/data` but unreachable. The raw Compose path requires an explicit port.
Generated Compose project names keep containers and volumes separate; the documentation must not
prescribe a fixed top-level `name` or `container_name`, because either would undermine parallel
projects. A two-project contract test starts installations with identical service names and proves
distinct containers, networks, volumes, tokens, approvals, proxy routing, and host ports.

The localhost security promise requires Docker Engine 28.3.3 or newer. Docker documents a general
loopback publication fix in 28.0.0, but 28.2.0 through 28.3.2 had the CVE-2025-54388 firewalld-reload
regression fixed in 28.3.3. `doctor` enforces this floor plus the minimum Compose and Docker Desktop
versions selected and rechecked at release. The daemon still validates `Host`, `Origin`, and bearer
authentication because port binding is not an application-layer trust boundary.

### 11.2 Browser UI optionality

**DECISION:** the static browser assets and read-only API ship in the image, but the published host
port is enabled through `compose.web.yaml` rather than the base daemon topology. Proxy-only users
therefore expose no host port. The launcher adds the web override for `web`, direct-HTTP MCP, and
browser commands and reports the resulting loopback URL. Do not create a second web container with
a second workflow service.

```yaml
services:
  workflow-mcp:
    ports:
      - name: local-api
        target: 7331
        published: "${WORKFLOW_MCP_PORT:-7331}"
        host_ip: 127.0.0.1
        protocol: tcp
```

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
workflow-mcp doctor --container [--json]
workflow-mcp healthcheck
workflow-mcp auth login
workflow-mcp auth status [--json]
workflow-mcp auth logout
workflow-mcp source approvals list [--json]
workflow-mcp source approve --path <workflow.js> --sha256 <hash>
workflow-mcp token show --purpose <mcp|web>
workflow-mcp backup create --output <file>
workflow-mcp backup verify --input <file>
workflow-mcp restore --input <file>
workflow-mcp migrate inspect [--json]
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
- A stable `admin` command family is added only with the non-agent-reachable control transport in
  Section 15; it may not fall back to direct store writes.

### 12.3 Host convenience command

Docker-first means the host does not need Node or a native `workflow-mcp` runtime. The release does,
however, need a trustworthy way to supply exact Compose identity and paths.

**DECISION:** every release publishes a checksummed installation bundle containing `compose.yaml`,
`compose.web.yaml`, `compose.authoring.yaml`, the opt-in `compose.auth-api-key.yaml`, a POSIX
launcher, a PowerShell launcher, and version metadata pinned to the release image digest. A
clean-machine guide downloads the bundle from the
matching immutable GitHub Release, verifies its release attestation and `SHA256SUMS`, initializes
`<project>/.workflow-mcp/` plus its uncommitted instance file, and pulls the pinned image. An image
command which emits the same bundle provides a recovery path, but its bytes and checksums must match
the release asset.

The launcher may:

- canonicalize one local project directory and reject remote Docker contexts;
- generate/read the stable instance ID and Compose project name;
- resolve, label, inspect, and attest the exact named volume, Docker context, and Docker daemon;
- persist only an explicitly selected loopback web port and otherwise publish none;
- supply absolute `-f`, `-p`, and `--project-directory` arguments;
- select reviewed Compose overrides;
- write/update one marker-fenced generated Codex MCP stanza without reparsing Compose policy; and
- invoke container CLI commands through `docker compose exec`.

It may not inspect or mutate the run store, copy credentials, implement MCP, or become another
workflow owner. POSIX and PowerShell behavior share golden contract fixtures. Raw `docker compose`
equivalents remain documented for recovery, always with explicit paths and project identity.

The host launcher exposes `install` (new random identity or same-project `--adopt-instance`),
`doctor`, lifecycle/interface/auth/source/maintenance commands, `uninstall`, and a separately
confirmed `uninstall --delete-data`. Cross-project/context/daemon move is not a v1 operation.
`uninstall` first validates the generated Codex path and exact labeled volume without mutation,
stops/removes the Compose application, removes only the marker-fenced Codex stanza it owns, then
removes the local public bundle
and instance metadata; it preserves the named volume by default. Data deletion resolves and checks
the labeled volume again and requires an explicit destructive confirmation. Stopping or upgrading
the daemon must never make Codex startup itself fail, and uninstall must leave no stale generated
MCP entry.

## 13. Codex MCP integration

### 13.1 Preferred full-product connection: STDIO proxy

The project-local Codex configuration should launch a proxy inside the already-running Compose
service:

```toml
[mcp_servers.workflow_mcp]
command = "/absolute/project/.workflow-mcp/workflow-mcp-docker"
args = ["mcp-proxy"]
cwd = "/absolute/project"
# `required` is omitted by default. Operators may opt into `required = true` only after accepting
# that a stopped, owner-conflicted, or upgrading project daemon will then block Codex startup.
```

Why this is preferred:

- Codex gets the broadly supported STDIO transport.
- The host does not need the Node package.
- The durable daemon remains alive when Codex exits.
- The host Codex config does not contain a bearer token.
- The launcher revalidates project/context/image identity and reconstructs every recorded Compose
  overlay before scoping the connection to the current project service.

The proxy reads a container-local MCP token, connects to the daemon as an MCP client, and exposes a
separate SDK-backed STDIO MCP server to Codex. It does not read the workflow store and does not
create a `WorkflowService`.

**GATE — this is a protocol adapter, not a byte relay.** STDIO is newline-delimited JSON-RPC;
Streamable HTTP maps each message to POST/Accept/status/content-type behavior and may use JSON or
SSE, sessions, server-to-client messages, notifications, cancellation, and multiple concurrent
request IDs. The adapter must preserve MCP lifecycle, IDs, notifications, cancellation, negotiated
capabilities, ordering, bounded backpressure, and disconnect semantics. It may deliberately reject
an unsupported server-to-client capability during initialization, but may not silently drop it.

Contract tests cover fragmented STDIN, multiple messages in one read, notifications and responses,
concurrent IDs, JSON and SSE HTTP responses, session headers, server-to-client requests,
cancellation, abrupt disconnect, bounded queues, and stdout purity. Use the pinned MCP SDK's client
and server transports rather than reimplementing parsers from ad hoc line/HTTP code.
Conformance records the negotiated stable protocol and every routing/session/subscription header
required by that revision. Prerelease SDK/wire behavior is a separate watch test and cannot silently
expand the production adapter's accepted protocol.

Codex officially supports an MCP-server `cwd`; the generated configuration always sets it. Absolute
Compose path and explicit project name remain required anyway because Codex CLI, IDE, desktop, and
future launchers need not share an ambient working directory.

### 13.2 Direct Streamable HTTP connection

Codex also supports Streamable HTTP and bearer-token environment variables. The secondary setup is:

```toml
[mcp_servers.workflow_mcp]
url = "http://127.0.0.1:7331/mcp"
bearer_token_env_var = "WORKFLOW_MCP_TOKEN"
```

This is appropriate for clients that cannot run `docker compose exec`; it requires the
web/direct-HTTP Compose override. Onboarding must explain how to obtain and export a stable token
without putting it in a committed project configuration or shell history.
Documentation maps the MCP token only to `/mcp` and the web token only to `/api/v1`/browser access;
the two are not interchangeable and neither grants administrative mutation.

### 13.3 MCP instructions

Codex consumes server instructions, and clients may truncate them. The existing instruction block
is detailed and valuable, but its authoring-first prefix contradicts the Docker default when the
project is read-only. Instructions must be generated from the daemon's effective capability mode.
The first 512 characters are a self-contained safe run/poll/read loop and state whether inline
authoring and project mutation are unavailable. Add golden prefix tests for read-only, authoring,
and future mutation modes separately from the full text.

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
complete durable UI product. Catalog mode defaults to concurrency one unless measured Gateway
resources are explicitly raised; current documented defaults are one CPU and 2 GiB per server.
`--block-network` cannot be enabled for this in-container remote Codex provider, so agent command
network denial must be demonstrated by the Codex sandbox rather than overstated as a Gateway
network guarantee.

Catalog cannot safely share one mutable mask volume across unrelated launches. Its project bind is
therefore accepted only when `.codex` is absent, and the image rechecks that invariant at every
provider attempt. The project-scoped Compose launcher alone may add its private empty tmpfs mask.

## 14. Authentication and configuration isolation

### 14.1 Never mount the complete host Codex home

Mounting `~/.codex` would import unrelated MCP definitions, user settings, and possibly recursive
references back to Workflow MCP. It also makes provider recovery evidence dependent on mutable
host configuration outside the container.

**DECISION:** set `CODEX_HOME=/data/codex-home` and populate it only through supported container
commands or narrowly scoped secret import. The image and startup code must attest that no managed,
system, user, profile, or project Codex capability is inherited before claiming MCP/tool isolation.

Official Codex CLI documentation establishes configuration precedence and trusted-project behavior,
but that is evidence for a hypothesis, not proof of how `@openai/codex-sdk` composes a provider
attempt. Before the Compose topology freezes, a Slice 0 spike must execute the exact pinned SDK and
Codex binary with a fresh `CODEX_HOME`, trusted and untrusted `/workspace`, sentinel user/project/
system/managed configuration, hooks, rules, plugins, apps, and recursive MCP entries. The test must
record which layers are read and what supported trust/config-suppression controls the SDK path can
actually set.

Use a documented untrusted-project/config-suppression mechanism as the primary control if the spike
proves it. An empty read-only overlay on `/workspace/.codex` is defense in depth only after the same
cross-platform spike proves its mount and discovery behavior on Linux Engine and Docker Desktop
while leaving project `AGENTS.md` visible. A post-load hash cannot repair a capability that already
executed. The candidate overlay is:

```yaml
tmpfs:
  - /workspace/.codex:size=1m,mode=0555,uid=10001,gid=10001
```

The container image itself must contain no unexpected `/etc/codex`, `/.codex`, managed-policy,
plugin, app, or hook layer. Startup computes one canonical recovery fingerprint from the exact
Codex executable path/version/digest, SDK version, effective config layers, project-layer masking,
model aliases, sandbox/approval/network policy, and classified external tools. The same builder
feeds both `CodexAgentProvider.recoveryFingerprint` and the service factory's recovery evidence.
Any unknown or changed input disables automatic crash replay.

### 14.2 Supported credential paths

1. **API key secret — stable version-one path:** the opt-in `compose.auth-api-key.yaml` overlay
   grants one explicit Compose secret; the base file does not require or imply a credential. The
   daemon, not Compose magic, reads and validates that file and deliberately maps it to the
   provider's supported API-key input. The secret is never a build argument, ordinary config value,
   persisted run field, diagnostic value, or inherited agent-tool environment.

2. **Interactive Codex login — supported only after broker tests pass:**

   ```bash
   ./workflow-mcp-docker auth login
   ```

   Headless/device and localhost-callback behavior must be validated on Linux Engine and Docker
   Desktop. `auth login`, logout, token refresh, and account switch go through a daemon-owned
   administrative operation; `docker compose exec` must not mutate the shared Codex home behind
   active provider attempts. The credential broker serializes refresh, creates per-attempt
   access-only snapshots, and defines revocation/account-switch semantics. Until that exists,
   interactive OAuth runs with concurrency one and is labeled experimental, or is omitted from the
   stable support matrix.

Ordinary environment variables may remain an emergency compatibility path, but published examples
prefer Compose secrets. File-backed Compose secrets ignore requested UID/GID/mode remapping, so
the selected environment- or file-source behavior must be tested with UID 10001 rather than
assumed.

### 14.3 Separate local tokens

Use distinct generated tokens for:

- MCP HTTP clients;
- web/control API clients; and
- future mutation-capable administration.

Tokens are created once with cryptographic randomness, stored mode 0600 under `/data/secrets`, and
survive container replacement. Rotation is explicit and invalidates existing clients. Tokens must
never appear in URLs, health responses, normal logs, HTML, event payloads, or diagnostics bundles.

**GATE — credential/control topology is a Slice 0 decision, and `0600` is not an agent isolation
boundary.** The daemon, Codex process, and agent-spawned
commands currently share a Unix identity. File mode 0600 protects against other UIDs, not a hostile
command under the same UID. Before release, a workflow must be unable to read `/data/secrets`,
`/data/codex-home/auth.json`, `/run/secrets`, daemon/provider `/proc/*/environ` or file descriptors,
or connect to daemon loopback/service DNS. These are negative final-image tests using the exact
Codex sandbox, not mocked permission checks.

The exact container/service/principal topology must be selected before daemon, Compose, token, and
administrative API contracts freeze. Run a sentinel-secret test through the real pinned Codex
command under the proposed topology; if a separate provider service, UID, PID/mount/network
namespace, broker, or another outer boundary is needed, make that architectural change in Slice 0.
If any probe succeeds and no boundary passes, the long-lived credentialed daemon is blocked. Until
the tests pass, documentation may say that credentials are kept out of the project bind and
ordinary logs, but not that they are invisible to workflow commands.

## 15. Local HTTP and control API

### 15.1 Route groups

Proposed routes:

```text
GET  /healthz                         unauthenticated, no sensitive detail
GET  /readyz                          unauthenticated, coarse readiness only
POST /mcp                             bearer-authenticated Streamable HTTP MCP
GET  /api/v1/instance                 authenticated instance/capability summary
GET  /api/v1/runs?cursor=&limit=       authenticated bounded run summaries
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

Administrative operations are a separate local transport, not hidden write routes on the web
token. The candidate is a non-host-published Unix socket under `/run/workflow-mcp` with versioned
request/response schemas for quiesce, cancel, source approval, token rotation, authentication,
backup coordination, and migration inspection; backup streams use bounded framed chunks plus a
terminal checksum. Every request carries an idempotency/request ID, an explicit token audience,
and the lifecycle/admission outcome. The optional direct-HTTP API-key path, if retained, ships as
an explicit `compose.auth-api-key.yaml` secret overlay rather than a required base-file secret.

**GATE:** a Unix socket pathname inside the same container is not isolation by itself. The Slice 0
credential/control topology must put the socket and one-time launcher-issued administrative
capability outside the project and outside every agent/provider principal, mount, PID view, and
network reach. The launcher passes the capability out of band to a short-lived client and never
persists it in the project or ordinary environment. If the chosen service/principal design cannot
prove that boundary, stable administrative commands are blocked. Every admin route is tested while
work is active and while admission is closing; no command bypasses the service/store coordinator
or writes files directly.

### 15.2 Reuse durable cursor semantics

Do not introduce WebSocket-owned state. The API should expose the same bounded event cursor and
long-poll behavior as `workflow_run_events`. A client reconstructs state with
`workflow-mcp/state`, remembers the last durable cursor, reconnects, and continues.

This preserves the product's central invariant: network connection state is disposable; the event
store is authoritative.

Cursor behavior must be explicit across MCP and `/api/v1`:

- `after` greater than the current durable cursor returns `cursor-ahead`, not an empty page that
  echoes the invented future position;
- an expired/compacted position returns `cursor-expired` with the recovery action;
- an empty caught-up page reports the actual durable cursor and never advances it;
- duplicate delivery is harmless and clients advance only through acknowledged durable cursors;
- compaction, when introduced, publishes a snapshot/retention boundary rather than silently
  invalidating old clients; and
- quiesce wakes a long poll with `service-stopping`, not a fabricated cursor transition.

The current future-cursor behavior receives a core regression test before any shared UI client is
built, because otherwise both UIs would faithfully reproduce a server-side starvation bug.

### 15.3 API DTO rules

- Reuse stable protocol/event types where they are browser-safe.
- Do not serialize internal filesystem paths unless the operator genuinely needs them.
- Use opaque artifact IDs, never arbitrary read paths.
- Bound page sizes, wait times, list sizes, and transcript sizes.
- Include a schema version and daemon version.
- Return structured error codes that the TUI and web UI can map consistently.
- Keep provider credentials and raw environment data out of every response.

The daemon receives a bounded `listRuns({ cursor, limit, filters })` service/store seam with keyset,
not offset, pagination. The immutable total order is `(createdAt, runId)` unless Slice 1 selects a
durable monotonic sequence. A versioned opaque cursor binds a normalized filter fingerprint, a
fixed high-water mark, and the last returned key; changing filters invalidates it. Status is mutable,
so version one documents weak consistency for status-filtered pages: a run may move into or out of
the matching set between requests, while an unchanged immutable set does not duplicate or skip
keys. An index is rebuildable from authoritative manifests/events and updates under the same writer
permit as its source mutation; lineage uniqueness never depends on an eventually consistent
projection.

The seam returns sanitized summaries rather than `listStoredRunReferences()` output: no source
path, transcript directory, credential path, or unbounded manifest array. The current hot health
path is `#healthFromSnapshot -> store.listManifests()`, which must become constant/bounded; the
current `listStoredRunReferences()` helper is separately path-leaky even though no in-repository
caller uses it. Successor/lineage lookup uses the bounded index or a direct query. The same
pagination contract drives TUI and web inventory.

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
./workflow-mcp-docker ui
```

Compose normally allocates a TTY for an interactive `exec`; documentation should include explicit
`docker exec -it` equivalents only as troubleshooting. The TUI exits cleanly on Ctrl-C and leaves
the daemon and all workflows untouched.

When stdin/stdout is not a TTY, `ui` fails with a concise capability error and points to
`status --json`; it does not emit alternate-screen control bytes into logs or CI. `NO_COLOR`,
reduced-color terminals, screen readers, narrow terminals, and plain-text snapshot output belong
in the acceptance matrix.

### 16.2 Version-one screens

1. Instance header: version, workspace, mount mode, auth status, daemon uptime, provider capacity.
2. Run list: status, workflow name, age, cursor, and error indicator; the selected-run projection
   shows agent counts, while its bounded agent evidence marks coverage gaps.
3. Run detail: phases, logical agents, attempt history, current activity, warnings, scheduler health.
4. Result reader: complete paginated run or agent output, never only bounded previews.
5. Transcript reader: paginated provider transcript through the service API.
6. Diagnostics view: projected recovery/store/provider warnings plus bounded logical-agent attempt
   and coverage-gap histories. Private quarantine payloads and provider-circuit internals remain in
   authenticated MCP evidence/container logs until a separately reviewed redacted DTO exists.

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

**DECISION:** use a dependency-free ANSI renderer over the shared bounded client. The implemented
surface uses an alternate screen by default, restores it and cursor/terminal state through `finally`
and signal paths, redraws on resize, and has explicit plain/no-color/non-interactive fallbacks. This
avoids adding a UI framework to the security-critical runtime image while keeping the product
contract independent of the rendering implementation; ADR 0003 records the client/transport boundary.

## 17. Browser UI

### 17.1 Scope

The browser UI is an optional local dashboard, not a hosted web application. It is compiled into
static assets in the image and served by the daemon when the web Compose override publishes the
loopback port. Browser use is optional for the operator, but shipping and testing the observational
dashboard is required by the first stable release defined in Section 31.

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
./workflow-mcp-docker token show --purpose web
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
under `.claude/workflows`. Reject inline `script` before any filesystem call with the stable
`authoring-disabled` policy error instead of persisting first or surfacing a generic `EROFS` error.

### 18.2 Workflow-authoring mode

An override may bind the project's `.claude/workflows` directory read/write while leaving the rest
of the project read-only. Host-side launcher initialization must:

- create the directory deliberately rather than relying on Compose's implicit host-path creation;
- verify that every existing host path component maps to the expected canonical project
  subdirectory;
- reject intermediate and final symlink redirection before Docker follows and hides the symlink
  behind a nested mount;
- report that workflow definitions are writable; and
- preserve the existing no-overwrite and source-hash authorization rules.

The source-approval design becomes a two-step protocol:

1. authoring mode may persist a valid new definition with no overwrite, return its path and hash,
   and fail execution with `source-approval-required`;
2. a local operator runs `source approve --path ... --sha256 ...`; the daemon verifies the current
   bytes and records approval under the stable instance/project identity; and
3. the caller retries with `scriptPath`, which must resolve to those exact approved bytes.

MCP-authored source must never approve itself merely because it arrived through an authenticated
model connection. Approval records are fenced durable mutations, edits revoke approval, and
restoring/copying `/data` into a different project identity does not transfer authority silently.
The stable identity is not the container path `/workspace`, which is identical for every project.

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
store directory                /data/store in every image mode
instance/project identity      generated stable installation ID, never `/workspace` alone
listen host                    0.0.0.0 in container daemon mode
listen port                    7331
provider concurrency           1 in the qualified default Compose profile
agent sandbox mode             read-only
agent approval policy          never
agent tool network             false
automatic recovery            enabled only where evidence permits
source authorization mode      fail closed
Codex home                     /data/codex-home
state layout version           required and checked before repair
capability mode                read-only | authoring | mutation
```

Do not turn environment variables into an untyped sprawl. Parse once into a validated immutable
configuration object and pass that through composition.

## 21. Health, diagnostics, and observability

### 21.1 Health meanings

- **Liveness** means the process can answer and its event loop is not wedged.
- **Readiness** means configuration is valid, the workspace boundary is established, the
  installation lock is held, the selected store generation is initialized, and the service accepts
  appropriate requests.
- Provider authentication may be reported as a degraded capability rather than making historical
  run inspection unavailable.
- Liveness/readiness are constant-time in-process snapshots. They never scan manifests, repair
  state, acquire a second lease, or start a provider. The container healthcheck's exec and runtime
  cold-start cost is included in the resource budget; if a full Node CLI probe is material, ship a
  minimal audited probe rather than paying that cost every interval.

### 21.2 `doctor`

Diagnostics have two explicit phases. `./workflow-mcp-docker doctor` runs on the host and checks the
Docker context/daemon, Engine/Compose versions, canonical project/installation identity, verified
version-matched bundle, rendered Compose model, and instance/volume labels and driver options. It then
invokes `workflow-mcp doctor --container`, which checks the effective UID/user namespace, mounts,
filesystem/lock/fsync behavior, layout/ownership, daemon endpoint, Codex SDK/config/auth/sandbox,
and tmpfs. Raw Compose users can run the container phase, but receive an unsupported warning unless
they supply the verified host attestation.

Together the implemented v1 phases check:

- CPU architecture and image version;
- workspace existence, canonical project identity, and read/write mode;
- `/data` access, fsync/rename primitives, free space, and layout version;
- the resolved local volume's empty allowlisted driver options and instance/project labels;
- isolated Codex home, project `.codex` masking, and absence of inherited MCP/hooks/rules;
- provider authentication status without making a billable model call;
- daemon readiness after the owner acquired its inherited lease and bound the API, plus the
  container image/core/SDK version report;
- configured concurrency versus detected CPU/memory guidance;
- whether a newer state layout would make downgrade unsafe;
- Docker context plus minimum Engine/Desktop/Compose versions, including Engine 28.3.3 for the
  localhost publication claim;
- `bubblewrap` availability and a non-billable sandbox probe under the final hardening settings;
- absolute project bind, stable Compose project identity, and explicit MCP `cwd`/Compose path; and
- managed-command inability to read credential/state/process paths, connect to admin, escape the
  PID namespace, inherit credential keys, or reach the release-gate network sentinel.

The doctor CLI is a separate process and therefore reports its own missing owner descriptor as a
warning; it does not claim to inspect the daemon's private inherited FD. Real two-process lock
exclusion, signal containment, and hostile network sentinels remain mandatory final-image release
smokes and are not relabeled as interactive diagnostics.

The JSON form is one versioned envelope with separate `host` and `container` result objects plus a
cross-phase identity verdict. It is suitable for support bundles and must redact credentials,
tokens, prompts, results, environment values, and private absolute host paths.

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

- `0.1.0`: repository-enforced immutable release tag;
- `0.1`: movable compatible minor tag;
- `latest`: newest stable release;
- `edge`: optional main-branch build, clearly unsupported for durable production state.

Documentation and generated Compose files pin an exact semantic version or digest. They do not use
`latest` in reproducible examples.

Docker tags are mutable unless the repository's immutable-tag rules enforce otherwise. Release
setup enables and CI/API-verifies immutability for semantic-version tags before the first publish.
The API gate compares the complete normalized rule list with the single reviewed full-SemVer regex;
merely finding that regex among broader rules could freeze the candidate, compatible-minor, or
`latest` reconciliation paths. The pipeline builds each release once, records the multi-platform
digest, and promotes that same digest to compatible-minor and `latest` tags; it never rebuilds a
release tag. The checksummed Compose bundle pins the immutable digest while retaining the
human-readable version in metadata.

### 22.2 Architectures

Publish one manifest list for `linux/amd64` and `linux/arm64`. CI must run an actual container smoke
test for both architectures; merely producing a manifest is insufficient because the Codex SDK or
bundled native executable may have architecture-specific packaging.

Emulation can validate startup for the non-native architecture, while scheduled/native runners
should cover at least one live Codex authentication/execution smoke before declaring that
architecture supported.

The host support matrix is Linux Engine, Intel/Apple-Silicon macOS Docker Desktop, and x86-64
Windows Docker Desktop/WSL2 because the product publishes first-class POSIX and PowerShell
launchers. Windows v1 is preview-only, accepts local absolute drive paths (including spaces), and
explicitly rejects UNC/device paths; its installation directory inherits the current user's
project ACL rather than claiming to author a new ACL policy. CRLF-safe assets, Git-ignore editing,
Compose argument quoting, TTY behavior, and Codex stanza removal still require a real runner. A
platform remains preview—not stable—until its full launcher/Compose matrix passes.

Docker Desktop validation runs on explicitly managed self-hosted or contracted external runners:
Intel macOS, Apple Silicon macOS, and x86-64 Windows labels, Docker Desktop version, owner, reset
procedure, secret boundary, update cadence, and maximum parallel jobs are repository documentation.
Each release job starts from a clean Docker context with project containers, volumes, credentials,
and bundle files removed. If that infrastructure is unavailable, the corresponding platform claim
is reduced rather than inferred from a Linux runner or QEMU.

### 22.3 Supply-chain outputs

Release automation must produce and verify:

- image digest;
- provenance attestation;
- SBOM;
- vulnerability scan result;
- source revision labels;
- keyless-signed image/index and verification identity policy;
- release notes including state-layout and migration compatibility.

Use max-level provenance and an explicit SBOM attestation; SBOM is not added automatically. Build
secrets use BuildKit secret mounts, never build arguments which max provenance may disclose. Pin
third-party GitHub Actions by full commit SHA, base images by digest, and package dependencies by
lockfile. A release fails on missing attestations/signature, an agreed exploitable-vulnerability
threshold, architecture smoke failure, or mismatch among image/package/MCP/metadata versions.
Rebuild regularly under a new patch release for base-image security updates; immutable release
tags are never overwritten.

Runtime OS packages use an equivalent reproducible package set: the Alpine base is digest-pinned,
each added APK is revision-pinned, and every resolved version is part of the SBOM. Repository
movement can therefore fail a rebuild closed but cannot silently select a newer package version.
The release records how security rebuilds advance those pins. Every downloaded build/release tool
is pinned and verified before execution.

Each GitHub release is created as a draft, receives the POSIX/PowerShell Compose bundle,
`SHA256SUMS`, image digest, signature verification command/policy, SBOM/provenance references,
migration compatibility, and rollback boundary, and is published only after every asset is
attached. Repository immutable releases then lock the tag/assets and generate a release
attestation. A checksum alone detects corruption but not whole-release substitution, so the
no-clone installer and release smoke verify both `gh release verify` and `gh release verify-asset`
(or an equivalent documented release-attestation verifier) plus the checksum before execution.
A separate protected preflight environment supplies only a repository-scoped Administration(read)
fine-grained PAT, because the ordinary `GITHUB_TOKEN` has no `administration` permission. Its
authenticated repository API check must prove immutable releases are still enabled before the
Docker/publication environment becomes available: discovering drift after publishing the draft
cannot retroactively lock that public release.

Every action is full-SHA-pinned with least-privilege job permissions. Protected tags/environment,
trusted-ref checks, release concurrency, fork/PR secret isolation, scoped short-lived Docker Hub
credentials, and a rule forbidding release publication from `pull_request_target` are explicit
workflow gates. The release smoke starts from a machine that has Docker, the documented platform
downloader/checksum and release-attestation verifier, but no repository clone, Node installation,
cached image, state volume, or existing Codex project configuration. If `gh` is the selected
verifier, it is an explicit bootstrap prerequisite rather than an undeclared dependency.

### 22.4 Official MCP Registry

The official registry stores metadata; it does not host the image. Publish a `server.json` whose
OCI package points to the Docker Hub multi-platform manifest-index digest
(`docker.io/<owner>/workflow-mcp@sha256:...`), not a movable tag, and describes STDIO transport.
Add the required `io.modelcontextprotocol.server.name` OCI label with the final reverse-DNS-style
server name.

Because the registry is Preview and published version metadata is immutable, validate exact-schema
metadata in CI, publish only after the index signature, ownership/version labels, platform list,
SBOM, provenance, and exact digest are verified, and use a new
prerelease/version for metadata corrections. Installation does not depend on a registry lookup.

Registry acceptance is not an `initialize`/`tools/list` handshake alone. A clean OCI launch must
execute one deterministic workflow to terminal completion within the same STDIO container/session;
removing that container must discard its anonymous state exactly as the metadata promises. A
separate named-volume reconnect test remains a stronger image capability check, not a claim about
the published Registry profile. A credentialed scheduled gate must additionally run one real Codex workflow
with the declared workspace, state, authentication, command arguments, and architecture. If target
clients cannot honor required OCI runtime arguments/mounts/secrets, metadata must label the package
ephemeral/compatibility-only rather than promising the Compose product.

### 22.5 Docker MCP Catalog

Submit only after the image command, secrets, volumes, supported architectures, and STDIO behavior
are stable. The catalog contribution should declare:

- the project workspace mount;
- no shared state volume (Catalog v1 is explicitly ephemeral and project-isolated);
- provider credential secret(s);
- the STDIO command;
- resource guidance; and
- the limitation that full TUI/web durability uses Compose.

Docker's registry contribution workflow can build an `mcp/*` image with Docker-managed signing,
provenance, and SBOM, or reference a maintainer image. Decide which identity is canonical before
submission so users do not face two undocumented images with different update policies.

Catalog validation uses a concrete `server.yaml`, declared command, required environment/secrets,
read-only workspace that must contain no `.codex`, supported architecture behavior, and concurrency
one. The image proves both halves: a clean project is accepted and an unmasked project-controlled
`.codex` is refused. A credential-free scheduled job compiles current Gateway and validates against
current Catalog source. Actual Docker Desktop Gateway tool-list/call and separate maintainer-image
Cosign verification remain publication gates, not claims made by metadata-only CI. Stop/restart
durability is qualified only for the Compose daemon product because Catalog v1 deliberately
discards session state.

### 22.6 npm

Npm is secondary. The core package is currently private and versioned `0.0.0`; Docker release does
not require changing that immediately. If a public npm package is later desired, its package
contract, binary ownership, native Codex dependency, and support policy need a separate release
decision.

## 23. Test strategy

### 23.1 Unit tests

- immutable config parsing and precedence;
- stable token create/read/rotate permissions;
- immutable lock-path type/owner/inode validation, descriptor `CLOEXEC`, and path/inode drift failure;
- lease-scoped writer-permit issuance, drain, generation revocation, and journal enforcement;
- Host, Origin, bearer, and route authorization;
- daemon lifecycle state machine;
- mutation admission versus concurrent quiesce at every awaited boundary;
- shutdown mode mapping;
- layout detection/migration before initialization or repair;
- API DTO redaction and page bounds;
- future, expired, caught-up, duplicate, and compacted cursor semantics;
- keyset run pagination, cursor schema/filter/high-water binding, index rebuild, and lineage lookup;
- MCP protocol-adapter lifecycle, framing, concurrency, cancellation, backpressure, and stdout
  purity;
- shared client cursor/reconnect behavior;
- TUI state/view model;
- web reducer integration; and
- image version/OCI metadata generation.

### 23.2 Standalone system tests with fake provider

- daemon acquires one installation-wide lease and becomes ready;
- second process on the same data root fails closed under the real kernel-lock backend;
- daemon and direct-STDIO ownership of the same installation produce the same typed conflict;
- Codex-like MCP client connects through `mcp-proxy`;
- direct HTTP MCP still requires bearer auth;
- dropped MCP, TUI, and web clients do not stop a run;
- two UI clients see identical cursor-derived state;
- TUI exit leaves daemon and run alive;
- daemon replacement preserves historical results;
- SIGTERM creates recoverable interruption, not cancellation;
- SIGKILL recovery preserves existing single-writer and replay rules;
- quiesce racing source resolution, idempotency lookup, run creation, cancellation, approval,
  backup, and token rotation admits or rejects each operation exactly once;
- corrupt one-run history is quarantined without losing service readiness;
- read-only mode rejects authoring with a policy error;
- authoring profile grants only its documented path;
- result and transcript paging never accepts raw paths;
- tokens do not appear in logs or API payloads;
- a future cursor fails immediately without advancing client state;
- an unknown/newer layout remains byte-identical and readiness-false;
- migration failure leaves the previous layout recoverable; and
- direct STDIO and daemon modes use the same state/isolation composition and do not appear to lose
  history when switched deliberately;
- offline backup create/verify/restore covers disk-full, wrong output path, truncated/corrupt
  archives, crash, concurrent restart, non-empty-target refusal, and credential/approval transfer;
- stopping the daemon does not block Codex startup under the default generated stanza, and uninstall
  removes that stanza while preserving data unless separately confirmed; and
- an ephemeral Catalog/Gateway launch emits the documented durability warning.

### 23.3 Docker contract tests

Build and run the actual image to prove:

- the final user is non-root;
- root filesystem can be read-only;
- only declared volume paths and bounded `/tmp`, `/run/workflow-mcp`, or runtime `/dev/shm` tmpfs
  are written, and no authoritative byte depends on tmpfs persistence;
- no Docker socket is present;
- healthcheck transitions are correct;
- localhost host-port publication works;
- an unqualified remote interface is not published by the supplied Compose file;
- named-volume state survives container deletion/recreation;
- two real containers sharing one local named volume cannot both own/recover/execute; the contender
  remains unready while the owner is live and takeover succeeds only after owner/container death;
- replacing/unlinking the lock path, leaving a descendant with ordinary inherited descriptors, and
  killing the daemon while that descendant lives cannot retain or split ownership;
- owner `SIGKILL`, missing `ps`, PID reuse, and a stale writer attempting every durable mutator do
  not create split brain;
- fault injection around every authoritative open/write/file-fsync/rename/directory-fsync prevents
  cross-generation writes and yields a recoverable selected generation;
- a double-forking/`setsid` descendant which ignores TERM and holds a file descriptor remains inside
  the selected per-attempt containment boundary, is killed, and does not release scheduler capacity
  early;
- launcher inspection rejects optioned-local NFS/CIFS/bind volumes, unsupported filesystems, label
  mismatches, Docker-context switches, copied/missing instance files, and raw unattested startup;
- fresh, pre-created-empty, restored, wrong-owner, and rootless volume cases match the support
  matrix;
- unknown-newer state preserves bytes, modes, symlinks, directory entries, and payload mtimes except
  for explicitly documented coordination diagnostics;
- project bind is read-only by default;
- two generated project installations remain isolated even with identical directory basenames;
- two web-enabled projects accept distinct explicitly selected persisted loopback ports and reject
  a configured collision before durable startup;
- `/run/workflow-mcp` and `/tmp` have the intended UID/GID/mode and pass create/fsync/unlink probes;
- no write falls back to the read-only application filesystem;
- project `.codex` config/hooks/rules and image system/managed config cannot reach provider attempts;
- hostile model-generated commands cannot read credential/token paths or process environments and cannot reach
  the daemon over loopback/service DNS;
- Codex `bubblewrap` starts under the exact published capability/seccomp/read-only settings;
- amd64 and arm64 entrypoints select functioning Codex binaries;
- signals reach and reap provider descendants;
- image contents omit tests, raw references, local state, source maps, and development secrets;
- OCI labels match the release; and
- the documented derived-image pattern can install and use a sample toolchain;
- a repository-root context applies the Dockerfile-specific ignore rules;
- target-platform dependency installation selects the correct Codex executable on both
  architectures;
- host/container doctor phases return one schema and agree on instance, volume, platform, and
  support verdict; and
- administrative operations racing active work/quiesce use only the isolated control transport and
  never become direct file mutations.

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

The API, headers, immutable assets, and read-only route surface have automated coverage on this
branch. The real-browser run remains a required pre-release qualification gate because this
environment did not expose a browser runtime; do not infer DOM, focus, suspension, or layout
behavior from HTTP/asset tests alone.

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
- Codex CLI, IDE, and desktop use the generated explicit `cwd`, Compose file, and project name where
  those surfaces are available;
- current Codex direct Streamable HTTP connection;
- Docker MCP Gateway launch over STDIO;
- official MCP Registry metadata validation;
- Docker MCP Catalog validation tooling when available;
- hostile real-Codex sandbox probes for `/data`, `/run/secrets`, `/proc`, project writes, tool
  network, and daemon loopback;
- exact `@openai/codex-sdk` fresh-home trusted/untrusted config-layer characterization with sentinel
  MCP, hook, rule, plugin, and app capability;
- a current Docker Desktop/Gateway Catalog launch that lists all thirteen tools and makes one real
  credential-free call, plus explicit proof that removing the ephemeral server discards its state.

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
- UI polling overhead with several clients;
- container healthcheck exec/runtime cold-start overhead; and
- cgroup/PID-containment overhead plus worst-case descendant teardown latency.

Catalog mode must not quietly use nine when the gateway grants one CPU and 2 GiB. Select a safe
mode-specific default or fail `doctor` with clear resource guidance.

Before RC1, those measurements produce published full and constrained profiles with concrete
`cpus`, `mem_limit`, `pids_limit`, Docker log rotation, state-retention, and minimum free-space
values. Concurrency is derived from the selected profile and detected cgroup limits; the daemon
refuses readiness when the configured concurrency cannot fit the declared supported resource
class. Failure-injection tests cover OOM kill, PID exhaustion, full `/data`, full log allocation,
and subsequent recovery without duplicate execution.

## 25. Implementation slices

Implementation is intended to remain on this implementation branch and PR, but every slice is a
reviewable commit group with its own green gate. Each slice must leave the branch releasable and
preserve the existing core test contract; a later slice may not be used to excuse a broken earlier
boundary. Reviewers may request a follow-up PR split if the single-PR review becomes unsafe, but
that is an explicit delivery decision rather than an accidental consequence of the plan file.

### Slice 0 — Freeze contracts and add decision records

Deliverables:

- this plan accepted as the live roadmap;
- ADR for standalone directory/package boundary;
- ADR for daemon-versus-catalog lifecycle;
- ADR for protocol-aware STDIO proxy connection;
- ADR for restart-safe shutdown semantics and mutation admission;
- ADR for local-volume kernel locking and supported volume drivers;
- ADR/prototype for per-attempt kernel lifetime containment under the final Docker hardening model;
- ADR/prototype for exact provider credential/control/admin principal, mount, PID, and network
  topology, including a real pinned-Codex sentinel-secret attack;
- empirical `@openai/codex-sdk` trusted/untrusted configuration-layer characterization and ADR for
  the primary suppression mechanism plus optional `.codex` mount defense;
- ADR for state layout/migration ordering;
- ADR for keyset inventory pagination and mutable-filter consistency;
- ADR for platform support/runners, fixed-versus-dynamic UID authoring, and volume attestation;
- adversarial tests which demonstrate the current PID-namespace, future-cursor,
  cancellation-versus-host-stop, admission-race, escaped-descendant, same-UID secret, and
  migration-partial-commit failures; and
- one requirements-to-test matrix covering every **GATE** in this document.

Exit criteria:

- no unresolved ownership, descendant-lifetime, credential, or administrative-control ambiguity;
- package dependency direction is agreed; and
- shutdown behavior is specified in event terms;
- if any kernel-containment or security-topology prototype fails, long-lived credentialed daemon
  implementation is blocked rather than continued under a weaker claim.

### Slice 1 — Core durability and isolation prerequisites

Deliverables:

- installation-wide Linux local-volume `flock` backend on an immutable coordination inode, separate
  diagnostic metadata, descriptor non-inheritance, and path/inode drift detection;
- lease-scoped writer permits and audit/enforcement for every durable store/journal/config/auth/
  backup mutation;
- explicit `WorkflowService` lifecycle plus mutation admission barrier;
- runtime-owned restart interruption/quiesce semantics distinct from cancellation;
- one global layout definition, pre-repair inspection, same-filesystem generation staging, and a
  single durable selector with deterministic resume/rollback;
- strict future/expired/caught-up cursor behavior;
- bounded paginated run inventory and indexed lineage/successor lookup;
- one canonical Codex recovery-fingerprint builder wired to provider and factory evidence;
- exact Codex SDK, MCP SDK, and negotiated protocol revisions generated from the package/release
  source of truth; and
- test seam for suppressing all executable Codex config capability while retaining project
  `AGENTS.md` guidance.

Exit criteria:

- two OS processes and two minimal containers cannot own the same installation concurrently, and a
  killed owner with a living descendant does not retain an inherited lock;
- stale writers fail every mutator after fence replacement and quiesce drains permits before unlock;
- start/resume/cancel/approval races with quiesce are deterministic and leave no orphan manifest or
  unregistered provider;
- migration failure is byte-recoverable and an unknown-newer layout is untouched;
- a future cursor cannot strand a client;
- run inventory is bounded and leaks no private filesystem path; and
- automatic recovery is enabled only when current and persisted canonical fingerprints match.

The Slice 1 merge gate also runs Agent Code integration/typecheck coverage for
`createWorkflowService`, existing `stop()`/`before-quit`, the injected embedded lease backend,
termination fencing, recovery inventory, and persistent-journal adapters. Container correctness may
not silently break the parent embedder or redefine its public stop behavior.

### Slice 2 — Isolated standalone package skeleton

Deliverables:

- `standalone/package.json`, build, typecheck, unit-test, and package checks;
- root scripts that invoke standalone checks without merging dependencies into Agent Code;
- immutable validated configuration;
- version injection;
- one policy-complete standalone `serve --stdio` composition root using `/data`, the same isolation,
  fingerprint, source mode, instructions, and shutdown contract planned for the daemon;
- command skeletons plus a functional minimum `doctor --container` covering platform/version, absolute
  workspace, `/data`, lease backend, and Codex sandbox prerequisites.

Exit criteria:

- standalone imports only the public root package API;
- root package cannot import standalone code;
- clean checkout runs both core and standalone checks; and
- a real MCP tool call through the early-frozen standalone command tuple intended for the future
  image/Catalog entrypoint never selects the legacy root-CLI composition.

### Slice 3 — Long-lived daemon and lifecycle

Deliverables:

- daemon composition root;
- fixed workspace scope and `/data` layout;
- stable token management;
- health/readiness endpoints;
- the isolated non-host-published administrative transport and admission-aware route schemas selected
  in Slice 0;
- installation-ownership failure diagnostics;
- daemon wiring to the already-tested restart-safe quiesce/admission core; and
- fake-provider lifecycle system tests.

Exit criteria:

- SIGTERM and SIGKILL tests prove their distinct recovery paths;
- a UI/proxy process can exit without touching service ownership; and
- a second daemon cannot mutate the store.

### Slice 4 — MCP proxy and Codex onboarding

Deliverables:

- daemon-owned Streamable HTTP MCP endpoint;
- SDK-backed STDIO-to-daemon MCP protocol adapter;
- Codex project configuration generator with explicit absolute `cwd`, Compose path, and project
  name;
- direct HTTP setup documentation;
- mode-aware instruction-prefix compatibility tests; and
- process-level proxy/client fixtures independent of the not-yet-built container.

Exit criteria:

- fragmented/concurrent/cancelled JSON-RPC plus JSON/SSE transport tests pass through the adapter;
- the process-level proxy path passes the existing MCP tool suite against a test daemon;
- proxy stdout contains no diagnostic bytes; and
- disconnecting Codex does not stop a run.

### Slice 5 — Production container, Compose, and installation bundle

Deliverables:

- multi-stage Dockerfile;
- repository-root context and Dockerfile-specific ignore contract;
- target-platform Codex dependency installation;
- baked init, `bubblewrap`, non-root runtime, healthcheck;
- base, web, authoring, and opt-in API-key-secret Compose files with correct tmpfs ownership;
- POSIX/PowerShell launchers and reproducible checksummed installation bundle;
- project-scoped Compose `.codex` masking, Catalog `.codex` refusal, and effective-configuration
  evidence;
- host/container `doctor`, instance/context/volume labels and attestation, explicit web-port
  selection/collision checks, explicit identity move/new flows, and reversible uninstall;
- generated Codex stanza plus current Codex CLI smoke through the built Compose application;
- Docker contract test harness;
- documented derived image; and
- multi-architecture CI build without publication.

Exit criteria:

- read-only-root, read-only-project, sandbox, and hostile-secret tests pass;
- two-project isolation and two-container same-volume exclusion tests pass;
- generated `docker compose -f ... -p ... exec -T ... mcp-proxy` passes the existing MCP tool suite
  through the final image and explicit instance identity;
- fresh/restored/wrong-owner/rootless volume cases match the support matrix;
- a clean machine with Docker and the documented release verifier can initialize from the bundle
  without cloning the repository or installing Node;
- image inventory contains only intended artifacts; and
- both target architectures start successfully.

### Slice 6 — Read-only control API and shared client

Deliverables:

- versioned authenticated `/api/v1` routes;
- bounded run inventory and lineage DTOs;
- client library with cursor continuation;
- DTO/redaction tests;
- Host/Origin/CSP hardening; and
- large-artifact pagination.

Exit criteria:

- no API path bypasses service scope or artifact IDs;
- multiple clients observe identical state;
- future/expired cursors and quiesce are explicit; and
- long polls survive restart and cursor replay.

### Slice 7 — Terminal UI

Deliverables:

- TUI library spike and ADR;
- instance/run/detail/result/transcript/diagnostics views;
- resize, no-color, and disconnect behavior; and
- verified-bundle launcher recovery plus explicit raw-Compose refusal/diagnostic documentation.

Exit criteria:

- active run survives repeated TUI attach/detach;
- large output remains bounded in memory; and
- terminal state is restored on every tested exit path.

### Slice 8 — Browser UI

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

### Slice 9 — Authentication and authoring profile

Deliverables:

- isolated `CODEX_HOME` initialization and evidence;
- stable API-key secret path and daemon-owned import;
- interactive login only with serialized broker/revocation behavior;
- auth diagnostics;
- host-validated narrow writable workflow-definition profile;
- effective-user authoring create/rename/fsync/delete probes and a documented ownership strategy;
- two-step durable source approval;
- negative `/data`, `/run/secrets`, `/proc`, loopback, project-config, hook, and rule probes; and
- policy-focused UI messages.

Exit criteria:

- host `~/.codex` is never required or mounted;
- project `.codex` cannot add provider capabilities while `AGENTS.md` remains available;
- workflow commands cannot read credentials/tokens or call the daemon;
- a source edit invalidates its approval;
- read-only mode never writes the project; and
- authoring mode cannot escape `.claude/workflows`.

### Slice 10 — Docker Hub release

Deliverables:

- release workflow with amd64/arm64 manifest;
- build-once digest promotion and repository-enforced immutable semantic tags;
- mandatory SBOM, max provenance, scan threshold, keyless signature, and verification;
- digest-pinned base images;
- immutable GitHub draft-then-publish release with attested, versioned, checksummed Compose/launcher
  assets;
- least-privilege full-SHA-pinned workflow, protected release environment/tags, trusted-ref and
  concurrency gates, and scoped Docker Hub credentials;
- declared clean/reset Linux, Intel/Apple-Silicon Docker Desktop, and Windows Docker Desktop runner
  contract;
- release notes/migration section; and
- clean-machine installation smoke test.

Exit criteria:

- a user can verify the immutable release/assets and follow only the published standalone README;
- digest-pinned Compose startup works on Linux and Docker Desktop;
- persistence survives an image update; and
- rollback behavior is documented and tested where supported.

### Slice 11 — Registry integrations

Deliverables:

- official MCP Registry `server.json` and OCI label validation;
- Docker MCP Catalog entry and secret/volume declarations;
- gateway resource/lifecycle documentation; and
- scheduled compatibility smoke tests.

Exit criteria:

- Registry installation completes a real fake-provider tool call with declared runtime inputs;
- Catalog launch exposes the same thirteen tools;
- current Docker Desktop/Gateway launches the rendered ephemeral Catalog entry, exposes thirteen
  tools, completes a credential-free call, and the maintainer digest passes explicit Cosign
  verification; and
- neither integration is described as the full durable UI product unless it actually preserves
  daemon lifecycle, storage, and port access.

### Slice 12 — Optional mutation profile

This is intentionally last. It needs a separate threat model and acceptance plan covering durable
workspaces, Git metadata, replay ambiguity, cleanup, host UID/GID, and derived project toolchains.

It is not required for the first read-only Docker release.

## 26. Documentation deliverables

Before stable release, documentation must include:

- five-minute Compose quick start;
- clean-machine bundle download, checksum/signature verification, initialization, and update flow;
- Codex MCP configuration for proxy and HTTP modes;
- TUI and browser usage;
- authentication setup and rotation;
- safe/read-only, authoring, and mutation capability matrix;
- project toolchain derived-image guide;
- Docker Desktop versus Linux notes;
- supported local-volume driver, ordinary/rootless UID/GID, Git ownership, and explicit exclusions;
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

- One global durable layout definition versions every subordinate format.
- Ownership is acquired and the layout is inspected without repair before a migration is selected.
- Migrations stage a complete same-filesystem generation, fsync it, atomically and durably replace
  one selector/transaction record, reopen-validate the selection, then remove superseded staging.
- Interrupted migration deterministically resumes or rolls back from that single record; ordinary
  readers and journal constructors never migrate lazily.
- Backup is taken or explicitly recommended before a destructive migration.
- A migration failure leaves the previous bytes recoverable and readiness false.
- Release notes state the newest version to which downgrade remains safe.

The stable durability claim covers process/container crash and host/power loss at authoritative
commit points. Every replacement writes and fsyncs the new file, renames it, then fsyncs its parent;
new run directories fsync children before publishing the manifest last; event append durably writes
the event bytes before advancing manifest/index state. A syscall fault-injection harness covers
short writes, `ENOSPC`/`EIO`, and termination around every open/write/file-fsync/rename/
directory-fsync. If a supported filesystem cannot satisfy and demonstrate this protocol, the
release must narrow its durability claim or block stable support rather than equating process-crash
tests with power-loss safety.

### 27.2 Backup

**DECISION:** version-one backup/restore is offline. `./workflow-mcp-docker backup create` quiesces
and scales the daemon to zero, resolves and rechecks the exact labeled volume, then launches a
one-shot maintenance container from the pinned image with that volume plus one explicit host-output
bind. It has no network, project mount, provider credentials, or Docker socket and acquires the same
immutable installation lock. The archive includes the selected payload generation and declared
configuration; it excludes coordination locks/diagnostics, migration staging, tmpfs, caches, and
other ephemeral data. It writes a temporary archive, fsyncs archive and output directory, records a
checksum/manifest, then atomically publishes the result. A concurrent launcher restart must lose the
lock/preflight race rather than overlap the copy.

`backup verify --input` checks checksum, archive grammar, layout, entries, modes, and identity
without restoring. Stable v1 archives exclude `/data/codex-home` and `/data/secrets`; restore
regenerates local tokens and requires provider reauthentication, making credential non-transfer an
explicit contract rather than an ambiguous prompt. `restore --input` operates only on a new or
verified-empty target volume and never overwrites live or existing payload state. Before publish it
verifies checksum, layout support, ownership/modes/symlink policy, instance/project identity, and
approval-transfer rules. Restoring to a different project never silently transfers source
approvals, credentials, or automatic-replay authority. Disk-full, wrong-output, corrupt/truncated
archive, process crash, concurrent restart, and non-empty target are mandatory failure tests.
Online checkpoint or encrypted credential export is a future feature requiring a separate proof.

### 27.3 Removal

`docker compose down` removes containers and networks but not the named volume by default. The
first-class `uninstall` contract in Section 12 removes the generated Codex stanza and local bundle/
instance metadata while preserving that volume. Removing the volume is a separately confirmed,
label-checked destructive command and documentation states that it permanently deletes runs,
artifacts, tokens, configuration, and container-owned Codex login.

## 28. Security threat model summary

| Threat | Required control |
| --- | --- |
| Malicious website reaches localhost | bearer auth, Host/Origin validation, CSP, no wildcard CORS |
| Leaked web token controls workflows | version-one API read-only; separate future admin token |
| MCP client requests arbitrary files | fixed project scope, canonical path confinement, opaque artifacts |
| Workflow source changes after approval | approval keyed by canonical identity and source hash |
| Container compromise controls Docker host | no Docker socket, non-root, capabilities dropped |
| Host/project Codex configuration creates recursive MCP | isolated `CODEX_HOME`, private Compose mask, Catalog refusal, audited system/managed layers, no whole-home mount |
| Two owners execute same lineage | immutable-inode installation lock, writer permits, verified local volume, fail-closed readiness |
| Escaped provider descendant survives attempt | kernel lifetime containment; capacity and lock handoff wait for all descendants |
| Restart duplicates unsafe side effects | existing replay evidence and explicit recovery-required state |
| Approved workflow source reads tokens/credentials | explicit operator code-trust grant; never advertise `node:vm` as a hostile-code boundary |
| Token leaks through ordinary tooling | stable private files, redaction, no URL/query/log placement; file mode alone is not claimed as agent isolation |
| Writable bind corrupts host project | read-only default and separately named opt-in profiles |
| Release bundle substitution | immutable GitHub release attestation plus checksum/asset verification |
| Image supply-chain substitution | index digest, provenance, SBOM, signing, pinned build inputs |
| Project installations collide | generated stable instance identity, explicit Compose `-p`/`-f`, absolute bind and MCP `cwd` |
| Future cursor strands UI | cursor-ahead/expired errors and no advancement beyond durable state |
| Migration mutates unknown layout | installation lock, inspect-before-repair, one-selector generation transaction, fail-closed readiness |
| Agent invokes administrative control | isolated principal/namespace, non-published transport, out-of-band one-time capability |

The restricted JavaScript workflow runtime is a compatibility/accident boundary, not a hostile-code
boundary. Selecting a repository or approving authored workflow bytes explicitly trusts that code.
The Codex command sandbox remains the boundary for untrusted model-generated commands. The
container itself is defense in depth around the service; a writable project mount still grants
meaningful access to host-owned source.

## 29. Risks and mitigations

### 29.1 Codex login does not work cleanly in a container

Mitigation: make API-key secret mode the stable first path, require the daemon-owned refresh broker
before concurrent OAuth is supported, test device/browser login on every documented platform, and
make `doctor` detect incomplete login without a billable turn.

### 29.2 The Codex SDK or CLI native package is missing for an architecture

Mitigation: build and execute the actual final image on both architectures before publishing a
manifest. Do not infer support from TypeScript compilation.

### 29.3 Nine agents exceed common Docker Desktop resources

Mitigation: measure, expose concurrency configuration, warn in `doctor`, publish conservative
profiles, and use a lower default in constrained Catalog mode.

### 29.4 Compose STDIO proxy resolution depends on client working directory

Mitigation: never depend on it. Generate explicit Codex `cwd`, absolute Compose file, stable project
name, and launcher/raw command. Verify every supported Codex surface; keep direct HTTP as a
supported alternative.

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

### 29.9 A PID-based lease creates cross-container split brain

Mitigation: block daemon implementation on the local-volume kernel-lock slice, keep per-mutation
writer permits, attest the exact empty-option local volume, exclude remote/shared drivers, and run a
real two-container/SIGKILL/inode-replacement takeover matrix.

### 29.10 Project Codex config reintroduces tools or recursion

Mitigation: use the SDK-proven untrusted/config-suppression mechanism, audit every effective layer,
keep a project `.codex` overlay only as proven defense in depth, fingerprint the result, and fail
closed on drift. If suppression cannot be proven across supported platforms, disable the affected
credentialed/recovery claim.

### 29.11 Same-UID commands can read credentials or control the daemon

Mitigation: make hostile final-image probes a release gate and introduce a separate principal or
verified sandbox deny layer if any sensitive file, process environment, descriptor, or loopback
endpoint is reachable. Do not describe 0600 as sufficient isolation.

### 29.12 Docker Hub image pull does not deliver Compose

Mitigation: publish a version-matched POSIX/PowerShell bundle in an immutable attested GitHub
release, verify both release asset and checksum, reproduce it from the image, and release-test from
a Docker-only machine with no repository clone.

### 29.13 Multi-architecture build ships the builder's Codex executable

Mitigation: install/prune native dependencies for `$TARGETPLATFORM` and execute both the CLI and an
SDK provider smoke in each manifest member, using native scheduled runners before declaring full
support.

### 29.14 A descendant escapes process-group termination

Mitigation: make the exact kernel containment prototype a Slice 0 gate, attack it with
double-fork/`setsid`/ignored-signal/file-descriptor fixtures, and never release capacity or describe
ownership as transferable until the entire attempt boundary is empty.

### 29.15 A `local` volume is actually NFS/CIFS/bind-backed

Mitigation: resolve and inspect the exact labeled Compose volume, initially allow only empty local
driver options, corroborate inside the container with mount/filesystem evidence and a real lock
probe, and reject unattested raw Compose startup.

### 29.16 Checksums bless a substituted release bundle

Mitigation: publish draft-with-all-assets as a GitHub immutable release, verify the release/asset
attestation and checksum before executing launchers, and protect release refs, environments,
permissions, credentials, and concurrency.

### 29.17 Administrative CLI becomes an agent-accessible back door

Mitigation: freeze administrative routes only after the Slice 0 principal/namespace topology proves
the real Codex process cannot reach its socket or one-time capability; otherwise omit stable admin
commands instead of relying on another bearer file under the same UID.

## 30. Resolved decisions and release watch items

The implementation does not leave an architectural OPEN item implicit. ADRs 0001–0008 resolve the
runtime, ownership, transport, platform, credential/source, maintenance, distribution, and evidence
questions. The selected public identities are `docker.io/juliusolsson05/workflow-mcp` and
`io.github.juliusolsson05/workflow-mcp`; the standalone remains a private subproject; the TUI is a
dependency-free ANSI client; Docker Catalog points at the maintainer image and explicitly describes
its session-bound limits; and broad mutation/browser mutation remain deferred.

The following are release watch items rather than undecided code architecture:

1. protected GitHub/Docker Hub controls and publisher accounts must be configured and attested;
2. each claimed Desktop/rootless row needs clean-runner evidence under the platform protocol;
3. measured resource profiles may lower concurrency or narrow a release's support matrix;
4. a future layout change must add a transactional migration and release-specific rollback rule;
5. a Codex/SDK/MCP/Docker Catalog revision requires re-running the pinned hostile/conformance probes;
6. Docker Catalog publication may eventually prefer a Docker-built `mcp/*` mirror, but it must
   retain digest correspondence and may not replace the full Compose lifecycle claim; and
7. broad project mutation or UI mutation requires its own threat model and acceptance plan.

## 31. Definition of done for the first stable Docker release

All items below are required:

- standalone product code and material are isolated under `standalone/`;
- the core package remains usable by Agent Code without standalone UI/container dependencies;
- one Compose daemon is the only durable service/store owner;
- installation ownership uses an immutable-inode kernel lock on an attested supported local volume;
  every persistent syscall holds a lease writer permit through final directory fsync;
- provider attempts have tested kernel lifetime containment, including escaped grandchildren;
- service lifecycle closes mutation admission atomically before restart quiesce;
- quiesce drains descendants and writer permits inside the documented stop budget before unlock;
- Codex connects through the documented STDIO proxy and direct HTTP fallback;
- closing Codex, the TUI, or the browser does not stop workflows;
- SIGTERM, SIGKILL, restart, and upgrade recovery semantics are tested;
- one global layout and selector make migration atomic; inspection precedes every mutation and
  stable backup/restore is offline, checksummed, and non-overwriting;
- future/expired cursor and bounded inventory contracts cannot strand or exhaust clients;
- two generated project installations share no Docker or application identity/state;
- project mount is read-only by default;
- container is non-root, capability-dropped, socket-free, and supports a read-only root filesystem;
- credentials use isolated Codex state or explicit secrets, never the whole host Codex home;
- project/system/managed Codex configuration cannot add unclassified MCP, hooks, rules, plugins, or
  apps to provider attempts;
- hostile model-command probes cannot read credentials/tokens/process environments or call the daemon;
- hostile model commands cannot reach the administrative transport/capability;
- automatic recovery fingerprints the exact executable, SDK, effective configuration, and policy;
- TUI and browser inspect the same cursor-derived durable state;
- browser/API security controls pass system tests;
- a real browser passes the containerized token, CSP/origin, reconnect, cursor-continuation,
  pagination, responsive-layout, accessibility, and no-mutation-control qualification matrix;
- amd64 and arm64 images are exercised, not merely built;
- Docker Hub publishes versioned multi-architecture artifacts with supply-chain metadata;
- release tags are repository-enforced immutable and image signatures, max provenance, SBOM, scan,
  and version consistency are verified;
- an attested, checksummed, version-matched Compose/launcher bundle installs without a source
  checkout and uninstalls without leaving a generated Codex entry;
- the default generated Codex stanza remains optional when its project daemon is stopped;
- Linux and every claimed Docker Desktop host have clean real-runner launcher/Compose evidence;
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
- [OpenAI Codex configuration basics](https://learn.chatgpt.com/docs/config-file/config-basic) —
  project/user/system precedence and trusted-project `.codex` behavior.
- [OpenAI Codex authentication](https://learn.chatgpt.com/docs/auth) — file/keyring storage,
  plaintext `auth.json`, refresh, and headless/device login.
- [OpenAI Codex sandboxing](https://learn.chatgpt.com/docs/sandboxing) — Linux `bubblewrap` and
  unprivileged-user-namespace prerequisites.
- [MCP transport specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
  — STDIO framing, Streamable HTTP POST/GET/JSON/SSE, sessions, cancellation, and security.
- [MCP versioning](https://modelcontextprotocol.io/docs/learn/versioning) — current-versus-draft/
  final revisions and initialization-time protocol negotiation.
- [MCP TypeScript SDK releases](https://github.com/modelcontextprotocol/typescript-sdk/releases) —
  v2/2026 wire remains prerelease at the plan date; release gates must not confuse it with stable v1.
- [`@modelcontextprotocol/sdk` package](https://www.npmjs.com/package/@modelcontextprotocol/sdk) —
  stable v1 package/version used by the current repository.
- [MCP Registry quickstart](https://modelcontextprotocol.io/registry/quickstart) — registry Preview
  status and publication model.
- [MCP Registry package types](https://modelcontextprotocol.io/registry/package-types) — OCI package
  metadata, supported registries, STDIO transport, and required image label.
- [MCP Registry versioning](https://modelcontextprotocol.io/registry/versioning) — immutable
  published metadata and unique version requirements.

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
- [Compose volume definition](https://docs.docker.com/reference/compose-file/volumes/) and
  [`docker volume inspect`](https://docs.docker.com/reference/cli/docker/volume/inspect/) — driver
  options/labels and exact-volume inspection; the local driver may still be option-backed.
- [Compose project names](https://docs.docker.com/compose/how-tos/project-name/) — project-name
  precedence and isolation role.
- [Compose service reference](https://docs.docker.com/reference/compose-file/services/) — relative
  bind resolution, `create_host_path`, tmpfs UID/GID, secret limitations, limits, and shutdown.
- [Linux `flock(2)`](https://man7.org/linux/man-pages/man2/flock.2.html) — open-description advisory
  lock and release semantics; remote filesystems remain outside the version-one contract.
- [Docker port publishing](https://docs.docker.com/engine/network/port-publishing/) — all-interface
  publication defaults and loopback host binding.
- [Docker Engine 28 release notes](https://docs.docker.com/engine/release-notes/28/) — 28.3.3 fix
  for CVE-2025-54388 after the loopback/firewalld regression.
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
- [Docker multi-platform builds](https://docs.docker.com/build/building/multi-platform/) —
  `$BUILDPLATFORM`/`$TARGETPLATFORM` and native/emulated build strategies.
- [Docker build attestations](https://docs.docker.com/build/ci/github-actions/attestations/) — max
  provenance, explicit SBOM, registry output, and build-argument secret disclosure risk.
- [Docker Hub API](https://docs.docker.com/reference/api/hub/latest/) — immutable-tag configuration
  and verification.
- [GitHub Actions secure use](https://docs.github.com/en/actions/reference/security/secure-use) —
  full-commit-SHA pinning for immutable action references.
- [GitHub immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)
  and [release integrity verification](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/secure-your-dependencies/verify-release-integrity)
  — draft-with-all-assets publication, locked tags/assets, generated release attestations, and
  consumer verification.

## 33. Repository evidence map

Maintenance and release review should start from these core files; standalone-owned evidence is
indexed by the implementation ledger and ADRs above:

| Concern | Current source of truth |
| --- | --- |
| CLI and standalone composition | `src/cli.ts` |
| STDIO and authenticated HTTP MCP | `src/standaloneServer.ts` |
| MCP tools and initialization instructions | `src/workflowMcp.ts` |
| Durable service ownership/recovery | `src/workflowService.ts` |
| Store lease, run layout, artifacts | `src/fileWorkflowStore.ts` |
| Store abstraction | `src/workflowStore.ts` |
| Durable workflow journal writes | `src/persistentWorkflowJournal.ts` |
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

The core already exports more of the required composition surface than the first draft implied:
`registerWorkflowMcpTools`, `CodexConfigurationIsolation`, service snapshots/events, and
`workflow-mcp/state` are public. Reuse them. The table distinguishes genuinely new correctness
work from existing seams that only need standalone composition.

| Core area | Required seam/status | Why standalone needs it | Compatibility constraint |
| --- | --- | --- | --- |
| `WorkflowService` lifecycle | **New:** explicit lifecycle, admission barrier, additive restart-safe `quiesce()` | Container stop must not mean user cancellation or race new work | Existing explicit `stop()` callers retain documented behavior until deliberately migrated |
| Store ownership | **Extend seam:** injected Linux immutable-inode installation lock plus writer permits; retain embedded backend | Containers have distinct PID namespaces and token checks cannot fence syscalls | Agent Code/non-container embedders keep their supported cross-platform backend and integration tests |
| Store layout | **New:** one global generation/selector and inspect-before-repair migration boundary | Container upgrades make layout compatibility operational | Current version-1 bytes migrate transactionally and remain recoverable |
| MCP assembly | **Existing:** `registerWorkflowMcpTools`; add mode-aware instructions without copying tools | Proxy/HTTP modes need the same tools | One canonical tool list and schemas |
| HTTP serving | Configurable bind address and composable route handling | Container listens on `0.0.0.0`; old direct server remains loopback-safe | Default for existing API stays `127.0.0.1` |
| Build metadata | Injected server/product version | OCI, health, MCP initialize, and UI must agree | Development builds report an explicit development revision, not a false release |
| Provider isolation | **Extend existing:** canonical fingerprint plus verified project/system/managed suppression | Private `CODEX_HOME` alone does not remove project config | Unknown capability remains fail-closed |
| Run inventory/events | **Replace existing inventory:** bounded sanitized pagination, indexed lineage, strict cursor validation | Current helper is unbounded and returns private paths | Existing explicit-run status/artifact APIs remain stable |
| Source authorization | **Extend existing callback:** durable operator-owned two-step source-hash approvals | Authoring creates source after startup | Workflow source cannot approve itself |
| Browser protocol | **Existing state entry; new DTO wrapper only** | UI must avoid Node-only types and private paths | `workflow-mcp/state` remains browser-safe |

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
  -> verify host attestation, stable instance identity, explicit project name, and canonical /workspace
  -> reserve HTTP listener in not-ready state
  -> open/validate immutable coordination inode and acquire installation-wide kernel lock
  -> inspect all /data layout/bytes/types/modes without repair or other persistent mutation
  -> reject an unknown-newer layout without changing payload state
  -> select/reopen or transactionally migrate a complete generation through one durable selector
  -> initialize/repair only the selected current generation under writer permits
  -> create/verify private /data configuration/tokens and tmpfs ownership under the same ownership
  -> verify the SDK-proven Codex suppression mechanism and all effective configuration layers
  -> construct/initialize WorkflowService and schedule evidence-safe recovery
  -> expose MCP/control routes
  -> mark readiness true
```

Reserving the listener before acquiring long-lived ownership avoids a daemon holding the store
lease and then discovering its configured port is unavailable. Until initialization succeeds, all
routes except coarse liveness/readiness return a bounded service-unavailable response. Any startup
failure closes the listener, drains any writer permits, and releases only the lock generation that
this initializer owns. Except for the dedicated coordination lock/diagnostic namespace, unknown
newer state is byte/type/mode/symlink-identical after refusal.

### 35.2 Codex MCP connection through the proxy

```text
Codex starts generated stdio command with explicit cwd
  -> docker compose -f <absolute> -p <instance> exec -T starts mcp-proxy
  -> proxy obtains its container-local credential without printing it
  -> proxy's MCP client initializes the daemon Streamable HTTP transport
  -> proxy's MCP server initializes Codex over STDIO with compatible negotiated capabilities
  -> proxy maps requests/responses/notifications/cancellation with bounded backpressure
  -> proxy closes only its transport
  -> daemon, installation lock, and workflows continue
```

The proxy must not buffer an unbounded stream, reinterpret tool payloads, or synthesize run state.
It is a protocol-aware transport adapter, not another control plane or a raw byte tunnel.

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
  -> atomically enter QUIESCING; readiness false; close mutation admission
  -> wait for already-admitted operations to register ownership or unwind
  -> notify/wake local clients that service is stopping
  -> runtime quiesces active evaluators/provider hosts and authors terminal/interruption events
  -> kernel containment proves every attempt descendant exited or records an unclean boundary
  -> persist interruption, configuration fingerprint, and replay evidence
  -> close the persistent-writer gate and drain every issued permit
  -> flush/fsync bounded persistence work
  -> release installation lock only when descendants are gone and writer ownership can transfer
  -> close listener
  -> exit before Docker grace period
```

A hard kill at any point is handled by the file/directory-fsync commit protocol, tail repair, final
descriptor lock release, and initialization recovery. Tests inject termination and syscall failure
between every durable boundary that materially changes the next owner's decision.

## 36. Requirements traceability

| Requirement | Design owner | Primary verification |
| --- | --- | --- |
| One durable owner | immutable installation lock + writer permits + volume attestation | two-container live-owner/SIGKILL/inode/descendant/stale-writer tests |
| Attempt lifetime | kernel cgroup/PID containment | double-fork/setsid/ignored-TERM/capacity tests |
| Docker-first, no host Node | OCI image + attested Compose bundle + proxy | no-clone clean-machine install smoke |
| Deterministic project identity | versioned instance + labeled volume/context + explicit paths | copy/move/context/same-basename tests |
| Project isolation | fixed `/workspace` scope | path-confinement and cross-project denial tests |
| Read-only default | Compose mount + sandbox policy | attempted-write system tests |
| Durable restart | `/data` volume + quiesce/recovery | SIGTERM/SIGKILL/recreate tests |
| Safe schema evolution | global generation/selector migration + offline backup | unknown-layout, syscall-fault, archive/restore tests |
| Codex compatibility | STDIO proxy + HTTP endpoint | current Codex CLI/IDE/Desktop matrix where available |
| TUI does not own work | API client-only architecture | repeated attach/detach during live run |
| Optional local web UI | static assets + authenticated read API | real-browser container test |
| No Codex recursion | isolated home + private Compose mask or Catalog refusal + audited effective config | config/hook/rule/plugin negative inheritance tests |
| Credential/control isolation | exact sandbox or separate principal | hostile `/data`/secrets/`/proc`/loopback probes |
| Admin isolation | non-published transport + out-of-band capability + separate principal | hostile reachability and quiesce-race suite |
| Stable MCP surface | canonical registrar | existing MCP suite through every transport |
| Correct transport bridge | SDK-backed protocol adapter | fragmentation/JSON/SSE/session/cancel/concurrency suite |
| Disposable UI cursors | strict event cursor + keyset bounded inventory | ahead/expired/compacted/filter/high-water pagination tests |
| Multi-architecture release | Buildx manifest + native smoke | amd64/arm64 entrypoint/provider tests |
| Safe discovery integrations | Registry/Catalog metadata | validators and gateway smoke tests |
| Clean package boundary | `standalone/` dependency graph | build-time import-boundary check |
| Supportable operation | health, doctor, structured logs | failure-injection diagnostics assertions |
| Reversible installation | generated-stanza ownership + non-destructive uninstall | stopped-daemon startup and uninstall/data-preservation tests |

## 37. Maintenance and release handoff checklist

Before changing or qualifying the implementation, the next agent should:

1. read this plan, `README.md`, `docs/ARCHITECTURE.md`, and the status header of
   `docs/RELIABILITY_IMPLEMENTATION_PLAN.md`;
2. inspect the current code named in the repository evidence map rather than trusting line numbers;
3. recheck the official Codex, Docker MCP, and MCP Registry sources because their statuses are
   time-sensitive;
4. confirm the selected work preserves the Slice 0/1 gates and that no standalone daemon/UI change
   bypasses their ownership, isolation, or durability contracts;
5. add or update the relevant ADR before resolving an open decision in code;
6. preserve thick WHY comments for lifecycle, security, durability, and packaging decisions;
7. keep changes inside the standalone repository and product boundary; and
8. finish each slice with the documented tests and an update to this plan's status.

The plan should remain live until the first stable Docker release. Completed slices should be
marked with revision references; superseded decisions should remain readable with a pointer to the
replacement ADR rather than being silently rewritten out of history.

## 38. Adversarial review disposition

On 2026-07-23, two separate rounds of two Codex and two Claude reviewers independently inspected
this plan, the current runtime/tests, and current official documentation. The second round received
the first revised plan rather than the original, specifically to find residual contradictions. This
section records how material findings changed the implementation contract so a later rewrite does
not erase the reason.

A final post-edit verification launched the same intended two-Codex/two-Claude mix. Both Claude
reviewers completed; Agent Code created the Codex sessions but repeatedly reported them blocked
before prompt delivery, including after close/recreate. The completed MCP/Codex review found no
residual P0/P1, and the product/execution review found the Slice 4→5 dependency below. This is
recorded explicitly rather than counting blocked sessions as completed reviews; the two Codex
reviews from the preceding full round remain the source of the storage/container findings above.

| Review finding | Disposition in this revision |
| --- | --- |
| PID/process-start lease is invalid across container PID namespaces | Accepted as a pre-daemon **GATE**; use a kernel-released immutable-inode installation lock, attested volume, and lease-scoped writer permits |
| Current stop can race new work and maps host stop to cancellation | Accepted; explicit lifecycle, admission barrier, runtime-owned interruption, typed long-poll shutdown |
| Raw STDIO/HTTP byte relay cannot preserve MCP | Accepted; SDK-backed protocol adapter with full lifecycle/concurrency/cancellation tests |
| Fixed Compose `name` and relative paths collapse/misroute projects | Accepted; generated instance identity, explicit `-p`/`-f`/project directory, absolute bind and Codex `cwd` |
| Docker Hub image alone does not supply Compose | Accepted; image plus reproducible checksummed release bundle is the installation unit |
| UID 10001 cannot write the proposed root-owned 0700 tmpfs | Accepted; explicit tmpfs UID/GID and real write probes |
| Fixed UID, Git trust, fresh/restored/rootless volume behavior undefined | Accepted; explicit support matrix, exact `safe.directory`, no root fallback, repair command and tests |
| Private `CODEX_HOME` still permits project `.codex` capability | Accepted; private Compose mask, fail-closed Catalog absence, audit all effective layers, canonical recovery fingerprint |
| Compose secrets and 0600 files do not isolate same-UID agent commands | Accepted; hostile sandbox probes are release-blocking and require a separate principal/deny layer on failure |
| Concurrent OAuth refresh/account mutation lacks one owner | Accepted; stable API-key path first, daemon-owned broker required for supported concurrent OAuth |
| State migration was required but unowned and ordered after repair | Accepted; inspect-before-repair transactional migration moved into core Slice 1 |
| Future cursors can strand clients; inventory is unbounded and path-leaking | Accepted; strict cursor errors, bounded sanitized inventory, indexed lineage lookup |
| Authoring symlink checks cannot recover host truth after Docker follows a bind | Accepted; host launcher validates before Compose and source approval becomes two-step |
| Build context, target architecture dependencies, and SDK version can drift | Accepted; root context, Dockerfile-specific ignore, target-platform install, single version source |
| Resource and supply-chain gates were advisory | Accepted; measured cgroups/PID/disk limits plus mandatory immutability, SBOM, max provenance, scan and signature |
| Browser was called optional while definition of done required it | Clarified: optional to use, required to ship/test; host port is an explicit web override |
| Split implementation into several PRs | Not adopted by default because this branch is intended for full implementation; adapted to independently green commit groups with an explicit escape hatch |
| Defer TUI/web/authoring/registries to v1.1 | Not adopted as the target definition of done; the release may still stop after any green slice, but “stable Docker release” retains the complete observational UI/distribution scope |
| Missing implementation was reported as a P0 | Rejected as a plan-review finding; the branch intentionally contained only this plan at review time |
| Lock pathname replacement and descriptor inheritance can defeat `flock` intent | Accepted; immutable coordination inode, `CLOEXEC`/type checks, no child inheritance, device/inode monitoring, death-with-child tests |
| Durable token checks are not filesystem CAS/fencing | Accepted; kernel lock is cross-process fence and unforgeable writer permits span final file/directory fsync before quiesce unlock |
| Ownership covered `/data/store` but not tokens/config/auth/backup | Accepted; one installation lock covers every persistent `/data` mutation and startup mutates nothing before ownership except coordination |
| Docker `Driver=local` can hide NFS/CIFS/bind options | Accepted; launcher resolves/inspects/labels exact volume, empty-option allowlist, daemon mount evidence plus real lock probe, raw Compose attestation |
| Multi-file/lazy migration cannot be atomic | Accepted; one global layout, complete same-filesystem generation, single durable selector, reopen validation and deterministic resume/rollback |
| Online backup semantics were underspecified | Accepted; stable v1 is an offline, locked maintenance container with explicit output bind, verified archive, new/empty-target restore and failure matrix |
| Process-group kill cannot contain `setsid`/double-fork descendants | Accepted as Slice 0 **GATE**; exact cgroup/PID-namespace containment must pass final-rootless/Desktop hardening or daemon is blocked |
| Credential and admin isolation was deferred too late | Accepted as Slice 0 topology **GATE** with real pinned-Codex sentinel secret and non-agent-reachable admin transport/capability |
| Fixed UID cannot promise host authoring writes | Accepted; effective-user mutation/fsync probe plus ACL/dynamic-UID/broker ADR; defer rather than root/chown fallback |
| Host launcher and container diagnostics were conflated | Accepted; versioned two-phase doctor envelope with cross-phase instance/volume verdict |
| Project identity did not bind Docker context/volume | Accepted; schema-versioned instance, daemon/context identity, labeled volume, command-time comparison, and same-project preserved-volume adoption; cross-context identity import is explicitly unsupported in v1 |
| Checksums do not authenticate a substituted bundle | Accepted; immutable draft-then-publish GitHub release and release/asset attestation verification in no-clone smoke |
| Registry metadata could resolve a mutable tag | Accepted; `server.json` uses verified multi-platform manifest-index digest |
| Generated `required = true` makes a stopped optional server block Codex | Accepted; omit by default, opt in explicitly, and test stopped-daemon startup |
| Installation had no reversible uninstall | Accepted; generated-stanza ownership, non-destructive uninstall, separately confirmed labeled-volume deletion |
| Direct STDIO policy could drift until image build | Accepted; policy-complete standalone composition and real tool-call parity are Slice 2 gates before container packaging |
| SDK config behavior was inferred from CLI documentation | Accepted; exact pinned `@openai/codex-sdk` trusted/untrusted sentinel characterization precedes suppression ADR |
| Run pagination lacked a stable order/consistency contract | Accepted; keyset cursor binds immutable order, filter fingerprint, high-water mark, and documents mutable-status weak consistency |
| Docker Engine 28.0 floor missed a later loopback regression | Accepted; minimum is 28.3.3 due CVE-2025-54388 and is rechecked at release |
| PowerShell implied unsupported Windows behavior | Accepted; Windows Docker Desktop is an explicit real-runner support tier and remains preview without passing evidence |
| Docker Desktop CI was aspirational | Accepted; named platform runners require ownership/reset/version/secrets/job contract or the platform claim is reduced |
| Health and shutdown overhead/budgets were vague | Accepted; constant-time health, measured probe overhead, 90-second drain inside 120-second grace with 30-second reserve |
| Catalog no-volume mode could appear durable | Accepted; explicit ephemeral startup warning and test |
| Agent Code embedding could regress under Linux-only lease changes | Accepted; injected lease backend, additive `quiesce()`, unchanged `stop()`, and parent integration merge gate |
| Slice 4 required generated Compose/image artifacts owned by Slice 5 | Accepted in post-edit verification; Slice 4 now proves the adapter at process level and Slice 5 owns final Compose/Codex CLI end-to-end |
| Journal wording implied existing token/async coordination | Accepted; current synchronous journal is explicitly described as having no token, permit, or coordinator |
| `gh release verify`/`verify-asset` might not exist | Rejected after rechecking current official GitHub release-integrity documentation, which specifies both commands; keep the verifier as an explicit bootstrap prerequisite |

Official status wording was rechecked after reviewers disagreed: Docker MCP Catalog/Toolkit remains
Beta, Profiles remains Early Access, and the official MCP Registry remains Preview on the date at
the top of this document. Treat those labels as time-sensitive and recheck them at implementation
and release gates.
