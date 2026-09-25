-- #35 controlled trial guard: abuse-limit admissions, operator allow/deny overrides, an
-- operator kill switch, worker heartbeats, trial alert kinds and the per-attempt platform
-- cost ledger. Limits themselves are server configuration (BB_TRIAL_*), not rows.

-- Admissions counted for per-account and per-source limits. The source is a keyed hash of
-- the trusted remote address, never the address itself. Rejected requests are not admitted.
CREATE TABLE bb_trial_admissions (
 id text PRIMARY KEY,
 owner_user_id text NOT NULL,
 kind text NOT NULL CHECK (kind IN ('project_create','upload_create','run_submit')),
 source_hash char(64) CHECK (source_hash IS NULL OR source_hash ~ '^[a-f0-9]{64}$'),
 byte_size bigint NOT NULL DEFAULT 0 CHECK (byte_size>=0),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bb_trial_admissions_owner_idx ON bb_trial_admissions(owner_user_id,kind,created_at DESC);
CREATE INDEX bb_trial_admissions_source_idx ON bb_trial_admissions(source_hash,kind,created_at DESC) WHERE source_hash IS NOT NULL;
CREATE TRIGGER bb_trial_admission_immutable BEFORE UPDATE OR DELETE ON bb_trial_admissions
  FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();

-- Operator allow/deny overrides (written by log_operator). The latest active, unexpired row
-- for a user wins. Like grants, the only permitted change is a single revocation.
CREATE TABLE bb_trial_overrides (
 id text PRIMARY KEY,
 seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 user_id text NOT NULL REFERENCES bb_users(id),
 effect text NOT NULL CHECK (effect IN ('allow','deny')),
 reason_code text NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9_]{0,63}$'),
 actor_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz,
 revoked_at timestamptz,
 revoked_by text,
 revoke_reason_code text CHECK (revoke_reason_code IS NULL OR revoke_reason_code ~ '^[a-z][a-z0-9_]{0,63}$'),
 CHECK (expires_at IS NULL OR expires_at>created_at),
 CHECK ((revoked_at IS NULL) = (revoked_by IS NULL) AND (revoked_at IS NULL) = (revoke_reason_code IS NULL))
);
CREATE INDEX bb_trial_overrides_user_idx ON bb_trial_overrides(user_id,seq DESC);
CREATE FUNCTION bb_guard_trial_override() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'trial overrides are retained' USING ERRCODE='23514'; END IF;
 IF OLD.revoked_at IS NOT NULL OR NEW.id<>OLD.id OR NEW.seq<>OLD.seq OR NEW.user_id<>OLD.user_id OR NEW.effect<>OLD.effect
    OR NEW.reason_code<>OLD.reason_code OR NEW.actor_id<>OLD.actor_id OR NEW.created_at<>OLD.created_at
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
 THEN RAISE EXCEPTION 'trial override is immutable except one revocation' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_trial_override_guard BEFORE UPDATE OR DELETE ON bb_trial_overrides
  FOR EACH ROW EXECUTE FUNCTION bb_guard_trial_override();

-- Operator kill switch for new model work. Append-only; the latest row decides; no row means
-- released. The BB_TRIAL_KILL_SWITCH=1 configuration engages it independently of this table.
CREATE TABLE bb_trial_kill_switch_events (
 id text PRIMARY KEY,
 seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 state text NOT NULL CHECK (state IN ('engaged','released')),
 reason_code text NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9_]{0,63}$'),
 actor_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER bb_trial_kill_switch_immutable BEFORE UPDATE OR DELETE ON bb_trial_kill_switch_events
  FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();

-- One row per worker process, upserted on each heartbeat. Readiness and the stale-worker
-- alert read last_seen_at; rows of stopped workers simply age out.
CREATE TABLE bb_worker_heartbeats (
 worker_id text PRIMARY KEY CHECK (worker_id ~ '^[A-Za-z0-9_-]{1,128}$'),
 started_at timestamptz NOT NULL,
 last_seen_at timestamptz NOT NULL DEFAULT now(),
 kinds text[] NOT NULL CHECK (kinds <@ ARRAY['run','parse']::text[] AND cardinality(kinds)>0),
 concurrency integer NOT NULL CHECK (concurrency BETWEEN 1 AND 16),
 stopped_at timestamptz
);
CREATE INDEX bb_worker_heartbeats_seen_idx ON bb_worker_heartbeats(last_seen_at DESC);

-- Trial alert kinds join the #79 append-only alerts table.
ALTER TABLE bb_ops_alerts DROP CONSTRAINT bb_ops_alerts_kind_check;
ALTER TABLE bb_ops_alerts ADD CONSTRAINT bb_ops_alerts_kind_check CHECK (kind IN (
 'log_sink_unavailable','log_backlog_stale','evidence_persist_failed','evidence_gate_paused','usage_conflict','retention_purge_failed',
 'worker_heartbeat_stale','queue_backlog_stale','error_rate_spike','trial_quota_exhausted'));

CREATE INDEX bb_model_call_attempts_owner_created_idx ON bb_model_call_attempts(owner_user_id,created_at);
CREATE INDEX bb_runs_owner_created_idx ON bb_runs(owner_user_id,created_at);
CREATE INDEX bb_runs_active_idx ON bb_runs(owner_user_id) WHERE state IN ('preparing','queued','running','validating','delivering');

-- Platform cost ledger: one record per supplier attempt. The rate is unconfirmed (#16), so
-- pricing_status is always 'unknown' and no amount is derived. Unresolved usage keeps its
-- status; it is never shown as zero tokens.
CREATE VIEW bb_platform_cost_ledger AS
SELECT a.id attempt_id,a.owner_user_id,a.job_id,j.run_id,a.logical_call_id,a.attempt_no,a.model_id,a.status call_status,
 e.usage_status,e.input_tokens,e.output_tokens,e.cached_input_tokens,e.reasoning_tokens,
 rt.duration_ms,'unknown'::text pricing_status,a.created_at
FROM bb_model_call_attempts a
JOIN bb_jobs j ON j.owner_user_id=a.owner_user_id AND j.id=a.job_id
JOIN bb_call_usage_effective e ON e.attempt_id=a.id
LEFT JOIN bb_model_call_attempt_runtime rt ON rt.attempt_id=a.id;
