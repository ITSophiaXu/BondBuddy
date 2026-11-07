# Shared helpers for the M1 deploy scripts. Sourced, not executed.
set -euo pipefail
BB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BB_REPO="$(git -C "$BB_DIR" rev-parse --show-toplevel)"
BB_ENV="${BB_ENV_FILE:-$BB_DIR/.env}"   # one env file per stack; several stacks may share a checkout
BB_STATE="${BB_STATE_DIR:-$BB_DIR/state}"
mkdir -p "$BB_STATE"
[ -f "$BB_ENV" ] || { echo "missing $BB_ENV (see .env.example)" >&2; exit 2; }
# BB_PROFILE=prod in .env adds compose.prod.yaml (small shared host, Azure Blob, no Azurite).
compose() {
  local files=(-f "$BB_DIR/compose.yaml")
  [ "$(env_value BB_PROFILE)" = prod ] && files+=(-f "$BB_DIR/compose.prod.yaml")
  docker compose --project-directory "$BB_DIR" "${files[@]}" --env-file "$BB_ENV" "$@"
}
current_tag() { cat "$BB_STATE/current" 2>/dev/null || true; }
log_release() { printf '%s\t%s\t%s\n' "$(date -u +%FT%TZ)" "$1" "$2" >> "$BB_STATE/releases.log"; }
env_value() { sed -n "s/^$1=//p" "$BB_ENV" | tail -1; }
# Split deployments must never enter legacy all-in-one deploy/restore/rollback paths.
if [ "${BB_ROLE_COMMAND:-0}" != 1 ] && { [ -n "$(env_value BB_DEPLOY_ROLE)" ] ||
  [ -f "$BB_STATE/environment-binding.json" ] || [ -f "$BB_DIR/state-main/environment-binding.json" ] || [ -f "$BB_DIR/state-execution/environment-binding.json" ]; }; then
  echo 'split deployment: use role-compose.sh/deploy-role.sh and the split deployment runbook; legacy scripts are disabled' >&2
  exit 2
fi
