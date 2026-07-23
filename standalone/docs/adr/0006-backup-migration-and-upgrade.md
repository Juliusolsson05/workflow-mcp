# ADR 0006: Backup, migration, restore, and upgrade

Status: accepted for layout/archive v1.

## Decision

One durable `layout.json` selects all subordinate format versions. Startup classifies without
mutation while the native owner lock is already held; v1 can adopt the pre-selector v0 shape and
refuses newer layouts. Future migrations must stage a complete same-filesystem generation, fsync
it, atomically replace one selector, reopen-validate, then clean old staging.

Backup v1 is offline. The launcher quiesces/scales the daemon to zero, re-attests the exact volume,
and starts a networkless, projectless, credentialless one-shot image under the same lock. The
archive is gzip over length-framed JSON headers and raw file bytes, with allowed roots, sorted
entries, private modes, per-file hashes, identity/layout manifest, terminal count, and an outer
SHA-256 sidecar published last. `codex-home`, `secrets`, coordination, caches, staging, and backups
are excluded. After Docker copies the pair to host-owned temporary files, a pinned root maintenance
helper fsyncs both, atomically no-clobber-links the archive then checksum, and fsyncs the host output
directory.

Restore verifies the entire archive before mutation, requires exact instance/project identity and a
new/reviewed-empty destination, uses exclusive creates plus file/parent fsync, never overwrites, and
regenerates login/tokens. Partial restore intentionally makes the target non-empty so a retry cannot
guess; `restore reset-target --confirm=INSTANCE_ID` deletes only the attested failed target and
preserves identity for an explicit retry. Upgrade preserves instance/volume identity and, within
layout v1, retains a private bundle rollback until the new daemon reaches readiness. Its launcher
transaction is process-interruption-safe; host power-loss recovery requires the offline backup
because cross-platform directory durability of the public bundle is not claimed. Downgrade is
refused.

## Why

Online copying can capture a manifest/event/journal generation that never coexisted. Tar extraction
without a preflight parser admits traversal, symlink, special-file, mode, duplicate, and truncation
ambiguity. Copying credentials makes backup an undocumented secret export. Restoring approvals to a
different project silently transfers JavaScript execution authority.
