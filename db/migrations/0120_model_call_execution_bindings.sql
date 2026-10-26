-- Bind real model work to its exact immutable execution input. This does not
-- enable successor executions or change the original attempt/result evidence.
-- Drain run -> job writers before taking the attempt lock: a weaker table lock
-- could retain an in-flight FOR UPDATE row lock while its intent INSERT waits.
LOCK TABLE bb_runs, bb_jobs, bb_snapshot_refs, bb_model_call_attempts, bb_run_execution_versions IN EXCLUSIVE MODE;

ALTER TABLE bb_run_execution_versions ADD CONSTRAINT bb_execution_exact_input_key
  UNIQUE(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash);

CREATE TABLE bb_model_call_execution_bindings (
  attempt_id text PRIMARY KEY,
  owner_user_id text NOT NULL,
  project_id text NOT NULL,
  run_id text NOT NULL,
  job_id text NOT NULL,
  execution_version integer NOT NULL CHECK(execution_version > 0),
  input_revision integer NOT NULL CHECK(input_revision > 0),
  input_hash char(64) NOT NULL CHECK(input_hash ~ '^[a-f0-9]{64}$'),
  prompt_snapshot_ref text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(owner_user_id,attempt_id) REFERENCES bb_model_call_attempts(owner_user_id,id),
  FOREIGN KEY(owner_user_id,job_id,run_id) REFERENCES bb_jobs(owner_user_id,id,run_id),
  FOREIGN KEY(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash)
    REFERENCES bb_run_execution_versions(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash),
  FOREIGN KEY(owner_user_id,project_id,run_id,prompt_snapshot_ref)
    REFERENCES bb_snapshot_refs(owner_user_id,project_id,run_id,id)
);
CREATE INDEX bb_model_call_execution_lookup_idx
  ON bb_model_call_execution_bindings(owner_user_id,run_id,execution_version,job_id);

CREATE FUNCTION bb_check_model_call_execution_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM bb_model_call_attempts a
    JOIN bb_jobs j ON j.id=a.job_id AND j.owner_user_id=a.owner_user_id
    JOIN bb_runs r ON r.id=j.run_id AND r.owner_user_id=j.owner_user_id
    JOIN bb_run_execution_versions e ON e.owner_user_id=r.owner_user_id AND e.project_id=r.project_id AND e.run_id=r.id
    JOIN bb_input_revisions i ON i.owner_user_id=e.owner_user_id AND i.project_id=e.project_id
      AND i.revision=e.input_revision AND i.input_hash=e.input_hash
    JOIN bb_snapshot_refs s ON s.id=a.prompt_snapshot_id AND s.owner_user_id=e.owner_user_id
      AND s.project_id=e.project_id AND s.run_id=e.run_id AND s.snapshot_kind='model_request'
      AND s.input_revision=e.input_revision AND s.input_hash=e.input_hash
    WHERE a.id=NEW.attempt_id AND a.owner_user_id=NEW.owner_user_id AND j.id=NEW.job_id
      AND r.id=NEW.run_id AND r.project_id=NEW.project_id AND e.execution_version=NEW.execution_version
      AND e.input_revision=NEW.input_revision AND e.input_hash=NEW.input_hash AND s.id=NEW.prompt_snapshot_ref
  ) THEN
    RAISE EXCEPTION 'model call must match its exact execution input and prompt'
      USING ERRCODE='23514', CONSTRAINT='bb_model_call_execution_exact';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER bb_model_call_execution_exact BEFORE INSERT ON bb_model_call_execution_bindings
  FOR EACH ROW EXECUTE FUNCTION bb_check_model_call_execution_binding();
CREATE TRIGGER bb_model_call_execution_immutable BEFORE UPDATE OR DELETE ON bb_model_call_execution_bindings
  FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();

