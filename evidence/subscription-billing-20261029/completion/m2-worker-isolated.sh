#!/usr/bin/env bash
# Synthetic-only M2 worker verification. Requires an explicitly verified immutable API image ID.
# No .env is loaded, no host port is published, and only this run's labelled IDs are removed.
set -euo pipefail

API_IMAGE=${1:?Pass the successful 279f13a API image sha256 ID}
[[ "$API_IMAGE" =~ ^sha256:[0-9a-f]{64}$ ]] || { printf '%s\n' 'Refusing a mutable image tag'; exit 2; }
SOURCE_SHA=279f13a0f086ca1048b38058fcc94703763f8b5a
FIXTURE_DIR=/mnt/c/Users/lezhai/Downloads/Bondbuddy/subscription-auto-billing-20261029/apps/worker/test-fixtures/codex
RUN_ID="bb-m2-ci-$(date -u +%Y%m%d%H%M%S)-$$"
LABEL=com.bondbuddy.synthetic.run
NETWORK_ID=
OWN_IDS=()
PG_ID=
BLOB_ID=
LAST_ID=

cleanup() {
  local status=$? clean=0 id actual index
  trap - EXIT INT TERM
  for ((index=${#OWN_IDS[@]}-1;index>=0;index--)); do
    id=${OWN_IDS[$index]}
    actual=$(docker inspect --format "{{index .Config.Labels \"$LABEL\"}}" "$id" 2>/dev/null || true)
    if [[ "$actual" != "$RUN_ID" ]]; then
      printf 'CLEANUP_BLOCKED container=%s reason=label-mismatch-or-unreadable\n' "$id"
      clean=1
      continue
    fi
    if docker rm -f "$id" >/dev/null; then printf 'CLEANED container=%s\n' "$id"; else clean=1; printf 'CLEANUP_FAILED container=%s\n' "$id"; fi
  done
  if [[ -n "$NETWORK_ID" ]]; then
    actual=$(docker network inspect --format "{{index .Labels \"$LABEL\"}}" "$NETWORK_ID" 2>/dev/null || true)
    if [[ "$actual" == "$RUN_ID" ]] && docker network rm "$NETWORK_ID" >/dev/null; then
      printf 'CLEANED network=%s\n' "$NETWORK_ID"
    else
      clean=1
      printf 'CLEANUP_FAILED network=%s\n' "$NETWORK_ID"
    fi
  fi
  if [[ "$clean" != 0 && "$status" == 0 ]]; then status=1; fi
  printf 'FINAL_EXIT=%s cleanup_failed=%s\n' "$status" "$clean"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

create_owned() {
  local role=$1
  shift
  LAST_ID=$(docker create --pull never --name "$RUN_ID-$role" --label "$LABEL=$RUN_ID" "$@")
  [[ "$LAST_ID" =~ ^[0-9a-f]{64}$ ]] || { printf 'Invalid created container ID\n'; exit 2; }
  OWN_IDS+=("$LAST_ID")
  printf 'CREATED role=%s container=%s\n' "$role" "$LAST_ID"
}
run_attached() {
  local id=$1 role=$2 attached=0 code
  timeout 240s docker start -a "$id" || attached=$?
  code=$(docker inspect --format '{{.State.ExitCode}}' "$id")
  printf 'CONTAINER_RESULT role=%s attach_exit=%s container_exit=%s\n' "$role" "$attached" "$code"
  [[ "$attached" == 0 && "$code" == 0 ]] || return 1
}

printf 'SOURCE_SHA=%s\nAPI_IMAGE=%s\nRUN_ID=%s\n' "$SOURCE_SHA" "$API_IMAGE" "$RUN_ID"
docker image inspect --format 'API metadata: id={{.Id}} workdir={{.Config.WorkingDir}} user={{.Config.User}}' "$API_IMAGE"
PG_IMAGE=$(docker image inspect --format '{{.Id}}' postgres:16.10)
BLOB_IMAGE=$(docker image inspect --format '{{.Id}}' mcr.microsoft.com/azure-storage/azurite:3.35.0)
printf 'POSTGRES_IMAGE=%s\nAZURITE_IMAGE=%s\n' "$PG_IMAGE" "$BLOB_IMAGE"
printf '%s  %s\n' 'ad3aaaca0c42fccf930d48b6251a2eecde98fe45ba77edf5fc8796a736882d46' "$FIXTURE_DIR/fake-codex.mjs" | sha256sum --check --status
printf '%s  %s\n' '2ff37668cec39f6229dc958ca2fd7a248d710ddc01a5c0c8f9d9afb8977a91a0' "$FIXTURE_DIR/missing_usage.jsonl" | sha256sum --check --status
printf 'Synthetic CLI and scenario hashes verified against the prepared 279f13a fixture snapshot.\n'

create_owned node-version --network none --read-only --cap-drop ALL --security-opt no-new-privileges --entrypoint node "$API_IMAGE" --version
run_attached "$LAST_ID" node-version

NETWORK_ID=$(docker network create --internal --label "$LABEL=$RUN_ID" "$RUN_ID-net")
[[ $(docker network inspect --format '{{.Internal}}' "$NETWORK_ID") == true ]]
printf 'CREATED internal_network=%s\n' "$NETWORK_ID"
create_owned postgres --network "$NETWORK_ID" --network-alias pg --tmpfs /var/lib/postgresql/data:rw,nosuid,nodev,size=768m \
  -e POSTGRES_USER=bondbuddy -e POSTGRES_PASSWORD=synthetic-m2-only -e POSTGRES_DB=bb_m2_ci "$PG_IMAGE"
PG_ID=$LAST_ID
docker start "$PG_ID" >/dev/null
STORAGE_KEY=$(printf '%s' 'bb-m2-ci-synthetic-storage-key-20261029' | base64 -w0)
create_owned azurite --network "$NETWORK_ID" --network-alias blob --tmpfs /data:rw,nosuid,nodev,size=256m \
  -e "AZURITE_ACCOUNTS=bbsynthetic:$STORAGE_KEY" "$BLOB_IMAGE" azurite-blob --blobHost 0.0.0.0 --blobPort 10000 --location /data --silent --skipApiVersionCheck
BLOB_ID=$LAST_ID
docker start "$BLOB_ID" >/dev/null
for attempt in $(seq 1 40); do
  if docker exec "$PG_ID" pg_isready -h 127.0.0.1 -U bondbuddy -d bb_m2_ci >/dev/null 2>&1; then break; fi
  [[ "$attempt" != 40 ]] || { docker logs --tail 60 "$PG_ID"; exit 1; }
  sleep 1
done
for attempt in $(seq 1 40); do
  if docker exec "$BLOB_ID" node -e "const n=require('net').connect(10000,'127.0.0.1',()=>{n.end();process.exit(0)});n.on('error',()=>process.exit(1));n.setTimeout(1000,()=>process.exit(1));" >/dev/null 2>&1; then break; fi
  [[ "$attempt" != 40 ]] || { docker logs --tail 60 "$BLOB_ID"; exit 1; }
  sleep 1
done
DATABASE_URL=postgresql://bondbuddy:synthetic-m2-only@pg:5432/bb_m2_ci
BLOB_CONNECTION="DefaultEndpointsProtocol=http;AccountName=bbsynthetic;AccountKey=$STORAGE_KEY;BlobEndpoint=http://blob:10000/bbsynthetic;"

create_owned migrate --network "$NETWORK_ID" --read-only --tmpfs /tmp:rw,mode=1777,size=128m --cap-drop ALL --security-opt no-new-privileges \
  -e "DATABASE_URL=$DATABASE_URL" --entrypoint node "$API_IMAGE" db/migrate.mjs
run_attached "$LAST_ID" migrate
docker exec "$PG_ID" psql -U bondbuddy -d bb_m2_ci -Atc "SELECT count(*),max(filename) FROM bb_schema_migrations;"
[[ $(docker exec "$PG_ID" psql -U bondbuddy -d bb_m2_ci -Atc "SELECT count(*) FROM bb_schema_migrations WHERE filename='0155_file_check_batch_reuse.sql';") == 1 ]]

create_owned worker-tests --network "$NETWORK_ID" --read-only --tmpfs /tmp:rw,mode=1777,size=256m --cap-drop ALL --security-opt no-new-privileges --no-healthcheck \
  --mount "type=bind,src=$FIXTURE_DIR,dst=/app/apps/worker/test-fixtures/codex,readonly" \
  -e NODE_ENV=test -e "BB_TEST_DATABASE_URL=$DATABASE_URL" -e "BB_TEST_AZURITE_CONNECTION_STRING=$BLOB_CONNECTION" \
  -e BB_SYNTHETIC_DEEPSEEK_KEY=synthetic-only-no-real-provider -e BB_WECHAT_PAY_ENABLED=0 -e BB_ALIPAY_PAY_ENABLED=0 \
  --entrypoint node "$API_IMAGE" --test --test-reporter=tap --test-concurrency=1 \
  apps/worker/dist/m2-paid-worker.test.js apps/worker/dist/authoring-action-progress.test.js apps/worker/dist/authoring-pause.pg.test.js apps/worker/dist/provider-reconciliation.test.js
TEST_ID=$LAST_ID
docker inspect --format 'Worker isolation: ports={{json .HostConfig.PortBindings}} read_only={{.HostConfig.ReadonlyRootfs}} mounts={{json .Mounts}}' "$TEST_ID"
run_attached "$TEST_ID" worker-tests
docker logs "$TEST_ID" 2>&1 | grep -Eq '^# pass 4$'
docker logs "$TEST_ID" 2>&1 | grep -Eq '^# fail 0$'
docker logs "$TEST_ID" 2>&1 | grep -Eq '^# skipped 0$'

# Actual API production entry point; /health only proves process/route boot.
# It is not a dependency, payment, model, or full deployment acceptance check.
create_owned api-health --network "$NETWORK_ID" --read-only --tmpfs /tmp:rw,mode=1777,size=128m --cap-drop ALL --security-opt no-new-privileges --no-healthcheck \
  -e "DATABASE_URL=$DATABASE_URL" -e "AZURE_STORAGE_CONNECTION_STRING=$BLOB_CONNECTION" \
  -e BB_ALLOWED_ORIGIN=http://synthetic-bondbuddy.invalid -e BB_UPLOAD_SPOOL_DIR=/tmp/bb-health-spool \
  -e BB_WECHAT_PAY_ENABLED=0 -e BB_ALIPAY_PAY_ENABLED=0 -e BB_PLATFORM_PROBE_ENABLED=0 -e BB_RUN_RUNTIME_ENABLED=0 \
  "$API_IMAGE"
HEALTH_ID=$LAST_ID
docker start "$HEALTH_ID" >/dev/null
for attempt in $(seq 1 30); do
  if docker exec "$HEALTH_ID" node -e "fetch('http://127.0.0.1:3000/health').then(async r=>{const b=await r.json();if(!r.ok||b.status!=='ok')process.exit(1);console.log(JSON.stringify({http_status:r.status,health:b,scope:'API process and route boot only'}));}).catch(()=>process.exit(1));"; then break; fi
  [[ "$attempt" != 30 ]] || { docker logs --tail 60 "$HEALTH_ID"; exit 1; }
  sleep 1
done
docker inspect --format 'API boot isolation: ports={{json .HostConfig.PortBindings}} read_only={{.HostConfig.ReadonlyRootfs}}' "$HEALTH_ID"
printf 'M2_WORKER_LOCAL_RESULT=4_pass_0_fail_0_skip\nAPI_HEALTH_SCOPE=process_and_route_boot_only\n'
