#!/bin/sh
set -eu
umask 077

image=${1:?usage: container-smoke.sh IMAGE}
standalone_root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)
repository_root=$(CDPATH='' cd -- "$standalone_root/.." && pwd -P)
temporary=$(mktemp -d "${TMPDIR:-/tmp}/workflow-mcp-container-smoke.XXXXXX")
suffix=$$
derived_image=workflow-mcp-derived-smoke-$suffix
container=workflow-mcp-smoke-$suffix
replacement_container=workflow-mcp-smoke-replacement-$suffix
volume=workflow-mcp-smoke-$suffix
restore_volume=workflow-mcp-smoke-restore-$suffix
secret_volume=workflow-mcp-smoke-secret-$suffix
export_volume=workflow-mcp-smoke-export-$suffix
input_volume=workflow-mcp-smoke-input-$suffix
catalog_mask_volume=workflow-mcp-smoke-catalog-mask-$suffix
stdio_volume=workflow-mcp-smoke-stdio-$suffix
network=workflow-mcp-smoke-network-$suffix
listener=workflow-mcp-smoke-listener-$suffix
staging_container=workflow-mcp-smoke-staging-$suffix
export_container=workflow-mcp-smoke-export-$suffix

cleanup() {
  docker rm -f "$container" "$replacement_container" "$listener" "$staging_container" "$export_container" >/dev/null 2>&1 || true
  docker volume rm "$volume" "$restore_volume" "$secret_volume" "$export_volume" "$input_volume" "$catalog_mask_volume" "$stdio_volume" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  docker image rm "$derived_image" >/dev/null 2>&1 || true
  # `temporary` is an exact mktemp result owned by this process. No user-supplied or unresolved
  # path can reach this cleanup target.
  rm -rf "$temporary"
}
trap cleanup EXIT HUP INT TERM

mkdir -p "$temporary/workspace/.claude/workflows" "$temporary/catalog-workspace/.codex" "$temporary/output"
cat > "$temporary/workspace/.claude/workflows/smoke.js" <<'EOF'
export const meta = { name: 'smoke', description: 'Container contract fixture' }
return 'container smoke complete'
EOF
cat > "$temporary/catalog-workspace/.codex/config.toml" <<'EOF'
[mcp_servers.hostile]
command = "must-not-copy-into-mask"
EOF
cat > "$temporary/output/openai_api_key" <<'EOF'
workflow-mcp-nonsecret-container-probe
EOF

# WHY: bind mounts retain the host fixture's mode bits. Hosted runners are free to choose a
# defensive umask, while the final image intentionally runs as unrelated uid 10001. If these
# inputs inherit 0700/0600, the policy wrapper cannot stat `.codex` and the refusal probe appears
# to accept the workspace merely because it was unreadable. Fix the public fixture modes so this
# gate measures the image's isolation decision, not the runner account's ambient umask.
chmod 0755 \
  "$temporary/workspace" \
  "$temporary/workspace/.claude" \
  "$temporary/workspace/.claude/workflows" \
  "$temporary/catalog-workspace" \
  "$temporary/catalog-workspace/.codex"
chmod 0644 \
  "$temporary/workspace/.claude/workflows/smoke.js" \
  "$temporary/catalog-workspace/.codex/config.toml"

# WHY: the documented extension image is an operator-facing compatibility contract, not illustrative
# prose. Building it from the exact candidate catches base-distribution/package-manager drift, and
# executing the installed tool as the final non-root user proves the example did not merely parse.
docker build --quiet --build-arg "WORKFLOW_MCP_IMAGE=$image" \
  --file "$standalone_root/docker/Dockerfile.example-toolchain" \
  --tag "$derived_image" "$repository_root" >/dev/null
docker run --rm --network none --read-only --user 10001:10001 \
  --entrypoint /usr/bin/make "$derived_image" --version >/dev/null

instance_id=11111111-2222-4333-8444-555555555555
project_hash=$(docker run --rm "$image" instance hash --project=/workspace)
docker volume create "$volume" >/dev/null
docker volume create "$restore_volume" >/dev/null
docker volume create "$secret_volume" >/dev/null
docker volume create "$export_volume" >/dev/null
docker volume create "$input_volume" >/dev/null
docker volume create "$catalog_mask_volume" >/dev/null
docker volume create "$stdio_volume" >/dev/null
docker network create "$network" >/dev/null
docker run -d --name "$listener" --network "$network" --entrypoint /usr/local/bin/node "$image" \
  -e 'require("node:net").createServer(socket=>socket.end()).listen(4567,"0.0.0.0")' >/dev/null
