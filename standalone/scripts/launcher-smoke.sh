#!/bin/sh
set -eu
umask 077

bundle=${1:-$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)}
launcher=$bundle/workflow-mcp-docker
[ -x "$launcher" ] || { printf 'launcher smoke: executable launcher missing from %s\n' "$bundle" >&2; exit 1; }

temporary=$(mktemp -d "${TMPDIR:-/tmp}/workflow-mcp-launcher-smoke.XXXXXX")
temporary=$(CDPATH='' cd -- "$temporary" && pwd -P)
project=$temporary/project
installed=$project/.workflow-mcp/workflow-mcp-docker
reset_lock_holder=workflow-mcp-reset-race-$$
bogus_adoption_volume=

# WHY: `compose up --wait` reports only "container ... is unhealthy", and this gate then deletes
# the failed container during cleanup, which made the 2026-07 native-runner workspace-permission
# crash undiagnosable from CI logs alone. Before teardown, publish each installed instance's
# container state, resolved security options, health-probe history, and daemon output. Every line
# is an explicit field selection rather than raw `docker inspect`, so credential-bearing
# environment values can never enter a CI transcript.
dump_failure_diagnostics() {
  for instance_file in "$temporary"/*/.workflow-mcp/instance.json; do
    [ -f "$instance_file" ] || continue
    diagnosed_project=$(sed -n 's/.*"composeProjectName":"\([^"]*\)".*/\1/p' "$instance_file" | head -n 1)
    [ -n "$diagnosed_project" ] || continue
    for container_id in $(docker ps --all --quiet --filter "label=com.docker.compose.project=$diagnosed_project"); do
      docker inspect "$container_id" --format \
        'launcher smoke diagnostic: name={{.Name}} status={{.State.Status}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}} error={{.State.Error}} restarts={{.RestartCount}} security={{json .HostConfig.SecurityOpt}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' >&2 || true
      docker inspect "$container_id" --format \
        '{{if .State.Health}}{{range .State.Health.Log}}launcher smoke diagnostic: probe exit={{.ExitCode}} output={{printf "%.400s" .Output}}{{end}}{{end}}' >&2 || true
      docker logs --tail 100 "$container_id" >&2 2>&1 || true
    done
  done
}

cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  [ "$status" -eq 0 ] || dump_failure_diagnostics
  docker rm -f "$reset_lock_holder" >/dev/null 2>&1 || true
  [ -z "$bogus_adoption_volume" ] || docker volume rm "$bogus_adoption_volume" >/dev/null 2>&1 || true
  if [ -f "$project/.workflow-mcp/instance.json" ]; then
    instance_id=$(sed -n 's/.*"instanceId":"\([^"]*\)".*/\1/p' "$project/.workflow-mcp/instance.json" | head -n 1)
    "$installed" down >/dev/null 2>&1 || true
    if [ -n "$instance_id" ]; then
      "$installed" uninstall --delete-data "--confirm=$instance_id" >/dev/null 2>&1 || true
    fi
  fi
  if [ -f "$temporary/hardened-project/.workflow-mcp/instance.json" ]; then
    hardened_cleanup_id=$(sed -n 's/.*"instanceId":"\([^"]*\)".*/\1/p' "$temporary/hardened-project/.workflow-mcp/instance.json" | head -n 1)
    "$temporary/hardened-project/.workflow-mcp/workflow-mcp-docker" down >/dev/null 2>&1 || true
    [ -z "$hardened_cleanup_id" ] ||
      "$temporary/hardened-project/.workflow-mcp/workflow-mcp-docker" uninstall --delete-data "--confirm=$hardened_cleanup_id" >/dev/null 2>&1 || true
  fi
  # This is the exact private directory returned by mktemp above. Keeping all test state below one
  # leaf makes the release gate self-cleaning without ever resolving a user-provided removal path.
  rm -rf "$temporary"
  exit "$status"
}
trap cleanup EXIT HUP INT TERM

