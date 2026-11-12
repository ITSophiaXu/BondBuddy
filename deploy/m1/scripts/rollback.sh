#!/usr/bin/env bash
# Usage: rollback.sh <previous-sha>
# Re-points the stack at images of an earlier release WITHOUT running migrations. Migrations are
# append-only; check compatibility before release because rollback does not restore data.
source "$(dirname "$0")/lib.sh"
BB_RELEASE_CONFIRMATION_SELECTION=disabled
target="${1:?usage: rollback.sh <previous-sha>}"
sha="$(git -C "$BB_REPO" rev-parse --verify "$target^{commit}")"
source "$(dirname "$0")/release-evidence.sh"
trap cleanup_release_evidence EXIT
exec 9>"$BB_STATE/deploy.lock"
flock -n 9 || { echo 'this environment is already being deployed or rolled back' >&2; exit 75; }
verify_release_evidence "$BB_REPO" "$sha" verify-rollback "$BB_STATE/releases.log"
verify_release_images "$BB_REPO" "$sha" all verify-rollback "$BB_STATE/releases.log"
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
for service in api worker worker-review worker-parse ops web; do
  case "$service" in worker*|ops) image=worker;; *) image="$service";; esac
  tested_id="$(docker image inspect --format '{{.Id}}' "bondbuddy-m1-$image:$tag")"
  containers="$(BB_IMAGE_TAG="$tag" compose ps -q "$service")"
  [ -n "$containers" ] || { echo "missing rollback runtime container: $service" >&2; exit 4; }
  while read -r container; do
    [ "$(docker inspect --format '{{.Image}}' "$container")" = "$tested_id" ] || { echo "rollback runtime image mismatch: $service" >&2; exit 4; }
  done <<< "$containers"
done
verify_release_images "$BB_REPO" "$sha" all verify-rollback "$BB_STATE/releases.log"
echo "$tag" > "$BB_STATE/current"
"$(dirname "$0")/smoke.sh" "http://127.0.0.1:$(env_value BB_HTTP_PORT)"
log_release rollback "$tag commit=$sha quality_sha256=$BB_RELEASE_QUALITY_DIGEST smoke_sha256=$BB_RELEASE_SMOKE_DIGEST (from ${from:-none})"
echo "rolled back to $tag"
