#!/usr/bin/env bash
# Private maintenance command. The actor is the invoking OS account.
source "$(dirname "$0")/lib.sh"
export BB_IMAGE_TAG="${BB_IMAGE_TAG:-$(current_tag)}"
compose exec -T -e "BB_RECONCILE_ACTOR=$(id -un)" ops node apps/worker/dist/reconcile-run.js "$@"
