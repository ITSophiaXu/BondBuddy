#!/usr/bin/env bash
# Usage: rollback.sh <previous-sha>
# Re-points the stack at images of an earlier release WITHOUT running migrations. Migrations are
# append-only; check compatibility before release because rollback does not restore data.
source "$(dirname "$0")/lib.sh"
target="${1:?usage: rollback.sh <previous-sha>}"
sha="$(git -C "$BB_REPO" rev-parse --verify "$target^{commit}")"
node "$BB_REPO/scripts/prospectus-quality-gate.mjs" verify-rollback "$sha" "${BB_RELEASE_QUALITY_RECEIPT:?set BB_RELEASE_QUALITY_RECEIPT to the original passing receipt for this deployed commit}" "$BB_STATE/releases.log"
# Old images ignore the new filters and would run three shared queues. Their own Compose is required.
if ! git -C "$BB_REPO" show "$target:apps/worker/src/runtime.ts" | grep BB_WORKER_RUN_KINDS >/dev/null; then
  echo 'rollback across worker isolation requires the target checkout/Compose; do not run old images with the three-worker topology' >&2
  exit 3
fi
tag="$(git -C "$BB_REPO" rev-parse --verify "$target^{commit}" 2>/dev/null | cut -c1-12 || true)"
tag="${tag:-${target:0:12}}"
for image in api worker web egress; do
  docker image inspect "bondbuddy-m1-$image:$tag" >/dev/null 2>&1 || { echo "image bondbuddy-m1-$image:$tag missing; run deploy.sh $target" >&2; exit 3; }
  revision="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "bondbuddy-m1-$image:$tag")"
  [ "$revision" = "$sha" ] || { echo "rollback image source mismatch: $image" >&2; exit 3; }
done
from="$(current_tag)"
BB_IMAGE_TAG="$tag" compose up -d --remove-orphans --wait api worker worker-review worker-parse ops egress web
echo "$tag" > "$BB_STATE/current"
log_release rollback "$tag (from ${from:-none})"
"$(dirname "$0")/smoke.sh" "http://127.0.0.1:$(env_value BB_HTTP_PORT)"
echo "rolled back to $tag"
