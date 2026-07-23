#!/bin/sh
# Workflow MCP one-command bootstrap.
#
#   curl -fsSL https://github.com/Juliusolsson05/workflow-mcp/releases/latest/download/install.sh | sh
#
# runs, in the current project directory: verify Docker, pull the digest-pinned release image,
# render the checksummed install bundle FROM that image (the image is the reproducible source of
# the bundle, so no separate download or checksum ceremony is needed here — integrity rides the
# image digest baked in at release render time), install the project-scoped launcher, start the
# daemon, and install a global `workflow-mcp` PATH shim. The old multi-command gh-attestation
# bootstrap remains documented in SECURITY.md as the optional high-assurance path; this script is
# the consumer default and must stay one paste with zero questions asked.
set -eu

# These three placeholders are replaced by the release pipeline with the immutable release
# identity. The literal underscore form only survives in a development checkout, where an explicit
# WORKFLOW_MCP_IMAGE is required instead so a dev run can never accidentally pull a mutable tag.
RELEASE_IMAGE='__WORKFLOW_MCP_RELEASE_IMAGE__'
RELEASE_VERSION='__WORKFLOW_MCP_RELEASE_VERSION__'
RELEASE_REVISION='__WORKFLOW_MCP_RELEASE_REVISION__'

fail() { printf 'workflow-mcp install: %s\n' "$1" >&2; exit 1; }

image=${WORKFLOW_MCP_IMAGE:-$RELEASE_IMAGE}
case "$image" in
  __WORKFLOW_MCP_RELEASE_IMAGE__)
    fail 'unrendered development copy; set WORKFLOW_MCP_IMAGE to a local image or use a released install.sh' ;;
esac

project=${1:-$PWD}
[ -d "$project" ] || fail "project directory does not exist: $project"
project=$(CDPATH='' cd -- "$project" && pwd -P)

command -v docker >/dev/null 2>&1 || fail 'Docker is required: https://docs.docker.com/get-docker/'
docker info >/dev/null 2>&1 || fail 'Docker is installed but not running; start Docker Desktop (or the engine) and rerun'

docker image inspect "$image" >/dev/null 2>&1 || docker pull "$image"

# Render the bundle from the image itself into a private temp dir. The container runs as the
# CALLING user so the rendered files are owned by them on every platform — the image's fixed UID
# 10001 could not write a 700 host temp dir on native Linux (bind mounts keep real host modes
# there; Docker Desktop hides this, which is exactly how such bugs used to reach CI first).
staging=$(mktemp -d "${TMPDIR:-/tmp}/workflow-mcp-bootstrap.XXXXXX")
trap 'rm -rf "$staging"' EXIT HUP INT TERM
set -- --output=/render/bundle "--image=$image"
[ "$RELEASE_VERSION" = '__WORKFLOW_MCP_RELEASE_VERSION__' ] || set -- "$@" "--version=$RELEASE_VERSION"
[ "$RELEASE_REVISION" = '__WORKFLOW_MCP_RELEASE_REVISION__' ] || set -- "$@" "--revision=$RELEASE_REVISION"
docker run --rm --network none --read-only --user "$(id -u):$(id -g)" \
  -v "$staging:/render" "$image" bundle-render "$@" >/dev/null

sh "$staging/bundle/workflow-mcp-docker" install "$project"
"$project/.workflow-mcp/workflow-mcp-docker" up

# Global shim: every later command is `workflow-mcp <verb>` from anywhere inside the project. The
# shim resolves the nearest installed launcher upward from $PWD, so one shim serves every project
# and never embeds a version. Refusing to overwrite a non-shim file keeps us out of foreign bins.
shim_dir=${WORKFLOW_MCP_BIN:-$HOME/.local/bin}
shim=$shim_dir/workflow-mcp
mkdir -p "$shim_dir"
if [ ! -e "$shim" ] || grep -q 'workflow-mcp shim v1' "$shim" 2>/dev/null; then
  cat > "$shim" <<'SHIM'
#!/bin/sh
# workflow-mcp shim v1: dispatch to the nearest project-installed launcher.
set -eu
directory=$PWD
while :; do
  if [ -x "$directory/.workflow-mcp/workflow-mcp-docker" ]; then
    exec "$directory/.workflow-mcp/workflow-mcp-docker" "$@"
  fi
  [ "$directory" != / ] || break
  directory=$(dirname "$directory")
done
printf 'workflow-mcp: no .workflow-mcp installation found from %s upward\n' "$PWD" >&2
exit 1
SHIM
  chmod 755 "$shim"
  # The backticked command name below is literal display text, not an expansion.
  # shellcheck disable=SC2016
  case ":$PATH:" in
    *":$shim_dir:"*) ;;
    *) printf 'Add %s to PATH to use the global `workflow-mcp` command.\n' "$shim_dir" ;;
  esac
else
  printf 'Skipped PATH shim: %s exists and is not a workflow-mcp shim.\n' "$shim"
fi

printf '\nWorkflow MCP is ready.\n'
printf '  Watch runs:   workflow-mcp ui   (or %s/.workflow-mcp/workflow-mcp-docker ui)\n' "$project"
printf '  Use it:       restart Codex inside %s\n' "$project"
