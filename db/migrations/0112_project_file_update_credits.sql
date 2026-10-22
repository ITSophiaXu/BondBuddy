-- 2026-10-21 user decision: checks free; generate a revised file for 4,500 credits.
-- No historical operation is retroactively charged. Reuse the shared wallet and
-- generic dual-Word on-delivery finalizer, including failure/cancellation release.
CREATE TABLE bb_project_file_update_quotes (
 id text PRIMARY KEY,owner_user_id text NOT NULL,project_id text NOT NULL,run_id text NOT NULL UNIQUE,
 check_run_id text NOT NULL,file_version_id text NOT NULL,input_hash char(64) NOT NULL,
 points bigint NOT NULL CHECK(points=4500),
 price_version text NOT NULL CHECK(price_version='project-file-update-4500-v1'),
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(owner_user_id,id),
 FOREIGN KEY(owner_user_id,project_id) REFERENCES bb_projects(owner_user_id,id),
 FOREIGN KEY(owner_user_id,run_id) REFERENCES bb_project_file_operations(owner_user_id,run_id),
 FOREIGN KEY(owner_user_id,check_run_id) REFERENCES bb_project_file_operations(owner_user_id,run_id),
 FOREIGN KEY(owner_user_id,file_version_id) REFERENCES bb_project_file_versions(owner_user_id,id)
);
CREATE TRIGGER bb_project_file_update_quotes_immutable BEFORE UPDATE OR DELETE ON bb_project_file_update_quotes
 FOR EACH ROW EXECUTE FUNCTION bb_credit_immutable();
CREATE OR REPLACE FUNCTION bb_credit_reservation_quote_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM bb_credit_quotes WHERE owner_user_id=NEW.owner_user_id AND id=NEW.quote_id)
 AND NOT EXISTS(SELECT 1 FROM bb_m4_quotes WHERE owner_user_id=NEW.owner_user_id AND id=NEW.quote_id AND reserve_points=NEW.points)
 AND NOT EXISTS(SELECT 1 FROM bb_project_file_update_quotes q
   JOIN bb_project_file_operations o ON o.run_id=q.run_id AND o.owner_user_id=q.owner_user_id
   WHERE q.owner_user_id=NEW.owner_user_id AND q.id=NEW.quote_id AND q.run_id=NEW.run_id AND q.points=NEW.points
     AND o.operation='patch' AND o.input_hash=q.input_hash AND o.project_id=q.project_id
     AND o.manifest->>'check_run_id'=q.check_run_id AND o.manifest->>'file_version_id'=q.file_version_id
     AND NEW.billing_policy='on_delivery')
 THEN RAISE EXCEPTION 'Owned immutable quote required' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
