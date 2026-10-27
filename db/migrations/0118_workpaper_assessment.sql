CREATE TABLE bb_workpaper_assessments (
 run_id text PRIMARY KEY,owner_user_id text NOT NULL,project_id text NOT NULL,manifest jsonb NOT NULL,input_hash char(64) NOT NULL,
 result jsonb,result_hash char(64),created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_user_id,run_id),FOREIGN KEY(owner_user_id,run_id) REFERENCES bb_runs(owner_user_id,id),
 FOREIGN KEY(owner_user_id,project_id) REFERENCES bb_projects(owner_user_id,id),
 CHECK((result IS NULL)=(result_hash IS NULL))
);
CREATE TABLE bb_workpaper_assessment_chunks (
 run_id text NOT NULL,ordinal integer NOT NULL,decisions jsonb NOT NULL,sha256 char(64) NOT NULL,
 PRIMARY KEY(run_id,ordinal),FOREIGN KEY(run_id) REFERENCES bb_workpaper_assessments(run_id)
);
CREATE TRIGGER bb_workpaper_assessment_chunks_immutable BEFORE UPDATE OR DELETE ON bb_workpaper_assessment_chunks FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();
CREATE FUNCTION bb_workpaper_assessment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.run_id,NEW.owner_user_id,NEW.project_id,NEW.manifest,NEW.input_hash) IS DISTINCT FROM ROW(OLD.run_id,OLD.owner_user_id,OLD.project_id,OLD.manifest,OLD.input_hash)
 OR (OLD.result IS NOT NULL AND ROW(NEW.result,NEW.result_hash) IS DISTINCT FROM ROW(OLD.result,OLD.result_hash))
 THEN RAISE EXCEPTION 'Workpaper assessment snapshot is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_workpaper_assessment_guard BEFORE UPDATE ON bb_workpaper_assessments FOR EACH ROW EXECUTE FUNCTION bb_workpaper_assessment_guard();
ALTER TABLE bb_workpaper_batches ADD COLUMN assessment_id text;
ALTER TABLE bb_workpaper_batches ADD COLUMN assessment_hash char(64);
ALTER TABLE bb_workpaper_batches ADD CONSTRAINT bb_workpaper_batch_assessment FOREIGN KEY(owner_user_id,assessment_id) REFERENCES bb_workpaper_assessments(owner_user_id,run_id);
ALTER TABLE bb_workpaper_items ADD COLUMN explanation jsonb;
CREATE FUNCTION bb_workpaper_confirmation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='bb_workpaper_batches' THEN
  IF TG_OP='INSERT' AND (NEW.assessment_id IS NULL OR NEW.assessment_hash IS NULL) THEN RAISE EXCEPTION 'Assessment confirmation required' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' AND ROW(NEW.assessment_id,NEW.assessment_hash) IS DISTINCT FROM ROW(OLD.assessment_id,OLD.assessment_hash) THEN RAISE EXCEPTION 'Confirmation is immutable' USING ERRCODE='23514'; END IF;
 ELSE
  IF NEW.explanation IS DISTINCT FROM OLD.explanation THEN RAISE EXCEPTION 'Explanation is immutable' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_workpaper_confirmation_guard BEFORE INSERT OR UPDATE ON bb_workpaper_batches FOR EACH ROW EXECUTE FUNCTION bb_workpaper_confirmation_guard();
CREATE TRIGGER bb_workpaper_explanation_guard BEFORE UPDATE ON bb_workpaper_items FOR EACH ROW EXECUTE FUNCTION bb_workpaper_confirmation_guard();