# Pin the Codex home to a fixture: the default install inherits the HOST's real ~/.codex/auth.json
# by design, and a release gate must never mount a maintainer's live credential into throwaway
# containers (CI was only clean by accident of runners having no Codex login). The fixture also
# makes host-auth detection deterministic in CI: the overlay path is exercised everywhere, with
# public modes so UID 10001 can read the seed through a native-Linux bind.
CODEX_HOME=$temporary/codex-home
export CODEX_HOME
mkdir -p "$CODEX_HOME"
printf '{"OPENAI_API_KEY":null,"tokens":{"access_token":"smoke-fixture","refresh_token":"smoke-fixture"}}\n' > "$CODEX_HOME/auth.json"
chmod 0755 "$CODEX_HOME"
chmod 0644 "$CODEX_HOME/auth.json"

mkdir -p "$project/.claude/workflows"
# macOS exposes /var through /private/var. Installation intentionally records `pwd -P`, so the
# expected generated command must use that same canonical spelling rather than the mktemp alias.
project=$(CDPATH='' cd -- "$project" && pwd -P)
installed=$project/.workflow-mcp/workflow-mcp-docker
unsafe_project=$temporary/$(printf 'terminal-escape-\033[2J')
mkdir "$unsafe_project"
if "$launcher" install "$unsafe_project" >"$temporary/unsafe-path.out" 2>&1; then
  echo 'installer accepted a terminal-control project path' >&2
  exit 1
fi
grep -Fqx 'workflow-mcp-docker: path contains terminal control, bidi, format, or malformed UTF-8 bytes' "$temporary/unsafe-path.out"
if LC_ALL=C od -An -tu1 "$temporary/unsafe-path.out" | awk '{ for (i=1;i<=NF;i++) if ($i==27) exit 1 }'; then :; else
  echo 'installer reflected a terminal-control project path into diagnostics' >&2
  exit 1
fi
cat > "$project/.claude/workflows/release-smoke.js" <<'EOF'
export const meta = {
  name: 'release-smoke',
  description: 'Published launcher and MCP transport contract'
}
return 'published launcher smoke complete'
EOF
# WHY: the Compose bind preserves the host fixture's real owner and mode bits on a native Linux
# engine, while Docker Desktop's file sharing rewrites bind ownership and hides restrictive modes.
# This script runs under `umask 077`, so without these explicit public modes the daemon's unrelated
# UID 10001 cannot even traverse /workspace on the hosted Ubuntu runner: startup workspace
# discovery fails with EACCES, the container exits, and `up --wait` reports only "unhealthy".
# Publishing the documented readable-project precondition here measures the launcher contract
# instead of the runner account's ambient umask, exactly like the container-smoke fixtures.
chmod 0755 "$project" "$project/.claude" "$project/.claude/workflows"
chmod 0644 "$project/.claude/workflows/release-smoke.js"

# Credential validation is an install precondition, including when authoring was requested. A bad
# secret must not leave behind either the writable workflow tree or a partial ownership directory.
bad_credential_project=$temporary/bad-credential-project
mkdir "$bad_credential_project"
if "$launcher" install "$bad_credential_project" --authoring \
  "--api-key-file=$temporary/does-not-exist" >/dev/null 2>&1; then
  echo 'installer accepted a missing API-key file' >&2
  exit 1
fi
test ! -e "$bad_credential_project/.claude"
test ! -e "$bad_credential_project/.workflow-mcp"

# The recorded path is intentionally rotatable, so installation cannot be the last content/readability
# check. A malformed later inode must be rejected before Compose creates even the named volume.
rotated_credential_project=$temporary/rotated-credential-project
rotated_credential_file=$temporary/rotated-openai-key
mkdir "$rotated_credential_project"
printf 'sk-launcher-smoke\n' > "$rotated_credential_file"
chmod 644 "$rotated_credential_file"
"$launcher" install "$rotated_credential_project" --no-codex \
  "--api-key-file=$rotated_credential_file" >/dev/null
