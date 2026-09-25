#!/usr/bin/env bash
# Usage: restore.sh <backup-dir>
# Stops api/worker, replaces the database from db.dump and re-imports every blob (sha256-checked),
# then starts the stack again. Destructive for current data: take a backup first.
source "$(dirname "$0")/lib.sh"
dir="$(cd "${1:?usage: restore.sh <backup-dir>}" && pwd)"
[ -f "$dir/db.dump" ] || { echo "no db.dump in $dir" >&2; exit 2; }
export BB_IMAGE_TAG="${BB_IMAGE_TAG:-$(current_tag)}"
compose stop web worker api
compose exec -T postgres psql -U bondbuddy -d postgres -v ON_ERROR_STOP=1 \
  -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='bondbuddy' AND pid<>pg_backend_pid()" \
  -c 'DROP DATABASE IF EXISTS bondbuddy' -c 'CREATE DATABASE bondbuddy OWNER bondbuddy' >/dev/null
compose exec -T postgres pg_restore -U bondbuddy -d bondbuddy --no-owner --exit-on-error < "$dir/db.dump"
compose run --rm --no-deps -T --user "$(id -u):$(id -g)" -v "$dir/blobs:/backup:ro" api \
  node deploy/m1/scripts/blob-snapshot.mjs import /backup
compose up -d --wait api worker web
log_release restore "$dir"
echo "restored from $dir"
