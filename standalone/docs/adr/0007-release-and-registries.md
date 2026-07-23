# ADR 0007: Release and registry architecture

Status: accepted; administrative repository/registry controls remain prerequisites.

## Decision

Docker Hub `docker.io/juliusolsson/workflow-mcp` is the canonical runtime. Stable semantic tags
are immutable; compatible-minor and `latest` are convenience pointers. The release builds one
run-attempt-unique amd64/arm64 staging index, attaches max provenance/SBOM, signs it, and runs native
per-architecture final-image smoke and HIGH-threshold scans before committing the full-SemVer tag
as its resumable signed checkpoint. A retry accepts that checkpoint only with the exact tagged
workflow's Cosign identity and complete labels/platform attestations. Tag/digest and signature
identity are verified; writer-controlled labels alone are never trusted.

GitHub publishes a versioned, reproducible Compose/launcher bundle pinned to the index digest. The
workflow creates a draft, attaches checksums, registry metadata, image digest, and notes, attests
the assets, then publishes into a repository configured for immutable releases. A second clean job
does not check out source: it verifies release/asset attestations and both checksum layers, extracts
the launcher, pulls the digest, and runs the image.

The official MCP Registry record uses schema `2025-12-11`, OCI ownership label
`io.modelcontextprotocol.server.name`, stable version, and release digest. Publication uses an
official versioned `mcp-publisher` archive whose SHA-256 is pinned in the release workflow, with
GitHub OIDC for registry authentication. Docker MCP Catalog gets a release-rendered submission
template and static tool inventory, but its session-bound lifecycle and missing host controls are
documented; it is not represented as the durable Compose product.

## External controls

The repository must enable immutable releases and protected `v*` tags/environment. Docker Hub must
be public, make the exact full-SemVer regex immutable, and issue a scoped read/write token to the
protected environment. The workflow fails closed on both an owner-attestation variable and a live
authenticated GitHub immutable-release check. Because that endpoint requires Administration(read),
the check runs in a separate protected preflight environment whose narrowly scoped fine-grained PAT is
its only secret and which has no Docker or publication credential. The protected publication job
cannot start until preflight succeeds. Its live Hub settings check requires the complete normalized
immutable-rule list to equal the single reviewed full-SemVer regex, preventing another rule from
freezing candidate/minor/latest reconciliation; see `docs/RELEASE_PREREQUISITES.md`.
Workflow permissions are least privilege and third-party actions execute by full commit SHA.
Dependabot proposes action changes; a mutable major tag is context only.
