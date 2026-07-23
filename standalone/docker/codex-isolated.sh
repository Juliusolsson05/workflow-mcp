#!/bin/sh
set -eu

codex=/opt/workflow-mcp/node_modules/@openai/codex/bin/codex.js
policy_launcher=/opt/workflow-mcp/bin/codex-policy-launcher.mjs

# Docker cannot create a nested tmpfs mountpoint under a read-only bind when `.codex` does not
# already exist. The launcher therefore selects the mask overlay only for an existing directory;
# this attempt-time refusal closes the race where the host creates a project config afterwards.
if { [ -e /workspace/.codex ] || [ -L /workspace/.codex ]; } \
  && [ "${WORKFLOW_MCP_PROJECT_CODEX_MASKED:-false}" != true ]; then
  echo "codex-isolated: refusing unmasked project /workspace/.codex configuration" >&2
  exit 77
fi

if [ -n "${WORKFLOW_MCP_OPENAI_API_KEY_FILE:-}" ]; then
  if [ ! -r "$WORKFLOW_MCP_OPENAI_API_KEY_FILE" ]; then
    echo "codex-isolated: configured API key secret is not readable" >&2
    exit 78
  fi
  OPENAI_API_KEY=$(sed -n '1p' "$WORKFLOW_MCP_OPENAI_API_KEY_FILE")
  if [ -z "$OPENAI_API_KEY" ]; then
    echo "codex-isolated: configured API key secret is empty" >&2
    exit 78
  fi
  export OPENAI_API_KEY
fi

if [ "${1:-}" = exec ]; then
  shift
  # The SDK still emits legacy --sandbox flags. The policy launcher replaces
  # those with managed permission profiles so same-UID tool commands cannot
  # read daemon/Codex credentials and every shell lives in a PID namespace.
  exec node "$policy_launcher" "$@"
fi

if [ "${1:-}" = policy-probe ]; then
  exec node "$policy_launcher" --self-test
fi

exec node "$codex" "$@"
