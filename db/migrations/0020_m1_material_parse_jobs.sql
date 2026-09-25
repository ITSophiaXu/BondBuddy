-- #17/#13/#76 seam: a durable material parse job runs on the existing bb_jobs lease
-- model without a run. It is enqueued with the verified upload completion, bound to one
-- owner + immutable material version + hash + parser version, and has one final state.
ALTER TABLE bb_jobs ALTER COLUMN run_id DROP NOT NULL;
ALTER TABLE bb_jobs
  ADD COLUMN project_id text,
  ADD COLUMN material_id text,
  ADD COLUMN material_version integer,
  ADD COLUMN material_sha256 char(64),
  ADD COLUMN parser_version text,
  ADD COLUMN trace_id text,
  ADD COLUMN max_attempts integer,
  ADD COLUMN error_code text,
  ADD COLUMN result jsonb;

ALTER TABLE bb_jobs ADD CONSTRAINT bb_job_binding CHECK (
  (job_type <> 'parse' AND run_id IS NOT NULL AND material_id IS NULL)
  OR (job_type = 'parse' AND subtype = 'material_parse' AND run_id IS NULL
      AND project_id IS NOT NULL AND material_id IS NOT NULL AND material_version > 0
      AND material_sha256 ~ '^[a-f0-9]{64}$'
      AND parser_version ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
      AND trace_id IS NOT NULL AND max_attempts BETWEEN 1 AND 10
      AND ((state = 'failed') = (error_code IS NOT NULL))
      AND (error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{0,63}$')
      AND (state <> 'succeeded' OR result IS NOT NULL))
);
ALTER TABLE bb_jobs ADD CONSTRAINT bb_job_material_fk
  FOREIGN KEY (owner_user_id, project_id, material_id, material_version)
  REFERENCES bb_material_versions(owner_user_id, project_id, id, version);
-- Idempotency: one job per owner, material version, subtype and deployment parser version.
CREATE UNIQUE INDEX bb_material_parse_job_key
  ON bb_jobs(owner_user_id, project_id, material_id, material_version, subtype, parser_version)
  WHERE job_type = 'parse';
CREATE INDEX bb_material_parse_job_claim_idx
  ON bb_jobs(state, lease_until, created_at) WHERE job_type = 'parse';

CREATE FUNCTION bb_guard_material_parse_job() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.job_type = 'parse' AND NOT EXISTS (
      SELECT 1 FROM bb_material_versions m
       WHERE m.owner_user_id = NEW.owner_user_id AND m.project_id = NEW.project_id
         AND m.id = NEW.material_id AND m.version = NEW.material_version
         AND m.deleted_at IS NULL AND lower(btrim(m.sha256::text)) = NEW.material_sha256
    ) THEN RAISE EXCEPTION 'parse job must bind an active material version and hash' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.job_type = 'parse' THEN
    IF NEW.job_type IS DISTINCT FROM OLD.job_type OR NEW.subtype IS DISTINCT FROM OLD.subtype
       OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id OR NEW.project_id IS DISTINCT FROM OLD.project_id
       OR NEW.material_id IS DISTINCT FROM OLD.material_id OR NEW.material_version IS DISTINCT FROM OLD.material_version
       OR NEW.material_sha256 IS DISTINCT FROM OLD.material_sha256 OR NEW.parser_version IS DISTINCT FROM OLD.parser_version
       OR NEW.trace_id IS DISTINCT FROM OLD.trace_id OR NEW.max_attempts IS DISTINCT FROM OLD.max_attempts
       OR NEW.run_id IS DISTINCT FROM OLD.run_id
    THEN RAISE EXCEPTION 'parse job binding is immutable' USING ERRCODE = '23514'; END IF;
    IF OLD.state IN ('succeeded','failed','cancelled') THEN
      RAISE EXCEPTION 'parse job already has a final state' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bb_material_parse_job_guard BEFORE INSERT OR UPDATE ON bb_jobs
  FOR EACH ROW EXECUTE FUNCTION bb_guard_material_parse_job();
CREATE FUNCTION bb_reject_material_parse_job_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.job_type = 'parse' THEN RAISE EXCEPTION 'parse jobs are retained' USING ERRCODE = '23514'; END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER bb_material_parse_job_retained BEFORE DELETE ON bb_jobs
  FOR EACH ROW EXECUTE FUNCTION bb_reject_material_parse_job_delete();

COMMENT ON COLUMN bb_jobs.checkpoint IS
  'Parse jobs: {"stages":{"<stage>":{...}}}; a completed stage is never redone after lease loss.';
