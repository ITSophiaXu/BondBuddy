# Log and job recovery drill (#79)

Two evidence levels are available. `run-log-recovery-drill.sh` exercises an isolated PostgreSQL 16/Azurite database and a private file sink; its recorded result in `docs/acceptance/79-recovery-drill-synthetic-2026-09-29.md` is a synthetic rehearsal. `deployed-recovery-drill.mjs` exercises the **already running** API, worker, ops scheduler, PostgreSQL and configured Blob service. Neither path calls an external model. Isolated usage records are synthetic; they do not establish supplier usage or balance.

## Existing deployment: prerequisites and exact invocation

Run from the checkout root with Node 22 and Docker Compose. Reserve a quiet window of at least eight minutes and freeze deployment changes. Use the exact 40-character deployed commit, existing private Compose env file, and full IDs of the running `api`, `worker`, `ops` and `postgres` containers. The script verifies IDs against Compose labels, image tags, `BB_RELEASE_SHA`, PostgreSQL 16, migrations through `0074`, API health, sink and origin. It fails closed on a mismatch. It never starts replacement PostgreSQL, Azurite, API or collector services. Do not derive the target from a hostname or put a database URL in shell history. It reads the database through `docker exec ... psql` in the **specified** PostgreSQL container. The private state file holds a temporary synthetic password and must stay local with mode `0600`.

```sh
cd <checkout-of-deployed-commit>
umask 077
export BB_DRILL_EXPECTED_SHA=<full-deployed-commit-sha>
export BB_DRILL_ENV_FILE=<absolute-path-to-existing-private-compose-env-file>
export BB_DRILL_BASE_URL=<existing-api-origin-or-local-reverse-proxy-url>
export BB_DRILL_ORIGIN=<configured-public-origin>
export BB_DRILL_API_ID=<full-docker-container-id>
export BB_DRILL_WORKER_ID=<full-docker-container-id>
export BB_DRILL_OPS_ID=<full-docker-container-id>
export BB_DRILL_POSTGRES_ID=<full-docker-container-id>
export BB_DRILL_STATE_FILE=<absolute-private-path-for-this-run.state.json>
export BB_DRILL_EVIDENCE_FILE=<absolute-private-path-for-this-run.evidence.ndjson>
node deploy/m1/scripts/deployed-recovery-drill.mjs preflight
timeout --signal=TERM --kill-after=30s 480s node deploy/m1/scripts/deployed-recovery-drill.mjs run
```

Obtain container IDs with the same Compose project and env file as the deployment; verify all four names and IDs before exporting them. The base URL must reach the existing API and allow registration from the configured origin. `preflight` is read-only apart from its local evidence file. It reports active job and external-call attempt IDs, refusing injection if another job is `queued`/`running`. Only exact job UUIDs saved by this invocation may be excluded after creation; user IDs are UUIDs and are never classified by a name prefix. A historical `paused/provider_reconcile` run with a failed, `unknown` usage attempt is left untouched and does not itself block the log or parse rehearsal. Newly active work during a fault window stops injection.

The original evidence gate state and sequence are recorded. An already paused gate is **never** opened by this script. If it prevents a particular API step, retain successful earlier phases and record the blocked remainder. The script does not change the gate or supplier usage rows.

## Fault phases and required checks

| Phase | Deployed component and expected evidence |
| --- | --- |
| D1 before/during | Pause only the named existing `ops` container. Register one synthetic account and project through the real API. Capture UUIDs and exact observability outbox IDs; pending count must rise while the collector is stopped. |
| D1 restore/replay | Unpause the same `ops` container. Its normal `log_forward` task drains the backlog to its configured `BB_LOG_SINK_FILE`; every scoped outbox ID must have one `ndjson_file` receipt and a unique `delivery_key`. Observe one more scheduler interval for duplicate receipts. No private sink or manual forwarder is used. |
| D2 before/during | Pause only the named deployed worker while a valid synthetic text upload creates a real parse job. A trigger on the exact material's parse snapshot adds an eight-second observation window. Unpause, observe `running`, recheck the activity guard, kill only that verified worker container once, then remove the trigger and restart the same service under its existing restart policy. |
| D2 restore | The normal deployed worker reclaims the expired lease. The same job ID reaches `succeeded`, attempts ≥2, with exactly one terminal job event. This runs the real parser. |
| D3 before/during | Queue a second synthetic material through the API with the worker paused. Install a uniquely named trigger on `bb_outbox`; it aborts only that job's first `material_parse.succeeded` insert. The transaction rolls back and the normal worker records `material_parse.retry_scheduled`; no first-attempt terminal event commits. |
| D3 restore | Drop the trigger, let the normal worker retry, and verify the same job reaches `succeeded` with attempts ≥2 and one terminal event. Preserve original gate state, especially `paused`. |

The evidence file contains only time, exact IDs, states, counts, image SHA, migration summary and delivery keys. It contains no cookies, connection strings, prompt content or log bodies. Keep it private while reviewing; commit only a short sanitized summary. Compare job event IDs, outbox IDs, receipt IDs and `delivery_key`s across before, during and after records. The `ndjson_file` receipt is the deployed collector's durable acknowledgment; also check the existing sink through normal operator tooling for the same keys without exporting body text.

## Recovery, timeout and cleanup

The outer timeout is 480 seconds; D1 drain has 90 seconds, D2 claim 30 seconds and lease recovery 180 seconds, D3 fault 60 seconds and recovery 120 seconds. The signal handler and `finally` restore only this run's paused containers, stopped worker and named trigger. A local `0600` state file is saved **before** each reversible mutation. After interruption or uncertain cleanup, run this against the same exact IDs, commit and private state file before another injection:

```sh
node deploy/m1/scripts/deployed-recovery-drill.mjs recover
```

`recover` removes only this run's trigger, unpauses only containers this run paused, starts only the named worker if this run stopped it, and closes only the exact synthetic project/account through the API. Deletion uses the supported soft-deletion flow; append-only job, audit, outbox and log evidence remains. It never broadly terminates database connections, retries historical runs or resumes an originally paused gate. Failed recovery is a stop condition: inspect private evidence and state, then repeat `recover` after correcting the cause. Remove the private state after successful recovery and evidence capture. Do not delete historical logs or service volumes.

The isolated script remains available for regression checks and synthetic usage deduplication, but running it on a deployment host does **not** verify deployed services. Target-environment acceptance requires independent execution of the existing-deployment mode after release installation, with exact deployed SHA and per-phase evidence; this document and local rehearsal alone do not complete that acceptance.
