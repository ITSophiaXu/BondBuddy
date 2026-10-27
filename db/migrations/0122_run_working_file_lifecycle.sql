-- Exact private working-file inventory. A committed object/source registration
-- precedes Blob IO; none of these rows grants downloads, adoption or execution.
-- Historical bytes are discovered by the bounded reader, never invented here.
CREATE TABLE bb_run_working_objects (
  object_key text PRIMARY KEY,
  owner_user_id text NOT NULL,
  project_id text NOT NULL,
  run_id text NOT NULL,
  filename text NOT NULL CHECK (length(filename) BETWEEN 1 AND 160
    AND position('/' IN filename)=0 AND position(chr(92) IN filename)=0
    AND filename NOT IN ('.','..')),
  sha256 char(64) NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  byte_size bigint NOT NULL,
  media_type text NOT NULL CHECK (length(media_type) BETWEEN 1 AND 255),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id,project_id,run_id,object_key),
  FOREIGN KEY (owner_user_id,project_id,run_id)
    REFERENCES bb_runs(owner_user_id,project_id,id),
  -- Literal equality, not LIKE: underscores in an owner/project/run ID are not
  -- wildcards. The writer additionally validates the complete collector path.
  CHECK (left(object_key,length('owners/' || owner_user_id || '/projects/' || project_id || '/runs/' || run_id || '/'))
    = 'owners/' || owner_user_id || '/projects/' || project_id || '/runs/' || run_id || '/'),
  CHECK (right(object_key,length('/' || trim(sha256) || '/' || filename))
    = '/' || trim(sha256) || '/' || filename
    OR (filename='capture.png' AND media_type='image/png'
      AND object_key='owners/' || owner_user_id || '/projects/' || project_id || '/runs/' || run_id
        || '/integrity/browser/' || trim(sha256) || '.png')
    OR (filename='capture.txt' AND media_type='text/plain; charset=utf-8'
      AND object_key='owners/' || owner_user_id || '/projects/' || project_id || '/runs/' || run_id
        || '/integrity/browser/' || trim(sha256) || '.txt')),
  CHECK (byte_size > 0 OR (byte_size=0 AND filename='capture.txt' AND media_type='text/plain; charset=utf-8'
    AND object_key='owners/' || owner_user_id || '/projects/' || project_id || '/runs/' || run_id
      || '/integrity/browser/' || trim(sha256) || '.txt'))
);
CREATE INDEX bb_run_working_objects_scope_idx
  ON bb_run_working_objects(owner_user_id,project_id,run_id,created_at,object_key);

-- Physical-object receipts deliberately have no run/project/attempt FK. A late
-- Blob result or purge retry must not acquire those scope locks after the
-- run_work_files / run_file_object content locks.
CREATE TABLE bb_run_working_object_state (
  object_key text PRIMARY KEY REFERENCES bb_run_working_objects(object_key),
  stored_at timestamptz,
  purge_started_at timestamptz,
  purged_at timestamptz,
  purge_reason text,
  policy_version text,
  CHECK ((purge_started_at IS NULL AND purged_at IS NULL
      AND purge_reason IS NULL AND policy_version IS NULL)
    OR (purge_started_at IS NOT NULL
      AND purge_reason IS NOT NULL AND policy_version IS NOT NULL
      AND length(btrim(purge_reason)) BETWEEN 1 AND 128
      AND length(btrim(policy_version)) BETWEEN 1 AND 128
      AND (purged_at IS NULL OR purged_at >= purge_started_at)))
);
CREATE INDEX bb_run_working_object_purge_pending_idx
  ON bb_run_working_object_state(purge_started_at,object_key)
  WHERE purge_started_at IS NOT NULL AND purged_at IS NULL;

