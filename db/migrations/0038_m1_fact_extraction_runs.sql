-- #15: idempotent, revision-pinned parse-to-fact extraction results. The full
-- source text stays in the private parse snapshot/evidence tables; review rows
-- retain only exact evidence IDs and machine-readable reasons.
CREATE TABLE bb_fact_extraction_runs (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL,
  project_id text NOT NULL,
  input_revision integer NOT NULL CHECK (input_revision > 0),
  input_hash char(64) NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  material_id text NOT NULL,
  material_version integer NOT NULL CHECK (material_version > 0),
  snapshot_id text NOT NULL,
  parse_response_sha256 char(64) NOT NULL CHECK (parse_response_sha256 ~ '^[a-f0-9]{64}$'),
  extractor_id text NOT NULL CHECK (length(extractor_id) BETWEEN 1 AND 128),
  extractor_version text NOT NULL CHECK (length(extractor_version) BETWEEN 1 AND 128),
  result_sha256 char(64) NOT NULL CHECK (result_sha256 ~ '^[a-f0-9]{64}$'),
  candidate_ids jsonb NOT NULL CHECK (jsonb_typeof(candidate_ids) = 'array'),
  needs_review jsonb NOT NULL CHECK (jsonb_typeof(needs_review) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_user_id, project_id, input_revision, material_id, material_version, snapshot_id, extractor_id, extractor_version),
  UNIQUE(owner_user_id, project_id, id),
  FOREIGN KEY(owner_user_id, project_id, input_revision)
    REFERENCES bb_input_revisions(owner_user_id, project_id, revision),
  FOREIGN KEY(owner_user_id, material_id, material_version)
    REFERENCES bb_material_versions(owner_user_id, id, version),
  FOREIGN KEY(owner_user_id, project_id, material_id, material_version, snapshot_id)
    REFERENCES bb_parse_snapshots(owner_user_id, project_id, material_id, material_version, id)
);

CREATE INDEX bb_fact_extraction_runs_material_idx
  ON bb_fact_extraction_runs(owner_user_id, project_id, material_id, material_version, created_at DESC);

CREATE FUNCTION bb_reject_fact_extraction_run_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'fact extraction runs are immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER bb_fact_extraction_run_immutable BEFORE UPDATE OR DELETE ON bb_fact_extraction_runs
  FOR EACH ROW EXECUTE FUNCTION bb_reject_fact_extraction_run_rewrite();

COMMENT ON TABLE bb_fact_extraction_runs IS
  'Append-only #15 semantic extraction ledger; candidate rows, review evidence refs and outbox event commit atomically under the pinned input and parse snapshot.';