rotated_credential_launcher=$rotated_credential_project/.workflow-mcp/workflow-mcp-docker
rotated_compose=$(sed -n 's/.*"composeProjectName":"\([^"]*\)".*/\1/p' \
  "$rotated_credential_project/.workflow-mcp/instance.json" | head -n 1)
printf 'malformed key with spaces\n' > "$rotated_credential_file"
if "$rotated_credential_launcher" up >/dev/null 2>&1; then
  echo 'up accepted malformed API-key bytes after installation' >&2
  exit 1
fi
if docker volume inspect "${rotated_compose}_workflow-mcp-data" >/dev/null 2>&1; then
  "$rotated_credential_launcher" down >/dev/null 2>&1 || true
  docker volume rm "${rotated_compose}_workflow-mcp-data" >/dev/null 2>&1 || true
  echo 'API-key runtime refusal happened after Compose mutation' >&2
  exit 1
fi

# A checkout controls names below the project, while installation runs with the human's host
# authority. Prove both an ownership-root symlink and an existing directory with a malicious leaf
# are rejected before Copy-Item/cp can follow them into an unrelated sentinel.
printf 'host sentinel must survive\n' > "$temporary/sentinel"
mkdir "$temporary/attacker-installation"
ln -s "$temporary/attacker-installation" "$project/.workflow-mcp"
if "$launcher" install "$project" >/dev/null 2>&1; then
  echo 'installer accepted a symlinked ownership root' >&2
  exit 1
fi
grep -Fqx 'host sentinel must survive' "$temporary/sentinel"
rm "$project/.workflow-mcp"
mkdir "$project/.workflow-mcp"
ln -s "$temporary/sentinel" "$project/.workflow-mcp/compose.yaml"
if "$launcher" install "$project" >/dev/null 2>&1; then
  echo 'installer accepted a pre-existing directory with a redirected leaf' >&2
  exit 1
fi
grep -Fqx 'host sentinel must survive' "$temporary/sentinel"
rm "$project/.workflow-mcp/compose.yaml"
rmdir "$project/.workflow-mcp"

"$launcher" install "$project"
[ -x "$installed" ] || { echo 'installed project launcher is not executable' >&2; exit 1; }
installed_image=$(sed -n 's/^WORKFLOW_MCP_IMAGE=//p' "$project/.workflow-mcp/version.env" | head -n 1)
grep -Fq "command = \"$installed\"" "$project/.codex/config.toml"
grep -Fq 'args = ["mcp-proxy"]' "$project/.codex/config.toml"

# A never-started install has no durable volume. Uninstall must not erase the only instance record
# or its Codex stanza and then falsely claim that data was preserved.
missing_volume_project=$temporary/missing-volume-project
mkdir "$missing_volume_project"
"$launcher" install "$missing_volume_project" >/dev/null
missing_volume_launcher=$missing_volume_project/.workflow-mcp/workflow-mcp-docker
if "$missing_volume_launcher" uninstall >/dev/null 2>&1; then
  echo 'uninstall accepted a missing durable volume' >&2
  exit 1
fi
test -f "$missing_volume_project/.workflow-mcp/instance.json"
grep -q '^\[mcp_servers\.workflow_mcp\]$' "$missing_volume_project/.codex/config.toml"

# Matching UUID/project labels are insufficient when an engine was reset behind the same context
# name and socket. Adoption is bound to the domain-separated Docker daemon identity as well.
wrong_daemon_project=$temporary/wrong-daemon-project
mkdir "$wrong_daemon_project"
wrong_daemon_project=$(CDPATH='' cd -- "$wrong_daemon_project" && pwd -P)
wrong_daemon_instance=12345678-1234-4234-9234-123456789abc
wrong_daemon_compact=$(printf '%s' "$wrong_daemon_instance" | tr -d '-')
wrong_daemon_compose=workflow-mcp-$(printf '%.16s' "$wrong_daemon_compact")
bogus_adoption_volume=${wrong_daemon_compose}_workflow-mcp-data
wrong_daemon_hash=$(docker run --rm "$installed_image" instance hash "--project=$wrong_daemon_project")
docker volume create \
  --label "io.workflow-mcp.instance-id=$wrong_daemon_instance" \
  --label "io.workflow-mcp.project-hash=$wrong_daemon_hash" \
  --label 'io.workflow-mcp.docker-daemon-fingerprint=0000000000000000000000000000000000000000000000000000000000000000' \
  "$bogus_adoption_volume" >/dev/null
