#!/usr/bin/env bash
# Usage: export-images.sh <git-sha> <out.tar.gz>
# Reuses tested app images, builds auxiliary egress if needed, and saves all four so a small target host can
# `docker load -i <out.tar.gz>` and run deploy.sh <git-sha> without building. Transfer the file with
# scp over the authorised SSH route; it contains no secrets (those stay in the target's .env).
set -euo pipefail
BB_RELEASE_CONFIRMATION_SELECTION=disabled
repo="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
sha="$(git -C "$repo" rev-parse --verify "${1:?git-sha}^{commit}")"; tag="${sha:0:12}"; out="${2:?out.tar.gz}"
source "$(dirname "$0")/release-evidence.sh"
ctx=''; trap 'cleanup_release_evidence; [ -z "$ctx" ] || rm -rf "$ctx"' EXIT
verify_release_evidence "$repo" "$sha"
verify_release_images "$repo" "$sha" all reuse
ctx="$(mktemp -d)"
git -C "$repo" archive "$sha" | tar -x -C "$ctx"
for t in api worker web; do docker image inspect "bondbuddy-m1-$t:$tag" >/dev/null 2>&1 || { echo "tested image disappeared: $t; reload the exact tested image archive" >&2; exit 3; }; done
docker image inspect "bondbuddy-m1-egress:$tag" >/dev/null 2>&1 || docker build -q --build-arg BB_RELEASE_SHA="$sha" -t "bondbuddy-m1-egress:$tag" "$ctx/deploy/m1/egress" >/dev/null
for target in api worker web egress; do
  revision="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "bondbuddy-m1-$target:$tag")"
  [ "$revision" = "$sha" ] || { echo "release image source mismatch: $target" >&2; exit 1; }
done
verify_release_images "$repo" "$sha" all
docker save "bondbuddy-m1-api:$tag" "bondbuddy-m1-worker:$tag" "bondbuddy-m1-web:$tag" "bondbuddy-m1-egress:$tag" | gzip -1 > "$out"
ls -l "$out"
