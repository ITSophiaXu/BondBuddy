-- #79/#35 ops scheduler: one row per scheduled task. A scheduler instance may run a task only
-- after winning the conditional UPDATE on this row (due and not leased), so two instances never
-- execute the same due task. Rows only carry scheduling state; outcomes of failed runs are
-- appended to bb_ops_alerts as scheduled_task_failed.
CREATE TABLE bb_ops_schedule (
 task text PRIMARY KEY CHECK (task ~ '^[a-z][a-z0-9_]{0,63}$'),
 next_due_at timestamptz NOT NULL DEFAULT now(),
 lease_token text CHECK (lease_token IS NULL OR lease_token ~ '^[A-Za-z0-9_-]{1,128}$'),
 lease_owner text CHECK (lease_owner IS NULL OR lease_owner ~ '^[A-Za-z0-9_-]{1,128}$'),
 lease_until timestamptz,
 last_started_at timestamptz,
 last_finished_at timestamptz,
 last_status text CHECK (last_status IS NULL OR last_status IN ('succeeded','failed')),
 last_error_code text CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
 runs bigint NOT NULL DEFAULT 0 CHECK (runs >= 0),
 failures bigint NOT NULL DEFAULT 0 CHECK (failures >= 0),
 CHECK ((lease_token IS NULL) = (lease_until IS NULL))
);

ALTER TABLE bb_ops_alerts DROP CONSTRAINT bb_ops_alerts_kind_check;
ALTER TABLE bb_ops_alerts ADD CONSTRAINT bb_ops_alerts_kind_check CHECK (kind IN (
 'log_sink_unavailable','log_backlog_stale','evidence_persist_failed','evidence_gate_paused','usage_conflict','retention_purge_failed',
 'worker_heartbeat_stale','queue_backlog_stale','error_rate_spike','trial_quota_exhausted',
 'scheduled_task_failed'));
