-- Bounded private-container reconciliation. The cursor is operational state;
-- deletion receipts are immutable and retain only a key digest.
ALTER TABLE bb_ops_alerts DROP CONSTRAINT bb_ops_alerts_kind_check;
ALTER TABLE bb_ops_alerts ADD CONSTRAINT bb_ops_alerts_kind_check CHECK (kind IN (
 'log_sink_unavailable','log_backlog_stale','evidence_persist_failed','evidence_gate_paused','usage_conflict','retention_purge_failed',
 'worker_heartbeat_stale','queue_backlog_stale','error_rate_spike','trial_quota_exhausted','scheduled_task_failed',
 'library_sync_failed','library_source_stale','storage_orphan_candidates'));
CREATE TABLE bb_storage_inventory_cursors (
 prefix text PRIMARY KEY CHECK (prefix IN ('users/','parse-cache/','log-archive/')),
 continuation text,
 updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE bb_storage_inventory_deletions (
 id text PRIMARY KEY,
 key_sha256 char(64) NOT NULL UNIQUE CHECK (key_sha256 ~ '^[a-f0-9]{64}$'),
 kind text NOT NULL CHECK (kind IN ('snapshot')),
 byte_size bigint NOT NULL CHECK (byte_size >= 0),
 object_last_modified timestamptz NOT NULL,
 policy_version text NOT NULL,
 deleted_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER bb_storage_inventory_deletion_immutable BEFORE UPDATE OR DELETE ON bb_storage_inventory_deletions
 FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();

-- Committed before Blob IO, so a crash after delete still leaves an audit lead.
CREATE TABLE bb_storage_inventory_delete_attempts (
 id text PRIMARY KEY,
 key_sha256 char(64) NOT NULL CHECK (key_sha256 ~ '^[a-f0-9]{64}$'),
 etag_sha256 char(64) NOT NULL CHECK (etag_sha256 ~ '^[a-f0-9]{64}$'),
 byte_size bigint NOT NULL CHECK (byte_size >= 0),
 object_last_modified timestamptz NOT NULL,
 attempted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bb_storage_inventory_delete_attempts_key ON bb_storage_inventory_delete_attempts(key_sha256,attempted_at);
CREATE TRIGGER bb_storage_inventory_delete_attempt_immutable BEFORE UPDATE OR DELETE ON bb_storage_inventory_delete_attempts
 FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();
