-- Bounded internal V2 Word completion after exact 0135 adoption. Production
-- successor execution, additional quotations and all accounting remain closed.
-- Old writers cannot infer V2 from the current head: prompts/artifacts carry an
-- explicit tuple; typed registries and working sources already carry theirs.
-- Drain writers and retry a busy migration; never wait holding a partial set.
LOCK TABLE bb_runs IN EXCLUSIVE MODE NOWAIT;
LOCK TABLE bb_jobs IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE bb_snapshot_refs IN ACCESS EXCLUSIVE MODE NOWAIT;
LOCK TABLE bb_model_call_attempts IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE bb_model_call_execution_bindings IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE bb_artifact_versions IN ACCESS EXCLUSIVE MODE NOWAIT;
LOCK TABLE bb_artifact_execution_bindings IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE bb_run_execution_versions IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE bb_run_execution_heads IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE bb_run_working_sources IN ACCESS EXCLUSIVE MODE NOWAIT;
LOCK TABLE bb_review_execution_editors IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE bb_review_execution_reports IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE bb_review_execution_artifacts IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE bb_m4_execution_artifacts IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE bb_run_execution_deliveries IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE bb_run_execution_delivery_artifacts IN SHARE ROW EXCLUSIVE MODE NOWAIT;

-- Historical origin only. Do not consult a mutable head, fresh grant, current
-- project visibility, job stage or terminal status when reading saved evidence.
CREATE FUNCTION bb_test_successor_execution_origin(p_owner text,p_project text,p_run text,
  p_execution integer,p_revision integer,p_hash text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT p_execution=2 AND EXISTS(
    SELECT 1 FROM bb_run_test_successor_authorizations a
    JOIN bb_run_execution_versions e ON e.owner_user_id=a.owner_user_id AND e.project_id=a.project_id
      AND e.run_id=a.run_id AND e.execution_version=a.execution_version
      AND e.input_revision=a.input_revision AND e.input_hash=a.input_hash AND e.created_at=a.created_at
    JOIN bb_run_execution_versions source ON source.owner_user_id=a.owner_user_id AND source.project_id=a.project_id
      AND source.run_id=a.run_id AND source.execution_version=a.source_execution_version
      AND source.input_revision=a.source_input_revision AND source.input_hash=a.source_input_hash
    JOIN bb_runs r ON r.owner_user_id=a.owner_user_id AND r.project_id=a.project_id AND r.id=a.run_id
      AND r.input_revision=a.source_input_revision AND r.input_hash=a.source_input_hash
    JOIN bb_jobs j ON j.owner_user_id=a.owner_user_id AND j.run_id=a.run_id AND j.id=a.job_id
    WHERE a.owner_user_id=p_owner AND a.project_id=p_project AND a.run_id=p_run
      AND a.execution_version=p_execution AND a.input_revision=p_revision AND a.input_hash=p_hash
      AND r.channel='non_production_test' AND j.channel='non_production_test'
      AND r.billing_mode IN ('platform_trial','non_billable_test') AND r.reservation_id IS NULL)
$$;

-- New writes require current authority. NOWAIT is necessary for direct SQL
-- registrars that already own a descendant slot: never reverse a parent writer's
-- run/job or project/grant lock order by waiting here. Retain the grant lock until
-- commit so revocation cannot slip between this check and the durable write.
CREATE FUNCTION bb_assert_test_successor_execution_active(p_owner text,p_project text,p_run text,
  p_execution integer,p_revision integer,p_hash text) RETURNS void LANGUAGE plpgsql VOLATILE AS $$
DECLARE adoption_row bb_run_test_successor_authorizations%ROWTYPE;grant_row bb_non_production_test_grants%ROWTYPE;
BEGIN
  IF NOT COALESCE(bb_test_successor_execution_origin(p_owner,p_project,p_run,p_execution,p_revision,p_hash),false) THEN
    RAISE EXCEPTION 'successor write requires its exact immutable internal test authorization'
      USING ERRCODE='23514',CONSTRAINT='bb_test_successor_write_authority';END IF;
  PERFORM 1 FROM bb_projects project JOIN bb_users u ON u.id=project.owner_user_id
    WHERE project.owner_user_id=p_owner AND project.id=p_project AND project.deleted_at IS NULL
      AND project.archived_at IS NULL AND u.closed_at IS NULL AND u.status<>'closed'
    FOR SHARE OF project,u NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'successor write project is unavailable'
    USING ERRCODE='23514',CONSTRAINT='bb_test_successor_write_authority';END IF;
  PERFORM 1 FROM bb_runs r JOIN bb_jobs j ON j.owner_user_id=r.owner_user_id AND j.run_id=r.id
    WHERE r.owner_user_id=p_owner AND r.project_id=p_project AND r.id=p_run
    FOR KEY SHARE OF r,j NOWAIT;
  SELECT a.* INTO adoption_row FROM bb_run_test_successor_authorizations a
    JOIN bb_run_execution_heads h ON h.owner_user_id=a.owner_user_id AND h.project_id=a.project_id
      AND h.run_id=a.run_id AND h.execution_version=a.execution_version
      AND h.input_revision=a.input_revision AND h.input_hash=a.input_hash AND h.activated_at=a.created_at
    WHERE a.owner_user_id=p_owner AND a.project_id=p_project AND a.run_id=p_run
      AND a.execution_version=p_execution AND a.input_revision=p_revision AND a.input_hash=p_hash
    FOR SHARE OF h NOWAIT;
  IF adoption_row.id IS NULL THEN RAISE EXCEPTION 'successor write requires its active exact execution head'
    USING ERRCODE='23514',CONSTRAINT='bb_test_successor_write_authority';END IF;
  SELECT * INTO grant_row FROM bb_non_production_test_grants WHERE grant_id=adoption_row.test_grant_id FOR SHARE NOWAIT;
  IF grant_row.grant_id IS NULL OR grant_row.user_id<>p_owner OR grant_row.project_id<>p_project
    OR grant_row.input_revision<>p_revision OR grant_row.input_hash<>p_hash
    OR grant_row.revoked_at IS NOT NULL OR grant_row.expires_at<=clock_timestamp()
    OR EXISTS(SELECT 1 FROM bb_credit_reservations c WHERE c.owner_user_id=p_owner AND c.run_id=p_run)
    OR EXISTS(SELECT 1 FROM bb_m4_metering m WHERE m.owner_user_id=p_owner AND m.run_id=p_run)
    OR EXISTS(SELECT 1 FROM bb_authoring_progress a WHERE a.owner_user_id=p_owner AND a.run_id=p_run AND a.accrued_points<>0) THEN
    RAISE EXCEPTION 'successor write requires its live exact target grant without paid accounting'
      USING ERRCODE='23514',CONSTRAINT='bb_test_successor_write_authority';END IF;
END; $$;

ALTER TABLE bb_snapshot_refs ADD COLUMN execution_version integer CHECK(execution_version IN (1,2));
ALTER TABLE bb_artifact_versions ADD COLUMN execution_version integer;
ALTER TABLE bb_artifact_versions ADD COLUMN input_revision integer;
ALTER TABLE bb_artifact_versions ADD COLUMN input_hash char(64);
ALTER TABLE bb_artifact_versions ADD CONSTRAINT bb_artifact_explicit_execution_tuple CHECK(
  num_nonnulls(execution_version,input_revision,input_hash)=0 OR
  (num_nonnulls(execution_version,input_revision,input_hash)=3 AND execution_version IN (1,2)
    AND input_revision>0 AND input_hash ~ '^[a-f0-9]{64}$'));
ALTER TABLE bb_run_working_sources DROP CONSTRAINT bb_run_working_sources_execution_version_check;
ALTER TABLE bb_run_working_sources ADD CONSTRAINT bb_run_working_sources_execution_version_check CHECK(execution_version IN (1,2));

CREATE FUNCTION bb_check_prompt_explicit_execution() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.snapshot_kind<>'model_request' OR NEW.run_id IS NULL THEN
    IF NEW.execution_version=2 THEN RAISE EXCEPTION 'successor prompt requires its exact run model request'
      USING ERRCODE='23514',CONSTRAINT='bb_model_call_execution_exact';END IF;
    RETURN NEW;
  END IF;
  IF NEW.execution_version=2 THEN
    PERFORM bb_assert_test_successor_execution_active(NEW.owner_user_id,NEW.project_id,NEW.run_id,
      NEW.execution_version,NEW.input_revision,NEW.input_hash);
  ELSIF EXISTS(SELECT 1 FROM bb_run_execution_heads h WHERE h.owner_user_id=NEW.owner_user_id
    AND h.project_id=NEW.project_id AND h.run_id=NEW.run_id AND h.execution_version=2)
    OR (NEW.execution_version=1 AND NOT EXISTS(SELECT 1 FROM bb_run_execution_versions e
      WHERE e.owner_user_id=NEW.owner_user_id AND e.project_id=NEW.project_id AND e.run_id=NEW.run_id
        AND e.execution_version=1 AND e.input_revision=NEW.input_revision AND e.input_hash=NEW.input_hash)) THEN
    RAISE EXCEPTION 'model prompt requires its explicit exact active execution input'
      USING ERRCODE='23514',CONSTRAINT='bb_model_call_execution_exact';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER bb_prompt_explicit_execution BEFORE INSERT ON bb_snapshot_refs
  FOR EACH ROW EXECUTE FUNCTION bb_check_prompt_explicit_execution();

CREATE OR REPLACE FUNCTION bb_bind_artifact_execution() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE execution bb_run_execution_versions%ROWTYPE;
BEGIN
  IF NEW.execution_version=2 THEN
    SELECT e.* INTO STRICT execution FROM bb_run_execution_versions e
      WHERE e.owner_user_id=NEW.owner_user_id AND e.run_id=NEW.run_id AND e.execution_version=NEW.execution_version
        AND e.input_revision=NEW.input_revision AND e.input_hash=NEW.input_hash;
    PERFORM bb_assert_test_successor_execution_active(NEW.owner_user_id,execution.project_id,NEW.run_id,
      NEW.execution_version,NEW.input_revision,NEW.input_hash);
  ELSE
    -- Preserve the V1 default only for an exact V1 head. A delayed old writer
    -- must still fail with the existing 0135 boundary after V2 adoption.
    IF NOT EXISTS(SELECT 1 FROM bb_run_execution_heads h JOIN bb_runs r
      ON r.owner_user_id=h.owner_user_id AND r.project_id=h.project_id AND r.id=h.run_id
      WHERE h.owner_user_id=NEW.owner_user_id AND h.run_id=NEW.run_id AND h.execution_version=1
        AND h.input_revision=r.input_revision AND h.input_hash=r.input_hash) THEN
      RAISE EXCEPTION 'successor artifact requires an explicitly supplied exact execution tuple'
        USING ERRCODE='23514',CONSTRAINT='bb_test_successor_artifact_closed';END IF;
    SELECT e.* INTO STRICT execution FROM bb_run_execution_versions e JOIN bb_runs r
      ON r.owner_user_id=e.owner_user_id AND r.project_id=e.project_id AND r.id=e.run_id
        AND r.input_revision=e.input_revision AND r.input_hash=e.input_hash
      WHERE e.owner_user_id=NEW.owner_user_id AND e.run_id=NEW.run_id AND e.execution_version=1
        AND (NEW.execution_version IS NULL OR (NEW.execution_version=e.execution_version
          AND NEW.input_revision=e.input_revision AND NEW.input_hash=e.input_hash));
  END IF;
  INSERT INTO bb_artifact_execution_bindings(artifact_id,artifact_version,owner_user_id,project_id,run_id,
    execution_version,input_revision,input_hash,created_at)
  VALUES(NEW.id,NEW.version,NEW.owner_user_id,execution.project_id,NEW.run_id,
    execution.execution_version,execution.input_revision,execution.input_hash,NEW.created_at);
  RETURN NEW;
EXCEPTION WHEN NO_DATA_FOUND THEN
  RAISE EXCEPTION 'artifact requires its exact explicit owned execution input'
    USING ERRCODE='23514',CONSTRAINT='bb_artifact_execution_exact';
END; $$;


-- Exact V2 writes; predecessor V1 shape/evidence/lifecycle checks remain.

CREATE OR REPLACE FUNCTION bb_check_model_call_execution_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.execution_version=2 THEN
    PERFORM bb_assert_test_successor_execution_active(NEW.owner_user_id,NEW.project_id,NEW.run_id,
      NEW.execution_version,NEW.input_revision,NEW.input_hash);
  END IF;
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
      AND ((e.execution_version=1 AND COALESCE(s.execution_version,1)=1
        AND EXISTS(SELECT 1 FROM bb_run_execution_heads h WHERE h.owner_user_id=e.owner_user_id
          AND h.project_id=e.project_id AND h.run_id=e.run_id AND h.execution_version=1
          AND h.input_revision=e.input_revision AND h.input_hash=e.input_hash))
        OR (e.execution_version=2 AND s.execution_version=2 AND a.created_at=NEW.created_at
          AND bb_test_successor_execution_origin(e.owner_user_id,e.project_id,e.run_id,e.execution_version,e.input_revision,e.input_hash)))
  ) THEN
    RAISE EXCEPTION 'model call must match its exact execution input and prompt'
      USING ERRCODE='23514', CONSTRAINT='bb_model_call_execution_exact';
  END IF;
  RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION bb_bind_model_call_execution() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.prompt_snapshot_id IS NULL THEN
    IF EXISTS(SELECT 1 FROM bb_jobs j JOIN bb_run_execution_heads h ON h.owner_user_id=j.owner_user_id AND h.run_id=j.run_id
      WHERE j.id=NEW.job_id AND j.owner_user_id=NEW.owner_user_id AND h.execution_version=2) THEN
      RAISE EXCEPTION 'successor model call requires an explicit exact model prompt'
        USING ERRCODE='23514',CONSTRAINT='bb_model_call_execution_exact';END IF;
    RETURN NEW;
  END IF;
  INSERT INTO bb_model_call_execution_bindings(attempt_id,owner_user_id,project_id,run_id,job_id,
    execution_version,input_revision,input_hash,prompt_snapshot_ref,created_at)
  SELECT NEW.id,NEW.owner_user_id,r.project_id,r.id,j.id,e.execution_version,e.input_revision,e.input_hash,s.id,NEW.created_at
  FROM bb_jobs j
  JOIN bb_runs r ON r.id=j.run_id AND r.owner_user_id=j.owner_user_id
  JOIN bb_run_execution_versions e ON e.owner_user_id=r.owner_user_id AND e.project_id=r.project_id AND e.run_id=r.id
  JOIN bb_snapshot_refs s ON s.id=NEW.prompt_snapshot_id AND s.owner_user_id=e.owner_user_id
    AND s.project_id=e.project_id AND s.run_id=e.run_id AND s.snapshot_kind='model_request'
    AND s.input_revision=e.input_revision AND s.input_hash=e.input_hash
    AND e.execution_version=COALESCE(s.execution_version,1)
  WHERE j.id=NEW.job_id AND j.owner_user_id=NEW.owner_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'model call must match its exact execution input and prompt'
      USING ERRCODE='23514', CONSTRAINT='bb_model_call_execution_exact';
  END IF;
  RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION bb_check_run_working_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE receipt bb_run_working_object_state%ROWTYPE;
