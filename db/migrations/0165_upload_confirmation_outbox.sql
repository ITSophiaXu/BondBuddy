-- Persistent owner-scoped pins and results for the existing outbox lease consumer.
CREATE UNIQUE INDEX bb_outbox_upload_complete_once ON bb_outbox(owner_user_id,aggregate_id)
 WHERE aggregate_type='upload' AND event_type='upload.complete_requested';
CREATE TABLE bb_upload_confirmations (
 upload_id text PRIMARY KEY,
 owner_user_id text NOT NULL,
 project_id text NOT NULL,
 outbox_id text NOT NULL UNIQUE REFERENCES bb_outbox(id) ON DELETE CASCADE,
 object_key text NOT NULL,
 sha256 char(64) NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
 byte_size bigint NOT NULL CHECK(byte_size BETWEEN 1 AND 104857600),
 upload_identity jsonb NOT NULL,
 last_error jsonb,
 inspection_excepted boolean NOT NULL DEFAULT false,
 canonical_object_key text,
 canonical_object_keys text[] NOT NULL DEFAULT '{}',
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','verifying','completed','failed')),
 result jsonb,
 error jsonb,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(owner_user_id,upload_id) REFERENCES bb_uploads(owner_user_id,id) ON DELETE CASCADE,
 FOREIGN KEY(owner_user_id,project_id) REFERENCES bb_projects(owner_user_id,id) ON DELETE CASCADE,
 CHECK((state='completed')=(result IS NOT NULL)),
 CHECK((state='failed')=(error IS NOT NULL))
);
CREATE FUNCTION bb_guard_upload_confirmation_pin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.upload_id,NEW.owner_user_id,NEW.project_id,NEW.outbox_id,NEW.object_key,NEW.sha256,NEW.byte_size,NEW.inspection_excepted,NEW.upload_identity)
   IS DISTINCT FROM (OLD.upload_id,OLD.owner_user_id,OLD.project_id,OLD.outbox_id,OLD.object_key,OLD.sha256,OLD.byte_size,OLD.inspection_excepted,OLD.upload_identity)
   OR (OLD.canonical_object_key IS NOT NULL AND NEW.canonical_object_key IS DISTINCT FROM OLD.canonical_object_key)

   OR NEW.canonical_object_keys[1:cardinality(OLD.canonical_object_keys)] IS DISTINCT FROM OLD.canonical_object_keys
 THEN RAISE EXCEPTION 'upload confirmation pin is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_upload_confirmation_pin_guard BEFORE UPDATE ON bb_upload_confirmations
 FOR EACH ROW EXECUTE FUNCTION bb_guard_upload_confirmation_pin();
CREATE FUNCTION bb_upload_confirmation_bytes_pinned(owner_id text,blob_key text) RETURNS boolean
 LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM bb_upload_confirmations c JOIN bb_outbox o ON o.id=c.outbox_id
  WHERE c.owner_user_id=owner_id AND o.owner_user_id=owner_id
    AND (c.object_key=blob_key OR c.canonical_object_key=blob_key OR blob_key=ANY(c.canonical_object_keys))
    AND c.state IN ('queued','verifying') AND o.delivered_at IS NULL
    AND o.aggregate_type='upload' AND o.event_type='upload.complete_requested')
$$;
