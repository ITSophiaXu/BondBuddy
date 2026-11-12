#!/usr/bin/env bash
# Usage: BB_ENV_FILE=<private env> deploy-role.sh main|execution <git-sha>
# Uses prebuilt exact-SHA images; export-images-role.sh prepares each role independently.
export BB_DEPLOY_ROLE="${1:?usage: deploy-role.sh main|execution <git-sha>}"; shift
export BB_ROLE_READONLY=0
export BB_PENDING_COMMAND=1
source "$(dirname "$0")/role-lib.sh"
sha="$(git -C "$BB_REPO" rev-parse --verify "${1:?git-sha required}^{commit}")"; shift
rollback=0
case "${1:-}" in '') ;; --rollback) rollback=1; shift;; *) echo 'unexpected deployment argument' >&2; exit 2;; esac
[ "$#" = 0 ] || exit 2
source "$(dirname "$0")/release-evidence.sh"
trap cleanup_release_evidence EXIT
role_compose_arguments
role_script_source
role_trusted_source "$sha"
# Legacy same-version mode stays valid. Decoupling requires an explicit exact script pin.
if [ -z "$BB_DEPLOY_SCRIPT_SHA" ]; then
  git -C "$BB_REPO" diff --quiet "$sha" -- deploy/m1 "${BB_RELEASE_VALIDATOR_PATHS[@]}" || { echo 'deployment files or evidence validators differ from the app commit; pin BB_DEPLOY_SCRIPT_SHA for independent configuration' >&2; exit 2; }
fi
# Validate the trusted script sources before executing either evidence validator.
# Normal releases must be refused before pending state or any one-off SQL container.
if [ "$rollback" = 0 ]; then verify_release_evidence "$BB_REPO" "$sha"; fi
export BB_IMAGE_TAG="${sha:0:12}"
exec 9>"$BB_STATE/deploy.lock"
flock -n 9 || { echo 'this role is already being deployed' >&2; exit 75; }
if [ "$rollback" = 0 ]; then
  # Use the same protected, resolved service selection that lifecycle commands validate.
  compose config --quiet
  BB_RELEASE_CONFIRMATION_SELECTION=disabled
  BB_RELEASE_CONFIRMATION_ROLE="$BB_UPLOAD_CONFIRMATION_ROLE"
  if role_confirmation_active; then BB_RELEASE_CONFIRMATION_SELECTION=active; fi
  verify_rollback_readiness "$BB_REPO" "$sha" "$BB_STATE" "$BB_DEPLOY_ROLE"
  verify_release_images "$BB_REPO" "$sha" "$BB_DEPLOY_ROLE" reuse
fi
BB_RELEASE_CONFIRMATION_SELECTION=disabled
BB_RELEASE_CONFIRMATION_ROLE="$BB_UPLOAD_CONFIRMATION_ROLE"
if role_confirmation_active; then BB_RELEASE_CONFIRMATION_SELECTION=active; fi
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
if role_confirmation_active; then targets+=(upload-confirmation); fi
declare -A image_ids
for target in "${targets[@]}"; do
  docker image inspect "$(role_image_ref "$target")" >/dev/null 2>&1 || { echo "missing release image: $target; prepare with export-images-role.sh" >&2; exit 3; }
  revision="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$(role_image_ref "$target")")"
  [ "$revision" = "$sha" ] || { echo "release image $target has no matching source revision; refusing tag-only reuse" >&2; exit 3; }
  image_ids[$target]="$(docker image inspect --format '{{.Id}}' "$(role_image_ref "$target")")"
