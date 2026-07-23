# ADR 0005: Credentials and workflow source authority

Status: accepted; amended by the consumer-defaults release (see
`standalone/docs/CONSUMER_SIMPLIFICATION_PLAN.md`).

## Decision

The host Codex *home* is never mounted; in the default profile the host's `auth.json` alone is
mounted read-only as a seed for the container-owned writable Codex home — rotation happens
container-side, the host file is never written, and agent shells still cannot read the seed path
(it joins the deny-read probe set). The hardened profile restores full credential isolation: no
host file is read at all. Stable API-key mode uses one opt-in Compose secret file and always wins
over host inheritance; Docker Catalog may map `OPENAI_API_KEY` as a documented compatibility path.
Interactive device login/status/logout runs only through the daemon credential broker and is
excluded while any run is active. Provider attempts receive only an explicit environment and
isolated Codex home; agent shells exclude credential variables and cannot read credential paths or
`/proc`.

Source authority is a profile decision. The default profile authorizes unconditionally: the
operator launched this daemon against their own project, and authored workflows are their own
agent's output. Under the hardened profile, read-only mode approves workflows visible at daemon
startup by canonical identity and exact source hash and rejects inline authoring before
filesystem access; authoring mode can persist a new no-overwrite definition, but execution fails
until an operator approves the current name/hash over the private admin channel. Durable
approvals store hashed canonical identity, project hash, source hash, name, and time under the
service/store lease. Edits revoke approval; another project hash cannot consume it.

## Why

Mounting `~/.codex` imports unrelated MCP servers, plugins, config, rules, and long-lived secrets.
Direct `compose exec codex login` races active refresh/session writers. Approval based only on path
survives edits; approval based only on bytes can transfer to a different checkout; approving an MCP
authored file in the same call lets untrusted model input grant itself code-execution authority.

API-key file paths may appear in the private instance record, but key bytes never do. MCP, web, and
admin bearer audiences are separate. Only MCP/web have deliberate interactive show commands.
