-- One append-only, version-bound proof per library profile. The JSON payload contains every
-- comparable revenue line, page evidence, denominator, ranking and signed classification review.
-- Existing published profiles are not backfilled or automatically declared eligible.
CREATE TABLE bb_library_revenue_rank_proofs (
  id text PRIMARY KEY,
  profile_id text NOT NULL REFERENCES bb_library_profiles(id),
  profile_version integer NOT NULL CHECK (profile_version > 0),
  profile_hash text NOT NULL CHECK (profile_hash ~ '^[0-9a-f]{64}$'),
  proof_hash text NOT NULL CHECK (proof_hash ~ '^[0-9a-f]{64}$'),
  proof jsonb NOT NULL CHECK (jsonb_typeof(proof) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (profile_id, profile_version),
  CHECK (proof->>'profile_id' = profile_id AND (proof->>'profile_version')::integer = profile_version
    AND proof->>'profile_hash' = profile_hash)
);
CREATE FUNCTION bb_library_revenue_rank_proof_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'revenue rank proof is immutable' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM bb_library_profiles p WHERE p.id=NEW.profile_id
    AND p.profile_version=NEW.profile_version AND p.state='published') THEN
    RAISE EXCEPTION 'revenue rank proof requires matching published profile version' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bb_library_revenue_rank_proof_guard BEFORE INSERT OR UPDATE OR DELETE ON bb_library_revenue_rank_proofs
  FOR EACH ROW EXECUTE FUNCTION bb_library_revenue_rank_proof_immutable();
COMMENT ON TABLE bb_library_revenue_rank_proofs IS 'Internal full-revenue proof; never exposed through public routes. A later profile version needs a new proof.';
