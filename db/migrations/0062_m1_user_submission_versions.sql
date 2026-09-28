-- User-submitted text is stored only in the private prompt Blob. These rows are immutable references.
CREATE TABLE bb_user_submission_versions (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL,
  project_id text NOT NULL,
  run_id text,
  snapshot_id text NOT NULL UNIQUE REFERENCES bb_snapshot_refs(id),
  submission_kind text NOT NULL CHECK (submission_kind IN ('run_execute','project_message')),
  message_id text,
  submission_request_id text,
  message_version integer CHECK (message_version > 0),
  version integer NOT NULL CHECK (version > 0),
  previous_submission_id text REFERENCES bb_user_submission_versions(id),
  content_sha256 char(64) NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  input_revision integer,
  input_hash char(64),
  material_versions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(material_versions) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id,project_id,version),
  UNIQUE (owner_user_id,project_id,submission_request_id),
  UNIQUE (owner_user_id,project_id,message_id,message_version),
  FOREIGN KEY (owner_user_id,project_id) REFERENCES bb_projects(owner_user_id,id),
  FOREIGN KEY (owner_user_id,project_id,run_id) REFERENCES bb_runs(owner_user_id,project_id,id),
  FOREIGN KEY (owner_user_id,project_id,input_revision) REFERENCES bb_input_revisions(owner_user_id,project_id,revision),
  CHECK (input_revision IS NULL OR input_hash IS NOT NULL),
  CHECK (submission_kind <> 'run_execute' OR (run_id IS NOT NULL AND input_revision IS NOT NULL)),
  CHECK (submission_kind <> 'project_message' OR (message_id IS NOT NULL AND submission_request_id IS NOT NULL AND message_version IS NOT NULL)),
  CHECK (submission_kind <> 'run_execute' OR (message_id IS NULL AND submission_request_id IS NULL AND message_version IS NULL))
);
CREATE INDEX bb_user_submission_run_idx ON bb_user_submission_versions(owner_user_id,run_id,version);
CREATE TRIGGER bb_user_submission_immutable BEFORE UPDATE OR DELETE ON bb_user_submission_versions
  FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();

-- The attempt records the run submission locked before the supplier call. Later messages
-- are not claimed to have been sent to the model by this association.
ALTER TABLE bb_model_call_attempts ADD COLUMN user_submission_id text REFERENCES bb_user_submission_versions(id);
CREATE FUNCTION bb_bind_model_user_submission() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  SELECT s.id INTO NEW.user_submission_id FROM bb_user_submission_versions s
    JOIN bb_jobs j ON j.owner_user_id=s.owner_user_id AND j.run_id=s.run_id
    WHERE j.id=NEW.job_id AND j.owner_user_id=NEW.owner_user_id AND s.submission_kind='run_execute'
    ORDER BY s.version DESC LIMIT 1;
  RETURN NEW;
END $$;
CREATE TRIGGER bb_model_user_submission BEFORE INSERT ON bb_model_call_attempts
  FOR EACH ROW EXECUTE FUNCTION bb_bind_model_user_submission();
CREATE TRIGGER bb_model_user_submission_immutable BEFORE UPDATE OF user_submission_id ON bb_model_call_attempts
  FOR EACH ROW WHEN (OLD.user_submission_id IS DISTINCT FROM NEW.user_submission_id)
  EXECUTE FUNCTION bb_reject_snapshot_change();
