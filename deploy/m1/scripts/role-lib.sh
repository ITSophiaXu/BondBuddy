# Role-specific deployment helpers. Never source the env file as shell code.
set -euo pipefail
case "${BB_DEPLOY_ROLE:-}" in main|execution) ;; *) echo 'role must be main or execution' >&2; exit 2;; esac
export BB_ROLE_COMMAND=1
BB_ROLE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BB_PRIVATE_STATE="$(node "$BB_ROLE_DIR/scripts/role-config.mjs" state "${BB_ENV_FILE:-$BB_ROLE_DIR/.env}")" || exit 2
if [ -n "$BB_PRIVATE_STATE" ]; then
  [ -z "${BB_STATE_DIR:-}" ] || [ "$(realpath -m "$BB_STATE_DIR")" = "$(realpath -m "$BB_PRIVATE_STATE")" ] || { echo 'BB_STATE_DIR must match the retained private BB_ROLE_STATE_DIR' >&2; exit 2; }
  export BB_STATE_DIR="$BB_PRIVATE_STATE"
else
  export BB_STATE_DIR="${BB_STATE_DIR:-$BB_ROLE_DIR/state-$BB_DEPLOY_ROLE}"
fi
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
# Serialize adoption, including concurrent first invocations. This lock is local to this role.
exec 8>"$BB_STATE/config.lock"
flock -n 8 || { echo 'role configuration is in use' >&2; exit 75; }
role_metadata() {
  local metadata
  metadata="$(node "$BB_DIR/scripts/role-config.mjs" metadata "$BB_ENV" "$BB_STATE" "$BB_DEPLOY_ROLE")" || exit 2
  mapfile -t BB_ROLE_METADATA <<< "$metadata"
  BB_ROLE_OVERRIDE_FILE="${BB_ROLE_METADATA[0]}"
  BB_ROLE_OVERRIDE_SHA256="${BB_ROLE_METADATA[1]}"
  BB_PARSE_ROLE="${BB_ROLE_METADATA[2]}"
  BB_ROLE_PROJECT="${BB_ROLE_METADATA[3]}"
  BB_DEPLOY_SCRIPT_SHA="${BB_ROLE_METADATA[4]:-}"
  BB_INTEGRITY_MODE="${BB_ROLE_METADATA[5]:-}"
  BB_UPLOAD_CONFIRMATION_ROLE="${BB_ROLE_METADATA[6]:-disabled}"
}
role_metadata
role_confirmation_active() {
  [ "$BB_DEPLOY_ROLE" = execution ] && [ "$BB_UPLOAD_CONFIRMATION_ROLE" != disabled ]
}
source "$BB_DIR/scripts/role-source-lib.sh"
# compose.yaml is extended for its shared policies. Its unused legacy DB interpolation must not
# require the main-site password on execution hosts; the actual URL is BB_EXECUTION_DATABASE_URL.
if [ "$BB_DEPLOY_ROLE" = execution ]; then
  export POSTGRES_PASSWORD=unused-no-local-database
  case "$BB_INTEGRITY_MODE" in beijing|direct|disabled) ;; *) echo 'set BB_INTEGRITY_MODE explicitly to beijing, direct or disabled; preserve the deployed route' >&2; exit 2;; esac
