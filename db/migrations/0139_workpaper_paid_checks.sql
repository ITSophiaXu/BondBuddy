-- One explicit batch instruction, one immutable scope and reservation per file.
CREATE TABLE bb_workpaper_paid_check_batches (
 id text PRIMARY KEY,owner_user_id text NOT NULL,project_id text NOT NULL,workpaper_batch_id text NOT NULL,
 request_id text NOT NULL,request_hash char(64) NOT NULL,source jsonb NOT NULL,points bigint NOT NULL CHECK(points>=0),
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(owner_user_id,id),UNIQUE(owner_user_id,request_id),
 FOREIGN KEY(owner_user_id,project_id) REFERENCES bb_projects(owner_user_id,id),
 FOREIGN KEY(owner_user_id,workpaper_batch_id) REFERENCES bb_workpaper_batches(owner_user_id,id)
);
CREATE TABLE bb_workpaper_paid_check_items (
 owner_user_id text NOT NULL,batch_id text NOT NULL,ordinal integer NOT NULL,item_id text NOT NULL,file_version_id text NOT NULL,
 run_id text NOT NULL,scope_quote_id text,points bigint NOT NULL CHECK(points>=0),
 PRIMARY KEY(batch_id,ordinal),UNIQUE(batch_id,file_version_id),UNIQUE(owner_user_id,run_id),
 FOREIGN KEY(owner_user_id,batch_id) REFERENCES bb_workpaper_paid_check_batches(owner_user_id,id),
 FOREIGN KEY(owner_user_id,file_version_id) REFERENCES bb_project_file_versions(owner_user_id,id),
 FOREIGN KEY(owner_user_id,run_id) REFERENCES bb_runs(owner_user_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(owner_user_id,scope_quote_id) REFERENCES bb_scope_quotations(owner_user_id,id)
);
CREATE TRIGGER bb_workpaper_paid_check_batch_immutable BEFORE UPDATE OR DELETE ON bb_workpaper_paid_check_batches
 FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();
CREATE TRIGGER bb_workpaper_paid_check_item_immutable BEFORE UPDATE OR DELETE ON bb_workpaper_paid_check_items
 FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();

-- Independent checks in the same already-frozen batch may execute together.
-- An unrelated run or another batch continues to hold the canonical mutex.
DO $$ DECLARE definition text; marker text := 'AND NOT bb_is_workpaper_assessment(r.owner_user_id,r.project_id,r.input_revision)';
BEGIN
 SELECT pg_get_functiondef('bb_m3_project_run_mutex()'::regprocedure) INTO definition;
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'Unexpected canonical run mutex'; END IF;
 EXECUTE replace(definition,marker,marker||$guard$
 AND NOT EXISTS(SELECT 1 FROM bb_workpaper_paid_check_items existing
 JOIN bb_workpaper_paid_check_items incoming ON incoming.owner_user_id=existing.owner_user_id AND incoming.batch_id=existing.batch_id
 WHERE existing.owner_user_id=r.owner_user_id AND existing.run_id=r.id AND incoming.run_id=NEW.id)$guard$);
END $$;

-- The host records real extraction/coverage verification; a generic manual-only
-- fallback report is not evidence that an entire workpaper was checked.
CREATE TABLE bb_workpaper_check_evidence (
 owner_user_id text NOT NULL,run_id text NOT NULL,file_version_id text NOT NULL,input_hash char(64) NOT NULL,
 source_sha256 char(64) NOT NULL,target_sha256 char(64) NOT NULL,checked_spans integer NOT NULL,total_spans integer NOT NULL,
 PRIMARY KEY(run_id,file_version_id),CHECK(checked_spans=total_spans AND total_spans>0),
 FOREIGN KEY(owner_user_id,run_id) REFERENCES bb_runs(owner_user_id,id),
 FOREIGN KEY(owner_user_id,file_version_id) REFERENCES bb_project_file_versions(owner_user_id,id)
);
CREATE TRIGGER bb_workpaper_check_evidence_immutable BEFORE UPDATE OR DELETE ON bb_workpaper_check_evidence
 FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();
CREATE OR REPLACE FUNCTION bb_project_file_check_delivery_ready(r bb_runs) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM bb_project_file_operations o WHERE o.run_id=r.id AND o.owner_user_id=r.owner_user_id AND o.operation='check'
 AND o.result IS NOT NULL AND o.result_hash IS NOT NULL AND o.result->>'version'='project-file-check-v1'
 AND jsonb_array_length(o.result->'files')=jsonb_array_length(o.manifest->'files')
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(o.manifest->'files') f WHERE NOT EXISTS(
   SELECT 1 FROM jsonb_array_elements(o.result->'files') delivered WHERE delivered->>'file_version_id'=f->>'file_version_id'))
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(o.manifest->'files') target
   JOIN bb_project_file_versions v ON v.owner_user_id=r.owner_user_id AND v.id=target->>'file_version_id'
   JOIN bb_project_files family ON family.owner_user_id=v.owner_user_id AND family.id=v.file_id AND family.document_type='workpaper'
   WHERE NOT EXISTS(SELECT 1 FROM bb_workpaper_check_evidence e WHERE e.owner_user_id=r.owner_user_id AND e.run_id=r.id
     AND e.file_version_id=v.id AND e.input_hash=r.input_hash
     AND trim(e.source_sha256)=o.manifest#>>'{source,asset,pin,sha256}'
     AND trim(e.target_sha256)=target#>>'{asset,pin,sha256}' AND e.checked_spans=e.total_spans AND e.total_spans>0)));
$$;
