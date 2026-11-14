-- NULL is the historical policy: ordinary batches stay serial, progressive stay two.
-- Only newly created batches acquire four-way admission; frozen inputs are untouched.
ALTER TABLE bb_workpaper_batches ADD COLUMN max_parallel smallint CHECK(max_parallel IS NULL OR max_parallel=4);
ALTER TABLE bb_project_file_batches ADD COLUMN max_parallel smallint CHECK(max_parallel IS NULL OR max_parallel=4);
ALTER TABLE bb_project_file_update_batches ADD COLUMN max_parallel smallint CHECK(max_parallel IS NULL OR max_parallel=4);
ALTER TABLE bb_workpaper_batches ALTER COLUMN max_parallel SET DEFAULT 4;
ALTER TABLE bb_project_file_batches ALTER COLUMN max_parallel SET DEFAULT 4;
ALTER TABLE bb_project_file_update_batches ALTER COLUMN max_parallel SET DEFAULT 4;
-- Execution policy is kept outside the public exact manifest: existing clients
-- use strict schema validation and must keep reading the same response format.
ALTER TABLE bb_project_qa_runs ADD COLUMN max_parallel smallint CHECK(max_parallel IS NULL OR max_parallel=4);
ALTER TABLE bb_project_qa_runs ALTER COLUMN max_parallel SET DEFAULT 4;
CREATE FUNCTION bb_qa_admission_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.max_parallel IS DISTINCT FROM OLD.max_parallel THEN
  RAISE EXCEPTION 'Frozen question admission policy changed' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_qa_admission_immutable BEFORE UPDATE ON bb_project_qa_runs FOR EACH ROW EXECUTE FUNCTION bb_qa_admission_immutable();
ALTER TABLE bb_workpaper_batches DROP CONSTRAINT bb_workpaper_progressive_shape;
ALTER TABLE bb_workpaper_batches ADD CONSTRAINT bb_workpaper_progressive_shape CHECK(progressive_plan IS NULL OR COALESCE((
 jsonb_typeof(progressive_plan->'chapters')='array' AND jsonb_array_length(progressive_plan->'chapters')>0
 AND jsonb_typeof(progressive_plan->'trial_item_ids')='array' AND jsonb_array_length(progressive_plan->'trial_item_ids') BETWEEN 1 AND 8
 AND progressive_plan->>'max_parallel' IN ('2','4')),false));

CREATE FUNCTION bb_batch_admission_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.max_parallel IS DISTINCT FROM OLD.max_parallel THEN
  RAISE EXCEPTION 'Frozen batch admission policy changed' USING ERRCODE='23514';
 END IF;
 IF TG_TABLE_NAME<>'bb_workpaper_batches' THEN
  IF jsonb_path_query_array(NEW.items,'$[*].manifest') IS DISTINCT FROM jsonb_path_query_array(OLD.items,'$[*].manifest')
   OR (to_jsonb(NEW)->'owner_user_id') IS DISTINCT FROM (to_jsonb(OLD)->'owner_user_id')
   OR (to_jsonb(NEW)->'project_id') IS DISTINCT FROM (to_jsonb(OLD)->'project_id')
   OR (to_jsonb(NEW)->'topic_id') IS DISTINCT FROM (to_jsonb(OLD)->'topic_id')
   OR (to_jsonb(NEW)->'request_id') IS DISTINCT FROM (to_jsonb(OLD)->'request_id')
   OR (to_jsonb(NEW)->'request_hash') IS DISTINCT FROM (to_jsonb(OLD)->'request_hash') THEN
   RAISE EXCEPTION 'Frozen batch membership changed' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_batch_admission_immutable BEFORE UPDATE ON bb_workpaper_batches FOR EACH ROW EXECUTE FUNCTION bb_batch_admission_immutable();
CREATE TRIGGER bb_batch_admission_immutable BEFORE UPDATE ON bb_project_file_batches FOR EACH ROW EXECUTE FUNCTION bb_batch_admission_immutable();
CREATE TRIGGER bb_batch_admission_immutable BEFORE UPDATE ON bb_project_file_update_batches FOR EACH ROW EXECUTE FUNCTION bb_batch_admission_immutable();

