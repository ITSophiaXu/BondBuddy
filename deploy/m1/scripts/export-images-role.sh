#!/usr/bin/env bash
# Usage: export-images-role.sh main|execution <git-sha> <output.tar.gz>
set -euo pipefail
role="${1:?role required}"; ref="${2:?git-sha required}"; output="${3:?output archive required}"
case "$role" in main) targets=(api worker web egress);; execution) targets=(worker egress pg-tunnel integrity-egress);; *) exit 2;; esac
repo="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
sha="$(git -C "$repo" rev-parse --verify "$ref^{commit}")"; tag="${sha:0:12}"
# Keep checkout/build/archive on the data filesystem. Do not copy credentials into the context.
ctx="$(mktemp -d "$(dirname "$repo")/.bb-role-build.XXXXXX")"; trap 'rm -rf "$ctx"' EXIT
git -C "$repo" archive "$sha" | tar -x -C "$ctx"
images=()
for target in "${targets[@]}"; do
  image="bondbuddy-m1-$target:$tag"; images+=("$image")
  if docker image inspect "$image" >/dev/null 2>&1; then continue; fi
  case "$target" in
    egress|pg-tunnel) docker build -q -t "$image" "$ctx/deploy/m1/$target" >/dev/null;;
    *) docker build -q -f "$ctx/deploy/m1/Dockerfile" --target "$target" --build-arg BB_RELEASE_SHA="$sha" -t "$image" "$ctx" >/dev/null;;
  esac
done
# pipefail prevents a partial archive being reported as success. No images are pruned here.
docker save "${images[@]}" | gzip > "$output"
echo "prepared $role $tag"
