-- #8 storage lifecycle. Deletion is represented durably before private Blob bytes can be removed.
ALTER TABLE bb_uploads DROP CONSTRAINT bb_uploads_state_check;
ALTER TABLE bb_uploads ADD CONSTRAINT bb_uploads_state_check
  CHECK (state IN ('uploading','received','completed','deleting','purged'));

ALTER TABLE bb_material_versions
  ADD CONSTRAINT bb_material_owner_project_version_key
  UNIQUE (owner_user_id,project_id,id,version);

CREATE TABLE bb_storage_tombstones (
 id text PRIMARY KEY,
 owner_user_id text NOT NULL,
 project_id text NOT NULL,
 object_kind text NOT NULL CHECK (object_kind IN ('material','orphan_upload')),
 material_id text,
 material_version integer,
 upload_id text,
 object_key text NOT NULL UNIQUE,
 sha256 char(64) NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
 state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','claimed','purged')),
 requested_at timestamptz NOT NULL DEFAULT now(),
 eligible_at timestamptz,
 attempts integer NOT NULL DEFAULT 0 CHECK (attempts>=0),
 claim_token text,
 lease_until timestamptz,
 retry_after timestamptz,
 last_error_code text CHECK (last_error_code IS NULL OR last_error_code IN ('pin_check_failed','blob_read_failed','blob_delete_failed','blob_hash_mismatch','purge_attempt_failed','blob_io_failed')),
 purged_at timestamptz,
 FOREIGN KEY (owner_user_id,project_id) REFERENCES bb_projects(owner_user_id,id),
 FOREIGN KEY (owner_user_id,project_id,material_id,material_version)
   REFERENCES bb_material_versions(owner_user_id,project_id,id,version),
 FOREIGN KEY (owner_user_id,upload_id) REFERENCES bb_uploads(owner_user_id,id),
 CHECK ((object_kind='material' AND material_id IS NOT NULL AND material_version IS NOT NULL AND upload_id IS NULL)
     OR (object_kind='orphan_upload' AND material_id IS NULL AND material_version IS NULL AND upload_id IS NOT NULL)),
 CHECK ((claim_token IS NULL) = (lease_until IS NULL)),
 CHECK ((state='claimed') = (claim_token IS NOT NULL)),
 CHECK ((state='purged') = (purged_at IS NOT NULL)),
 CHECK (object_key LIKE ('users/' || owner_user_id || '/projects/' || project_id || '/%'))
);
CREATE INDEX bb_storage_tombstones_ready_idx
  ON bb_storage_tombstones(eligible_at,retry_after,requested_at,id)
  WHERE state IN ('pending','claimed');
CREATE INDEX bb_uploads_expired_cleanup_idx
  ON bb_uploads(expires_at,id) WHERE state IN ('uploading','received');
CREATE INDEX bb_input_revisions_material_refs_idx
  ON bb_input_revisions USING gin(material_versions jsonb_path_ops);
CREATE INDEX bb_input_revisions_manifest_material_refs_idx
  ON bb_input_revisions USING gin ((manifest->'materials') jsonb_path_ops);

CREATE FUNCTION bb_guard_upload_storage_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.state=OLD.state
    OR (OLD.state='uploading' AND NEW.state IN ('received','deleting'))
    OR (OLD.state='received' AND NEW.state IN ('completed','deleting'))
    OR (OLD.state='deleting' AND NEW.state='purged') THEN
   RETURN NEW;
 END IF;
 RAISE EXCEPTION 'upload storage state transition is not allowed' USING ERRCODE='23514';
END $$;
CREATE TRIGGER bb_upload_storage_state_guard
  BEFORE UPDATE OF state ON bb_uploads
  FOR EACH ROW EXECUTE FUNCTION bb_guard_upload_storage_state();

CREATE FUNCTION bb_validate_storage_tombstone_target() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target RECORD;
BEGIN
 IF NEW.object_kind='material' THEN
   SELECT owner_user_id,project_id,deleted_at,object_key,sha256 INTO target
     FROM bb_material_versions
    WHERE owner_user_id=NEW.owner_user_id AND project_id=NEW.project_id
      AND id=NEW.material_id AND version=NEW.material_version;
   IF NOT FOUND OR target.deleted_at IS NULL OR target.object_key IS DISTINCT FROM NEW.object_key
      OR lower(btrim(target.sha256::text)) IS DISTINCT FROM lower(btrim(NEW.sha256::text)) THEN
     RAISE EXCEPTION 'storage tombstone does not match a deleted material version' USING ERRCODE='23514';
   END IF;
 ELSE
   SELECT owner_user_id,project_id,state,object_key,sha256 INTO target
     FROM bb_uploads
    WHERE owner_user_id=NEW.owner_user_id AND project_id=NEW.project_id AND id=NEW.upload_id;
   IF NOT FOUND OR target.state<>'deleting' OR target.object_key IS DISTINCT FROM NEW.object_key
      OR lower(btrim(target.sha256::text)) IS DISTINCT FROM lower(btrim(NEW.sha256::text))
      OR EXISTS (SELECT 1 FROM bb_material_versions m WHERE m.owner_user_id=NEW.owner_user_id AND m.upload_id=NEW.upload_id) THEN
     RAISE EXCEPTION 'storage tombstone does not match an orphan upload' USING ERRCODE='23514';
   END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_storage_tombstone_target_valid
  BEFORE INSERT ON bb_storage_tombstones FOR EACH ROW EXECUTE FUNCTION bb_validate_storage_tombstone_target();