if "$launcher" install "$wrong_daemon_project" "--adopt-instance=$wrong_daemon_instance" >/dev/null 2>&1; then
  echo 'installer adopted a volume from a different Docker daemon' >&2
  exit 1
fi
test ! -e "$wrong_daemon_project/.workflow-mcp"
docker volume rm "$bogus_adoption_volume" >/dev/null
bogus_adoption_volume=

# Inject the exact durable shape left after an interruption during the public-file switch. The next
# installed launcher must restore every old byte before it sources the deliberately corrupt image
# authority, proving recovery is a startup invariant rather than only an in-process catch block.
mkdir -m 700 "$project/.workflow-mcp/.upgrade-rollback" "$project/.workflow-mcp/.upgrade-stage"
expected_image=$(sed -n '/^WORKFLOW_MCP_IMAGE=/p' "$project/.workflow-mcp/version.env")
for name in LICENSE SHA256SUMS compose.yaml compose.web.yaml compose.authoring.yaml compose.auth-api-key.yaml compose.auth-host-codex.yaml compose.hardened.yaml compose.project-codex-mask.yaml workflow-mcp-docker workflow-mcp-docker.ps1 version.env .gitignore instance.json; do
  cp "$project/.workflow-mcp/$name" "$project/.workflow-mcp/.upgrade-rollback/$name"
done
printf 'workflow-mcp-upgrade-v1\n' > "$project/.workflow-mcp/.upgrade-transaction"
printf 'WORKFLOW_MCP_IMAGE=invalid torn authority\n' > "$project/.workflow-mcp/version.env"
"$installed" help >/dev/null
grep -Fqx "$expected_image" "$project/.workflow-mcp/version.env"
test ! -e "$project/.workflow-mcp/.upgrade-transaction"

"$installed" up
"$installed" status --json > "$temporary/status.json"
grep -q '^{' "$temporary/status.json"
grep -q '"lifecycle":"READY"' "$temporary/status.json"
# The default profile turns the read-only dashboard on with no token — but only on engines at or
# above the 28.3.3 loopback-publication floor; older engines must DOWNGRADE the default instead of
# blocking the install (GitHub's ubuntu-24.04 runner currently ships 28.0.4, so CI exercises the
# downgrade branch while developer machines exercise the web branch). Branch on what the install
# actually recorded, and keep the downgrade branch honest by proving the engine really is old.
if grep -q '"webPort"' "$project/.workflow-mcp/instance.json"; then
  # Prove the three properties that replaced the bearer: loopback API answers unauthenticated,
  # the daemon reports the default authoring posture, and a foreign Host header is still refused
  # (the DNS-rebinding guard stays).
  curl -fsS http://127.0.0.1:7331/readyz | grep -q '"status":"ready"'
  curl -fsS http://127.0.0.1:7331/api/v1/instance > "$temporary/web-instance.json"
  grep -q '"sourceMode":"authoring"' "$temporary/web-instance.json"
  [ "$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: attacker.example' http://127.0.0.1:7331/api/v1/instance)" = 421 ]
else
  smoke_engine=$(docker version --format '{{.Server.Version}}' | sed 's/[^0-9.].*$//')
  old_ifs=$IFS; IFS=.
  # Deliberate POSIX field split of an already digits-and-dots value; cannot glob.
  # shellcheck disable=SC2086
  set -- $smoke_engine; smoke_major=${1:-0}; smoke_minor=${2:-0}; smoke_patch=${3:-0}
  IFS=$old_ifs
  if [ "$smoke_major" -gt 28 ] ||
    { [ "$smoke_major" -eq 28 ] && [ "$smoke_minor" -gt 3 ]; } ||
    { [ "$smoke_major" -eq 28 ] && [ "$smoke_minor" -eq 3 ] && [ "$smoke_patch" -ge 3 ]; }; then
    echo "default install skipped the web UI although engine $smoke_engine supports it" >&2
    exit 1
  fi
