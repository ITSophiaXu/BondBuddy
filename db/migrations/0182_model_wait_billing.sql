-- Lease-scoped billing activity is separate from the model semaphore: abandoned
-- processes keep their capacity fence, while billing is bounded by the job lease.
-- Additive only; no historical credits or task policies are rewritten.
CREATE TABLE bb_run_model_activity (
 request_id text PRIMARY KEY,
 owner_user_id text NOT NULL,
 run_id text NOT NULL,
 job_id text NOT NULL,
 lease_token text NOT NULL,
 state text NOT NULL CHECK (state IN ('waiting','active','abandoned')),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY (owner_user_id,job_id) REFERENCES bb_jobs(owner_user_id,id) ON DELETE CASCADE,
 FOREIGN KEY (owner_user_id,run_id) REFERENCES bb_runs(owner_user_id,id) ON DELETE CASCADE
);
CREATE INDEX bb_run_model_activity_lease ON bb_run_model_activity(job_id,lease_token,state);
