-- Preserve existing upload and delivered Word provenance. No blob rewrite or task creation.
-- Append to any versions already created during a rolling upgrade.
WITH candidates AS (
 SELECT 'legacy-upload:'||m.id||':'||m.version AS id,m.owner_user_id,m.project_id,
  'upload'::text AS origin,m.filename,m.sha256,m.id AS material_id,m.version AS material_version,
  NULL::text AS artifact_id,NULL::integer AS artifact_version,NULL::text AS revision_artifact_id,
  NULL::text AS run_id,m.persisted_at AS created_at
 FROM bb_material_versions m JOIN bb_projects p ON p.id=m.project_id AND p.owner_user_id=m.owner_user_id
 WHERE p.kind='update' AND p.deleted_at IS NULL AND m.deleted_at IS NULL AND m.role='historical'
  AND NOT EXISTS(SELECT 1 FROM bb_prospectus_versions v WHERE v.project_id=m.project_id AND v.material_id=m.id AND v.material_version=m.version)
 UNION ALL
 SELECT 'legacy-generated:'||r.id,r.owner_user_id,r.project_id,'generated','募集说明书清洁版.docx',
  a.sha256,NULL::text,NULL::integer,a.id,a.version,rev.id,r.id,a.created_at
 FROM bb_runs r JOIN bb_projects p ON p.id=r.project_id AND p.owner_user_id=r.owner_user_id
 JOIN bb_jobs j ON j.run_id=r.id AND j.owner_user_id=r.owner_user_id
 JOIN LATERAL (SELECT a.* FROM bb_artifact_versions a
  WHERE a.id=j.checkpoint#>>'{stages,word_delivery_pair,clean_artifact_id}' AND a.owner_user_id=r.owner_user_id AND a.run_id=r.id
  ORDER BY a.version DESC LIMIT 1) a ON true
 JOIN LATERAL (SELECT rev.* FROM bb_artifact_versions rev
  WHERE rev.id=j.checkpoint#>>'{stages,word_delivery_pair,revision_artifact_id}' AND rev.owner_user_id=r.owner_user_id AND rev.run_id=r.id
  ORDER BY rev.version DESC LIMIT 1) rev ON true
 WHERE p.kind='update' AND p.deleted_at IS NULL AND r.task_kind='update' AND r.channel='production' AND r.state='succeeded'
  AND a.quality_status='passed' AND a.delivery_status='available' AND rev.quality_status='passed' AND rev.delivery_status='available'
  AND NOT EXISTS(SELECT 1 FROM bb_prospectus_versions v WHERE v.project_id=r.project_id AND v.run_id=r.id)
), numbered AS (
 SELECT c.*,COALESCE((SELECT max(v.sequence) FROM bb_prospectus_versions v WHERE v.project_id=c.project_id),0)
  +row_number() OVER(PARTITION BY c.project_id ORDER BY c.created_at,c.id) AS sequence FROM candidates c
)
INSERT INTO bb_prospectus_versions(id,owner_user_id,project_id,sequence,origin,filename,sha256,material_id,material_version,artifact_id,artifact_version,revision_artifact_id,run_id,created_at)
 SELECT id,owner_user_id,project_id,sequence,origin,filename,sha256,material_id,material_version,artifact_id,artifact_version,revision_artifact_id,run_id,created_at FROM numbered;

-- Existing drafts may contain several unrelated references. Do not silently choose one.
-- A completed generated pair is an unambiguous default; explicit user selections always win.
INSERT INTO bb_prospectus_selection(owner_user_id,project_id,version_id,revision)
 SELECT DISTINCT ON(v.project_id) v.owner_user_id,v.project_id,v.id,1
 FROM bb_prospectus_versions v WHERE v.origin='generated'
  AND NOT EXISTS(SELECT 1 FROM bb_prospectus_selection s WHERE s.project_id=v.project_id)
 ORDER BY v.project_id,v.created_at DESC,v.sequence DESC;
