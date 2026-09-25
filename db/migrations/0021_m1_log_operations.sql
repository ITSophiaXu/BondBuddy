-- #79 operations: operator grants, durable log forwarding, evidence gate, alerts,
-- append-only corrections and retention tombstones. Raw evidence rows from 0005/0007/0019
-- stay immutable; everything here only appends or points at them.

-- Deny by default: a user without an active grant has no operator surface at all.
-- log_reader sees redacted metadata/metrics; prompt_viewer is a separate grant for plaintext.
CREATE TABLE bb_operator_grants (
 id text PRIMARY KEY,
 user_id text NOT NULL REFERENCES bb_users(id),
 role text NOT NULL CHECK (role IN ('log_reader','prompt_viewer')),
 granted_by text NOT NULL,
 reason_code text NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9_]{0,63}$'),
 granted_at timestamptz NOT NULL DEFAULT now(),
 revoked_at timestamptz,
 CHECK (revoked_at IS NULL OR revoked_at>=granted_at)
);
CREATE UNIQUE INDEX bb_operator_grant_active_idx ON bb_operator_grants(user_id,role) WHERE revoked_at IS NULL;
-- Only revocation may change a grant, and only once.
CREATE FUNCTION bb_guard_operator_grant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'operator grants are retained' USING ERRCODE='23514'; END IF;
 IF OLD.revoked_at IS NOT NULL OR NEW.id<>OLD.id OR NEW.user_id<>OLD.user_id OR NEW.role<>OLD.role
    OR NEW.granted_by<>OLD.granted_by OR NEW.reason_code<>OLD.reason_code OR NEW.granted_at<>OLD.granted_at
 THEN RAISE EXCEPTION 'operator grant is immutable except one revocation' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_operator_grant_guard BEFORE UPDATE OR DELETE ON bb_operator_grants
  FOR EACH ROW EXECUTE FUNCTION bb_guard_operator_grant();

-- Access audit now records the actor role and the requested plaintext kind.
ALTER TABLE bb_log_access_audit ADD COLUMN actor_role text CHECK (actor_role IS NULL OR actor_role IN ('log_reader','prompt_viewer','owner_service'));
ALTER TABLE bb_log_access_audit ADD COLUMN target_ref text CHECK (target_ref IS NULL OR target_ref ~ '^[A-Za-z0-9_-]{1,128}$');
ALTER TABLE bb_log_access_audit ADD COLUMN reason_code text CHECK (reason_code IS NULL OR reason_code ~ '^[a-z][a-z0-9_]{0,63}$');
CREATE INDEX bb_log_access_actor_idx ON bb_log_access_audit(actor_id,accessed_at DESC);

-- Forwarding: one row per (outbox event, sink). The delivery key is what the sink dedupes on,
-- so a crash after the sink accepted but before this insert only re-sends the same key.
ALTER TABLE bb_outbox ADD COLUMN last_delivery_error text
  CHECK (last_delivery_error IS NULL OR last_delivery_error ~ '^[a-z][a-z0-9_]{0,63}$');
ALTER TABLE bb_outbox ADD COLUMN next_attempt_at timestamptz;
CREATE INDEX bb_outbox_observability_pending_idx ON bb_outbox(created_at,id)
  WHERE delivered_at IS NULL AND aggregate_type='observability';
CREATE TABLE bb_log_deliveries (
 outbox_id text NOT NULL REFERENCES bb_outbox(id),
 sink text NOT NULL CHECK (sink ~ '^[a-z][a-z0-9_]{0,63}$'),
 delivery_key char(64) NOT NULL UNIQUE CHECK (delivery_key ~ '^[a-f0-9]{64}$'),
 delivered_at timestamptz NOT NULL DEFAULT now(),
 attempts integer NOT NULL CHECK (attempts>0),
 PRIMARY KEY (outbox_id,sink)
);
CREATE TRIGGER bb_log_delivery_immutable BEFORE UPDATE OR DELETE ON bb_log_deliveries
  FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();

