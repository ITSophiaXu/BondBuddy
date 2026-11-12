#!/usr/bin/env bash
# Usage: export-images-role.sh main|execution <git-sha> <output.tar.gz> [beijing|direct|disabled]
set -euo pipefail
role="${1:?role required}"; ref="${2:?git-sha required}"; output="${3:?output archive required}"
case "$role" in main) targets=(api worker web egress);; execution)
 targets=(worker egress pg-tunnel)
 case "${4:-beijing}" in beijing) targets+=(integrity-tunnel);; direct) targets+=(integrity-egress);; disabled) ;; *) echo 'invalid integrity mode' >&2; exit 2;; esac;; *) exit 2;; esac
repo="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
sha="$(git -C "$repo" rev-parse --verify "$ref^{commit}")"; tag="${sha:0:12}"
source "$(dirname "$0")/release-evidence.sh"
ctx=''; trap 'cleanup_release_evidence; [ -z "$ctx" ] || rm -rf "$ctx"' EXIT
BB_REPO="$repo"
source "$(dirname "$0")/role-source-lib.sh"
BB_DEPLOY_SCRIPT_SHA=''
role_script_source
role_trusted_source "$sha"
verify_release_evidence "$repo" "$sha"
verify_release_images "$repo" "$sha" "$role" reuse
# Keep checkout/build/archive on the data filesystem. Do not copy credentials into the context.
images=()
for target in "${targets[@]}"; do
  if [ "$target" = integrity-tunnel ]; then image="bondbuddy-integrity-tunnel:$tag"; else image="bondbuddy-m1-$target:$tag"; fi
  images+=("$image")
  if docker image inspect "$image" >/dev/null 2>&1; then
    revision="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$image")"
    [ "$revision" = "$sha" ] || { echo "image $target has no matching source revision; do not reuse a drifting tag" >&2; exit 3; }
    continue
  fi
  if [ -z "$ctx" ]; then
    ctx="$(mktemp -d "$(dirname "$repo")/.bb-role-build.XXXXXX")"
    git -C "$repo" archive "$sha" | tar -x -C "$ctx"
  fi
  case "$target" in
    api|worker|web) echo "tested image disappeared: $target; reload the exact tested image archive" >&2; exit 3;;
    integrity-tunnel) docker build --network "${BB_BUILD_NETWORK:-default}" -q --label "org.opencontainers.image.revision=$sha" -f "$ctx/deploy/beijing/Dockerfile.tunnel" -t "$image" "$ctx/deploy/beijing" >/dev/null;;
    egress|pg-tunnel) docker build --network "${BB_BUILD_NETWORK:-default}" -q --label "org.opencontainers.image.revision=$sha" -t "$image" "$ctx/deploy/m1/$target" >/dev/null;;
    *) docker build --network "${BB_BUILD_NETWORK:-default}" -q -f "$ctx/deploy/m1/Dockerfile" --target "$target" --build-arg BB_RELEASE_SHA="$sha" -t "$image" "$ctx" >/dev/null;;
  esac
done
verify_release_images "$repo" "$sha" "$role"
# pipefail prevents a partial archive being reported as success. No images are pruned here.
docker save "${images[@]}" | gzip > "$output"
echo "prepared $role $tag"