done
previous="$(current_tag)"
first_resume=0
resume_candidate=0
resume_consumers=0
gate_tag="$previous"
prepared=0
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
  recovery="$(printf '%s' "$snapshots" | node "$BB_DIR/scripts/role-release.mjs" verify "$BB_STATE" "$BB_DEPLOY_ROLE" "$sha")"
  mapfile -t recovery_fields <<< "$recovery"
  gate_tag="${recovery_fields[0]}"
  first_resume="${recovery_fields[1]}"
  resume_consumers="${recovery_fields[2]}"
  pending_target="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).to)' "$BB_STATE/pending-release.json")"
  if [ "$pending_target" = "$BB_IMAGE_TAG" ]; then resume_candidate=1; fi
  if [ "$first_resume" = 1 ] || [ "$resume_candidate" = 1 ]; then
    # Continuing a sealed candidate (including A -> B after a partial B failure)
    # is a new release attempt. Never borrow the rollback age waiver for it.
    verify_release_evidence "$BB_REPO" "$sha"
  else
    verify_release_evidence "$BB_REPO" "$sha" verify-rollback "$BB_STATE/releases.log" "$BB_DEPLOY_ROLE"
  fi
else
  if [ "$rollback" = 1 ]; then
    verify_release_evidence "$BB_REPO" "$sha" verify-rollback "$BB_STATE/releases.log" "$BB_DEPLOY_ROLE"
  fi
  role_existing_release
  if [ -n "$previous" ]; then
    from_sha="$(git -C "$BB_REPO" rev-parse --verify "$previous^{commit}")"
    [ "${from_sha:0:12}" = "$previous" ] || { echo 'current must identify its exact trusted source' >&2; exit 3; }
    role_trusted_source "$from_sha"
    snapshots+="$(BB_IMAGE_TAG="$previous" role_release_snapshot "$from_sha")"$'\n'
  fi
  snapshots+="$(role_release_snapshot "$sha")"$'\n'
  if [ "$rollback" = 1 ]; then
    verify_release_images "$BB_REPO" "$sha" "$BB_DEPLOY_ROLE" verify-rollback "$BB_STATE/releases.log"
  else verify_release_images "$BB_REPO" "$sha" "$BB_DEPLOY_ROLE"; fi
  # Durable non-success state precedes even the one-off SQL probe container and every switch.
  printf '%s' "$snapshots" | node "$BB_DIR/scripts/role-release.mjs" prepare "$BB_STATE" "$BB_DEPLOY_ROLE" "$sha" '' "$BB_ENV" "$BB_SCRIPT_SHA"
fi
if [ "$rollback" = 1 ]; then
  if [ "$first_resume" = 1 ] || [ "$resume_candidate" = 1 ]; then verify_release_images "$BB_REPO" "$sha" "$BB_DEPLOY_ROLE"
  else verify_release_images "$BB_REPO" "$sha" "$BB_DEPLOY_ROLE" verify-rollback "$BB_STATE/releases.log"; fi
fi
infrastructure=(pg-tunnel egress)
if [ "$BB_DEPLOY_ROLE" = execution ]; then
  case "$BB_INTEGRITY_MODE" in beijing) infrastructure+=(integrity-beijing-tunnel);; direct) infrastructure+=(integrity-egress);; esac
fi
role_prepare_publish() {
  if [ "$BB_DEPLOY_ROLE" = main ]; then
    compose up -d --wait postgres egress
    role_probe connect
    compose run --rm --no-deps -T migrate
  else
    compose up -d --no-deps --wait "${infrastructure[@]}"
  fi
  role_probe schema
}
# No switch while the old role is active. The release procedure must first close new submissions
# and inspect provider processes as well: a DB gate cannot prove an unrecorded external call ended.
if [ "$first_resume" = 1 ] && [ "$resume_consumers" = 0 ]; then
  # No consumers: restore the sealed first release's infrastructure/schema before querying idle.
  # Any connection/schema failure is fatal; no consumer is started or stopped along this path.
  role_prepare_publish
  prepared=1
fi
if [ -n "$gate_tag" ]; then
  candidate="$BB_IMAGE_TAG"
  BB_IMAGE_TAG="$gate_tag" role_probe idle
  export BB_IMAGE_TAG="$candidate"
fi
[ "$rollback" = 0 ] || [ -n "$previous" ] || [ "$first_resume" = 1 ] || { echo 'rollback requires an existing role release or verified first-release pending' >&2; exit 2; }
# Never stop a parser until the existing SQL/in-flight gate has passed.
if [ "$BB_PARSE_ROLE" != "$BB_DEPLOY_ROLE" ]; then
  role_compose_raw stop worker-parse