attempt=0
until docker exec "$listener" /usr/local/bin/node -e \
  'const s=require("node:net").connect(4567,"127.0.0.1");s.on("connect",()=>{s.destroy();process.exit(0)});s.on("error",()=>process.exit(1))' >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 10 ] || { docker logs "$listener" >&2; exit 1; }
  sleep 1
done

# The published Catalog contract has no shared mask: it refuses any project-controlled `.codex`
# directory and accepts the same read-only bind when that directory is absent. This exact pair
# guards against metadata/image drift before the lower-level Compose mask defense is exercised.
if docker run --rm --network none --read-only --user 10001:10001 \
  --mount "type=bind,src=$temporary/catalog-workspace,dst=/workspace,readonly" \
  --entrypoint /opt/workflow-mcp/bin/codex-isolated "$image" --version >/dev/null 2>&1; then
  echo 'Catalog profile accepted project-controlled .codex configuration' >&2
  exit 1
fi
docker run --rm --network none --read-only --user 10001:10001 \
  --mount "type=bind,src=$temporary/workspace,dst=/workspace,readonly" \
  --entrypoint /opt/workflow-mcp/bin/codex-isolated "$image" --version >/dev/null

# The checksummed Compose launcher can conditionally add a private per-container tmpfs mask. Its
# empty/no-copy invariant remains independently tested so a future overlay change cannot seed or
# accept hostile configuration even though the Catalog intentionally uses refusal instead.
docker run --rm --network none --read-only --user 10001:10001 \
  -e WORKFLOW_MCP_PROJECT_CODEX_MASKED=true \
  --mount "type=bind,src=$temporary/catalog-workspace,dst=/workspace,readonly" \
  --mount "type=volume,src=$catalog_mask_volume,dst=/workspace/.codex,readonly,volume-nocopy" \
  --entrypoint /bin/sh "$image" -c 'test ! -e /workspace/.codex/config.toml'
docker run --rm --network none --read-only --user 0:0 \
  --mount "type=volume,src=$catalog_mask_volume,dst=/mask,volume-nocopy" \
  --entrypoint /bin/sh "$image" -c 'printf hostile > /mask/config.toml'
if docker run --rm --network none --read-only --user 10001:10001 \
  -e WORKFLOW_MCP_PROJECT_CODEX_MASKED=true \
  --mount "type=bind,src=$temporary/catalog-workspace,dst=/workspace,readonly" \
  --mount "type=volume,src=$catalog_mask_volume,dst=/workspace/.codex,readonly,volume-nocopy" \
  --entrypoint /opt/workflow-mcp/bin/codex-isolated "$image" --version >/dev/null 2>&1; then
  echo 'contaminated project Codex mask was accepted' >&2
  exit 1
fi
docker run --rm --network none --read-only --user 10001:10001 \
  -e WORKFLOW_MCP_PROJECT_CODEX_MASKED=true \
  --mount "type=bind,src=$temporary/catalog-workspace,dst=/workspace,readonly" \
  --tmpfs /workspace/.codex:ro,size=1m,mode=0555,uid=10001,gid=10001 \
  --entrypoint /opt/workflow-mcp/bin/codex-isolated "$image" --version >/dev/null

# REGRESSION: a genuinely mounted mask must be accepted even when the caller rebuilt a minimal
# environment and dropped the attestation variable. The credential broker does exactly that so a
# login child cannot inherit credentials, and because installation always writes the project Codex
# stanza into <project>/.codex, dropping the flag made `auth status`/`auth login` refuse on 100% of
# default installations — surfacing to operators as an unreadable EPIPE. The mount, not the
# variable, is the security boundary; proving it here keeps that fix from silently regressing.
docker run --rm --network none --read-only --user 10001:10001 \
  --mount "type=bind,src=$temporary/catalog-workspace,dst=/workspace,readonly" \
  --tmpfs /workspace/.codex:ro,size=1m,mode=0555,uid=10001,gid=10001 \
  --entrypoint /opt/workflow-mcp/bin/codex-isolated "$image" --version >/dev/null

