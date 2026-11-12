#!/usr/bin/env bash
# Usage: role-compose.sh main|execution <compose arguments...>
export BB_DEPLOY_ROLE="${1:?usage: role-compose.sh main|execution <compose arguments...>}"; shift
case "${1:-}" in
  ''|-*) echo 'role-compose.sh requires a subcommand first; configure global Compose options in the fixed deployment scripts' >&2; exit 2;;
  build|pull|watch|scale) echo 'image preparation, scaling and release changes require fixed deployment configuration and export-images-role.sh or deploy-role.sh evidence gates' >&2; exit 2;;
esac
export BB_ROLE_READONLY=0
export BB_PENDING_COMMAND=0
source "$(dirname "$0")/role-lib.sh"
retained_tag="$(current_tag)"
export BB_IMAGE_TAG="${BB_IMAGE_TAG:-$retained_tag}"
role_compose_arguments "$@"
case "${1:-}" in config|ps|logs|images|port|version) BB_ROLE_READONLY=1;;
  probe) role_script_source;;
  *) role_script_source; role_existing_state;;
esac
# Maintenance may recreate the retained version, but cannot select a new release.
# An empty role may bootstrap explicit infrastructure without starting dependencies.
bootstrap_infrastructure() {
  local command="$1" no_deps=0 services=0 arg
  shift
  case "$command" in up|create) ;; *) return 1;; esac
  [ -n "$BB_IMAGE_TAG" ] || return 1
  for arg in "$@"; do
    case "$arg" in
      --no-deps) no_deps=1;;
      -d|--detach|--wait|--force-recreate|--no-recreate|--no-start|--no-build|--quiet-pull) ;;
      egress) services=$((services + 1));;
      postgres) [ "$BB_DEPLOY_ROLE" = main ] || return 1; services=$((services + 1));;
      pg-tunnel) [ "$BB_DEPLOY_ROLE" = execution ] || return 1; services=$((services + 1));;
      *) return 1;;
    esac
  done
  [ "$no_deps" = 1 ] && [ "$services" -gt 0 ]
}
case "${1:-}" in up|create|run|probe)
  if [ -n "$retained_tag" ]; then
    [ "$BB_IMAGE_TAG" = "$retained_tag" ] || { echo 'maintenance cannot change the retained image tag; use deploy-role.sh for a release' >&2; exit 2; }
  elif ! bootstrap_infrastructure "$@"; then
    echo 'no retained release: use deploy-role.sh; infrastructure bootstrap requires explicit role services and --no-deps' >&2; exit 2
  fi;;
esac
if [ "${1:-}" = probe ]; then
  shift
  [ "$#" = 1 ] || { echo 'usage: role-compose.sh main|execution probe connect|schema|idle' >&2; exit 2; }
  case "$1" in connect|schema|idle) role_probe "$1";; *) exit 2;; esac
  exit
fi
compose "$@"
