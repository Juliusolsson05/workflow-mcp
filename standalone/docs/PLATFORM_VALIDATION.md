# Platform release-validation contract

This protocol decides what a stable Workflow MCP release may call supported. Building a Linux
image or parsing Compose on one machine is not evidence for another host filesystem, UID mapping,
Docker Desktop VM, shell, or architecture. Missing evidence removes a row from release notes; it
does not become a best-effort support claim.

## Automated release gates

Before semantic tags are promoted, the protected release workflow must run the exact multi-platform
index digest on native GitHub-hosted `linux/amd64` and `linux/arm64` runners. Each runner executes
the final-image smoke: fixed identity/label, health and real Codex policy probe, admin socket mode,
second-owner exclusion, clean shutdown, and offline backup/verify/restore. Each native image is
also scanned at the release threshold. The build job attaches max provenance and SBOM to the one
index and signs that digest; promotion must copy that index rather than rebuild it.

Those Ubuntu 24.04 platform-gate VMs explicitly set
`kernel.apparmor_restrict_unprivileged_userns=0` for that one disposable, credential-free job before
the final-image probe. Ubuntu documents this as a one-boot way to permit unprivileged user
namespaces. This is test-host preparation, not a relaxation of the candidate container: the image
still runs non-root with all capabilities dropped, `no-new-privileges`, the default seccomp profile,
and a read-only root. Production Linux evidence must record either a narrow AppArmor policy that
permits the nested Bubblewrap namespace or the reviewed host setting; Docker Desktop evidence must
record the Linux VM behavior. A privileged/unconfined container is never substitute evidence.

## Clean host matrix

Release-candidate evidence is recorded separately for:

| Row | Minimum clean host |
| --- | --- |
| Linux rootful amd64/arm64 | local Engine, nested unprivileged user namespaces permitted, empty Docker state for the fixture, Compose 2.32+, ordinary local volume |
| Linux rootless | rootless local context with recorded UID mapping and volume/bind behavior |
| macOS Intel | current supported Docker Desktop, POSIX launcher, fresh project and named volume |
| macOS Apple Silicon | current supported Docker Desktop, POSIX launcher, fresh project and named volume |
| Windows x86-64 | current supported Docker Desktop Linux containers, PowerShell 7 launcher, fresh project and named volume |

“Clean” means no source checkout, Node/npm/Codex installation, previous Workflow MCP bundle,
containers, networks, volumes, Codex stanza, cached release archive, or environment variables from
an earlier attempt. Docker's ordinary image cache may be empty or explicitly recorded. Do not reset
or delete a shared developer Docker installation to manufacture this state; use a disposable runner
or VM.

## Required procedure

Before invoking Docker, run `npm --prefix standalone run check:host-launcher` on the native host.
This exercises its actual POSIX/One-True-Awk implementation and proves ordinary UTF-8 paths remain
accepted while terminal-control, bidi, and malformed paths are rejected without reflection. On
Windows, run the release PowerShell parser and the equivalent Cc/Cf path cases before Docker.

For each row:

1. Record host OS/build, CPU, Docker Engine/Desktop, Compose, Docker context/endpoint, filesystem,
   volume driver/options, available memory/CPUs/disk, and PowerShell version where applicable.
2. From the first fail-closed tag run, obtain the exact `IMAGE@sha256:...` digest and the
   `build-COMMIT-RUN_ID-RUN_ATTEMPT` staging handle recorded in its build output/job summary. Pull by
   digest, record both identities, and verify that digest's tagged-workflow Cosign identity (never
   trust the mutable staging handle by itself), and use its `bundle-render` command with that digest,
   tag commit, version, and commit epoch. The
   protected release workflow independently proves those bytes equal its candidate bundle. Verify
   the bundle checksum. After publication, repeat the download, immutable-release, asset-attestation,
   release-checksum, and extracted-bundle checks as a post-publication audit.
3. Install read-only mode into a fresh absolute project containing one deterministic workflow. If
   the row claims web support, install with a loopback port and prove Engine 28.3.3+ enforcement.
4. Start the daemon, run launcher `doctor`, inspect status/TUI, connect through the generated Codex
   STDIO command, and execute a fake/non-billable conformance call plus a separately authorized real
   provider smoke when release credentials permit.
5. Disconnect Codex/TUI/browser during an active deterministic fixture and prove the daemon/run
   survives. Stop/restart the container and prove cursor/state recovery.
6. Attempt a second owner against the exact labeled volume and require fail-closed ownership.
7. If authoring is claimed, run the effective UID create/fsync/rename/directory-fsync/delete probe,
   author one no-overwrite workflow, require approval, approve its exact hash, edit one byte, and
   require approval again.
