-- #17 Word delivery gate. Append-only evidence records the inspected package and
-- the exact private Blob bytes read back before an artifact can become available.
CREATE TABLE bb_word_delivery_evidence (
 id text PRIMARY KEY,
 owner_user_id text NOT NULL,
 run_id text NOT NULL,
 artifact_id text NOT NULL,
 artifact_version integer NOT NULL CHECK (artifact_version > 0),
 candidate_sha256 char(64) NOT NULL CHECK (candidate_sha256 ~ '^[0-9a-f]{64}$'),
 byte_size bigint NOT NULL CHECK (byte_size >= 0),
 validator_version text NOT NULL CHECK (length(validator_version) BETWEEN 1 AND 80),
 quality_status text NOT NULL CHECK (quality_status IN ('passed','failed')),
 delivery_status text NOT NULL CHECK (delivery_status IN ('not_attempted','unavailable','available')),
 delivery_code text NOT NULL CHECK (delivery_code IN ('not_attempted','readback_verified','blob_write_failed','blob_missing','blob_too_large','blob_read_failed','blob_hash_mismatch')),
 readback_sha256 char(64) CHECK (readback_sha256 IS NULL OR readback_sha256 ~ '^[0-9a-f]{64}$'),
 readback_byte_size bigint CHECK (readback_byte_size IS NULL OR readback_byte_size >= 0),
 quality_evidence jsonb NOT NULL CHECK (jsonb_typeof(quality_evidence) = 'object'),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (owner_user_id,run_id,id),
 UNIQUE NULLS NOT DISTINCT (owner_user_id,run_id,artifact_id,artifact_version,candidate_sha256,validator_version,quality_status,delivery_status,delivery_code,readback_sha256,readback_byte_size),
 FOREIGN KEY (owner_user_id,run_id) REFERENCES bb_runs(owner_user_id,id),
 CHECK (
   (quality_status='failed' AND delivery_status='not_attempted' AND delivery_code='not_attempted' AND readback_sha256 IS NULL AND readback_byte_size IS NULL)
   OR
   (quality_status='passed' AND delivery_status='unavailable' AND delivery_code IN ('blob_write_failed','blob_missing','blob_too_large','blob_read_failed') AND readback_sha256 IS NULL AND readback_byte_size IS NULL)
   OR
   (quality_status='passed' AND delivery_status='unavailable' AND delivery_code='blob_hash_mismatch' AND readback_sha256 IS NOT NULL AND readback_byte_size IS NOT NULL)
   OR
   (quality_status='passed' AND delivery_status='available' AND delivery_code='readback_verified' AND readback_sha256=candidate_sha256 AND readback_byte_size=byte_size)
 ),
 CHECK(quality_evidence->>'sha256'=trim(candidate_sha256)),
 CHECK(quality_evidence->>'byte_size'=byte_size::text),
 CHECK(quality_evidence->>'validator_version'=validator_version),
 CHECK(quality_evidence->>'quality_status'=quality_status)
);

CREATE INDEX bb_word_delivery_evidence_run_idx
 ON bb_word_delivery_evidence(owner_user_id,run_id,created_at,id);

CREATE FUNCTION bb_reject_word_delivery_evidence_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'immutable Word delivery evidence' USING ERRCODE='23514'; END $$;
CREATE TRIGGER bb_word_delivery_evidence_immutable
 BEFORE UPDATE OR DELETE ON bb_word_delivery_evidence
 FOR EACH ROW EXECUTE FUNCTION bb_reject_word_delivery_evidence_change();

ALTER TABLE bb_artifact_versions ADD COLUMN word_delivery_evidence_id text;
DO $$
BEGIN
 IF EXISTS (SELECT 1 FROM bb_runs WHERE state='succeeded') THEN
   RAISE EXCEPTION 'Word delivery evidence migration requires operator review of existing successful runs' USING ERRCODE='23514';
 END IF;
END $$;
-- No pre-0009 writer stored validator/readback evidence. Revoke legacy availability fail-closed.
UPDATE bb_artifact_versions SET delivery_status='revoked' WHERE delivery_status='available';
ALTER TABLE bb_artifact_versions
 ADD CONSTRAINT bb_artifact_delivery_evidence_fk
 FOREIGN KEY(owner_user_id,run_id,word_delivery_evidence_id)
 REFERENCES bb_word_delivery_evidence(owner_user_id,run_id,id);
ALTER TABLE bb_artifact_versions
 ADD CONSTRAINT bb_available_artifact_requires_evidence
 CHECK (delivery_status <> 'available' OR word_delivery_evidence_id IS NOT NULL);

CREATE FUNCTION bb_check_word_delivery_evidence_for_artifact() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE evidence bb_word_delivery_evidence%ROWTYPE;
BEGIN
 IF NEW.word_delivery_evidence_id IS NOT NULL THEN
   SELECT * INTO evidence FROM bb_word_delivery_evidence
    WHERE owner_user_id=NEW.owner_user_id AND run_id=NEW.run_id AND id=NEW.word_delivery_evidence_id;
   IF NOT FOUND
      OR evidence.artifact_id <> NEW.id
      OR evidence.artifact_version <> NEW.version
      OR evidence.candidate_sha256 <> NEW.sha256
      OR evidence.quality_status <> NEW.quality_status THEN
     RAISE EXCEPTION 'artifact evidence identity mismatch' USING ERRCODE='23514';
   END IF;
 END IF;
 IF NEW.delivery_status='available' THEN
   IF NEW.word_delivery_evidence_id IS NULL
      OR evidence.artifact_id <> NEW.id
      OR evidence.artifact_version <> NEW.version
      OR evidence.candidate_sha256 <> NEW.sha256
      OR evidence.quality_status <> 'passed'
      OR evidence.delivery_status <> 'available'
      OR evidence.delivery_code <> 'readback_verified'
      OR NEW.media_type <> 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      OR NEW.quality_status <> 'passed' THEN
     RAISE EXCEPTION 'available artifact requires matching verified Word evidence' USING ERRCODE='23514';
   END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_artifact_delivery_evidence_guard
 BEFORE INSERT OR UPDATE OF id,version,owner_user_id,run_id,media_type,sha256,quality_status,delivery_status,word_delivery_evidence_id
 ON bb_artifact_versions FOR EACH ROW EXECUTE FUNCTION bb_check_word_delivery_evidence_for_artifact();

CREATE FUNCTION bb_require_word_delivery_for_run_success() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.state='succeeded' AND NOT EXISTS (
   SELECT 1 FROM bb_artifact_versions a
   JOIN bb_word_delivery_evidence e
     ON e.owner_user_id=a.owner_user_id AND e.run_id=a.run_id AND e.id=a.word_delivery_evidence_id
   WHERE a.owner_user_id=NEW.owner_user_id AND a.run_id=NEW.id
     AND a.id=NEW.artifact_id AND a.version=NEW.artifact_version
     AND a.media_type='application/vnd.openxmlformats-officedocument.wordprocessingml.document'
     AND a.quality_status='passed' AND a.delivery_status='available'
     AND e.quality_status='passed' AND e.delivery_status='available'
     AND e.delivery_code='readback_verified' AND e.candidate_sha256=a.sha256
     AND e.readback_sha256=a.sha256 AND e.readback_byte_size=e.byte_size
 ) THEN
   RAISE EXCEPTION 'succeeded run requires verified available Word delivery' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_run_success_delivery_guard
 BEFORE INSERT OR UPDATE OF state,artifact_id,artifact_version
 ON bb_runs FOR EACH ROW EXECUTE FUNCTION bb_require_word_delivery_for_run_success();
