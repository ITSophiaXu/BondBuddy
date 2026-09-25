#!/usr/bin/env bash
# Usage: backup.sh [label]  ->  $BB_BACKUP_DIR/<utc>-<label>/{db.dump,blobs/,manifest.txt}
# pg_dump -Fc of the application database plus a full export of the private blob container.
source "$(dirname "$0")/lib.sh"
export BB_IMAGE_TAG="${BB_IMAGE_TAG:-$(current_tag)}"
dir="${BB_BACKUP_DIR:-$BB_DIR/backups}/$(date -u +%Y%m%dT%H%M%SZ)-${1:-manual}"
mkdir -p "$dir/blobs"; chmod 700 "$dir"
compose exec -T postgres pg_dump -U bondbuddy -d bondbuddy -Fc > "$dir/db.dump"
compose run --rm --no-deps -T --user "$(id -u):$(id -g)" -v "$dir/blobs:/backup" api \
  node deploy/m1/scripts/blob-snapshot.mjs export /backup
{ echo "release=$BB_IMAGE_TAG"; echo "db_sha256=$(sha256sum "$dir/db.dump" | cut -d' ' -f1)"; } > "$dir/manifest.txt"
echo "$dir"
