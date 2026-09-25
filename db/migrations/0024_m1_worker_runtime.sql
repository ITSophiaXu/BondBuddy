-- #17 worker runtime. Parse jobs gain a per-job ordered event log so the public event
-- stream can resume by Last-Event-ID (runs already have bb_run_events.seq). Rows are
-- appended in the same transaction as the job transition, under the job row lock.
CREATE TABLE bb_job_events (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL,
  job_id text NOT NULL,
  seq integer NOT NULL CHECK (seq > 0),
  type text NOT NULL CHECK (type ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  state text NOT NULL CHECK (state IN ('queued','running','paused','succeeded','failed','cancelled')),
  stage text,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, seq),
  FOREIGN KEY (owner_user_id, job_id) REFERENCES bb_jobs(owner_user_id, id)
);
CREATE INDEX bb_job_events_owner_idx ON bb_job_events(owner_user_id, job_id, seq);

CREATE FUNCTION bb_reject_job_event_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'job events are append-only' USING ERRCODE = '23514'; END $$;
CREATE TRIGGER bb_job_events_append_only BEFORE UPDATE OR DELETE ON bb_job_events
  FOR EACH ROW EXECUTE FUNCTION bb_reject_job_event_change();

-- Run jobs record their terminal public error code like parse jobs do (parse jobs keep
-- their stricter bb_job_binding rule). Finding paused runs for the runtime sweeps:
CREATE INDEX bb_jobs_paused_run_idx ON bb_jobs(stage, updated_at) WHERE state = 'paused' AND job_type <> 'parse';
