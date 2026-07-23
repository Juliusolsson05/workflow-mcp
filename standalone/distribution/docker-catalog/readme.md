# Workflow

Run Claude-compatible JavaScript workflow files from a selected project through the Codex provider.
Definitions are discovered from the read-only `/workspace/.claude/workflows` tree and exposed as
thirteen MCP tools for discovery, execution, durable status/events, resume, cancellation, results,
and per-agent evidence.

## Configuration

- Select an absolute project directory containing `.claude/workflows`.
- Select a project that does not contain `.codex` configuration. The image checks this at every
  provider attempt, so configuration created after server startup is refused as well.
- Provide `workflow-mcp.openai_api_key` through Docker Desktop's secret UI.
- The catalog profile fixes `WORKFLOW_MCP_CONCURRENCY=1` to fit its one-CPU/two-GiB server budget.

The Catalog's static `tools.json` describes `workflow_run.args` as an object because the Catalog
inventory format has no `unknown` JSON type. The live MCP schema is authoritative and accepts any
JSON-compatible value; clients that need an array, scalar, or null pass it through the MCP call.

The project is read-only, project-controlled `.codex` configuration is refused, and the image runs
as UID/GID 10001 with no host Docker socket. Refusal avoids a shared Catalog mask volume that another
container could mutate after verification. Catalog mode does not
attach a durable `/data` volume: its container-local runs and approvals are discarded with that
server container, preventing two projects/profiles from sharing a global volume name.

## Lifecycle boundary

This catalog entry uses the image's generic session-bound STDIO mode. Closing or restarting the
catalog MCP server also closes its in-process workflow owner and discards its session state. Runs
cannot be resumed after that container is removed, and unattended execution is not promised across
the stop.

For independent long-running execution, the terminal UI, optional loopback browser UI, interactive
device authentication, source-authoring approvals, offline backup/restore, and upgrade/adoption,
use the verified checksummed Compose/launcher bundle from the matching GitHub release. The Docker
Catalog entry is intentionally not presented as that full daemon product.
