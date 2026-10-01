-- #16/#79: per-attempt runtime evidence from the contained Codex adapter.
-- Supplier usage/outcome stays in bb_provider_call_observations; this table only adds
-- the framework-side facts that the observation schema has no column for.
CREATE TABLE bb_model_call_attempt_runtime (
 id text PRIMARY KEY,
 owner_user_id text NOT NULL,
 project_id text NOT NULL,
 job_id text NOT NULL,
 run_id text NOT NULL,
 trace_id text NOT NULL,
 attempt_id text NOT NULL,
 logical_call_id text NOT NULL,
 attempt_no integer NOT NULL CHECK(attempt_no>0),
 adapter text NOT NULL CHECK(adapter IN ('codex_exec')),
 adapter_version text NOT NULL CHECK(adapter_version ~ '^[A-Za-z0-9._-]{1,128}$'),
 model_provider text NOT NULL CHECK(model_provider ~ '^[a-z0-9_-]{1,64}$'),
 model_config_version text NOT NULL CHECK(model_config_version ~ '^[A-Za-z0-9._-]{1,128}$'),
 provider_request_id_status text NOT NULL CHECK(provider_request_id_status IN ('unknown')),
 framework_thread_id text CHECK(framework_thread_id IS NULL OR framework_thread_id ~ '^[A-Za-z0-9_-]{1,128}$'),
 started_at timestamptz NOT NULL,
 duration_ms integer NOT NULL CHECK(duration_ms>=0),
 exit_code integer,
 exit_signal text CHECK(exit_signal IS NULL OR exit_signal ~ '^SIG[A-Z0-9]{1,16}$'),
 finish_reason text CHECK(finish_reason IS NULL OR finish_reason ~ '^[a-z_]{1,64}$'),
 error_code text CHECK(error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
 tool_attempts integer NOT NULL CHECK(tool_attempts>=0),
 pricing_status text NOT NULL CHECK(pricing_status IN ('unknown')),
 recorded_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(attempt_id),
 FOREIGN KEY(owner_user_id,project_id,run_id) REFERENCES bb_runs(owner_user_id,project_id,id),
 FOREIGN KEY(owner_user_id,job_id,run_id) REFERENCES bb_jobs(owner_user_id,id,run_id),
 FOREIGN KEY(owner_user_id,job_id,logical_call_id,attempt_no,attempt_id)
   REFERENCES bb_model_call_attempts(owner_user_id,job_id,logical_call_id,attempt_no,id),
 CHECK(trace_id=run_id)
);
CREATE INDEX bb_model_attempt_runtime_owner_job_idx ON bb_model_call_attempt_runtime(owner_user_id,job_id,attempt_no);
CREATE TRIGGER bb_model_call_attempt_runtime_immutable BEFORE UPDATE OR DELETE ON bb_model_call_attempt_runtime
  FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();
