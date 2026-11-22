-- Bounded, immutable substage evidence. Never store exception messages or result bytes.
CREATE TABLE bb_model_result_failure_diagnostics (
 id text PRIMARY KEY, attempt_id text NOT NULL REFERENCES bb_model_call_attempts(id),
 owner_user_id text NOT NULL, project_id text NOT NULL, run_id text NOT NULL,
 job_id text NOT NULL, logical_call_id text NOT NULL, attempt_no integer NOT NULL,
 substage text NOT NULL CHECK(substage IN ('collect','envelope','serialize','validate','object_write','object_verify','reference_record')),
 error_class text NOT NULL CHECK(error_class IN ('output_validation','serialization','storage_io','storage_integrity','unknown')),
 error_code text NOT NULL CHECK(error_code IN ('MODEL_RESULT_STORE_FAILED','MODEL_OUTPUT_SCHEMA_INVALID','RESULT_REFERENCE_RECORD_FAILED')),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(attempt_id,substage),
 FOREIGN KEY(owner_user_id,job_id,logical_call_id,attempt_no,attempt_id)
  REFERENCES bb_model_call_attempts(owner_user_id,job_id,logical_call_id,attempt_no,id)
);
CREATE INDEX bb_model_result_failure_diagnostics_run ON bb_model_result_failure_diagnostics(owner_user_id,run_id,recorded_at);
CREATE TRIGGER bb_model_result_failure_diagnostics_immutable BEFORE UPDATE OR DELETE ON bb_model_result_failure_diagnostics
 FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();
