#!/usr/bin/env bash
# Usage: rollback.sh <previous-sha>
# Re-points the stack at images of an earlier release WITHOUT running migrations. Migrations are
# append-only; if the newer release's schema is incompatible with the old code, restore the
# pre-deploy backup instead (see docs/runbooks/m1-deploy.md).
source "$(dirname "$0")/lib.sh"
target="${1:?usage: rollback.sh <previous-sha>}"
tag="$(git -C "$BB_REPO" rev-parse --verify "$target^{commit}" 2>/dev/null | cut -c1-12 || true)"
tag="${tag:-${target:0:12}}"
for image in api worker web egress; do
  docker image inspect "bondbuddy-m1-$image:$tag" >/dev/null 2>&1 || { echo "image bondbuddy-m1-$image:$tag missing; run deploy.sh $target" >&2; exit 3; }
done
from="$(current_tag)"
BB_IMAGE_TAG="$tag" compose up -d --remove-orphans --wait api worker egress web
echo "$tag" > "$BB_STATE/current"
log_release rollback "$tag (from ${from:-none})"
"$(dirname "$0")/smoke.sh" "http://127.0.0.1:$(env_value BB_HTTP_PORT)"
echo "rolled back to $tag"
