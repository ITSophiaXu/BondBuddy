#!/usr/bin/env bash
# Usage: role-compose.sh main|execution <compose arguments...>
export BB_DEPLOY_ROLE="${1:?usage: role-compose.sh main|execution <compose arguments...>}"; shift
source "$(dirname "$0")/role-lib.sh"
export BB_IMAGE_TAG="${BB_IMAGE_TAG:-$(current_tag)}"
role_compose_arguments "$@"
case "${1:-}" in config|ps|logs|images|port|version) ;;
  probe) role_script_source;;
  *) role_script_source; role_existing_state;;
esac
if [ "${1:-}" = probe ]; then
  shift
  [ "$#" = 1 ] || { echo 'usage: role-compose.sh main|execution probe connect|schema|idle' >&2; exit 2; }
  case "$1" in connect|schema|idle) role_probe "$1";; *) exit 2;; esac
  exit
fi
compose "$@"
