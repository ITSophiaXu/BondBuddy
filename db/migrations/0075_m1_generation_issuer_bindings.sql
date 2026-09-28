-- #33 / #360: project-level generation issuer binding ledger.
-- A binding version is an immutable combination decision over the exact issuer-role
-- materials selected in one locked input revision. Review events are append-only and
-- may only be written by an active, project-scoped issuer_identity_reviewer grant.
-- This is persistence plus a trusted read; it does not unlock the #17 input lock.

CREATE TABLE bb_generation_issuer_bindings (
  id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  owner_user_id text NOT NULL,
  project_id text NOT NULL,
  input_revision integer NOT NULL CHECK (input_revision > 0),
  input_hash char(64) NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  request_id text NOT NULL CHECK (request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  selected_materials jsonb NOT NULL CHECK (jsonb_typeof(selected_materials) = 'array' AND jsonb_array_length(selected_materials) BETWEEN 1 AND 100),
  material_decisions jsonb NOT NULL CHECK (jsonb_typeof(material_decisions) = 'array' AND jsonb_array_length(material_decisions) BETWEEN 1 AND 100),
  disputes jsonb NOT NULL CHECK (jsonb_typeof(disputes) = 'array' AND jsonb_array_length(disputes) <= 500),
  issuer_entity_id text CHECK (issuer_entity_id IS NULL OR issuer_entity_id ~ '^(uscc:[0-9A-HJ-NPQRTUWXY]{18}|entity:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$'),
  content_sha256 char(64) NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, version),
  UNIQUE (owner_user_id, project_id, id, version),
  UNIQUE (owner_user_id, project_id, id, version, content_sha256),
  UNIQUE (owner_user_id, project_id, request_id),
  FOREIGN KEY (owner_user_id, project_id) REFERENCES bb_projects(owner_user_id, id),
  FOREIGN KEY (owner_user_id, project_id, input_revision)
    REFERENCES bb_input_revisions(owner_user_id, project_id, revision)
);

CREATE INDEX bb_generation_issuer_bindings_latest_idx
  ON bb_generation_issuer_bindings(owner_user_id, project_id, id, version DESC);

