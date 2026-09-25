-- #15: immutable issuer identity observations bound to one owner's exact material
-- version and parser evidence anchor. Review grants are provisioned out of band;
-- this API slice intentionally has no grant creation path.

CREATE TABLE bb_issuer_identity_reviewer_grants (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES bb_users(id),
  role text NOT NULL CHECK (role = 'issuer_identity_reviewer'),
  granted_by text NOT NULL REFERENCES bb_users(id),
  reason_code text NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CHECK (user_id <> granted_by),
  CHECK (revoked_at IS NULL OR revoked_at >= granted_at),
  UNIQUE (user_id, id)
);
CREATE UNIQUE INDEX bb_issuer_identity_reviewer_grant_active_idx
  ON bb_issuer_identity_reviewer_grants(user_id, role) WHERE revoked_at IS NULL;

CREATE FUNCTION bb_issuer_identity_reviewer_grant_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'issuer identity reviewer grants are retained' USING ERRCODE='23514'; END IF;
  IF OLD.revoked_at IS NOT NULL OR NEW.id <> OLD.id OR NEW.user_id <> OLD.user_id OR NEW.role <> OLD.role
     OR NEW.granted_by <> OLD.granted_by OR NEW.reason_code <> OLD.reason_code OR NEW.granted_at <> OLD.granted_at
  THEN RAISE EXCEPTION 'issuer identity reviewer grant is immutable except one revocation' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bb_issuer_identity_reviewer_grant_guard
  BEFORE UPDATE OR DELETE ON bb_issuer_identity_reviewer_grants
  FOR EACH ROW EXECUTE FUNCTION bb_issuer_identity_reviewer_grant_guard();

CREATE TABLE bb_issuer_identity_source_records (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL,
  project_id text NOT NULL,
  material_id text NOT NULL,
  material_version integer NOT NULL CHECK (material_version > 0),
  snapshot_id text NOT NULL,
  source_record_id text NOT NULL,
  source_record_sha256 char(64) NOT NULL CHECK (source_record_sha256 ~ '^[a-f0-9]{64}$'),
  source_content_sha256 char(64) NOT NULL CHECK (source_content_sha256 ~ '^[a-f0-9]{64}$'),
  source_locator_type text NOT NULL CHECK (source_locator_type IN ('docx_block','pdf_bbox','xlsx_cell','csv_cell','text_line')),
  source_locator jsonb NOT NULL CHECK (jsonb_typeof(source_locator) = 'object'),
  source_quote text NOT NULL CHECK (length(btrim(source_quote)) > 0 AND octet_length(source_quote) <= 65536),
  issuer_display_name text NOT NULL CHECK (length(btrim(issuer_display_name)) BETWEEN 1 AND 512),
  entity_id text NOT NULL CHECK (entity_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  identity_version integer NOT NULL CHECK (identity_version > 0),
  request_id text NOT NULL CHECK (length(btrim(request_id)) BETWEEN 1 AND 128),
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  content_sha256 char(64) NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'needs_review' CHECK (state = 'needs_review'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, project_id, material_id, material_version, identity_version),
  UNIQUE (owner_user_id, project_id, material_id, material_version, request_id),
  UNIQUE (owner_user_id, project_id, material_id, material_version, id, identity_version, content_sha256, entity_id),
  FOREIGN KEY (owner_user_id, project_id, material_id, material_version)
    REFERENCES bb_material_versions(owner_user_id, project_id, id, version),
  FOREIGN KEY (owner_user_id, project_id, material_id, material_version, snapshot_id, source_record_id)
    REFERENCES bb_parse_evidence(owner_user_id, project_id, material_id, material_version, snapshot_id, record_id),
  CHECK (content_sha256 = lower(btrim(content_sha256::text)))
);
CREATE INDEX bb_issuer_identity_source_scope_idx
  ON bb_issuer_identity_source_records(owner_user_id, project_id, material_id, material_version, identity_version DESC);

CREATE TABLE bb_issuer_identity_source_reviews (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL,
  project_id text NOT NULL,
  material_id text NOT NULL,
  material_version integer NOT NULL CHECK (material_version > 0),
  source_record_id text NOT NULL,
  identity_version integer NOT NULL CHECK (identity_version > 0),
  content_sha256 char(64) NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  entity_id text NOT NULL,
  reviewer_user_id text NOT NULL,
  reviewer_grant_id text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('verified','rejected','conflict')),
  reason_code text NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, project_id, material_id, material_version, source_record_id),
  FOREIGN KEY (owner_user_id, project_id, material_id, material_version, source_record_id, identity_version, content_sha256, entity_id)
    REFERENCES bb_issuer_identity_source_records(owner_user_id, project_id, material_id, material_version, id, identity_version, content_sha256, entity_id),
  FOREIGN KEY (reviewer_user_id, reviewer_grant_id)
    REFERENCES bb_issuer_identity_reviewer_grants(user_id, id)
);
CREATE INDEX bb_issuer_identity_review_scope_idx
  ON bb_issuer_identity_source_reviews(owner_user_id, project_id, material_id, material_version, created_at DESC);

