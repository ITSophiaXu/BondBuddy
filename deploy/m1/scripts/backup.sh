#!/usr/bin/env bash
# Usage: backup.sh [label]  ->  $BB_BACKUP_DIR/<utc>-<label>/{db.dump,blobs/,manifest.txt}
# pg_dump -Fc of the application database plus the configured application Blob containers.
# #35: then copies the directory off-host into the private `bb-backups` Blob container (sha256 verified
# by re-download) and deletes older local backups, keeping only this newest one. BB_BACKUP_OFFHOST=off
# keeps everything local (for example on a dev stack).
source "$(dirname "$0")/lib.sh"
export BB_IMAGE_TAG="${BB_IMAGE_TAG:-$(current_tag)}"
label="${1:-manual}"
[[ "$label" =~ ^[A-Za-z0-9._-]{1,64}$ ]] || { echo "invalid label $label" >&2; exit 2; }
root="${BB_BACKUP_DIR:-$BB_DIR/backups}"
id="$(date -u +%Y%m%dT%H%M%SZ)-$label"
dir="$root/$id"
mkdir -p "$dir/blobs"; chmod 700 "$dir"
compose exec -T postgres pg_dump -U bondbuddy -d bondbuddy -Fc > "$dir/db.dump"
compose run --rm --no-deps -T --user "$(id -u):$(id -g)" -v "$dir/blobs:/backup" api \
  node deploy/m1/scripts/blob-snapshot.mjs export /backup
{ echo "release=${BB_BACKUP_SOURCE_TAG:-$BB_IMAGE_TAG}"; echo "db_sha256=$(sha256sum "$dir/db.dump" | cut -d' ' -f1)"; } > "$dir/manifest.txt"

offhost="${BB_BACKUP_OFFHOST:-$(env_value BB_BACKUP_OFFHOST)}"
if [ "${offhost:-on}" = off ]; then
  echo "off-host copy disabled (BB_BACKUP_OFFHOST=off); keep $dir safe yourself" >&2
elif ! compose run --rm --no-deps -T api test -f deploy/m1/scripts/backup-offhost.mjs; then
  # Images built before #35 (e.g. the previous release during deploy.sh) cannot upload; keep it local.
  echo "WARNING: image $BB_IMAGE_TAG has no off-host uploader; $dir stays local only" >&2
else
  compose run --rm --no-deps -T --user "$(id -u):$(id -g)" -v "$dir:/backup:ro" api \
    node deploy/m1/scripts/backup-offhost.mjs upload /backup "$id" >&2
  echo "offhost=blob:$id" >> "$dir/manifest.txt"
  # Only verified off-host copies allow pruning; the newest local backup (this one) stays for fast restore.
  for old in "$root"/*/; do
    old="${old%/}"
    [ "$old" = "$dir" ] || [ ! -f "$old/db.dump" ] || rm -rf -- "$old"
  done
fi
echo "$dir"
