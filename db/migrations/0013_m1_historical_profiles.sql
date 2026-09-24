-- #76 owner-scoped, immutable snapshots for historical prospectus recognition.
-- A profile is tied to exactly one persisted material version; corrections append
-- a new profile version and never rewrite an existing or run-pinned snapshot.
CREATE FUNCTION bb_historical_profile_ready_is_supported(profile jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT COALESCE(CASE WHEN jsonb_typeof(profile->'reporting_periods') = 'array' THEN
    jsonb_array_length(profile->'reporting_periods') > 0
    AND (profile->'source_market'->>'value') IS NOT NULL
    AND profile->'source_market'->>'status' = 'recognized'
    AND jsonb_typeof(profile->'source_market'->'uncertainty') = 'array'
    AND jsonb_array_length(profile->'source_market'->'uncertainty') = 0
    AND jsonb_typeof(profile->'source_market'->'provenance'->'evidence_refs') = 'array'
    AND jsonb_array_length(profile->'source_market'->'provenance'->'evidence_refs') > 0
    AND (profile->'source_offering'->>'value') IS NOT NULL
    AND profile->'source_offering'->>'status' = 'recognized'
    AND jsonb_typeof(profile->'source_offering'->'uncertainty') = 'array'
    AND jsonb_array_length(profile->'source_offering'->'uncertainty') = 0
    AND jsonb_typeof(profile->'source_offering'->'provenance'->'evidence_refs') = 'array'
    AND jsonb_array_length(profile->'source_offering'->'provenance'->'evidence_refs') > 0
    AND (profile->'latest_reporting_cutoff'->>'value') IS NOT NULL
    AND profile->'latest_reporting_cutoff'->>'status' = 'recognized'
    AND jsonb_typeof(profile->'latest_reporting_cutoff'->'uncertainty') = 'array'
    AND jsonb_array_length(profile->'latest_reporting_cutoff'->'uncertainty') = 0
    AND jsonb_typeof(profile->'latest_reporting_cutoff'->'provenance'->'evidence_refs') = 'array'
    AND jsonb_array_length(profile->'latest_reporting_cutoff'->'provenance'->'evidence_refs') > 0
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(profile->'reporting_periods') AS period
       WHERE (period->>'start') IS NULL OR (period->>'end') IS NULL
          OR period->>'period_kind' IS NULL OR period->>'period_kind' NOT IN ('annual','interim')
          OR period->>'scope' IS NULL OR period->>'scope' NOT IN ('consolidated','parent')
          OR period->>'status' IS NULL OR period->>'status' <> 'recognized'
          OR (period->>'start')::date > (period->>'end')::date
          OR jsonb_typeof(period->'uncertainty') <> 'array'
          OR jsonb_array_length(period->'uncertainty') <> 0
          OR jsonb_typeof(period->'provenance'->'evidence_refs') <> 'array'
          OR jsonb_array_length(period->'provenance'->'evidence_refs') = 0
    )
    AND (profile->'latest_reporting_cutoff'->>'value')::date = (
      SELECT max((period->>'end')::date)
        FROM jsonb_array_elements(profile->'reporting_periods') AS period
    )
  ELSE false END, false)
$$;

CREATE FUNCTION bb_historical_profile_provenance_matches_material(profile jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT COALESCE(CASE WHEN jsonb_typeof(profile->'reporting_periods') = 'array' THEN
    (profile->'source_market'->'provenance'->>'material_id') = profile->>'material_id'
    AND (profile->'source_market'->'provenance'->>'material_version')::integer = (profile->>'material_version')::integer
    AND (profile->'source_offering'->'provenance'->>'material_id') = profile->>'material_id'
    AND (profile->'source_offering'->'provenance'->>'material_version')::integer = (profile->>'material_version')::integer
    AND (profile->'latest_reporting_cutoff'->'provenance'->>'material_id') = profile->>'material_id'
    AND (profile->'latest_reporting_cutoff'->'provenance'->>'material_version')::integer = (profile->>'material_version')::integer
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(profile->'reporting_periods') AS period
       WHERE (period->'provenance'->>'material_id') IS DISTINCT FROM profile->>'material_id'
          OR (period->'provenance'->>'material_version')::integer IS DISTINCT FROM (profile->>'material_version')::integer
    )
  ELSE false END, false)
$$;

CREATE TABLE bb_historical_profiles (
  owner_user_id text NOT NULL,
  project_id text NOT NULL,
  material_id text NOT NULL,
  material_version integer NOT NULL CHECK (material_version > 0),
  profile_version integer NOT NULL CHECK (profile_version > 0),
  request_id text NOT NULL,
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  write_kind text NOT NULL CHECK (write_kind IN ('recognition','correction')),
  recognition jsonb NOT NULL CHECK (jsonb_typeof(recognition) = 'object'),
  actor_id text,
  correction_reason text,
  correction_evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(correction_evidence_refs) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, project_id, material_id, material_version, profile_version),
  UNIQUE (owner_user_id, project_id, material_id, material_version, request_id),
  FOREIGN KEY (owner_user_id, project_id) REFERENCES bb_projects(owner_user_id, id),
  FOREIGN KEY (owner_user_id, project_id, material_id, material_version)
    REFERENCES bb_material_versions(owner_user_id, project_id, id, version),
  CHECK ((write_kind = 'recognition' AND actor_id IS NULL AND correction_reason IS NULL
            AND correction_evidence_refs = '[]'::jsonb)
      OR (write_kind = 'correction' AND actor_id IS NOT NULL AND length(btrim(actor_id)) > 0
            AND correction_reason IS NOT NULL AND length(btrim(correction_reason)) > 0)),
  CHECK ((recognition->>'material_id') = material_id),
  CHECK ((recognition->>'material_version')::integer = material_version),
  CHECK ((recognition->>'profile_version')::integer = profile_version),
  CHECK (bb_historical_profile_provenance_matches_material(recognition)),
  CHECK ((recognition->>'state') <> 'ready' OR bb_historical_profile_ready_is_supported(recognition))
);

CREATE INDEX bb_historical_profiles_latest_idx
  ON bb_historical_profiles(owner_user_id, project_id, material_id, material_version, profile_version DESC);
CREATE INDEX bb_historical_profiles_request_idx
  ON bb_historical_profiles(owner_user_id, project_id, request_id);

CREATE FUNCTION bb_reject_historical_profile_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'historical profiles are immutable snapshots' USING ERRCODE='23514'; END $$;
CREATE TRIGGER bb_historical_profile_immutable
  BEFORE UPDATE OR DELETE ON bb_historical_profiles
  FOR EACH ROW EXECUTE FUNCTION bb_reject_historical_profile_change();
