#!/usr/bin/env bash
# Restore into an isolated database/storage account; never restart execution automatically.
# BB_RESTORE_SAFETY_RECEIPT is a source-verified, off-host call/fence/billing manifest.
set -euo pipefail
validate_only=0
if [[ "${1:-}" == --validate-only ]]; then validate_only=1; shift; fi
src="${1:?usage: restore.sh [--validate-only] <backup-dir> | blob:<backup-id>}"
receipt="${BB_RESTORE_SAFETY_RECEIPT:?BB_RESTORE_SAFETY_RECEIPT is required}"
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
if [[ "$validate_only" == 0 || "$src" == blob:* ]]; then
  source "$(dirname "$0")/lib.sh"  # Keeps the existing prohibition on split-deployment legacy restore.
  export BB_IMAGE_TAG="${BB_IMAGE_TAG:-$(current_tag)}"
fi
if [[ "$src" == blob:* ]]; then
  id="${src#blob:}"
  [[ "$id" =~ ^[0-9]{8}T[0-9]{6}Z-[A-Za-z0-9._-]{1,64}$ ]] || { echo "invalid backup id $id" >&2; exit 2; }
  root="${BB_BACKUP_DIR:-$BB_DIR/backups}"; mkdir -p "$root"
  dir="$(mktemp -d "$root/restore-$id.XXXXXX")"
  compose run --rm --no-deps -T --user "$(id -u):$(id -g)" -v "$dir:/backup" api \
    node deploy/m1/scripts/backup-offhost.mjs download "$id" /backup
else
  dir="$(cd "$src" && pwd)"
fi
[ -f "$dir/db.dump" ] || { echo "no db.dump in $dir" >&2; exit 2; }
want="$(sed -n 's/\r$//;s/^db_sha256=//p' "$dir/manifest.txt" 2>/dev/null || true)"
[[ "$want" =~ ^[a-f0-9]{64}$ ]] || { echo 'backup manifest requires db_sha256' >&2; exit 3; }
[ "$(sha256sum "$dir/db.dump" | cut -d' ' -f1)" = "$want" ] || { echo "db.dump sha256 mismatch in $dir" >&2; exit 3; }
"${BB_RESTORE_NODE:-node}" "$repo_dir/db/verify-restore.mjs" --restore-safety-dry "$receipt" "$want"
if [[ "$validate_only" == 1 ]]; then exit 0; fi
target="${BB_RESTORE_DATABASE_NAME:?An isolated BB_RESTORE_DATABASE_NAME is required}"
export BB_RESTORE_DATABASE_NAME="$target"
[[ "$target" =~ ^[a-z][a-z0-9_]{0,62}$ && "$target" != bondbuddy ]] || { echo 'restore target must be a separate database' >&2; exit 3; }
: "${RESTORE_DATABASE_URL:?RESTORE_DATABASE_URL for the isolated database is required}"
: "${BB_RESTORE_STORAGE_CONNECTION_STRING:?An isolated storage connection is required}"
compose run --rm --no-deps -T -e BB_RESTORE_STORAGE_CONNECTION_STRING api \
  node deploy/m1/scripts/restore-control.mjs validate-storage
receipt_hash="$(sha256sum "$receipt" | cut -d' ' -f1)"
compose run --rm --no-deps -T -v "$receipt:/restore-receipt.json:ro" api \
  node db/verify-restore.mjs --restore-freeze /restore-receipt.json "$want"
compose stop web worker worker-review worker-parse ops api
compose run --rm --no-deps -T -v "$receipt:/restore-receipt.json:ro" api \
  node db/verify-restore.mjs --restore-safety-preflight /restore-receipt.json "$want"
[ "$(sha256sum "$receipt" | cut -d' ' -f1)" = "$receipt_hash" ] || { echo 'restore receipt changed after verification' >&2; exit 3; }
compose exec -T postgres psql -U bondbuddy -d postgres -v ON_ERROR_STOP=1 \
  -c "CREATE DATABASE $target OWNER bondbuddy" >/dev/null
compose exec -T postgres pg_restore -U bondbuddy -d "$target" --no-owner --exit-on-error < "$dir/db.dump"
# Bring the isolated snapshot to the fixed schema before any restored job can obtain admission.
DATABASE_URL="$RESTORE_DATABASE_URL" compose run --rm --no-deps -T -e DATABASE_URL api node db/migrate.mjs
compose run --rm --no-deps -T -e RESTORE_DATABASE_URL -e BB_RESTORE_DATABASE_NAME -v "$receipt:/restore-receipt.json:ro" api \
  node db/verify-restore.mjs --restore-safety-apply /restore-receipt.json "$want"
AZURE_STORAGE_CONNECTION_STRING="$BB_RESTORE_STORAGE_CONNECTION_STRING" compose run --rm --no-deps -T --user "$(id -u):$(id -g)" \
  -v "$dir/blobs:/backup:ro" -e AZURE_STORAGE_CONNECTION_STRING api node deploy/m1/scripts/blob-snapshot.mjs import /backup
log_release restore "$src"
echo "isolated restore complete: $target; API, workers and ops remain stopped; reconcile and use the role deployment runbook for cutover"
