-- Persist the active execution authority independently of the immutable run
-- origin. This first stage accepts only the exact original V1 and deliberately
-- has no head update, successor activation, adoption or billing operation.
LOCK TABLE bb_input_revisions,bb_runs,bb_run_execution_versions IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE bb_run_execution_heads (
  owner_user_id text NOT NULL,project_id text NOT NULL,run_id text PRIMARY KEY,
  execution_version integer NOT NULL CHECK(execution_version=1),
  input_revision integer NOT NULL CHECK(input_revision>0),
  input_hash char(64) NOT NULL CHECK(input_hash ~ '^[a-f0-9]{64}$'),
  activated_at timestamptz NOT NULL CHECK(isfinite(activated_at)),
  UNIQUE(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash),
  FOREIGN KEY(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash)
    REFERENCES bb_run_execution_versions(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE FUNCTION bb_check_initial_execution_head() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(
    SELECT 1 FROM bb_run_execution_versions e
    JOIN bb_runs r ON r.owner_user_id=e.owner_user_id AND r.project_id=e.project_id AND r.id=e.run_id
    WHERE e.owner_user_id=NEW.owner_user_id AND e.project_id=NEW.project_id AND e.run_id=NEW.run_id
      AND e.execution_version=1 AND e.execution_version=NEW.execution_version
      AND e.input_revision=NEW.input_revision AND e.input_hash=NEW.input_hash
      AND e.input_revision=r.input_revision AND e.input_hash=r.input_hash
      AND e.created_at=NEW.activated_at
      AND (SELECT count(*) FROM bb_run_execution_versions all_versions
        WHERE all_versions.owner_user_id=e.owner_user_id AND all_versions.project_id=e.project_id AND all_versions.run_id=e.run_id)=1
  ) THEN
    RAISE EXCEPTION 'initial active head must preserve the unique original execution'
      USING ERRCODE='23514',CONSTRAINT='bb_initial_execution_head_origin';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER bb_initial_execution_head_origin BEFORE INSERT ON bb_run_execution_heads
  FOR EACH ROW EXECUTE FUNCTION bb_check_initial_execution_head();
CREATE TRIGGER bb_run_execution_head_immutable BEFORE UPDATE OR DELETE ON bb_run_execution_heads
  FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();

-- Do not skip any existing run. Missing/mismatched execution origins fail the
-- migration atomically instead of creating an apparently valid partial head set.
INSERT INTO bb_run_execution_heads(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash,activated_at)
SELECT r.owner_user_id,r.project_id,r.id,e.execution_version,e.input_revision,e.input_hash,e.created_at
FROM bb_runs r LEFT JOIN bb_run_execution_versions e
  ON e.owner_user_id=r.owner_user_id AND e.project_id=r.project_id AND e.run_id=r.id AND e.execution_version=1;

CREATE FUNCTION bb_create_initial_execution_head() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO bb_run_execution_heads(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash,activated_at)
  VALUES(NEW.owner_user_id,NEW.project_id,NEW.run_id,NEW.execution_version,NEW.input_revision,NEW.input_hash,NEW.created_at);
  RETURN NEW;
END; $$;
CREATE TRIGGER bb_run_initial_execution_head AFTER INSERT ON bb_run_execution_versions
  FOR EACH ROW EXECUTE FUNCTION bb_create_initial_execution_head();

COMMENT ON TABLE bb_run_execution_heads IS
  'Exact active execution authority, initialized and frozen at V1. No successor/adoption/pricing permission; activation requires a later complete authorized protocol.';