fi
"$installed" doctor > "$temporary/doctor.json"
grep -q '"schemaVersion":1,"ok":true,"host":' "$temporary/doctor.json"
grep -q '"container":{"schemaVersion":1,"ok":true' "$temporary/doctor.json"
grep -q '"identityVerdict":{"ok":true' "$temporary/doctor.json"
# A completed doctor uses exit 3 to carry a valid detailed failure report. Remove only the cached
# proof (which the running daemon does not mutate after startup), prove the launcher retains that
# exact failed check, then restart so the fenced owner recreates it for the rest of the smoke.
compose_project=$(sed -n 's/.*"composeProjectName":"\([^"]*\)".*/\1/p' "$project/.workflow-mcp/instance.json" | head -n 1)
docker run --rm --network none --read-only --user 0:0 \
  --entrypoint /bin/rm \
  --mount "type=volume,src=${compose_project}_workflow-mcp-data,dst=/data,volume-nocopy" \
  "$installed_image" -f /data/config/durability-proof.json
detailed_doctor_exit=0
if "$installed" doctor > "$temporary/detailed-failure-doctor.json"; then
  echo 'doctor returned success after a deliberate container check failure' >&2
  exit 1
else
  detailed_doctor_exit=$?
fi
[ "$detailed_doctor_exit" -eq 3 ] || { echo "failing doctor returned $detailed_doctor_exit instead of 3" >&2; exit 1; }
grep -q '"id":"data-fsync","status":"fail"' "$temporary/detailed-failure-doctor.json"
if grep -q '"id":"container-availability"' "$temporary/detailed-failure-doctor.json"; then
  echo 'launcher discarded a completed doctor report as container-unavailable' >&2
  exit 1
fi
"$installed" down
# The restart doubles as the auto-up contract check: mcp-proxy against a stopped daemon must
# start it itself (Codex connecting is the real lifecycle trigger) while its stdout carries ONLY
# MCP JSON-RPC — every recovery-start progress byte belongs on stderr. Any Compose noise on
# stdout makes the first-line JSON assertion fail.
cat > "$temporary/auto-up-requests.jsonl" <<'EOF'
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"auto-up-smoke","version":"1"}}}
{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"workflow_list","arguments":{}}}
EOF
"$installed" mcp-proxy < "$temporary/auto-up-requests.jsonl" > "$temporary/auto-up-responses.jsonl" 2>"$temporary/auto-up-stderr.log"
head -c 1 "$temporary/auto-up-responses.jsonl" | grep -q '{'
grep -q '"release-smoke"' "$temporary/auto-up-responses.jsonl"
"$installed" ui --snapshot > "$temporary/ui-snapshot.txt"
grep -q '^Workflow MCP ' "$temporary/ui-snapshot.txt"