BEGIN
  -- Exact historical discovery is cleanup inventory, including hidden/revoked
  -- scopes. The immutable result+attempt checks below still prove every claim;
  -- it cannot authorize a new Blob write. New producer claims need live grants.
  IF NEW.execution_version=2 AND NEW.discovered_result_id IS NULL THEN
    PERFORM bb_assert_test_successor_execution_active(NEW.owner_user_id,NEW.project_id,NEW.run_id,
      NEW.execution_version,NEW.input_revision,NEW.input_hash);
  END IF;
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
      AND e.input_revision=NEW.input_revision AND e.input_hash=NEW.input_hash
      AND (e.execution_version=1 OR (e.execution_version=2
        AND bb_test_successor_execution_origin(e.owner_user_id,e.project_id,e.run_id,e.execution_version,e.input_revision,e.input_hash)))
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

CREATE OR REPLACE FUNCTION bb_check_artifact_execution_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.execution_version=2 THEN
    PERFORM bb_assert_test_successor_execution_active(NEW.owner_user_id,NEW.project_id,NEW.run_id,
      NEW.execution_version,NEW.input_revision,NEW.input_hash);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM bb_artifact_versions a
    JOIN bb_runs r ON r.owner_user_id=a.owner_user_id AND r.id=a.run_id
    JOIN bb_run_execution_versions e ON e.owner_user_id=r.owner_user_id AND e.project_id=r.project_id
      AND e.run_id=r.id
    JOIN bb_input_revisions i ON i.owner_user_id=e.owner_user_id AND i.project_id=e.project_id
      AND i.revision=e.input_revision AND i.input_hash=e.input_hash
    WHERE a.id=NEW.artifact_id AND a.version=NEW.artifact_version AND a.owner_user_id=NEW.owner_user_id
      AND a.run_id=NEW.run_id AND a.created_at=NEW.created_at AND r.project_id=NEW.project_id
      AND e.execution_version=NEW.execution_version AND e.input_revision=NEW.input_revision AND e.input_hash=NEW.input_hash
      AND ((e.execution_version=1 AND r.input_revision=e.input_revision AND r.input_hash=e.input_hash
        AND (a.execution_version IS NULL OR (a.execution_version=1 AND a.input_revision=e.input_revision AND a.input_hash=e.input_hash)))
        OR (e.execution_version=2 AND a.execution_version=2 AND a.input_revision=e.input_revision AND a.input_hash=e.input_hash
          AND bb_test_successor_execution_origin(e.owner_user_id,e.project_id,e.run_id,e.execution_version,e.input_revision,e.input_hash)))
  ) THEN
    RAISE EXCEPTION 'artifact must preserve its exact owned initial execution and creation time'
      USING ERRCODE='23514', CONSTRAINT='bb_artifact_execution_exact';
  END IF;
  RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION bb_guard_artifact_execution_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id,NEW.version,NEW.owner_user_id,NEW.run_id,NEW.media_type,NEW.sha256,NEW.object_key,NEW.created_at,NEW.execution_version,NEW.input_revision,NEW.input_hash)
    IS DISTINCT FROM ROW(OLD.id,OLD.version,OLD.owner_user_id,OLD.run_id,OLD.media_type,OLD.sha256,OLD.object_key,OLD.created_at,OLD.execution_version,OLD.input_revision,OLD.input_hash) THEN
    RAISE EXCEPTION 'artifact identity and execution origin are immutable'
      USING ERRCODE='23514', CONSTRAINT='bb_artifact_execution_identity_immutable';
  END IF;
  RETURN NEW;
END; $$;

