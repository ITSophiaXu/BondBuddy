# M1 trial operations (#35)

This runbook covers admission capacity, short-window abuse limits, the emergency kill switch, usage accounting and health probes. Daily usage limits were retired by the [2026-10-30 product decision](../product-decisions/2026-10-30-no-daily-limits.md). Credit billing follows the separate current billing policies. Code: `apps/api/src/trial-guard.ts`; contracts: `packages/contracts/src/trial-guard.ts`. Regression evidence uses synthetic data and real isolated PostgreSQL/Azurite, without a real provider.

## Configuration

Active limits apply to API and worker. Zero blocks actions for active capacity/rate limits. The four retired daily settings are ignored even if present; their compatible admin fields always return 0 (unlimited). Deploy the updated API and all execution workers together. Previously daily-paused tasks resume through the existing sweep subject to credits and other current checks.

| Variable | Default | Meaning |
|---|---|---|
| `BB_TRIAL_GUARD` | `on` when `NODE_ENV=production`, otherwise `off` | `on` or `off`. When it is off, numeric limits are skipped; overrides and the kill switch still apply |
| `BB_TRIAL_DAY_TIME_ZONE` | `Asia/Shanghai` | Time zone for daily usage reporting only |
| `BB_TRIAL_ACTIVE_RUNS_PER_USER` | 2 | Runs in `preparing/queued/running/validating/delivering`. Paused runs and runs awaiting input do not count |
| `BB_TRIAL_RUNS_PER_USER_PER_DAY` | retired | Ignored; no daily limit |
| `BB_TRIAL_UPLOAD_BYTES_PER_USER_PER_DAY` | retired | Ignored; no daily limit |
| `BB_TRIAL_MODEL_TOKENS_PER_USER_PER_DAY` | retired | Ignored; no daily limit |
| `BB_TRIAL_UNKNOWN_USAGE_TOKENS_PER_ATTEMPT` | 200 000 | Conservative reporting estimate for unmeasured usage; never a charge or admission limit |
| `BB_TRIAL_GLOBAL_ACTIVE_RUNS` | 4 | Active runs across all users. An allow override does not bypass it |
| `BB_TRIAL_PROJECTS_PER_USER_PER_DAY` | retired | Ignored; no daily limit |
| `BB_TRIAL_PROJECTS_PER_SOURCE_PER_HOUR` | 120 | Project creations per source address, all accounts together |
| `BB_TRIAL_UPLOADS_PER_USER_PER_HOUR` | 120 | Upload sessions per account |
| `BB_TRIAL_UPLOADS_PER_SOURCE_PER_HOUR` | 1200 | Upload sessions per source address |
| `BB_TRIAL_KILL_SWITCH` | unset | `1` engages the kill switch from configuration (restart needed) |
| `BB_TRIAL_SOURCE_SALT` | empty | Key mixed into the source hash. Set a random value per environment and keep it in the target environment only |
| `BB_READY_WORKER_HEARTBEAT_MAX_AGE_SECONDS` | 90 | Heartbeat age above which readiness reports `stale` and the stale-worker alert fires |
| `BB_READY_TIMEOUT_MS` | 2000 | Timeout for each readiness check |
| `BB_WORKER_HEARTBEAT_MS` | 10000 | Worker heartbeat interval |
| `BB_ALERT_QUEUE_BACKLOG_SECONDS` | 600 | Age of the oldest queued job that raises `queue_backlog_stale` |
| `BB_ALERT_ERROR_WINDOW_SECONDS`, `BB_ALERT_ERROR_RATE`, `BB_ALERT_ERROR_MIN_SAMPLE` | 900, 0.5, 5 | `error_rate_spike` fires when failed / (succeeded + failed) jobs in the window reach the rate, with at least the minimum sample |

An invalid active setting stops the process at start-up. Retired daily settings are not parsed. The defaults are engineering placeholders for 2 vCPU / 3 GB hosts. Size them from the capacity records, not from these numbers.

## Where limits are enforced

| Point | Checks | Error |
|---|---|---|
| `POST /api/v1/projects` | deny override; projects per source per hour | 403 `TRIAL_ACCESS_DENIED`, 429 `TRIAL_QUOTA_EXCEEDED` |
| `POST /api/v1/projects/{id}/materials/uploads` | deny; uploads per account/hour; uploads per source/hour | same |
| `POST /api/v1/runs/execute` | kill switch; deny; global active runs; active runs for the account | 503 `MODEL_CALLS_SUSPENDED`, 403, 429 |
| Worker, before each model call (`recordPotentialCall`) | kill switch; deny | same codes. No call intent is written, so no supplier call is made |

- A replay of the same `execution_request_id` returns the existing run before any quota check, so retrying never trips a limit.
- The message names the limit (for example `Trial limit reached: active_runs_per_user`). `TRIAL_LIMIT_KINDS` also retains daily kinds for historical records; current servers never emit daily-limit rejections.
- Every rejection is written through #79 as a `rejected` operation (`bb_operations` plus `operation.rejected`) with the error code. Quota rejections also raise one `trial_quota_exhausted` alert per limit and account per hour. The global cap raises one per hour for scope `global`.
- Admission is serialised per account (advisory lock), and run submission is serialised globally, so concurrent submits cannot overshoot a cap.

### Token counting

The count uses the day's rows in `bb_model_call_attempts` joined with `bb_call_usage_effective` (#79):

- `measured`: input + output tokens. Cached input and reasoning tokens are subsets and are not added again.
- `unknown`, `pending` or `conflict`: counted as `BB_TRIAL_UNKNOWN_USAGE_TOKENS_PER_ATTEMPT`, never as 0.
- `confirmed_not_sent`: 0.

