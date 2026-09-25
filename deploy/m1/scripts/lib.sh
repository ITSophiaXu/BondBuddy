# Shared helpers for the M1 deploy scripts. Sourced, not executed.
set -euo pipefail
BB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BB_REPO="$(git -C "$BB_DIR" rev-parse --show-toplevel)"
BB_STATE="${BB_STATE_DIR:-$BB_DIR/state}"
mkdir -p "$BB_STATE"
[ -f "$BB_DIR/.env" ] || { echo "missing $BB_DIR/.env (see .env.example)" >&2; exit 2; }
compose() { docker compose --project-directory "$BB_DIR" -f "$BB_DIR/compose.yaml" --env-file "$BB_DIR/.env" "$@"; }
current_tag() { cat "$BB_STATE/current" 2>/dev/null || true; }
log_release() { printf '%s\t%s\t%s\n' "$(date -u +%FT%TZ)" "$1" "$2" >> "$BB_STATE/releases.log"; }
env_value() { sed -n "s/^$1=//p" "$BB_DIR/.env" | tail -1; }
