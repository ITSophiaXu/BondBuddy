#!/usr/bin/env bash
set -euo pipefail
umask 077

cd "$(dirname "$0")/../../.."
test -d node_modules || { echo 'npm ci required' >&2; exit 2; }
test -n "${BB_DRILL_EXPECTED_SHA:-}" || { echo 'BB_DRILL_EXPECTED_SHA required' >&2; exit 2; }
test "$(git rev-parse HEAD)" = "$BB_DRILL_EXPECTED_SHA" || { echo 'Checkout SHA mismatch' >&2; exit 2; }
git diff --quiet && git diff --cached --quiet || { echo 'Tracked checkout changes present' >&2; exit 2; }

# This is a read-only safety gate against injecting a drill while real work is active.
# Local disposable test runs set BB_DRILL_LOCAL_ONLY=1; pre-release must supply its DB URL.
if [ "${BB_DRILL_LOCAL_ONLY:-}" != 1 ]; then
  test -n "${BB_DRILL_GUARD_DATABASE_URL:-}" || { echo 'BB_DRILL_GUARD_DATABASE_URL required' >&2; exit 2; }
  node --input-type=module -e '
    import { Pool } from "pg";
    const pool = new Pool({ connectionString: process.env.BB_DRILL_GUARD_DATABASE_URL, max: 1, connectionTimeoutMillis: 5000 });
    try {
      const q = await pool.query("SELECT count(*)::int n FROM bb_jobs WHERE state IN ($1,$2) AND owner_user_id NOT LIKE $3", ["queued", "running", "synthetic79_%"]);
      process.stdout.write(`active_real_jobs=${q.rows[0].n}\n`);
      if (q.rows[0].n !== 0) process.exitCode = 3;
    } finally { await pool.end(); }
  '
fi

suffix="$(date +%s)-$$"
pg_name="bb79drill-pg-${suffix}"
az_name="bb79drill-az-${suffix}"
cleanup() {
  docker rm -f "$az_name" "$pg_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

docker run -d --name "$pg_name" -e POSTGRES_USER=bbdrill -e POSTGRES_DB=bbdrill \
  -e POSTGRES_HOST_AUTH_METHOD=trust -p 127.0.0.1::5432 --tmpfs /var/lib/postgresql/data postgres:16 >/dev/null
# Use the emulator's fixed local endpoint; if another service owns it, fail before migration.
docker run -d --name "$az_name" -p 127.0.0.1:10000:10000 --tmpfs /data \
  mcr.microsoft.com/azure-storage/azurite azurite-blob --blobHost 0.0.0.0 --skipApiVersionCheck >/dev/null

for _ in $(seq 1 30); do
  if docker exec "$pg_name" pg_isready -U bbdrill -d bbdrill >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$pg_name" pg_isready -U bbdrill -d bbdrill >/dev/null
port="$(docker port "$pg_name" 5432/tcp)"
port="${port##*:}"
db_url="postgresql://bbdrill@127.0.0.1:${port}/bbdrill"

timeout 180s npm run build -w @bondbuddy/contracts >/dev/null
timeout 180s npm run build -w @bondbuddy/domain >/dev/null
timeout 180s npm run build -w @bondbuddy/rule-pack-registry >/dev/null
timeout 180s npm run build -w @bondbuddy/rule-applicability-context >/dev/null
timeout 180s npm run build -w @bondbuddy/api >/dev/null
DATABASE_URL="$db_url" timeout 180s node db/migrate.mjs >/dev/null
BB_RECOVERY_DRILL_TEST_DATABASE_URL="$db_url" BB_TEST_AZURITE_CONNECTION_STRING=UseDevelopmentStorage=true \
  timeout 120s node --test --test-concurrency=2 apps/api/dist/zz_recovery_drill.test.js
