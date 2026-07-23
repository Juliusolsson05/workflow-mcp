# ADR 0008: Support and test contract

Status: accepted.

## Decision

“Runs in Docker” is not a support claim. Each stable release records evidence for architecture,
Engine/Desktop/Compose version, local/rootless context, volume driver/options/labels, effective UID,
authoring bind behavior, web publication floor, credential path, and clean installation source.
Missing platform evidence narrows the matrix rather than becoming an assumption.

Required layers are:

1. core unit/system/corpus tests for compatibility, scheduler, recovery, durability, pagination,
   shutdown, ownership, and source policy;
2. standalone tests for config/layout, daemon/proxy SDK conformance, token/admin/API/TUI/web,
   authentication, source approval, bundle reproducibility, and hostile backup inputs;
3. final-image smoke for non-root labels, real managed Codex credential/PID escape probes, second
   owner conflict, admin socket mode, offline backup/verify/restore, and Compose profile parsing;
4. multi-platform release build with attestations/scan/signature; and
5. clean/reset Linux, Intel/Apple-Silicon Docker Desktop, and Windows PowerShell/Desktop evidence
   before those rows are marked supported for a stable tag.

## Failure semantics

Tests must include success, corrupt/truncated input, symlink/path redirect, wrong project/instance,
non-empty restore, active-run auth, source edit, read-only authoring, stale cursor, startup/shutdown
race, owner collision, detached descendant, and missing credential cases. A skipped destructive or
live-provider test is reported separately and cannot be counted as its proof.

## Why

Mocked filesystem modes do not prove Docker Desktop binds; process groups do not prove containment;
loopback configuration does not prove an older Engine's host firewall behavior; and an amd64 build
does not prove Codex's architecture-specific optional package exists on arm64. The matrix follows
evidence, not optimism.
