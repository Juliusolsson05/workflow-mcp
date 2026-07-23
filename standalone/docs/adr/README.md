# Standalone architecture decisions

These ADRs are the compact implementation record behind the larger
[`DOCKER_FIRST_CODEX_MCP_IMPLEMENTATION_PLAN.md`](../../../docs/DOCKER_FIRST_CODEX_MCP_IMPLEMENTATION_PLAN.md).
The plan preserves research, rejected alternatives, sequencing, and release gates; these files
record the decisions that the shipped code now enforces.

| ADR | Decision | Enforcement/evidence |
|---|---|---|
| [0001](0001-runtime-topology.md) | one daemon, proxy clients, isolated agent control plane | Compose, managed Codex profiles, hostile image probe |
| [0002](0002-ownership-and-durability.md) | kernel flock plus lease-scoped writers and durable commit order | native launcher, store tests, owner-conflict smoke |
| [0003](0003-transport-and-interfaces.md) | authenticated HTTP daemon, STDIO proxy, read-only UI surfaces | SDK system tests, API/TUI/web tests |
| [0004](0004-container-and-platform.md) | fixed non-root Linux image and explicit platform gates | digest-pinned Dockerfile, host doctor, authoring probe |
| [0005](0005-credentials-and-source-authority.md) | external credentials and two-step byte-exact source approval | admin broker/store and negative policy tests |
| [0006](0006-backup-migration-and-upgrade.md) | offline framed backup and global versioned layout | maintenance tests and container smoke |
| [0007](0007-release-and-registries.md) | Docker Hub canonical image, immutable GitHub bundle, qualified registry modes | full-SHA-pinned release workflow and metadata validator |
| [0008](0008-support-and-test-contract.md) | evidence-qualified support rather than implied Docker portability | matrix, CI, release runner contract |

An ADR change that weakens a boundary must update its test and operator documentation in the same
diff. A prose-only exception is not an implementation decision.