# The converse must still hold with the flag absent: an unmasked project `.codex` is refused, so
# trusting the mount never became "trust anything".
if docker run --rm --network none --read-only --user 10001:10001 \
  --mount "type=bind,src=$temporary/catalog-workspace,dst=/workspace,readonly" \
  --entrypoint /opt/workflow-mcp/bin/codex-isolated "$image" --version >/dev/null 2>&1; then
  echo 'unmasked project Codex configuration was accepted without the attestation flag' >&2
  exit 1
fi

# Authoring uses the same immutable policy but a real nested writable mount. Prove that exact
# allowlist can perform durable file primitives while sibling project paths, state, credentials,
# process metadata, admin/daemon endpoints, external network, and detached descendants stay denied.
docker run --rm --network "$network" --read-only=true --user=10001:10001 \
  --cap-drop=ALL --security-opt=no-new-privileges:true \
  --security-opt=seccomp=unconfined --security-opt=apparmor=unconfined \
  --pids-limit=256 --memory=2g --cpus=1 \
  --mount=type=volume,target=/data \
  --mount="type=bind,source=$temporary/workspace,target=/workspace,readonly" \
  --tmpfs=/workspace/.claude/workflows:size=4m,mode=0700,uid=10001,gid=10001 \
  --tmpfs=/tmp:size=256m,mode=1777,uid=10001,gid=10001 \
  --tmpfs=/run/workflow-mcp:size=16m,mode=0700,uid=10001,gid=10001 \
  --tmpfs=/run/secrets:size=1m,mode=0700,uid=10001,gid=10001 \
  -e WORKFLOW_MCP_ATTEMPT_PROFILE=authoring \
  -e WORKFLOW_MCP_OPENAI_API_KEY_FILE=/run/secrets/openai_api_key \
  -e WORKFLOW_MCP_POLICY_NETWORK_TARGET=workflow-mcp-smoke-listener-$suffix:4567 \
  --entrypoint=/bin/sh "$image" -c \
  'printf "%s\n" workflow-mcp-nonsecret-authoring-probe > /run/secrets/openai_api_key; exec /opt/workflow-mcp/bin/codex-isolated policy-probe-authoring' >/dev/null

user=$(docker image inspect "$image" --format '{{.Config.User}}')
[ "$user" = 10001:10001 ] || { echo "unexpected image user: $user" >&2; exit 1; }
# WHY: the managed requirements file is only useful if the actual non-root runtime can traverse
# its root-owned parent and read it. File metadata alone missed a builder-dependent parent-mode
# regression, while the later Codex sandbox error misleadingly named only the leaf file.
docker run --rm --network none --read-only --user 10001:10001 \
  --entrypoint /usr/local/bin/node "$image" \
  -e 'require("node:fs").accessSync("/etc/codex/requirements.toml",require("node:fs").constants.R_OK)'
healthcheck=$(docker image inspect "$image" --format '{{json .Config.Healthcheck}}')
[ "$healthcheck" = null ] || { echo "image embeds a transport-specific healthcheck: $healthcheck" >&2; exit 1; }
label=$(docker image inspect "$image" --format '{{index .Config.Labels "io.modelcontextprotocol.server.name"}}')
[ "$label" = io.github.Juliusolsson05/workflow-mcp ] || { echo "MCP ownership label drifted" >&2; exit 1; }
expected_version=$(docker image inspect "$image" --format '{{index .Config.Labels "org.opencontainers.image.version"}}')

# This is the MCP Registry runtimeArguments profile, including its anonymous `/data` volume. Keep
# the client and owner in one container until the deterministic run is terminal; removing the
# container then removes the anonymous volume, exactly matching the published lifecycle promise.
docker run --rm --network none --read-only=true --user=10001:10001 \
  --cap-drop=ALL --security-opt=no-new-privileges:true \
  --security-opt=seccomp=unconfined --security-opt=apparmor=unconfined \
  --pids-limit=256 --memory=2g --cpus=1 \
  --tmpfs=/tmp:size=256m,mode=1777,uid=10001,gid=10001 \
  --tmpfs=/run/workflow-mcp:size=16m,mode=0700,uid=10001,gid=10001 \
  --mount=type=volume,target=/data \
  --mount="type=bind,source=$temporary/workspace,target=/workspace,readonly" \
  -e "EXPECTED_VERSION=$expected_version" --entrypoint=/usr/local/bin/node \
  "$image" /opt/workflow-mcp/standalone/scripts/stdio-session-smoke.mjs

