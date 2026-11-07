#!/usr/bin/env bash
# Usage: BB_ENV_FILE=<private env> deploy-role.sh main|execution <git-sha>
# Uses prebuilt exact-SHA images; export-images-role.sh prepares each role independently.
export BB_DEPLOY_ROLE="${1:?usage: deploy-role.sh main|execution <git-sha>}"; shift
export BB_PENDING_COMMAND=1
source "$(dirname "$0")/role-lib.sh"
sha="$(git -C "$BB_REPO" rev-parse --verify "${1:?git-sha required}^{commit}")"; shift
rollback=0
case "${1:-}" in '') ;; --rollback) rollback=1; shift;; *) echo 'unexpected deployment argument' >&2; exit 2;; esac
[ "$#" = 0 ] || exit 2
role_compose_arguments
role_script_source
role_trusted_source "$sha"
# Legacy same-version mode stays valid. Decoupling requires an explicit exact script pin.
if [ -z "$BB_DEPLOY_SCRIPT_SHA" ]; then
  git -C "$BB_REPO" diff --quiet "$sha" -- deploy/m1 || { echo 'deployment files differ from the app commit; pin BB_DEPLOY_SCRIPT_SHA for independent configuration' >&2; exit 2; }
fi
export BB_IMAGE_TAG="${sha:0:12}"
exec 9>"$BB_STATE/deploy.lock"
flock -n 9 || { echo 'this role is already being deployed' >&2; exit 75; }
if [ "$(env_value BB_NON_PRODUCTION_TEST_CHANNEL)" = enabled ] && [ "$(env_value BB_DEPLOYMENT_TIER)" != preprod ]; then
  echo 'non-production test channel requires BB_DEPLOYMENT_TIER=preprod' >&2; exit 2
fi
compose config --quiet
role_existing_state
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
previous="$(current_tag)"
snapshots=''
if [ -f "$BB_STATE/pending-release.json" ]; then
  [ "$rollback" = 1 ] || { echo 'pending release retained; use --rollback to recover its verified versions' >&2; exit 3; }
  refs="$(node "$BB_DIR/scripts/role-release.mjs" refs "$BB_STATE" "$BB_DEPLOY_ROLE")"
  index=0
  while read -r ref; do
    role_trusted_source "$ref"
    if [ "$index" -gt 0 ]; then snapshots+="$(BB_IMAGE_TAG="${ref:0:12}" role_release_snapshot "$ref")"$'\n'; fi
    index=$((index + 1))
  done <<< "$refs"
  printf '%s' "$snapshots" | node "$BB_DIR/scripts/role-release.mjs" verify "$BB_STATE" "$BB_DEPLOY_ROLE" "$sha"
else
  role_existing_release
  if [ -n "$previous" ]; then
    from_sha="$(git -C "$BB_REPO" rev-parse --verify "$previous^{commit}")"
    [ "${from_sha:0:12}" = "$previous" ] || { echo 'current must identify its exact trusted source' >&2; exit 3; }
    role_trusted_source "$from_sha"
    snapshots+="$(BB_IMAGE_TAG="$previous" role_release_snapshot "$from_sha")"$'\n'
  fi
  snapshots+="$(role_release_snapshot "$sha")"$'\n'
  # Durable non-success state precedes even the one-off SQL probe container and every switch.
  printf '%s' "$snapshots" | node "$BB_DIR/scripts/role-release.mjs" prepare "$BB_STATE" "$BB_DEPLOY_ROLE" "$sha" '' "$BB_ENV" "$BB_SCRIPT_SHA"
fi
# No switch while the old role is active. The release procedure must first close new submissions
# and inspect provider processes as well: a DB gate cannot prove an unrecorded external call ended.
if [ -n "$(current_tag)" ]; then
  candidate="$BB_IMAGE_TAG"
  BB_IMAGE_TAG="$(current_tag)" role_probe idle
  export BB_IMAGE_TAG="$candidate"
fi
[ "$rollback" = 0 ] || [ -n "$previous" ] || { echo 'rollback requires an existing role release' >&2; exit 2; }
# Never stop a parser until the existing SQL/in-flight gate has passed.
if [ "$BB_PARSE_ROLE" != "$BB_DEPLOY_ROLE" ]; then
  role_compose_raw stop worker-parse
