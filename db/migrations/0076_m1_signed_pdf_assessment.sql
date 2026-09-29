-- A null value means the material was not admitted through the signed PDF profile.
-- It is not a claim that the material has no signature or that an old material was checked.
ALTER TABLE bb_material_versions
  ADD COLUMN signature_assessment jsonb;

ALTER TABLE bb_material_versions
  ADD CONSTRAINT bb_material_signature_assessment_shape CHECK (
    signature_assessment IS NULL OR (
      media_type = 'application/pdf'
      AND jsonb_typeof(signature_assessment) = 'object'
      AND signature_assessment = jsonb_build_object(
        'status', 'signature_unverified',
        'profile_version', 'signed-pdf-classic-v1',
        'signature_count', 1
      )
    )
  );

CREATE FUNCTION bb_guard_material_signature_assessment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.signature_assessment IS DISTINCT FROM OLD.signature_assessment THEN
    RAISE EXCEPTION 'material signature assessment is immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.signature_assessment IS NOT NULL AND (
    NEW.id IS DISTINCT FROM OLD.id OR NEW.version IS DISTINCT FROM OLD.version
    OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.sha256 IS DISTINCT FROM OLD.sha256
    OR NEW.byte_size IS DISTINCT FROM OLD.byte_size
    OR NEW.object_key IS DISTINCT FROM OLD.object_key
  ) THEN
    RAISE EXCEPTION 'assessed material identity and bytes are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER bb_material_signature_assessment_guard
  BEFORE UPDATE OF signature_assessment,id,version,owner_user_id,project_id,sha256,byte_size,object_key ON bb_material_versions
  FOR EACH ROW EXECUTE FUNCTION bb_guard_material_signature_assessment();