# Generic Registry/Catalog launches are session-bound STDIO processes. A closed client input must
# flush accepted responses and let the container exit; otherwise Docker Desktop accumulates stale
# provider/session owners even though the MCP client believes it disconnected.
cat > "$temporary/stdio-requests.jsonl" <<'EOF'
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"container-eof-smoke","version":"1"}}}
{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"workflow_run","arguments":{"name":"smoke","idempotencyKey":"container-stdio-terminal-smoke"}}}
EOF
(cat "$temporary/stdio-requests.jsonl"; sleep 1) | docker run --rm --network none --read-only --user 10001:10001 -i \
  --cap-drop=ALL --security-opt=no-new-privileges:true \
  --security-opt=seccomp=unconfined --security-opt=apparmor=unconfined \
  --pids-limit=256 --memory=2g --cpus=1 \
  --tmpfs /tmp:size=256m,mode=1777,uid=10001,gid=10001 \
  --tmpfs /run/workflow-mcp:size=16m,mode=0700,uid=10001,gid=10001 \
  --mount "type=volume,src=$stdio_volume,dst=/data" \
  --mount "type=bind,src=$temporary/workspace,dst=/workspace,readonly" \
  "$image" > "$temporary/stdio-responses.jsonl"
grep -q '"id":1' "$temporary/stdio-responses.jsonl"
grep -q '"workflow_list"' "$temporary/stdio-responses.jsonl"
stdio_run_id=$(docker run --rm --network none --read-only -i --entrypoint /usr/local/bin/node \
  "$image" -e '
  const fs=require("node:fs");
  for(const line of fs.readFileSync(0,"utf8").trim().split("\n")) {
    const message=JSON.parse(line);
    if(message.id===1&&message.result?.serverInfo?.version!==process.argv[1]) process.exit(8);
    if(message.id===3) process.stdout.write(message.result.structuredContent.run.runId);
  }
' "$expected_version" < "$temporary/stdio-responses.jsonl")
case "$stdio_run_id" in run_*) ;; *) echo 'generic STDIO run did not return an ID' >&2; exit 1 ;; esac
cat > "$temporary/stdio-status-requests.jsonl" <<EOF
{"jsonrpc":"2.0","id":4,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"container-reconnect-smoke","version":"1"}}}
{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}
{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"workflow_run_status","arguments":{"runId":"$stdio_run_id"}}}
EOF
docker run --rm --network none --read-only --user 10001:10001 -i \
  --cap-drop=ALL --security-opt=no-new-privileges:true \
  --security-opt=seccomp=unconfined --security-opt=apparmor=unconfined \
  --pids-limit=256 --memory=2g --cpus=1 \
  --tmpfs /tmp:size=256m,mode=1777,uid=10001,gid=10001 \
  --tmpfs /run/workflow-mcp:size=16m,mode=0700,uid=10001,gid=10001 \
  --mount "type=volume,src=$stdio_volume,dst=/data,volume-nocopy" \
  --mount "type=bind,src=$temporary/workspace,dst=/workspace,readonly" \
  "$image" < "$temporary/stdio-status-requests.jsonl" > "$temporary/stdio-status-responses.jsonl"
docker run --rm --network none --read-only -i --entrypoint /usr/local/bin/node "$image" -e '
  const fs=require("node:fs");
  const messages=fs.readFileSync(0,"utf8").trim().split("\n").map(JSON.parse);
  const status=messages.find(message=>message.id===5)?.result?.structuredContent?.run?.status;
  // WHY: the one-second input grace deliberately straddles the completion boundary. A fast host
  // may finish before EOF, while a cold or emulated host may still be executing when EOF asks the
  // session owner to quiesce. Both outcomes satisfy the public session-bound contract; accepting
  // queued/running would instead prove that the owner exited without durably settling its work.
  if(!["completed","interrupted"].includes(status)) throw new Error("generic STDIO run ended as "+status);
' < "$temporary/stdio-status-responses.jsonl"

