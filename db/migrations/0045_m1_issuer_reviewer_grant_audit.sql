ALTER TABLE bb_issuer_identity_reviewer_grants
  ADD COLUMN authorization_basis text,
  ADD COLUMN revoked_by text REFERENCES bb_users(id),
  ADD COLUMN revocation_basis text,
  ADD COLUMN revocation_reason_code text CHECK (revocation_reason_code ~ '^[a-z][a-z0-9_]{0,63}$');
ALTER TABLE bb_issuer_identity_reviewer_grants ADD CONSTRAINT bb_issuer_grant_revocation_audit
  CHECK ((revoked_at IS NULL AND revoked_by IS NULL AND revocation_reason_code IS NULL AND revocation_basis IS NULL)
    OR (revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND revocation_reason_code IS NOT NULL AND revocation_basis IS NOT NULL)) NOT VALID;
CREATE OR REPLACE FUNCTION bb_issuer_identity_reviewer_grant_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'issuer identity reviewer grants are retained' USING ERRCODE='23514'; END IF;
  IF OLD.revoked_at IS NOT NULL OR NEW.id <> OLD.id OR NEW.user_id <> OLD.user_id OR NEW.role <> OLD.role
     OR NEW.granted_by <> OLD.granted_by OR NEW.reason_code <> OLD.reason_code OR NEW.granted_at <> OLD.granted_at
     OR NEW.authorization_basis IS DISTINCT FROM OLD.authorization_basis
     OR OLD.revoked_by IS NOT NULL OR OLD.revocation_reason_code IS NOT NULL OR OLD.revocation_basis IS NOT NULL
     OR NEW.revoked_at IS NULL OR NEW.revoked_by IS NULL OR NEW.revocation_reason_code IS NULL OR NEW.revocation_basis IS NULL
  THEN RAISE EXCEPTION 'issuer identity reviewer grant is immutable except one audited revocation' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;

-- Existing 0035 verified rows may lack a basis. Keep them for audit, but the loader rejects them.
-- NOT VALID still enforces this constraint for every new review row.
ALTER TABLE bb_issuer_identity_source_reviews
  ADD COLUMN verified_entity_id text,
  ADD COLUMN entity_basis_kind text,
  ADD COLUMN entity_basis_ref text;
ALTER TABLE bb_issuer_identity_source_reviews ADD CONSTRAINT bb_issuer_review_verified_entity_basis
  CHECK (
    (decision = 'verified' AND verified_entity_id IS NOT NULL AND entity_basis_kind IS NOT NULL AND entity_basis_ref IS NOT NULL
      AND (verified_entity_id ~ '^uscc:[0-9A-HJ-NPQRTUWXY]{18}$'
        OR verified_entity_id ~ '^entity:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')
      AND entity_basis_kind IN ('uscc','registry_record','manual_attestation')
      AND length(btrim(entity_basis_ref)) BETWEEN 1 AND 512
      AND (entity_basis_kind <> 'uscc' OR (verified_entity_id LIKE 'uscc:%' AND verified_entity_id = 'uscc:' || entity_basis_ref)))
    OR (decision <> 'verified' AND verified_entity_id IS NULL AND entity_basis_kind IS NULL AND entity_basis_ref IS NULL)
  ) NOT VALID;
COMMENT ON COLUMN bb_issuer_identity_source_records.entity_id IS
  'Candidate clustering key only. Production values use issuer-name:v1; never use this column as a verified fact entity key.';
COMMENT ON COLUMN bb_issuer_identity_source_reviews.verified_entity_id IS
  'Reviewer-attested legal entity key. Legacy verified rows without this value remain unbound.';
CREATE INDEX bb_issuer_identity_candidate_project_idx
  ON bb_issuer_identity_source_records(owner_user_id, project_id, entity_id);

