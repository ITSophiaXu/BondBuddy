#!/usr/bin/env bash
# Usage: restore.sh <backup-dir> | restore.sh blob:<backup-id>
# Stops api/worker, replaces the database from db.dump and re-imports every blob (sha256-checked),
# then starts the stack again. Destructive for current data: take a backup first.
# #35: blob:<backup-id> first downloads the off-host copy from the private bb-backups container and
# verifies every file's sha256 (and db.dump against manifest.txt) before anything is stopped.
source "$(dirname "$0")/lib.sh"
src="${1:?usage: restore.sh <backup-dir> | blob:<backup-id>}"
export BB_IMAGE_TAG="${BB_IMAGE_TAG:-$(current_tag)}"
if [[ "$src" == blob:* ]]; then
  id="${src#blob:}"
  [[ "$id" =~ ^[0-9]{8}T[0-9]{6}Z-[A-Za-z0-9._-]{1,64}$ ]] || { echo "invalid backup id $id" >&2; exit 2; }
  root="${BB_BACKUP_DIR:-$BB_DIR/backups}"; mkdir -p "$root"
  dir="$root/restore-$id"
  rm -rf -- "$dir"; mkdir -m 700 "$dir"
  compose run --rm --no-deps -T --user "$(id -u):$(id -g)" -v "$dir:/backup" api \
    node deploy/m1/scripts/backup-offhost.mjs download "$id" /backup
else
  dir="$(cd "$src" && pwd)"
fi
[ -f "$dir/db.dump" ] || { echo "no db.dump in $dir" >&2; exit 2; }
want="$(sed -n 's/^db_sha256=//p' "$dir/manifest.txt" 2>/dev/null || true)"
[ -z "$want" ] || [ "$(sha256sum "$dir/db.dump" | cut -d' ' -f1)" = "$want" ] || { echo "db.dump sha256 mismatch in $dir" >&2; exit 3; }
compose stop web worker api
compose exec -T postgres psql -U bondbuddy -d postgres -v ON_ERROR_STOP=1 \
  -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='bondbuddy' AND pid<>pg_backend_pid()" \
  -c 'DROP DATABASE IF EXISTS bondbuddy' -c 'CREATE DATABASE bondbuddy OWNER bondbuddy' >/dev/null
compose exec -T postgres pg_restore -U bondbuddy -d bondbuddy --no-owner --exit-on-error < "$dir/db.dump"
compose run --rm --no-deps -T --user "$(id -u):$(id -g)" -v "$dir/blobs:/backup:ro" api \
  node deploy/m1/scripts/blob-snapshot.mjs import /backup
compose up -d --wait api worker web
log_release restore "$src"
echo "restored from $src"