# Secrets and maintenance archives cross the host/container boundary through Docker-managed
# volumes. This is the same ownership topology as the public launcher and proves a normal 0600
# host file never needs to become world-readable merely because the image has a fixed UID.
docker create --name "$staging_container" --network none --read-only --entrypoint /bin/true \
  --mount "type=volume,src=$secret_volume,dst=/secret-input" "$image" >/dev/null
docker cp "$temporary/output/openai_api_key" "$staging_container:/secret-input/openai_api_key"
docker run --rm --network none --read-only --user 0:0 --entrypoint /bin/chown \
  --mount "type=volume,src=$secret_volume,dst=/secret-input,volume-nocopy" \
  "$image" 10001:10001 /secret-input/openai_api_key
docker rm "$staging_container" >/dev/null

docker run -d --name "$container" --network "$network" --read-only --user 10001:10001 \
  --cap-drop=ALL --security-opt=no-new-privileges:true \
  --security-opt=seccomp=unconfined --security-opt=apparmor=unconfined \
  --pids-limit=256 --memory=2g --cpus=1 \
  --tmpfs /tmp:size=256m,mode=1777,uid=10001,gid=10001 \
  --tmpfs /run/workflow-mcp:size=16m,mode=0700,uid=10001,gid=10001 \
  -e "WORKFLOW_MCP_INSTANCE_ID=$instance_id" -e "WORKFLOW_MCP_PROJECT_HASH=$project_hash" \
  -e WORKFLOW_MCP_OPENAI_API_KEY_FILE=/run/secrets/openai_api_key \
  -e WORKFLOW_MCP_POLICY_NETWORK_TARGET=workflow-mcp-smoke-listener-$suffix:4567 \
  --mount "type=volume,src=$secret_volume,dst=/run/secrets,readonly,volume-nocopy" \
  -v "$volume:/data" -v "$temporary/workspace:/workspace:ro" \
  "$image" daemon --host=127.0.0.1 --lease=inherited-flock >/dev/null

attempt=0
until docker exec "$container" workflow-mcp healthcheck >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 30 ] || { docker logs "$container" >&2; exit 1; }
  sleep 1
done
docker exec "$container" workflow-mcp doctor --json | grep -q '"codex-policy","status":"pass"'
docker exec "$container" workflow-mcp auth status --json | grep -q '"mode":"api-key-secret"'
docker exec "$container" sh -c 'test "$(stat -c %a /run/workflow-mcp/admin.sock)" = 600'

# A second owner of the same volume must lose immediately at the kernel lock, not reach repair.
if docker run --rm --network none --read-only --user 10001:10001 \
  --cap-drop=ALL --security-opt=no-new-privileges:true \
  --security-opt=seccomp=unconfined --security-opt=apparmor=unconfined \
  --pids-limit=256 --memory=2g --cpus=1 \
  --tmpfs /tmp --tmpfs /run/workflow-mcp:mode=0700,uid=10001,gid=10001 \
  -v "$volume:/data" -v "$temporary/workspace:/workspace:ro" \
  -e "WORKFLOW_MCP_INSTANCE_ID=$instance_id" -e "WORKFLOW_MCP_PROJECT_HASH=$project_hash" \
  "$image" daemon --host=127.0.0.1 --lease=inherited-flock >/dev/null 2>&1; then
  echo "second durable owner unexpectedly started" >&2
  exit 1
fi

# Holding flock on an open file is insufficient if a privileged volume actor unlinks that pathname:
# Linux permits a second process to lock the newly created inode. Exercise that exact two-generation
# topology through the native entrypoint (not synthetic Node descriptors), prove the replacement
# owner really becomes ready, and prove the old generation's monitor withdraws readiness. This is
# the release-level wiring counterpart to the focused service lifecycle regression.
docker run --rm --network none --read-only --user 0:0 \
  --mount "type=volume,src=$volume,dst=/data,volume-nocopy" \
  --entrypoint /bin/sh "$image" -c '
    rm /data/.coordination/owner.lock
    umask 077
    : > /data/.coordination/owner.lock
    chown 10001:10001 /data/.coordination/owner.lock
  '