fi
if [ "$BB_DEPLOY_ROLE" = main ]; then
  if [ "$rollback" = 0 ]; then compose up -d --wait postgres egress; fi
  role_probe connect
  if [ "$rollback" = 0 ]; then compose run --rm --no-deps -T migrate; fi
  role_probe schema
  services=(api ops egress)
  [ "$BB_PARSE_ROLE" != main ] || services+=(worker-parse)
  compose up -d --no-deps --wait "${services[@]}"
  # nginx resolves api at startup; always replace web after recreating api.
  compose up -d --no-deps --force-recreate --wait web
  "$BB_DIR/scripts/smoke.sh" "http://127.0.0.1:$(env_value BB_HTTP_PORT)"
else
  bash "$BB_DIR/scripts/install-codex-file-sandbox.sh"
  infrastructure=(pg-tunnel egress)
  case "$BB_INTEGRITY_MODE" in beijing) infrastructure+=(integrity-beijing-tunnel);; direct) infrastructure+=(integrity-egress);; esac
  compose up -d --no-deps --wait "${infrastructure[@]}"
  role_probe schema
  services=(worker worker-review)
  [ "$BB_PARSE_ROLE" != execution ] || services+=(worker-parse)
  compose up -d --no-deps --wait "${services[@]}"
  services+=("${infrastructure[@]}")
fi
# Bind evidence to immutable image IDs and actual running containers, not mutable tags.
if [ "$BB_DEPLOY_ROLE" = main ]; then services+=(web); fi
if [ "$BB_PARSE_ROLE" != "$BB_DEPLOY_ROLE" ]; then
  [ -z "$(role_compose_raw ps --status running -q worker-parse)" ] || { echo 'inactive parser is still running' >&2; exit 4; }
fi
for service in "${services[@]}"; do
  case "$service" in ops|worker|worker-review|worker-parse) target=worker;; integrity-beijing-tunnel) target=integrity-tunnel;; *) target="$service";; esac
  containers="$(compose ps -q "$service")"
  [ -n "$containers" ] || { echo "missing runtime container: $service" >&2; exit 4; }
  while read -r container; do
    [ "$(docker inspect --format '{{.Image}}' "$container")" = "${image_ids[$target]}" ] || { echo "runtime image mismatch: $service" >&2; exit 4; }
  done <<< "$containers"
done
record="$(date -u +%Y%m%dT%H%M%S.%N)-$$"
{ echo "record=$record"; echo "commit=$sha"; echo "script_commit=$BB_SCRIPT_SHA"; echo "script_tree=$(git -C "$BB_REPO" rev-parse "$BB_SCRIPT_SHA^{tree}")";
  echo "override_sha256=${BB_ROLE_OVERRIDE_SHA256:-none}"; echo "parse_role=$BB_PARSE_ROLE";
  for target in "${targets[@]}"; do echo "$target=${image_ids[$target]}"; done; } > "$BB_STATE/images-$BB_IMAGE_TAG.txt"
cp "$BB_STATE/images-$BB_IMAGE_TAG.txt" "$BB_STATE/release-$record.txt"
# Readiness and file/payment/integrity acceptance are separate release steps in the runbook.
[ -z "$previous" ] || echo "$previous" > "$BB_STATE/previous"
[ ! -f "$BB_STATE/current-release" ] || cp "$BB_STATE/current-release" "$BB_STATE/previous-release"
echo "$record" > "$BB_STATE/current-release"
node "$BB_DIR/scripts/role-release.mjs" clear "$BB_STATE" "$BB_DEPLOY_ROLE" "$sha"
log_release "deploy-$BB_DEPLOY_ROLE" "record=$record app=$sha script=$BB_SCRIPT_SHA override=${BB_ROLE_OVERRIDE_SHA256:-none} rollback=$rollback (previous ${previous:-none})"
echo "deployed $BB_DEPLOY_ROLE $BB_IMAGE_TAG; complete the role acceptance checklist"
