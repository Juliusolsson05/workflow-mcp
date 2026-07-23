# Security policy

## Reporting

Do not open a public issue for a suspected vulnerability involving credential disclosure, sandbox
escape, command execution, state corruption, release substitution, or cross-project access. Use
GitHub's private vulnerability reporting for `Juliusolsson05/workflow-mcp` and include:

- the exact image digest, release version, host OS, Docker Engine/Desktop and Compose versions;
- whether base, web, authoring, API-key, or project-Codex-mask overlays were active;
- the minimum reproducer and whether it works through a real Codex tool command; and
- any evidence of credential, `/data`, `/proc`, loopback, process, or project-boundary access.

Do not include live API keys, MCP/web/admin tokens, Codex auth files, private workflow prompts, or
run results. Rotate any credential that may have been exposed before sending a redacted report.

The supported security-update line begins with the first published `0.1.x` release. Source builds,
development tags, mutable minor/`latest` tags, Docker Catalog templates, and unreviewed derived
images are not security-supported artifacts. Published immutable semantic tags remain available for
reproduction; fixes ship as a new patch and never replace an old tag.

## Trust boundaries

Project workflow JavaScript is trusted code selected by the local operator. Installing against a
repository trusts its existing workflow files; approving newly authored source is an explicit,
byte-exact code-trust grant. The evaluator's restricted globals and `node:vm` preserve compatibility
and reduce accidents, but Node documents that `node:vm` is not a security mechanism. Do not install
or approve workflow source from an untrusted author.

Model-generated commands remain untrusted. The local operator, approved workflow source, verified
release bundle, exact image digest, Docker daemon, managed Codex policy, and daemon-owned state are
trusted within their documented roles.

The image deliberately does not claim that mode `0600` or the workflow VM separates approved
workflow code from daemon secrets: the evaluator, daemon, and Codex share UID 10001. The boundary
for untrusted model-generated commands is the pinned Codex command sandbox with
managed deny-read paths, its PID/mount namespace, disabled command network, environment filtering,
project-config masking, and the real final-image escape probe. A change to Codex, Bubblewrap,
requirements, policy launcher, executable path, project mask, SDK, or effective tool set changes the
recovery fingerprint and must re-pass that probe.

The official MCP Registry record is an explicitly session-bound compatibility launch. It encodes
the fixed user, read-only root, dropped capabilities, no-new-privileges, resource limits, private
tmpfs paths, anonymous `/data`, and read-only project bind. It also disables Docker's stock seccomp
and AppArmor profiles because those outer filters block the user/mount namespace syscalls and mount
propagation required to construct the inner Codex/Bubblewrap boundary. This is a deliberate layer
substitution, not a sandbox bypass: the host user-namespace prerequisite and hostile final-image
probe must both pass, while container removal still discards anonymous state. Clients that ignore
declared OCI runtime arguments are unsupported. The verified Compose/launcher bundle remains the
maintained durability and operator-control surface.

The daemon container itself needs outbound access to OpenAI. A model shell does not inherit that
network permission. The base Compose service publishes no port. Optional web mode binds loopback
only and still authenticates Host/Origin/bearer; Engine versions below 28.3.3 are rejected because
host binding is not an application-layer boundary.

## Secrets

- Prefer the opt-in Compose secret file. It is mounted only at `/run/secrets/openai_api_key` and
  converted to the provider's explicit environment inside the wrapper.
- Docker Catalog can express only an environment secret. It is accepted as a compatibility path,
  then excluded from every model-tool shell environment; the Compose installation is preferred.
- Interactive login lives only in the container-owned Codex home and is mutated through the admin
  broker when no workflow is active.
- MCP, web, and admin bearers are separate random values. Only MCP/web have deliberate show
  commands; admin is never printed.
- Backups exclude `codex-home` and `secrets` and require new authentication/tokens after restore.

Secrets must never be submitted as Docker build arguments, Compose labels, normal environment
examples, URLs, workflow args, event data, diagnostics, screenshots, or issue attachments.

## Release verification

Stable users should verify all three layers before execution:

1. `gh release verify vX.Y.Z` and `gh release verify-asset` establish the immutable GitHub release
   and asset identity;
2. the release `SHA256SUMS` validates downloaded asset bytes; and
3. the extracted bundle `SHA256SUMS` validates every Compose/launcher file.

The bundle pins the Docker Hub image by multi-platform index digest. The release workflow attaches
max provenance and SBOM attestations, blocks every applicable HIGH-or-critical vulnerability,
keyless-signs the digest, verifies its OIDC identity, and checks semantic/minor/latest tags all name
the build-once digest. Repository immutable releases, protected release tags/environment, Docker
Hub immutable semantic tags, and scoped Docker Hub credentials are required administrative
settings; workflow YAML cannot create those controls on its own.

The only source-controlled scanner suppression is exact-package/version scoped in `.grype.yaml`:
CVE-2026-32631 describes a Git for Windows NTLM/network-drive behavior which is absent from the
Linux/musl image. A Git package revision change stops matching that rule and must be reviewed again;
unfixed, low-risk, or inconvenient findings are not blanket-suppressed.

### Hardened bootstrap (manual verification)

The consumer `install.sh` performs these steps implicitly against a digest-pinned image. The
commands below are the explicit, verify-every-byte-first path for operators who refuse to pipe a
download into a shell:

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

## Out of scope and unsupported configurations

Reports that also reproduce in a supported configuration are welcome. The following configurations
do not carry the v1 isolation/durability promise by themselves:

- remote Docker contexts, Docker socket mounts, privileged mode, added capabilities, root user,
  disabled `no-new-privileges`, or a writable container root;
- network/optioned volume drivers or filesystems without the documented fsync/rename behavior;
- full workspace write, user/project Codex config inheritance, extra MCP servers, plugins, apps,
  hooks, or sandbox bypass flags;
- direct mutation of the named volume, Codex home, token/approval files, instance record, generated
  Compose files, or lock inode outside the owner/launcher protocols; and
- mutable image tags or bundles/assets that were not verified as above.

Those cases may still reveal a defense-in-depth improvement, but they are not evidence that the
supported boundary failed unless the issue survives removal of the unsupported change.
