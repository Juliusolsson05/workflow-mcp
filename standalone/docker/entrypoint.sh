#!/bin/sh
set -eu

cli=/opt/workflow-mcp/standalone/dist/cli/main.js
lock_path=${WORKFLOW_MCP_LOCK_PATH:-${WORKFLOW_MCP_DATA_DIR:-/data}/.coordination/owner.lock}

case "${1:-help}" in
  bundle-render)
    # The rendered bundle must name the already-built image digest, so it cannot be embedded as a
    # static layer. Keeping the renderer and inputs in that image still makes the OCI artifact the
    # reproducible source; callers supply only immutable release identity and a writable output.
    shift
    exec node /opt/workflow-mcp/standalone/scripts/build-install-bundle.mjs "$@"
    ;;
  daemon|serve)
    # Both long-lived Compose mode and OCI STDIO compatibility mode can mutate /data. Routing them
    # through the same kernel owner prevents a catalog launch and a daemon from ever repairing or
    # executing the same installation concurrently.
    exec /opt/workflow-mcp/native/workflow-mcp-lock "$lock_path" node "$cli" "$@"
    ;;
  maintenance)
    case "${2:-}" in
      backup-verify|host-backup-commit)
        # Verification is read-only and often runs without a data volume. Host commit touches only
        # the launcher's exact output bind after the data-owning backup container has exited. Neither
        # operation owns /data. Neither helper may mutate service state.
        exec node "$cli" "$@"
        ;;
      backup-create|restore|restore-reset-check)
        # The reset checker publishes a durable reset claim while it owns the same flock as restore.
        # This is intentionally a mutating maintenance owner: a read-only check followed by host
        # deletion leaves a race in which another restore can commit between those two operations.
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