8. Exercise API-key-file mode where supported and interactive status/login/logout on rows that claim
   it, without copying the host Codex home. Redact all credential output.
9. Create/verify an offline backup, restore into the reviewed empty destination, reauthenticate,
   and prove the same instance/project identity and historical run projection.
10. Upgrade from the previous compatible stable bundle, prove identity/volume persistence and
    readiness, then inject a bad-image readiness failure and prove v1 bundle rollback.
11. Uninstall without data deletion and prove the marked Codex stanza is removed while the volume
    remains. Reinstall/adopt only through the documented identity path; finally test exact-ID
    confirmed deletion on the disposable fixture.
12. On the current Docker Desktop release, install/enable the current MCP Gateway and rendered
    Catalog entry, select a clean project, list exactly thirteen tools, and complete a
    credential-free `workflow_list` call. Separately verify the maintainer image digest with Cosign;
    Gateway's default signature policy is not evidence for a non-Docker-owned image. Confirm that
    removing the Catalog server discards its anonymous state, as documented.

### Candidate bundle extraction on a clean host

Use values copied from the candidate job summary and the immutable tag commit. `REVISION` is the
40-character commit, and `EPOCH` is that commit's Unix committer timestamp (`git show -s
--format=%ct`) recorded by the release operator. The output directories must not already exist.

```sh
set -eu
umask 077
IMAGE=docker.io/juliusolsson05/workflow-mcp
DIGEST=sha256:REPLACE_WITH_64_HEX_DIGEST
VERSION=X.Y.Z
REVISION=REPLACE_WITH_40_HEX_COMMIT
EPOCH=REPLACE_WITH_COMMIT_UNIX_TIMESTAMP
SUBJECT="$IMAGE@$DIGEST"
CONTAINER=workflow-mcp-platform-bundle
OUTPUT=workflow-mcp-candidate-bundle
[ ! -e "$OUTPUT" ]
docker pull "$SUBJECT"
docker create --name "$CONTAINER" --network none --read-only \
  --cap-drop ALL --security-opt no-new-privileges:true \
  -e "SOURCE_DATE_EPOCH=$EPOCH" --mount type=volume,dst=/bundle-output \
  "$SUBJECT" bundle-render --output=/bundle-output/release-bundle --release \
  --version="$VERSION" --revision="$REVISION" --image="$SUBJECT"
docker start --attach "$CONTAINER"
docker cp "$CONTAINER:/bundle-output/release-bundle" "$OUTPUT"
docker rm --volumes "$CONTAINER"
(cd "$OUTPUT" && {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum --check SHA256SUMS
  else shasum -a 256 --check SHA256SUMS
  fi
})
```

Resolve and verify the digest before executing the extracted launcher. The release workflow pins
Cosign v3.0.6 through the full-SHA-pinned installer action. A clean Docker host can use the reviewed
multi-platform verifier image instead of installing another host binary:

```sh
docker run --rm \
  ghcr.io/sigstore/cosign/cosign@sha256:de9c65609e6bde17e6b48de485ee788407c9502fa08b8f4459f595b21f56cd00 \
  verify "$SUBJECT" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity "https://github.com/Juliusolsson05/workflow-mcp/.github/workflows/container-release.yml@refs/tags/v$VERSION"
```

A staging or candidate tag is only a discovery handle. Record the verifier digest and output in the
redacted evidence bundle.

## Evidence record

Attach a redacted record to the release candidate containing the release tag, commit, index digest,
bundle/asset hashes, every version/fact above, command exit status, test timestamps, and links to
logs. Record skipped live-provider/destructive tests separately; a skip is never a pass. Secrets,
tokens, private paths/usernames, workflow prompts, and run content must be removed.

Any failure narrows only the affected row/capability when the shared image/runtime evidence remains
sound. A credential read, admin reachability, process escape, duplicate owner, corrupt restore,
wrong-project acceptance, or immutable-artifact mismatch blocks the entire release.

The first tag workflow intentionally stops after a signed candidate checkpoint, bundle reproduction,
and automated gates until this evidence exists. After the protected reviewer confirms the record,
set repository variable `WORKFLOW_MCP_PLATFORM_QUALIFICATION` to the exact `VERSION@sha256:DIGEST`
and rerun with `gh workflow run container-release.yml --ref vVERSION`. The retry accepts only the
prior digest signed by this exact tagged workflow; it never rebuilds or substitutes candidate bytes.
