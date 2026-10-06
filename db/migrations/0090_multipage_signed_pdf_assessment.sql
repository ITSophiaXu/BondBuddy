-- Extend the immutable assessment to multi-page signed reports. Existing v1 rows stay unchanged.
ALTER TABLE bb_material_versions DROP CONSTRAINT bb_material_signature_assessment_shape;
ALTER TABLE bb_material_versions ADD CONSTRAINT bb_material_signature_assessment_shape CHECK (
  signature_assessment IS NULL OR (
    media_type = 'application/pdf' AND jsonb_typeof(signature_assessment) = 'object' AND (
      signature_assessment = jsonb_build_object('status','signature_unverified','profile_version','signed-pdf-classic-v1','signature_count',1)
      OR (
        signature_assessment = jsonb_build_object('status','signature_unverified','profile_version','signed-pdf-multipage-v2','signature_count',signature_assessment->'signature_count')
        AND jsonb_typeof(signature_assessment->'signature_count') = 'number'
        AND (signature_assessment->>'signature_count') ~ '^[1-9][0-9]{0,3}$'
        AND (signature_assessment->>'signature_count')::numeric BETWEEN 1 AND 1500
      )
    )
  )
);
