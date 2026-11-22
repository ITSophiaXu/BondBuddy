-- Immutable evidence committed before a Codex process is spawned. A null release or
-- overlay digest means that component cannot be attested from this worker.
CREATE TABLE bb_model_attempt_execution_configs (
 attempt_id text PRIMARY KEY REFERENCES bb_model_call_attempts(id),
 owner_user_id text NOT NULL, project_id text NOT NULL, run_id text NOT NULL,
 job_id text NOT NULL, logical_call_id text NOT NULL, attempt_no integer NOT NULL,
 effective_timeout_ms integer NOT NULL CHECK(effective_timeout_ms>0),
 timeout_deadline_at timestamptz NOT NULL,
 timeout_source text NOT NULL CHECK(timeout_source IN ('default','environment','injected_config','authoring_override','deadline_cap')),
 timeout_branch text NOT NULL CHECK(timeout_branch IN ('ordinary','authoring','file_authoring')),
 model_config_version text NOT NULL,
 loaded_adapter_sha256 char(64) NOT NULL,
 selected_config_sha256 char(64) NOT NULL,
 release_sha text, overlay_sha256 char(64),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(owner_user_id,job_id,logical_call_id,attempt_no,attempt_id)
   REFERENCES bb_model_call_attempts(owner_user_id,job_id,logical_call_id,attempt_no,id)
);
CREATE INDEX bb_model_attempt_execution_configs_run ON bb_model_attempt_execution_configs(owner_user_id,run_id,recorded_at);
CREATE TRIGGER bb_model_attempt_execution_configs_immutable BEFORE UPDATE OR DELETE ON bb_model_attempt_execution_configs
 FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();
