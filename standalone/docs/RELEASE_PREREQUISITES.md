# Release prerequisites

The release workflow is fail-closed until every external control below exists. These settings are
not repository files and cannot be created safely by a pull request.

Current audit on 2026-07-23: **not ready to publish**. GitHub immutable releases are disabled,
neither protected release-preflight nor publication environment exists, no repository ruleset
exists, private vulnerability reporting is disabled, and the public Docker Hub
repository `juliusolsson/workflow-mcp` now exists (created 2026-07-23). Do not create `v0.1.0` until this checklist is
complete; GitHub release immutability does not retroactively protect an earlier release.

1. DONE 2026-07-23: public Docker Hub repository `juliusolsson/workflow-mcp` created (the operator's real Hub account is `juliusolsson`; `juliusolsson05` never existed on Docker Hub).
2. Configure the repository's specific-tag immutability rule exactly as
   `^[0-9]+\.[0-9]+\.[0-9]+$`. It must be the only immutable-tag regex: an additional rule can
   freeze the resumable `candidate-*`, compatible-minor, or `latest` tags even when this exact rule
   is also present.
3. Create a scoped Docker Hub token that can read/write only that repository.
4. Enable GitHub immutable releases for `Juliusolsson05/workflow-mcp`.
5. Protect `v*` tags with a ruleset that restricts creation/deletion and requires the intended
   release path.
6. Create and protect a separate `workflow-mcp-release-preflight` environment with required
   reviewers. Create a fine-grained PAT limited to `Juliusolsson05/workflow-mcp` with only repository
   **Administration: read-only**, store it as
   `WORKFLOW_MCP_GITHUB_ADMIN_READ_TOKEN`, set a reviewed expiration/rotation date, and put no Docker
   Hub credential, `contents:write`, package, release, or other publication authority in this
   environment. The ordinary `GITHUB_TOKEN` cannot call the immutable-release endpoint because
   `administration` is not a supported workflow permission.
7. Create and protect the separate `workflow-mcp-release` publication environment, add required
   reviewers, and store `DOCKERHUB_TOKEN` plus `DOCKERHUB_USERNAME` only there.
8. Enable GitHub private vulnerability reporting and confirm the repository Security tab resolves
   the recognized policy at `.github/SECURITY.md`.
9. After independently reviewing steps 4–8, set repository variable
   `WORKFLOW_MCP_RELEASE_CONTROLS` to
   `github-immutable-v1+protected-tags-v1+protected-preflight-v1+protected-publication-v1+private-reporting-v1`.
10. Complete and record Docker Desktop macOS/Windows and native-rootless Linux qualification from
   [PLATFORM_VALIDATION.md](PLATFORM_VALIDATION.md). Set `WORKFLOW_MCP_PLATFORM_QUALIFICATION` only
   to the reviewed `VERSION@sha256:DIGEST` candidate identity. Catalog/Gateway remains preview-only
   until a real current Docker Desktop Gateway call plus separate Cosign verification passes.

After source/tag/default-branch validation, the workflow enters only the preflight environment and
uses its Administration(read) credential to query GitHub's authenticated immutable-release and
private-reporting endpoints. The publication environment and Docker credentials remain unavailable
until that job succeeds, so a stale owner-attestation variable cannot permit a mutable public
release. The later build job also queries Docker Hub before it builds or signs anything and verifies
that the repository is public and its normalized immutable-rule list contains only the exact
full-SemVer rule. A missing repo, disabled setting, permission failure, changed API response, or
changed rule blocks the release.