CREATE FUNCTION bb_reject_material_delete_reversal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
   RAISE EXCEPTION 'deleted material versions cannot be restored or have their deletion time rewritten' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_material_deletion_is_irreversible
  BEFORE UPDATE OF deleted_at ON bb_material_versions
  FOR EACH ROW EXECUTE FUNCTION bb_reject_material_delete_reversal();

CREATE FUNCTION bb_record_material_storage_tombstone() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
   INSERT INTO bb_storage_tombstones
     (id,owner_user_id,project_id,object_kind,material_id,material_version,object_key,sha256,requested_at)
   VALUES ('material-' || md5(NEW.owner_user_id || ':' || NEW.id || ':' || NEW.version::text),
     NEW.owner_user_id,NEW.project_id,'material',NEW.id,NEW.version,NEW.object_key,lower(btrim(NEW.sha256::text)),NEW.deleted_at)
   ON CONFLICT (object_key) DO NOTHING;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_material_deletion_creates_storage_tombstone
  AFTER UPDATE OF deleted_at ON bb_material_versions
  FOR EACH ROW EXECUTE FUNCTION bb_record_material_storage_tombstone();

CREATE FUNCTION bb_reject_storage_tombstone_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
   RAISE EXCEPTION 'storage tombstones are durable' USING ERRCODE='23514';
 END IF;
 IF NEW.id IS DISTINCT FROM OLD.id OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.object_kind IS DISTINCT FROM OLD.object_kind
    OR NEW.material_id IS DISTINCT FROM OLD.material_id OR NEW.material_version IS DISTINCT FROM OLD.material_version
    OR NEW.upload_id IS DISTINCT FROM OLD.upload_id OR NEW.object_key IS DISTINCT FROM OLD.object_key
    OR lower(btrim(NEW.sha256::text)) IS DISTINCT FROM lower(btrim(OLD.sha256::text))
    OR NEW.requested_at IS DISTINCT FROM OLD.requested_at THEN
   RAISE EXCEPTION 'storage tombstone identity is immutable' USING ERRCODE='23514';
 END IF;
 IF OLD.eligible_at IS NOT NULL AND NEW.eligible_at IS DISTINCT FROM OLD.eligible_at THEN
   RAISE EXCEPTION 'storage tombstone eligibility is immutable once set' USING ERRCODE='23514';
 END IF;
 IF OLD.state='purged' THEN
   RAISE EXCEPTION 'purged storage tombstones are immutable' USING ERRCODE='23514';
 END IF;
 IF NEW.state='claimed' THEN
   IF NEW.attempts<>OLD.attempts+1 OR NEW.lease_until<=clock_timestamp() THEN
     RAISE EXCEPTION 'storage tombstone claim must advance one attempt with a live lease' USING ERRCODE='23514';
   END IF;
   IF OLD.state='claimed' AND OLD.lease_until>clock_timestamp() THEN
     RAISE EXCEPTION 'active storage tombstone lease cannot be stolen' USING ERRCODE='23514';
   END IF;
 ELSIF NEW.state='pending' THEN
   IF NEW.attempts<>OLD.attempts OR NEW.claim_token IS NOT NULL OR NEW.lease_until IS NOT NULL OR NEW.purged_at IS NOT NULL THEN
     RAISE EXCEPTION 'storage tombstone retry transition is invalid' USING ERRCODE='23514';
   END IF;
 ELSIF NEW.state='purged' THEN
   IF OLD.state<>'claimed' OR NEW.attempts<>OLD.attempts OR NEW.claim_token IS NOT NULL
      OR NEW.lease_until IS NOT NULL OR NEW.purged_at IS NULL THEN
     RAISE EXCEPTION 'storage tombstone purge transition is invalid' USING ERRCODE='23514';
   END IF;
 END IF;
 IF OLD.eligible_at IS NULL AND NEW.eligible_at IS NOT NULL
    AND (NEW.state IS DISTINCT FROM OLD.state OR NEW.attempts<>OLD.attempts) THEN
   RAISE EXCEPTION 'storage tombstone eligibility must be recorded independently' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_storage_tombstone_identity_immutable
  BEFORE UPDATE OR DELETE ON bb_storage_tombstones
  FOR EACH ROW EXECUTE FUNCTION bb_reject_storage_tombstone_rewrite();

COMMENT ON TABLE bb_storage_tombstones IS
  'Durable deletion markers. A worker must commit a claim before checking and deleting the exact Blob key; retries replay by key and hash.';
COMMENT ON COLUMN bb_storage_tombstones.eligible_at IS
  'First configured retention/grace eligibility timestamp; NULL means no deletion policy has authorized purge.';

-- Convert prior soft deletions into durable replay markers. Policy eligibility stays unset.
INSERT INTO bb_storage_tombstones
  (id,owner_user_id,project_id,object_kind,material_id,material_version,object_key,sha256,requested_at)
SELECT 'legacy-material-' || md5(m.owner_user_id || ':' || m.id || ':' || m.version::text),
       m.owner_user_id,m.project_id,'material',m.id,m.version,m.object_key,lower(btrim(m.sha256::text)),m.deleted_at
FROM bb_material_versions m
WHERE m.deleted_at IS NOT NULL
ON CONFLICT (object_key) DO NOTHING;
