#!/bin/sh
set -eu

codex=/opt/workflow-mcp/node_modules/@openai/codex/bin/codex.js
policy_launcher=/opt/workflow-mcp/bin/codex-policy-launcher.mjs

# Docker cannot create a nested tmpfs mountpoint under a read-only bind when `.codex` does not
# already exist. The launcher therefore selects the mask overlay only for an existing directory;
# this attempt-time refusal closes the race where the host creates a project config afterwards.
#
# WHY the mount is the source of truth rather than WORKFLOW_MCP_PROJECT_CODEX_MASKED: that variable
# was only ever an attestation REQUEST, while the mount is the actual security boundary — which is
# why it was always re-proven below. Gating on the variable first meant any caller that rebuilt a
# minimal environment silently lost the attestation and hit the unmasked refusal even though a
# correct mask was mounted. The credential broker does exactly that (it strips the environment down
# to PATH/LANG/TERM/HOME/CODEX_HOME so a login child cannot inherit credentials), and because a
# default install always writes the project Codex stanza into <project>/.codex, `auth status` and
# `auth login` failed on 100% of default installations with an opaque exit 77 that surfaced to
# operators as EPIPE. Proving the mask directly fixes that whole class — every caller, not just the
# broker — without loosening anything: an unproven `.codex` is still refused exactly as before.
if [ -e /workspace/.codex ] || [ -L /workspace/.codex ]; then
  if [ ! -d /workspace/.codex ] || [ -L /workspace/.codex ]; then
    echo "codex-isolated: project Codex mask is not an ordinary directory" >&2
    exit 77
  fi
  [ -z "$(find /workspace/.codex -mindepth 1 -maxdepth 1 -print -quit)" ] || {
    echo "codex-isolated: refusing unmasked project /workspace/.codex configuration" >&2
    exit 77
  }
  if ! awk '$5 == "/workspace/.codex" { found=1 } END { if (!found) exit 3 }' /proc/self/mountinfo \
    || [ -w /workspace/.codex ]; then
    echo "codex-isolated: refusing unmasked project /workspace/.codex configuration" >&2
    exit 77
  fi
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

if [ "${1:-}" = policy-probe-authoring ]; then
  exec node "$policy_launcher" --self-test-authoring
fi

exec node "$codex" "$@"