-- Exact host-created manifest + linked run OR exact pending child request key.
-- Merely claiming a batch ID in client input never grants a project mutex exception.
CREATE FUNCTION bb_batch_child_identity(owner_id text,project_id text,revision integer,run_id text,request_key text)
 RETURNS text[] LANGUAGE sql STABLE AS $$
 SELECT ARRAY['workpaper:'||b.id,i.item_id,COALESCE((b.progressive_plan->>'max_parallel')::smallint,b.max_parallel,1)::text]
 FROM bb_input_revisions input
 JOIN bb_workpaper_items i ON i.owner_user_id=input.owner_user_id AND i.manifest=input.manifest
 JOIN bb_workpaper_batches b ON b.owner_user_id=i.owner_user_id AND b.id=i.batch_id
 JOIN bb_m4_topics t ON t.owner_user_id=b.owner_user_id AND t.id=b.topic_id
 JOIN bb_projects p ON p.owner_user_id=t.owner_user_id AND p.id=t.project_id
 WHERE input.owner_user_id=$1 AND input.project_id=$2 AND input.revision=$3
 AND t.project_id=$2 AND t.source_project_id=b.project_id
 AND input.manifest->>'topic_id'=t.id AND input.manifest->>'kind'='document'
 AND input.manifest->>'execution_scope_project_id'=COALESCE(p.execution_scope_project_id,p.id)
 AND input.manifest->'input'->'workpaper'->>'batch_id'=b.id
 AND input.manifest->'input'->'workpaper'->'entry'->>'id'=i.item_id
 AND (i.run_id=$4 OR (i.run_id IS NULL AND i.state='queued' AND b.state IN ('queued','running')
  AND $5='workpaper:'||b.id||':'||i.item_id||':'||i.attempt
  AND (b.progressive_plan IS NULL OR b.progressive_phase='remaining'
   OR b.progressive_phase='trial' AND b.progressive_plan->'trial_item_ids' ? i.item_id
   OR b.progressive_phase='retry_failed' AND b.progressive_retry_items ? i.item_id)))
 UNION ALL
 SELECT ARRAY['generation:'||b.id,item.value->'manifest'->'input'->>'document_type',COALESCE(b.max_parallel,1)::text]
 FROM bb_input_revisions input JOIN bb_project_file_batches b ON b.owner_user_id=input.owner_user_id
 CROSS JOIN LATERAL jsonb_array_elements(b.items) WITH ORDINALITY item(value,ordinality)
 JOIN bb_m4_topics t ON t.owner_user_id=b.owner_user_id AND t.id=b.topic_id
 JOIN bb_projects p ON p.owner_user_id=t.owner_user_id AND p.id=t.project_id
 JOIN bb_project_file_workspaces workspace ON workspace.owner_user_id=b.owner_user_id AND workspace.project_id=b.project_id AND workspace.topic_id=b.topic_id
 WHERE input.owner_user_id=$1 AND input.project_id=$2 AND input.revision=$3
 AND input.manifest=item.value->'manifest' AND t.project_id=$2 AND (t.source_project_id=b.project_id OR t.project_id=b.project_id)
 AND input.manifest->>'topic_id'=t.id AND input.manifest->>'execution_scope_project_id'=COALESCE(p.execution_scope_project_id,p.id)
 AND (item.value->>'run_id'=$4 OR (item.value->>'run_id' IS NULL AND b.state IN ('queued','running')
 AND $5='project-files:'||b.id||':'||(item.ordinality-1)||':'||COALESCE(item.value->>'attempt','1')))
 UNION ALL
 SELECT ARRAY['patch:'||b.id,item.value->'manifest'->>'file_id',COALESCE(b.max_parallel,1)::text]
 FROM bb_input_revisions input JOIN bb_project_file_update_batches b ON b.owner_user_id=input.owner_user_id AND b.project_id=input.project_id
 CROSS JOIN LATERAL jsonb_array_elements(b.items) WITH ORDINALITY item(value,ordinality)
 WHERE input.owner_user_id=$1 AND input.project_id=$2 AND input.revision=$3 AND input.manifest=item.value->'manifest'
 AND input.manifest->>'operation'='patch' AND input.manifest->>'check_run_id'=b.check_run_id
 AND (item.value->>'run_id'=$4 OR (item.value->>'run_id' IS NULL AND b.state IN ('queued','running')
 AND $5='file-patch:'||b.id||':'||(item.ordinality-1)||':'||COALESCE(item.value->>'attempt','1')))
 LIMIT 1
