# ADR 0004: Container and platform contract

Status: accepted with explicit release-runner gates.

## Decision

The maintained artifact is a digest-pinned Alpine 3.23 / Node 22 Linux image for `linux/amd64` and
`linux/arm64`. It pins Codex and MCP SDK versions, exact runtime APK revisions, bundles native lock/CLOEXEC helpers, runs fixed
UID/GID 10001, drops all capabilities, enables no-new-privileges, limits PIDs/logs/tmpfs, keeps root
and project read-only, and never mounts the Docker socket. Base Compose disables Docker's stock
seccomp profile because it blocks the syscalls Bubblewrap needs to construct the stricter nested
Codex command sandbox; a hostile final-image probe must prove that replacement boundary on every
release architecture. Base Compose exposes but does not publish the daemon port.

The launcher accepts local Docker contexts and ordinary labeled local volumes only. Web mode
requires Engine 28.3.3+. Authoring validates every relevant host path and asks the exact image UID
to create/fsync/rename/directory-fsync/delete before mounting only `.claude/workflows` writable.
Failure asks for a narrow UID ACL/ownership; the service never becomes root to hide the mismatch.

## Platform interpretation

macOS and Windows mean Linux containers under Docker Desktop. A PowerShell launcher has the same
identity, checksum, context, volume, auth, backup, restore, upgrade, and removal contract. Native
Linux rootless mode is conditional on its UID mapping/volume/bind probes. Remote contexts,
Kubernetes, Windows containers, network volumes, and full workspace mutation are outside v1.
Windows is preview-only until a real runner qualifies it; v1 accepts local absolute drive paths,
inherits the project ACL, and explicitly rejects UNC/device paths.

## Why

Dynamic host UID mapping improves bind convenience but makes image/volume ownership depend on the
calling shell and complicates Docker Desktop parity. Running root fixes ownership by destroying the
boundary. Fixed UID plus preflight makes the real constraint visible.

The initial plan conservatively rejected Alpine pending native evidence. The pinned Codex package
now supplies explicit musl-native Codex, Bubblewrap, and ripgrep resources for both supported
architectures, and the final-image hostile probes exercise that exact path. Alpine also avoids the
unused Perl/curl/glibc dependency fan-out that Debian Git pulled into the credential-bearing image.
This decision does not waive platform evidence: both native manifest members still have to pass the
same Codex policy, lifecycle, and HIGH-threshold scan gates before publication.