-- Only historical prompts carrying exact input evidence qualify for backfill.
-- Unprompted calls and incomplete/mismatched old prompts remain unbound; readers
-- reject their use as provider results instead of inventing an execution origin.
INSERT INTO bb_model_call_execution_bindings(attempt_id,owner_user_id,project_id,run_id,job_id,
  execution_version,input_revision,input_hash,prompt_snapshot_ref,created_at)
SELECT a.id,a.owner_user_id,r.project_id,r.id,j.id,e.execution_version,e.input_revision,e.input_hash,s.id,a.created_at
FROM bb_model_call_attempts a
JOIN bb_jobs j ON j.id=a.job_id AND j.owner_user_id=a.owner_user_id
JOIN bb_runs r ON r.id=j.run_id AND r.owner_user_id=j.owner_user_id
JOIN bb_run_execution_versions e ON e.owner_user_id=r.owner_user_id AND e.project_id=r.project_id AND e.run_id=r.id
JOIN bb_input_revisions i ON i.owner_user_id=e.owner_user_id AND i.project_id=e.project_id
  AND i.revision=e.input_revision AND i.input_hash=e.input_hash
JOIN bb_snapshot_refs s ON s.id=a.prompt_snapshot_id AND s.owner_user_id=e.owner_user_id
  AND s.project_id=e.project_id AND s.run_id=e.run_id AND s.snapshot_kind='model_request'
  AND s.input_revision=e.input_revision AND s.input_hash=e.input_hash;

CREATE FUNCTION bb_bind_model_call_execution() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.prompt_snapshot_id IS NULL THEN RETURN NEW; END IF;
  INSERT INTO bb_model_call_execution_bindings(attempt_id,owner_user_id,project_id,run_id,job_id,
    execution_version,input_revision,input_hash,prompt_snapshot_ref,created_at)
  SELECT NEW.id,NEW.owner_user_id,r.project_id,r.id,j.id,e.execution_version,e.input_revision,e.input_hash,s.id,NEW.created_at
  FROM bb_jobs j
  JOIN bb_runs r ON r.id=j.run_id AND r.owner_user_id=j.owner_user_id
  JOIN bb_run_execution_versions e ON e.owner_user_id=r.owner_user_id AND e.project_id=r.project_id AND e.run_id=r.id
  JOIN bb_snapshot_refs s ON s.id=NEW.prompt_snapshot_id AND s.owner_user_id=e.owner_user_id
    AND s.project_id=e.project_id AND s.run_id=e.run_id AND s.snapshot_kind='model_request'
    AND s.input_revision=e.input_revision AND s.input_hash=e.input_hash
  WHERE j.id=NEW.job_id AND j.owner_user_id=NEW.owner_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'model call must match its exact execution input and prompt'
      USING ERRCODE='23514', CONSTRAINT='bb_model_call_execution_exact';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER bb_model_call_execution_insert AFTER INSERT ON bb_model_call_attempts
  FOR EACH ROW EXECUTE FUNCTION bb_bind_model_call_execution();

-- Attempt status/usage may advance; the identity of its saved work cannot move.
CREATE FUNCTION bb_guard_bound_model_call_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id,NEW.owner_user_id,NEW.job_id,NEW.logical_call_id,NEW.attempt_no,NEW.model_id,NEW.prompt_snapshot_id)
    IS DISTINCT FROM ROW(OLD.id,OLD.owner_user_id,OLD.job_id,OLD.logical_call_id,OLD.attempt_no,OLD.model_id,OLD.prompt_snapshot_id)
    AND EXISTS(SELECT 1 FROM bb_model_call_execution_bindings WHERE attempt_id=OLD.id) THEN
    RAISE EXCEPTION 'bound model call identity is immutable'
      USING ERRCODE='23514', CONSTRAINT='bb_model_call_execution_identity_immutable';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER bb_model_call_execution_identity_immutable BEFORE UPDATE ON bb_model_call_attempts
  FOR EACH ROW EXECUTE FUNCTION bb_guard_bound_model_call_identity();
