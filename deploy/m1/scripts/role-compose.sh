#!/usr/bin/env bash
# Usage: role-compose.sh main|execution <compose arguments...>
export BB_DEPLOY_ROLE="${1:?usage: role-compose.sh main|execution <compose arguments...>}"; shift
source "$(dirname "$0")/role-lib.sh"
export BB_IMAGE_TAG="${BB_IMAGE_TAG:-$(current_tag)}"
compose "$@"
