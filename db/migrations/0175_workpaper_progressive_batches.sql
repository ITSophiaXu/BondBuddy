-- New batches freeze chapter order and trial membership separately from runtime state.
-- Historical batches retain NULL and keep their existing sequential behavior.
ALTER TABLE bb_workpaper_batches DROP CONSTRAINT bb_workpaper_batches_pause_reason_check;
ALTER TABLE bb_workpaper_batches ADD CONSTRAINT bb_workpaper_batches_pause_reason_check
 CHECK(pause_reason IS NULL OR pause_reason IN ('credits_insufficient','shared_blocked'));
ALTER TABLE bb_workpaper_batches
 ADD COLUMN progressive_plan jsonb,
 ADD COLUMN progressive_phase text CHECK(progressive_phase IN ('trial','awaiting_confirmation','remaining','retry_failed')),
 ADD COLUMN progressive_retry_items jsonb,
 ADD COLUMN progressive_retry_return_phase text CHECK(progressive_retry_return_phase IN ('awaiting_confirmation','remaining','cancelled')),
 ADD CONSTRAINT bb_workpaper_progressive_presence CHECK((progressive_plan IS NULL)=(progressive_phase IS NULL)),
 ADD CONSTRAINT bb_workpaper_progressive_shape CHECK(progressive_plan IS NULL OR COALESCE((
   jsonb_typeof(progressive_plan->'chapters')='array' AND jsonb_array_length(progressive_plan->'chapters')>0
   AND jsonb_typeof(progressive_plan->'trial_item_ids')='array' AND jsonb_array_length(progressive_plan->'trial_item_ids') BETWEEN 1 AND 8
   AND progressive_plan->>'max_parallel'='2'),false));

CREATE FUNCTION bb_workpaper_progressive_plan_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.progressive_plan IS DISTINCT FROM OLD.progressive_plan THEN
  RAISE EXCEPTION 'Workpaper chapter and trial selection is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_workpaper_progressive_plan_guard BEFORE UPDATE ON bb_workpaper_batches
 FOR EACH ROW EXECUTE FUNCTION bb_workpaper_progressive_plan_guard();

CREATE TABLE bb_workpaper_continuations (
 owner_user_id text NOT NULL,request_id text NOT NULL,batch_id text NOT NULL,request_hash char(64) NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(owner_user_id,request_id),
 FOREIGN KEY(owner_user_id,batch_id) REFERENCES bb_workpaper_batches(owner_user_id,id)
);
CREATE TRIGGER bb_workpaper_continuation_immutable BEFORE UPDATE OR DELETE ON bb_workpaper_continuations
 FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();

-- Match both incoming and existing runs to the host-created immutable manifest.
-- Input JSON merely claiming a batch_id never grants the concurrency exception.
CREATE FUNCTION bb_progressive_workpaper_identity(owner_id text,project_id text,revision integer,run_id text)
 RETURNS text[] LANGUAGE sql STABLE AS $$
 SELECT ARRAY[b.id,i.item_id] FROM bb_input_revisions input
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
  AND b.progressive_plan IS NOT NULL
  AND (i.run_id=$4 OR (i.run_id IS NULL AND i.state='queued' AND b.state IN ('queued','running')
    AND (b.progressive_phase='remaining'
      OR b.progressive_phase='trial' AND b.progressive_plan->'trial_item_ids' ? i.item_id
      OR b.progressive_phase='retry_failed' AND b.progressive_retry_items ? i.item_id)))
 LIMIT 1
$$;

-- Keep all existing QA/inspection exceptions, and relax the canonical mutex only
-- for two different files in the same frozen progressive batch.
DO $$ DECLARE definition text; marker text; BEGIN
 SELECT pg_get_functiondef('bb_m3_project_run_mutex()'::regprocedure) INTO definition;
 marker:='DECLARE project_kind text; scope_id text; is_m4_scope boolean;';
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'Unexpected canonical run mutex declarations'; END IF;
 definition:=replace(definition,marker,marker||' progressive text[];');
 marker:='IF (project_kind=''review'' OR is_m4_scope) AND EXISTS (';
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'Unexpected canonical run mutex body'; END IF;
 definition:=replace(definition,marker,$guard$
 progressive:=bb_progressive_workpaper_identity(NEW.owner_user_id,NEW.project_id,NEW.input_revision,NEW.id);
 IF progressive IS NOT NULL AND (
  SELECT count(*) FROM bb_runs active JOIN bb_projects scope_project ON scope_project.owner_user_id=active.owner_user_id AND scope_project.id=active.project_id
  WHERE active.owner_user_id=NEW.owner_user_id AND COALESCE(scope_project.execution_scope_project_id,scope_project.id)=scope_id
   AND active.id<>NEW.id AND active.task_kind<>'qa' AND active.state NOT IN ('succeeded','test_completed','failed','cancelled','rejected')
   AND (bb_progressive_workpaper_identity(active.owner_user_id,active.project_id,active.input_revision,active.id))[1]=progressive[1]
 )>=2 THEN RAISE EXCEPTION 'Progressive workpaper concurrency limit reached' USING ERRCODE='23514'; END IF;
 IF (project_kind='review' OR is_m4_scope) AND EXISTS ($guard$);
 marker:='AND NOT bb_is_workpaper_assessment(r.owner_user_id,r.project_id,r.input_revision)';
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'Unexpected canonical run mutex peers'; END IF;
 definition:=replace(definition,marker,marker||$guard$
 AND NOT COALESCE(progressive[1]=(bb_progressive_workpaper_identity(r.owner_user_id,r.project_id,r.input_revision,r.id))[1]
  AND progressive[2]<>(bb_progressive_workpaper_identity(r.owner_user_id,r.project_id,r.input_revision,r.id))[2],false)$guard$);
 EXECUTE definition;
END $$;
