-- Upload is the user's source choice for unified updates. No tasks, blobs,
-- immutable inputs or charges are changed by this migration.
-- Preserve the selection revision even when the last unused upload is removed.
LOCK TABLE bb_projects IN EXCLUSIVE MODE;
ALTER TABLE bb_prospectus_selection ALTER COLUMN version_id DROP NOT NULL;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='bb_prospectus_selection_project_owner_fk') THEN
  ALTER TABLE bb_prospectus_selection ADD CONSTRAINT bb_prospectus_selection_project_owner_fk
   FOREIGN KEY(owner_user_id,project_id) REFERENCES bb_projects(owner_user_id,id);
 END IF;
END $$;

WITH missing AS (
 SELECT m.*,COALESCE((SELECT max(v.sequence) FROM bb_prospectus_versions v WHERE v.project_id=m.project_id),0)
  +row_number() OVER(PARTITION BY m.project_id ORDER BY m.persisted_at,m.id,m.version) AS sequence
 FROM bb_material_versions m JOIN bb_projects p ON p.id=m.project_id AND p.owner_user_id=m.owner_user_id
 WHERE p.kind='update' AND p.update_details->>'authoring_mode'='unified_v1' AND p.deleted_at IS NULL
  AND m.role='historical' AND m.deleted_at IS NULL AND NOT m.internal_template
  AND NOT EXISTS(SELECT 1 FROM bb_prospectus_versions v WHERE v.project_id=m.project_id AND v.material_id=m.id AND v.material_version=m.version)
)
INSERT INTO bb_prospectus_versions(id,owner_user_id,project_id,sequence,origin,filename,sha256,material_id,material_version,created_at)
 SELECT 'auto-upload:'||id||':'||version,owner_user_id,project_id,sequence,'upload',filename,sha256,id,version,persisted_at FROM missing;

-- Keep a valid selected upload and results already derived from a source.
-- Repair missing selections, uploads newer than an automatic result, and the
-- observed regression: a generated first draft despite an earlier saved source.
WITH candidates AS MATERIALIZED (
 SELECT p.owner_user_id,p.id AS project_id,latest.id AS version_id
 FROM bb_projects p
 JOIN LATERAL (SELECT v.* FROM bb_prospectus_versions v JOIN bb_material_versions m
   ON m.owner_user_id=v.owner_user_id AND m.id=v.material_id AND m.version=v.material_version
   WHERE v.owner_user_id=p.owner_user_id AND v.project_id=p.id AND v.origin='upload' AND m.deleted_at IS NULL
   ORDER BY v.created_at DESC,v.sequence DESC LIMIT 1) latest ON true
 LEFT JOIN bb_prospectus_selection s ON s.owner_user_id=p.owner_user_id AND s.project_id=p.id
 LEFT JOIN bb_prospectus_versions current ON current.owner_user_id=s.owner_user_id AND current.id=s.version_id
 LEFT JOIN bb_runs r ON r.owner_user_id=p.owner_user_id AND r.id=current.run_id
 LEFT JOIN bb_input_revisions i ON i.owner_user_id=r.owner_user_id AND i.project_id=r.project_id AND i.revision=r.input_revision
 WHERE p.kind='update' AND p.update_details->>'authoring_mode'='unified_v1' AND p.deleted_at IS NULL
  AND (s.version_id IS NULL OR (current.origin='generated' AND
    (latest.created_at>current.created_at OR
      (i.manifest#>>'{authoring,format_policy,mode}'='new_document'
       AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(i.manifest->'materials','[]'::jsonb)) m
         WHERE m->>'role' IN ('historical','reference'))))))
 FOR UPDATE OF p
), adopted AS (
 INSERT INTO bb_prospectus_selection(owner_user_id,project_id,version_id,revision)
 SELECT owner_user_id,project_id,version_id,1 FROM candidates
 ON CONFLICT(project_id) DO UPDATE SET version_id=EXCLUDED.version_id,revision=bb_prospectus_selection.revision+1
 RETURNING *
), updated AS (
 UPDATE bb_projects p SET draft_revision=p.draft_revision+1,updated_at=now(),update_details=p.update_details-'format_template'
 FROM adopted a WHERE p.owner_user_id=a.owner_user_id AND p.id=a.project_id RETURNING p.id
)
INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload)
 SELECT 'auto-adopt-upload-20261031:'||a.project_id,a.owner_user_id,'project',a.project_id,'prospectus.current_changed',
  jsonb_build_object('version_id',a.version_id,'reason','automatic_uploaded_source') FROM adopted a;
