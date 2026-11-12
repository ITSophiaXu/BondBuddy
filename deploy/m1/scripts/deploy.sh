#!/usr/bin/env bash
# Usage: deploy.sh <git-sha>
# Reuses the exact tested app images; builds only auxiliary egress from git archive,
# runs migrations, starts the stack and smokes it. Releases do not create backups.
source "$(dirname "$0")/lib.sh"
BB_RELEASE_CONFIRMATION_SELECTION=disabled
BB_RELEASE_CONFIRMATION_ROLE=disabled
if [ "$(env_value BB_NON_PRODUCTION_TEST_CHANNEL)" = enabled ] && [ "$(env_value BB_DEPLOYMENT_TIER)" != preprod ]; then
  echo 'non-production test channel requires BB_DEPLOYMENT_TIER=preprod' >&2
  exit 2
fi
sha="$(git -C "$BB_REPO" rev-parse --verify "${1:?usage: deploy.sh <git-sha>}^{commit}")"
source "$(dirname "$0")/release-evidence.sh"
ctx=''; trap 'cleanup_release_evidence; [ -z "$ctx" ] || rm -rf "$ctx"' EXIT
verify_release_evidence "$BB_REPO" "$sha"
exec 9>"$BB_STATE/deploy.lock"
flock -n 9 || { echo 'this environment is already being deployed or rolled back' >&2; exit 75; }
verify_rollback_readiness "$BB_REPO" "$sha" "$BB_STATE"
verify_release_images "$BB_REPO" "$sha" all reuse
tag="${sha:0:12}"
build_required_bytes=$(( 4 * 1024 * 1024 * 1024 ))
# Images already present (e.g. loaded with `docker load` from scripts/export-images.sh on a build
# host, to spare a small target disk the ~2 GB build cache) are reused, not rebuilt.
have() { docker image inspect "$1" >/dev/null 2>&1; }
space_error() { echo "deploy space preflight: $*" >&2; exit 1; }
image_count=0
for target in api worker web egress; do
  if have "bondbuddy-m1-$target:$tag"; then
    image_count=$((image_count + 1))
  fi
done
if [ "$image_count" -eq 4 ]; then
  required_bytes=$(( 5 * 1024 * 1024 * 1024 / 2 ))
  threshold_reason="all four release images preloaded (2.5 GiB minimum)"
else
  required_bytes="$build_required_bytes"
  threshold_reason="local Docker build required ($image_count/4 release images preloaded; 4 GiB minimum)"
