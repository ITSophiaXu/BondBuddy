-- Immutable inputs and lease-backed, recoverable change checks; private dependency
-- metadata stays outside delivered documents and ZIPs.
CREATE TABLE bb_workpaper_checks (
 run_id text PRIMARY KEY,owner_user_id text NOT NULL,project_id text NOT NULL,batch_id text NOT NULL,
 manifest jsonb NOT NULL,input_hash char(64) NOT NULL,result jsonb,result_hash char(64),
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(owner_user_id,run_id) REFERENCES bb_runs(owner_user_id,id),
 FOREIGN KEY(owner_user_id,project_id) REFERENCES bb_projects(owner_user_id,id),
 FOREIGN KEY(owner_user_id,batch_id) REFERENCES bb_workpaper_batches(owner_user_id,id),
 CHECK ((result IS NULL)=(result_hash IS NULL))
);
CREATE INDEX bb_workpaper_checks_project ON bb_workpaper_checks(owner_user_id,project_id,created_at DESC);
CREATE FUNCTION bb_workpaper_check_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.run_id,NEW.owner_user_id,NEW.project_id,NEW.batch_id,NEW.manifest,NEW.input_hash)
 IS DISTINCT FROM ROW(OLD.run_id,OLD.owner_user_id,OLD.project_id,OLD.batch_id,OLD.manifest,OLD.input_hash)
 OR (OLD.result IS NOT NULL AND ROW(NEW.result,NEW.result_hash) IS DISTINCT FROM ROW(OLD.result,OLD.result_hash))
 THEN RAISE EXCEPTION 'Workpaper check snapshot is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_workpaper_check_guard BEFORE UPDATE ON bb_workpaper_checks FOR EACH ROW EXECUTE FUNCTION bb_workpaper_check_guard();
