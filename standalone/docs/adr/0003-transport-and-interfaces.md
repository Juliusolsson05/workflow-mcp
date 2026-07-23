# ADR 0003: Transport and local interfaces

Status: accepted.

## Decision

The daemon serves stable MCP Streamable HTTP at `/mcp` with a dedicated bearer, coarse unauthenticated
`/healthz`/`/readyz`, and versioned authenticated GET-only `/api/v1` projections. The default image
command remains STDIO for OCI registry compatibility. The installed Codex configuration uses a
STDIO-to-HTTP proxy so stdout contains only MCP frames while daemon diagnostics remain on stderr.

Terminal UI and browser UI consume the same bounded read model. The browser is optional, publishes
loopback only, uses a separate tab-session token, validates Host and Origin, emits strict CSP and
other security headers, serves content-hashed assets, redacts host paths, and has no mutation route.
Administrative mutation is a separate 0600 Unix socket plus never-printed admin bearer under
`/run/workflow-mcp`, which the agent policy denies.

## Why

STDIO is maximally compatible but binds server lifetime to each client. A localhost port alone does
not authenticate a browser extension, malicious website, sibling container, or pre-28.3.3 Docker
publication bypass. Combining read and mutation tokens would let a browser token approve source or
replace credentials. Letting UIs read the filesystem would duplicate store parsing and expose
absolute paths.

## Versioning

The implementation pins stable MCP protocol `2025-11-25` through SDK v1 and advertises exact
package/SDK/revision metadata from one generated source. SDK v2/future wire revisions are watch
items, not silent upgrades. API JSON uses `schemaVersion: 1`; cursors are opaque, strict, scoped,
bounded, and reject stale/filter-mismatched use.
