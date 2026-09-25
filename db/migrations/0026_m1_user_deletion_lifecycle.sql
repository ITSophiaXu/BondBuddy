-- #6 user deletion lifecycle. Builds on the 0006 storage tombstones and the 0021 log-content purge:
-- a deleted project releases its snapshot pins, and derived content (parse evidence text, OCR objects,
-- orphaned parse cache, Word artifacts) is purged after the configured window. Audit/cost metadata stays.

-- Project deletion is irreversible, like material deletion (0006).
CREATE FUNCTION bb_reject_project_delete_reversal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
   RAISE EXCEPTION 'deleted projects cannot be restored or have their deletion time rewritten' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_project_deletion_is_irreversible
  BEFORE UPDATE OF deleted_at ON bb_projects
  FOR EACH ROW EXECUTE FUNCTION bb_reject_project_delete_reversal();

-- Single pin rule shared by the storage lifecycle queries. A deleted material's bytes stay only while
-- its project is live and a run that is not terminal still executes an input revision naming it.
-- Terminal runs keep input_hash/sha256 metadata for audit; they do not keep user-deleted bytes.
CREATE FUNCTION bb_material_bytes_pinned(p_owner text, p_project text, p_material text, p_version integer)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1
      FROM bb_projects p
      JOIN bb_input_revisions i ON i.owner_user_id=p.owner_user_id AND i.project_id=p.id
      JOIN bb_runs r ON r.owner_user_id=i.owner_user_id AND r.project_id=i.project_id AND r.input_revision=i.revision
     WHERE p.owner_user_id=p_owner AND p.id=p_project AND p.deleted_at IS NULL
       AND r.state NOT IN ('succeeded','failed','cancelled','rejected')
       AND (
         i.material_versions @> jsonb_build_array(jsonb_build_object('material_id',p_material,'material_version',p_version))
         OR i.manifest->'materials' @> jsonb_build_array(jsonb_build_object('material_id',p_material,'material_version',p_version))
       )
  )
$$;

-- One append-only receipt per purged subject. Counts are the audit record; no content is kept.
CREATE TABLE bb_deleted_content_purges (
 id text PRIMARY KEY,
 owner_user_id text NOT NULL,
 project_id text NOT NULL,
 subject_kind text NOT NULL CHECK (subject_kind IN ('material_version','project')),
 material_id text,
 material_version integer,
 storage_tombstone_id text UNIQUE REFERENCES bb_storage_tombstones(id),
 parse_evidence_rows integer NOT NULL DEFAULT 0 CHECK (parse_evidence_rows>=0),
 ocr_objects integer NOT NULL DEFAULT 0 CHECK (ocr_objects>=0),
 parse_cache_objects integer NOT NULL DEFAULT 0 CHECK (parse_cache_objects>=0),
 artifact_objects integer NOT NULL DEFAULT 0 CHECK (artifact_objects>=0),
 policy_version text NOT NULL CHECK (length(policy_version)>0),
 purged_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (owner_user_id,project_id) REFERENCES bb_projects(owner_user_id,id),
 FOREIGN KEY (owner_user_id,project_id,material_id,material_version)
   REFERENCES bb_material_versions(owner_user_id,project_id,id,version),
 CHECK ((subject_kind='material_version' AND material_id IS NOT NULL AND material_version IS NOT NULL AND storage_tombstone_id IS NOT NULL)
     OR (subject_kind='project' AND material_id IS NULL AND material_version IS NULL AND storage_tombstone_id IS NULL))
);
CREATE UNIQUE INDEX bb_deleted_content_purges_project_key
  ON bb_deleted_content_purges(owner_user_id,project_id) WHERE subject_kind='project';
CREATE FUNCTION bb_reject_deleted_content_purge_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'deleted content purge receipts are append-only' USING ERRCODE='23514'; END $$;
CREATE TRIGGER bb_deleted_content_purge_immutable BEFORE UPDATE OR DELETE ON bb_deleted_content_purges
  FOR EACH ROW EXECUTE FUNCTION bb_reject_deleted_content_purge_rewrite();

-- Parse evidence rows carry literal material text. They stay immutable, except that the purge job may
-- delete rows of a material version whose storage tombstone has already purged the original bytes.
-- Snapshot headers (hashes, counts, parser version) remain as audit metadata.
CREATE OR REPLACE FUNCTION bb_reject_parse_snapshot_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='bb_parse_evidence' AND TG_OP='DELETE'
    AND current_setting('bb.deleted_content_purge', true)='on'
    AND EXISTS (
      SELECT 1 FROM bb_material_versions m
        JOIN bb_storage_tombstones t ON t.object_kind='material' AND t.owner_user_id=m.owner_user_id
         AND t.material_id=m.id AND t.material_version=m.version AND t.state='purged'
       WHERE m.owner_user_id=OLD.owner_user_id AND m.project_id=OLD.project_id
         AND m.id=OLD.material_id AND m.version=OLD.material_version AND m.deleted_at IS NOT NULL) THEN
   RETURN OLD;
 END IF;
 RAISE EXCEPTION 'parse evidence snapshots are immutable' USING ERRCODE='23514';
END $$;

COMMENT ON TABLE bb_deleted_content_purges IS
  'Receipts for user-deleted derived content purged after the configured window; counts only, never content.';
