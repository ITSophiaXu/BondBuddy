-- Integrity checks/exports use independent immutable inputs and run-scoped outputs.
-- Keep the existing generation task kind for historical jobs and worker contracts.
-- Input identity is available before the integrity row/job is inserted in the transaction.
CREATE FUNCTION bb_is_integrity_input(owner_id text,project_id text,revision integer)
 RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM bb_input_revisions i
  WHERE i.owner_user_id=$1 AND i.project_id=$2 AND i.revision=$3
   AND i.manifest->>'version'='integrity-round-v1'
   AND i.manifest->>'operation' IN ('check','export'))
$$;

-- Only another integrity operation in this exact owned project conflicts.
-- Resume/progress of an already admitted nonterminal run does not take a project
-- lock after the run/account locks; that would deadlock concurrent admissions.
CREATE FUNCTION bb_integrity_project_run_mutex() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.state IN ('succeeded','test_completed','failed','cancelled','rejected')
  OR NOT bb_is_integrity_input(NEW.owner_user_id,NEW.project_id,NEW.input_revision) THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND OLD.state NOT IN ('succeeded','test_completed','failed','cancelled','rejected')
  AND ROW(NEW.owner_user_id,NEW.project_id,NEW.input_revision,NEW.id,NEW.execution_request_id,NEW.task_kind)
   IS NOT DISTINCT FROM ROW(OLD.owner_user_id,OLD.project_id,OLD.input_revision,OLD.id,OLD.execution_request_id,OLD.task_kind)
 THEN RETURN NEW; END IF;
 PERFORM 1 FROM bb_projects WHERE owner_user_id=NEW.owner_user_id AND id=NEW.project_id FOR NO KEY UPDATE;
 IF EXISTS(SELECT 1 FROM bb_runs r WHERE r.owner_user_id=NEW.owner_user_id AND r.project_id=NEW.project_id AND r.id<>NEW.id
  AND r.state NOT IN ('succeeded','test_completed','failed','cancelled','rejected')
  AND bb_is_integrity_input(r.owner_user_id,r.project_id,r.input_revision)) THEN
  RAISE EXCEPTION 'Project already has an active integrity run' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_integrity_run_mutex BEFORE INSERT OR UPDATE OF state ON bb_runs
 FOR EACH ROW EXECUTE FUNCTION bb_integrity_project_run_mutex();

-- Preserve the canonical document mutex, its batch membership/capacity checks,
-- QA and assessment exceptions. Integrity is excluded in both admission directions.
DO $$ DECLARE definition text; marker text; BEGIN
 SELECT pg_get_functiondef('bb_m3_project_run_mutex()'::regprocedure) INTO definition;
 marker:='IF NEW.task_kind=''qa'' OR NEW.state IN';
 IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN
  RAISE EXCEPTION 'Unexpected canonical run mutex entry';
 END IF;
 definition:=replace(definition,marker,
  'IF bb_is_integrity_input(NEW.owner_user_id,NEW.project_id,NEW.input_revision) OR NEW.task_kind=''qa'' OR NEW.state IN');
 marker:='AND NOT bb_is_workpaper_assessment(r.owner_user_id,r.project_id,r.input_revision)';
 IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN
  RAISE EXCEPTION 'Unexpected canonical run mutex peers';
 END IF;
 definition:=replace(definition,marker,marker||
  ' AND NOT bb_is_integrity_input(r.owner_user_id,r.project_id,r.input_revision)');
 EXECUTE definition;
END $$;