-- Context pins refer to the verified subject in the immutable review. Existing
-- draft rows remain readable for audit; only new rows must satisfy this link.
ALTER TABLE bb_issuer_identity_source_reviews ADD CONSTRAINT bb_issuer_review_verified_subject_ref
  UNIQUE (owner_user_id, project_id, material_id, material_version, source_record_id,
    identity_version, content_sha256, verified_entity_id);
ALTER TABLE bb_rule_applicability_context_drafts
  DROP CONSTRAINT bb_rule_applicability_context_owner_user_id_project_id_iss_fkey;
ALTER TABLE bb_rule_applicability_context_drafts ADD CONSTRAINT bb_rule_context_verified_subject_fkey
  FOREIGN KEY (owner_user_id, project_id, issuer_identity_material_id, issuer_identity_material_version,
    issuer_identity_record_id, issuer_identity_version, issuer_identity_hash, issuer_entity_id)
  REFERENCES bb_issuer_identity_source_reviews(owner_user_id, project_id, material_id, material_version,
    source_record_id, identity_version, content_sha256, verified_entity_id) NOT VALID;

-- The rule context insert guard must compare the verified subject, not the candidate key.
CREATE OR REPLACE FUNCTION bb_rule_applicability_context_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE rev_hash char(64);
DECLARE rev_draft integer;
DECLARE manifest_json jsonb;
DECLARE material_refs jsonb;
DECLARE selected_sha char(64);
DECLARE selected_deleted timestamptz;
DECLARE parse_sha char(64);
DECLARE parse_status text;
DECLARE identity_review text;
DECLARE identity_grant_revoked timestamptz;
DECLARE latest_identity_version integer;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'rule applicability context snapshots are immutable' USING ERRCODE='23514';
  END IF;

  IF TG_TABLE_NAME = 'bb_rule_applicability_context_drafts' THEN
    SELECT input_hash, draft_revision, manifest, material_versions INTO rev_hash, rev_draft, manifest_json, material_refs
      FROM bb_input_revisions
     WHERE owner_user_id=NEW.owner_user_id AND project_id=NEW.project_id AND revision=NEW.source_input_revision
     FOR SHARE;
    IF rev_hash IS DISTINCT FROM NEW.source_input_hash OR rev_draft IS DISTINCT FROM NEW.source_draft_revision THEN
      RAISE EXCEPTION 'rule applicability source input hash mismatch' USING ERRCODE='23514';
    END IF;
    IF jsonb_array_length(NEW.source_materials) <> jsonb_array_length(material_refs)
       OR jsonb_array_length(NEW.source_materials) <> jsonb_array_length(manifest_json->'materials')
       OR (SELECT count(DISTINCT (p->>'materialId') || ':' || (p->>'materialVersion'))
             FROM jsonb_array_elements(NEW.source_materials) AS p) <> jsonb_array_length(NEW.source_materials)
       OR EXISTS (
         SELECT 1 FROM jsonb_array_elements(NEW.source_materials) AS p
          WHERE jsonb_typeof(p) <> 'object'
             OR p->>'materialId' IS NULL OR p->>'sha256' !~ '^[a-f0-9]{64}$'
             OR (p->>'materialVersion') !~ '^[1-9][0-9]*$'
             OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(material_refs) AS r
               WHERE r->>'material_id'=p->>'materialId' AND r->>'material_version'=p->>'materialVersion')
             OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(manifest_json->'materials') AS m
               WHERE m->>'material_id'=p->>'materialId' AND m->>'material_version'=p->>'materialVersion'
                 AND lower(m->>'sha256')=p->>'sha256')
       ) THEN
      RAISE EXCEPTION 'rule applicability source material set mismatch' USING ERRCODE='23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM bb_projects p WHERE p.owner_user_id=NEW.owner_user_id AND p.id=NEW.project_id
      AND p.deleted_at IS NULL AND p.latest_input_revision=NEW.source_input_revision AND p.draft_revision=NEW.source_draft_revision) THEN
      RAISE EXCEPTION 'rule applicability project or current source revision is unavailable' USING ERRCODE='23514';
    END IF;
    SELECT sha256, deleted_at INTO selected_sha, selected_deleted FROM bb_material_versions
     WHERE owner_user_id=NEW.owner_user_id AND project_id=NEW.project_id
       AND id=NEW.selected_material_id AND version=NEW.selected_material_version FOR SHARE;
    IF selected_sha IS DISTINCT FROM NEW.selected_material_sha256 OR selected_deleted IS NOT NULL THEN
      RAISE EXCEPTION 'rule applicability selected material is unavailable or mismatched' USING ERRCODE='23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(material_refs) AS r
       WHERE r->>'material_id'=NEW.selected_material_id
         AND (r->>'material_version')::integer=NEW.selected_material_version
    ) OR NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(manifest_json->'materials') AS m
       WHERE m->>'material_id'=NEW.selected_material_id
         AND (m->>'material_version')::integer=NEW.selected_material_version
         AND lower(m->>'sha256')=NEW.selected_material_sha256
    ) THEN
      RAISE EXCEPTION 'rule applicability selected material is outside source revision' USING ERRCODE='23514';
    END IF;
    SELECT content_sha256, response_status INTO parse_sha, parse_status FROM bb_parse_snapshots
     WHERE owner_user_id=NEW.owner_user_id AND project_id=NEW.project_id AND material_id=NEW.selected_material_id
       AND material_version=NEW.selected_material_version AND id=NEW.selected_parse_snapshot_id FOR SHARE;
    IF parse_sha IS DISTINCT FROM NEW.selected_material_sha256 OR parse_status NOT IN ('parsed','needs_confirmation') THEN
      RAISE EXCEPTION 'rule applicability selected parse snapshot is unavailable' USING ERRCODE='23514';
    END IF;
    IF manifest_json->'issuer_identity'->>'status' IS DISTINCT FROM 'verified'
       OR manifest_json->'issuer_identity'->>'record_id' IS DISTINCT FROM NEW.issuer_identity_record_id
       OR (manifest_json->'issuer_identity'->>'version')::integer IS DISTINCT FROM NEW.issuer_identity_version
       OR lower(manifest_json->'issuer_identity'->>'content_hash') IS DISTINCT FROM NEW.issuer_identity_hash
       OR manifest_json->'issuer_identity'->>'entity_id' IS DISTINCT FROM NEW.issuer_entity_id
       OR manifest_json->'issuer_identity'->>'material_id' IS DISTINCT FROM NEW.issuer_identity_material_id
       OR (manifest_json->'issuer_identity'->>'material_version')::integer IS DISTINCT FROM NEW.issuer_identity_material_version THEN
      RAISE EXCEPTION 'rule applicability identity does not match source revision' USING ERRCODE='23514';
    END IF;
    SELECT rv.decision, g.revoked_at INTO identity_review, identity_grant_revoked
      FROM bb_issuer_identity_source_reviews rv
      JOIN bb_issuer_identity_reviewer_grants g ON g.user_id=rv.reviewer_user_id AND g.id=rv.reviewer_grant_id
     WHERE rv.owner_user_id=NEW.owner_user_id AND rv.project_id=NEW.project_id
       AND rv.material_id=NEW.issuer_identity_material_id AND rv.material_version=NEW.issuer_identity_material_version
       AND rv.source_record_id=NEW.issuer_identity_record_id AND rv.identity_version=NEW.issuer_identity_version
       AND rv.content_sha256=NEW.issuer_identity_hash AND rv.verified_entity_id=NEW.issuer_entity_id;
    IF identity_review IS DISTINCT FROM 'verified' OR identity_grant_revoked IS NOT NULL THEN
      RAISE EXCEPTION 'rule applicability identity review is not current' USING ERRCODE='23514';
    END IF;
    SELECT max(identity_version) INTO latest_identity_version FROM bb_issuer_identity_source_records
     WHERE owner_user_id=NEW.owner_user_id AND project_id=NEW.project_id
       AND material_id=NEW.issuer_identity_material_id AND material_version=NEW.issuer_identity_material_version;
    IF latest_identity_version IS DISTINCT FROM NEW.issuer_identity_version THEN
      RAISE EXCEPTION 'rule applicability identity was superseded' USING ERRCODE='23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'bb_rule_applicability_context_candidates' THEN
    IF NEW.review_decision IS NOT NULL OR NEW.review_status <> 'needs_review' THEN
      RAISE EXCEPTION 'rule applicability candidates start needs_review' USING ERRCODE='23514';
    END IF;
    IF NEW.source_kind='unknown' AND (NEW.source_status<>'unknown' OR NEW.candidate_value<>'null'::jsonb) THEN
      RAISE EXCEPTION 'unknown rule applicability candidate must be null' USING ERRCODE='23514';
    END IF;
    IF NEW.source_kind='user_asserted' AND NEW.source_status NOT IN ('user_asserted','conflicting') THEN
      RAISE EXCEPTION 'user assertions remain user_asserted or conflicting' USING ERRCODE='23514';
    END IF;
    IF NEW.field_key='specialFeatures' AND jsonb_typeof(NEW.candidate_value)='array'
       AND jsonb_array_length(NEW.candidate_value)=0 THEN
      RAISE EXCEPTION 'empty specialFeatures requires an explicit reviewed absence record' USING ERRCODE='23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'bb_rule_applicability_context_candidate_evidence' THEN
    IF NOT EXISTS (
      SELECT 1 FROM bb_rule_applicability_context_candidates c
      JOIN bb_rule_applicability_context_drafts d ON d.owner_user_id=c.owner_user_id AND d.project_id=c.project_id
        AND d.id=c.context_id AND d.version=c.context_version
      JOIN bb_input_revisions i ON i.owner_user_id=d.owner_user_id AND i.project_id=d.project_id AND i.revision=d.source_input_revision
      JOIN bb_parse_evidence e ON e.owner_user_id=NEW.owner_user_id AND e.project_id=NEW.project_id
        AND e.material_id=NEW.material_id AND e.material_version=NEW.material_version
        AND e.snapshot_id=NEW.parse_snapshot_id AND e.record_id=NEW.evidence_record_id
        AND e.record_sha256=NEW.evidence_record_sha256 AND e.content_sha256=NEW.material_sha256
      JOIN bb_parse_snapshots s ON s.owner_user_id=e.owner_user_id AND s.project_id=e.project_id
        AND s.material_id=e.material_id AND s.material_version=e.material_version AND s.id=e.snapshot_id
        AND s.content_sha256=e.content_sha256 AND s.response_status IN ('parsed','needs_confirmation')
      JOIN bb_material_versions m ON m.owner_user_id=e.owner_user_id AND m.project_id=e.project_id
        AND m.id=e.material_id AND m.version=e.material_version AND m.sha256=e.content_sha256 AND m.deleted_at IS NULL
      WHERE c.owner_user_id=NEW.owner_user_id AND c.project_id=NEW.project_id AND c.context_id=NEW.context_id
        AND c.context_version=NEW.context_version AND c.candidate_id=NEW.candidate_id
        AND c.source_kind IN ('parse_evidence','user_asserted') AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(i.material_versions) AS r
           WHERE r->>'material_id'=NEW.material_id AND (r->>'material_version')::integer=NEW.material_version
        ) AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(i.manifest->'materials') AS m
           WHERE m->>'material_id'=NEW.material_id AND (m->>'material_version')::integer=NEW.material_version
             AND lower(m->>'sha256')=NEW.material_sha256
        )
    ) THEN RAISE EXCEPTION 'rule applicability evidence is not pinned to owner input material and parse anchor' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
