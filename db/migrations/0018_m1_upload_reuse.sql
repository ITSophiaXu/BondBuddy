-- A completion receipt resolves a redundant staging upload to an immutable material.
-- Its staging Blob remains received and follows the existing orphan retention policy.
CREATE TABLE bb_upload_reuse_receipts (
  upload_id text PRIMARY KEY,
  owner_user_id text NOT NULL,
  project_id text NOT NULL,
  material_id text NOT NULL,
  material_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(owner_user_id,upload_id) REFERENCES bb_uploads(owner_user_id,id),
  FOREIGN KEY(owner_user_id,project_id,material_id,material_version)
    REFERENCES bb_material_versions(owner_user_id,project_id,id,version)
);
CREATE FUNCTION bb_guard_upload_reuse() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM bb_uploads u JOIN bb_material_versions m
      ON m.owner_user_id=u.owner_user_id AND m.project_id=u.project_id
    WHERE u.id=NEW.upload_id AND u.owner_user_id=NEW.owner_user_id AND u.project_id=NEW.project_id
      AND u.state='received' AND u.received_sha256=u.sha256 AND u.received_bytes=u.byte_size
      AND m.id=NEW.material_id AND m.version=NEW.material_version AND m.deleted_at IS NULL
      AND m.upload_id<>u.id AND m.role=u.role AND m.sha256=u.sha256
      AND m.byte_size=u.byte_size AND m.media_type=u.declared_media_type
  ) THEN RAISE EXCEPTION 'invalid upload reuse receipt' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bb_upload_reuse_guard BEFORE INSERT ON bb_upload_reuse_receipts
  FOR EACH ROW EXECUTE FUNCTION bb_guard_upload_reuse();
CREATE TRIGGER bb_upload_reuse_immutable BEFORE UPDATE OR DELETE ON bb_upload_reuse_receipts
  FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();
-- Nonunique: existing material versions and historical duplicates are never rewritten.
CREATE INDEX bb_material_reuse_idx ON bb_material_versions(owner_user_id,project_id,role,sha256)
  WHERE deleted_at IS NULL;