CREATE TABLE bb_run_working_sources (
  object_key text NOT NULL,
  owner_user_id text NOT NULL,
  project_id text NOT NULL,
  run_id text NOT NULL,
  job_id text NOT NULL,
  execution_version integer NOT NULL CHECK (execution_version=1),
  input_revision integer NOT NULL CHECK (input_revision > 0),
  input_hash char(64) NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  source_kind text NOT NULL CHECK (source_kind IN ('provider','local_correction',
    'local_project_file','local_qa','local_integrity','local_integrity_browser')),
  attempt_id text,
  result_schema_version text NOT NULL CHECK (result_schema_version ~ '^[A-Za-z0-9._-]{1,128}$'),
  -- This is an actual discovered immutable result, not a synthetic producer or
  -- a claim that legacy files had a committed pre-write intent.
  discovered_result_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (owner_user_id,project_id,run_id,object_key)
    REFERENCES bb_run_working_objects(owner_user_id,project_id,run_id,object_key),
  FOREIGN KEY (owner_user_id,job_id,run_id)
    REFERENCES bb_jobs(owner_user_id,id,run_id),
  FOREIGN KEY (owner_user_id,project_id,run_id,execution_version,input_revision,input_hash)
    REFERENCES bb_run_execution_versions(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash),
  FOREIGN KEY (attempt_id) REFERENCES bb_model_call_execution_bindings(attempt_id),
  FOREIGN KEY (owner_user_id,project_id,run_id,discovered_result_id)
    REFERENCES bb_provider_result_refs(owner_user_id,project_id,run_id,id),
  CHECK ((source_kind='provider' AND attempt_id IS NOT NULL AND length(attempt_id)>0)
    OR (source_kind<>'provider' AND attempt_id IS NULL AND discovered_result_id IS NULL))
);
-- Several producer attempts or local conversions may legitimately name the
-- same physical object. A collector may also write several hashes for one
-- filename before its final envelope selects one; retain every exact key.
CREATE UNIQUE INDEX bb_run_working_source_identity
  ON bb_run_working_sources(object_key,job_id,execution_version,source_kind,
    (coalesce(attempt_id,'')),result_schema_version);
CREATE INDEX bb_run_working_sources_run_idx
  ON bb_run_working_sources(owner_user_id,project_id,run_id,job_id);
CREATE INDEX bb_run_working_sources_attempt_idx
  ON bb_run_working_sources(attempt_id) WHERE attempt_id IS NOT NULL;
CREATE INDEX bb_run_working_sources_result_idx
  ON bb_run_working_sources(discovered_result_id) WHERE discovered_result_id IS NOT NULL;

CREATE FUNCTION bb_guard_run_working_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'working-file object and source identities are durable'
      USING ERRCODE='23514', CONSTRAINT='bb_run_working_identity_immutable';
  END IF;
  IF to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
    RAISE EXCEPTION 'working-file object and source identities are immutable'
      USING ERRCODE='23514', CONSTRAINT='bb_run_working_identity_immutable';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER bb_run_working_object_immutable BEFORE UPDATE OR DELETE ON bb_run_working_objects
  FOR EACH ROW EXECUTE FUNCTION bb_guard_run_working_identity();
CREATE TRIGGER bb_run_working_source_immutable BEFORE UPDATE OR DELETE ON bb_run_working_sources
  FOR EACH ROW EXECUTE FUNCTION bb_guard_run_working_identity();

CREATE FUNCTION bb_check_run_working_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE receipt bb_run_working_object_state%ROWTYPE;
BEGIN
  -- The writer locks scope before content, then creates object -> state ->
  -- source. Locking the existing receipt also serializes direct SQL claims
  -- with a concurrent purge marker; a missing receipt is not authority.
  SELECT * INTO receipt FROM bb_run_working_object_state
    WHERE object_key=NEW.object_key FOR SHARE;
  IF NOT FOUND OR receipt.purge_started_at IS NOT NULL THEN
    RAISE EXCEPTION 'working-file source cannot claim an unregistered or purging object'
      USING ERRCODE='23514', CONSTRAINT='bb_run_working_source_live_object';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM bb_run_working_objects o
    JOIN bb_jobs j ON j.id=NEW.job_id AND j.owner_user_id=o.owner_user_id AND j.run_id=o.run_id
    JOIN bb_run_execution_versions e ON e.owner_user_id=o.owner_user_id AND e.project_id=o.project_id
      AND e.run_id=o.run_id AND e.execution_version=NEW.execution_version
    WHERE o.object_key=NEW.object_key AND o.owner_user_id=NEW.owner_user_id
      AND o.project_id=NEW.project_id AND o.run_id=NEW.run_id
      AND e.execution_version=1 AND e.input_revision=NEW.input_revision AND e.input_hash=NEW.input_hash
  ) THEN
    RAISE EXCEPTION 'working-file source must match its exact execution input and job'
      USING ERRCODE='23514', CONSTRAINT='bb_run_working_source_execution';
  END IF;
  IF NEW.source_kind='provider' AND NOT EXISTS (
    SELECT 1 FROM bb_model_call_execution_bindings b
    JOIN bb_model_call_attempts a ON a.id=b.attempt_id AND a.owner_user_id=b.owner_user_id
      AND a.job_id=b.job_id AND a.prompt_snapshot_id=b.prompt_snapshot_ref
    WHERE b.attempt_id=NEW.attempt_id AND b.owner_user_id=NEW.owner_user_id
      AND b.project_id=NEW.project_id AND b.run_id=NEW.run_id AND b.job_id=NEW.job_id
      AND b.execution_version=NEW.execution_version AND b.input_revision=NEW.input_revision
      AND b.input_hash=NEW.input_hash
  ) THEN
    RAISE EXCEPTION 'working-file provider source must match its exact bound attempt'
      USING ERRCODE='23514', CONSTRAINT='bb_run_working_source_attempt';
  END IF;
  IF NEW.discovered_result_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM bb_provider_result_refs p
    JOIN bb_model_call_execution_bindings b ON b.attempt_id=p.attempt_id
      AND b.prompt_snapshot_ref=p.prompt_snapshot_ref
    WHERE p.id=NEW.discovered_result_id AND p.owner_user_id=NEW.owner_user_id
      AND p.project_id=NEW.project_id AND p.run_id=NEW.run_id AND p.job_id=NEW.job_id
      AND p.attempt_id=NEW.attempt_id AND p.result_schema_version=NEW.result_schema_version
      AND b.execution_version=NEW.execution_version AND b.input_revision=NEW.input_revision
      AND b.input_hash=NEW.input_hash
  ) THEN
    RAISE EXCEPTION 'discovered working-file source must name its actual exact provider result'
      USING ERRCODE='23514', CONSTRAINT='bb_run_working_source_discovered_result';
  END IF;
  -- Terminal/deleted scopes remain registrable for exact legacy cleanup. The
  -- write helper enforces visibility and rejects late writes before Blob IO.
  RETURN NEW;
