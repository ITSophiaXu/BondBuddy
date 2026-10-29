-- Ordinary associated files require the same host extraction/coverage evidence
-- as workpapers. Preserve existing immutable records and the old read name.
ALTER TABLE bb_workpaper_check_evidence RENAME TO bb_project_file_check_evidence;
CREATE VIEW bb_workpaper_check_evidence AS SELECT * FROM bb_project_file_check_evidence;

CREATE OR REPLACE FUNCTION bb_project_file_check_delivery_ready(r bb_runs) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM bb_project_file_operations o WHERE o.run_id=r.id AND o.owner_user_id=r.owner_user_id AND o.operation='check'
 AND o.result IS NOT NULL AND o.result_hash IS NOT NULL AND o.result->>'version'='project-file-check-v1'
 AND jsonb_array_length(o.result->'files')=jsonb_array_length(o.manifest->'files')
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(o.manifest->'files') f WHERE NOT EXISTS(
   SELECT 1 FROM jsonb_array_elements(o.result->'files') delivered WHERE delivered->>'file_version_id'=f->>'file_version_id'))
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(o.manifest->'files') target
   WHERE NOT EXISTS(SELECT 1 FROM bb_project_file_check_evidence e WHERE e.owner_user_id=r.owner_user_id AND e.run_id=r.id
     AND e.file_version_id=target->>'file_version_id' AND e.input_hash=r.input_hash
     AND trim(e.source_sha256)=o.manifest#>>'{source,asset,pin,sha256}'
     AND trim(e.target_sha256)=target#>>'{asset,pin,sha256}' AND e.checked_spans=e.total_spans AND e.total_spans>0)));
$$;
