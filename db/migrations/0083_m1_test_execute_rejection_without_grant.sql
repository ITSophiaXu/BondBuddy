-- An automatic working-draft request may be rejected before its test grant is issued.
-- Preserve its channel and durable rejection key without granting execution rights.
ALTER TABLE bb_jobs DROP CONSTRAINT bb_job_test_channel_check;
ALTER TABLE bb_jobs ADD CONSTRAINT bb_job_test_channel_check CHECK (
  (channel='production' AND test_grant_id IS NULL) OR
  (channel='non_production_test' AND test_grant_id IS NOT NULL) OR
  (channel='non_production_test' AND test_grant_id IS NULL AND run_id IS NULL
    AND state='rejected' AND subtype IN ('execute_rejected','execute_schema_rejected'))
);