fi
role_image_ref() {
  if [ "$1" = integrity-tunnel ]; then echo "bondbuddy-integrity-tunnel:$BB_IMAGE_TAG"; else echo "bondbuddy-m1-$1:$BB_IMAGE_TAG"; fi
}
role_compose_raw() (
  # Compose's process env normally overrides --env-file. Remove that alternate configuration
  # channel while retaining Docker authentication/connection settings and the exact image tag.
  local tag="$BB_IMAGE_TAG" key role="$BB_DEPLOY_ROLE" parse="$BB_PARSE_ROLE" directory="$BB_DIR" environment="$BB_ENV" override="$BB_ROLE_OVERRIDE_FILE" integrity="${BB_INTEGRITY_MODE:-}" project="$BB_ROLE_PROJECT" confirmation="$BB_UPLOAD_CONFIRMATION_ROLE"
  while read -r key; do
    case "$key" in BB_*|COMPOSE_*|POSTGRES_PASSWORD) unset "$key";; esac
  done < <(compgen -e)
  while read -r key; do unset "$key"; done < <(sed -nE 's/^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=.*/\2/p' "$environment")
  export BB_IMAGE_TAG="$tag"
  if [ "$parse" = "$role" ]; then
    export BB_ROLE_PARSE_PROFILE=bb-parse-active BB_ROLE_PARSE_REPLICAS=1
  else
    export BB_ROLE_PARSE_PROFILE=bb-parse-inactive BB_ROLE_PARSE_REPLICAS=0
  fi
  if [ "$role" = execution ] && [ "$confirmation" != disabled ]; then
    export BB_ROLE_CONFIRMATION_PROFILE=bb-confirmation-active BB_ROLE_CONFIRMATION_REPLICAS=1
  else
    export BB_ROLE_CONFIRMATION_PROFILE=bb-confirmation-inactive BB_ROLE_CONFIRMATION_REPLICAS=0
  fi
  if [ "$confirmation" = size-split ]; then export BB_ROLE_CONFIRMATION_LANE=large; else export BB_ROLE_CONFIRMATION_LANE=general; fi
  [ "$role" != execution ] || export POSTGRES_PASSWORD=unused-no-local-database
  local files=(-f "$directory/compose.$role.yaml")
  if [ "$role" = execution ]; then
    case "$integrity" in
      beijing) files+=(-f "$directory/compose.integrity-beijing.yaml");;
      direct) files+=(-f "$directory/compose.integrity-browser.yaml");;
    esac
  fi
  [ -z "$override" ] || files+=(-f "$override")
  local profiles=()
  [ "$parse" != "$role" ] || profiles+=(--profile bb-parse-active)
  if [ "$role" = execution ] && [ "$confirmation" != disabled ]; then profiles+=(--profile bb-confirmation-active); fi
  docker compose --project-directory "$directory" --project-name "$project" "${files[@]}" "${profiles[@]}" --env-file "$environment" "$@"
)
compose() {
  role_metadata
  # Validate resolved policies without printing credentials, before every lifecycle command.
  role_compose_raw --profile '*' config --format json 2>/dev/null | node "$BB_DIR/scripts/role-config.mjs" validate "$BB_ENV" "$BB_STATE" "$BB_DEPLOY_ROLE" 3< <(
    if role_confirmation_active; then
      role_compose_raw --profile '*' -f "$BB_DIR/compose.confirmation-bind-check.yaml" config --format json 2>/dev/null
    fi
  ) 4< <(
    if role_confirmation_active; then
      role_compose_raw --profile '*' -f "$BB_DIR/compose.confirmation-bind-true-check.yaml" config --format json 2>/dev/null
    fi
  ) || return 2
  [ "${BB_ROLE_READONLY:-0}" != 1 ] || flock -u 8
  role_compose_raw "$@"
}
role_existing_state() {
  if [ -f "$BB_STATE/pending-release.json" ] && [ "${BB_PENDING_COMMAND:-0}" != 1 ]; then
    echo 'pending role release: use deploy-role.sh --rollback for verified recovery' >&2; exit 3
  fi
  local existing
  existing="$(docker ps -aq --filter "label=com.docker.compose.project=$BB_ROLE_PROJECT")"
  if [ -n "$existing" ] && [ -z "$(current_tag)" ] && { [ "${BB_PENDING_COMMAND:-0}" != 1 ] || [ ! -f "$BB_STATE/pending-release.json" ]; }; then
    echo 'existing role project has no retained release state; adopt verified state/project/pgdata before deployment, never treat it as a first release' >&2; exit 2
  fi
}
role_release_snapshot() {
  local hashes snapshot status
  hashes="$(mktemp "$BB_STATE/.release-hashes.XXXXXX")"
  if role_compose_raw --profile '*' config --hash '*' > "$hashes" &&
    snapshot="$(role_compose_raw --profile '*' config --format json | node "$BB_DIR/scripts/role-release.mjs" snapshot "$BB_STATE" "$BB_DEPLOY_ROLE" "$1" "$hashes" "$BB_ENV")"; then
    rm "$hashes"; printf '%s\n' "$snapshot"
  else
    status=$?; rm "$hashes"; return "$status"
  fi
}
role_existing_release() {
  # current-only migration states are legal. Verify what is actually running without inventing
  # old receipts; the SQL idle gate is still mandatory after this source/ID check.
  local tag container service target image revision expected containers
  tag="$(current_tag)"; [ -n "$tag" ] || return 0
  containers="$(docker ps -q --filter "label=com.docker.compose.project=$BB_ROLE_PROJECT")"
  while read -r container; do
    [ -n "$container" ] || continue
    service="$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.service" }}' "$container")"
    case "$service" in api|web|egress|pg-tunnel|integrity-egress|upload-confirmation) target="$service";;
      ops|worker|worker-review|worker-parse) target=worker;; integrity-beijing-tunnel) target=integrity-tunnel;; postgres) continue;;
      *) echo 'unexpected running service in the retained role project' >&2; exit 3;;
    esac
    image="$(docker inspect --format '{{.Image}}' "$container")"
    revision="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$image")"
    [[ "$revision" =~ ^[a-f0-9]{40}$ ]] && [ "${revision:0:12}" = "$tag" ] || { echo 'retained runtime source does not match current; nothing switched' >&2; exit 3; }
    role_trusted_source "$revision"
    expected="$(BB_IMAGE_TAG="$tag" role_image_ref "$target")"
    [ "$(docker image inspect --format '{{.Id}}' "$expected")" = "$image" ] || { echo 'retained runtime ID differs from its exact source image; nothing switched' >&2; exit 3; }
  done <<< "$containers"
}
role_compose_arguments() {
  local arg command="${1:-}" index=0
  for arg in "$@"; do
    if [ "$command" = logs ] && [ "$index" -gt 0 ] && [ "$arg" = -f ]; then continue; fi
    index=$((index + 1))
    case "$arg" in -f|-f?*|--file|--file=*|--env-file|--env-file=*|--project-directory|--project-directory=*|-p|-p?*|--project-name|--project-name=*|--profile|--profile=*|--scale|--scale=*|--include-deps)
      echo 'role entry owns Compose files, env, project, profiles and parser scale; extra configuration flags are disabled' >&2; exit 2;;
    esac
    if ! role_confirmation_active && [ "$arg" = upload-confirmation ]; then
      echo 'upload confirmation is inactive in this role' >&2; exit 2
    fi
    if [ "$BB_PARSE_ROLE" != "$BB_DEPLOY_ROLE" ] && [ "$arg" = worker-parse ]; then
      echo 'parser is inactive in this role' >&2; exit 2
    fi
  done
  local key
  while read -r key; do
    case "$key" in COMPOSE_*) echo 'COMPOSE environment overrides are disabled; configure the private role env' >&2; exit 2;; esac
  done < <(compgen -e)
}
role_probe() {
  local service=api
  [ "$BB_DEPLOY_ROLE" = execution ] && service=worker
  # stdin supplies this checkout's script even to images made before this entry existed.
  compose run --rm --no-deps -T "$service" node --input-type=module - "$BB_DEPLOY_ROLE" "$1" < "$BB_DIR/scripts/role-probe.mjs"
}
