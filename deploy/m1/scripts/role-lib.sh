# Role-specific deployment helpers. Never source the env file as shell code.
set -euo pipefail
case "${BB_DEPLOY_ROLE:-}" in main|execution) ;; *) echo 'role must be main or execution' >&2; exit 2;; esac
export BB_ROLE_COMMAND=1
export BB_STATE_DIR="${BB_STATE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/state-$BB_DEPLOY_ROLE}"
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
[ "$(env_value BB_DEPLOY_ROLE)" = "$BB_DEPLOY_ROLE" ] || { echo 'env BB_DEPLOY_ROLE must match the requested role' >&2; exit 2; }
# compose.yaml is extended for its shared policies. Its unused legacy DB interpolation must not
# require the main-site password on execution hosts; the actual URL is BB_EXECUTION_DATABASE_URL.
if [ "$BB_DEPLOY_ROLE" = execution ]; then export POSTGRES_PASSWORD=unused-no-local-database; fi
compose() {
  local files=(-f "$BB_DIR/compose.$BB_DEPLOY_ROLE.yaml")
  if [ "$BB_DEPLOY_ROLE" = execution ] && [ "$(env_value BB_INTEGRITY_BROWSER)" = 1 ]; then
    files+=(-f "$BB_DIR/compose.integrity-browser.yaml")
  fi
  docker compose --project-directory "$BB_DIR" "${files[@]}" --env-file "$BB_ENV" "$@"
}
role_probe() {
  local service=api
  [ "$BB_DEPLOY_ROLE" = execution ] && service=worker
  # stdin supplies this checkout's script even to images made before this entry existed.
  compose run --rm --no-deps -T "$service" node --input-type=module - "$BB_DEPLOY_ROLE" "$1" < "$BB_DIR/scripts/role-probe.mjs"
}
