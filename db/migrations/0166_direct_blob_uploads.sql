-- Transport identity is pinned once; signed URLs are never stored.
ALTER TABLE bb_uploads ADD COLUMN upload_transport text NOT NULL DEFAULT 'same_origin'
 CHECK(upload_transport IN ('same_origin','azure_blob'));
CREATE FUNCTION bb_guard_upload_transport() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.upload_transport,NEW.object_key,NEW.owner_user_id,NEW.project_id,NEW.id)
  IS DISTINCT FROM (OLD.upload_transport,OLD.object_key,OLD.owner_user_id,OLD.project_id,OLD.id)
 THEN RAISE EXCEPTION 'upload transport identity is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_upload_transport_guard BEFORE UPDATE ON bb_uploads
 FOR EACH ROW EXECUTE FUNCTION bb_guard_upload_transport();