CREATE FUNCTION bb_generation_issuer_binding_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  revision_hash char(64);
  input_manifest jsonb;
  issuer_roles text[] := ARRAY['audit','financial','interimFinancial','notes'];
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'generation issuer bindings are append-only' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM bb_projects p
      WHERE p.owner_user_id=NEW.owner_user_id AND p.id=NEW.project_id AND p.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'generation issuer binding project is unavailable' USING ERRCODE='23514';
  END IF;
  SELECT input_hash, manifest INTO revision_hash, input_manifest FROM bb_input_revisions
   WHERE owner_user_id=NEW.owner_user_id AND project_id=NEW.project_id AND revision=NEW.input_revision FOR SHARE;
  IF revision_hash IS DISTINCT FROM NEW.input_hash OR input_manifest->>'kind' IS DISTINCT FROM 'generation'
     OR jsonb_typeof(input_manifest->'materials') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'generation issuer binding input revision mismatch' USING ERRCODE='23514';
  END IF;
  -- Every pin must be well-formed, unique, and carry an explicit issuer-role label.
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.selected_materials) m
      WHERE jsonb_typeof(m) <> 'object' OR m->>'role' <> ALL(issuer_roles)
        OR (m->>'material_id') IS NULL OR (m->>'material_version') !~ '^[1-9][0-9]*$'
        OR (m->>'material_sha256') !~ '^[a-f0-9]{64}$' OR (m->>'parse_snapshot_id') IS NULL
        OR (m->>'parse_response_sha256') !~ '^[a-f0-9]{64}$')
     OR (SELECT count(DISTINCT (m->>'material_id') || ':' || (m->>'material_version'))
           FROM jsonb_array_elements(NEW.selected_materials) m) <> jsonb_array_length(NEW.selected_materials) THEN
    RAISE EXCEPTION 'generation issuer binding selected material shape is invalid' USING ERRCODE='23514';
  END IF;
  -- The selected set must equal exactly the issuer-role materials of the locked input revision.
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.selected_materials) sel
      WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(input_manifest->'materials') m
        WHERE m->>'material_id'=sel->>'material_id' AND m->>'material_version'=sel->>'material_version'
          AND m->>'role'=sel->>'role' AND lower(m->>'sha256')=sel->>'material_sha256'))
     OR jsonb_array_length(NEW.selected_materials) <> (SELECT count(*) FROM jsonb_array_elements(input_manifest->'materials') m
        WHERE m->>'role' = ANY(issuer_roles)) THEN
    RAISE EXCEPTION 'generation issuer binding does not cover exactly the selected issuer materials' USING ERRCODE='23514';
  END IF;
  -- Exactly one decision per selected material; every observation pin must match its material pin.
  IF jsonb_array_length(NEW.material_decisions) <> jsonb_array_length(NEW.selected_materials)
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.material_decisions) d
        WHERE jsonb_typeof(d) <> 'object' OR d->>'disposition' NOT IN ('classified','unrelated','pending')
          OR length(btrim(d->>'reason')) NOT BETWEEN 1 AND 2048
          OR jsonb_typeof(d->'observations') <> 'array'
          OR (SELECT count(*) FROM jsonb_array_elements(NEW.selected_materials) sel
                WHERE sel->>'material_id'=d->>'material_id' AND sel->>'material_version'=d->>'material_version') <> 1) THEN
    RAISE EXCEPTION 'generation issuer binding material decision coverage is invalid' USING ERRCODE='23514';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.material_decisions) d
      CROSS JOIN LATERAL jsonb_array_elements(d->'observations') o
      WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.selected_materials) sel
        WHERE sel->>'material_id'=o->>'material_id' AND sel->>'material_version'=o->>'material_version'
          AND sel->>'material_sha256'=o->>'material_sha256' AND sel->>'parse_snapshot_id'=o->>'parse_snapshot_id'
          AND sel->>'parse_response_sha256'=o->>'parse_response_sha256')) THEN
    RAISE EXCEPTION 'generation issuer binding observation pin is outside its material pin' USING ERRCODE='23514';
  END IF;
  -- A declared issuer must be the single verified entity of at least one compiler observation.
  IF NEW.issuer_entity_id IS NOT NULL AND (
     EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.material_decisions) d
       CROSS JOIN LATERAL jsonb_array_elements(d->'observations') o
       WHERE o->>'subject_relation'='issuer_compiler' AND o->>'verified_entity_id' IS DISTINCT FROM NEW.issuer_entity_id)
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.material_decisions) d
       CROSS JOIN LATERAL jsonb_array_elements(d->'observations') o
       WHERE o->>'subject_relation'='issuer_compiler' AND o->>'verified_entity_id'=NEW.issuer_entity_id)) THEN
    RAISE EXCEPTION 'generation issuer binding issuer entity is not the compiler consensus' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER bb_generation_issuer_binding_guard
  BEFORE INSERT OR UPDATE OR DELETE ON bb_generation_issuer_bindings
  FOR EACH ROW EXECUTE FUNCTION bb_generation_issuer_binding_guard();
CREATE FUNCTION bb_generation_issuer_binding_no_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'generation issuer bindings are append-only' USING ERRCODE='23514'; END $$;
CREATE TRIGGER bb_generation_issuer_binding_no_truncate BEFORE TRUNCATE
  ON bb_generation_issuer_bindings FOR EACH STATEMENT EXECUTE FUNCTION bb_generation_issuer_binding_no_truncate();

