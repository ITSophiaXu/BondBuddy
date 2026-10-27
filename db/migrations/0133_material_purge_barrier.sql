-- Coordinate every material-pin producer with the irreversible start of an
-- original-byte purge. Claims still commit before Blob I/O; neither an advisory
-- lock nor a database transaction is held across a Blob request. This preserves
-- V1 execution and existing retention windows; drafts/plans do not retain bytes.
-- All existing-table locks are nonblocking: rolling writers have several valid
-- scope lock orders, so a busy migration must fail and be retried after drain.
LOCK TABLE bb_input_revisions IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE bb_runs IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE bb_run_execution_versions IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE bb_m4_executions IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE bb_m4_execution_snapshots IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE bb_jobs IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE bb_material_versions IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE bb_storage_tombstones IN SHARE ROW EXCLUSIVE MODE NOWAIT;

-- The old worker has no start barrier between its final pin read and Blob
-- deletion. An in-flight old claim cannot safely cross installation of this
-- protocol, even when it currently owns no database lock.
DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM bb_storage_tombstones WHERE state='claimed') THEN
    RAISE EXCEPTION 'material purge barrier requires all old storage claims to be drained'
      USING ERRCODE='55000',
        HINT='Stop old storage workers and drain every claimed tombstone before retrying this migration.';
  END IF;
END $$;

CREATE FUNCTION bb_material_lifecycle_lock_key(p_owner text,p_project text,p_material text,p_version integer)
RETURNS bigint LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT hashtextextended(jsonb_build_array('bb-material-lifecycle-v1',p_owner,p_project,p_material,p_version)::text,0)
$$;

CREATE TABLE bb_storage_purge_starts (
  tombstone_id text PRIMARY KEY REFERENCES bb_storage_tombstones(id),
  claim_token text,
  claim_attempt integer NOT NULL CHECK(claim_attempt>0),
  origin text NOT NULL CHECK(origin IN ('verified_delete','legacy_attempt')),
  created_at timestamptz NOT NULL CHECK(isfinite(created_at)),
  CHECK(origin='legacy_attempt' OR claim_token IS NOT NULL)
);

-- A previous attempt may have deleted bytes before its finalize transaction
-- failed. Record that uncertainty before enabling new pin producers. This does
-- not assert that any particular historical attempt actually reached Blob I/O.
INSERT INTO bb_storage_purge_starts(tombstone_id,claim_token,claim_attempt,origin,created_at)
SELECT id,NULL,attempts,'legacy_attempt',clock_timestamp()
FROM bb_storage_tombstones WHERE object_kind='material' AND attempts>0;

-- Exact execution identity replaces the old implicit run/input join. Only V1
-- is executable. M4 uses its immutable canonical business snapshot and retains
-- explicit source-project/hash semantics, including templates and QA citations.
CREATE OR REPLACE FUNCTION bb_material_bytes_pinned(p_owner text,p_project text,p_material text,p_version integer)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS(
    SELECT 1 FROM bb_projects p
    JOIN bb_runs r ON r.owner_user_id=p.owner_user_id AND r.project_id=p.id
    JOIN bb_run_execution_versions e ON e.owner_user_id=r.owner_user_id AND e.project_id=r.project_id AND e.run_id=r.id
      AND e.execution_version=1 AND e.input_revision=r.input_revision AND e.input_hash=r.input_hash
    JOIN bb_input_revisions i ON i.owner_user_id=e.owner_user_id AND i.project_id=e.project_id
      AND i.revision=e.input_revision AND i.input_hash=e.input_hash
    WHERE p.owner_user_id=p_owner AND p.id=p_project AND p.deleted_at IS NULL
      AND r.state NOT IN ('succeeded','test_completed','failed','cancelled','rejected')
      AND NOT EXISTS(SELECT 1 FROM bb_m4_executions legacy WHERE legacy.owner_user_id=r.owner_user_id AND legacy.run_id=r.id)
      AND NOT EXISTS(SELECT 1 FROM bb_m4_execution_snapshots s WHERE s.owner_user_id=r.owner_user_id AND s.run_id=r.id)
      AND (i.material_versions @> jsonb_build_array(jsonb_build_object('material_id',p_material,'material_version',p_version))
        OR i.manifest->'materials' @> jsonb_build_array(jsonb_build_object('material_id',p_material,'material_version',p_version)))
  ) OR EXISTS(
    SELECT 1 FROM bb_runs r
    JOIN bb_projects p ON p.owner_user_id=r.owner_user_id AND p.id=r.project_id
    JOIN bb_run_execution_versions e ON e.owner_user_id=r.owner_user_id AND e.project_id=r.project_id AND e.run_id=r.id
      AND e.execution_version=1 AND e.input_revision=r.input_revision AND e.input_hash=r.input_hash
    JOIN bb_input_revisions i ON i.owner_user_id=e.owner_user_id AND i.project_id=e.project_id
      AND i.revision=e.input_revision AND i.input_hash=e.input_hash
    JOIN bb_m4_execution_snapshots s ON s.owner_user_id=e.owner_user_id AND s.project_id=e.project_id AND s.run_id=e.run_id
      AND s.execution_version=e.execution_version AND s.input_revision=e.input_revision AND s.input_hash=e.input_hash
      AND s.manifest=i.manifest
    JOIN bb_jobs j ON j.owner_user_id=r.owner_user_id AND j.run_id=r.id
    JOIN bb_material_versions m ON m.owner_user_id=r.owner_user_id
      AND m.project_id=p_project AND m.id=p_material AND m.version=p_version
    WHERE r.owner_user_id=p_owner AND p.deleted_at IS NULL
      AND r.state NOT IN ('succeeded','test_completed','failed','cancelled','rejected')
      AND ((r.task_kind='generation' AND j.subtype='m4_document_v1' AND s.manifest->>'version'='m4-document-input-v1')
        OR (r.task_kind='qa' AND j.subtype='m4_qa_v1' AND s.manifest->>'version'='m4-qa-input-v1'))
      AND i.material_versions @> jsonb_build_array(jsonb_build_object(
        'source_project_id',p_project,'material_id',p_material,'material_version',p_version,'sha256',btrim(m.sha256::text)))
  )
