#!/usr/bin/env bash
# Usage: deploy.sh <git-sha>
# Builds images from the exact commit (git archive, so no uncommitted files leak in), takes a
# pre-deploy backup when a database already exists, runs migrations, starts the stack and smokes it.
source "$(dirname "$0")/lib.sh"
sha="$(git -C "$BB_REPO" rev-parse --verify "${1:?usage: deploy.sh <git-sha>}^{commit}")"
tag="${sha:0:12}"
ctx="$(mktemp -d)"; trap 'rm -rf "$ctx"' EXIT
git -C "$BB_REPO" archive "$sha" | tar -x -C "$ctx"
for target in api worker web; do
  docker build -q -f "$ctx/deploy/m1/Dockerfile" --target "$target" --build-arg BB_RELEASE_SHA="$sha" \
    -t "bondbuddy-m1-$target:$tag" "$ctx" >/dev/null
done
docker build -q -t "bondbuddy-m1-egress:$tag" "$ctx/deploy/m1/egress" >/dev/null
previous="$(current_tag)"
export BB_IMAGE_TAG="$tag"
if [ -n "$previous" ] && compose ps --status running --services 2>/dev/null | grep -qx postgres; then
  BB_IMAGE_TAG="$previous" "$(dirname "$0")/backup.sh" "pre-deploy-$tag"
fi
compose up -d postgres $( [ "$(env_value COMPOSE_PROFILES)" = staging-blob ] && echo azurite )
compose run --rm migrate
compose up -d --remove-orphans --wait api worker egress web
echo "$tag" > "$BB_STATE/current"
[ -n "$previous" ] && echo "$previous" > "$BB_STATE/previous"
log_release deploy "$tag (previous ${previous:-none})"
"$(dirname "$0")/smoke.sh" "http://127.0.0.1:$(env_value BB_HTTP_PORT)"
echo "deployed $tag"
