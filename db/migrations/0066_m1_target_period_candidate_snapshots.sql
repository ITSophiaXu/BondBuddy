-- #76: immutable, owner/project-scoped pre-lock candidate envelopes (migration 0066).
-- This is evidence proposal storage only. It does not confirm periods or derive N.
CREATE FUNCTION bb_target_period_candidate_content_pending(value jsonb) RETURNS boolean LANGUAGE SQL IMMUTABLE AS $$
  SELECT COALESCE(jsonb_typeof(value->'candidates') = 'array', false) AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(value->'candidates') AS candidate
    WHERE candidate->>'status' IS DISTINCT FROM 'needs_confirmation'
  )
$$;

CREATE TABLE bb_target_period_candidate_snapshots (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL,
  project_id text NOT NULL,
  candidate_set_id text NOT NULL,
  candidate_set_version integer NOT NULL CHECK (candidate_set_version > 0),
  content_sha256 char(64) NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  content jsonb NOT NULL CHECK (jsonb_typeof(content) = 'object'),
  request_id text NOT NULL CHECK (length(btrim(request_id)) BETWEEN 1 AND 128),
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, project_id, request_id),
  UNIQUE (owner_user_id, project_id, candidate_set_id, candidate_set_version),
  UNIQUE (owner_user_id, project_id, candidate_set_id, candidate_set_version, content_sha256),
  FOREIGN KEY (owner_user_id, project_id) REFERENCES bb_projects(owner_user_id, id),
  CHECK (content->>'schema_version' IS NOT DISTINCT FROM 'target-period-candidate-snapshot-v1'),
  CHECK (content->>'owner_user_id' IS NOT DISTINCT FROM owner_user_id),
  CHECK (content->>'project_id' IS NOT DISTINCT FROM project_id),
  CHECK (content->>'status' IS NOT DISTINCT FROM 'needs_confirmation'),
  CHECK (content->>'completeness' IS NOT DISTINCT FROM 'not_determined'),
  CHECK (bb_target_period_candidate_content_pending(content))
);

CREATE INDEX bb_target_period_candidate_snapshots_project_idx
  ON bb_target_period_candidate_snapshots(owner_user_id, project_id, created_at DESC, id DESC);

CREATE FUNCTION bb_reject_target_period_candidate_snapshot_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'target period candidate snapshots are append-only' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER bb_target_period_candidate_snapshot_immutable
  BEFORE UPDATE OR DELETE ON bb_target_period_candidate_snapshots
  FOR EACH ROW EXECUTE FUNCTION bb_reject_target_period_candidate_snapshot_change();

COMMENT ON TABLE bb_target_period_candidate_snapshots IS
  'Immutable #76 source-period proposals. Every envelope remains needs_confirmation; this table is not a target confirmation, period decision, or N result.';
