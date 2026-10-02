-- Defends M3 against simultaneous submissions through any current/future entry point.
CREATE FUNCTION bb_m3_project_run_mutex() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE project_kind text;
BEGIN
 IF NEW.state IN ('succeeded','test_completed','failed','cancelled','rejected') THEN RETURN NEW; END IF;
 SELECT kind INTO project_kind FROM bb_projects WHERE owner_user_id=NEW.owner_user_id AND id=NEW.project_id FOR UPDATE;
 IF project_kind='review' AND EXISTS (
   SELECT 1 FROM bb_runs WHERE owner_user_id=NEW.owner_user_id AND project_id=NEW.project_id AND id<>NEW.id
   AND state NOT IN ('succeeded','test_completed','failed','cancelled','rejected')
 ) THEN RAISE EXCEPTION 'M3 project already has an active run' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_m3_run_mutex BEFORE INSERT OR UPDATE OF state ON bb_runs FOR EACH ROW EXECUTE FUNCTION bb_m3_project_run_mutex();