$$;

-- Derive lock candidates directly from well-formed JSON references, including
-- rows that do not exist yet. Missing/fake references only acquire a lock; the
-- final purge check rechecks exact material rows and real tombstones. Local refs include
-- staged M4 runs before their legacy/canonical rows replace the local pin branch.
-- Cross-project M4 candidates require an explicit source and a possible hash.
CREATE FUNCTION bb_material_lifecycle_input_keys(p_owner text,p_project text,p_revision integer)
RETURNS TABLE(source_project_id text,material_id text,material_version integer,lifecycle_key bigint)
LANGUAGE sql STABLE AS $$
  WITH input AS (
    SELECT manifest,material_versions FROM bb_input_revisions
    WHERE owner_user_id=p_owner AND project_id=p_project AND revision=p_revision
  ), local_refs AS (
    SELECT pin FROM input i CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(i.material_versions)='array' THEN i.material_versions ELSE '[]'::jsonb END) refs(pin)
    UNION
    SELECT pin FROM input i CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(i.manifest->'materials')='array' THEN i.manifest->'materials' ELSE '[]'::jsonb END) refs(pin)
  ), candidate_refs AS (
    SELECT p_project AS project_id,pin FROM local_refs
    UNION ALL
    SELECT pin->>'source_project_id',pin FROM input i
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(i.material_versions)='array' THEN i.material_versions ELSE '[]'::jsonb END) refs(pin)
    WHERE i.manifest->>'version' IN ('m4-document-input-v1','m4-qa-input-v1')
      AND jsonb_typeof(pin->'source_project_id')='string'
      AND jsonb_typeof(pin->'sha256')='string' AND pin->>'sha256' ~ '^[0-9A-Fa-f]{64}$'
  ), parsed_refs AS (
    SELECT project_id,pin->>'material_id' AS id,
      CASE WHEN jsonb_typeof(pin->'material_version')='number'
        THEN (pin->>'material_version')::numeric END AS version_number
    FROM candidate_refs WHERE jsonb_typeof(pin->'material_id')='string'
  ), material_refs AS (
    SELECT project_id,id,
      CASE WHEN version_number BETWEEN 1 AND 2147483647 AND version_number=trunc(version_number)
        THEN version_number::integer END AS version
    FROM parsed_refs
  )
  SELECT project_id,id,version,bb_material_lifecycle_lock_key(p_owner,project_id,id,version)
  FROM material_refs WHERE version IS NOT NULL
$$;

