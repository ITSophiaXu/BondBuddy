# Role-specific deployment helpers. Never source the env file as shell code.
set -euo pipefail
case "${BB_DEPLOY_ROLE:-}" in main|execution) ;; *) echo 'role must be main or execution' >&2; exit 2;; esac
export BB_ROLE_COMMAND=1
export BB_STATE_DIR="${BB_STATE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/state-$BB_DEPLOY_ROLE}"
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
}
role_metadata
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
  local tag="$BB_IMAGE_TAG" key role="$BB_DEPLOY_ROLE" parse="$BB_PARSE_ROLE" directory="$BB_DIR" environment="$BB_ENV" override="$BB_ROLE_OVERRIDE_FILE" integrity="${BB_INTEGRITY_MODE:-}" project="$BB_ROLE_PROJECT"
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
  [ "$parse" != "$role" ] || profiles=(--profile bb-parse-active)
  docker compose --project-directory "$directory" --project-name "$project" "${files[@]}" "${profiles[@]}" --env-file "$environment" "$@"
)
compose() {
  role_metadata
  # Validate resolved policies without printing credentials, before every lifecycle command.
  role_compose_raw --profile '*' config --format json 2>/dev/null | node "$BB_DIR/scripts/role-config.mjs" validate "$BB_ENV" "$BB_STATE" "$BB_DEPLOY_ROLE" || return 2
  role_compose_raw "$@"
}
role_compose_arguments() {
  local arg
  for arg in "$@"; do
    case "$arg" in -f|-f?*|--file|--file=*|--env-file|--env-file=*|--project-directory|--project-directory=*|-p|-p?*|--project-name|--project-name=*|--profile|--profile=*|--scale|--scale=*|--include-deps)
      echo 'role entry owns Compose files, env, project, profiles and parser scale; extra configuration flags are disabled' >&2; exit 2;;
    esac
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