CREATE OR REPLACE VIEW bb_execution_artifact_versions AS
SELECT a.* FROM bb_artifact_versions a
JOIN bb_artifact_execution_bindings b ON b.owner_user_id=a.owner_user_id AND b.run_id=a.run_id
  AND b.artifact_id=a.id AND b.artifact_version=a.version AND b.created_at=a.created_at
JOIN bb_run_execution_versions e ON e.owner_user_id=b.owner_user_id AND e.project_id=b.project_id
  AND e.run_id=b.run_id AND e.execution_version=b.execution_version
  AND e.input_revision=b.input_revision AND e.input_hash=b.input_hash
JOIN bb_runs r ON r.owner_user_id=b.owner_user_id AND r.project_id=b.project_id AND r.id=b.run_id
JOIN bb_input_revisions i ON i.owner_user_id=b.owner_user_id AND i.project_id=b.project_id
  AND i.revision=b.input_revision AND i.input_hash=b.input_hash
WHERE (e.execution_version=1 AND r.input_revision=e.input_revision AND r.input_hash=e.input_hash
    AND (a.execution_version IS NULL OR (a.execution_version=1 AND a.input_revision=e.input_revision AND a.input_hash=e.input_hash)))
  OR (e.execution_version=2 AND a.execution_version=2 AND a.input_revision=e.input_revision AND a.input_hash=e.input_hash
    AND bb_test_successor_execution_origin(e.owner_user_id,e.project_id,e.run_id,e.execution_version,e.input_revision,e.input_hash));

CREATE OR REPLACE FUNCTION bb_check_review_execution_editor() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE review_body jsonb; manifest jsonb; source_pin jsonb; manifest_pin jsonb;
  review_created_at timestamptz; execution_created_at timestamptz; source_format text;
