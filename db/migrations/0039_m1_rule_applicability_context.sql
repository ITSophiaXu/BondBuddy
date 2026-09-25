-- #19/#15 internal, owner-scoped rule-applicability context drafts.  This is
-- evidence storage only: every row begins needs_review and no production
-- taxonomy or approval threshold is implied by this schema.
CREATE TABLE bb_rule_applicability_context_drafts (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL,
  project_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  source_input_revision integer NOT NULL CHECK (source_input_revision > 0),
  source_input_hash char(64) NOT NULL CHECK (source_input_hash ~ '^[a-f0-9]{64}$'),
  source_draft_revision integer NOT NULL CHECK (source_draft_revision > 0),
  source_materials jsonb NOT NULL CHECK (jsonb_typeof(source_materials) = 'array'),
  selected_material_id text NOT NULL,
  selected_material_version integer NOT NULL CHECK (selected_material_version > 0),
  selected_material_sha256 char(64) NOT NULL CHECK (selected_material_sha256 ~ '^[a-f0-9]{64}$'),
  selected_parse_snapshot_id text NOT NULL,
  issuer_identity_material_id text NOT NULL,
  issuer_identity_material_version integer NOT NULL CHECK (issuer_identity_material_version > 0),
  issuer_identity_record_id text NOT NULL,
  issuer_identity_version integer NOT NULL CHECK (issuer_identity_version > 0),
  issuer_identity_hash char(64) NOT NULL CHECK (issuer_identity_hash ~ '^[a-f0-9]{64}$'),
  issuer_entity_id text NOT NULL CHECK (length(btrim(issuer_entity_id)) > 0),
  as_of date,
  document_purpose text CHECK (document_purpose IS NULL OR document_purpose IN ('registration','issuance')),
  request_id text NOT NULL CHECK (length(btrim(request_id)) BETWEEN 1 AND 128),
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  content_hash char(64) NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'needs_review' CHECK (status = 'needs_review'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, project_id, id, version),
  UNIQUE (owner_user_id, project_id, request_id),
  FOREIGN KEY (owner_user_id, project_id, source_input_revision)
    REFERENCES bb_input_revisions(owner_user_id, project_id, revision),
  FOREIGN KEY (owner_user_id, project_id, selected_material_id, selected_material_version)
    REFERENCES bb_material_versions(owner_user_id, project_id, id, version),
  FOREIGN KEY (owner_user_id, project_id, selected_material_id, selected_material_version, selected_parse_snapshot_id)
    REFERENCES bb_parse_snapshots(owner_user_id, project_id, material_id, material_version, id),
  FOREIGN KEY (owner_user_id, project_id, issuer_identity_material_id, issuer_identity_material_version,
               issuer_identity_record_id, issuer_identity_version, issuer_identity_hash, issuer_entity_id)
    REFERENCES bb_issuer_identity_source_records(owner_user_id, project_id, material_id, material_version,
               id, identity_version, content_sha256, entity_id),
  CHECK (source_input_hash = lower(btrim(source_input_hash::text))),
  CHECK (selected_material_sha256 = lower(btrim(selected_material_sha256::text))),
  CHECK (issuer_identity_hash = lower(btrim(issuer_identity_hash::text)))
);

CREATE TABLE bb_rule_applicability_context_candidates (
  context_id text NOT NULL,
  owner_user_id text NOT NULL,
  project_id text NOT NULL,
  context_version integer NOT NULL CHECK (context_version > 0),
  candidate_id text NOT NULL,
  field_key text NOT NULL CHECK (field_key ~ '^[A-Za-z][A-Za-z0-9_.:-]{0,127}$'),
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  candidate_value jsonb NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN ('parse_evidence','user_asserted','unknown')),
  source_status text NOT NULL CHECK (source_status IN ('recognized','user_asserted','unknown','conflicting')),
  conflict_refs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(conflict_refs) = 'array'),
  review_decision text CHECK (review_decision IS NULL),
  review_status text NOT NULL DEFAULT 'needs_review' CHECK (review_status = 'needs_review'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (context_id, candidate_id),
  UNIQUE (owner_user_id, project_id, context_id, context_version, candidate_id),
  UNIQUE (owner_user_id, project_id, context_id, context_version, field_key, ordinal),
  FOREIGN KEY (owner_user_id, project_id, context_id, context_version)
    REFERENCES bb_rule_applicability_context_drafts(owner_user_id, project_id, id, version)
);

CREATE TABLE bb_rule_applicability_context_candidate_evidence (
  owner_user_id text NOT NULL,
  project_id text NOT NULL,
  context_id text NOT NULL,
  context_version integer NOT NULL,
  candidate_id text NOT NULL,
  material_id text NOT NULL,
  material_version integer NOT NULL,
  parse_snapshot_id text NOT NULL,
  evidence_record_id text NOT NULL,
  evidence_record_sha256 char(64) NOT NULL CHECK (evidence_record_sha256 ~ '^[a-f0-9]{64}$'),
  material_sha256 char(64) NOT NULL CHECK (material_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (context_id, context_version, candidate_id, evidence_record_id),
  FOREIGN KEY (owner_user_id, project_id, context_id, context_version, candidate_id)
    REFERENCES bb_rule_applicability_context_candidates(owner_user_id, project_id, context_id, context_version, candidate_id),
  FOREIGN KEY (owner_user_id, project_id, material_id, material_version, parse_snapshot_id, evidence_record_id)
    REFERENCES bb_parse_evidence(owner_user_id, project_id, material_id, material_version, snapshot_id, record_id),
  FOREIGN KEY (owner_user_id, project_id, material_id, material_version)
    REFERENCES bb_material_versions(owner_user_id, project_id, id, version)
);

CREATE INDEX bb_rule_applicability_context_source_idx
  ON bb_rule_applicability_context_drafts(owner_user_id, project_id, source_input_revision, created_at DESC);
CREATE INDEX bb_rule_applicability_context_identity_idx
  ON bb_rule_applicability_context_drafts(owner_user_id, project_id, issuer_identity_record_id, issuer_identity_version);

CREATE FUNCTION bb_rule_applicability_context_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
       AND rv.content_sha256=NEW.issuer_identity_hash AND rv.entity_id=NEW.issuer_entity_id;
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

CREATE TRIGGER bb_rule_applicability_context_draft_guard
  BEFORE INSERT OR UPDATE OR DELETE ON bb_rule_applicability_context_drafts
  FOR EACH ROW EXECUTE FUNCTION bb_rule_applicability_context_guard();
CREATE TRIGGER bb_rule_applicability_context_candidate_guard
  BEFORE INSERT OR UPDATE OR DELETE ON bb_rule_applicability_context_candidates
  FOR EACH ROW EXECUTE FUNCTION bb_rule_applicability_context_guard();
CREATE TRIGGER bb_rule_applicability_context_evidence_guard
  BEFORE INSERT OR UPDATE OR DELETE ON bb_rule_applicability_context_candidate_evidence
  FOR EACH ROW EXECUTE FUNCTION bb_rule_applicability_context_guard();

COMMENT ON TABLE bb_rule_applicability_context_drafts IS
  'Internal immutable #15/#19 applicability context source pins. All rows are needs_review until Maxy taxonomy and approval thresholds are supplied; old pins remain auditable.';
COMMENT ON TABLE bb_rule_applicability_context_candidates IS
  'Per-field candidate values and provenance. User assertions and recognized values are evidence only; no review decision can be written here.';
