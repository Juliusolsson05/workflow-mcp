#!/bin/sh
set -eu
umask 077

root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)
launcher=${1:-$root/install/workflow-mcp-docker}
[ -x "$launcher" ] || { echo 'host launcher path smoke requires an executable POSIX launcher' >&2; exit 1; }

temporary=$(mktemp -d "${TMPDIR:-/tmp}/workflow-mcp-host-path-smoke.XXXXXX")
cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  # This exact private leaf is the only test artifact. None of the deliberately hostile byte
  # strings below is ever used as a removal root.
  rm -rf "$temporary"
  exit "$status"
}
trap cleanup EXIT HUP INT TERM

assert_missing_directory() {
  if "$launcher" install "$1" >"$temporary/result" 2>&1; then
    echo 'host launcher unexpectedly installed a nonexistent test path' >&2
    exit 1
  fi
  test "$(cat "$temporary/result")" = 'workflow-mcp-docker: directory does not exist' || {
    echo 'host launcher rejected an ordinary path before directory validation' >&2
    exit 1
  }
}

assert_unsafe_path() {
  if "$launcher" install "$1" >"$temporary/result" 2>&1; then
    echo 'host launcher accepted an unsafe terminal path' >&2
    exit 1
  fi
  # WHY: checking the entire diagnostic proves the rejected bytes were not reflected around an
  # otherwise-safe prefix. This gate intentionally requires no Docker daemon and therefore runs
  # under the host's real awk implementation, including macOS One-True-Awk.
  test "$(cat "$temporary/result")" = \
    'workflow-mcp-docker: path contains terminal control, bidi, format, or malformed UTF-8 bytes' || {
      echo 'host launcher reflected or misclassified an unsafe terminal path' >&2
      exit 1
    }
}

assert_missing_directory "$temporary/ascii-does-not-exist"
assert_missing_directory "$temporary/utf8-å-does-not-exist"
assert_unsafe_path "$(printf '%s\033[2J' "$temporary/escape-")"
assert_unsafe_path "$(printf '%s\342\200\256' "$temporary/bidi-")"
assert_unsafe_path "$(printf '%s\300\257' "$temporary/malformed-")"

echo 'Host launcher ASCII, UTF-8, terminal-control, bidi, and malformed-path probes passed.'
