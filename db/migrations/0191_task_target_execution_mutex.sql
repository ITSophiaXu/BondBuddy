-- Shared immutable sources may feed independent targets concurrently.
-- Keep target writer and verified same-batch item protections. No capacity/lease changes.
CREATE OR REPLACE FUNCTION public.bb_m3_project_run_mutex()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE project_kind text; scope_id text; is_m4_scope boolean; progressive text[];
BEGIN
 IF TG_OP='UPDATE' AND OLD.state NOT IN ('succeeded','test_completed','failed','cancelled','rejected')
  AND NEW.state NOT IN ('succeeded','test_completed','failed','cancelled','rejected')
  AND ROW(NEW.owner_user_id,NEW.project_id,NEW.input_revision,NEW.id,NEW.execution_request_id,NEW.task_kind)
   IS NOT DISTINCT FROM ROW(OLD.owner_user_id,OLD.project_id,OLD.input_revision,OLD.id,OLD.execution_request_id,OLD.task_kind)
 THEN RETURN NEW; END IF;
 IF NEW.task_kind='qa' OR NEW.state IN ('succeeded','test_completed','failed','cancelled','rejected')
  OR bb_is_workpaper_assessment(NEW.owner_user_id,NEW.project_id,NEW.input_revision) THEN RETURN NEW; END IF;
 SELECT kind,COALESCE(execution_scope_project_id,id) INTO project_kind,scope_id FROM bb_projects
 WHERE owner_user_id=NEW.owner_user_id AND id=NEW.project_id;
 PERFORM 1 FROM bb_projects WHERE owner_user_id=NEW.owner_user_id AND id=NEW.project_id FOR NO KEY UPDATE;
 SELECT EXISTS(SELECT 1 FROM bb_projects WHERE owner_user_id=NEW.owner_user_id AND execution_scope_project_id=scope_id) INTO is_m4_scope;

 progressive:=bb_batch_child_identity(NEW.owner_user_id,NEW.project_id,NEW.input_revision,NEW.id,NEW.execution_request_id);
 IF progressive IS NOT NULL AND (
  SELECT count(*) FROM bb_runs active JOIN bb_projects scope_project ON scope_project.owner_user_id=active.owner_user_id AND scope_project.id=active.project_id
  WHERE active.owner_user_id=NEW.owner_user_id AND active.project_id=NEW.project_id
   AND active.id<>NEW.id AND active.task_kind<>'qa' AND active.state NOT IN ('succeeded','test_completed','failed','cancelled','rejected')
   AND (bb_batch_child_identity(active.owner_user_id,active.project_id,active.input_revision,active.id,active.execution_request_id))[1]=progressive[1]
 )>=progressive[3]::integer THEN RAISE EXCEPTION 'Progressive workpaper concurrency limit reached' USING ERRCODE='23514'; END IF;
 IF (project_kind='review' OR is_m4_scope OR EXISTS(SELECT 1 FROM bb_project_file_workspaces w JOIN bb_projects scope_project ON scope_project.owner_user_id=w.owner_user_id AND scope_project.id=w.project_id WHERE w.owner_user_id=NEW.owner_user_id AND COALESCE(scope_project.execution_scope_project_id,scope_project.id)=scope_id)) AND EXISTS (
  SELECT 1 FROM bb_runs r JOIN bb_projects p ON p.id=r.project_id AND p.owner_user_id=r.owner_user_id
  WHERE r.owner_user_id=NEW.owner_user_id AND r.project_id=NEW.project_id AND r.id<>NEW.id
   AND r.task_kind<>'qa' AND r.state NOT IN ('succeeded','test_completed','failed','cancelled','rejected')
   AND NOT bb_is_workpaper_assessment(r.owner_user_id,r.project_id,r.input_revision)
 AND NOT COALESCE(progressive[1]=(bb_batch_child_identity(r.owner_user_id,r.project_id,r.input_revision,r.id,r.execution_request_id))[1]
  AND progressive[2]<>(bb_batch_child_identity(r.owner_user_id,r.project_id,r.input_revision,r.id,r.execution_request_id))[2],false)
 AND NOT EXISTS(SELECT 1 FROM bb_project_file_check_attempts existing JOIN bb_project_file_check_attempts incoming
  ON incoming.owner_user_id=existing.owner_user_id AND incoming.batch_id=existing.batch_id
  WHERE existing.owner_user_id=r.owner_user_id AND existing.run_id=r.id AND incoming.run_id=NEW.id)
 AND NOT EXISTS(SELECT 1 FROM bb_workpaper_paid_check_items existing
 JOIN bb_workpaper_paid_check_items incoming ON incoming.owner_user_id=existing.owner_user_id AND incoming.batch_id=existing.batch_id
 WHERE existing.owner_user_id=r.owner_user_id AND existing.run_id=r.id AND incoming.run_id=NEW.id)
 ) THEN RAISE EXCEPTION 'Project already has an active business run' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $function$;
