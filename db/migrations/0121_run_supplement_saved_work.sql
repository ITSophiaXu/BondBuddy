-- Freeze private saved-work references at an existing safe supplement boundary.
-- This does not adopt inputs, enable V2, retain draft-only uploads or grant downloads.
CREATE TABLE bb_run_supplement_saved_work (
  owner_user_id text NOT NULL,
  project_id text NOT NULL,
  run_id text NOT NULL,
  supplement_revision integer NOT NULL,
  job_id text NOT NULL,
  execution_version integer NOT NULL,
  input_revision integer NOT NULL,
  input_hash char(64) NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  source_checkpoint jsonb NOT NULL CHECK (jsonb_typeof(source_checkpoint)='object'),
  checkpoint_hash char(64) NOT NULL CHECK (checkpoint_hash ~ '^[a-f0-9]{64}$'),
  captured_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id,supplement_revision),
  UNIQUE (owner_user_id,project_id,run_id,supplement_revision),
  FOREIGN KEY (run_id,supplement_revision) REFERENCES bb_run_supplement_drafts(run_id,revision),
  FOREIGN KEY (owner_user_id,project_id,run_id) REFERENCES bb_runs(owner_user_id,project_id,id),
  FOREIGN KEY (owner_user_id,job_id,run_id) REFERENCES bb_jobs(owner_user_id,id,run_id),
  FOREIGN KEY (run_id,execution_version) REFERENCES bb_run_execution_versions(run_id,execution_version)
);
CREATE FUNCTION bb_check_supplement_saved_work() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM bb_run_supplement_drafts d
    JOIN bb_run_execution_versions e ON e.run_id=d.run_id AND e.execution_version=NEW.execution_version
    JOIN bb_runs r ON r.id=d.run_id AND r.owner_user_id=d.owner_user_id AND r.project_id=d.project_id
    JOIN bb_jobs j ON j.id=NEW.job_id AND j.owner_user_id=r.owner_user_id AND j.run_id=r.id
    WHERE d.run_id=NEW.run_id AND d.revision=NEW.supplement_revision
      AND d.owner_user_id=NEW.owner_user_id AND d.project_id=NEW.project_id
      AND e.owner_user_id=NEW.owner_user_id AND e.project_id=NEW.project_id
      AND e.input_revision=NEW.input_revision AND e.input_hash=NEW.input_hash
      AND d.base_input_revision=NEW.input_revision AND d.base_input_hash=NEW.input_hash
      AND r.state='paused' AND j.state='paused' AND j.user_pause_requested
      AND j.lease_token IS NULL AND j.lease_until IS NULL AND j.checkpoint=NEW.source_checkpoint
  ) THEN
    RAISE EXCEPTION 'saved work must match the exact safe supplement boundary'
      USING ERRCODE='23514', CONSTRAINT='bb_supplement_saved_work_boundary';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER bb_supplement_saved_work_boundary BEFORE INSERT ON bb_run_supplement_saved_work
  FOR EACH ROW EXECUTE FUNCTION bb_check_supplement_saved_work();
CREATE TRIGGER bb_supplement_saved_work_immutable BEFORE UPDATE OR DELETE ON bb_run_supplement_saved_work
  FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();

CREATE TABLE bb_run_supplement_saved_results (
  owner_user_id text NOT NULL,
  project_id text NOT NULL,
  run_id text NOT NULL,
  supplement_revision integer NOT NULL,
  attempt_id text NOT NULL REFERENCES bb_model_call_execution_bindings(attempt_id),
  result_id text NOT NULL,
  PRIMARY KEY (run_id,supplement_revision,attempt_id),
  FOREIGN KEY (owner_user_id,project_id,run_id,supplement_revision)
    REFERENCES bb_run_supplement_saved_work(owner_user_id,project_id,run_id,supplement_revision),
  FOREIGN KEY (owner_user_id,project_id,run_id,result_id)
    REFERENCES bb_provider_result_refs(owner_user_id,project_id,run_id,id)
);
CREATE FUNCTION bb_check_supplement_saved_result() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM bb_run_supplement_saved_work w
    JOIN bb_model_call_execution_bindings b ON b.attempt_id=NEW.attempt_id
    JOIN bb_provider_result_refs p ON p.id=NEW.result_id AND p.attempt_id=b.attempt_id
    WHERE w.run_id=NEW.run_id AND w.supplement_revision=NEW.supplement_revision
      AND w.owner_user_id=NEW.owner_user_id AND w.project_id=NEW.project_id
      AND b.owner_user_id=w.owner_user_id AND b.project_id=w.project_id
      AND b.run_id=w.run_id AND b.job_id=w.job_id AND b.execution_version=w.execution_version
      AND b.input_revision=w.input_revision AND b.input_hash=w.input_hash
      AND p.owner_user_id=w.owner_user_id AND p.project_id=w.project_id AND p.run_id=w.run_id AND p.job_id=w.job_id
      AND p.prompt_snapshot_ref=b.prompt_snapshot_ref
  ) THEN
    RAISE EXCEPTION 'saved result must belong to the captured execution input'
      USING ERRCODE='23514', CONSTRAINT='bb_supplement_saved_result_origin';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER bb_supplement_saved_result_origin BEFORE INSERT ON bb_run_supplement_saved_results
  FOR EACH ROW EXECUTE FUNCTION bb_check_supplement_saved_result();
CREATE TRIGGER bb_supplement_saved_result_immutable BEFORE UPDATE OR DELETE ON bb_run_supplement_saved_results
  FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();

COMMENT ON TABLE bb_run_supplement_saved_work IS
  'Private immutable provenance, not adoption or execution authority. Existing project/account deletion and content retention still apply.';