# The hardened profile is the one recorded bit that must restore the entire original posture. If
# this leg rots, "hardened" becomes marketing: prove the read-only source mode is derived from the
# profile, that inline MCP authoring is refused again, and that a workflow visible at startup
# still runs under the snapshot approval boundary — the exact behaviors the default removed.
hardened_project=$temporary/hardened-project
mkdir -p "$hardened_project/.claude/workflows"
cat > "$hardened_project/.claude/workflows/hardened-smoke.js" <<'EOF'
export const meta = { name: 'hardened-smoke', description: 'Hardened profile gate fixture' }
return 'hardened gate passed'
EOF
chmod 0755 "$hardened_project" "$hardened_project/.claude" "$hardened_project/.claude/workflows"
chmod 0644 "$hardened_project/.claude/workflows/hardened-smoke.js"
"$launcher" install "$hardened_project" --hardened --no-codex >/dev/null
hardened_launcher=$hardened_project/.workflow-mcp/workflow-mcp-docker
hardened_instance=$(sed -n 's/.*"instanceId":"\([^"]*\)".*/\1/p' "$hardened_project/.workflow-mcp/instance.json" | head -n 1)
"$hardened_launcher" up >/dev/null 2>&1
"$hardened_launcher" status --json | grep -q '"sourceMode":"read-only"'
cat > "$temporary/hardened-requests.jsonl" <<'EOF'
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"hardened-smoke","version":"1"}}}
{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"workflow_run","arguments":{"script":"export const meta = { name: 'refused', description: 'must not author' }\nreturn 1","idempotencyKey":"hardened-refusal"}}}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"workflow_run","arguments":{"name":"hardened-smoke","idempotencyKey":"hardened-startup-approved"}}}
EOF
"$hardened_launcher" mcp-proxy < "$temporary/hardened-requests.jsonl" > "$temporary/hardened-responses.jsonl"
grep -q 'authoring-disabled' "$temporary/hardened-responses.jsonl"
grep -q '"hardened-smoke"' "$temporary/hardened-responses.jsonl"
"$hardened_launcher" down >/dev/null 2>&1
"$hardened_launcher" uninstall --delete-data "--confirm=$hardened_instance" >/dev/null

# A copied trusted bundle is the recovery entry point when the installed launcher is missing. It
# must authenticate executable Compose policy against the immutable image, not a project-owned
# checksum that can be changed alongside the policy.
cp "$project/.workflow-mcp/compose.yaml" "$temporary/original-compose.yaml"
printf '\n# hostile recovery-policy edit\n' >> "$project/.workflow-mcp/compose.yaml"
if "$launcher" status "$project" >/dev/null 2>&1; then
  echo 'external recovery launcher trusted modified installed Compose policy' >&2
  exit 1
fi
mv "$temporary/original-compose.yaml" "$project/.workflow-mcp/compose.yaml"
"$installed" status --json | grep -q '"lifecycle":"READY"'

# Redirecting the host stream must survive Compose's default pseudo-TTY behavior. The explicit
# force escape hatch is retained for intentional automation, but ordinary pipes never receive a
# bearer token.
if "$installed" token --purpose=mcp > "$temporary/token-refused.txt" 2>&1; then
  echo 'token command printed a secret to redirected output without --force' >&2
  exit 1
fi
grep -q 'Refusing to print a token without a TTY' "$temporary/token-refused.txt"
"$installed" token --purpose=mcp --force > "$temporary/token-forced.txt"
test -s "$temporary/token-forced.txt"

# Post-install checkout retargeting must be refused before a healthy service is stopped and before
# an attacker-controlled config file is touched.
mv "$project/.codex" "$project/.codex.workflow-mcp-original"
mkdir "$temporary/attacker-codex"
printf 'attacker sentinel must survive\n' > "$temporary/attacker-codex/config.toml"
ln -s "$temporary/attacker-codex" "$project/.codex"
if "$installed" uninstall >/dev/null 2>&1; then
  echo 'uninstall followed a redirected Codex config directory' >&2
  exit 1
fi
grep -Fqx 'attacker sentinel must survive' "$temporary/attacker-codex/config.toml"
rm "$project/.codex"
mv "$project/.codex.workflow-mcp-original" "$project/.codex"
"$installed" status --json | grep -q '"lifecycle":"READY"'

