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
filter because that outer filter blocks the user/mount namespace syscalls required to construct the
inner Codex/Bubblewrap boundary. This is a deliberate layer substitution, not a sandbox bypass: the
host user-namespace prerequisite and hostile final-image probe must both pass, while container
removal still discards anonymous state. Clients that ignore declared OCI runtime arguments are
unsupported. The verified Compose/launcher bundle remains the maintained durability and
operator-control surface.

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
