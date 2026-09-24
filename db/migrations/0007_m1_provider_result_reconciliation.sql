-- #17/#16 seam: immutable provider result references and attempt-bound observations.
-- This migration is independent of the concurrent #8 storage migration 0006.
ALTER TABLE bb_jobs
  ADD CONSTRAINT bb_job_owner_id_run_key UNIQUE(owner_user_id,id,run_id);
ALTER TABLE bb_model_call_attempts
  ADD CONSTRAINT bb_call_owner_attempt_identity_key
  UNIQUE(owner_user_id,job_id,logical_call_id,attempt_no,id);
ALTER TABLE bb_snapshot_refs
  ADD CONSTRAINT bb_snapshot_owner_project_run_id_key
  UNIQUE(owner_user_id,project_id,run_id,id);

CREATE TABLE bb_provider_result_refs (
 id text PRIMARY KEY,
 owner_user_id text NOT NULL,
 project_id text NOT NULL,
 job_id text NOT NULL,
 run_id text NOT NULL,
 attempt_id text NOT NULL,
 logical_call_id text NOT NULL,
 attempt_no integer NOT NULL CHECK(attempt_no>0),
 call_id text NOT NULL,
 trace_id text NOT NULL,
 model_id text NOT NULL,
 model_config_version text NOT NULL,
 prompt_snapshot_ref text NOT NULL,
 result_ref text NOT NULL UNIQUE,
 result_sha256 char(64) NOT NULL CHECK(result_sha256 ~ '^[a-f0-9]{64}$'),
 result_schema_version text NOT NULL CHECK(result_schema_version ~ '^[A-Za-z0-9._-]{1,128}$'),
 byte_size bigint NOT NULL CHECK(byte_size>0 AND byte_size<=10485760),
 media_type text NOT NULL CHECK(media_type='application/json'),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(attempt_id,result_sha256),
 UNIQUE(owner_user_id,project_id,run_id,id),
 FOREIGN KEY(owner_user_id,project_id,run_id) REFERENCES bb_runs(owner_user_id,project_id,id),
 FOREIGN KEY(owner_user_id,job_id,run_id) REFERENCES bb_jobs(owner_user_id,id,run_id),
 FOREIGN KEY(owner_user_id,job_id,logical_call_id,attempt_no,attempt_id)
   REFERENCES bb_model_call_attempts(owner_user_id,job_id,logical_call_id,attempt_no,id),
 FOREIGN KEY(owner_user_id,project_id,run_id,prompt_snapshot_ref)
   REFERENCES bb_snapshot_refs(owner_user_id,project_id,run_id,id),
 CHECK(call_id=attempt_id),
 CHECK(trace_id=run_id),
 CHECK(result_ref='users/' || owner_user_id || '/projects/' || project_id || '/provider-results/' || attempt_id || '-' || trim(result_sha256) || '.json')
);
CREATE INDEX bb_provider_result_owner_job_idx ON bb_provider_result_refs(owner_user_id,job_id,attempt_no);

CREATE TABLE bb_provider_call_observations (
 id text PRIMARY KEY,
 owner_user_id text NOT NULL,
 project_id text NOT NULL,
 job_id text NOT NULL,
 run_id text NOT NULL,
 attempt_id text NOT NULL,
 logical_call_id text NOT NULL,
 attempt_no integer NOT NULL CHECK(attempt_no>0),
 call_id text NOT NULL,
 trace_id text NOT NULL,
 provider_request_id text,
 model_id text NOT NULL,
 model_config_version text NOT NULL CHECK(model_config_version ~ '^[A-Za-z0-9._-]{1,128}$'),
 prompt_snapshot_ref text NOT NULL,
 result_id text,
 outcome text NOT NULL CHECK(outcome IN ('completed','failed','pending_reconcile','confirmed_not_sent')),
 finish_reason text,
 usage_status text NOT NULL CHECK(usage_status IN ('unknown','pending','measured')),
 input_tokens integer,
 cached_input_tokens integer,
 output_tokens integer,
 reasoning_tokens integer,
 total_tokens integer,
 error_code text CHECK(error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
 observation_hash char(64) NOT NULL CHECK(observation_hash ~ '^[a-f0-9]{64}$'),
 observed_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(attempt_id,observation_hash),
 UNIQUE(owner_user_id,project_id,run_id,id),
 FOREIGN KEY(owner_user_id,project_id,run_id) REFERENCES bb_runs(owner_user_id,project_id,id),
 FOREIGN KEY(owner_user_id,job_id,run_id) REFERENCES bb_jobs(owner_user_id,id,run_id),
 FOREIGN KEY(owner_user_id,job_id,logical_call_id,attempt_no,attempt_id)
   REFERENCES bb_model_call_attempts(owner_user_id,job_id,logical_call_id,attempt_no,id),
 FOREIGN KEY(owner_user_id,project_id,run_id,prompt_snapshot_ref)
   REFERENCES bb_snapshot_refs(owner_user_id,project_id,run_id,id),
 FOREIGN KEY(owner_user_id,project_id,run_id,result_id)
   REFERENCES bb_provider_result_refs(owner_user_id,project_id,run_id,id),
 CHECK(call_id=attempt_id),
 CHECK(trace_id=run_id),
 CHECK((usage_status='unknown' AND input_tokens IS NULL AND cached_input_tokens IS NULL AND output_tokens IS NULL AND reasoning_tokens IS NULL AND total_tokens IS NULL)
    OR (usage_status='pending' AND (input_tokens IS NULL OR input_tokens>=0) AND (cached_input_tokens IS NULL OR cached_input_tokens>=0) AND (output_tokens IS NULL OR output_tokens>=0) AND (reasoning_tokens IS NULL OR reasoning_tokens>=0) AND (total_tokens IS NULL OR total_tokens>=0))
    OR (usage_status='measured' AND input_tokens>=0 AND output_tokens>=0 AND total_tokens=input_tokens+output_tokens AND (cached_input_tokens IS NULL OR (cached_input_tokens>=0 AND cached_input_tokens<=input_tokens)) AND (reasoning_tokens IS NULL OR (reasoning_tokens>=0 AND reasoning_tokens<=output_tokens)))),
 CHECK(cached_input_tokens IS NULL OR input_tokens IS NULL OR cached_input_tokens<=input_tokens),
 CHECK(reasoning_tokens IS NULL OR output_tokens IS NULL OR reasoning_tokens<=output_tokens),
 CHECK(outcome<>'completed' OR (result_id IS NOT NULL AND usage_status='measured' AND finish_reason='stop' AND error_code IS NULL)),
 CHECK(outcome<>'confirmed_not_sent' OR result_id IS NULL)
);
CREATE INDEX bb_provider_observation_owner_job_idx ON bb_provider_call_observations(owner_user_id,job_id,observed_at,id);

-- Provider result material and observations are append-only. Corrections are new observations;
-- conflicting hashes/usages remain unresolved instead of replacing earlier evidence.
CREATE TRIGGER bb_provider_result_ref_immutable BEFORE UPDATE OR DELETE ON bb_provider_result_refs
  FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();
CREATE TRIGGER bb_provider_call_observation_immutable BEFORE UPDATE OR DELETE ON bb_provider_call_observations
  FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();
