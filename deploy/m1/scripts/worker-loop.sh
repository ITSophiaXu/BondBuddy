#!/bin/sh
# Keeps draining durable material parse jobs. Each pass is a bounded one-shot
# (apps/worker material-parse-job) so a crash only loses the current lease, which
# PostgreSQL recovers. There is no model-backed run processor installed in M1 yet;
# runs stay queued/not-ready rather than being faked.
set -eu
interval="${BB_WORKER_IDLE_SECONDS:-5}"
while :; do
  node apps/worker/dist/material-parse-job.js || echo '{"worker":"parse pass failed; retrying"}' >&2
  sleep "$interval"
done
