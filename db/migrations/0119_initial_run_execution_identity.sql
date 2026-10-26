-- Give the original execution an immutable identity consumed by every run lease.
-- This migration does not authorise successor executions, adoption or pricing.
-- Writers create the immutable input before its run. Take both locks in that
-- order so FK setup/backfill cannot deadlock with an in-flight creation.
LOCK TABLE bb_input_revisions, bb_runs IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE bb_run_execution_versions (
  owner_user_id text NOT NULL,
  project_id text NOT NULL,
  run_id text NOT NULL,
  execution_version integer NOT NULL CHECK (execution_version = 1),
  input_revision integer NOT NULL CHECK (input_revision > 0),
  input_hash char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, execution_version),
  FOREIGN KEY (owner_user_id, project_id, run_id)
    REFERENCES bb_runs(owner_user_id, project_id, id),
  FOREIGN KEY (owner_user_id, project_id, input_revision)
    REFERENCES bb_input_revisions(owner_user_id, project_id, revision)
);

CREATE FUNCTION bb_check_initial_execution() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM bb_runs r
    WHERE r.id=NEW.run_id AND r.owner_user_id=NEW.owner_user_id AND r.project_id=NEW.project_id
      AND r.input_revision=NEW.input_revision AND r.input_hash=NEW.input_hash
  ) THEN
    RAISE EXCEPTION 'initial execution must match the original run input'
      USING ERRCODE='23514', CONSTRAINT='bb_initial_execution_origin';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER bb_initial_execution_origin BEFORE INSERT ON bb_run_execution_versions
  FOR EACH ROW EXECUTE FUNCTION bb_check_initial_execution();

INSERT INTO bb_run_execution_versions(owner_user_id, project_id, run_id, execution_version, input_revision, input_hash, created_at)
  SELECT owner_user_id, project_id, id, 1, input_revision, input_hash, created_at FROM bb_runs;

CREATE FUNCTION bb_guard_run_execution_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'run execution identity is immutable'
    USING ERRCODE='23514', CONSTRAINT='bb_run_execution_immutable';
END; $$;
CREATE TRIGGER bb_run_execution_immutable BEFORE UPDATE OR DELETE ON bb_run_execution_versions
  FOR EACH ROW EXECUTE FUNCTION bb_guard_run_execution_immutable();

CREATE FUNCTION bb_create_initial_execution() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO bb_run_execution_versions(owner_user_id, project_id, run_id, execution_version, input_revision, input_hash, created_at)
    VALUES(NEW.owner_user_id, NEW.project_id, NEW.id, 1, NEW.input_revision, NEW.input_hash, NEW.created_at);
  RETURN NEW;
END; $$;
CREATE TRIGGER bb_run_initial_execution AFTER INSERT ON bb_runs
  FOR EACH ROW EXECUTE FUNCTION bb_create_initial_execution();
