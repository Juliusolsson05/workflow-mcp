# Workflow MCP standalone

Workflow MCP runs Claude-compatible JavaScript workflow definitions as durable Codex-backed MCP
jobs without requiring Agent Code. Docker owns the runtime, Codex CLI, credentials, state, and
process isolation; normal operation needs no host Node.js, Codex, or Agent Code installation. The
host runtime needs a local Docker Engine or Docker Desktop plus Compose. The verified release
bootstrap also needs GitHub CLI (`gh`), `tar`, `sha256sum` or `shasum`, and a POSIX shell; Windows
uses PowerShell 7 plus the corresponding built-in archive/hash commands.

Codex's Linux Bubblewrap boundary requires unprivileged user namespaces on the Docker host. Docker
Desktop supplies that Linux-VM capability. Native Linux operators must allow the container runtime
to create nested user namespaces; Ubuntu 24.04 enables an AppArmor restriction that can deny them
unless the administrator supplies an appropriate AppArmor policy or changes the documented
`kernel.apparmor_restrict_unprivileged_userns` host setting. Hosts that expose
`kernel.unprivileged_userns_clone` must also enable it. Docker's default seccomp and AppArmor
profiles separately block the namespace syscalls and mount propagation Bubblewrap needs, so the
published Compose and OCI Registry profiles apply per-container `seccomp=unconfined` and
`apparmor=unconfined` exceptions. Those exceptions enable the inner Codex sandbox; they do not
disable it. The container remains non-root with every capability dropped, `no-new-privileges`,
read-only mounts, and bounded resources. The launcher and doctor fail closed when the real sandbox
probe cannot start. Do not replace this runtime shape with a privileged container, added
capabilities, writable outer mounts, or a disabled Codex sandbox. See the
[Docker runtime-security options](https://docs.docker.com/reference/cli/docker/container/run/#security-opt)
and the
[Ubuntu 24.04 security notes](https://documentation.ubuntu.com/release-notes/24.04/#unprivileged-user-namespace-restrictions).

The normal installation is one long-lived daemon per project. Codex connects to a tiny STDIO proxy
with `docker compose exec`; disconnecting one MCP client therefore does not cancel the daemon or its
runs. A session-bound STDIO image mode also exists for generic OCI/MCP registries, but it has a
narrower lifecycle contract.

<!-- mcp-name: io.github.juliusolsson05/workflow-mcp -->

## Install a published release

The commands below apply after the matching release is published. Set `VERSION` to an exact stable
release such as `0.1.0`; do not use `latest` as an installation identity.

```bash
set -eu
umask 077
VERSION=0.1.0
TAG="v$VERSION"
ASSET="workflow-mcp-install-$VERSION.tar.gz"

[ ! -e workflow-mcp-release ] || { echo "workflow-mcp-release already exists" >&2; exit 1; }
[ ! -e workflow-mcp-bundle ] || { echo "workflow-mcp-bundle already exists" >&2; exit 1; }
mkdir workflow-mcp-release
gh release download "$TAG" \
  --repo Juliusolsson05/workflow-mcp \
  --dir workflow-mcp-release
gh release verify "$TAG" --repo Juliusolsson05/workflow-mcp
for FILE in workflow-mcp-release/*; do
  gh release verify-asset "$TAG" "$FILE" --repo Juliusolsson05/workflow-mcp
  gh attestation verify "$FILE" --repo Juliusolsson05/workflow-mcp
done
(cd workflow-mcp-release && {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum --check SHA256SUMS
  else shasum -a 256 --check SHA256SUMS
  fi
})

mkdir workflow-mcp-bundle
tar -xzf "workflow-mcp-release/$ASSET" -C workflow-mcp-bundle
(cd workflow-mcp-bundle && {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum --check SHA256SUMS
  else shasum -a 256 --check SHA256SUMS
  fi
})
./workflow-mcp-bundle/workflow-mcp-docker install /absolute/path/to/project
/absolute/path/to/project/.workflow-mcp/workflow-mcp-docker up
```

The release is deliberately not installed by piping a mutable URL to a shell. GitHub's immutable
release attestation establishes publisher/tag/asset identity; the release checksum covers the
download; the bundle's second checksum covers every file after extraction.

On Windows, use PowerShell 7 and Docker Desktop in Linux-container mode. The equivalent clean
install verifies every downloaded asset before executing the PowerShell launcher:

```powershell
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$Version = "0.1.0"
$Tag = "v$Version"
$Release = Join-Path $PWD "workflow-mcp-release"
$Bundle = Join-Path $PWD "workflow-mcp-bundle"
function Assert-Native([string] $Operation) { if ($LASTEXITCODE -ne 0) { throw "$Operation failed" } }
function New-VerifiedDirectory([string] $Path) {
  if ($Path -match '[\p{Cc}\p{Cf}]') { throw "Extraction path contains terminal control, bidi, or format characters" }
  $Full = [IO.Path]::GetFullPath($Path)
  if ($Full -match '[\p{Cc}\p{Cf}]') { throw "Extraction path contains terminal control, bidi, or format characters" }
  if ($Full -notmatch '^[A-Za-z]:[\\/]' -or $Full -match '^\\\\[?.]\\') { throw "Only local drive-qualified extraction paths are supported" }
  if ($null -ne (Get-Item -Force -LiteralPath $Full -ErrorAction SilentlyContinue)) { throw "Extraction path already exists: $Full" }
  $Parent = Get-Item -Force -LiteralPath ([IO.Path]::GetDirectoryName($Full))
  if ($Parent.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Extraction parent may not be redirected: $($Parent.FullName)" }
  New-Item -ItemType Directory -Path $Full | Out-Null
}
New-VerifiedDirectory $Release
New-VerifiedDirectory $Bundle
gh release download $Tag --repo Juliusolsson05/workflow-mcp --dir $Release
Assert-Native "release download"
gh release verify $Tag --repo Juliusolsson05/workflow-mcp
Assert-Native "immutable release verification"
Get-ChildItem -File $Release | ForEach-Object {
  gh release verify-asset $Tag $_.FullName --repo Juliusolsson05/workflow-mcp
  Assert-Native "release asset verification"
  gh attestation verify $_.FullName --repo Juliusolsson05/workflow-mcp
  Assert-Native "release asset attestation verification"
}
Get-Content (Join-Path $Release "SHA256SUMS") | ForEach-Object {
  if ($_ -notmatch '^([0-9a-f]{64})  (.+)$') { throw "Malformed release checksum" }
  if ((Get-FileHash -Algorithm SHA256 (Join-Path $Release $Matches[2])).Hash.ToLowerInvariant() -ne $Matches[1]) { throw "Release checksum mismatch" }
}
tar -xzf (Join-Path $Release "workflow-mcp-install-$Version.tar.gz") -C $Bundle
Assert-Native "bundle extraction"
Get-Content (Join-Path $Bundle "SHA256SUMS") | ForEach-Object {
  if ($_ -notmatch '^([0-9a-f]{64})  (.+)$') { throw "Malformed bundle checksum" }
  if ((Get-FileHash -Algorithm SHA256 (Join-Path $Bundle $Matches[2])).Hash.ToLowerInvariant() -ne $Matches[1]) { throw "Bundle checksum mismatch" }
}
pwsh -NoProfile -File (Join-Path $Bundle "workflow-mcp-docker.ps1") install C:\absolute\project
Assert-Native "Workflow MCP installation"
pwsh -NoProfile -File C:\absolute\project\.workflow-mcp\workflow-mcp-docker.ps1 up
Assert-Native "Workflow MCP startup"
```

Installation creates `<project>/.workflow-mcp/`, writes one marked project-local Codex MCP stanza
to `<project>/.codex/config.toml`, pulls the image pinned by digest, and records stable instance,
Compose project, Docker context, Docker Engine ID fingerprint, project, and named-volume identities. Machine-specific files are
gitignored. The project bind is read-only by default, no TCP port is published, and the daemon runs
as UID/GID `10001:10001` with a read-only root filesystem.

Use `--no-codex` if another configuration manager owns `config.toml`. `instance codex-config`
inside the image can render the exact stanza for recovery.

## Authentication

The host Codex home is never mounted. Choose one credential path.

For the stable non-interactive path, put only the key in an ordinary non-symlink file and bind its
absolute path at installation:

```bash
umask 077
printf '%s\n' "$OPENAI_API_KEY" > /absolute/private/openai-api-key
# Native Linux only: local Compose secrets retain host ownership. Grant the fixed runtime identity
# read access to this one file without broadening its mode; Docker Desktop normally needs no ACL.
setfacl -m u:10001:r /absolute/private/openai-api-key
./workflow-mcp-bundle/workflow-mcp-docker install /absolute/project \
  --api-key-file=/absolute/private/openai-api-key
/absolute/project/.workflow-mcp/workflow-mcp-docker up
```

Compose presents that file as `/run/secrets/openai_api_key`; it is not copied into the installation,
run records, logs, or backup. Removing or rotating the host file affects the next container start.

Interactive device login is daemon-owned and refuses account mutation while a workflow is active:

```bash
./workflow-mcp-docker auth status
./workflow-mcp-docker auth login
./workflow-mcp-docker auth logout
```

The login stream travels over the private admin Unix socket. Do not call `codex login` through a
separate `docker compose exec`: that would create an uncoordinated writer to the shared Codex home.

## Codex MCP use

The generated Codex stanza runs the installed, project-scoped launcher:

```text
/absolute/project/.workflow-mcp/workflow-mcp-docker mcp-proxy
```

The launcher revalidates instance/context identity and reconstructs every recorded Compose overlay
before entering the proxy. The proxy keeps stdout exclusively for MCP JSON-RPC and authenticates to the loopback daemon with
the MCP token stored in the named volume. It exposes thirteen tools:

- `workflow_list`, `workflow_describe`, and `workflow_validate` discover definitions;
- `workflow_run`, `workflow_resume`, and `workflow_run_cancel` mutate durable run state;
- `workflow_run_status` and `workflow_run_events` follow a run by strict cursor; and
- the five result/agent tools page complete workflow and per-agent evidence without filesystem
  paths.

`workflow_run` returns immediately. Keep polling `workflow_run_events` from the returned cursor or
read `workflow_run_status`; MCP transport lifetime is not run lifetime.

## Terminal and browser interfaces

The terminal UI and status command are read-only clients of the daemon:

```bash
./workflow-mcp-docker status
./workflow-mcp-docker status --json
./workflow-mcp-docker ui
```

The interactive UI uses `1`–`5` or Left/Right for runs, workflow result, agent result,
transcript, and diagnostics. Use Up/Down to select or scroll, `[`/`]` to change the selected run
outside the run-list view, Tab/Shift-Tab to change agents, and `n`/`p`/`g` for next, retained
previous, and first page. Inventory, result, and transcript cursors keep a fixed 32-entry history;
only the current content page is retained in memory. `ui --snapshot` is the non-interactive,
non-ANSI fallback.

Enable the browser UI only during installation:

```bash
./workflow-mcp-docker install /absolute/project --web-port=7331
./workflow-mcp-docker up
./workflow-mcp-docker token --purpose=web
```

Open `http://127.0.0.1:7331` and enter the token in the tab. The token is never placed in a URL,
HTML, browser history, or ordinary log. The browser API is authenticated and read-only; it has no
cancel, approval, auth, token-rotation, backup, or project-write route.
Its inventory, result, and transcript controls page through bounded API responses and replace the
current content page instead of accumulating an unbounded DOM transcript.

Web publication requires Docker Engine `28.3.3` or newer because earlier engines had a loopback
publication bypass. The launcher refuses web mode below that floor. Base/terminal/MCP operation
does not publish a host port and does not impose that web-specific floor.

## Read-only and authoring modes

Read-only is the default. Existing visible `.claude/workflows/*.js` files are approved at daemon
startup by canonical identity and exact SHA-256 bytes. Inline MCP source fails with
`authoring-disabled` before any project filesystem operation.

Narrow authoring is opt-in:

```bash
./workflow-mcp-docker install /absolute/project --authoring
```

Only `<project>/.claude/workflows` becomes writable; the rest of the project stays read-only. The
launcher rejects redirected `.claude`/`workflows` paths and asks UID 10001 in the exact image to
create, fsync, rename, directory-fsync, and delete a probe before enabling the overlay. On native
Linux, grant UID 10001 an ACL or narrow ownership on that directory if the probe fails. The product
does not solve this by running as root.

Newly authored source never approves itself. The first MCP call persists a no-overwrite definition
and returns `source-approval-required`. An operator reviews its bytes and runs:

```bash
./workflow-mcp-docker source approvals --json
./workflow-mcp-docker source approve --name=my-workflow --source-hash=<64-hex-source-hash>
```

`<64-hex-source-hash>` is a visible placeholder for the exact hash returned by describe/run. The
daemon re-reads the current visible workflow and rejects a mismatch. The durable record contains
only hashed canonical identity, project hash, workflow name, source hash, and timestamp. A one-byte
edit revokes authority, and copying/restoring records for another project identity does not grant
execution.

## Backup, restore, and upgrade

Version-one backup is offline and excludes all credentials and local tokens:

```bash
./workflow-mcp-docker backup create --output=/absolute/backups/project.backup
./workflow-mcp-docker backup verify --input=/absolute/backups/project.backup
```

Backup is deliberately offline and does not restart the instance automatically. After the archive
and checksum commit successfully, run `./workflow-mcp-docker up` to resume service.

`backup create` cleanly stops the daemon, re-attests the exact labeled volume, and launches a
networkless one-shot container from the pinned image. It acquires the same kernel owner lock and
mounts no project, Docker socket, or credential. It writes:

- `project.backup`: a gzip-compressed, framed v1 archive with a manifest and per-entry SHA-256; and
- `project.backup.sha256`: the outer checksum/commit record, published last.

The payload contains layout v1, run store, configuration, source approvals, and workspaces. It
excludes `.coordination`, `codex-home`, `secrets`, `backups`, tmpfs, cache, and staging state.
`verify` checks the outer checksum, framing grammar, sorted paths, entry count, allowed roots,
private modes, ordinary-file/symlink policy, every content hash, layout, and instance/project
identity without extracting.

Restore is non-overwriting and same-identity only:

```bash
./workflow-mcp-docker restore --input=/absolute/backups/project.backup
./workflow-mcp-docker up
./workflow-mcp-docker auth login       # interactive mode; or configure the API-key file before up
```

The launcher copies the private host archive and sidecar into one temporary Docker volume, narrows
them to UID 10001/mode 0400, and verifies and restores from that same snapshot. This avoids both
native-Linux bind permission failures and a host-file replacement window after verification. The
destination volume is opened only after verification and must be new
or contain only the reviewed empty image skeleton and coordination lock. A failed or interrupted
partial extraction leaves a non-empty target that restore refuses. Preserve instance identity and
reset only that attested target before retrying:

```bash
./workflow-mcp-docker restore reset-target --confirm=INSTANCE_ID
./workflow-mcp-docker restore --input=/absolute/backups/project.backup
```

Tokens regenerate on first daemon start and interactive authentication must be recreated.

To upgrade with a newer verified release bundle:

```bash
./new-workflow-mcp-bundle/workflow-mcp-docker upgrade /absolute/project
```

The launcher refuses a downgrade, preserves instance/project/volume identity, stops the old daemon,
atomically replaces public bundle files and the image field, and waits for readiness. For the v1
layout it restores the previous bundle/image if the new daemon fails. Take an offline backup first;
the launcher transaction recovers process interruption, while host power-loss recovery relies on
that backup. Future releases whose notes declare a layout migration may require one and may narrow
rollback.

Inspect the selected format without changing it:

```bash
./workflow-mcp-docker migrate inspect --json
```

## Shutdown, removal, and recovery

`down` asks the daemon to quiesce, rejects new mutations, drains admitted writers, interrupts active
runs durably, terminates contained Codex attempts, closes MCP/admin transports, and releases the
kernel lock. Compose then removes the container/network but preserves the named volume.

```bash
./workflow-mcp-docker down
./workflow-mcp-docker uninstall
```

Uninstall removes the marked Codex stanza and public `.workflow-mcp` files but preserves durable
data. The executing launcher is the one file it cannot safely remove on every supported host. After
the command returns, remove that exact launcher and then its now-empty ownership directory; do not
recursively delete `.workflow-mcp`. It prints the preserved UUID; reattach only from the same
canonical project path, Docker context, and same Docker daemon with a fresh verified bundle:

```bash
rm /absolute/project/.workflow-mcp/workflow-mcp-docker
rmdir /absolute/project/.workflow-mcp
./new-workflow-mcp-bundle/workflow-mcp-docker install /absolute/project \
  --adopt-instance=<preserved-instance-uuid>
```

On Windows, remove the exact `workflow-mcp-docker.ps1` remnant and then the empty
`C:\absolute\project\.workflow-mcp` directory before running the fresh bundle's PowerShell launcher.

Adoption derives the original Compose/volume name, recomputes the canonical project hash, and
requires exact driver/options/instance/project/daemon-fingerprint labels before writing installation
metadata. Context name and socket are not treated as engine identity: an Engine reset behind the
same route fails closed. A moved project or copied UUID fails closed; v1 has no automatic
cross-path/context/daemon move. Permanent deletion
is a separate label-checked command requiring the exact instance UUID:

```bash
./workflow-mcp-docker uninstall --delete-data --confirm=<instance-uuid>
```

`<instance-uuid>` is printed by `instance.json`; this command permanently removes runs, results,
approvals, tokens, and container-owned login and cannot be undone without a backup.

If the installed convenience launcher is lost, extract the same version's verified release bundle
and let its launcher recover the instance. The source-bundle launcher accepts the project path,
strictly parses the installed identity with the pinned image, compares every executable installed
Compose file with immutable bytes in that image, re-attests the volume/context/daemon, and
reconstructs every required `.codex` mask, web, authoring, and API-key overlay:

```bash
gh attestation verify workflow-mcp-install-<version>.tar.gz \
  --repo Juliusolsson05/workflow-mcp
tar -xzf workflow-mcp-install-<version>.tar.gz
(cd workflow-mcp-install-<version> && sha256sum --check SHA256SUMS)
./workflow-mcp-install-<version>/workflow-mcp-docker up /absolute/project
```

Raw `docker compose ... up` is not a supported recovery shortcut: the base file alone omits
instance-specific isolation/auth/authoring/web overlays, and manually reconstructed environment is
not host-attested. Raw Compose is limited to offline `config` diagnosis; never run providers from
that diagnostic model. Do not invent a new identity for an existing volume.

## Resource profile

The supported default is one concurrent Codex attempt with a hard Compose envelope of 1 CPU, 2 GiB
memory, 512 PIDs, 64 MiB shared memory, and 256 MiB temporary space. Readiness checks the effective
cgroup limits and refuses to start when they cannot support the configured concurrency. Each added
concurrent attempt requires one additional CPU and one additional GiB beyond the one-GiB daemon
baseline; raise `WORKFLOW_MCP_CONCURRENCY`, `WORKFLOW_MCP_CPUS`, and
`WORKFLOW_MCP_MEMORY_LIMIT` together. Docker Desktop must allocate at least those limits to its Linux
VM as well. The Docker MCP Catalog template deliberately fixes concurrency to one because its
documented per-server profile is 1 CPU/2 GiB.

## Support matrix

| Environment | Base read-only mode | Web | Authoring | Evidence required before claiming support |
|---|---:|---:|---:|---|
| Linux Engine, local context, local named volume | Release target when nested user namespaces are permitted | Engine 28.3.3+ | UID-10001 probe/ACL required | native amd64/arm64 final-image release gates |
| Rootless Linux Engine | Conditional target | Engine 28.3.3+ | UID mapping must pass | clean reset rootless runner |
| Docker Desktop macOS, Intel/Apple Silicon | Release target | Engine 28.3.3+ | bind probe must pass | clean reset Desktop runner for each architecture |
| Docker Desktop Windows + PowerShell, local drive only | Preview target (no UNC) | Engine 28.3.3+ | inherited current-user project ACL + bind probe | clean reset Windows/Desktop/PowerShell runner |
| Remote Docker context, Kubernetes, optioned/remote volume | Not supported in v1 | No | No | launcher rejects |

“Release target” is not a claim about an unpublished or unqualified build. A stable release may
mark a row supported only when its release evidence follows
[`docs/PLATFORM_VALIDATION.md`](docs/PLATFORM_VALIDATION.md); missing evidence narrows the release
matrix instead of becoming an assumption.

The durable power-loss claim applies only to Docker's ordinary local named-volume filesystem where
file `fsync`, atomic same-filesystem rename, and directory `fsync` have their documented semantics.
Network filesystems and Docker volume plugins are not silently treated as equivalent. Windows and
macOS refer to Linux containers under Docker Desktop, not a native Windows image.

## Security model

- The final image is non-root, drops every capability, enables `no-new-privileges`, has a read-only
  root/project, bounded tmpfs, PID limit, and no Docker socket. Its runtime disables Docker's stock
  seccomp and AppArmor profiles only because they block Bubblewrap setup; the real hostile probe
  must then prove the narrower Codex command sandbox starts and holds.
- Managed Codex permission profiles deny `/data`, `/run/secrets`, `/run/workflow-mcp`, and `/proc`;
  tools have no network and start inside Codex's Bubblewrap PID namespace.
- The image doctor runs a hostile final-image probe which tries to read the MCP token and launch a
  detached `setsid` sleeper. Release fails if either escapes.
- Project `.codex` is masked and provider attempts use `--ignore-user-config`/`--ignore-rules` with
  apps, plugins, image generation, and multi-agent delegation disabled. `AGENTS.md` remains normal
  project prompt input; it is not executable configuration authority.
- MCP, web, and admin tokens are distinct. Admin uses a mode-0600 Unix socket in tmpfs plus a token
  and is unreachable from the managed agent sandbox.
- The browser validates Host, Origin, bearer audience, CSP, immutable content-hashed assets, and
  exposes GET-only projected data with no absolute project paths.

The daemon and Codex share the container UID, so Unix mode bits alone are not claimed as agent
isolation. The managed mount/PID/network policy and its hostile probe are the boundary. See
[`SECURITY.md`](SECURITY.md) and [`docs/adr/0001-runtime-topology.md`](docs/adr/0001-runtime-topology.md).

## Diagnostics and exit behavior

```bash
./workflow-mcp-docker doctor
./workflow-mcp-docker logs
docker compose exec -T workflow-mcp workflow-mcp doctor --json
```

The launcher emits one versioned `{host, container, identityVerdict}` report. It covers Docker and
Compose versions/context, canonical instance/project identity, volume labels/options, rendered
Compose, image/core/Codex/MCP versions, mount access, Codex policy probe, daemon readiness after
owner startup, layout, free space, and provider authentication without a billable model call. The
separate client process cannot inspect the daemon's inherited lock descriptor directly; the exact
two-owner exclusion is a release/container smoke gate, not a doctor claim. Health endpoints are
coarse and unauthenticated; diagnostics never print token or credential values. The container CLI
uses exit `2` for invalid usage/configuration, `3` for an unavailable required service, `4` for
authentication, `5` for a source/auth policy refusal, and `10` for an internal error. The host
launchers are orchestration scripts: their own validation failures use `1`, a completed doctor
report with `ok:false` uses `3`, and other Docker/Compose failures may preserve that subprocess's
nonzero result. Automation needing the remaining typed codes should
invoke `workflow-mcp` inside the running container.

Common failures:

- `another durable workflow owner`: find the exact same instance/volume; do not delete its lock.
- `Docker context changed`: switch back to the recorded local context; adoption never bypasses it.
- `Docker daemon changed`: the Engine ID behind the route changed; v1 never imports preserved state
  across daemons, even when context and endpoint strings are unchanged.
- `UID 10001 cannot durably author`: grant only `.claude/workflows` a suitable ACL or stay read-only.
- `project .codex configuration`: ensure the generated mask override is present and restart.
- `source-approval-required`: review and approve the exact current hash, then retry by name/path.
- `layout newer`: use the newer image; downgrade cannot guess at future state.

## Build and test from source

Maintainers must complete the external [release prerequisites](docs/RELEASE_PREREQUISITES.md)
before creating the first stable tag. The repository is intentionally not release-ready while any
owner-controlled setting or platform qualification remains missing.

```bash
npm ci --include=dev
npm run check
npm --prefix standalone ci --include=dev
npm --prefix standalone run check
docker build -f standalone/docker/Dockerfile -t workflow-mcp:development .
standalone/scripts/container-smoke.sh workflow-mcp:development
```

The release workflow additionally builds native `linux/amd64` and `linux/arm64` members once,
attaches max BuildKit provenance and an SBOM, scans at the documented threshold, keyless-signs the
index digest, verifies every promoted tag names that digest, attests release assets, publishes an
immutable GitHub release, and performs a no-checkout installation smoke.

## Registry modes

`distribution/mcp-registry/server.json` is the official MCP Registry OCI record. The image defaults
to session-bound STDIO for this generic package surface and fails provider calls closed when a
generic runner exposes an unmasked project `.codex` directory. `distribution/docker-catalog`
contains a release template that accepts only projects without `.codex` configuration, avoiding a
globally shared mask another Catalog container could mutate, and explicit limitations: Docker MCP Catalog cannot provide the long-lived daemon
lifecycle, web/TUI controls, host authoring probe, interactive auth broker, or offline maintenance
launcher. Use the checksummed Compose bundle when durability across MCP client disconnects matters.

The standalone package is intentionally isolated under this directory. The provider-neutral core
never imports the Docker daemon, UI, release, credential, or registry layers.
