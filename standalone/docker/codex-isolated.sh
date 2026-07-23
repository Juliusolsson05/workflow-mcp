#!/bin/sh
set -eu

codex=/opt/workflow-mcp/node_modules/@openai/codex/bin/codex.js

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
  # The SDK invokes `codex exec`. Injecting at that exact boundary preserves login/doctor commands
  # while ensuring provider attempts cannot inherit mutable user config or user/project exec rules.
  # The optional Compose overlay separately masks project .codex as defense in depth; AGENTS.md
  # remains visible in both paths.
  exec node "$codex" exec --ignore-user-config --ignore-rules \
    -c 'shell_environment_policy.exclude=["OPENAI_API_KEY","WORKFLOW_MCP_MCP_TOKEN","WORKFLOW_MCP_WEB_TOKEN"]' \
    "$@"
fi

exec node "$codex" "$@"
