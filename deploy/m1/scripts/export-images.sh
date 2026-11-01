#!/usr/bin/env bash
# Usage: export-images.sh <git-sha> <out.tar.gz>
# Builds (if needed) and saves the four release images on a build host, so a small target host can
# `docker load -i <out.tar.gz>` and run deploy.sh <git-sha> without building. Transfer the file with
# scp over the authorised SSH route; it contains no secrets (those stay in the target's .env).
set -euo pipefail
repo="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
sha="$(git -C "$repo" rev-parse --verify "${1:?git-sha}^{commit}")"; tag="${sha:0:12}"; out="${2:?out.tar.gz}"
node "$repo/scripts/prospectus-quality-gate.mjs" verify "$sha" "${BB_RELEASE_QUALITY_RECEIPT:?set BB_RELEASE_QUALITY_RECEIPT to passing evidence for this exact commit}"
ctx="$(mktemp -d)"; trap 'rm -rf "$ctx"' EXIT
git -C "$repo" archive "$sha" | tar -x -C "$ctx"
for t in api worker web; do docker image inspect "bondbuddy-m1-$t:$tag" >/dev/null 2>&1 || docker build -q -f "$ctx/deploy/m1/Dockerfile" --target "$t" --build-arg BB_RELEASE_SHA="$sha" -t "bondbuddy-m1-$t:$tag" "$ctx" >/dev/null; done
docker image inspect "bondbuddy-m1-egress:$tag" >/dev/null 2>&1 || docker build -q --build-arg BB_RELEASE_SHA="$sha" -t "bondbuddy-m1-egress:$tag" "$ctx/deploy/m1/egress" >/dev/null
for target in api worker web egress; do
  revision="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "bondbuddy-m1-$target:$tag")"
  [ "$revision" = "$sha" ] || { echo "release image source mismatch: $target" >&2; exit 1; }
done
docker save "bondbuddy-m1-api:$tag" "bondbuddy-m1-worker:$tag" "bondbuddy-m1-web:$tag" "bondbuddy-m1-egress:$tag" | gzip -1 > "$out"
ls -l "$out"
