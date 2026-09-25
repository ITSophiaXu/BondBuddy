#!/usr/bin/env bash
# Usage: deploy.sh <git-sha>
# Builds images from the exact commit (git archive, so no uncommitted files leak in), takes a
# pre-deploy backup when a database already exists, runs migrations, starts the stack and smokes it.
source "$(dirname "$0")/lib.sh"
sha="$(git -C "$BB_REPO" rev-parse --verify "${1:?usage: deploy.sh <git-sha>}^{commit}")"
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
ctx="$(mktemp -d)"; trap 'rm -rf "$ctx"' EXIT
git -C "$BB_REPO" archive "$sha" | tar -x -C "$ctx"
for target in api worker web; do
  have "bondbuddy-m1-$target:$tag" && continue
  check_space "$build_required_bytes" "local Docker build required ($target image missing; 4 GiB minimum)"
  docker build -q -f "$ctx/deploy/m1/Dockerfile" --target "$target" --build-arg BB_RELEASE_SHA="$sha" \
    -t "bondbuddy-m1-$target:$tag" "$ctx" >/dev/null
done
if ! have "bondbuddy-m1-egress:$tag"; then
  check_space "$build_required_bytes" "local Docker build required (egress image missing; 4 GiB minimum)"
  docker build -q -t "bondbuddy-m1-egress:$tag" "$ctx/deploy/m1/egress" >/dev/null
fi
previous="$(current_tag)"
export BB_IMAGE_TAG="$tag"
if [ -n "$previous" ] && compose ps --status running --services 2>/dev/null | grep -qx postgres; then
  BB_IMAGE_TAG="$previous" "$(dirname "$0")/backup.sh" "pre-deploy-$tag"
fi
compose up -d postgres $( [ "$(env_value COMPOSE_PROFILES)" = staging-blob ] && echo azurite )
compose run --rm migrate
compose up -d --remove-orphans --wait api worker ops egress web
echo "$tag" > "$BB_STATE/current"
[ -n "$previous" ] && echo "$previous" > "$BB_STATE/previous"
log_release deploy "$tag (previous ${previous:-none})"
"$(dirname "$0")/smoke.sh" "http://127.0.0.1:$(env_value BB_HTTP_PORT)"
# Keep only the current and previous release images on disk.
keep="$tag ${previous:-}"
docker image ls --format '{{.Repository}}:{{.Tag}}' | grep '^bondbuddy-m1-' | while read -r ref; do
  case " $keep " in *" ${ref##*:} "*) ;; *) docker image rm "$ref" >/dev/null 2>&1 || true;; esac
done
echo "deployed $tag"
