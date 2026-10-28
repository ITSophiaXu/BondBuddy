-- Direct batches make applicability part of each authoring turn, not a prerequisite run.
ALTER TABLE bb_workpaper_batches ADD COLUMN start_mode text NOT NULL DEFAULT 'assessed'
 CHECK(start_mode IN ('assessed','direct'));
UPDATE bb_workpaper_batches SET start_mode='direct' WHERE assessment_id IS NULL AND assessment_hash IS NULL;
ALTER TABLE bb_workpaper_batches ADD CONSTRAINT bb_workpaper_start_binding CHECK(
 (start_mode='direct' AND assessment_id IS NULL AND assessment_hash IS NULL)
 OR (start_mode='assessed' AND assessment_id IS NOT NULL AND assessment_hash IS NOT NULL));
CREATE OR REPLACE FUNCTION bb_workpaper_confirmation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='bb_workpaper_batches' THEN
  IF TG_OP='UPDATE' AND ROW(NEW.start_mode,NEW.assessment_id,NEW.assessment_hash) IS DISTINCT FROM ROW(OLD.start_mode,OLD.assessment_id,OLD.assessment_hash)
  THEN RAISE EXCEPTION 'Start binding is immutable' USING ERRCODE='23514'; END IF;
 ELSE
  IF NEW.explanation IS DISTINCT FROM OLD.explanation THEN RAISE EXCEPTION 'Explanation is immutable' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;

-- A result belongs to one attempt. Retrying never changes a previous attempt's conclusion.
CREATE TABLE bb_workpaper_item_results (
 run_id text PRIMARY KEY,owner_user_id text NOT NULL,batch_id text NOT NULL,item_id text NOT NULL,
 decision jsonb NOT NULL,explanation jsonb,result_hash char(64) NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(owner_user_id,run_id) REFERENCES bb_runs(owner_user_id,id),
 FOREIGN KEY(batch_id,item_id) REFERENCES bb_workpaper_items(batch_id,item_id),
 CHECK(decision->>'item_id'=item_id AND decision->>'status' IN ('generate','not_applicable','missing_information','external_evidence')),
 CHECK((decision->>'status'='generate')=(explanation IS NULL))
);
CREATE FUNCTION bb_workpaper_result_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM bb_workpaper_items i JOIN bb_workpaper_batches b ON b.owner_user_id=i.owner_user_id AND b.id=i.batch_id
  WHERE i.owner_user_id=NEW.owner_user_id AND i.batch_id=NEW.batch_id AND i.item_id=NEW.item_id AND i.run_id=NEW.run_id
   AND b.start_mode='direct' AND i.manifest->'input'->'workpaper'->>'mode'='direct')
 THEN RAISE EXCEPTION 'Workpaper result must match the pinned direct attempt' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_workpaper_result_guard BEFORE INSERT ON bb_workpaper_item_results FOR EACH ROW EXECUTE FUNCTION bb_workpaper_result_guard();
CREATE TRIGGER bb_workpaper_result_immutable BEFORE UPDATE OR DELETE ON bb_workpaper_item_results FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();

-- Retired preflight runs are read-only, like QA. Their unresolved provider observations
-- remain intact; they cannot keep a new authoring batch behind an obsolete prerequisite.
CREATE FUNCTION bb_is_workpaper_assessment(owner_id text,project_id text,revision integer) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM bb_input_revisions i WHERE i.owner_user_id=owner_id AND i.project_id=$2 AND i.revision=$3
  AND i.manifest->>'version'='workpaper-assessment-v1')
