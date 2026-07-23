# ADR 0002: Ownership and durable mutation

Status: accepted for the local named-volume contract.

## Decision

Every long-lived writer enters through `/opt/workflow-mcp/native/workflow-mcp-lock`. It opens one
owner-only, single-link, non-symlink inode and takes non-blocking Linux `flock` before Node can
inspect/migrate/repair state. The descriptor crosses exactly one exec and is restored to CLOEXEC by
a preload constructor before Node main, so provider/maintenance children cannot extend ownership.

`WorkflowService` acquires the injected lease before store initialization. All run, journal,
approval, auth-control, backup, and future configuration mutations use generation-scoped writer
permits. Quiesce closes admission first, drains admitted mutations, interrupts/reaps attempts,
commits terminal evidence, closes transports, and releases ownership last.

Authoritative replacement order is new file open/write, file fsync, rename on the same filesystem,
then parent-directory fsync. Run publication writes every child first and the manifest last. Events
are durable before cursor/index publication or subscriber delivery. Bounded indexes are rebuildable;
manifests/events/artifacts remain authoritative.

## Why

PID files cannot prove liveness across PID namespaces or container replacement. JavaScript locks do
not cover a second process before module initialization. A lock descriptor inherited by provider
grandchildren would make a dead daemon look alive. Independent app files without the store's lease
could commit source authority after ownership transferred.

## Scope and proof

This contract requires an ordinary local Docker volume filesystem with working file/directory
fsync and atomic same-filesystem rename. Remote/optioned drivers are rejected rather than assumed.
Core tests inject lease loss, shutdown races, cursor/index repair, torn tails, and administrative
mutation timing. Final-image smoke starts a second daemon on the exact volume and requires it to
lose at flock before application initialization.
