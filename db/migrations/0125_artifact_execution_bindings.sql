-- Preserve the exact execution origin of every artifact, including pending and
-- rejected candidates. This is V1 provenance, not successor execution authority.
-- Production promoters lock run -> job before touching artifacts. Drain those
-- row lockers first, then artifacts, before acquiring the execution FK lock.
-- Do not take input/topic locks: creators may already hold them while waiting
-- to insert or lock their run.
LOCK TABLE bb_runs IN EXCLUSIVE MODE;
LOCK TABLE bb_jobs, bb_artifact_versions IN EXCLUSIVE MODE;
LOCK TABLE bb_run_execution_versions IN EXCLUSIVE MODE;

ALTER TABLE bb_artifact_versions ADD CONSTRAINT bb_artifact_owned_run_version_key
  UNIQUE(owner_user_id,run_id,id,version);

CREATE TABLE bb_artifact_execution_bindings (
  artifact_id text NOT NULL,
  artifact_version integer NOT NULL CHECK(artifact_version > 0),
  owner_user_id text NOT NULL,
  project_id text NOT NULL,
  run_id text NOT NULL,
  execution_version integer NOT NULL CHECK(execution_version > 0),
  input_revision integer NOT NULL CHECK(input_revision > 0),
  input_hash char(64) NOT NULL CHECK(input_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL,
  PRIMARY KEY(artifact_id,artifact_version),
  FOREIGN KEY(owner_user_id,run_id,artifact_id,artifact_version)
    REFERENCES bb_artifact_versions(owner_user_id,run_id,id,version),
  FOREIGN KEY(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash)
    REFERENCES bb_run_execution_versions(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash)
);
CREATE INDEX bb_artifact_execution_scope_idx
  ON bb_artifact_execution_bindings(owner_user_id,project_id,run_id,execution_version);

CREATE FUNCTION bb_check_artifact_execution_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM bb_artifact_versions a
    JOIN bb_runs r ON r.owner_user_id=a.owner_user_id AND r.id=a.run_id
    JOIN bb_run_execution_versions e ON e.owner_user_id=r.owner_user_id AND e.project_id=r.project_id
      AND e.run_id=r.id AND e.execution_version=1 AND e.input_revision=r.input_revision AND e.input_hash=r.input_hash
    JOIN bb_input_revisions i ON i.owner_user_id=e.owner_user_id AND i.project_id=e.project_id
      AND i.revision=e.input_revision AND i.input_hash=e.input_hash
    WHERE a.id=NEW.artifact_id AND a.version=NEW.artifact_version AND a.owner_user_id=NEW.owner_user_id
      AND a.run_id=NEW.run_id AND a.created_at=NEW.created_at AND r.project_id=NEW.project_id
      AND e.execution_version=NEW.execution_version AND e.input_revision=NEW.input_revision AND e.input_hash=NEW.input_hash
  ) THEN
    RAISE EXCEPTION 'artifact must preserve its exact owned initial execution and creation time'
      USING ERRCODE='23514', CONSTRAINT='bb_artifact_execution_exact';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER bb_artifact_execution_exact BEFORE INSERT ON bb_artifact_execution_bindings
  FOR EACH ROW EXECUTE FUNCTION bb_check_artifact_execution_binding();
CREATE TRIGGER bb_artifact_execution_immutable BEFORE UPDATE OR DELETE ON bb_artifact_execution_bindings
  FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();

-- LEFT JOIN deliberately retains every artifact. Missing or mismatched origin
-- evidence fails this migration instead of silently omitting a historical file.
INSERT INTO bb_artifact_execution_bindings(artifact_id,artifact_version,owner_user_id,project_id,run_id,
  execution_version,input_revision,input_hash,created_at)
SELECT a.id,a.version,a.owner_user_id,r.project_id,a.run_id,e.execution_version,e.input_revision,e.input_hash,a.created_at
FROM bb_artifact_versions a LEFT JOIN bb_runs r ON r.owner_user_id=a.owner_user_id AND r.id=a.run_id
LEFT JOIN bb_run_execution_versions e ON e.owner_user_id=r.owner_user_id AND e.project_id=r.project_id
  AND e.run_id=r.id AND e.execution_version=1;

CREATE FUNCTION bb_bind_artifact_execution() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE execution bb_run_execution_versions%ROWTYPE;
BEGIN
  SELECT e.* INTO STRICT execution FROM bb_run_execution_versions e
  JOIN bb_runs r ON r.owner_user_id=e.owner_user_id AND r.project_id=e.project_id AND r.id=e.run_id
    AND r.input_revision=e.input_revision AND r.input_hash=e.input_hash
  WHERE e.owner_user_id=NEW.owner_user_id AND e.run_id=NEW.run_id AND e.execution_version=1;
  INSERT INTO bb_artifact_execution_bindings(artifact_id,artifact_version,owner_user_id,project_id,run_id,
    execution_version,input_revision,input_hash,created_at)
  VALUES(NEW.id,NEW.version,NEW.owner_user_id,execution.project_id,NEW.run_id,
    execution.execution_version,execution.input_revision,execution.input_hash,NEW.created_at);
  RETURN NEW;
EXCEPTION WHEN NO_DATA_FOUND THEN
  RAISE EXCEPTION 'artifact requires its exact owned initial execution'
    USING ERRCODE='23514', CONSTRAINT='bb_artifact_execution_exact';
END; $$;
CREATE TRIGGER bb_artifact_execution_insert AFTER INSERT ON bb_artifact_versions
  FOR EACH ROW EXECUTE FUNCTION bb_bind_artifact_execution();

-- Delivery state and evidence may advance or be revoked. File identity and
-- bytes cannot move to another source after their first durable registration.
CREATE FUNCTION bb_guard_artifact_execution_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id,NEW.version,NEW.owner_user_id,NEW.run_id,NEW.media_type,NEW.sha256,NEW.object_key,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.version,OLD.owner_user_id,OLD.run_id,OLD.media_type,OLD.sha256,OLD.object_key,OLD.created_at) THEN
    RAISE EXCEPTION 'artifact identity and execution origin are immutable'
      USING ERRCODE='23514', CONSTRAINT='bb_artifact_execution_identity_immutable';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER bb_artifact_execution_identity_immutable BEFORE UPDATE ON bb_artifact_versions
  FOR EACH ROW EXECUTE FUNCTION bb_guard_artifact_execution_identity();

-- Read-only provenance boundary. Callers retain their own status/channel/owner
-- authorization checks; this view never grants download or V2 execution.
CREATE VIEW bb_execution_artifact_versions AS
SELECT a.* FROM bb_artifact_versions a
JOIN bb_artifact_execution_bindings b ON b.owner_user_id=a.owner_user_id AND b.run_id=a.run_id
  AND b.artifact_id=a.id AND b.artifact_version=a.version AND b.created_at=a.created_at
JOIN bb_run_execution_versions e ON e.owner_user_id=b.owner_user_id AND e.project_id=b.project_id
  AND e.run_id=b.run_id AND e.execution_version=b.execution_version
  AND e.input_revision=b.input_revision AND e.input_hash=b.input_hash
JOIN bb_runs r ON r.owner_user_id=b.owner_user_id AND r.project_id=b.project_id AND r.id=b.run_id
  AND r.input_revision=b.input_revision AND r.input_hash=b.input_hash
JOIN bb_input_revisions i ON i.owner_user_id=b.owner_user_id AND i.project_id=b.project_id
  AND i.revision=b.input_revision AND i.input_hash=b.input_hash
WHERE e.execution_version=1;
