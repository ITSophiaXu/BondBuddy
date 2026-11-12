-- Exact stored versions whose complete body matched the immutable material hash.
CREATE TABLE bb_upload_integrity_receipts (
 owner_user_id text NOT NULL,
 project_id text NOT NULL,
 material_id text NOT NULL,
 material_version integer NOT NULL,
 object_key text NOT NULL,
 sha256 char(64) NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
 byte_size bigint NOT NULL CHECK (byte_size > 0),
 object_etag text NOT NULL CHECK (length(object_etag) BETWEEN 1 AND 512),
 verified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_user_id,project_id,material_id,material_version,object_etag),
 FOREIGN KEY(owner_user_id,project_id,material_id,material_version)
  REFERENCES bb_material_versions(owner_user_id,project_id,id,version) ON DELETE CASCADE
);
CREATE TRIGGER bb_upload_integrity_receipts_no_rewrite BEFORE UPDATE ON bb_upload_integrity_receipts
 FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();