After an operator resolves an attempt with a usage correction (#79), the corrected value replaces the reporting estimate. Daily aggregates never restrict further model calls or task submissions.

### Shared company addresses

The per-source limits are deliberately loose. They count all accounts behind one address, so they stop one source from creating accounts and projects in bulk, while ordinary colleagues behind the same office address stay under the limit. The tight limits are per account. If a pilot company still hits a source limit, allow-list its accounts. Do not raise the global setting. Only a keyed SHA-256 of the trusted remote address is stored (`bb_trial_admissions.source_hash`), and the address itself is never stored. The remote address comes from Fastify's trusted proxy handling (`BB_TRUSTED_PROXY_CIDR`), so a client-supplied forwarded header is not trusted.

## Operator actions

Operators use the #79 grants. Reads need `log_reader` and writes need `log_operator`. Without the exact role, every route returns the owner-safe 404. Each call writes a `bb_log_access_audit` row.

- `GET /api/v1/admin/trial/status` shows the effective limits, the kill switch, the global active runs, live worker heartbeats and the age of the oldest queued job.
- `POST /api/v1/admin/trial/overrides {user_id, effect: allow|deny, reason_code, expires_at?}` appends an override. The latest active, unexpired override for a user wins. `deny` blocks project creation, uploads, runs and model calls for the account. `allow` exempts the account from the per-account and per-source limits and the per-user quotas, but not from the global cap or the kill switch.
- `POST /api/v1/admin/trial/overrides/{id}/revoke {reason_code}` revokes an override once. A second revoke returns 409. Overrides are never deleted. `GET /api/v1/admin/trial/overrides` lists the active ones.
- `POST /api/v1/admin/trial/kill-switch {state: engaged|released, reason_code}` controls the emergency stop. While it is engaged, `runs/execute` returns 503 `MODEL_CALLS_SUSPENDED` and workers refuse new call intents. Runs already inside a supplier call finish that call; their next call is refused. Setting the switch to the state it is already in returns 409. The rows are append-only. `BB_TRIAL_KILL_SWITCH=1` engages the stop independently, and only a configuration change releases that one.

The kill switch is separate from the #79 evidence gate. The gate pauses automatically when evidence cannot be persisted and is resumed through `POST /admin/evidence-gate/resume`. The kill switch is an operator decision, for example during a supplier incident, a cost spike or suspected abuse.

## Platform cost ledger

`bb_platform_cost_ledger` (a view, so it cannot drift from the evidence) has one row per supplier attempt: owner, job, run, model, call status, effective usage, adapter duration and `pricing_status='unknown'`. #16 decided that the supplier rate is unconfirmed, so no amount is derived. The API returns `cost_amount: null`, never 0.

- `GET /api/v1/admin/trial/cost-ledger?user_id=&from=&to=&cursor=&limit=` lists the rows oldest first, keyset-paginated (limit ≤ 500). Each row has `conservative_tokens`, an accounting estimate with no admission cap.
- `GET /api/v1/admin/trial/usage?from=YYYY-MM-DD&to=YYYY-MM-DD&user_id=` returns daily aggregates in the trial time zone, per user and in total. The range is at most 92 days, and the default is today. Each row has runs created, runs finished with their summed duration, attempts, measured and unresolved attempts, summed model-call duration, measured token breakdown, conservative tokens, upload bytes and `pricing_status: unknown`.

Use these for the capacity, time and cost records in #35. Once a rate is confirmed, compute cost outside the ledger from measured tokens and record the rate version. Do not back-fill amounts into these rows.

## Health and readiness

- `GET /api/v1/health` is liveness only: `{status:'ok', service:'bondbuddy-m1-api'}`. Use it for the container restart probe. The older `/health` stays as it was.
- `GET /api/v1/ready` checks the database (`SELECT 1`), private Blob (a `exists` probe), the evidence gate (`paused` counts as not ready) and the newest live worker heartbeat (`missing` or `stale` count as not ready). It returns 200 when every check is `ok`, otherwise 503 with the same body. The body carries check states and the heartbeat age only, with no error text, hosts or ports. Use it to gate Nginx or the deploy smoke test, not the API restart: a stale worker should not restart the API.
- Workers upsert `bb_worker_heartbeats` every `BB_WORKER_HEARTBEAT_MS` and set `stopped_at` on graceful shutdown. A crashed worker's row simply ages out.

## Alerts

Run `npm run trial:health -w @bondbuddy/api` (or `node apps/api/dist/trial-guard.js health` with `DATABASE_URL` set) manually if needed. In the Compose stack the `ops` scheduler runs it every 5 minutes and the heartbeat check every minute (see `m1-deploy.md`, Ops scheduler). Each pass appends deduplicated rows to the #79 `bb_ops_alerts` table, which `GET /api/v1/admin/alerts` reads:

| Kind | Severity | Fires when | First response |
|---|---|---|---|
| `worker_heartbeat_stale` | critical | No live heartbeat, or the newest is older than the threshold (`age_seconds=-1` means none) | Check the worker container and its logs, then restart it. Jobs resume from their leases and checkpoints |
| `queue_backlog_stale` | warning | The oldest queued job waited longer than the threshold | Check the worker count and concurrency, the global cap and whether the kill switch is engaged |
| `error_rate_spike` | critical | The failed share of jobs finished in the window reached the rate | Look at `GET /admin/metrics` and job timelines by `error_code`. Consider engaging the kill switch |
| `trial_quota_exhausted` | warning | A user hit a quota, or the global cap is full | Normal at low volume. Repeated alerts for one account suggest abuse (deny) or a pilot that needs an allow override. A full global cap suggests capacity is short |

This change does not send alerts to an external channel (email or IM). That delivery, reading from `bb_ops_alerts`, is still open and belongs to the deployment work.