END; $$;
CREATE TRIGGER bb_run_working_source_exact BEFORE INSERT ON bb_run_working_sources
  FOR EACH ROW EXECUTE FUNCTION bb_check_run_working_source();

CREATE FUNCTION bb_guard_run_working_object_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'working-file lifecycle receipts are durable'
      USING ERRCODE='23514', CONSTRAINT='bb_run_working_state_durable';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.stored_at IS NOT NULL AND NEW.purge_started_at IS NOT NULL THEN
      RAISE EXCEPTION 'working-file storage cannot be recorded after purge starts'
        USING ERRCODE='23514', CONSTRAINT='bb_run_working_state_storage';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.object_key IS DISTINCT FROM OLD.object_key
    OR OLD.stored_at IS NOT NULL AND NEW.stored_at IS DISTINCT FROM OLD.stored_at
    OR OLD.purge_started_at IS NOT NULL AND ROW(NEW.purge_started_at,NEW.purge_reason,NEW.policy_version)
      IS DISTINCT FROM ROW(OLD.purge_started_at,OLD.purge_reason,OLD.policy_version)
    OR OLD.purged_at IS NOT NULL AND NEW.purged_at IS DISTINCT FROM OLD.purged_at THEN
    RAISE EXCEPTION 'working-file lifecycle identity and recorded boundaries are immutable'
      USING ERRCODE='23514', CONSTRAINT='bb_run_working_state_immutable';
  END IF;
  IF NEW.stored_at IS DISTINCT FROM OLD.stored_at
    AND (OLD.purge_started_at IS NOT NULL OR NEW.purge_started_at IS NOT NULL) THEN
    RAISE EXCEPTION 'working-file storage cannot be recorded after purge starts'
      USING ERRCODE='23514', CONSTRAINT='bb_run_working_state_storage';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER bb_run_working_state_monotonic BEFORE INSERT OR UPDATE OR DELETE ON bb_run_working_object_state
  FOR EACH ROW EXECUTE FUNCTION bb_guard_run_working_object_state();

COMMENT ON TABLE bb_run_working_objects IS
  'Exact physical private working-file addresses. Registration precedes new Blob writes; discovery is not fabricated historical write intent.';
COMMENT ON TABLE bb_run_working_sources IS
  'Immutable execution/input and actual producer claims, including every superseded key. These claims grant no adoption, execution, artifact or download.';
COMMENT ON TABLE bb_run_working_object_state IS
  'Monotonic physical-object receipts. A committed purge_started_at permanently prohibits new storage/claims; retries delete the exact key and retain audit metadata.';

-- The scanner classifies owners/ working files separately; an unregistered
-- legacy key remains an observation, never fabricated execution authority.
ALTER TABLE bb_storage_inventory_cursors DROP CONSTRAINT bb_storage_inventory_cursors_prefix_check;
ALTER TABLE bb_storage_inventory_cursors ADD CONSTRAINT bb_storage_inventory_cursors_prefix_check
  CHECK (prefix IN ('users/','parse-cache/','log-archive/','owners/'));
