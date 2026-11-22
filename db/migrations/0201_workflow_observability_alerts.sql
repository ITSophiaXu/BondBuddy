-- Add the six workflow operational alerts while retaining every existing kind.
DO $$ DECLARE previous_expression text; BEGIN
 SELECT pg_get_expr(conbin,conrelid) INTO STRICT previous_expression FROM pg_constraint
 WHERE conrelid='bb_ops_alerts'::regclass AND conname='bb_ops_alerts_kind_check';
 ALTER TABLE bb_ops_alerts DROP CONSTRAINT bb_ops_alerts_kind_check;
 EXECUTE format('ALTER TABLE bb_ops_alerts ADD CONSTRAINT bb_ops_alerts_kind_check CHECK ((%s) OR kind IN (''spool_pending_stale'',''spool_low_disk'',''provider_due_scan_stale'',''workflow_handoff_stale'',''workflow_chapter_budget_exhausted'',''workflow_usage_unknown''))',previous_expression);
END $$;