# The protocol transcript uses only public MCP messages. It proves the generated Codex command can
# initialize, enumerate tools, and execute a project workflow while the daemon stays independently
# alive; testing only `help` would miss launcher, Compose, token, proxy, and transport regressions.
cat > "$temporary/requests.jsonl" <<'EOF'
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"release-smoke","version":"1"}}}
{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"workflow_run","arguments":{"name":"release-smoke","idempotencyKey":"published-release-smoke"}}}
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"workflow_run","arguments":{"script":"export const meta = { name: 'inline-default-smoke', description: 'Default profile inline authoring' }\nreturn 'inline authoring ran without approval'","idempotencyKey":"published-inline-default"}}}
EOF
"$installed" mcp-proxy < "$temporary/requests.jsonl" > "$temporary/responses.jsonl"
grep -q '"workflow_list"' "$temporary/responses.jsonl"
grep -q '"id":3' "$temporary/responses.jsonl"
grep -q '"ok":true' "$temporary/responses.jsonl"
# The product's headline default flow: an inline-authored workflow persists AND runs with no
# approval step. A source-approval-required refusal here means the default profile regressed
# into the hardened gate. (Match the exact error tokens — tool descriptions legitimately contain
# the word "approval".)
if grep -Eq 'source-approval-required|authoring-disabled|Workflow source approval is required' "$temporary/responses.jsonl"; then
  echo 'default profile demanded source approval for inline-authored workflow' >&2
  exit 1
