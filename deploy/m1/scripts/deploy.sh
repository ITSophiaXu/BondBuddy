#!/usr/bin/env bash
# Usage: deploy.sh <git-sha>
# Builds images from the exact commit (git archive, so no uncommitted files leak in), takes a
# pre-deploy backup when a database already exists, runs migrations, starts the stack and smokes it.
source "$(dirname "$0")/lib.sh"
sha="$(git -C "$BB_REPO" rev-parse --verify "${1:?usage: deploy.sh <git-sha>}^{commit}")"
tag="${sha:0:12}"
ctx="$(mktemp -d)"; trap 'rm -rf "$ctx"' EXIT
git -C "$BB_REPO" archive "$sha" | tar -x -C "$ctx"
# Images already present (e.g. loaded with `docker load` from scripts/export-images.sh on a build
# host, to spare a small target disk the ~2 GB build cache) are reused, not rebuilt.
have() { docker image inspect "$1" >/dev/null 2>&1; }
for target in api worker web; do
  have "bondbuddy-m1-$target:$tag" && continue
  docker build -q -f "$ctx/deploy/m1/Dockerfile" --target "$target" --build-arg BB_RELEASE_SHA="$sha" \
    -t "bondbuddy-m1-$target:$tag" "$ctx" >/dev/null
done
have "bondbuddy-m1-egress:$tag" || docker build -q -t "bondbuddy-m1-egress:$tag" "$ctx/deploy/m1/egress" >/dev/null
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