CREATE FUNCTION bb_issuer_identity_source_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'issuer identity source records and reviews are immutable' USING ERRCODE='23514'; END IF;
  IF TG_TABLE_NAME = 'bb_issuer_identity_source_records' THEN
    IF NOT EXISTS (
      SELECT 1 FROM bb_parse_evidence e
      JOIN bb_parse_snapshots s ON s.owner_user_id=e.owner_user_id AND s.project_id=e.project_id
        AND s.material_id=e.material_id AND s.material_version=e.material_version AND s.id=e.snapshot_id
        AND s.content_sha256=e.content_sha256 AND s.response_status IN ('parsed','needs_confirmation')
      JOIN bb_material_versions m ON m.owner_user_id=e.owner_user_id AND m.project_id=e.project_id
        AND m.id=e.material_id AND m.version=e.material_version AND m.sha256=e.content_sha256 AND m.deleted_at IS NULL
      WHERE e.owner_user_id=NEW.owner_user_id AND e.project_id=NEW.project_id AND e.material_id=NEW.material_id
        AND e.material_version=NEW.material_version AND e.snapshot_id=NEW.snapshot_id AND e.record_id=NEW.source_record_id
        AND e.record_sha256=NEW.source_record_sha256 AND e.content_sha256=NEW.source_content_sha256
        AND e.locator_type=NEW.source_locator_type AND e.locator=NEW.source_locator AND e.literal_quote=NEW.source_quote
        AND e.uncertainty='[]'::jsonb AND m.role <> 'reference'
    ) THEN RAISE EXCEPTION 'issuer identity source evidence mismatch' USING ERRCODE='23514'; END IF;
    IF NEW.state <> 'needs_review' THEN RAISE EXCEPTION 'issuer identity starts needs_review' USING ERRCODE='23514'; END IF;
  ELSE
    IF NOT EXISTS (
      SELECT 1 FROM bb_issuer_identity_reviewer_grants g
      WHERE g.id=NEW.reviewer_grant_id AND g.user_id=NEW.reviewer_user_id
        AND g.role='issuer_identity_reviewer' AND g.revoked_at IS NULL
    ) THEN RAISE EXCEPTION 'active issuer identity reviewer grant required' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bb_issuer_identity_source_record_guard
  BEFORE INSERT OR UPDATE OR DELETE ON bb_issuer_identity_source_records
  FOR EACH ROW EXECUTE FUNCTION bb_issuer_identity_source_guard();
CREATE TRIGGER bb_issuer_identity_source_review_guard
  BEFORE INSERT OR UPDATE OR DELETE ON bb_issuer_identity_source_reviews
  FOR EACH ROW EXECUTE FUNCTION bb_issuer_identity_source_guard();

COMMENT ON TABLE bb_issuer_identity_reviewer_grants IS
  'Privileged, out-of-band identity-review authorization. No user API or repository function creates grants; application actor strings are not grants.';
COMMENT ON TABLE bb_issuer_identity_source_records IS
  'Append-only source observations. All new rows are needs_review and cannot bind #17 input_lock without a linked review decision.';
COMMENT ON TABLE bb_issuer_identity_source_reviews IS
  'Append-only reviewer decisions linked to an active database grant and exact immutable evidence record/hash/entity identity.';