$$;

-- Preserve every existing assessment/QA/check exception; replace only the exact
-- progressive child comparison and its cap with the more general frozen identity.
DO $$ DECLARE definition text; marker text; BEGIN
 SELECT pg_get_functiondef('bb_m3_project_run_mutex()'::regprocedure) INTO definition;
 -- All nonterminal states already occupy admission, including queued and paused.
 -- A progress/claim transition of the same admitted child cannot increase it.
 -- Re-locking the project here (after run/account locks) conflicts with sibling
 -- foreign-key key-share locks and creates a real account/project deadlock.
 -- Inserts, resurrection and changed identities still take the original mutex.
 marker:='BEGIN'||chr(10)||' IF NEW.task_kind=';
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'Unexpected batch mutex entry'; END IF;
 definition:=replace(definition,marker,$guard$BEGIN
 IF TG_OP='UPDATE' AND OLD.state NOT IN ('succeeded','test_completed','failed','cancelled','rejected')
  AND NEW.state NOT IN ('succeeded','test_completed','failed','cancelled','rejected')
  AND ROW(NEW.owner_user_id,NEW.project_id,NEW.input_revision,NEW.id,NEW.execution_request_id,NEW.task_kind)
   IS NOT DISTINCT FROM ROW(OLD.owner_user_id,OLD.project_id,OLD.input_revision,OLD.id,OLD.execution_request_id,OLD.task_kind)
 THEN RETURN NEW; END IF;
 IF NEW.task_kind=$guard$);
 marker:='PERFORM 1 FROM bb_projects WHERE owner_user_id=NEW.owner_user_id AND id=scope_id FOR UPDATE;';
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'Unexpected batch scope lock'; END IF;
 definition:=replace(definition,marker,replace(marker,'FOR UPDATE;','FOR NO KEY UPDATE;'));
 marker:='progressive:=bb_progressive_workpaper_identity(NEW.owner_user_id,NEW.project_id,NEW.input_revision,NEW.id);';
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'Unexpected batch mutex identity'; END IF;
 definition:=replace(definition,marker,'progressive:=bb_batch_child_identity(NEW.owner_user_id,NEW.project_id,NEW.input_revision,NEW.id,NEW.execution_request_id);');
 definition:=replace(definition,'bb_progressive_workpaper_identity(active.owner_user_id,active.project_id,active.input_revision,active.id)',
  'bb_batch_child_identity(active.owner_user_id,active.project_id,active.input_revision,active.id,active.execution_request_id)');
 definition:=replace(definition,'bb_progressive_workpaper_identity(r.owner_user_id,r.project_id,r.input_revision,r.id)',
  'bb_batch_child_identity(r.owner_user_id,r.project_id,r.input_revision,r.id,r.execution_request_id)');
 marker:=')>=2 THEN RAISE EXCEPTION';
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'Unexpected batch mutex cap'; END IF;
 definition:=replace(definition,marker,')>=progressive[3]::integer THEN RAISE EXCEPTION');
 definition:=replace(definition,'(project_kind=''review'' OR is_m4_scope)',
  '(project_kind=''review'' OR is_m4_scope OR EXISTS(SELECT 1 FROM bb_project_file_workspaces w JOIN bb_projects scope_project ON scope_project.owner_user_id=w.owner_user_id AND scope_project.id=w.project_id WHERE w.owner_user_id=NEW.owner_user_id AND COALESCE(scope_project.execution_scope_project_id,scope_project.id)=scope_id))');
 EXECUTE definition;
END $$;
