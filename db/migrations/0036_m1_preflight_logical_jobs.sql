-- #79: completed free preflights and pre-run rejections are logical jobs without runs.
ALTER TABLE bb_jobs ADD COLUMN operation_id text;
ALTER TABLE bb_jobs ADD COLUMN request_id text;
ALTER TABLE bb_jobs ADD COLUMN input_revision integer;
ALTER TABLE bb_jobs ADD COLUMN input_hash char(64);
ALTER TABLE bb_operations ADD CONSTRAINT bb_operations_owner_project_id UNIQUE(owner_user_id,project_id,id);
ALTER TABLE bb_jobs ADD CONSTRAINT bb_logical_job_operation_fk
  FOREIGN KEY(owner_user_id,project_id,operation_id) REFERENCES bb_operations(owner_user_id,project_id,id);
CREATE UNIQUE INDEX bb_logical_job_request_key ON bb_jobs(owner_user_id,request_id)
  WHERE run_id IS NULL AND subtype IN ('free_preflight','preflight_rejected','execute_rejected');
CREATE INDEX bb_logical_job_trace_idx ON bb_jobs(owner_user_id,trace_id)
  WHERE run_id IS NULL AND subtype IN ('free_preflight','preflight_rejected','execute_rejected');

ALTER TABLE bb_jobs DROP CONSTRAINT bb_jobs_state_check;
ALTER TABLE bb_jobs ADD CONSTRAINT bb_jobs_state_check
  CHECK (state IN ('queued','running','paused','succeeded','failed','cancelled','rejected'));
ALTER TABLE bb_jobs DROP CONSTRAINT bb_job_binding;
ALTER TABLE bb_jobs ADD CONSTRAINT bb_job_binding CHECK (
  (job_type NOT IN ('parse','library') AND run_id IS NOT NULL AND material_id IS NULL AND library_source_id IS NULL)
  OR (job_type = 'parse' AND subtype = 'material_parse' AND run_id IS NULL
      AND project_id IS NOT NULL AND material_id IS NOT NULL AND material_version > 0
      AND material_sha256 ~ '^[a-f0-9]{64}$'
      AND parser_version ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
      AND trace_id IS NOT NULL AND max_attempts BETWEEN 1 AND 10
      AND ((state = 'failed') = (error_code IS NOT NULL))
      AND (error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{0,63}$')
      AND (state <> 'succeeded' OR result IS NOT NULL)
      AND library_source_id IS NULL)
  OR (job_type = 'library' AND subtype IN ('library_sync','library_record') AND run_id IS NULL AND project_id IS NULL
      AND material_id IS NULL AND owner_user_id = 'system-reference-library'
      AND library_source_id IS NOT NULL AND trace_id IS NOT NULL AND max_attempts BETWEEN 1 AND 10
      AND ((subtype = 'library_record') = (library_version_id IS NOT NULL))
      AND ((state = 'failed') = (error_code IS NOT NULL))
      AND (error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'))
  OR (run_id IS NULL AND subtype IN ('free_preflight','preflight_rejected','execute_rejected')
      AND ((subtype='free_preflight' AND job_type='preflight' AND state='succeeded' AND error_code IS NULL)
        OR (subtype='preflight_rejected' AND job_type='preflight' AND state='rejected'
            AND error_code ~ '^[A-Z][A-Z0-9_]{0,63}$')
        OR (subtype='execute_rejected' AND job_type IN ('update','review','generation','qa')
            AND state='rejected' AND error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'))
      AND project_id IS NOT NULL AND trace_id IS NOT NULL AND request_id IS NOT NULL
      AND operation_id IS NOT NULL AND input_revision > 0 AND input_hash ~ '^[a-f0-9]{64}$'
      AND material_id IS NULL AND library_source_id IS NULL AND lease_token IS NULL
      AND attempts=0)
);

-- The terminal logical row cannot drift away from its immutable operation evidence.
CREATE FUNCTION bb_guard_logical_job() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE op bb_operations%ROWTYPE;
BEGIN
  IF TG_OP='UPDATE' AND OLD.subtype IN ('free_preflight','preflight_rejected','execute_rejected') THEN
    RAISE EXCEPTION 'terminal logical job is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.subtype IN ('free_preflight','preflight_rejected','execute_rejected') THEN
    SELECT * INTO op FROM bb_operations WHERE id=NEW.operation_id AND owner_user_id=NEW.owner_user_id AND project_id=NEW.project_id;
    IF NOT FOUND OR op.request_id<>NEW.request_id OR op.trace_id<>NEW.trace_id
       OR op.input_revision IS DISTINCT FROM NEW.input_revision OR op.input_hash IS DISTINCT FROM NEW.input_hash
       OR op.operation_kind<>(CASE WHEN NEW.subtype='execute_rejected' THEN 'execute' ELSE 'preflight' END)
       OR op.status<>(CASE WHEN NEW.state='rejected' THEN 'rejected' ELSE 'submitted' END)
       OR op.error_code IS DISTINCT FROM NEW.error_code THEN
      RAISE EXCEPTION 'logical job operation mismatch' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER bb_logical_job_guard BEFORE INSERT OR UPDATE ON bb_jobs
  FOR EACH ROW EXECUTE FUNCTION bb_guard_logical_job();