fi
grep -q '"inline-default-smoke"' "$temporary/responses.jsonl"
test -f "$project/.claude/workflows/inline-default-smoke.js"
run_id=$(docker run --rm --network none --read-only -i --entrypoint /usr/local/bin/node \
  "$installed_image" -e '
  const fs=require("node:fs");
  for(const line of fs.readFileSync(0,"utf8").trim().split("\n")) {
    const message=JSON.parse(line); if(message.id===3) process.stdout.write(message.result.structuredContent.run.runId);
  }
' < "$temporary/responses.jsonl")
attempt=0
while :; do
  "$installed" status --json > "$temporary/run-status.json"
  terminal=$(docker run --rm --network none --read-only -i -e "RUN_ID=$run_id" \
    --entrypoint /usr/local/bin/node "$installed_image" -e '
    const fs=require("node:fs"), response=JSON.parse(fs.readFileSync(0,"utf8"));
    const run=response.runs.items.find(item=>item.runId===process.env.RUN_ID);
    process.stdout.write(run?.status==="completed" ? "yes" : "no");
  ' < "$temporary/run-status.json")
  [ "$terminal" != yes ] || break
  attempt=$((attempt + 1))
  [ "$attempt" -lt 30 ] || { echo "launcher smoke run did not complete" >&2; exit 1; }
  sleep 1
done
if "$installed" backup create "--output=$temporary/unsafe backup name" >/dev/null 2>&1; then
  echo 'backup accepted a filename outside the portable safe-leaf grammar' >&2
  exit 1
fi
"$installed" status --json | grep -q '"lifecycle":"READY"'
oversized_backup_name=$(awk 'BEGIN { for (i = 0; i < 198; i++) printf "a" }')
if "$installed" backup create "--output=$temporary/$oversized_backup_name" >/dev/null 2>&1; then
  echo 'backup accepted an output leaf whose checksum staging suffix exceeds NAME_MAX' >&2
  exit 1
fi
"$installed" status --json | grep -q '"lifecycle":"READY"'
mkdir "$temporary/comma,output"
if "$installed" backup create "--output=$temporary/comma,output/release-smoke.backup" >/dev/null 2>&1; then
  echo 'backup accepted an unsupported comma-containing bind directory' >&2
  exit 1
fi
# Both refusals must happen before Compose down; an exit code alone would miss the availability bug.
"$installed" status --json | grep -q '"lifecycle":"READY"'
"$installed" backup create "--output=$temporary/release-smoke.backup" \
  2> "$temporary/backup-create.stderr"
grep -q 'Workflow MCP remains offline after backup' "$temporary/backup-create.stderr"
test -s "$temporary/release-smoke.backup"
test -s "$temporary/release-smoke.backup.sha256"
"$installed" backup verify "--input=$temporary/release-smoke.backup" >/dev/null
doctor_exit=0
if "$installed" doctor > "$temporary/stopped-doctor.json"; then
  echo 'doctor returned success while the daemon was stopped' >&2
  exit 1
else
  doctor_exit=$?
fi
[ "$doctor_exit" -eq 3 ] || { echo "stopped doctor returned $doctor_exit instead of 3" >&2; exit 1; }
grep -q '"schemaVersion":1,"ok":false' "$temporary/stopped-doctor.json"

instance_id=$(sed -n 's/.*"instanceId":"\([^"]*\)".*/\1/p' "$project/.workflow-mcp/instance.json" | head -n 1)
# Model the only state for which reset-target is valid: a restore process wrote and fsynced its
# identity-bound poison marker, then died before commit. Using healthy data beneath the marker also
# proves startup classification cannot be fooled by an otherwise valid layout.
project_hash=$(sed -n 's/.*"projectHash":"\([^"]*\)".*/\1/p' "$project/.workflow-mcp/instance.json" | head -n 1)
docker run --rm --network none --read-only --user 10001:10001 \
  -e "MARKER_INSTANCE=$instance_id" -e "MARKER_PROJECT=$project_hash" \
  --mount "type=volume,src=${compose_project}_workflow-mcp-data,dst=/data,volume-nocopy" \
  --entrypoint /usr/local/bin/node "$installed_image" -e '
    const fs=require("node:fs");
    const path="/data/.restore-in-progress.json";
    const fd=fs.openSync(path,"wx",0o600);
    fs.writeFileSync(fd,JSON.stringify({schemaVersion:1,instanceId:process.env.MARKER_INSTANCE,projectHash:process.env.MARKER_PROJECT,archiveSha256:"0".repeat(64)})+"\n");
    fs.fsyncSync(fd);fs.closeSync(fd);
    const root=fs.openSync("/data","r");fs.fsyncSync(root);fs.closeSync(root);
  '
if "$installed" restore reset-target --confirm=wrong-instance >/dev/null 2>&1; then
  echo 'restore target reset accepted a wrong instance confirmation' >&2
  exit 1
fi
# Hold the exact immutable owner inode while reset validates the poison marker. The checker must
# lose before it can publish a reset claim, and the launcher must preserve the volume. This models
# the old check/restore/delete race deterministically without relying on extraction timing.
docker run -d --name "$reset_lock_holder" --network none --read-only --user 10001:10001 \
  --mount "type=volume,src=${compose_project}_workflow-mcp-data,dst=/data,volume-nocopy" \
  --entrypoint /opt/workflow-mcp/native/workflow-mcp-lock "$installed_image" \
  /data/.coordination/owner.lock /usr/local/bin/node -e 'setTimeout(() => {}, 30000)' >/dev/null
if "$installed" restore reset-target "--confirm=$instance_id" >/dev/null 2>&1; then
  echo 'restore target reset raced an active volume owner' >&2
  exit 1
fi
docker volume inspect "${compose_project}_workflow-mcp-data" >/dev/null
docker rm -f "$reset_lock_holder" >/dev/null
"$installed" restore reset-target "--confirm=$instance_id"
"$installed" restore "--input=$temporary/release-smoke.backup"
"$installed" up
"$installed" status --json | grep -q '"runId":"run_'
"$installed" uninstall
if grep -q '^\[mcp_servers\.workflow_mcp\]$' "$project/.codex/config.toml"; then
  echo 'uninstall left its generated Codex MCP stanza behind' >&2
  exit 1
fi
# The running launcher is the one intentional uninstall remnant. Installation still requires an
# absent ownership root so a checkout cannot pre-seed redirected leaves; model the documented
# post-command cleanup before proving preserved-volume adoption.
rm "$installed"
rmdir "$project/.workflow-mcp"
"$launcher" install "$project" "--adopt-instance=$instance_id"
grep -q "\"instanceId\":\"$instance_id\"" "$project/.workflow-mcp/instance.json"
"$installed" up
"$installed" status --json > "$temporary/adopted-status.json"
grep -q '"runId":"run_' "$temporary/adopted-status.json"
"$installed" uninstall --delete-data "--confirm=$instance_id"

echo 'Published bundle install, daemon, Codex stanza, MCP proxy, and preserved-volume adoption smoke passed.'
