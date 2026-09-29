# Log and job recovery drill (synthetic, isolated)

This kit exercises the fifth acceptance item of #79 without a supplier call or customer material. It uses a fresh PostgreSQL 16 container, a fresh Azurite container, a migrated template database and a database cloned from that template. The test never writes to the configured application database. The real file sink is a private temporary NDJSON file. The parse claimant is a child process started by the test; only that process is killed.

The existing production interfaces remain the source of truth: `enqueueMaterialParse`, `claimMaterialParse`, `completeMaterialParseStage`, `succeedMaterialParse`, `forwardLogs`, `ndjsonFileSink`, `guardEvidenceWrite`, `resumeEvidenceGate` and `observeUsage`. This drill does not alter the runtime or claim to prove supplier request idempotency. It checks the synthetic attempt and usage accounting path only.

## Pre-release procedure

1. Record the exact deployed application commit and migration ledger. Check that this checkout is that commit. Pause deployment changes for the drill window. Check the application database for active real jobs; any `queued` or `running` job stops this procedure. Keep the normal application and its database untouched. Run the following from the repository root with Node 22, Docker and `npm ci` already available. The guard URL must be a **read-only** connection to the application database. Do not print either URL.

   ```sh
   npm ci --ignore-scripts --no-audit --no-fund
   export BB_DRILL_EXPECTED_SHA="$(git rev-parse HEAD)"
   export BB_DRILL_GUARD_DATABASE_URL="<read-only application database URL>"
   umask 077
   timeout 420s bash deploy/m1/scripts/run-log-recovery-drill.sh > recovery-drill.tap 2>&1
   ```

   A local disposable rehearsal may use `BB_DRILL_LOCAL_ONLY=1` instead of the read-only guard. Never use that override to assert that the application database has no active jobs. The wrapper checks the checkout SHA, reads only the active-job count from the guard database, starts named disposable containers, migrates its own empty database, builds the required packages and runs one test. If the guard count is nonzero or cannot be read, stop without starting containers. Azurite binds only to `127.0.0.1:10000`; if that port is occupied, stop and investigate the conflicting service. The PostgreSQL port is assigned dynamically on loopback.

2. Inspect the exit status (`0` required), the `# tests 1`, `# pass 1`, `# fail 0`, `# skipped 0` TAP footer, and the `synthetic_79_recovery` phase records. Keep the private TAP file out of the repository. Retain a short, redacted summary with exact checkout SHA, job/event/outbox/receipt IDs, counts and status only. Do not publish connection strings, prompt or log bodies.

3. Confirm the wrapper removed both disposable containers. The cloned test database was dropped by the test helper; the wrapper's template database was removed with its container. Its Azurite object is deleted in `finally`, and the Azurite container is removed by the wrapper trap. The temporary NDJSON file and directory are removed in `finally`. If interrupted, first confirm both container names matching the drill invocation are stopped and removed. Do not delete similarly named containers from another run.

## Required reconciliation

| Phase | Expected evidence |
| --- | --- |
| Before fault | One queued parse job, one job event and its observability outbox row, zero terminal events. |
| During parse crash | One running job at attempt 1; the child process is killed after its synthetic `parse_evidence` checkpoint commits. Job and outbox IDs remain present. |
| After lease recovery | Same job ID at attempt 2, checkpoint retained; job remains running before its terminal transition. |
| During database fault | A trigger scoped to this synthetic job's terminal outbox insert terminates only the current PostgreSQL backend. The terminal transaction rolls back: job stays running, terminal count stays zero, outbox IDs stay unchanged and the evidence gate pauses. The trigger is removed in `finally`. |
| After database recovery | Operator resume appends an open gate event. The same claimed job completes once and a repeated completion is rejected. Job terminal count is one. |
| During sink outage | Unsafe mode on this drill's NDJSON file makes the real sink reject the batch. Pending outbox rows and `sink_unavailable` markers equal the job's observability rows; no delivery receipts. |
| After sink recovery | File mode is repaired. Each pending outbox ID has one delivery receipt and one unique NDJSON delivery key. A second forward pass delivers zero. No historical row is rewritten or deleted. |
| Usage check | One synthetic call-start event and two distinct source observations, including one exact retry, each have outbox and delivery receipts. They give one effective attempt with input 7, output 3, cached input 2 and reasoning output 1. These are synthetic counters, not supplier usage. |

## Failure and rollback

The wrapper sets an EXIT/INT/TERM cleanup trap and bounded timeouts: five package builds and migration at 180 seconds each, test at 120 seconds, outer operator command at 420 seconds. The test drops its scoped fault trigger in `finally`, repairs the file mode before replay, opens the gate after the scoped connection fault, and removes its Blob key and temporary sink in `finally`. If any assertion fails, the clone and containers are discarded; do not try to repair the failed clone or apply its SQL to the application database. Preserve the short failure summary and rerun from a new disposable environment after diagnosis. Since the application database is read-only to this kit, no application rollback is needed. If a real application gate is paused separately, use [log alert recovery](log-alert-recovery.md) and reconcile in-flight provider attempts before an authorized operator resumes it.

This is a local synthetic rehearsal suitable for execution on the pre-release host. The target environment's real job, supplier and external collector acceptance still needs a separate controlled review and evidence record.
