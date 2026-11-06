#!/usr/bin/env bash
# Usage: BB_ENV_FILE=<private env> deploy-role.sh main|execution <git-sha>
# Uses prebuilt exact-SHA images; export-images-role.sh prepares each role independently.
export BB_DEPLOY_ROLE="${1:?usage: deploy-role.sh main|execution <git-sha>}"; shift
source "$(dirname "$0")/role-lib.sh"
sha="$(git -C "$BB_REPO" rev-parse --verify "${1:?git-sha required}^{commit}")"
git -C "$BB_REPO" diff --quiet "$sha" -- deploy/m1 || { echo 'deployment files must match the requested commit' >&2; exit 2; }
export BB_IMAGE_TAG="${sha:0:12}"
exec 9>"$BB_STATE/deploy.lock"
flock -n 9 || { echo 'this role is already being deployed' >&2; exit 75; }
if [ "$(env_value BB_NON_PRODUCTION_TEST_CHANNEL)" = enabled ] && [ "$(env_value BB_DEPLOYMENT_TIER)" != preprod ]; then
  echo 'non-production test channel requires BB_DEPLOYMENT_TIER=preprod' >&2; exit 2
fi
compose config --quiet
targets=(api worker web egress)
if [ "$BB_DEPLOY_ROLE" = execution ]; then
  targets=(worker egress pg-tunnel)
  case "$BB_INTEGRITY_MODE" in beijing) targets+=(integrity-tunnel);; direct) targets+=(integrity-egress);; esac
fi
declare -A image_ids
for target in "${targets[@]}"; do
  docker image inspect "$(role_image_ref "$target")" >/dev/null 2>&1 || { echo "missing release image: $target; prepare with export-images-role.sh" >&2; exit 3; }
  revision="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$(role_image_ref "$target")")"
  [ "$revision" = "$sha" ] || { echo "release image $target has no matching source revision; refusing tag-only reuse" >&2; exit 3; }
  image_ids[$target]="$(docker image inspect --format '{{.Id}}' "$(role_image_ref "$target")")"
done
# No switch while the old role is active. The release procedure must first close new submissions
# and inspect provider processes as well: a DB gate cannot prove an unrecorded external call ended.
if [ -n "$(current_tag)" ]; then
  candidate="$BB_IMAGE_TAG"
  BB_IMAGE_TAG="$(current_tag)" role_probe idle
  export BB_IMAGE_TAG="$candidate"
fi
previous="$(current_tag)"
if [ "$BB_DEPLOY_ROLE" = main ]; then
  compose up -d --wait postgres egress
  role_probe connect
  compose run --rm --no-deps -T migrate
  role_probe schema
  compose up -d --no-deps --wait api ops
  # nginx resolves api at startup; always replace web after recreating api.
  compose up -d --no-deps --force-recreate --wait web
  "$BB_DIR/scripts/smoke.sh" "http://127.0.0.1:$(env_value BB_HTTP_PORT)"
else
  bash "$BB_DIR/scripts/install-codex-file-sandbox.sh"
  compose up -d --wait pg-tunnel egress
  role_probe schema
  services=(worker worker-review worker-parse)
  case "$BB_INTEGRITY_MODE" in
    beijing) services=(integrity-beijing-tunnel "${services[@]}");;
    direct) services=(integrity-egress "${services[@]}");;
  esac
  compose up -d --wait "${services[@]}"
fi
# Bind evidence to immutable image IDs and actual running containers, not mutable tags.
if [ "$BB_DEPLOY_ROLE" = main ]; then services=(api ops egress web); else services+=(egress pg-tunnel); fi
for service in "${services[@]}"; do
  case "$service" in ops|worker|worker-review|worker-parse) target=worker;; integrity-beijing-tunnel) target=integrity-tunnel;; *) target="$service";; esac
  containers="$(compose ps -q "$service")"
  [ -n "$containers" ] || { echo "missing runtime container: $service" >&2; exit 4; }
  while read -r container; do
    [ "$(docker inspect --format '{{.Image}}' "$container")" = "${image_ids[$target]}" ] || { echo "runtime image mismatch: $service" >&2; exit 4; }
  done <<< "$containers"
done
{ echo "commit=$sha"; for target in "${targets[@]}"; do echo "$target=${image_ids[$target]}"; done; } > "$BB_STATE/images-$BB_IMAGE_TAG.txt"
# Readiness and file/payment/integrity acceptance are separate release steps in the runbook.
echo "$BB_IMAGE_TAG" > "$BB_STATE/current"
[ -z "$previous" ] || echo "$previous" > "$BB_STATE/previous"
log_release "deploy-$BB_DEPLOY_ROLE" "$BB_IMAGE_TAG (previous ${previous:-none})"
echo "deployed $BB_DEPLOY_ROLE $BB_IMAGE_TAG; complete the role acceptance checklist"
