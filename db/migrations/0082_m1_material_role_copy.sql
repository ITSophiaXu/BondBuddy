-- A reserved upload makes a copied object discoverable after a process crash.
-- Pending reservations may be retried even after normal orphan-upload cleanup.
CREATE TABLE bb_material_role_copy_receipts (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL,
  project_id text NOT NULL,
  request_key text NOT NULL,
  request_hash char(64) NOT NULL,
  source_material_id text NOT NULL,
  source_material_version integer NOT NULL,
  source_sha256 char(64) NOT NULL,
  target_role text NOT NULL CHECK (target_role = 'historical'),
  upload_id text NOT NULL,
  material_id text,
  material_version integer NOT NULL DEFAULT 1 CHECK (material_version = 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (owner_user_id, project_id, request_key),
  UNIQUE (upload_id),
  UNIQUE (material_id),
  FOREIGN KEY (owner_user_id, project_id) REFERENCES bb_projects(owner_user_id, id),
  FOREIGN KEY (owner_user_id, project_id, source_material_id, source_material_version)
    REFERENCES bb_material_versions(owner_user_id, project_id, id, version),
  FOREIGN KEY (owner_user_id, upload_id) REFERENCES bb_uploads(owner_user_id, id),
  FOREIGN KEY (owner_user_id, project_id, material_id, material_version)
    REFERENCES bb_material_versions(owner_user_id, project_id, id, version),
  CHECK ((material_id IS NULL AND completed_at IS NULL) OR
         (material_id IS NOT NULL AND completed_at IS NOT NULL))
);

CREATE FUNCTION bb_guard_material_role_copy_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'material role copy receipt is retained' USING ERRCODE='23514';
  END IF;
  IF OLD.completed_at IS NOT NULL OR NEW.id IS DISTINCT FROM OLD.id
    OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.request_key IS DISTINCT FROM OLD.request_key
    OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
    OR NEW.source_material_id IS DISTINCT FROM OLD.source_material_id
    OR NEW.source_material_version IS DISTINCT FROM OLD.source_material_version
    OR NEW.source_sha256 IS DISTINCT FROM OLD.source_sha256
    OR NEW.target_role IS DISTINCT FROM OLD.target_role
    OR NEW.material_version IS DISTINCT FROM OLD.material_version
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR (NEW.upload_id IS DISTINCT FROM OLD.upload_id AND OLD.material_id IS NOT NULL)
  THEN RAISE EXCEPTION 'material role copy receipt is immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bb_material_role_copy_receipt_guard BEFORE UPDATE OR DELETE ON bb_material_role_copy_receipts
  FOR EACH ROW EXECUTE FUNCTION bb_guard_material_role_copy_receipt();
