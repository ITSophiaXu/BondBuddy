-- #17 queue slice. A job is owned by exactly one run; checkpoints survive leases.
CREATE TABLE bb_jobs (
 id text PRIMARY KEY, owner_user_id text NOT NULL, run_id text NOT NULL UNIQUE,
 job_type text NOT NULL, subtype text NOT NULL, state text NOT NULL
   CHECK (state IN ('queued','running','paused','succeeded','failed','cancelled')),
 stage text, checkpoint jsonb NOT NULL DEFAULT '{}'::jsonb,
 lease_token text, lease_until timestamptz, attempts integer NOT NULL DEFAULT 0 CHECK (attempts>=0),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (owner_user_id,id), FOREIGN KEY (owner_user_id,run_id) REFERENCES bb_runs(owner_user_id,id),
 CHECK ((lease_token IS NULL) = (lease_until IS NULL))
);
CREATE INDEX bb_jobs_claim_idx ON bb_jobs(state,lease_until,created_at);
CREATE TABLE bb_model_call_attempts (
 id text PRIMARY KEY, owner_user_id text NOT NULL, job_id text NOT NULL,
 logical_call_id text NOT NULL, attempt_no integer NOT NULL CHECK (attempt_no>0),
 provider_request_id text, status text NOT NULL CHECK (status IN ('pending_reconcile','confirmed_not_sent','completed','failed')),
 usage_status text NOT NULL DEFAULT 'unknown' CHECK (usage_status IN ('unknown','pending','measured')),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (job_id,logical_call_id,attempt_no),
 FOREIGN KEY (owner_user_id,job_id) REFERENCES bb_jobs(owner_user_id,id)
);
CREATE INDEX bb_model_call_reconcile_idx ON bb_model_call_attempts(job_id,status);
-- A committed event always has a matching outbox row; transitions take the run row lock.