BEGIN
  IF NEW.execution_version=2 THEN
    PERFORM bb_assert_test_successor_execution_active(NEW.owner_user_id,NEW.project_id,NEW.run_id,
      NEW.execution_version,NEW.input_revision,NEW.input_hash);
  END IF;
  IF NOT bb_review_editor_snapshot_shape(NEW.snapshot) THEN
    RAISE EXCEPTION 'review editor body must match review-editor-v1'
      USING ERRCODE='23514',CONSTRAINT='bb_review_execution_editor_shape';
  END IF;
  IF encode(sha256(convert_to(bb_review_editor_canonical_json(NEW.snapshot),'UTF8')),'hex') IS DISTINCT FROM NEW.sha256::text THEN
    RAISE EXCEPTION 'review editor hash must match its canonical immutable body'
      USING ERRCODE='23514',CONSTRAINT='bb_review_execution_editor_hash';
  END IF;
  -- Read only immutable origin rows. In particular, do not infer a historical
  -- editor's execution from the current mutable bb_runs input or lock parent
  -- rows in a trigger running after a writer already holds its run/job lease.
  SELECT s.snapshot,i.manifest,s.created_at,e.created_at
    INTO STRICT review_body,manifest,review_created_at,execution_created_at
  FROM bb_review_execution_snapshots s
  JOIN bb_run_execution_versions e
    ON e.owner_user_id=s.owner_user_id AND e.project_id=s.project_id AND e.run_id=s.run_id
    AND e.execution_version=s.execution_version AND e.input_revision=s.input_revision AND e.input_hash=s.input_hash
  JOIN bb_input_revisions i
    ON i.owner_user_id=e.owner_user_id AND i.project_id=e.project_id AND i.revision=e.input_revision AND i.input_hash=e.input_hash
  WHERE s.owner_user_id=NEW.owner_user_id AND s.project_id=NEW.project_id AND s.run_id=NEW.run_id
    AND s.execution_version=NEW.execution_version AND s.input_revision=NEW.input_revision AND s.input_hash=NEW.input_hash;
  source_pin := review_body#>'{input,source_material_ref}';
  IF manifest#>>'{review,version}'='review_v1' THEN
    manifest_pin := manifest#>'{review,input,source_material_ref}';
  ELSIF manifest#>>'{authoring,version}'='unified_v1' THEN
    manifest_pin := manifest#>'{authoring,review_result,source_material}';
  ELSE manifest_pin := NULL;
  END IF;
  IF NOT bb_execution_material_pin_shape(source_pin) OR source_pin IS DISTINCT FROM manifest_pin
    OR NOT COALESCE(review_body#>'{input,material_versions}' @> jsonb_build_array(source_pin),false)
    OR NEW.snapshot->>'source_sha256' IS DISTINCT FROM source_pin->>'sha256'
    OR NEW.created_at<review_created_at OR NEW.created_at<execution_created_at THEN
    RAISE EXCEPTION 'review editor must preserve its exact execution source pin and creation time'
      USING ERRCODE='23514',CONSTRAINT='bb_review_execution_editor_origin';
  END IF;
  -- Validate the live source registration at insertion, with joint owner and
  -- project scope. No material FK/reference is added: an editor is not a new
  -- permanent raw-material retention pin, and normal source deletion remains
  -- governed by the existing lifecycle.
  SELECT CASE m.media_type
      WHEN 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' THEN 'docx'
      WHEN 'application/pdf' THEN 'pdf' ELSE NULL END
    INTO STRICT source_format
  FROM bb_material_versions m
  WHERE m.owner_user_id=NEW.owner_user_id AND m.project_id=NEW.project_id
    AND m.id=source_pin->>'material_id' AND m.version::numeric=(source_pin->>'material_version')::numeric
    AND m.sha256=source_pin->>'sha256';
  IF source_format IS NULL OR NEW.snapshot->>'source_format' IS DISTINCT FROM source_format THEN
    RAISE EXCEPTION 'review editor source format must match its exact owned material pin'
      USING ERRCODE='23514',CONSTRAINT='bb_review_execution_editor_source';
  END IF;
  RETURN NEW;
EXCEPTION WHEN NO_DATA_FOUND THEN
  RAISE EXCEPTION 'review editor requires its exact execution review snapshot and owned source registration'
    USING ERRCODE='23514',CONSTRAINT='bb_review_execution_editor_origin';
END; $$;

CREATE OR REPLACE FUNCTION bb_check_review_execution_report() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE review_body jsonb; manifest jsonb; source_pin jsonb; review_version integer; operation text; task_kind text;
  review_created_at timestamptz; execution_created_at timestamptz;
BEGIN
  IF NEW.execution_version=2 THEN
    PERFORM bb_assert_test_successor_execution_active(NEW.owner_user_id,NEW.project_id,NEW.run_id,
      NEW.execution_version,NEW.input_revision,NEW.input_hash);
  END IF;
  IF NOT bb_review_report_storage_shape(NEW.report) THEN
    RAISE EXCEPTION 'review report must preserve its storage envelope'
      USING ERRCODE='23514',CONSTRAINT='bb_review_execution_report_shape';
  END IF;
  -- Numeric identity fields compare as JSONB to trusted PostgreSQL integers;
  -- never cast arbitrary report numbers to integer or hash JSONB text here.
  IF NEW.report->>'report_id' IS DISTINCT FROM NEW.id
    OR NEW.report->>'project_id' IS DISTINCT FROM NEW.project_id
    OR NEW.report->>'run_id' IS DISTINCT FROM NEW.run_id
    OR NEW.report->'input_revision' IS DISTINCT FROM to_jsonb(NEW.input_revision)
    OR NEW.report->'version' IS DISTINCT FROM to_jsonb(NEW.version) THEN
    RAISE EXCEPTION 'review report body must match its registered identity'
      USING ERRCODE='23514',CONSTRAINT='bb_review_execution_report_identity';
  END IF;
  -- Canonical registration depends only on immutable execution/input/business
  -- origins, never on a legacy report or the current mutable run input.
  SELECT s.snapshot,s.version,s.operation,i.manifest,s.created_at,e.created_at,r.task_kind
    INTO STRICT review_body,review_version,operation,manifest,review_created_at,execution_created_at,task_kind
  FROM bb_review_execution_snapshots s
  JOIN bb_run_execution_versions e
    ON e.owner_user_id=s.owner_user_id AND e.project_id=s.project_id AND e.run_id=s.run_id
    AND e.execution_version=s.execution_version AND e.input_revision=s.input_revision AND e.input_hash=s.input_hash
  JOIN bb_input_revisions i
    ON i.owner_user_id=e.owner_user_id AND i.project_id=e.project_id AND i.revision=e.input_revision AND i.input_hash=e.input_hash
  JOIN bb_runs r ON r.owner_user_id=e.owner_user_id AND r.project_id=e.project_id AND r.id=e.run_id
  WHERE s.owner_user_id=NEW.owner_user_id AND s.project_id=NEW.project_id AND s.run_id=NEW.run_id
    AND s.execution_version=NEW.execution_version AND s.input_revision=NEW.input_revision AND s.input_hash=NEW.input_hash;
  source_pin := review_body#>'{input,source_material_ref}';
  IF task_kind IS DISTINCT FROM 'review' OR manifest#>>'{review,version}' IS DISTINCT FROM 'review_v1'
    OR manifest#>>'{review,report_id}' IS DISTINCT FROM NEW.id
    OR manifest#>'{review,version_number}' IS DISTINCT FROM to_jsonb(NEW.version)
    OR review_version IS DISTINCT FROM NEW.version OR operation NOT IN ('full_review','differential_review')
    OR manifest#>>'{review,operation}' IS DISTINCT FROM operation
    OR NEW.report#>>'{scope,mode}' IS DISTINCT FROM operation
    OR NEW.report#>'{scope,finding_ids}' IS DISTINCT FROM review_body->'finding_ids'
    OR manifest#>'{review,finding_ids}' IS DISTINCT FROM review_body->'finding_ids'
    OR manifest#>'{review,input}' IS DISTINCT FROM review_body->'input'
    OR NOT bb_execution_material_pin_shape(source_pin)
    OR source_pin IS DISTINCT FROM manifest#>'{review,input,source_material_ref}'
    OR NEW.report->'source_material' IS DISTINCT FROM source_pin
    OR NOT COALESCE(review_body#>'{input,material_versions}' @> jsonb_build_array(source_pin),false)
    OR NEW.created_at<review_created_at OR NEW.created_at<execution_created_at THEN
    RAISE EXCEPTION 'review report must preserve its exact execution review input and source pin'
      USING ERRCODE='23514',CONSTRAINT='bb_review_execution_report_origin';
  END IF;
  -- The row registration time and report body's completion timestamp have
  -- distinct meanings. Preserve both; no equality or timestamp rewriting is
  -- imposed. A report adds no permanent raw-material retention reference.
  RETURN NEW;
EXCEPTION WHEN NO_DATA_FOUND THEN
  RAISE EXCEPTION 'review report requires its exact owned execution review origin'
    USING ERRCODE='23514',CONSTRAINT='bb_review_execution_report_origin';
END; $$;

CREATE OR REPLACE FUNCTION bb_check_review_execution_artifact() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owned_run text;
BEGIN
  IF NEW.execution_version=2 THEN
    PERFORM bb_assert_test_successor_execution_active(NEW.owner_user_id,NEW.project_id,NEW.run_id,
      NEW.execution_version,NEW.input_revision,NEW.input_hash);
  END IF;
  IF TG_OP='UPDATE' AND ROW(NEW.owner_user_id,NEW.project_id,NEW.run_id,NEW.execution_version,NEW.input_revision,NEW.input_hash,NEW.kind,NEW.filename)
    IS DISTINCT FROM ROW(OLD.owner_user_id,OLD.project_id,OLD.run_id,OLD.execution_version,OLD.input_revision,OLD.input_hash,OLD.kind,OLD.filename) THEN
    RAISE EXCEPTION 'review artifact slot identity and filename are fixed'
      USING ERRCODE='23514',CONSTRAINT='bb_review_execution_artifact_identity';
  END IF;
  -- The provenance join permits retained/revoked candidates as historical data;
  -- availability and quality remain delivery/reader checks. A slot may refer
  -- only to its own precisely bound artifact, never another run's candidate.
  SELECT r.id INTO STRICT owned_run
  FROM bb_runs r
  JOIN bb_run_execution_versions e ON e.owner_user_id=r.owner_user_id AND e.project_id=r.project_id AND e.run_id=r.id
  JOIN bb_review_execution_snapshots s ON s.owner_user_id=e.owner_user_id AND s.project_id=e.project_id AND s.run_id=e.run_id
    AND s.execution_version=e.execution_version AND s.input_revision=e.input_revision AND s.input_hash=e.input_hash
  JOIN bb_input_revisions i ON i.owner_user_id=e.owner_user_id AND i.project_id=e.project_id
    AND i.revision=e.input_revision AND i.input_hash=e.input_hash
  JOIN bb_artifact_execution_bindings b ON b.owner_user_id=e.owner_user_id AND b.project_id=e.project_id AND b.run_id=e.run_id
    AND b.execution_version=e.execution_version AND b.input_revision=e.input_revision AND b.input_hash=e.input_hash
  JOIN bb_execution_artifact_versions a ON a.owner_user_id=b.owner_user_id AND a.run_id=b.run_id
    AND a.id=b.artifact_id AND a.version=b.artifact_version AND a.created_at=b.created_at
  WHERE r.owner_user_id=NEW.owner_user_id AND r.project_id=NEW.project_id AND r.id=NEW.run_id
    AND e.execution_version=NEW.execution_version AND e.input_revision=NEW.input_revision AND e.input_hash=NEW.input_hash
    AND a.id=NEW.artifact_id AND a.version=NEW.artifact_version
    AND ((e.execution_version=1 AND e.input_revision=r.input_revision AND e.input_hash=r.input_hash
        AND (SELECT count(*) FROM bb_run_execution_versions WHERE run_id=r.id)=1)
      OR (e.execution_version=2 AND bb_test_successor_execution_origin(e.owner_user_id,e.project_id,e.run_id,e.execution_version,e.input_revision,e.input_hash)))
  FOR KEY SHARE OF r NOWAIT;
  -- A direct SQL registrar may already own its slot. Never wait for the parent
  -- in that reversed order: KEY SHARE NOWAIT either joins the production lock
  -- protocol or fails with 55P03. Terminal capture's FOR UPDATE serializes both
  -- replacement and a new slot (including INSERT/FK waits) against final freeze.
  RETURN NEW;
EXCEPTION WHEN NO_DATA_FOUND THEN
  RAISE EXCEPTION 'review artifact requires its exact owned V1 execution and artifact origin'
    USING ERRCODE='23514',CONSTRAINT='bb_review_execution_artifact_origin';
END; $$;

CREATE OR REPLACE FUNCTION bb_check_m4_execution_artifact() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owned_run text;
BEGIN
  IF NEW.execution_version=2 THEN
    PERFORM bb_assert_test_successor_execution_active(NEW.owner_user_id,NEW.project_id,NEW.run_id,
      NEW.execution_version,NEW.input_revision,NEW.input_hash);
  END IF;
  SELECT r.id INTO STRICT owned_run
  FROM bb_runs r
  JOIN bb_jobs j ON j.owner_user_id=r.owner_user_id AND j.run_id=r.id
  JOIN bb_run_execution_versions e ON e.owner_user_id=r.owner_user_id AND e.project_id=r.project_id AND e.run_id=r.id
  JOIN bb_m4_execution_snapshots s ON s.owner_user_id=e.owner_user_id AND s.project_id=e.project_id AND s.run_id=e.run_id
    AND s.execution_version=e.execution_version AND s.input_revision=e.input_revision AND s.input_hash=e.input_hash
  JOIN bb_input_revisions i ON i.owner_user_id=e.owner_user_id AND i.project_id=e.project_id
    AND i.revision=e.input_revision AND i.input_hash=e.input_hash AND i.manifest=s.manifest
  JOIN bb_m4_topics t ON t.owner_user_id=s.owner_user_id AND t.project_id=s.project_id AND t.id=s.topic_id
  JOIN bb_artifact_execution_bindings b ON b.owner_user_id=e.owner_user_id AND b.project_id=e.project_id AND b.run_id=e.run_id
    AND b.execution_version=e.execution_version AND b.input_revision=e.input_revision AND b.input_hash=e.input_hash
  JOIN bb_execution_artifact_versions a ON a.owner_user_id=b.owner_user_id AND a.run_id=b.run_id
    AND a.id=b.artifact_id AND a.version=b.artifact_version AND a.created_at=b.created_at
  WHERE e.owner_user_id=NEW.owner_user_id AND e.project_id=NEW.project_id AND e.run_id=NEW.run_id
    AND e.execution_version=NEW.execution_version AND e.input_revision=NEW.input_revision AND e.input_hash=NEW.input_hash
    AND s.topic_id=NEW.topic_id AND a.id=NEW.artifact_id AND a.version=NEW.artifact_version
    AND r.task_kind='generation' AND j.subtype='m4_document_v1'
    AND s.manifest->>'version'='m4-document-input-v1' AND s.manifest->>'kind'='document'
    AND s.manifest#>>'{input,document_type}'=NEW.document_type
    AND COALESCE(s.manifest#>'{input,edit_base}','null'::jsonb)=COALESCE(NEW.base_artifact,'null'::jsonb)
    AND a.media_type='application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    AND ((e.execution_version=1 AND e.input_revision=r.input_revision AND e.input_hash=r.input_hash
        AND (SELECT count(*) FROM bb_run_execution_versions WHERE run_id=r.id)=1)
      OR (e.execution_version=2 AND bb_test_successor_execution_origin(e.owner_user_id,e.project_id,e.run_id,e.execution_version,e.input_revision,e.input_hash)))
  FOR KEY SHARE OF r NOWAIT;
  -- This validates provenance, including retained/revoked candidates. Delivery
  -- status, readback readiness and publication remain separate consumer gates.
  IF EXISTS(SELECT 1 FROM bb_m4_execution_artifacts c
    WHERE ((c.run_id=NEW.run_id AND c.execution_version=NEW.execution_version AND c.kind=NEW.kind)
      OR (c.artifact_id=NEW.artifact_id AND c.artifact_version=NEW.artifact_version))
      AND to_jsonb(c) IS DISTINCT FROM to_jsonb(NEW)) THEN
    RAISE EXCEPTION 'M4 execution Word registration replay must preserve every field'
      USING ERRCODE='23514',CONSTRAINT='bb_m4_execution_artifact_replay';
  END IF;
  RETURN NEW;
EXCEPTION WHEN NO_DATA_FOUND THEN
  RAISE EXCEPTION 'M4 Word registration requires its exact owned V1 document execution and artifact origin'
    USING ERRCODE='23514',CONSTRAINT='bb_m4_execution_artifact_origin';
END; $$;

CREATE OR REPLACE FUNCTION bb_guard_review_execution_artifact() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owned_run text;
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'review artifact slots cannot be deleted'
      USING ERRCODE='23514',CONSTRAINT='bb_review_execution_artifact_identity';
  END IF;
  -- Exact origin is checked by the preceding _exact trigger. Take the same
  -- nonblocking parent lock here as well so this guard has no late-parent wait
  -- and cannot silently treat an unowned/missing run as an unfrozen selection.
  SELECT r.id INTO STRICT owned_run FROM bb_runs r
  WHERE r.owner_user_id=NEW.owner_user_id AND r.project_id=NEW.project_id AND r.id=NEW.run_id
    AND ((NEW.execution_version=1 AND r.input_revision=NEW.input_revision AND r.input_hash=NEW.input_hash)
      OR (NEW.execution_version=2 AND bb_test_successor_execution_origin(NEW.owner_user_id,NEW.project_id,NEW.run_id,NEW.execution_version,NEW.input_revision,NEW.input_hash)))
  FOR KEY SHARE NOWAIT;
  IF EXISTS(SELECT 1 FROM bb_run_execution_deliveries d
    WHERE d.owner_user_id=NEW.owner_user_id AND d.project_id=NEW.project_id AND d.run_id=NEW.run_id
      AND d.execution_version=NEW.execution_version AND d.input_revision=NEW.input_revision AND d.input_hash=NEW.input_hash AND d.delivery_phase='final')
    OR EXISTS(SELECT 1 FROM bb_runs r WHERE r.owner_user_id=NEW.owner_user_id AND r.project_id=NEW.project_id AND r.id=NEW.run_id
      AND r.state IN ('succeeded','test_completed')) THEN
    IF TG_OP='UPDATE' AND NEW.artifact_id=OLD.artifact_id AND NEW.artifact_version=OLD.artifact_version THEN RETURN NEW; END IF;
    -- INSERT ... ON CONFLICT may legitimately replay an already frozen slot.
    -- It may not create a new selection or replace that slot after capture.
    IF TG_OP='INSERT' AND EXISTS(SELECT 1 FROM bb_review_execution_artifacts c
      WHERE c.owner_user_id=NEW.owner_user_id AND c.project_id=NEW.project_id AND c.run_id=NEW.run_id
        AND c.execution_version=NEW.execution_version AND c.input_revision=NEW.input_revision AND c.input_hash=NEW.input_hash
        AND c.kind=NEW.kind AND c.filename=NEW.filename AND c.artifact_id=NEW.artifact_id AND c.artifact_version=NEW.artifact_version) THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'review artifact selection is frozen by its final delivery'
      USING ERRCODE='23514',CONSTRAINT='bb_review_execution_artifact_final';
  END IF;
  RETURN NEW;
EXCEPTION WHEN NO_DATA_FOUND THEN
  RAISE EXCEPTION 'review artifact requires its exact owned run'
    USING ERRCODE='23514',CONSTRAINT='bb_review_execution_artifact_origin';
END; $$;

CREATE OR REPLACE FUNCTION bb_mirror_review_execution_artifact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.execution_version=2 THEN RETURN NEW; END IF;
  IF NEW.execution_version<>1 THEN
    RAISE EXCEPTION 'only V1 review artifact mirrors are supported'
      USING ERRCODE='23514',CONSTRAINT='bb_review_execution_artifact_origin';
  END IF;
  IF EXISTS(SELECT 1 FROM bb_review_artifacts legacy
    WHERE legacy.owner_user_id=NEW.owner_user_id AND legacy.project_id=NEW.project_id AND legacy.run_id=NEW.run_id
      AND legacy.kind=NEW.kind AND legacy.filename=NEW.filename AND legacy.artifact_id=NEW.artifact_id AND legacy.artifact_version=NEW.artifact_version) THEN RETURN NEW; END IF;
  INSERT INTO bb_review_artifacts AS legacy(owner_user_id,project_id,run_id,artifact_id,artifact_version,kind,filename)
  VALUES(NEW.owner_user_id,NEW.project_id,NEW.run_id,NEW.artifact_id,NEW.artifact_version,NEW.kind,NEW.filename)
  ON CONFLICT(run_id,kind) DO UPDATE SET artifact_id=EXCLUDED.artifact_id,artifact_version=EXCLUDED.artifact_version
    WHERE legacy.owner_user_id=EXCLUDED.owner_user_id AND legacy.project_id=EXCLUDED.project_id AND legacy.filename=EXCLUDED.filename;
  IF NOT EXISTS(SELECT 1 FROM bb_review_artifacts legacy
    WHERE legacy.owner_user_id=NEW.owner_user_id AND legacy.project_id=NEW.project_id AND legacy.run_id=NEW.run_id
      AND legacy.kind=NEW.kind AND legacy.filename=NEW.filename AND legacy.artifact_id=NEW.artifact_id AND legacy.artifact_version=NEW.artifact_version) THEN
    RAISE EXCEPTION 'review execution artifact must exactly mirror its legacy V1 slot'
      USING ERRCODE='23514',CONSTRAINT='bb_review_execution_artifact_mirror';
  END IF;
  RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION bb_mirror_m4_execution_artifact() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE legacy_row jsonb := to_jsonb(NEW)-ARRAY['project_id','execution_version','input_revision'];
BEGIN
  IF NEW.execution_version=2 THEN RETURN NEW; END IF;
  IF NEW.execution_version<>1 THEN
    RAISE EXCEPTION 'only V1 M4 Word registration mirrors are supported'
      USING ERRCODE='23514',CONSTRAINT='bb_m4_execution_artifact_origin';
  END IF;
  IF EXISTS(SELECT 1 FROM bb_m4_artifacts legacy WHERE legacy.run_id=NEW.run_id AND legacy.kind=NEW.kind
    AND to_jsonb(legacy)=legacy_row) THEN RETURN NEW; END IF;
  INSERT INTO bb_m4_artifacts(owner_user_id,topic_id,run_id,artifact_id,artifact_version,kind,filename,byte_size,
    document_type,base_artifact,input_hash,body_content,preview_content,created_at,revision_number)
  VALUES(NEW.owner_user_id,NEW.topic_id,NEW.run_id,NEW.artifact_id,NEW.artifact_version,NEW.kind,NEW.filename,NEW.byte_size,
    NEW.document_type,NEW.base_artifact,NEW.input_hash,NEW.body_content,NEW.preview_content,NEW.created_at,NEW.revision_number)
  ON CONFLICT DO NOTHING;
  IF NOT EXISTS(SELECT 1 FROM bb_m4_artifacts legacy WHERE legacy.run_id=NEW.run_id AND legacy.kind=NEW.kind
    AND to_jsonb(legacy)=legacy_row) THEN
    RAISE EXCEPTION 'M4 execution Word registration must exactly mirror its legacy registry'
      USING ERRCODE='23514',CONSTRAINT='bb_m4_execution_artifact_mirror';
  END IF;
  RETURN NEW;
END; $$;

CREATE OR REPLACE VIEW bb_review_execution_artifact_versions AS
SELECT c.*,a.sha256 AS artifact_sha256,a.media_type,a.object_key,a.quality_status,a.delivery_status,
  a.created_at AS artifact_created_at,i.manifest,s.version AS review_version,s.operation,s.source_report_id,s.snapshot AS execution_snapshot
FROM bb_review_execution_artifacts c
JOIN bb_run_execution_versions e ON e.owner_user_id=c.owner_user_id AND e.project_id=c.project_id AND e.run_id=c.run_id
  AND e.execution_version=c.execution_version AND e.input_revision=c.input_revision AND e.input_hash=c.input_hash
JOIN bb_review_execution_snapshots s ON s.owner_user_id=c.owner_user_id AND s.project_id=c.project_id AND s.run_id=c.run_id
  AND s.execution_version=c.execution_version AND s.input_revision=c.input_revision AND s.input_hash=c.input_hash
JOIN bb_input_revisions i ON i.owner_user_id=c.owner_user_id AND i.project_id=c.project_id
  AND i.revision=c.input_revision AND i.input_hash=c.input_hash
JOIN bb_runs r ON r.owner_user_id=c.owner_user_id AND r.project_id=c.project_id AND r.id=c.run_id
JOIN bb_artifact_execution_bindings b ON b.owner_user_id=c.owner_user_id AND b.project_id=c.project_id AND b.run_id=c.run_id
  AND b.execution_version=c.execution_version AND b.input_revision=c.input_revision AND b.input_hash=c.input_hash
  AND b.artifact_id=c.artifact_id AND b.artifact_version=c.artifact_version
JOIN bb_execution_artifact_versions a ON a.owner_user_id=b.owner_user_id AND a.run_id=b.run_id
  AND a.id=b.artifact_id AND a.version=b.artifact_version AND a.created_at=b.created_at
WHERE (e.execution_version=1 AND e.input_revision=r.input_revision AND e.input_hash=r.input_hash)
  OR (e.execution_version=2 AND bb_test_successor_execution_origin(e.owner_user_id,e.project_id,e.run_id,e.execution_version,e.input_revision,e.input_hash));

CREATE OR REPLACE VIEW bb_m4_execution_artifact_versions AS
SELECT c.*,s.manifest,a.sha256 AS artifact_sha256,a.media_type,a.object_key,a.quality_status,a.delivery_status,
  a.created_at AS artifact_created_at
FROM bb_m4_execution_artifacts c
JOIN bb_run_execution_versions e ON e.owner_user_id=c.owner_user_id AND e.project_id=c.project_id AND e.run_id=c.run_id
  AND e.execution_version=c.execution_version AND e.input_revision=c.input_revision AND e.input_hash=c.input_hash
JOIN bb_m4_execution_snapshots s ON s.owner_user_id=c.owner_user_id AND s.project_id=c.project_id AND s.run_id=c.run_id
  AND s.execution_version=c.execution_version AND s.input_revision=c.input_revision AND s.input_hash=c.input_hash AND s.topic_id=c.topic_id
JOIN bb_input_revisions i ON i.owner_user_id=c.owner_user_id AND i.project_id=c.project_id
  AND i.revision=c.input_revision AND i.input_hash=c.input_hash AND i.manifest=s.manifest
JOIN bb_runs r ON r.owner_user_id=c.owner_user_id AND r.project_id=c.project_id AND r.id=c.run_id
JOIN bb_jobs j ON j.owner_user_id=c.owner_user_id AND j.run_id=c.run_id
JOIN bb_m4_topics t ON t.owner_user_id=c.owner_user_id AND t.project_id=c.project_id AND t.id=c.topic_id
JOIN bb_artifact_execution_bindings b ON b.owner_user_id=c.owner_user_id AND b.project_id=c.project_id AND b.run_id=c.run_id
  AND b.execution_version=c.execution_version AND b.input_revision=c.input_revision AND b.input_hash=c.input_hash
  AND b.artifact_id=c.artifact_id AND b.artifact_version=c.artifact_version
JOIN bb_execution_artifact_versions a ON a.owner_user_id=c.owner_user_id AND a.run_id=c.run_id
  AND a.id=c.artifact_id AND a.version=c.artifact_version AND a.created_at=b.created_at
WHERE r.task_kind='generation' AND j.subtype='m4_document_v1'
  AND s.manifest->>'version'='m4-document-input-v1' AND s.manifest->>'kind'='document'
  AND s.manifest#>>'{input,document_type}'=c.document_type
  AND COALESCE(s.manifest#>'{input,edit_base}','null'::jsonb)=COALESCE(c.base_artifact,'null'::jsonb)
  AND a.media_type='application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  AND ((e.execution_version=1 AND e.input_revision=r.input_revision AND e.input_hash=r.input_hash)
    OR (e.execution_version=2 AND bb_test_successor_execution_origin(e.owner_user_id,e.project_id,e.run_id,e.execution_version,e.input_revision,e.input_hash)));

-- Completion consumes the explicit worker stamp and records the target grant.
-- V1 durable capture and every deployed billing/finalizer statement remain.

CREATE OR REPLACE FUNCTION bb_review_delivery_ready(r bb_runs) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE correction boolean; pair jsonb; execution bb_run_execution_versions%ROWTYPE;
BEGIN
 SELECT * INTO execution FROM bb_run_execution_versions e
 WHERE e.owner_user_id=r.owner_user_id AND e.project_id=r.project_id AND e.run_id=r.id
   AND ((e.execution_version=1 AND e.input_revision=r.input_revision AND e.input_hash=r.input_hash
     AND (SELECT count(*) FROM bb_run_execution_versions WHERE run_id=r.id)=1)
     OR (e.execution_version=2 AND bb_test_successor_execution_origin(e.owner_user_id,e.project_id,e.run_id,e.execution_version,e.input_revision,e.input_hash)
       AND EXISTS(SELECT 1 FROM bb_run_execution_heads h JOIN bb_jobs j ON j.owner_user_id=h.owner_user_id AND j.run_id=h.run_id
         WHERE h.owner_user_id=e.owner_user_id AND h.project_id=e.project_id AND h.run_id=e.run_id
           AND h.execution_version=e.execution_version AND h.input_revision=e.input_revision AND h.input_hash=e.input_hash
           AND j.checkpoint->'stage_execution'=jsonb_build_object('execution_version',e.execution_version,'input_revision',e.input_revision,'input_hash',trim(e.input_hash)))));
 IF NOT FOUND THEN RETURN false; END IF;
 SELECT manifest #>> '{review,file_delivery,version}' = 'review-correction-v2' INTO correction
 FROM bb_input_revisions WHERE owner_user_id=execution.owner_user_id AND project_id=execution.project_id
   AND revision=execution.input_revision AND input_hash=execution.input_hash;
 IF correction IS DISTINCT FROM true THEN
   RETURN EXISTS(SELECT 1 FROM bb_review_execution_artifacts a JOIN bb_execution_artifact_versions v ON v.id=a.artifact_id AND v.version=a.artifact_version
     WHERE a.owner_user_id=execution.owner_user_id AND a.project_id=execution.project_id AND a.run_id=execution.run_id
       AND a.execution_version=execution.execution_version AND a.input_revision=execution.input_revision AND a.input_hash=execution.input_hash AND a.kind='report'
       AND v.owner_user_id=r.owner_user_id AND v.run_id=r.id AND v.id=r.artifact_id AND v.version=r.artifact_version
       AND v.delivery_status=CASE WHEN r.channel='non_production_test' THEN 'test_only' ELSE 'available' END AND v.quality_status='passed');
 END IF;
 SELECT checkpoint #> '{stages,word_delivery_pair}' INTO pair FROM bb_jobs WHERE owner_user_id=r.owner_user_id AND run_id=r.id;
 IF pair->>'revision_artifact_id' IS NULL OR pair->>'clean_artifact_id' IS NULL OR r.artifact_id IS DISTINCT FROM pair->>'revision_artifact_id' THEN RETURN false; END IF;
 RETURN (SELECT count(DISTINCT a.kind)=3 FROM bb_review_execution_artifacts a
   JOIN bb_execution_artifact_versions v ON v.id=a.artifact_id AND v.version=a.artifact_version AND v.owner_user_id=a.owner_user_id AND v.run_id=a.run_id
   JOIN bb_word_delivery_evidence evidence ON evidence.id=v.word_delivery_evidence_id AND evidence.owner_user_id=v.owner_user_id AND evidence.run_id=v.run_id
     AND evidence.artifact_id=v.id AND evidence.artifact_version=v.version
   WHERE a.owner_user_id=execution.owner_user_id AND a.project_id=execution.project_id AND a.run_id=execution.run_id
     AND a.execution_version=execution.execution_version AND a.input_revision=execution.input_revision AND a.input_hash=execution.input_hash
     AND v.delivery_status=CASE WHEN r.channel='non_production_test' THEN 'test_only' ELSE 'available' END AND v.quality_status='passed' AND evidence.delivery_status='available' AND evidence.delivery_code='readback_verified'
     AND evidence.readback_sha256=v.sha256 AND evidence.candidate_sha256=v.sha256
     AND (a.kind='report' OR (a.kind='revision' AND v.id=r.artifact_id AND v.version=r.artifact_version)
       OR (a.kind='clean' AND v.id=pair->>'clean_artifact_id')));
END; $$;

CREATE OR REPLACE FUNCTION bb_run_execution_delivery_plan(owned_by text, target_run text, origin text, phase text DEFAULT 'final')
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r bb_runs%ROWTYPE; j bb_jobs%ROWTYPE; e bb_run_execution_versions%ROWTYPE;
  d bb_run_execution_deliveries%ROWTYPE; a bb_artifact_versions%ROWTYPE;
  pair jsonb; refs jsonb; item jsonb; member jsonb; members jsonb := '[]'::jsonb;
  role_name text; member_role text; member_version integer; matches integer; existing jsonb;
  review_version integer; m4_manifest jsonb; terminal_event bb_run_events%ROWTYPE;
  registration_count integer; registration_kind text;
BEGIN
  IF phase NOT IN ('final','m4_durable') OR origin NOT IN ('terminal_transition','m4_durable_registration','legacy_backfill')
    OR (phase='final' AND origin='m4_durable_registration') OR (phase='m4_durable' AND origin='terminal_transition') THEN
    RAISE EXCEPTION 'unsupported delivery source' USING ERRCODE='23514',CONSTRAINT='bb_execution_delivery_exact';
  END IF;
  SELECT * INTO STRICT r FROM bb_runs WHERE owner_user_id=owned_by AND id=target_run FOR UPDATE;
  SELECT * INTO STRICT j FROM bb_jobs WHERE owner_user_id=owned_by AND run_id=r.id FOR UPDATE;
  IF r.task_kind='platform_probe' OR j.job_type='platform_probe' THEN RETURN NULL; END IF;
  IF phase='m4_durable' THEN
    -- Preserve the existing non-dynamic M4 durable-read contract. This records
    -- persistence, never terminal success or a new billing authorization.
    IF r.channel<>'production' OR j.subtype NOT IN ('m4_document_v1','m4_qa_v1') OR EXISTS(
      SELECT 1 FROM bb_credit_reservations c WHERE c.id=r.reservation_id AND c.owner_user_id=r.owner_user_id AND c.billing_policy='authoring_balance_v2'
    ) THEN RETURN NULL; END IF;
    registration_kind:=CASE WHEN j.subtype='m4_qa_v1' THEN 'qa_text' ELSE 'document' END;
    SELECT count(*) INTO registration_count FROM bb_m4_artifact_execution_versions q WHERE q.owner_user_id=r.owner_user_id AND q.project_id=r.project_id AND q.run_id=r.id AND q.execution_version=1 AND q.input_revision=r.input_revision AND q.input_hash=r.input_hash;
    -- Some existing callers register document and note in two transactions.
    -- The first call is a no-op; it must not freeze a partial delivery.
    IF registration_count<>(CASE WHEN registration_kind='qa_text' THEN 1 ELSE 2 END)
      OR NOT EXISTS(SELECT 1 FROM bb_m4_artifact_execution_versions WHERE owner_user_id=r.owner_user_id AND project_id=r.project_id AND run_id=r.id AND execution_version=1 AND input_revision=r.input_revision AND input_hash=r.input_hash AND kind=registration_kind)
      OR (registration_kind='document' AND NOT EXISTS(SELECT 1 FROM bb_m4_artifact_execution_versions WHERE owner_user_id=r.owner_user_id AND project_id=r.project_id AND run_id=r.id AND execution_version=1 AND input_revision=r.input_revision AND input_hash=r.input_hash AND kind='preparation_note')) THEN RETURN NULL; END IF;
    SELECT artifact_id,artifact_version INTO STRICT r.artifact_id,r.artifact_version FROM bb_m4_artifact_execution_versions
      WHERE owner_user_id=r.owner_user_id AND project_id=r.project_id AND run_id=r.id AND execution_version=1 AND input_revision=r.input_revision AND input_hash=r.input_hash AND kind=registration_kind;
  ELSIF r.artifact_id IS NULL THEN RETURN NULL;
  END IF;
  IF phase='final' AND (r.state NOT IN ('succeeded','test_completed') OR j.state<>r.state OR r.artifact_version IS NULL
    OR j.lease_token IS NOT NULL OR j.lease_until IS NOT NULL) THEN
    RAISE EXCEPTION 'completed user delivery required' USING ERRCODE='23514',CONSTRAINT='bb_execution_delivery_terminal';
  END IF;
  -- The complete explicit worker stamp chooses V2. A head alone never supplies
  -- a default, and neither a V1 artifact nor a legacy input may complete V2.
  IF EXISTS(SELECT 1 FROM bb_run_execution_heads h WHERE h.owner_user_id=r.owner_user_id
    AND h.project_id=r.project_id AND h.run_id=r.id AND h.execution_version=2) THEN
    SELECT version.* INTO e FROM bb_run_execution_versions version
      WHERE version.owner_user_id=r.owner_user_id AND version.project_id=r.project_id AND version.run_id=r.id
        AND version.execution_version=2 AND j.checkpoint->'stage_execution'=jsonb_build_object(
          'execution_version',version.execution_version,'input_revision',version.input_revision,'input_hash',trim(version.input_hash));
    IF e.run_id IS NULL THEN RAISE EXCEPTION 'successor delivery requires its complete explicit stage execution'
      USING ERRCODE='23514',CONSTRAINT='bb_execution_delivery_exact';END IF;
    PERFORM bb_assert_test_successor_execution_active(e.owner_user_id,e.project_id,e.run_id,e.execution_version,e.input_revision,e.input_hash);
    IF phase<>'final' OR origin<>'terminal_transition' OR r.state<>'test_completed' OR j.state<>'test_completed' THEN
      RAISE EXCEPTION 'successor delivery is internal test completion only'
        USING ERRCODE='23514',CONSTRAINT='bb_execution_delivery_exact';END IF;
  ELSE
    SELECT * INTO STRICT e FROM bb_run_execution_versions
      WHERE owner_user_id=r.owner_user_id AND project_id=r.project_id AND run_id=r.id AND execution_version=1;
    IF e.input_revision<>r.input_revision OR e.input_hash<>r.input_hash
      OR (SELECT count(*) FROM bb_run_execution_versions WHERE run_id=r.id)<>1 THEN
      RAISE EXCEPTION 'delivery execution does not match its fixed input' USING ERRCODE='23514',CONSTRAINT='bb_execution_delivery_exact';
    END IF;
  END IF;
  d.owner_user_id:=r.owner_user_id; d.project_id:=r.project_id; d.run_id:=r.id;
  d.execution_version:=e.execution_version; d.input_revision:=e.input_revision; d.input_hash:=e.input_hash;
  d.delivery_phase:=phase; d.terminal_state:=CASE WHEN phase='final' THEN r.state END;
  d.channel:=r.channel;
  IF e.execution_version=2 THEN
    SELECT test_grant_id INTO STRICT d.test_grant_id FROM bb_run_test_successor_authorizations
      WHERE owner_user_id=e.owner_user_id AND project_id=e.project_id AND run_id=e.run_id
        AND execution_version=e.execution_version AND input_revision=e.input_revision AND input_hash=e.input_hash;
  ELSE d.test_grant_id:=r.test_grant_id; END IF;
  -- The first capture's source is historical fact. Replays preserve it.
  SELECT source INTO d.source FROM bb_run_execution_deliveries WHERE run_id=r.id AND execution_version=e.execution_version AND delivery_phase=phase;
  d.source:=COALESCE(d.source,origin); origin:=d.source;
  d.primary_artifact_id:=r.artifact_id; d.primary_artifact_version:=r.artifact_version;
  IF phase='m4_durable' THEN
    SELECT max(created_at) INTO d.delivered_at FROM bb_m4_artifact_execution_versions WHERE owner_user_id=r.owner_user_id AND project_id=r.project_id AND run_id=r.id AND execution_version=1 AND input_revision=r.input_revision AND input_hash=r.input_hash;
    d.event_cursor:=NULL;
  ELSIF origin='legacy_backfill' THEN
    SELECT * INTO STRICT terminal_event FROM bb_run_events
      WHERE owner_user_id=r.owner_user_id AND run_id=r.id AND state=r.state AND type='run.state_changed'
        AND seq<=r.event_cursor ORDER BY seq DESC LIMIT 1;
    IF EXISTS(SELECT 1 FROM bb_run_events WHERE run_id=r.id AND seq>terminal_event.seq AND state<>r.state) THEN
      RAISE EXCEPTION 'ambiguous historical terminal event' USING ERRCODE='23514',CONSTRAINT='bb_execution_delivery_history';
    END IF;
    d.delivered_at:=terminal_event.occurred_at; d.event_cursor:=terminal_event.seq;
  ELSE
    -- The event INSERT follows the run UPDATE. Do not query a future event.
    d.delivered_at:=r.updated_at; d.event_cursor:=r.event_cursor;
  END IF;
  SELECT manifest INTO STRICT d.naming_manifest FROM bb_input_revisions
    WHERE owner_user_id=r.owner_user_id AND project_id=r.project_id AND revision=e.input_revision AND input_hash=e.input_hash;
  SELECT s.version INTO review_version FROM bb_review_execution_snapshots s
    WHERE s.owner_user_id=e.owner_user_id AND s.project_id=e.project_id AND s.run_id=e.run_id
      AND s.execution_version=e.execution_version AND s.input_revision=e.input_revision AND s.input_hash=e.input_hash;
  SELECT s.manifest INTO m4_manifest FROM bb_m4_execution_snapshots s
    WHERE s.owner_user_id=e.owner_user_id AND s.project_id=e.project_id AND s.run_id=e.run_id
      AND s.execution_version=e.execution_version AND s.input_revision=e.input_revision AND s.input_hash=e.input_hash;
  IF (EXISTS(SELECT 1 FROM bb_review_executions WHERE run_id=r.id) AND review_version IS NULL)
    OR (EXISTS(SELECT 1 FROM bb_m4_executions WHERE run_id=r.id) AND m4_manifest IS NULL) THEN
    RAISE EXCEPTION 'delivery business snapshot is missing' USING ERRCODE='23514',CONSTRAINT='bb_execution_delivery_exact';
  END IF;
  -- M4 typed capture requires the complete exact registry even when the run's
  -- primary alone would be a valid generic artifact. Do not publish a partial
  -- Word pair or treat a QA subtype/snapshot as document registration fallback.
  IF j.subtype IN ('m4_document_v1','m4_qa_v1') OR m4_manifest IS NOT NULL THEN
    registration_kind:=CASE
      WHEN j.subtype='m4_document_v1' AND r.task_kind='generation'
        AND m4_manifest->>'version'='m4-document-input-v1' AND m4_manifest->>'kind'='document' THEN 'document'
      WHEN j.subtype='m4_qa_v1' AND r.task_kind='qa' AND r.channel='production'
        AND m4_manifest->>'version'='m4-qa-input-v1' AND m4_manifest->>'kind'='qa' THEN 'qa_text'
      ELSE NULL END;
    IF registration_kind IS NULL THEN
      RAISE EXCEPTION 'M4 delivery requires its exact document or QA business type'
        USING ERRCODE='23514',CONSTRAINT='bb_execution_delivery_exact';
    END IF;
    SELECT count(*) INTO registration_count FROM bb_m4_artifact_execution_versions q
      WHERE q.owner_user_id=e.owner_user_id AND q.project_id=e.project_id AND q.run_id=e.run_id
        AND q.execution_version=e.execution_version AND q.input_revision=e.input_revision AND q.input_hash=e.input_hash;
    IF registration_count<>(CASE WHEN registration_kind='qa_text' THEN 1 ELSE 2 END)
      OR NOT EXISTS(SELECT 1 FROM bb_m4_artifact_execution_versions q
        WHERE q.owner_user_id=e.owner_user_id AND q.project_id=e.project_id AND q.run_id=e.run_id
          AND q.execution_version=e.execution_version AND q.input_revision=e.input_revision AND q.input_hash=e.input_hash
          AND q.kind=registration_kind AND q.artifact_id=r.artifact_id AND q.artifact_version=r.artifact_version)
      OR (registration_kind='document' AND NOT EXISTS(SELECT 1 FROM bb_m4_artifact_execution_versions q
        WHERE q.owner_user_id=e.owner_user_id AND q.project_id=e.project_id AND q.run_id=e.run_id
          AND q.execution_version=e.execution_version AND q.input_revision=e.input_revision AND q.input_hash=e.input_hash
          AND q.kind='preparation_note')) THEN
      RAISE EXCEPTION 'M4 delivery requires its complete exact registered output and primary'
        USING ERRCODE='23514',CONSTRAINT='bb_execution_delivery_member';
    END IF;
  END IF;
  d.naming_review_version:=review_version; d.naming_m4_manifest:=m4_manifest;
  pair:=CASE WHEN phase='final' THEN j.checkpoint#>'{stages,word_delivery_pair}' END;
  IF pair='null'::jsonb THEN pair:=NULL; END IF;
  refs:=jsonb_build_array(jsonb_build_object('artifact_id',r.artifact_id,'artifact_version',r.artifact_version,'role','primary'));
  IF pair IS NOT NULL THEN
    IF jsonb_typeof(pair)<>'object' OR jsonb_typeof(pair->'revision_artifact_id') IS DISTINCT FROM 'string'
      OR jsonb_typeof(pair->'clean_artifact_id') IS DISTINCT FROM 'string' OR pair->>'revision_artifact_id'<>r.artifact_id THEN
      RAISE EXCEPTION 'delivery pair does not name its primary' USING ERRCODE='23514',CONSTRAINT='bb_execution_delivery_pair';
    END IF;
    FOREACH role_name IN ARRAY ARRAY['revision','clean','baseline'] LOOP
      IF pair ? (role_name||'_artifact_id') THEN
        IF jsonb_typeof(pair->(role_name||'_artifact_id'))<>'string' THEN
          RAISE EXCEPTION 'invalid delivery pair member' USING ERRCODE='23514',CONSTRAINT='bb_execution_delivery_pair';
        END IF;
        refs:=refs||jsonb_build_array(jsonb_build_object('artifact_id',pair->>(role_name||'_artifact_id'),
          'artifact_version',CASE WHEN role_name='revision' THEN to_jsonb(r.artifact_version) ELSE pair->(role_name||'_artifact_version') END,
          'role',role_name));
      END IF;
    END LOOP;
  END IF;
  -- Registries are explicit output selections, unlike the run's pool of
  -- candidates. Only ready, precisely versioned registrations are added.
  SELECT refs||COALESCE(jsonb_agg(x.ref),'[]'::jsonb) INTO refs FROM (
    SELECT jsonb_build_object('artifact_id',v.id,'artifact_version',v.version,'role',q.kind) AS ref
    FROM bb_review_execution_artifacts q JOIN bb_artifact_versions v ON v.owner_user_id=q.owner_user_id AND v.run_id=q.run_id AND v.id=q.artifact_id AND v.version=q.artifact_version
    WHERE phase='final' AND q.owner_user_id=e.owner_user_id AND q.project_id=e.project_id AND q.run_id=e.run_id
      AND q.execution_version=e.execution_version AND q.input_revision=e.input_revision AND q.input_hash=e.input_hash
      AND bb_execution_delivery_artifact_ready(v,r.channel,d.delivered_at)
    UNION ALL
    SELECT jsonb_build_object('artifact_id',v.id,'artifact_version',v.version,'role',q.kind)
    FROM bb_m4_artifact_execution_versions q JOIN bb_artifact_versions v ON v.owner_user_id=q.owner_user_id AND v.run_id=q.run_id AND v.id=q.artifact_id AND v.version=q.artifact_version
    -- Every M4 registration is mandatory. Let the exact member loop reject an
    -- unavailable note instead of silently publishing only its ready document.
    WHERE q.owner_user_id=e.owner_user_id AND q.project_id=e.project_id AND q.run_id=e.run_id AND q.execution_version=e.execution_version AND q.input_revision=e.input_revision AND q.input_hash=e.input_hash
    UNION ALL
    SELECT jsonb_build_object('artifact_id',v.id,'artifact_version',v.version,'role',q.kind)
    FROM bb_integrity_artifacts q JOIN bb_artifact_versions v ON v.owner_user_id=q.owner_user_id AND v.run_id=q.run_id AND v.id=q.artifact_id AND v.version=q.artifact_version
    WHERE phase='final' AND q.owner_user_id=r.owner_user_id AND q.run_id=r.id AND bb_execution_delivery_artifact_ready(v,r.channel,d.delivered_at)
  ) x;
  FOR item IN SELECT value FROM jsonb_array_elements(refs) LOOP
    member_role:=item->>'role'; member_version:=NULL;
    IF item->'artifact_version' IS NOT NULL AND item->'artifact_version'<>'null'::jsonb THEN
      IF jsonb_typeof(item->'artifact_version')<>'number' OR (item->>'artifact_version') !~ '^[1-9][0-9]*$' THEN
        RAISE EXCEPTION 'invalid delivery artifact version' USING ERRCODE='23514',CONSTRAINT='bb_execution_delivery_pair';
      END IF;
      member_version:=(item->>'artifact_version')::integer;
    END IF;
    SELECT count(*),min(v.version) INTO matches,member_version
    -- PostgreSQL gives a view its own composite type. Pass a real base-table
    -- row to the readiness helper while retaining the exact provenance gate.
    FROM bb_artifact_versions v
    JOIN bb_execution_artifact_versions verified_origin ON verified_origin.owner_user_id=v.owner_user_id AND verified_origin.run_id=v.run_id
      AND verified_origin.id=v.id AND verified_origin.version=v.version AND verified_origin.sha256=v.sha256 AND verified_origin.created_at=v.created_at
    JOIN bb_artifact_execution_bindings b ON b.artifact_id=v.id AND b.artifact_version=v.version
    WHERE v.owner_user_id=e.owner_user_id AND v.run_id=e.run_id AND v.id=item->>'artifact_id'
      AND (member_version IS NULL OR v.version=member_version)
      AND b.project_id=e.project_id AND b.execution_version=e.execution_version AND b.input_revision=e.input_revision AND b.input_hash=e.input_hash
      AND bb_execution_delivery_artifact_ready(v,r.channel,d.delivered_at);
    IF matches<>1 THEN
      RAISE EXCEPTION 'delivery member requires one exact verified artifact version' USING ERRCODE='23514',CONSTRAINT='bb_execution_delivery_member';
    END IF;
    SELECT * INTO STRICT a FROM bb_artifact_versions WHERE owner_user_id=r.owner_user_id AND run_id=r.id AND id=item->>'artifact_id' AND version=member_version FOR SHARE;
    IF pair IS NOT NULL AND member_role IN ('revision','clean','baseline') THEN
      IF pair ? (member_role||'_artifact_version') AND pair->(member_role||'_artifact_version') IS DISTINCT FROM to_jsonb(member_version) THEN
        RAISE EXCEPTION 'delivery pair version differs from exact member' USING ERRCODE='23514',CONSTRAINT='bb_execution_delivery_pair';
      END IF;
      pair:=pair||jsonb_build_object(member_role||'_artifact_version',member_version);
    END IF;
    SELECT value INTO existing FROM jsonb_array_elements(members)
      WHERE value->>'artifact_id'=a.id AND (value->>'artifact_version')::integer=a.version;
    IF existing IS NOT NULL THEN
      IF member_role='primary' OR existing->>'role'=member_role THEN CONTINUE; END IF;
      IF existing->>'role'<>'primary' THEN
        RAISE EXCEPTION 'one delivered file has conflicting roles' USING ERRCODE='23514',CONSTRAINT='bb_execution_delivery_member';
      END IF;
      SELECT COALESCE(jsonb_agg(value),'[]'::jsonb) INTO members FROM jsonb_array_elements(members)
        WHERE NOT(value->>'artifact_id'=a.id AND (value->>'artifact_version')::integer=a.version);
    END IF;
    member:=jsonb_build_object('artifact_id',a.id,'artifact_version',a.version,'artifact_sha256',a.sha256,
      'role',member_role,'is_primary',a.id=r.artifact_id AND a.version=r.artifact_version,
      'naming_created_at',to_char(a.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'naming_integrity_kind',(SELECT kind FROM bb_integrity_artifacts WHERE owner_user_id=r.owner_user_id AND run_id=r.id AND artifact_id=a.id AND artifact_version=a.version),
      'naming_review_kind',(SELECT kind FROM bb_review_execution_artifacts WHERE owner_user_id=e.owner_user_id AND project_id=e.project_id AND run_id=e.run_id AND execution_version=e.execution_version AND input_revision=e.input_revision AND input_hash=e.input_hash AND artifact_id=a.id AND artifact_version=a.version),
      'naming_m4_kind',(SELECT kind FROM bb_m4_artifact_execution_versions WHERE owner_user_id=e.owner_user_id AND project_id=e.project_id AND run_id=e.run_id AND execution_version=e.execution_version AND input_revision=e.input_revision AND input_hash=e.input_hash AND artifact_id=a.id AND artifact_version=a.version),
      'naming_m4_revision',(SELECT revision_number FROM bb_m4_artifact_execution_versions WHERE owner_user_id=e.owner_user_id AND project_id=e.project_id AND run_id=e.run_id AND execution_version=e.execution_version AND input_revision=e.input_revision AND input_hash=e.input_hash AND artifact_id=a.id AND artifact_version=a.version),
      'naming_m4_type',(SELECT document_type FROM bb_m4_artifact_execution_versions WHERE owner_user_id=e.owner_user_id AND project_id=e.project_id AND run_id=e.run_id AND execution_version=e.execution_version AND input_revision=e.input_revision AND input_hash=e.input_hash AND artifact_id=a.id AND artifact_version=a.version));
    members:=members||jsonb_build_array(member);
    IF a.id=r.artifact_id AND a.version=r.artifact_version THEN d.primary_sha256:=a.sha256; END IF;
  END LOOP;
  SELECT jsonb_agg(value ORDER BY value->>'artifact_id',(value->>'artifact_version')::integer) INTO d.artifact_manifest FROM jsonb_array_elements(members);
  d.word_delivery_pair:=pair;
  RETURN to_jsonb(d);
END; $$;