-- Lock the entire deduplicated set by the actual signed bigint key. Every
-- producer calls this same function in its pin-creating transaction. Separate
-- statements after the lock waits see the latest committed barrier at READ
-- COMMITTED; do not fold the wait and final check into one STABLE SQL snapshot.
CREATE FUNCTION bb_assert_material_lifecycle_available(p_owner text,p_project text,p_revision integer)
RETURNS void LANGUAGE plpgsql VOLATILE AS $$
DECLARE key_to_lock bigint;
BEGIN
  IF current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'material lifecycle coordination requires READ COMMITTED isolation'
      USING ERRCODE='23514',CONSTRAINT='bb_material_lifecycle_isolation';
  END IF;
  FOR key_to_lock IN SELECT DISTINCT lifecycle_key
    FROM bb_material_lifecycle_input_keys(p_owner,p_project,p_revision) ORDER BY lifecycle_key
  LOOP
    PERFORM pg_advisory_xact_lock(key_to_lock);
  END LOOP;
  -- Lock speculative tuples too, but preserve the exact original candidate check
  -- after every wait so a fake reference does not create a new admission rule.
  IF EXISTS(
    SELECT 1 FROM bb_material_lifecycle_input_keys(p_owner,p_project,p_revision) k
    JOIN bb_material_versions m ON m.owner_user_id=p_owner AND m.project_id=k.source_project_id
      AND m.id=k.material_id AND m.version=k.material_version
    JOIN bb_input_revisions i ON i.owner_user_id=p_owner AND i.project_id=p_project AND i.revision=p_revision
    JOIN bb_storage_tombstones t ON t.object_kind='material' AND t.owner_user_id=p_owner
      AND t.project_id=m.project_id AND t.material_id=m.id AND t.material_version=m.version
    WHERE ((m.project_id=p_project
        AND (i.material_versions @> jsonb_build_array(jsonb_build_object('material_id',m.id,'material_version',m.version))
          OR i.manifest->'materials' @> jsonb_build_array(jsonb_build_object('material_id',m.id,'material_version',m.version))))
      OR (i.manifest->>'version' IN ('m4-document-input-v1','m4-qa-input-v1')
        AND i.material_versions @> jsonb_build_array(jsonb_build_object(
          'source_project_id',m.project_id,'material_id',m.id,'material_version',m.version,'sha256',btrim(m.sha256::text)))))
      AND (t.state='purged' OR EXISTS(SELECT 1 FROM bb_storage_purge_starts s WHERE s.tombstone_id=t.id))
  ) THEN
    RAISE EXCEPTION 'material purge has already started; its original bytes cannot acquire a new execution pin'
      USING ERRCODE='23514',CONSTRAINT='bb_material_purge_barrier';
  END IF;
END $$;

CREATE FUNCTION bb_guard_run_material_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state IN ('succeeded','test_completed','failed','cancelled','rejected') THEN RETURN NEW; END IF;
  IF TG_OP='INSERT' THEN
    PERFORM bb_assert_material_lifecycle_available(NEW.owner_user_id,NEW.project_id,NEW.input_revision);
  ELSIF OLD.state IN ('succeeded','test_completed','failed','cancelled','rejected')
    OR NEW.task_kind IS DISTINCT FROM OLD.task_kind THEN
    PERFORM bb_assert_material_lifecycle_available(NEW.owner_user_id,NEW.project_id,NEW.input_revision);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bb_material_lifecycle_run_guard BEFORE INSERT OR UPDATE OF state,task_kind ON bb_runs
  FOR EACH ROW EXECUTE FUNCTION bb_guard_run_material_lifecycle();

CREATE FUNCTION bb_guard_execution_material_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM bb_runs r WHERE r.owner_user_id=NEW.owner_user_id AND r.project_id=NEW.project_id
    AND r.id=NEW.run_id AND r.input_revision=NEW.input_revision AND r.input_hash=NEW.input_hash
    AND r.state NOT IN ('succeeded','test_completed','failed','cancelled','rejected')) THEN
    PERFORM bb_assert_material_lifecycle_available(NEW.owner_user_id,NEW.project_id,NEW.input_revision);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bb_material_lifecycle_execution_guard BEFORE INSERT ON bb_run_execution_versions
  FOR EACH ROW EXECUTE FUNCTION bb_guard_execution_material_lifecycle();
CREATE TRIGGER bb_material_lifecycle_m4_snapshot_guard BEFORE INSERT ON bb_m4_execution_snapshots
  FOR EACH ROW EXECUTE FUNCTION bb_guard_execution_material_lifecycle();

CREATE FUNCTION bb_guard_m4_legacy_material_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owned_run bb_runs%ROWTYPE;
BEGIN
  SELECT * INTO owned_run FROM bb_runs WHERE owner_user_id=NEW.owner_user_id AND id=NEW.run_id;
  IF FOUND AND owned_run.state NOT IN ('succeeded','test_completed','failed','cancelled','rejected') THEN
    PERFORM bb_assert_material_lifecycle_available(owned_run.owner_user_id,owned_run.project_id,owned_run.input_revision);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bb_material_lifecycle_m4_legacy_guard BEFORE INSERT ON bb_m4_executions
  FOR EACH ROW EXECUTE FUNCTION bb_guard_m4_legacy_material_lifecycle();

