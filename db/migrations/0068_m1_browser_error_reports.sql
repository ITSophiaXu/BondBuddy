-- Bounded redacted browser diagnostics; durable event and operation are written in the same transaction.
CREATE TABLE bb_browser_error_reports (
 id text PRIMARY KEY,
 owner_user_id text NOT NULL REFERENCES bb_users(id),
 project_id text,
 job_id text,
 session_hash char(64) NOT NULL CHECK (session_hash ~ '^[a-f0-9]{64}$'),
 dedupe_key char(64) NOT NULL UNIQUE CHECK (dedupe_key ~ '^[a-f0-9]{64}$'),
 fingerprint char(64) NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
 error_type text NOT NULL CHECK (length(error_type) BETWEEN 1 AND 64),
 safe_message text CHECK (octet_length(safe_message) <= 1024),
 route_id text NOT NULL CHECK (length(route_id) BETWEEN 1 AND 128),
 frontend_version text NOT NULL CHECK (length(frontend_version) BETWEEN 1 AND 64),
 client_time timestamptz NOT NULL,
 received_at timestamptz NOT NULL DEFAULT now(),
 purged_at timestamptz,
 CHECK (purged_at IS NULL OR safe_message IS NULL),
 FOREIGN KEY (owner_user_id,project_id) REFERENCES bb_projects(owner_user_id,id),
 FOREIGN KEY (owner_user_id,job_id) REFERENCES bb_jobs(owner_user_id,id)
);
CREATE INDEX bb_browser_error_owner_time_idx ON bb_browser_error_reports(owner_user_id,received_at DESC);
CREATE INDEX bb_browser_error_job_idx ON bb_browser_error_reports(owner_user_id,job_id,received_at DESC);
CREATE FUNCTION bb_guard_browser_error_report() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'browser error metadata is retained' USING ERRCODE='23514'; END IF;
 IF OLD.purged_at IS NOT NULL OR NEW.purged_at IS NULL OR NEW.safe_message IS NOT NULL
    OR (to_jsonb(NEW)-'safe_message'-'purged_at') <> (to_jsonb(OLD)-'safe_message'-'purged_at')
 THEN RAISE EXCEPTION 'browser error report is immutable except content purge' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_browser_error_report_guard BEFORE UPDATE OR DELETE ON bb_browser_error_reports
 FOR EACH ROW EXECUTE FUNCTION bb_guard_browser_error_report();
