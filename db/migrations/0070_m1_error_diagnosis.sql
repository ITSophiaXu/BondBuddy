-- #79: bounded diagnostics and indexed root-cause lookup. Existing evidence remains immutable.
ALTER TABLE bb_observability_errors
  ADD COLUMN provider_error_type text CHECK (provider_error_type IS NULL OR provider_error_type ~ '^[a-z][a-z0-9_]{0,63}$'),
  ADD COLUMN safe_message text CHECK (safe_message IS NULL OR octet_length(safe_message) <= 1024),
  ADD COLUMN safe_stack text CHECK (safe_stack IS NULL OR octet_length(safe_stack) <= 2048),
  ADD CONSTRAINT bb_error_provider_status_range CHECK (provider_status IS NULL OR provider_status BETWEEN 100 AND 599);
CREATE INDEX bb_errors_category_code_fingerprint_idx ON bb_observability_errors(category,code,fingerprint,created_at DESC);

-- A retry disposition is written before its final outcome is known. Keep the original error
-- immutable and append its terminal recovery evidence with the job's terminal transition.
CREATE TABLE bb_error_recovery_events (
 id text PRIMARY KEY,
 error_id text NOT NULL UNIQUE REFERENCES bb_observability_errors(id),
 job_id text NOT NULL REFERENCES bb_jobs(id),
 outcome text NOT NULL CHECK (outcome IN ('recovered','retried_failed','user_cancelled')),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bb_error_recovery_job_idx ON bb_error_recovery_events(job_id,created_at);
CREATE TRIGGER bb_error_recovery_immutable BEFORE UPDATE OR DELETE ON bb_error_recovery_events
 FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();

CREATE FUNCTION bb_record_error_recovery() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.state IN ('succeeded','test_completed','failed','cancelled','rejected')
    AND OLD.state NOT IN ('succeeded','test_completed','failed','cancelled','rejected') THEN
   INSERT INTO bb_error_recovery_events(id,error_id,job_id,outcome)
   SELECT md5(e.id || ':' || NEW.id || ':' || NEW.state),e.id,NEW.id,
     CASE WHEN NEW.state IN ('succeeded','test_completed') THEN 'recovered'
          WHEN NEW.state='cancelled' THEN 'user_cancelled'
          ELSE 'retried_failed' END
   FROM bb_observability_errors e
   WHERE e.job_id=NEW.id AND e.recovery_status='retry_scheduled'
   ON CONFLICT (error_id) DO NOTHING;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_job_error_recovery AFTER UPDATE OF state ON bb_jobs
 FOR EACH ROW EXECUTE FUNCTION bb_record_error_recovery();
