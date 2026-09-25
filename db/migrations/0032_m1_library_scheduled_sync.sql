-- #78 scheduled library sync on the #79/#35 ops scheduler (0028). Each enabled public-disclosure source
-- row carries its own cadence; the scheduler's library_sync task claims a due source with the conditional
-- UPDATE on sync_lease_until (so two scheduler instances never enqueue the same source twice) and then
-- drives the existing bb_jobs library pipeline, which keeps the cursor, dedupe and resume semantics.
ALTER TABLE bb_library_sources
  ADD COLUMN sync_interval_seconds integer NOT NULL DEFAULT 86400 CHECK (sync_interval_seconds BETWEEN 300 AND 31536000),
  ADD COLUMN next_sync_due_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN sync_lease_owner text CHECK (sync_lease_owner IS NULL OR sync_lease_owner ~ '^[A-Za-z0-9_-]{1,128}$'),
  ADD COLUMN sync_lease_until timestamptz,
  ADD COLUMN consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  ADD CONSTRAINT bb_library_sources_sync_lease_check CHECK ((sync_lease_owner IS NULL) = (sync_lease_until IS NULL));
CREATE INDEX bb_library_sources_due_idx ON bb_library_sources(next_sync_due_at) WHERE enabled AND kind='public_disclosure';

ALTER TABLE bb_ops_alerts DROP CONSTRAINT bb_ops_alerts_kind_check;
ALTER TABLE bb_ops_alerts ADD CONSTRAINT bb_ops_alerts_kind_check CHECK (kind IN (
 'log_sink_unavailable','log_backlog_stale','evidence_persist_failed','evidence_gate_paused','usage_conflict','retention_purge_failed',
 'worker_heartbeat_stale','queue_backlog_stale','error_rate_spike','trial_quota_exhausted',
 'scheduled_task_failed','library_source_stale','library_sync_failed'));
