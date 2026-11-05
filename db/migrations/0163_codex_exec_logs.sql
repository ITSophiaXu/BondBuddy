-- #448: private per-attempt Codex stdout/stderr evidence. Bytes live in private Blob
-- storage; this table records the immutable owner-scoped reference and integrity facts.
CREATE TABLE bb_codex_exec_logs (
 attempt_id text PRIMARY KEY,
 owner_user_id text NOT NULL,
 project_id text NOT NULL,
 run_id text NOT NULL,
 job_id text NOT NULL,
 logical_call_id text NOT NULL,
 attempt_no integer NOT NULL CHECK(attempt_no>0),
 object_key text NOT NULL UNIQUE,
 sha256 char(64) NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
 byte_size bigint NOT NULL CHECK(byte_size>=0),
 truncated boolean NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(owner_user_id,project_id,run_id) REFERENCES bb_runs(owner_user_id,project_id,id),
 FOREIGN KEY(owner_user_id,job_id,run_id) REFERENCES bb_jobs(owner_user_id,id,run_id),
 FOREIGN KEY(owner_user_id,job_id,logical_call_id,attempt_no,attempt_id)
   REFERENCES bb_model_call_attempts(owner_user_id,job_id,logical_call_id,attempt_no,id)
);
CREATE INDEX bb_codex_exec_logs_run_idx ON bb_codex_exec_logs(owner_user_id,run_id,created_at DESC,attempt_id);
CREATE TRIGGER bb_codex_exec_logs_immutable BEFORE UPDATE OR DELETE ON bb_codex_exec_logs
  FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();