CREATE TABLE bb_generation_issuer_binding_reviews (
  sequence_id bigserial UNIQUE NOT NULL,
  id text PRIMARY KEY,
  owner_user_id text NOT NULL,
  project_id text NOT NULL,
  binding_id text NOT NULL,
  binding_version integer NOT NULL CHECK (binding_version > 0),
  binding_content_sha256 char(64) NOT NULL CHECK (binding_content_sha256 ~ '^[a-f0-9]{64}$'),
  action text NOT NULL CHECK (action IN ('request_more_evidence','approve','withdraw')),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2048),
  authority text NOT NULL CHECK (authority = 'issuer_identity_reviewer'),
  reviewer_user_id text NOT NULL REFERENCES bb_users(id),
  reviewer_grant_id text NOT NULL,
  request_id text NOT NULL CHECK (request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, project_id, id),
  UNIQUE (owner_user_id, project_id, request_id),
  FOREIGN KEY (owner_user_id, project_id, binding_id, binding_version, binding_content_sha256)
    REFERENCES bb_generation_issuer_bindings(owner_user_id, project_id, id, version, content_sha256),
  FOREIGN KEY (reviewer_user_id, reviewer_grant_id)
    REFERENCES bb_issuer_identity_reviewer_grants(user_id, id)
);

CREATE INDEX bb_generation_issuer_binding_reviews_latest_idx
  ON bb_generation_issuer_binding_reviews(owner_user_id, project_id, binding_id, binding_version, sequence_id DESC);

CREATE FUNCTION bb_generation_issuer_binding_review_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  grant_revoked timestamptz;
  grant_active boolean;
  prior_action text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'generation issuer binding reviews are append-only' USING ERRCODE='23514';
  END IF;
  SELECT g.revoked_at, (u.status = 'active') INTO grant_revoked, grant_active
    FROM bb_issuer_identity_reviewer_grants g JOIN bb_users u ON u.id = g.user_id
   WHERE g.id=NEW.reviewer_grant_id AND g.user_id=NEW.reviewer_user_id AND g.role='issuer_identity_reviewer'
     AND g.scope_owner_user_id=NEW.owner_user_id AND g.scope_project_id=NEW.project_id FOR SHARE OF g, u;
  IF NOT FOUND OR grant_revoked IS NOT NULL OR grant_active IS NOT TRUE OR NEW.reviewer_user_id=NEW.owner_user_id THEN
    RAISE EXCEPTION 'current exact issuer identity reviewer grant required' USING ERRCODE='42501';
  END IF;
  SELECT action INTO prior_action FROM bb_generation_issuer_binding_reviews
   WHERE owner_user_id=NEW.owner_user_id AND project_id=NEW.project_id
     AND binding_id=NEW.binding_id AND binding_version=NEW.binding_version
   ORDER BY sequence_id DESC LIMIT 1;
  IF prior_action='withdrawn' THEN
    RAISE EXCEPTION 'withdrawn generation issuer binding version is terminal' USING ERRCODE='23514';
  END IF;
  IF prior_action='approved' AND NEW.action <> 'withdraw' THEN
    RAISE EXCEPTION 'approved generation issuer binding version only permits withdrawal' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER bb_generation_issuer_binding_review_guard
  BEFORE INSERT OR UPDATE OR DELETE ON bb_generation_issuer_binding_reviews
  FOR EACH ROW EXECUTE FUNCTION bb_generation_issuer_binding_review_guard();
CREATE FUNCTION bb_generation_issuer_binding_review_no_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'generation issuer binding reviews are append-only' USING ERRCODE='23514'; END $$;
CREATE TRIGGER bb_generation_issuer_binding_review_no_truncate BEFORE TRUNCATE
  ON bb_generation_issuer_binding_reviews FOR EACH STATEMENT EXECUTE FUNCTION bb_generation_issuer_binding_review_no_truncate();

COMMENT ON TABLE bb_generation_issuer_bindings IS
  'Append-only #33/#360 project-level generation issuer combination decision pinned to exact owner/project/input revision and issuer-role material/parse pins. Browser issuer_name, reference issuers and annual revenue profiles never appear here.';
COMMENT ON TABLE bb_generation_issuer_binding_reviews IS
  'Append-only approve/request_more_evidence/withdraw events for a generation issuer binding version, written only by an active project-scoped issuer_identity_reviewer.';