fi
if [ "$BB_DEPLOY_ROLE" = execution ] && ! role_confirmation_active; then
  role_compose_raw stop upload-confirmation
fi
if [ "$BB_DEPLOY_ROLE" = main ]; then
  if [ "$prepared" = 0 ]; then
    if [ "$rollback" = 0 ] || [ "$first_resume" = 1 ] || [ "$resume_candidate" = 1 ]; then role_prepare_publish
    else role_probe connect; role_probe schema; fi
  fi
  services=(api ops egress)
  [ "$BB_PARSE_ROLE" != main ] || services+=(worker-parse)
  compose up -d --no-deps --wait "${services[@]}"
  # nginx resolves api at startup; always replace web after recreating api.
  compose up -d --no-deps --force-recreate --wait web
  "$BB_DIR/scripts/smoke.sh" "http://127.0.0.1:$(env_value BB_HTTP_PORT)"
else
  bash "$BB_DIR/scripts/install-codex-file-sandbox.sh"
  if [ "$prepared" = 0 ]; then role_prepare_publish; fi
  services=(worker worker-review)
  if role_confirmation_active; then services+=(upload-confirmation); fi
  [ "$BB_PARSE_ROLE" != execution ] || services+=(worker-parse)
  compose up -d --no-deps --wait "${services[@]}"
  services+=("${infrastructure[@]}")
fi
# Bind evidence to immutable image IDs and actual running containers, not mutable tags.
if [ "$BB_DEPLOY_ROLE" = main ]; then services+=(web); fi
if [ "$BB_PARSE_ROLE" != "$BB_DEPLOY_ROLE" ]; then
  [ -z "$(role_compose_raw ps --status running -q worker-parse)" ] || { echo 'inactive parser is still running' >&2; exit 4; }
fi
if [ "$BB_DEPLOY_ROLE" = execution ] && ! role_confirmation_active; then
  [ -z "$(role_compose_raw ps --status running -q upload-confirmation)" ] || { echo 'inactive upload confirmation is still running' >&2; exit 4; }
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
save_release_evidence "$sha" "$BB_STATE"
{ echo "record=$record"; echo "commit=$sha"; echo "script_commit=$BB_SCRIPT_SHA"; echo "script_tree=$(git -C "$BB_REPO" rev-parse "$BB_SCRIPT_SHA^{tree}")";
  echo "quality_sha256=$BB_RELEASE_QUALITY_DIGEST"; echo "smoke_sha256=$BB_RELEASE_SMOKE_DIGEST";
  echo "resume_first=$first_resume"; echo "resume_candidate=$resume_candidate";
  echo "override_sha256=${BB_ROLE_OVERRIDE_SHA256:-none}"; echo "parse_role=$BB_PARSE_ROLE"; echo "upload_confirmation_role=$BB_UPLOAD_CONFIRMATION_ROLE";
  for target in "${targets[@]}"; do echo "$target=${image_ids[$target]}"; done; } > "$BB_STATE/images-$BB_IMAGE_TAG.txt"
cp "$BB_STATE/images-$BB_IMAGE_TAG.txt" "$BB_STATE/release-$record.txt"
# Readiness and file/payment/integrity acceptance are separate release steps in the runbook.
[ -z "$previous" ] || echo "$previous" > "$BB_STATE/previous"
[ ! -f "$BB_STATE/current-release" ] || cp "$BB_STATE/current-release" "$BB_STATE/previous-release"
echo "$record" > "$BB_STATE/current-release"
node "$BB_DIR/scripts/role-release.mjs" clear "$BB_STATE" "$BB_DEPLOY_ROLE" "$sha"
log_release "deploy-$BB_DEPLOY_ROLE" "record=$record app=$sha script=$BB_SCRIPT_SHA quality_sha256=$BB_RELEASE_QUALITY_DIGEST smoke_sha256=$BB_RELEASE_SMOKE_DIGEST override=${BB_ROLE_OVERRIDE_SHA256:-none} rollback=$rollback resume_first=$first_resume resume_candidate=$resume_candidate (previous ${previous:-none})"
echo "deployed $BB_DEPLOY_ROLE $BB_IMAGE_TAG; complete the role acceptance checklist"
