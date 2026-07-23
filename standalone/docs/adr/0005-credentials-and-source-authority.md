# ADR 0005: Credentials and workflow source authority

Status: accepted.

## Decision

The host Codex home is never mounted. Stable API-key mode uses one opt-in Compose secret file;
Docker Catalog may map `OPENAI_API_KEY` as a documented compatibility path. Interactive device
login/status/logout runs only through the daemon credential broker and is excluded while any run is
active. Provider attempts receive only an explicit environment and isolated Codex home; agent
shells exclude credential variables and cannot read credential paths or `/proc`.

Read-only mode approves workflows visible at daemon startup by canonical identity and exact source
hash and rejects inline authoring before filesystem access. Authoring mode can persist a new
no-overwrite definition, but execution fails until an operator approves the current name/hash over
the private admin channel. Durable approvals store hashed canonical identity, project hash, source
hash, name, and time under the service/store lease. Edits revoke approval; another project hash
cannot consume it.

## Why

Mounting `~/.codex` imports unrelated MCP servers, plugins, config, rules, and long-lived secrets.
Direct `compose exec codex login` races active refresh/session writers. Approval based only on path
survives edits; approval based only on bytes can transfer to a different checkout; approving an MCP
authored file in the same call lets untrusted model input grant itself code-execution authority.

API-key file paths may appear in the private instance record, but key bytes never do. MCP, web, and
admin bearer audiences are separate. Only MCP/web have deliberate interactive show commands.