$$;
CREATE OR REPLACE FUNCTION bb_m3_project_run_mutex() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE project_kind text; scope_id text; is_m4_scope boolean;
BEGIN
 IF NEW.task_kind='qa' OR NEW.state IN ('succeeded','test_completed','failed','cancelled','rejected')
  OR bb_is_workpaper_assessment(NEW.owner_user_id,NEW.project_id,NEW.input_revision) THEN RETURN NEW; END IF;
 SELECT kind,COALESCE(execution_scope_project_id,id) INTO project_kind,scope_id FROM bb_projects
 WHERE owner_user_id=NEW.owner_user_id AND id=NEW.project_id;
 PERFORM 1 FROM bb_projects WHERE owner_user_id=NEW.owner_user_id AND id=scope_id FOR UPDATE;
 SELECT EXISTS(SELECT 1 FROM bb_projects WHERE owner_user_id=NEW.owner_user_id AND execution_scope_project_id=scope_id) INTO is_m4_scope;
 IF (project_kind='review' OR is_m4_scope) AND EXISTS (
  SELECT 1 FROM bb_runs r JOIN bb_projects p ON p.id=r.project_id AND p.owner_user_id=r.owner_user_id
  WHERE r.owner_user_id=NEW.owner_user_id AND COALESCE(p.execution_scope_project_id,p.id)=scope_id AND r.id<>NEW.id
   AND r.task_kind<>'qa' AND r.state NOT IN ('succeeded','test_completed','failed','cancelled','rejected')
   AND NOT bb_is_workpaper_assessment(r.owner_user_id,r.project_id,r.input_revision)
 ) THEN RAISE EXCEPTION 'Project already has an active business run' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;

-- Generated workpapers retain progress billing. A delivered explanation has zero net
-- charge: append refunds for any progress debits, preserving the original ledger.
DO $$ DECLARE definition text;
BEGIN
 SELECT pg_get_functiondef('bb_m4_credit_finalize_run()'::regprocedure) INTO definition;
 IF strpos(definition,'compensation text;')=0 OR strpos(definition,'authoring_platform_failure_refund')=0
 THEN RAISE EXCEPTION 'Unexpected M4 finalizer'; END IF;
 definition:=replace(definition,'compensation text;','compensation text; explanation_only boolean;');
 definition:=replace(definition,'IF NOT FOUND THEN RETURN NEW; END IF;',
  'IF NOT FOUND THEN RETURN NEW; END IF; SELECT EXISTS(SELECT 1 FROM bb_workpaper_item_results w WHERE w.owner_user_id=NEW.owner_user_id AND w.run_id=NEW.id AND w.decision->>''status''<>''generate'') INTO explanation_only;');
 definition:=replace(definition,'IF charged>r.points THEN','IF explanation_only THEN charged:=0; END IF; IF charged>r.points THEN');
 definition:=replace(definition,'IF NEW.state=''succeeded'' AND COALESCE(r.charged_points,0)<>r.points THEN',
  'IF NEW.state=''succeeded'' AND NOT explanation_only AND COALESCE(r.charged_points,0)<>r.points THEN');
 definition:=replace(definition,'IF NEW.state IN (''failed'',''rejected'') THEN','IF NEW.state IN (''failed'',''rejected'') OR explanation_only THEN');
 definition:=replace(definition,'''dynamic-failure:''||r.id','(CASE WHEN explanation_only THEN ''workpaper-explanation:'' ELSE ''dynamic-failure:'' END)||r.id');
 definition:=replace(definition,'''authoring_platform_failure_refund''','CASE WHEN explanation_only THEN ''workpaper_explanation_no_charge'' ELSE ''authoring_platform_failure_refund'' END');
 definition:=replace(definition,'NEW.state IN (''failed'',''rejected'') OR COALESCE(charged_points,0)=0',
  'NEW.state IN (''failed'',''rejected'') OR explanation_only OR COALESCE(charged_points,0)=0');
 definition:=replace(definition,'state=CASE WHEN NEW.state=''succeeded'' THEN ''settled'' ELSE ''released'' END',
  'state=CASE WHEN NEW.state=''succeeded'' AND charged>0 THEN ''settled'' ELSE ''released'' END');
 EXECUTE definition;
END $$;
