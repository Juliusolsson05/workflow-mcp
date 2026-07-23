#!/bin/sh
set -eu

cli=/opt/workflow-mcp/standalone/dist/cli/main.js
lock_path=${WORKFLOW_MCP_LOCK_PATH:-${WORKFLOW_MCP_DATA_DIR:-/data}/.coordination/owner.lock}

case "${1:-help}" in
  daemon|serve)
    # Both long-lived Compose mode and OCI STDIO compatibility mode can mutate /data. Routing them
    # through the same kernel owner prevents a catalog launch and a daemon from ever repairing or
    # executing the same installation concurrently.
    exec /opt/workflow-mcp/native/workflow-mcp-lock "$lock_path" node "$cli" "$@"
    ;;
  maintenance)
    case "${2:-}" in
      backup-verify)
        # Verification is read-only and often runs without a data volume. Identity and archive
        # checks are still enforced by the CLI, but minting an irrelevant /data lock would make
        # `--read-only` verification fail before opening its input bind.
        exec node "$cli" "$@"
        ;;
      backup-create|restore)
        exec /opt/workflow-mcp/native/workflow-mcp-lock "$lock_path" node "$cli" "$@"
        ;;
      *)
        echo "workflow-mcp: unknown maintenance action: ${2:-}" >&2
        exit 2
        ;;
    esac
    ;;
  *)
    # Proxy, UI, doctor, and health commands are clients. Giving them the owner FD would make an
    # innocent `docker compose exec` extend ownership beyond daemon shutdown.
    exec node "$cli" "$@"
    ;;
esac
