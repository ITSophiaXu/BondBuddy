-- Preserve the accepted singleton response separately from later status reads.
-- Existing operations have no fabricated acceptance and remain fail-closed.
ALTER TABLE bb_execution_cloud_operations ADD COLUMN run_acceptance jsonb;