-- Operational alerts are append-only; acknowledgements are separate rows.
-- dedupe_key keeps one open alert per condition window instead of one per poll.
CREATE TABLE bb_ops_alerts (
 id text PRIMARY KEY,
 kind text NOT NULL CHECK (kind IN ('log_sink_unavailable','log_backlog_stale','evidence_persist_failed','evidence_gate_paused','usage_conflict','retention_purge_failed')),
 severity text NOT NULL CHECK (severity IN ('warning','critical')),
 dedupe_key text NOT NULL UNIQUE CHECK (dedupe_key ~ '^[A-Za-z0-9:_-]{1,200}$'),
 detail jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bb_ops_alerts_created_idx ON bb_ops_alerts(created_at DESC,id);
CREATE TRIGGER bb_ops_alert_immutable BEFORE UPDATE OR DELETE ON bb_ops_alerts
  FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();
CREATE TABLE bb_ops_alert_acks (
 id text PRIMARY KEY,
 alert_id text NOT NULL UNIQUE REFERENCES bb_ops_alerts(id),
 actor_id text NOT NULL,
 reason_code text NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9_]{0,63}$'),
 acked_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER bb_ops_alert_ack_immutable BEFORE UPDATE OR DELETE ON bb_ops_alert_acks
  FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();

-- Evidence gate: the latest row decides whether NEW external model calls may be recorded.
-- No row means open. Pausing and resuming both append.
CREATE TABLE bb_evidence_gate_events (
 id text PRIMARY KEY,
 seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 state text NOT NULL CHECK (state IN ('open','paused')),
 reason_code text NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9_]{0,63}$'),
 actor_type text NOT NULL CHECK (actor_type IN ('system','operator')),
 actor_id text,
 alert_id text REFERENCES bb_ops_alerts(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK ((actor_type='operator') = (actor_id IS NOT NULL))
);
CREATE TRIGGER bb_evidence_gate_event_immutable BEFORE UPDATE OR DELETE ON bb_evidence_gate_events
  FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();

-- Usage corrections: an operator/reconciler resolves a conflicting or unknown attempt by
-- appending a decision. Raw observations are never updated; the latest correction wins.
CREATE TABLE bb_usage_corrections (
 id text PRIMARY KEY,
 seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 owner_user_id text NOT NULL,
 attempt_id text NOT NULL,
 chosen_observation_id text REFERENCES bb_usage_observations(id),
 usage_status text NOT NULL CHECK (usage_status IN ('measured','unknown')),
 input_tokens integer, output_tokens integer, cached_input_tokens integer, reasoning_tokens integer,
 reason_code text NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9_]{0,63}$'),
 actor_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (owner_user_id,attempt_id) REFERENCES bb_model_call_attempts(owner_user_id,id),
 CHECK ((usage_status='measured' AND input_tokens>=0 AND output_tokens>=0
         AND (cached_input_tokens IS NULL OR (cached_input_tokens>=0 AND cached_input_tokens<=input_tokens))
         AND (reasoning_tokens IS NULL OR (reasoning_tokens>=0 AND reasoning_tokens<=output_tokens)))
     OR (usage_status='unknown' AND input_tokens IS NULL AND output_tokens IS NULL AND cached_input_tokens IS NULL AND reasoning_tokens IS NULL AND chosen_observation_id IS NULL))
);
CREATE INDEX bb_usage_corrections_attempt_idx ON bb_usage_corrections(attempt_id,seq DESC);
CREATE TRIGGER bb_usage_correction_immutable BEFORE UPDATE OR DELETE ON bb_usage_corrections
  FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();
-- A chosen observation must belong to the same attempt and carry the same counts.
CREATE FUNCTION bb_guard_usage_correction() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.chosen_observation_id IS NOT NULL AND NOT EXISTS (
   SELECT 1 FROM bb_usage_observations u WHERE u.id=NEW.chosen_observation_id AND u.attempt_id=NEW.attempt_id
     AND u.usage_status='measured' AND u.input_tokens=NEW.input_tokens AND u.output_tokens=NEW.output_tokens
     AND u.cached_input_tokens IS NOT DISTINCT FROM NEW.cached_input_tokens AND u.reasoning_tokens IS NOT DISTINCT FROM NEW.reasoning_tokens)
 THEN RAISE EXCEPTION 'correction must match the chosen observation of the same attempt' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_usage_correction_guard BEFORE INSERT ON bb_usage_corrections
  FOR EACH ROW EXECUTE FUNCTION bb_guard_usage_correction();

-- Effective per-attempt usage: latest correction, otherwise the unresolved 0005 view.
-- One row per supplier attempt, so gateway/framework duplicates are counted once.
CREATE VIEW bb_call_usage_effective AS
SELECT u.attempt_id,u.owner_user_id,u.job_id,u.logical_call_id,u.attempt_no,u.call_status,
 COALESCE(c.usage_status,u.usage_status) usage_status,
 CASE WHEN c.id IS NOT NULL THEN c.input_tokens ELSE u.input_tokens END input_tokens,
 CASE WHEN c.id IS NOT NULL THEN c.output_tokens ELSE u.output_tokens END output_tokens,
 CASE WHEN c.id IS NOT NULL THEN c.cached_input_tokens ELSE u.cached_input_tokens END cached_input_tokens,
 CASE WHEN c.id IS NOT NULL THEN c.reasoning_tokens ELSE u.reasoning_tokens END reasoning_tokens,
 u.conflicting_measurements, c.id correction_id
FROM bb_call_usage u
LEFT JOIN LATERAL (SELECT * FROM bb_usage_corrections c WHERE c.attempt_id=u.attempt_id ORDER BY c.seq DESC LIMIT 1) c ON true;

-- Retention: prompt/model content bytes are purged from private Blob and tombstoned here.
-- The snapshot/result metadata rows (hash, versions, usage, attempts) remain for accounting.
CREATE TABLE bb_log_content_tombstones (
 id text PRIMARY KEY,
 owner_user_id text NOT NULL,
 content_kind text NOT NULL CHECK (content_kind IN ('prompt_snapshot','provider_result')),
 content_id text NOT NULL,
 object_key text NOT NULL UNIQUE,
 reason text NOT NULL CHECK (reason IN ('retention_expired','user_deleted')),
 policy_version text NOT NULL CHECK (policy_version ~ '^[A-Za-z0-9._-]{1,64}$'),
 purged_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (content_kind,content_id),
 CHECK (object_key LIKE 'users/' || owner_user_id || '/%')
);
CREATE INDEX bb_log_content_tombstones_owner_idx ON bb_log_content_tombstones(owner_user_id,purged_at DESC);
CREATE TRIGGER bb_log_content_tombstone_immutable BEFORE UPDATE OR DELETE ON bb_log_content_tombstones
  FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();

CREATE INDEX bb_snapshot_refs_created_idx ON bb_snapshot_refs(created_at,id);
CREATE INDEX bb_provider_result_created_idx ON bb_provider_result_refs(created_at,id);
CREATE INDEX bb_observability_events_created_idx ON bb_observability_events(created_at,id);
CREATE INDEX bb_observability_events_job_idx ON bb_observability_events(job_id,created_at,id);
