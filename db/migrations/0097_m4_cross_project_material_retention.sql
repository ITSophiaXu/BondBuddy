-- M4 input revisions belong to a topic project but may name original bytes in
-- another owned project, including broker templates and QA citations. Keep those
-- exact bytes until the referencing run ends; draft-only references do not pin.
CREATE OR REPLACE FUNCTION bb_material_bytes_pinned(p_owner text, p_project text, p_material text, p_version integer)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM bb_projects p
    JOIN bb_input_revisions i ON i.owner_user_id=p.owner_user_id AND i.project_id=p.id
    JOIN bb_runs r ON r.owner_user_id=i.owner_user_id AND r.project_id=i.project_id AND r.input_revision=i.revision
    WHERE p.owner_user_id=p_owner AND p.id=p_project AND p.deleted_at IS NULL
      AND r.state NOT IN ('succeeded','test_completed','failed','cancelled','rejected')
      -- M4 pins always carry an explicit source project. Do not let the legacy
      -- implicit-local-project interpretation broaden those exact references.
      AND NOT EXISTS (SELECT 1 FROM bb_m4_executions e WHERE e.owner_user_id=r.owner_user_id AND e.run_id=r.id)
      AND (i.material_versions @> jsonb_build_array(jsonb_build_object('material_id',p_material,'material_version',p_version))
        OR i.manifest->'materials' @> jsonb_build_array(jsonb_build_object('material_id',p_material,'material_version',p_version)))
  ) OR EXISTS (
    SELECT 1 FROM bb_m4_executions e
    JOIN bb_runs r ON r.owner_user_id=e.owner_user_id AND r.id=e.run_id
    JOIN bb_projects p ON p.owner_user_id=r.owner_user_id AND p.id=r.project_id
    JOIN bb_input_revisions i ON i.owner_user_id=r.owner_user_id AND i.project_id=r.project_id AND i.revision=r.input_revision
    JOIN bb_jobs j ON j.owner_user_id=r.owner_user_id AND j.run_id=r.id
    JOIN bb_material_versions m ON m.owner_user_id=e.owner_user_id
      AND m.project_id=p_project AND m.id=p_material AND m.version=p_version
    WHERE e.owner_user_id=p_owner AND p.deleted_at IS NULL
      AND r.state NOT IN ('succeeded','test_completed','failed','cancelled','rejected')
      AND e.input_hash=r.input_hash AND i.input_hash=r.input_hash AND e.manifest=i.manifest
      AND ((r.task_kind='generation' AND j.subtype='m4_document_v1' AND e.manifest->>'version'='m4-document-input-v1')
        OR (r.task_kind='qa' AND j.subtype='m4_qa_v1' AND e.manifest->>'version'='m4-qa-input-v1'))
      AND i.material_versions @> jsonb_build_array(jsonb_build_object(
        'source_project_id',p_project,'material_id',p_material,'material_version',p_version,'sha256',btrim(m.sha256::text)))
  )
$$;
