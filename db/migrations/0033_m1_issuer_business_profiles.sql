-- #33 target-issuer AnnualBusinessProfile snapshots. These are private project/run
-- records and are deliberately separate from platform-owned bb_library_profiles.
CREATE TABLE bb_issuer_business_profiles (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL,
  project_id text NOT NULL,
  run_id text NOT NULL,
  input_revision integer NOT NULL CHECK (input_revision > 0),
  input_hash char(64) NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  source_material_id text NOT NULL,
  source_material_version integer NOT NULL CHECK (source_material_version > 0),
  profile_version integer NOT NULL CHECK (profile_version > 0),
  request_id text NOT NULL CHECK (length(btrim(request_id)) BETWEEN 1 AND 128),
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  profile jsonb NOT NULL CHECK (jsonb_typeof(profile) = 'object'),
  profile_sha256 char(64) NOT NULL CHECK (profile_sha256 ~ '^[a-f0-9]{64}$'),
  evidence_refs jsonb NOT NULL CHECK (CASE WHEN jsonb_typeof(evidence_refs) = 'array' THEN jsonb_array_length(evidence_refs) > 0 ELSE false END),
  review_status text NOT NULL DEFAULT 'pending_review' CHECK (review_status = 'pending_review'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, project_id, run_id, profile_version),
  UNIQUE (owner_user_id, project_id, run_id, request_id),
  FOREIGN KEY (owner_user_id, project_id, run_id)
    REFERENCES bb_runs(owner_user_id, project_id, id),
  FOREIGN KEY (owner_user_id, project_id, input_revision)
    REFERENCES bb_input_revisions(owner_user_id, project_id, revision),
  FOREIGN KEY (owner_user_id, project_id, source_material_id, source_material_version)
    REFERENCES bb_material_versions(owner_user_id, project_id, id, version),
  CHECK (COALESCE(profile->>'verificationStatus' = 'pending', false)),
  CHECK (COALESCE(profile->>'profileVersion' = profile_version::text, false)),
  CHECK (COALESCE(length(btrim(profile->>'issuerId')) > 0, false)),
  CHECK (COALESCE(profile->>'fiscalYear' ~ '^\d{4}$', false)),
  CHECK (COALESCE(profile->>'accountingScope' IN ('consolidated','parent','mixed','unknown'), false)),
  CHECK (COALESCE(jsonb_typeof(profile->'lines') = 'array', false)),
  CHECK (COALESCE(jsonb_typeof(profile->'sourceEvidence') = 'array', false))
);

CREATE INDEX bb_issuer_business_profiles_run_idx
  ON bb_issuer_business_profiles(owner_user_id, project_id, run_id, profile_version DESC);
CREATE INDEX bb_issuer_business_profiles_source_idx
  ON bb_issuer_business_profiles(owner_user_id, project_id, source_material_id, source_material_version, profile_version DESC);

CREATE FUNCTION bb_issuer_business_profile_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE run_input_revision integer;
DECLARE run_input_hash char(64);
DECLARE revision_hash char(64);
DECLARE material_refs jsonb;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'issuer business profile snapshots are immutable' USING ERRCODE = '23514';
  END IF;

  SELECT r.input_revision, r.input_hash INTO run_input_revision, run_input_hash
    FROM bb_runs r
   WHERE r.owner_user_id = NEW.owner_user_id AND r.project_id = NEW.project_id AND r.id = NEW.run_id;
  SELECT i.input_hash, i.material_versions INTO revision_hash, material_refs
    FROM bb_input_revisions i
   WHERE i.owner_user_id = NEW.owner_user_id AND i.project_id = NEW.project_id AND i.revision = NEW.input_revision;

  IF run_input_revision IS DISTINCT FROM NEW.input_revision OR run_input_hash IS DISTINCT FROM NEW.input_hash
     OR revision_hash IS DISTINCT FROM NEW.input_hash THEN
    RAISE EXCEPTION 'issuer business profile run/input binding mismatch' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(material_refs) AS ref
     WHERE ref->>'material_id' = NEW.source_material_id
       AND (ref->>'material_version')::integer = NEW.source_material_version
  ) THEN
    RAISE EXCEPTION 'issuer business profile source material is outside the input revision' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER bb_issuer_business_profile_guard
  BEFORE INSERT OR UPDATE OR DELETE ON bb_issuer_business_profiles
  FOR EACH ROW EXECUTE FUNCTION bb_issuer_business_profile_guard();

COMMENT ON TABLE bb_issuer_business_profiles IS
  'Owner-scoped target-issuer annual revenue snapshots for #33. Every row remains pending_review until an authenticated reviewer handoff exists; never a library profile or generation authority.';
