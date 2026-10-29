-- Extend the existing operator alert vocabulary without rewriting historical events.
ALTER TABLE bb_ops_alerts DROP CONSTRAINT bb_ops_alerts_kind_check;
ALTER TABLE bb_ops_alerts ADD CONSTRAINT bb_ops_alerts_kind_check CHECK (kind IN (
 'log_sink_unavailable','log_backlog_stale','evidence_persist_failed','evidence_gate_paused','usage_conflict','retention_purge_failed',
 'worker_heartbeat_stale','queue_backlog_stale','error_rate_spike','trial_quota_exhausted','scheduled_task_failed',
 'library_sync_failed','library_source_stale','storage_orphan_candidates','payment_reconciliation_unresolved'));
