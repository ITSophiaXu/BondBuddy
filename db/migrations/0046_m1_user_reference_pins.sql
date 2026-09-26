-- User supplied structural references are separate from the platform library.
-- Review decisions are append-only; no grant or decision is seeded by migration.
CREATE TABLE bb_user_reference_reviewer_grants (
  id text PRIMARY KEY,
  reviewer_user_id text NOT NULL REFERENCES bb_users(id),
  granted_by text NOT NULL REFERENCES bb_users(id),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id, reviewer_user_id),
  CHECK(reviewer_user_id <> granted_by),
  CHECK(revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE FUNCTION bb_user_reference_grant_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'reference review grants are retained' USING ERRCODE='23514'; END IF;
  IF OLD.revoked_at IS NOT NULL OR NEW.id <> OLD.id OR NEW.reviewer_user_id <> OLD.reviewer_user_id
     OR NEW.granted_by <> OLD.granted_by OR NEW.created_at <> OLD.created_at
     OR NEW.revoked_at IS NULL
  THEN RAISE EXCEPTION 'reference review grant is immutable except one revocation' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bb_user_reference_grant_guard BEFORE UPDATE OR DELETE ON bb_user_reference_reviewer_grants
  FOR EACH ROW EXECUTE FUNCTION bb_user_reference_grant_guard();

CREATE TABLE bb_user_reference_reviews (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL,
  project_id text NOT NULL,
  material_id text NOT NULL,
  material_version integer NOT NULL,
  material_sha256 char(64) NOT NULL CHECK (material_sha256 ~ '^[a-f0-9]{64}$'),
  parse_snapshot_id text NOT NULL,
  target_market text NOT NULL,
  target_offering text NOT NULL,
  target_product text NOT NULL,
  target_document_stage text NOT NULL,
  authorization_status text NOT NULL CHECK (authorization_status IN ('accepted','needs_review','rejected')),
  readability_status text NOT NULL CHECK (readability_status IN ('accepted','needs_review','rejected')),
  applicability_status text NOT NULL CHECK (applicability_status IN ('accepted','needs_review','rejected')),
  status text NOT NULL CHECK (status IN ('accepted','needs_review','rejected')),
  fact_isolation_check_version text NOT NULL CHECK (length(btrim(fact_isolation_check_version)) > 0),
  outline jsonb NOT NULL CHECK (jsonb_typeof(outline) = 'array' AND octet_length(outline::text) <= 32768),
  reviewer_user_id text NOT NULL,
  reviewer_grant_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(owner_user_id,project_id,material_id,material_version)
    REFERENCES bb_material_versions(owner_user_id,project_id,id,version),
  FOREIGN KEY(owner_user_id,project_id,material_id,material_version,parse_snapshot_id)
    REFERENCES bb_parse_snapshots(owner_user_id,project_id,material_id,material_version,id),
  FOREIGN KEY(reviewer_grant_id,reviewer_user_id)
    REFERENCES bb_user_reference_reviewer_grants(id,reviewer_user_id),
  CHECK (status <> 'accepted' OR
    (authorization_status = 'accepted' AND readability_status = 'accepted' AND applicability_status = 'accepted'))
);
CREATE INDEX bb_user_reference_reviews_source_idx ON bb_user_reference_reviews
  (owner_user_id,project_id,material_id,material_version,parse_snapshot_id,created_at DESC,id DESC);

CREATE TABLE bb_user_reference_pins (
  owner_user_id text NOT NULL,
  project_id text NOT NULL,
  input_revision integer NOT NULL,
  material_id text NOT NULL,
  material_version integer NOT NULL,
  material_sha256 char(64) NOT NULL CHECK (material_sha256 ~ '^[a-f0-9]{64}$'),
  parse_snapshot_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('accepted','needs_review','rejected')),
  authorization_status text NOT NULL CHECK (authorization_status IN ('accepted','needs_review','rejected')),
  readability_status text NOT NULL CHECK (readability_status IN ('accepted','needs_review','rejected')),
  applicability_status text NOT NULL CHECK (applicability_status IN ('accepted','needs_review','rejected')),
  target_market text NOT NULL,
  target_offering text NOT NULL,
  target_product text NOT NULL,
  target_document_stage text NOT NULL,
  fact_isolation_check_version text,
  review_id text REFERENCES bb_user_reference_reviews(id),
  reviewer_user_id text,
  reviewer_grant_id text,
  outline jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(outline) = 'array' AND octet_length(outline::text) <= 32768),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_user_id,project_id,input_revision),
  FOREIGN KEY(owner_user_id,project_id,input_revision)
    REFERENCES bb_input_revisions(owner_user_id,project_id,revision),
  FOREIGN KEY(owner_user_id,project_id,material_id,material_version)
    REFERENCES bb_material_versions(owner_user_id,project_id,id,version),
  FOREIGN KEY(owner_user_id,project_id,material_id,material_version,parse_snapshot_id)
    REFERENCES bb_parse_snapshots(owner_user_id,project_id,material_id,material_version,id),
  CHECK (status <> 'accepted' OR
    (authorization_status = 'accepted' AND readability_status = 'accepted' AND applicability_status = 'accepted'
     AND review_id IS NOT NULL AND reviewer_user_id IS NOT NULL AND reviewer_grant_id IS NOT NULL
     AND fact_isolation_check_version IS NOT NULL AND jsonb_array_length(outline) > 0))
);

CREATE TRIGGER bb_user_reference_reviews_immutable BEFORE UPDATE OR DELETE ON bb_user_reference_reviews
  FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();
CREATE TRIGGER bb_user_reference_pins_immutable BEFORE UPDATE OR DELETE ON bb_user_reference_pins
  FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();
