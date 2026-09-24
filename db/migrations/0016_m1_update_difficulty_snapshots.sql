-- #76 internal, immutable preflight comparison snapshots. No public DTO/API is
-- introduced here; callers must supply server-verified target period evidence.
CREATE TABLE bb_update_difficulty_snapshots (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL,
  project_id text NOT NULL,
  request_id text NOT NULL,
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  source_material_id text NOT NULL,
  source_material_version integer NOT NULL CHECK (source_material_version > 0),
  source_profile_version integer NOT NULL CHECK (source_profile_version > 0),
  target_revision integer NOT NULL CHECK (target_revision > 0),
  source_market text,
  source_offering text,
  target_market text,
  target_offering text,
  input_revision integer,
  input_hash char(64),
  financial_material_versions jsonb NOT NULL CHECK (jsonb_typeof(financial_material_versions) = 'array'),
  comparison_input jsonb NOT NULL CHECK (jsonb_typeof(comparison_input) = 'object'),
  old_profile_completeness text NOT NULL CHECK (old_profile_completeness IN ('complete','incomplete','undetermined')),
  estimate jsonb NOT NULL CHECK (jsonb_typeof(estimate) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, project_id, request_id),
  UNIQUE (owner_user_id, project_id, id),
  -- One source profile can be compared with one immutable target/input revision.
  -- NULL is a real identity when no input revision has been locked yet.
  UNIQUE NULLS NOT DISTINCT (owner_user_id, project_id, source_material_id, source_material_version,
    source_profile_version, target_revision, input_revision),
  FOREIGN KEY (owner_user_id, project_id) REFERENCES bb_projects(owner_user_id, id),
  FOREIGN KEY (owner_user_id, project_id, source_material_id, source_material_version, source_profile_version)
    REFERENCES bb_historical_profiles(owner_user_id, project_id, material_id, material_version, profile_version),
  FOREIGN KEY (owner_user_id, project_id, input_revision)
    REFERENCES bb_input_revisions(owner_user_id, project_id, revision),
  CHECK ((input_revision IS NULL) = (input_hash IS NULL)),
  CHECK ((estimate->>'profileVersion')::integer = source_profile_version),
  CHECK ((estimate->>'targetRevision')::integer = target_revision),
  CHECK ((estimate->>'status') <> 'ready' OR (estimate->>'estimatedN') IS NOT NULL),
  CHECK ((estimate->>'status') <> 'needs_confirmation' OR (estimate->>'estimatedN') IS NULL)
);

CREATE INDEX bb_update_difficulty_owner_project_idx
  ON bb_update_difficulty_snapshots(owner_user_id, project_id, created_at DESC, id);

CREATE FUNCTION bb_reject_update_difficulty_snapshot_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'update difficulty snapshots are immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER bb_update_difficulty_snapshot_immutable
  BEFORE UPDATE OR DELETE ON bb_update_difficulty_snapshots
  FOR EACH ROW EXECUTE FUNCTION bb_reject_update_difficulty_snapshot_change();
