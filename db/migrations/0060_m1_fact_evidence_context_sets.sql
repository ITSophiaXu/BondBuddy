-- #15: immutable, server-derived versioned evidence context manifests. This is
-- evidence identity only; it does not approve candidates or release facts.
CREATE TABLE bb_fact_evidence_context_sets (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL,
  project_id text NOT NULL,
  candidate_id text NOT NULL,
  input_revision integer NOT NULL CHECK (input_revision > 0),
  input_hash char(64) NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  material_id text NOT NULL,
  material_version integer NOT NULL CHECK (material_version > 0),
  snapshot_id text NOT NULL,
  parser_version text NOT NULL CHECK (length(btrim(parser_version)) > 0),
  parse_response_sha256 char(64) NOT NULL CHECK (parse_response_sha256 ~ '^[a-f0-9]{64}$'),
  content_sha256 char(64) NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  schema_version text NOT NULL CHECK (schema_version = 'fact-evidence-context-v1'),
  evidence_set_sha256 char(64) NOT NULL CHECK (evidence_set_sha256 ~ '^[a-f0-9]{64}$'),
  completeness_status text NOT NULL CHECK (completeness_status IN ('complete','incomplete')),
  reviewable boolean NOT NULL CHECK (reviewable = (completeness_status = 'complete')),
  manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest) = 'object' AND octet_length(manifest::text) <= 1048576),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, project_id, candidate_id, evidence_set_sha256),
  UNIQUE (owner_user_id, project_id, id),
  FOREIGN KEY (owner_user_id, project_id, candidate_id)
    REFERENCES bb_fact_candidates(owner_user_id, project_id, id),
  FOREIGN KEY (owner_user_id, project_id, input_revision)
    REFERENCES bb_input_revisions(owner_user_id, project_id, revision),
  FOREIGN KEY (owner_user_id, project_id, material_id, material_version, snapshot_id)
    REFERENCES bb_parse_snapshots(owner_user_id, project_id, material_id, material_version, id),
  FOREIGN KEY (owner_user_id, material_id, material_version)
    REFERENCES bb_material_versions(owner_user_id, id, version),
  CHECK (manifest->>'schema_version' IS NOT DISTINCT FROM schema_version),
  CHECK (manifest->>'candidate_id' IS NOT DISTINCT FROM candidate_id),
  CHECK ((manifest->>'input_revision')::integer IS NOT DISTINCT FROM input_revision),
  CHECK (manifest->>'input_hash' IS NOT DISTINCT FROM input_hash),
  CHECK (manifest->>'snapshot_id' IS NOT DISTINCT FROM snapshot_id),
  CHECK (manifest->>'evidence_set_sha256' IS NOT DISTINCT FROM evidence_set_sha256),
  CHECK (manifest->>'completeness_status' IS NOT DISTINCT FROM completeness_status),
  CHECK ((manifest->>'reviewable')::boolean IS NOT DISTINCT FROM reviewable)
);

CREATE INDEX bb_fact_evidence_context_candidate_idx
  ON bb_fact_evidence_context_sets(owner_user_id, project_id, candidate_id, created_at DESC);

CREATE FUNCTION bb_reject_fact_evidence_context_set_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'fact evidence context sets are immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER bb_fact_evidence_context_set_immutable BEFORE UPDATE OR DELETE ON bb_fact_evidence_context_sets
  FOR EACH ROW EXECUTE FUNCTION bb_reject_fact_evidence_context_set_rewrite();

COMMENT ON TABLE bb_fact_evidence_context_sets IS
  'Server-derived immutable #15 evidence context identity. Reviewability only means the evidence inventory is complete; no reviewer decision or fact release is implied.';
