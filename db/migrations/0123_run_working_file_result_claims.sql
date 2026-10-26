-- A producer may have several immutable result candidates. Each exact result
-- is a separate retention claim, alongside the original pre-write claim.
-- Preserve all existing rows and timestamps; do not rewrite 0122 history.
DROP INDEX bb_run_working_source_identity;
CREATE UNIQUE INDEX bb_run_working_source_identity
  ON bb_run_working_sources(object_key,job_id,execution_version,source_kind,
    (coalesce(attempt_id,'')),result_schema_version,(coalesce(discovered_result_id,'')));

COMMENT ON INDEX bb_run_working_source_identity IS
  'One physical object may retain the pre-write producer claim and each exact immutable result claim, including conflicting candidates of one attempt.';