fi
# Docker may use a separate filesystem from the checkout. Recheck immediately before each build,
# since a release image can disappear after the initial four-image inspection.
check_space() {
  local required_bytes="$1" threshold_reason="$2" docker_endpoint docker_root df_output available_bytes LC_COLLATE=C
  if [ -n "${DOCKER_HOST:-}" ] && [ -z "${DOCKER_CONTEXT:-}" ]; then
    docker_endpoint="$DOCKER_HOST"
  else
    docker_endpoint="$(docker context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null)" || space_error "cannot determine Docker endpoint; available bytes unknown, required ${required_bytes} bytes: $threshold_reason"
  fi
  [[ "$docker_endpoint" = unix:///* ]] || space_error "Docker endpoint is not a local Unix socket; available bytes unknown, required ${required_bytes} bytes: $threshold_reason"
  docker_root="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null)" || space_error "cannot determine Docker data-root; available bytes unknown, required ${required_bytes} bytes: $threshold_reason"
  [[ "$docker_root" = /* && "$docker_root" != *$'\n'* ]] || space_error "cannot determine Docker data-root; available bytes unknown, required ${required_bytes} bytes: $threshold_reason"
  docker_root="$(readlink -e -- "$docker_root" 2>/dev/null)" || space_error "cannot resolve Docker data-root; available bytes unknown, required ${required_bytes} bytes: $threshold_reason"
  df_output="$(df -B1 --output=avail -- "$docker_root" 2>/dev/null)" || space_error "df failed for Docker data-root; available bytes unknown, required ${required_bytes} bytes: $threshold_reason"
  available_bytes="$(printf '%s\n' "$df_output" | awk 'NR == 2 { print $1 }')"
  [[ "$available_bytes" =~ ^[0-9]+$ ]] || space_error "cannot read free bytes for Docker data-root; available bytes unknown, required ${required_bytes} bytes: $threshold_reason"
  # Bash comparisons are signed 64-bit; an oversized df value must never make an if-test fail open.
  if [ "${#available_bytes}" -gt 19 ] || { [ "${#available_bytes}" -eq 19 ] && [[ "$available_bytes" > 9223372036854775807 ]]; }; then
    space_error "Docker data-root reported ${available_bytes} bytes outside shell integer range; required ${required_bytes} bytes: $threshold_reason"
  fi
  if [ "$available_bytes" -lt "$required_bytes" ]; then
    space_error "Docker data-root has ${available_bytes} bytes available; requires ${required_bytes} bytes: $threshold_reason"
  fi
}
check_space "$required_bytes" "$threshold_reason"
ctx="$(mktemp -d)"
git -C "$BB_REPO" archive "$sha" | tar -x -C "$ctx"
for target in api worker web; do
  have "bondbuddy-m1-$target:$tag" && continue
  echo "tested $target image disappeared; reload the exact tested image archive, do not rebuild" >&2; exit 3
done
if ! have "bondbuddy-m1-egress:$tag"; then
  check_space "$build_required_bytes" "local Docker build required (egress image missing; 4 GiB minimum)"
  docker build -q --build-arg BB_RELEASE_SHA="$sha" -t "bondbuddy-m1-egress:$tag" "$ctx/deploy/m1/egress" >/dev/null
fi
# Tags and preloaded archives alone do not prove which source was built.
for target in api worker web egress; do
  revision="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "bondbuddy-m1-$target:$tag")"
  [ "$revision" = "$sha" ] || { echo "release image source mismatch: $target" >&2; exit 1; }
done
verify_release_images "$BB_REPO" "$sha" all
previous="$(current_tag)"
export BB_IMAGE_TAG="$tag"
# Optional pre-switch gate (BB_DEPLOY_INFLIGHT_GATE=1): the build above can take many minutes, so a run
# may have started since the caller last checked. Stop before migration or any container switch:
# exit 76 when non-parse runs hold a live lease, 77 when the count is unavailable. Built images are kept,
# so a retry skips the build.
if [ "${BB_DEPLOY_INFLIGHT_GATE:-0}" = 1 ] && compose ps --status running --services 2>/dev/null | grep -qx postgres; then
  in_flight="$(compose exec -T postgres psql -X -A -t -v ON_ERROR_STOP=1 -U bondbuddy -d bondbuddy \
    -c "select count(*) from bb_jobs where state='running' and job_type<>'parse' and lease_until > now()" 2>&1)" || in_flight=failed
  if ! [[ "$in_flight" =~ ^[0-9]+$ ]]; then
    echo "deploy in-flight gate: run count unavailable; nothing switched" >&2
    exit 77
  fi
  if [ "$in_flight" -gt 0 ]; then
    echo "deploy in-flight gate: $in_flight non-parse runs in flight; images $tag kept, nothing switched" >&2
    exit 76
  fi
fi
bash "$(dirname "$0")/install-codex-file-sandbox.sh"
compose up -d postgres $( [ "$(env_value COMPOSE_PROFILES)" = staging-blob ] && echo azurite )
compose run --rm migrate
compose up -d --remove-orphans --wait api worker worker-review worker-parse ops egress web
for service in api worker worker-review worker-parse ops web; do
  case "$service" in worker*|ops) target=worker;; *) target="$service";; esac
  tested_id="$(docker image inspect --format '{{.Id}}' "bondbuddy-m1-$target:$tag")"
  containers="$(compose ps -q "$service")"
  [ -n "$containers" ] || { echo "missing runtime container: $service" >&2; exit 4; }
  while read -r container; do
    [ "$(docker inspect --format '{{.Image}}' "$container")" = "$tested_id" ] || { echo "runtime image mismatch: $service" >&2; exit 4; }
  done <<< "$containers"
done
verify_release_images "$BB_REPO" "$sha" all
echo "$tag" > "$BB_STATE/current"
[ -n "$previous" ] && echo "$previous" > "$BB_STATE/previous"
"$(dirname "$0")/smoke.sh" "http://127.0.0.1:$(env_value BB_HTTP_PORT)"
# Keep the exact passing receipt for a later emergency rollback. Record success
# only after smoke: a failed deployment must never authorize the rollback exception.
save_release_evidence "$sha" "$BB_STATE"
log_release deploy "$tag commit=$sha quality_sha256=$BB_RELEASE_QUALITY_DIGEST smoke_sha256=$BB_RELEASE_SMOKE_DIGEST (previous ${previous:-none})"
# Keep only the current and previous release images on disk.
keep="$tag ${previous:-}"
docker image ls --format '{{.Repository}}:{{.Tag}}' | grep '^bondbuddy-m1-' | while read -r ref; do
  case " $keep " in *" ${ref##*:} "*) ;; *) docker image rm "$ref" >/dev/null 2>&1 || true;; esac
done
echo "deployed $tag"
