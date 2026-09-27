#!/usr/bin/env bash
# Execute the audited grant command in the private ops service.
source "$(dirname "$0")/lib.sh"
if [ "$(env_value BB_DEPLOYMENT_TIER)" != preprod ] || [ "$(env_value BB_NON_PRODUCTION_TEST_CHANNEL)" != enabled ]; then
  echo 'non-production test channel is disabled' >&2
  exit 2
fi
export BB_IMAGE_TAG="${BB_IMAGE_TAG:-$(current_tag)}"
compose exec -T ops node apps/worker/dist/non-production-test-grants.js "$@"