CREATE FUNCTION bb_guard_job_material_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owned_run bb_runs%ROWTYPE;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF ROW(NEW.owner_user_id,NEW.run_id,NEW.subtype) IS NOT DISTINCT FROM ROW(OLD.owner_user_id,OLD.run_id,OLD.subtype) THEN
      RETURN NEW;
    END IF;
  END IF;
  SELECT * INTO owned_run FROM bb_runs WHERE owner_user_id=NEW.owner_user_id AND id=NEW.run_id;
  IF FOUND AND owned_run.state NOT IN ('succeeded','test_completed','failed','cancelled','rejected') THEN
    PERFORM bb_assert_material_lifecycle_available(owned_run.owner_user_id,owned_run.project_id,owned_run.input_revision);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bb_material_lifecycle_job_guard BEFORE INSERT OR UPDATE OF owner_user_id,run_id,subtype ON bb_jobs
  FOR EACH ROW EXECUTE FUNCTION bb_guard_job_material_lifecycle();

-- The pin predicate compares material identity and hashes. Freeze those for
-- ordinary materials too, so changing a hash cannot revive a pin after purge.
-- Parsing/deletion state, signature handling and descriptive metadata retain
-- their existing guards and legal update paths.
CREATE FUNCTION bb_guard_material_byte_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.owner_user_id,NEW.project_id,NEW.id,NEW.version,NEW.upload_id,NEW.object_key,NEW.sha256,NEW.byte_size)
    IS DISTINCT FROM
    ROW(OLD.owner_user_id,OLD.project_id,OLD.id,OLD.version,OLD.upload_id,OLD.object_key,OLD.sha256,OLD.byte_size) THEN
    RAISE EXCEPTION 'material version identity and original bytes are immutable'
      USING ERRCODE='23514',CONSTRAINT='bb_material_byte_identity_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bb_material_byte_identity_guard
  BEFORE UPDATE OF owner_user_id,project_id,id,version,upload_id,object_key,sha256,byte_size ON bb_material_versions
  FOR EACH ROW EXECUTE FUNCTION bb_guard_material_byte_identity();

-- New starts are accepted only against a verified live claim. Read immutable
-- scope first, take the producer's lock, then re-read the claim under its row
-- lock. This guard is also required for direct SQL callers of the table.
CREATE FUNCTION bb_check_storage_purge_start() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
DECLARE target bb_storage_tombstones%ROWTYPE;
BEGIN
  IF current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'material lifecycle coordination requires READ COMMITTED isolation'
      USING ERRCODE='23514',CONSTRAINT='bb_material_lifecycle_isolation';
  END IF;
  IF NEW.origin<>'verified_delete' THEN
    RAISE EXCEPTION 'historical purge uncertainty can only be recorded by migration'
      USING ERRCODE='23514',CONSTRAINT='bb_storage_purge_start_exact';
  END IF;
  SELECT * INTO target FROM bb_storage_tombstones WHERE id=NEW.tombstone_id;
  IF NOT FOUND OR target.object_kind<>'material' THEN
    RAISE EXCEPTION 'purge start must identify an existing material tombstone'
      USING ERRCODE='23514',CONSTRAINT='bb_storage_purge_start_exact';
  END IF;
  PERFORM pg_advisory_xact_lock(bb_material_lifecycle_lock_key(target.owner_user_id,target.project_id,target.material_id,target.material_version));
  SELECT * INTO target FROM bb_storage_tombstones WHERE id=NEW.tombstone_id FOR UPDATE;
  IF target.state<>'claimed' OR target.claim_token IS DISTINCT FROM NEW.claim_token
    OR target.attempts<>NEW.claim_attempt OR target.lease_until<=clock_timestamp()
    OR target.eligible_at IS NULL
    OR bb_material_bytes_pinned(target.owner_user_id,target.project_id,target.material_id,target.material_version) THEN
    RAISE EXCEPTION 'purge start must preserve its exact live unpinned claim'
      USING ERRCODE='23514',CONSTRAINT='bb_storage_purge_start_exact';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bb_storage_purge_start_exact BEFORE INSERT ON bb_storage_purge_starts
  FOR EACH ROW EXECUTE FUNCTION bb_check_storage_purge_start();
CREATE FUNCTION bb_reject_storage_purge_start_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'material purge starts are irreversible'
    USING ERRCODE='23514',CONSTRAINT='bb_storage_purge_start_immutable';
END $$;
CREATE TRIGGER bb_storage_purge_start_immutable BEFORE UPDATE OR DELETE ON bb_storage_purge_starts
  FOR EACH ROW EXECUTE FUNCTION bb_reject_storage_purge_start_rewrite();

COMMENT ON TABLE bb_storage_purge_starts IS
  'Irreversible original-byte deletion barrier. verified_delete proves the exact live unpinned claim at start; legacy_attempt records only historical deletion uncertainty. Failures and lease changes never permit new execution pins.';
