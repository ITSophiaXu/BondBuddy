#!/bin/sh
# Keeps draining durable material parse jobs. Each pass is a bounded one-shot
# (apps/worker material-parse-job) so a crash only loses the current lease, which
# PostgreSQL recovers. There is no model-backed run processor installed in M1 yet;
# runs stay queued/not-ready rather than being faked. The only model call is the
# operator-enqueued platform probe below (BB_PLATFORM_PROBE_ENABLED=1).
set -eu
interval="${BB_WORKER_IDLE_SECONDS:-5}"
while :; do
  node apps/worker/dist/material-parse-job.js || echo '{"worker":"parse pass failed; retrying"}' >&2
  # #79/#16 operator-only platform probe: off unless the operator enables it for a probe window.
  if [ "${BB_PLATFORM_PROBE_ENABLED:-0}" = 1 ]; then
    node apps/worker/dist/platform-probe-job.js || echo '{"worker":"platform probe pass failed; retrying"}' >&2
  fi
  sleep "$interval"
done
