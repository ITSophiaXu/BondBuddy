-- One immutable browser observation per subject/site. Saved before model interpretation.
CREATE TABLE bb_integrity_browser_batches (
 owner_user_id text NOT NULL, run_id text NOT NULL, subject_id text NOT NULL, site_id text NOT NULL,
 payload jsonb NOT NULL, sha256 char(64) NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(run_id,subject_id,site_id),
 FOREIGN KEY(owner_user_id,run_id) REFERENCES bb_integrity_runs(owner_user_id,run_id)
);
CREATE TRIGGER bb_integrity_browser_batches_immutable BEFORE UPDATE OR DELETE ON bb_integrity_browser_batches FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();
CREATE TABLE bb_integrity_browser_captures (
 id text PRIMARY KEY, owner_user_id text NOT NULL, run_id text NOT NULL, subject_id text NOT NULL, site_id text NOT NULL,
 metadata jsonb NOT NULL, screenshot_key text NOT NULL, text_key text NOT NULL,
 FOREIGN KEY(run_id,subject_id,site_id) REFERENCES bb_integrity_browser_batches(run_id,subject_id,site_id),
 FOREIGN KEY(owner_user_id,run_id) REFERENCES bb_integrity_runs(owner_user_id,run_id)
);
CREATE TRIGGER bb_integrity_browser_captures_immutable BEFORE UPDATE OR DELETE ON bb_integrity_browser_captures FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();