docker run -d --name "$replacement_container" --network "$network" --read-only --user 10001:10001 \
  --cap-drop=ALL --security-opt=no-new-privileges:true \
  --security-opt=seccomp=unconfined --security-opt=apparmor=unconfined \
  --pids-limit=256 --memory=2g --cpus=1 \
  --tmpfs /tmp:size=256m,mode=1777,uid=10001,gid=10001 \
  --tmpfs /run/workflow-mcp:size=16m,mode=0700,uid=10001,gid=10001 \
  -e "WORKFLOW_MCP_INSTANCE_ID=$instance_id" -e "WORKFLOW_MCP_PROJECT_HASH=$project_hash" \
  -e WORKFLOW_MCP_OPENAI_API_KEY_FILE=/run/secrets/openai_api_key \
  --mount "type=volume,src=$secret_volume,dst=/run/secrets,readonly,volume-nocopy" \
  -v "$volume:/data" -v "$temporary/workspace:/workspace:ro" \
  "$image" daemon --host=127.0.0.1 --lease=inherited-flock >/dev/null
attempt=0
until docker exec "$replacement_container" workflow-mcp healthcheck >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 30 ] || { docker logs "$replacement_container" >&2; exit 1; }
  sleep 1
done
attempt=0
while docker exec "$container" workflow-mcp healthcheck >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 30 ] || { echo "old owner stayed ready after lock pathname replacement" >&2; exit 1; }
  sleep 1
done

docker stop -t 120 "$container" >/dev/null
docker rm "$container" >/dev/null
docker stop -t 120 "$replacement_container" >/dev/null
docker rm "$replacement_container" >/dev/null
docker create --name "$export_container" --network none --read-only --user 10001:10001 \
  -e "WORKFLOW_MCP_INSTANCE_ID=$instance_id" -e "WORKFLOW_MCP_PROJECT_HASH=$project_hash" \
  --mount "type=volume,src=$volume,dst=/data,volume-nocopy" \
  --mount "type=volume,src=$export_volume,dst=/backup-output" \
  "$image" maintenance backup-create --output=/backup-output/smoke.backup >/dev/null
docker start --attach "$export_container" >/dev/null
docker cp "$export_container:/backup-output/smoke.backup" "$temporary/output/smoke.backup"
docker cp "$export_container:/backup-output/smoke.backup.sha256" "$temporary/output/smoke.backup.sha256"
docker rm "$export_container" >/dev/null
docker create --name "$staging_container" --network none --read-only --entrypoint /bin/true \
  --mount "type=volume,src=$input_volume,dst=/backup-input" "$image" >/dev/null
docker cp "$temporary/output/smoke.backup" "$staging_container:/backup-input/smoke.backup"
docker cp "$temporary/output/smoke.backup.sha256" "$staging_container:/backup-input/smoke.backup.sha256"
docker run --rm --network none --read-only --user 0:0 --entrypoint /bin/chown \
  --mount "type=volume,src=$input_volume,dst=/backup-input,volume-nocopy" \
  "$image" 10001:10001 /backup-input/smoke.backup /backup-input/smoke.backup.sha256
docker rm "$staging_container" >/dev/null
docker run --rm --network none --read-only \
  -e "WORKFLOW_MCP_INSTANCE_ID=$instance_id" -e "WORKFLOW_MCP_PROJECT_HASH=$project_hash" \
  --user 10001:10001 \
  --mount "type=volume,src=$input_volume,dst=/backup-input,readonly,volume-nocopy" \
  "$image" maintenance backup-verify --input=/backup-input/smoke.backup >/dev/null
# A brand-new named volume is owned by root until Docker performs image copy-up. Seed only the
# image's reviewed empty /data skeleton; restore still verifies that no payload/layout exists.
docker run --rm --network none --read-only -v "$restore_volume:/data" "$image" help >/dev/null
docker run --rm --network none --read-only --user 10001:10001 \
  -e "WORKFLOW_MCP_INSTANCE_ID=$instance_id" -e "WORKFLOW_MCP_PROJECT_HASH=$project_hash" \
  --mount "type=volume,src=$restore_volume,dst=/data,volume-nocopy" \
  --mount "type=volume,src=$input_volume,dst=/backup-input,readonly,volume-nocopy" \
  "$image" maintenance restore --input=/backup-input/smoke.backup >/dev/null

echo "Container ownership, policy, admin-socket, and offline-maintenance smoke passed."
