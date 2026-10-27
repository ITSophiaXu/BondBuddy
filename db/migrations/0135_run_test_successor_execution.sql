-- Internal test-only successor acceptance, not production supplement pricing.
-- Sources: 0119/0132 execution authority; 0124 canonical business snapshots;
-- 0133 material purge coordination. The complete V2 working/artifact/registration/
-- delivery protocol is deliberately NOT opened here. A legacy artifact INSERT
-- must fail after activation instead of being mislabeled V1.
-- Existing run/job origin, channel, grant, request, quotation and reservation
-- guards remain installed. No provider, credit, cleanup or legacy mirror change.
-- Rolling writers use several valid scope-lock orders. A busy deployment must
-- fail and retry after drain instead of waiting with only part of this set held.
LOCK TABLE bb_input_revisions IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE bb_runs IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE bb_jobs IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE bb_run_execution_versions IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE bb_run_execution_heads IN SHARE ROW EXCLUSIVE MODE NOWAIT;

CREATE TABLE bb_run_test_successor_authorizations (
  id text PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 128),
  owner_user_id text NOT NULL,project_id text NOT NULL,run_id text NOT NULL,job_id text NOT NULL,
  source_execution_version integer NOT NULL CHECK(source_execution_version=1),
  source_input_revision integer NOT NULL CHECK(source_input_revision>0),
  source_input_hash char(64) NOT NULL CHECK(source_input_hash ~ '^[a-f0-9]{64}$'),
  supplement_revision integer NOT NULL CHECK(supplement_revision>0),
  processing_plan_id text NOT NULL,
  request_id text NOT NULL CHECK(length(request_id) BETWEEN 1 AND 128),
  request_hash char(64) NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  execution_version integer NOT NULL CHECK(execution_version=2),
  input_revision integer NOT NULL CHECK(input_revision>0 AND input_revision<>source_input_revision),
  input_hash char(64) NOT NULL CHECK(input_hash ~ '^[a-f0-9]{64}$'),
  test_grant_id text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now() CHECK(isfinite(created_at)),
  UNIQUE(owner_user_id,run_id,request_id),
  UNIQUE(run_id,execution_version),
  UNIQUE(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash),
  FOREIGN KEY(owner_user_id,project_id,run_id) REFERENCES bb_runs(owner_user_id,project_id,id),
  FOREIGN KEY(owner_user_id,job_id,run_id) REFERENCES bb_jobs(owner_user_id,id,run_id),
  FOREIGN KEY(owner_user_id,project_id,run_id,processing_plan_id)
    REFERENCES bb_run_supplement_processing_plans(owner_user_id,project_id,run_id,id),
  FOREIGN KEY(owner_user_id,project_id,run_id,supplement_revision)
    REFERENCES bb_run_supplement_saved_work(owner_user_id,project_id,run_id,supplement_revision),
  FOREIGN KEY(owner_user_id,project_id,run_id,source_execution_version,source_input_revision,source_input_hash)
    REFERENCES bb_run_execution_versions(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash),
  FOREIGN KEY(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash)
    REFERENCES bb_run_execution_versions(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(test_grant_id,owner_user_id,project_id,input_revision,input_hash)
    REFERENCES bb_non_production_test_grants(grant_id,user_id,project_id,input_revision,input_hash)
);

CREATE FUNCTION bb_check_test_successor_authorization() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r bb_runs%ROWTYPE;j bb_jobs%ROWTYPE;p bb_run_supplement_processing_plans%ROWTYPE;
  w bb_run_supplement_saved_work%ROWTYPE;d bb_run_supplement_drafts%ROWTYPE;g bb_non_production_test_grants%ROWTYPE;
  target_input bb_input_revisions%ROWTYPE;source_project bb_projects%ROWTYPE;material bb_material_versions%ROWTYPE;
  planned_pins jsonb;candidate_pins jsonb;planned_refs jsonb;candidate_refs jsonb;staged_refs jsonb;
  project_to_lock text;pin_to_lock jsonb;key_to_lock bigint;
BEGIN
  -- Same project -> run -> job ordering as the service. No Blob IO in SQL.
  PERFORM 1 FROM bb_projects project JOIN bb_users u ON u.id=project.owner_user_id
    WHERE project.owner_user_id=NEW.owner_user_id AND project.id=NEW.project_id
      AND project.deleted_at IS NULL AND project.archived_at IS NULL AND u.closed_at IS NULL AND u.status<>'closed'
    FOR UPDATE OF project;
  IF NOT FOUND THEN RAISE EXCEPTION 'test successor requires a live owned project'
    USING ERRCODE='23514',CONSTRAINT='bb_test_successor_authorization_origin';END IF;
  SELECT * INTO r FROM bb_runs WHERE owner_user_id=NEW.owner_user_id AND project_id=NEW.project_id AND id=NEW.run_id FOR UPDATE;
  SELECT * INTO j FROM bb_jobs WHERE owner_user_id=NEW.owner_user_id AND run_id=NEW.run_id AND id=NEW.job_id FOR UPDATE;
  SELECT * INTO p FROM bb_run_supplement_processing_plans WHERE owner_user_id=NEW.owner_user_id AND project_id=NEW.project_id
    AND run_id=NEW.run_id AND id=NEW.processing_plan_id;
  SELECT * INTO w FROM bb_run_supplement_saved_work WHERE owner_user_id=NEW.owner_user_id AND project_id=NEW.project_id
    AND run_id=NEW.run_id AND supplement_revision=NEW.supplement_revision;
  SELECT * INTO d FROM bb_run_supplement_drafts WHERE owner_user_id=NEW.owner_user_id AND project_id=NEW.project_id
    AND run_id=NEW.run_id AND revision=NEW.supplement_revision;
  -- FOR SHARE conflicts with the one permitted grant revocation. Read current
  -- values after the wait instead of using a pre-wait STABLE query snapshot.
  SELECT * INTO g FROM bb_non_production_test_grants WHERE grant_id=NEW.test_grant_id FOR SHARE;
  IF r.id IS NULL OR j.id IS NULL OR p.id IS NULL OR w.run_id IS NULL OR d.run_id IS NULL OR g.grant_id IS NULL
    OR r.channel<>'non_production_test' OR j.channel<>'non_production_test'
    OR r.billing_mode NOT IN ('platform_trial','non_billable_test') OR r.reservation_id IS NOT NULL
    OR EXISTS(SELECT 1 FROM bb_credit_reservations c WHERE c.owner_user_id=NEW.owner_user_id AND c.run_id=NEW.run_id)
    OR EXISTS(SELECT 1 FROM bb_m4_metering m WHERE m.owner_user_id=NEW.owner_user_id AND m.run_id=NEW.run_id)
    OR EXISTS(SELECT 1 FROM bb_authoring_progress a WHERE a.owner_user_id=NEW.owner_user_id AND a.run_id=NEW.run_id AND a.accrued_points<>0)
    OR r.state<>'paused' OR j.state<>'paused' OR NOT j.user_pause_requested
    OR j.lease_token IS NOT NULL OR j.lease_until IS NOT NULL
    OR r.input_revision<>NEW.source_input_revision OR r.input_hash<>NEW.source_input_hash
    OR p.job_id<>NEW.job_id OR p.supplement_revision<>NEW.supplement_revision
    OR p.execution_version<>NEW.source_execution_version OR p.input_revision<>NEW.source_input_revision OR p.input_hash<>NEW.source_input_hash
    OR p.candidate_input_hash<>NEW.input_hash
    OR p.body->>'candidateInputHash' IS DISTINCT FROM trim(NEW.input_hash)
    OR p.body->>'checkpointHash' IS DISTINCT FROM trim(p.checkpoint_hash)
    OR p.body->>'basisHash' IS DISTINCT FROM trim(p.basis_hash)
    OR w.job_id<>NEW.job_id OR w.execution_version<>NEW.source_execution_version
    OR w.input_revision<>NEW.source_input_revision OR w.input_hash<>NEW.source_input_hash
    OR w.checkpoint_hash<>p.checkpoint_hash OR w.source_checkpoint IS DISTINCT FROM j.checkpoint
    OR d.request_id<>p.receipt_request_id OR d.request_hash<>p.receipt_request_hash
    OR d.base_input_revision<>NEW.source_input_revision OR d.base_input_hash<>NEW.source_input_hash
    OR EXISTS(SELECT 1 FROM bb_model_call_attempts a WHERE a.job_id=NEW.job_id AND a.status='pending_reconcile')
    OR g.user_id<>NEW.owner_user_id OR g.project_id<>NEW.project_id OR g.input_revision<>NEW.input_revision OR g.input_hash<>NEW.input_hash
    OR g.revoked_at IS NOT NULL OR g.expires_at<=clock_timestamp() OR g.created_at<p.created_at
    OR EXISTS(SELECT 1 FROM bb_runs old_run WHERE old_run.test_grant_id=NEW.test_grant_id)
    OR EXISTS(SELECT 1 FROM bb_jobs old_job WHERE old_job.test_grant_id=NEW.test_grant_id)
    OR NEW.created_at IS DISTINCT FROM transaction_timestamp()
    OR NOT EXISTS(SELECT 1 FROM bb_input_revisions i WHERE i.owner_user_id=NEW.owner_user_id AND i.project_id=NEW.project_id
      AND i.revision=NEW.input_revision AND i.input_hash=NEW.input_hash)
    OR NOT EXISTS(SELECT 1 FROM bb_run_execution_heads h WHERE h.owner_user_id=NEW.owner_user_id AND h.project_id=NEW.project_id
      AND h.run_id=NEW.run_id AND h.execution_version=NEW.source_execution_version
      AND h.input_revision=NEW.source_input_revision AND h.input_hash=NEW.source_input_hash)
    OR (SELECT count(*) FROM bb_run_execution_versions e WHERE e.owner_user_id=NEW.owner_user_id AND e.project_id=NEW.project_id AND e.run_id=NEW.run_id)<>1
  THEN RAISE EXCEPTION 'test successor requires the exact safe plan, original V1 and fresh target grant; paid adoption is closed'
    USING ERRCODE='23514',CONSTRAINT='bb_test_successor_authorization_origin';END IF;

  -- Bind the complete immutable candidate pin set, including M4's separate
  -- source/template references. Plan roles are checked against the locked rows
  -- below; M4 manifest pins intentionally carry no role of their own.
  SELECT * INTO target_input FROM bb_input_revisions WHERE owner_user_id=NEW.owner_user_id
    AND project_id=NEW.project_id AND revision=NEW.input_revision AND input_hash=NEW.input_hash;
  SELECT COALESCE(jsonb_agg(CASE WHEN p.kind='authoring'
    THEN pin||jsonb_build_object('source_project_id',NEW.project_id) ELSE pin END),'[]'::jsonb)
    INTO planned_pins FROM jsonb_array_elements(p.body->'materials') refs(pin);
  candidate_pins=CASE WHEN p.kind='m4' THEN target_input.manifest->'input'->'materials'
    ELSE target_input.manifest->'materials' END;
  IF jsonb_typeof(candidate_pins) IS DISTINCT FROM 'array'
    OR jsonb_typeof(target_input.material_versions) IS DISTINCT FROM 'array'
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(planned_pins) refs(pin)
      WHERE (pin->>'material_version')::numeric>2147483647) THEN
    RAISE EXCEPTION 'test successor requires the complete exact live candidate material set'
      USING ERRCODE='23514',CONSTRAINT='bb_test_successor_materials_available';END IF;
  IF p.kind='m4' THEN
    candidate_pins=candidate_pins
      ||CASE WHEN jsonb_typeof(target_input.manifest->'input'->'source_material')='object'
        THEN jsonb_build_array(target_input.manifest->'input'->'source_material') ELSE '[]'::jsonb END
      ||CASE WHEN jsonb_typeof(target_input.manifest->'template_material')='object'
        THEN jsonb_build_array(target_input.manifest->'template_material') ELSE '[]'::jsonb END;
  END IF;
  SELECT COALESCE(jsonb_agg(CASE WHEN p.kind='m4' THEN pin-'role' ELSE pin END),'[]'::jsonb)
    INTO planned_refs FROM jsonb_array_elements(planned_pins) refs(pin);
  SELECT COALESCE(jsonb_agg(CASE WHEN p.kind='m4' THEN pin
    ELSE pin||jsonb_build_object('source_project_id',NEW.project_id) END),'[]'::jsonb)
    INTO candidate_refs FROM jsonb_array_elements(candidate_pins) refs(pin);
  SELECT COALESCE(jsonb_agg(CASE WHEN p.kind='m4' THEN pin
    ELSE pin||jsonb_build_object('source_project_id',NEW.project_id) END),'[]'::jsonb)
    INTO staged_refs FROM jsonb_array_elements(target_input.material_versions) refs(pin);
  IF NOT (planned_refs @> candidate_refs AND candidate_refs @> planned_refs
    AND staged_refs @> candidate_refs AND candidate_refs @> staged_refs) THEN
    RAISE EXCEPTION 'test successor requires the complete exact live candidate material set'
      USING ERRCODE='23514',CONSTRAINT='bb_test_successor_materials_available';END IF;

  IF current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'material lifecycle coordination requires READ COMMITTED isolation'
      USING ERRCODE='23514',CONSTRAINT='bb_material_lifecycle_isolation';END IF;
  -- Obtain the ENTIRE input/plan advisory set before any source-row lock. The
  -- legacy helper also covers speculative local M4 keys, so retain that union.
  FOR key_to_lock IN SELECT DISTINCT lifecycle_key FROM (
    SELECT lifecycle_key FROM bb_material_lifecycle_input_keys(NEW.owner_user_id,NEW.project_id,NEW.input_revision)
    UNION ALL SELECT bb_material_lifecycle_lock_key(NEW.owner_user_id,pin->>'source_project_id',
      pin->>'material_id',(pin->>'material_version')::integer)
      FROM jsonb_array_elements(planned_pins) refs(pin)
  ) lifecycle_keys ORDER BY lifecycle_key LOOP
    PERFORM pg_advisory_xact_lock(key_to_lock);
  END LOOP;
  PERFORM bb_assert_material_lifecycle_available(NEW.owner_user_id,NEW.project_id,NEW.input_revision);

  -- Do not filter deleted rows before locking: the post-lock check must see the
  -- current committed state. Shared locks retain live source rows through commit.
  -- NOWAIT prevents target -> source cycles and advisory/row lock-order cycles.
  FOR project_to_lock IN SELECT DISTINCT pin->>'source_project_id'
    FROM jsonb_array_elements(planned_pins) refs(pin) ORDER BY 1 LOOP
    SELECT * INTO source_project FROM bb_projects WHERE owner_user_id=NEW.owner_user_id
      AND id=project_to_lock FOR SHARE NOWAIT;
    IF source_project.id IS NULL OR source_project.deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'test successor candidate source project is unavailable'
        USING ERRCODE='23514',CONSTRAINT='bb_test_successor_materials_available';END IF;
  END LOOP;
  FOR pin_to_lock IN SELECT pin FROM jsonb_array_elements(planned_pins) refs(pin)
    ORDER BY pin->>'source_project_id',pin->>'material_id',(pin->>'material_version')::integer LOOP
    SELECT * INTO material FROM bb_material_versions WHERE owner_user_id=NEW.owner_user_id
      AND project_id=pin_to_lock->>'source_project_id' AND id=pin_to_lock->>'material_id'
      AND version=(pin_to_lock->>'material_version')::integer FOR SHARE NOWAIT;
    IF material.id IS NULL OR material.deleted_at IS NOT NULL
      OR trim(material.sha256) IS DISTINCT FROM pin_to_lock->>'sha256'
      OR material.role IS DISTINCT FROM pin_to_lock->>'role' THEN
      RAISE EXCEPTION 'test successor candidate material identity or availability changed'
        USING ERRCODE='23514',CONSTRAINT='bb_test_successor_materials_available';END IF;
  END LOOP;
  RETURN NEW;
END;$$;
CREATE TRIGGER bb_test_successor_authorization_exact BEFORE INSERT ON bb_run_test_successor_authorizations
  FOR EACH ROW EXECUTE FUNCTION bb_check_test_successor_authorization();
CREATE TRIGGER bb_test_successor_authorization_immutable BEFORE UPDATE OR DELETE ON bb_run_test_successor_authorizations
  FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();

-- Every existing V1 identity remains immutable. No V3 or production successor.
ALTER TABLE bb_run_execution_versions DROP CONSTRAINT bb_run_execution_versions_execution_version_check;
ALTER TABLE bb_run_execution_versions ADD CONSTRAINT bb_run_execution_versions_execution_version_check CHECK(execution_version IN (1,2));
ALTER TABLE bb_run_execution_heads DROP CONSTRAINT bb_run_execution_heads_execution_version_check;
ALTER TABLE bb_run_execution_heads ADD CONSTRAINT bb_run_execution_heads_execution_version_check CHECK(execution_version IN (1,2));

CREATE OR REPLACE FUNCTION bb_check_initial_execution() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.execution_version=1 THEN
    IF NOT EXISTS(SELECT 1 FROM bb_runs r WHERE r.id=NEW.run_id AND r.owner_user_id=NEW.owner_user_id AND r.project_id=NEW.project_id
      AND r.input_revision=NEW.input_revision AND r.input_hash=NEW.input_hash) THEN
      RAISE EXCEPTION 'initial execution must match the original run input'
        USING ERRCODE='23514',CONSTRAINT='bb_initial_execution_origin';END IF;
  ELSIF NEW.execution_version=2 THEN
    IF NOT EXISTS(SELECT 1 FROM bb_run_test_successor_authorizations a JOIN bb_runs r
      ON r.owner_user_id=a.owner_user_id AND r.project_id=a.project_id AND r.id=a.run_id
      WHERE a.owner_user_id=NEW.owner_user_id AND a.project_id=NEW.project_id AND a.run_id=NEW.run_id
        AND a.execution_version=NEW.execution_version AND a.input_revision=NEW.input_revision AND a.input_hash=NEW.input_hash
        AND a.created_at=NEW.created_at AND r.channel='non_production_test' AND r.state='paused') THEN
      RAISE EXCEPTION 'second execution requires its exact test-only authorization'
        USING ERRCODE='23514',CONSTRAINT='bb_test_successor_execution_origin';END IF;
  ELSE RAISE EXCEPTION 'unsupported successor execution'
    USING ERRCODE='23514',CONSTRAINT='bb_test_successor_execution_origin';END IF;
  RETURN NEW;
END;$$;

-- 0132 initialized every inserted version. V2 instead uses an explicit CAS.
CREATE OR REPLACE FUNCTION bb_create_initial_execution_head() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.execution_version=1 THEN
    INSERT INTO bb_run_execution_heads(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash,activated_at)
      VALUES(NEW.owner_user_id,NEW.project_id,NEW.run_id,NEW.execution_version,NEW.input_revision,NEW.input_hash,NEW.created_at);
  END IF;
  RETURN NEW;
END;$$;

CREATE FUNCTION bb_guard_test_successor_head() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'execution head cannot be deleted'
    USING ERRCODE='23514',CONSTRAINT='bb_test_successor_head_transition';END IF;
  IF NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW;END IF;
  IF ROW(NEW.owner_user_id,NEW.project_id,NEW.run_id) IS DISTINCT FROM ROW(OLD.owner_user_id,OLD.project_id,OLD.run_id)
    OR OLD.execution_version<>1 OR NEW.execution_version<>2
    OR NOT EXISTS(SELECT 1 FROM bb_run_test_successor_authorizations a
      JOIN bb_runs r ON r.owner_user_id=a.owner_user_id AND r.project_id=a.project_id AND r.id=a.run_id
      JOIN bb_jobs j ON j.owner_user_id=a.owner_user_id AND j.run_id=a.run_id AND j.id=a.job_id
      JOIN bb_run_execution_versions e ON e.owner_user_id=a.owner_user_id AND e.project_id=a.project_id AND e.run_id=a.run_id
        AND e.execution_version=a.execution_version AND e.input_revision=a.input_revision AND e.input_hash=a.input_hash
      JOIN bb_non_production_test_grants g ON g.grant_id=a.test_grant_id AND g.user_id=a.owner_user_id AND g.project_id=a.project_id
        AND g.input_revision=a.input_revision AND g.input_hash=a.input_hash
      WHERE a.owner_user_id=NEW.owner_user_id AND a.project_id=NEW.project_id AND a.run_id=NEW.run_id
        AND a.source_execution_version=OLD.execution_version AND a.source_input_revision=OLD.input_revision AND a.source_input_hash=OLD.input_hash
        AND a.execution_version=NEW.execution_version AND a.input_revision=NEW.input_revision AND a.input_hash=NEW.input_hash
        AND a.created_at=NEW.activated_at AND r.channel='non_production_test' AND j.channel='non_production_test'
        AND r.state='paused' AND j.state='paused' AND j.user_pause_requested AND j.lease_token IS NULL AND j.lease_until IS NULL
        AND g.revoked_at IS NULL AND g.expires_at>clock_timestamp()) THEN
    RAISE EXCEPTION 'execution head requires an exact test-only V1 to V2 CAS'
      USING ERRCODE='23514',CONSTRAINT='bb_test_successor_head_transition';END IF;
  PERFORM bb_assert_material_lifecycle_available(NEW.owner_user_id,NEW.project_id,NEW.input_revision);
  RETURN NEW;
END;$$;
DROP TRIGGER bb_run_execution_head_immutable ON bb_run_execution_heads;
CREATE TRIGGER bb_run_execution_head_immutable BEFORE UPDATE OR DELETE ON bb_run_execution_heads
  FOR EACH ROW EXECUTE FUNCTION bb_guard_test_successor_head();

-- Deferred because acceptance inserts authority -> execution -> CAS -> canonical
-- business snapshot -> queued checkpoint in ONE transaction. No partial authority
-- or orphan V2 survives commit. Later worker transactions retain normal live gates.
CREATE FUNCTION bb_check_test_successor_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r bb_runs%ROWTYPE;j bb_jobs%ROWTYPE;p bb_run_supplement_processing_plans%ROWTYPE;w bb_run_supplement_saved_work%ROWTYPE;
BEGIN
  SELECT * INTO r FROM bb_runs WHERE owner_user_id=NEW.owner_user_id AND project_id=NEW.project_id AND id=NEW.run_id;
  SELECT * INTO j FROM bb_jobs WHERE owner_user_id=NEW.owner_user_id AND run_id=NEW.run_id AND id=NEW.job_id;
  SELECT * INTO p FROM bb_run_supplement_processing_plans WHERE owner_user_id=NEW.owner_user_id AND project_id=NEW.project_id
    AND run_id=NEW.run_id AND id=NEW.processing_plan_id;
  SELECT * INTO w FROM bb_run_supplement_saved_work WHERE owner_user_id=NEW.owner_user_id AND project_id=NEW.project_id
    AND run_id=NEW.run_id AND supplement_revision=NEW.supplement_revision;
  IF r.id IS NULL OR j.id IS NULL OR p.id IS NULL OR w.run_id IS NULL
    OR r.channel<>'non_production_test' OR j.channel<>'non_production_test' OR r.state<>'queued' OR j.state<>'queued'
    OR j.user_pause_requested OR j.lease_token IS NOT NULL OR j.lease_until IS NOT NULL
    OR r.input_revision<>NEW.source_input_revision OR r.input_hash<>NEW.source_input_hash
    OR r.reservation_id IS NOT NULL OR r.billing_mode NOT IN ('platform_trial','non_billable_test')
    OR EXISTS(SELECT 1 FROM bb_credit_reservations c WHERE c.owner_user_id=NEW.owner_user_id AND c.run_id=NEW.run_id)
    OR EXISTS(SELECT 1 FROM bb_m4_metering m WHERE m.owner_user_id=NEW.owner_user_id AND m.run_id=NEW.run_id)
    OR EXISTS(SELECT 1 FROM bb_authoring_progress a WHERE a.owner_user_id=NEW.owner_user_id AND a.run_id=NEW.run_id AND a.accrued_points<>0)
    OR j.checkpoint->'stages' IS DISTINCT FROM '{}'::jsonb
    OR j.checkpoint->'stage_execution' IS DISTINCT FROM jsonb_build_object('execution_version',NEW.execution_version,
      'input_revision',NEW.input_revision,'input_hash',trim(NEW.input_hash))
    OR COALESCE(j.checkpoint->'provider_results','[]'::jsonb) IS DISTINCT FROM COALESCE(w.source_checkpoint->'provider_results','[]'::jsonb)
    OR COALESCE(j.checkpoint->'operator_reconciliations','[]'::jsonb) IS DISTINCT FROM COALESCE(w.source_checkpoint->'operator_reconciliations','[]'::jsonb)
    OR NOT EXISTS(SELECT 1 FROM bb_run_execution_heads h JOIN bb_run_execution_versions e
      ON e.owner_user_id=h.owner_user_id AND e.project_id=h.project_id AND e.run_id=h.run_id
        AND e.execution_version=h.execution_version AND e.input_revision=h.input_revision AND e.input_hash=h.input_hash
      WHERE h.owner_user_id=NEW.owner_user_id AND h.project_id=NEW.project_id AND h.run_id=NEW.run_id
        AND h.execution_version=NEW.execution_version AND h.input_revision=NEW.input_revision AND h.input_hash=NEW.input_hash
        AND h.activated_at=NEW.created_at AND e.created_at=NEW.created_at)
    OR (SELECT count(*) FROM bb_run_execution_versions e WHERE e.run_id=NEW.run_id)<>2
    OR NOT EXISTS(SELECT 1 FROM bb_non_production_test_grants g WHERE g.grant_id=NEW.test_grant_id
      AND g.user_id=NEW.owner_user_id AND g.project_id=NEW.project_id AND g.input_revision=NEW.input_revision AND g.input_hash=NEW.input_hash
      AND g.revoked_at IS NULL AND g.expires_at>clock_timestamp())
    OR (p.kind='authoring' AND (EXISTS(SELECT 1 FROM bb_review_execution_snapshots s WHERE s.run_id=NEW.run_id AND s.execution_version=NEW.execution_version)
      OR EXISTS(SELECT 1 FROM bb_m4_execution_snapshots s WHERE s.run_id=NEW.run_id AND s.execution_version=NEW.execution_version)))
    OR (p.kind='review' AND (NOT EXISTS(SELECT 1 FROM bb_review_execution_snapshots s
      WHERE s.owner_user_id=NEW.owner_user_id AND s.project_id=NEW.project_id AND s.run_id=NEW.run_id
        AND s.execution_version=NEW.execution_version AND s.input_revision=NEW.input_revision AND s.input_hash=NEW.input_hash)
      OR EXISTS(SELECT 1 FROM bb_m4_execution_snapshots s WHERE s.run_id=NEW.run_id AND s.execution_version=NEW.execution_version)))
    OR (p.kind='m4' AND (NOT EXISTS(SELECT 1 FROM bb_m4_execution_snapshots s
      WHERE s.owner_user_id=NEW.owner_user_id AND s.project_id=NEW.project_id AND s.run_id=NEW.run_id
        AND s.execution_version=NEW.execution_version AND s.input_revision=NEW.input_revision AND s.input_hash=NEW.input_hash)
      OR EXISTS(SELECT 1 FROM bb_review_execution_snapshots s WHERE s.run_id=NEW.run_id AND s.execution_version=NEW.execution_version)))
  THEN RAISE EXCEPTION 'test successor acceptance must commit complete exact authority, snapshots and a fresh queued stage set'
    USING ERRCODE='23514',CONSTRAINT='bb_test_successor_complete';END IF;
  RETURN NEW;
END;$$;
CREATE CONSTRAINT TRIGGER bb_test_successor_complete AFTER INSERT ON bb_run_test_successor_authorizations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bb_check_test_successor_complete();

COMMENT ON TABLE bb_run_test_successor_authorizations IS
  'Immutable internal non-production V1 to V2 acceptance and fresh exact test grant. Does not authorize production adoption, pricing, charges, V2 artifacts or Word delivery.';

-- 0124 final review guard: retain every V1 comparison; V2 is canonical-only.
CREATE OR REPLACE FUNCTION bb_check_review_execution_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE manifest jsonb; task_kind text; materials jsonb; valid boolean;
BEGIN
  SELECT i.manifest,r.task_kind INTO STRICT manifest,task_kind
  FROM bb_run_execution_versions e
  JOIN bb_runs r ON r.owner_user_id=e.owner_user_id AND r.project_id=e.project_id AND r.id=e.run_id
  JOIN bb_input_revisions i ON i.owner_user_id=e.owner_user_id AND i.project_id=e.project_id
    AND i.revision=e.input_revision AND i.input_hash=e.input_hash
  LEFT JOIN bb_review_executions legacy ON legacy.owner_user_id=e.owner_user_id AND legacy.project_id=e.project_id AND legacy.run_id=e.run_id
  WHERE e.owner_user_id=NEW.owner_user_id AND e.project_id=NEW.project_id AND e.run_id=NEW.run_id
    AND e.execution_version=NEW.execution_version AND e.input_revision=NEW.input_revision AND e.input_hash=NEW.input_hash
    AND ((NEW.execution_version=1 AND legacy.version=NEW.version AND legacy.operation=NEW.operation
      AND legacy.source_report_id IS NOT DISTINCT FROM NEW.source_report_id
      AND legacy.snapshot=NEW.snapshot AND legacy.created_at=NEW.created_at)
    OR (NEW.execution_version=2 AND EXISTS(
      SELECT 1 FROM bb_run_test_successor_authorizations a
      JOIN bb_run_supplement_processing_plans p ON p.owner_user_id=a.owner_user_id AND p.project_id=a.project_id
        AND p.run_id=a.run_id AND p.id=a.processing_plan_id AND p.kind='review'
      JOIN bb_review_execution_snapshots source ON source.owner_user_id=a.owner_user_id AND source.project_id=a.project_id
        AND source.run_id=a.run_id AND source.execution_version=a.source_execution_version
        AND source.input_revision=a.source_input_revision AND source.input_hash=a.source_input_hash
      JOIN bb_run_execution_heads h ON h.owner_user_id=a.owner_user_id AND h.project_id=a.project_id AND h.run_id=a.run_id
        AND ((h.execution_version=a.source_execution_version AND h.input_revision=a.source_input_revision AND h.input_hash=a.source_input_hash)
          OR (h.execution_version=a.execution_version AND h.input_revision=a.input_revision AND h.input_hash=a.input_hash))
      WHERE a.owner_user_id=NEW.owner_user_id AND a.project_id=NEW.project_id AND a.run_id=NEW.run_id
        AND a.execution_version=NEW.execution_version AND a.input_revision=NEW.input_revision AND a.input_hash=NEW.input_hash
        AND a.created_at=NEW.created_at AND source.version::bigint+1=NEW.version::bigint AND source.operation=NEW.operation
        AND source.source_report_id IS NOT DISTINCT FROM NEW.source_report_id
        AND (source.snapshot-'input') IS NOT DISTINCT FROM (NEW.snapshot-'input'))));
  IF manifest ? 'review' THEN
    valid := jsonb_typeof(manifest->'review')='object' AND manifest#>>'{review,version}'='review_v1'
      AND manifest#>'{review,version_number}'=to_jsonb(NEW.version) AND manifest#>>'{review,operation}'=NEW.operation
      AND manifest#>>'{review,source_report_id}' IS NOT DISTINCT FROM NEW.source_report_id
      AND manifest#>'{review,input}'=NEW.snapshot->'input'
      AND manifest#>'{review,finding_ids}'=NEW.snapshot->'finding_ids'
      AND COALESCE(manifest#>'{review,origin}','null'::jsonb)=COALESCE(NEW.snapshot->'origin','null'::jsonb);
  ELSIF jsonb_typeof(manifest#>'{authoring,review_result}')='object' AND jsonb_typeof(manifest->'materials')='array' THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object('material_id',m->'material_id','material_version',m->'material_version','sha256',m->'sha256') ORDER BY ordinal),'[]'::jsonb)
      INTO materials FROM jsonb_array_elements(manifest->'materials') WITH ORDINALITY p(m,ordinal);
    valid := task_kind='update' AND NEW.operation='revision' AND manifest#>>'{authoring,version}'='unified_v1'
      AND NEW.snapshot->>'source_run_id'=manifest#>>'{authoring,review_result,run_id}'
      AND NEW.snapshot#>'{input,source_material_ref}'=manifest#>'{authoring,review_result,source_material}'
      AND NEW.snapshot#>'{input,material_versions}'=materials
      AND materials @> jsonb_build_array(manifest#>'{authoring,review_result,source_material}')
      AND NEW.snapshot#>'{input,requirements}'=CASE WHEN COALESCE(manifest#>>'{authoring,review_result,requirements}','')=''
        THEN '[]'::jsonb ELSE jsonb_build_array(manifest#>>'{authoring,review_result,requirements}') END;
  ELSE valid := false;
  END IF;
  IF NOT COALESCE(valid,false) THEN
    RAISE EXCEPTION 'review snapshot must match its exact execution input'
      USING ERRCODE='23514',CONSTRAINT='bb_review_execution_snapshot_exact';
  END IF;
  RETURN NEW;
EXCEPTION WHEN NO_DATA_FOUND THEN
  RAISE EXCEPTION 'review snapshot must preserve its owned immutable business origin'
    USING ERRCODE='23514',CONSTRAINT='bb_review_execution_snapshot_exact';
END; $$;

-- 0124 final M4 guard: preserve immutable methods/template/business context.
CREATE OR REPLACE FUNCTION bb_check_m4_execution_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(
    SELECT 1 FROM bb_run_execution_versions e
    JOIN bb_runs r ON r.owner_user_id=e.owner_user_id AND r.project_id=e.project_id AND r.id=e.run_id
    JOIN bb_input_revisions i ON i.owner_user_id=e.owner_user_id AND i.project_id=e.project_id
      AND i.revision=e.input_revision AND i.input_hash=e.input_hash
    LEFT JOIN bb_m4_executions legacy ON legacy.owner_user_id=e.owner_user_id AND legacy.run_id=e.run_id
    JOIN bb_m4_topics t ON t.owner_user_id=NEW.owner_user_id AND t.id=NEW.topic_id AND t.project_id=e.project_id
    WHERE e.owner_user_id=NEW.owner_user_id AND e.project_id=NEW.project_id AND e.run_id=NEW.run_id
      AND e.execution_version=NEW.execution_version AND e.input_revision=NEW.input_revision AND e.input_hash=NEW.input_hash
      AND i.manifest=NEW.manifest
      AND ((NEW.execution_version=1 AND legacy.topic_id=NEW.topic_id AND legacy.manifest=NEW.manifest
        AND legacy.input_hash=NEW.input_hash AND legacy.created_at=NEW.created_at)
      OR (NEW.execution_version=2 AND EXISTS(
        SELECT 1 FROM bb_run_test_successor_authorizations a
        JOIN bb_run_supplement_processing_plans p ON p.owner_user_id=a.owner_user_id AND p.project_id=a.project_id
          AND p.run_id=a.run_id AND p.id=a.processing_plan_id AND p.kind='m4'
        JOIN bb_m4_execution_snapshots source ON source.owner_user_id=a.owner_user_id AND source.project_id=a.project_id
          AND source.run_id=a.run_id AND source.execution_version=a.source_execution_version
          AND source.input_revision=a.source_input_revision AND source.input_hash=a.source_input_hash
        JOIN bb_run_execution_heads h ON h.owner_user_id=a.owner_user_id AND h.project_id=a.project_id AND h.run_id=a.run_id
          AND ((h.execution_version=a.source_execution_version AND h.input_revision=a.source_input_revision AND h.input_hash=a.source_input_hash)
          OR (h.execution_version=a.execution_version AND h.input_revision=a.input_revision AND h.input_hash=a.input_hash))
        WHERE a.owner_user_id=NEW.owner_user_id AND a.project_id=NEW.project_id AND a.run_id=NEW.run_id
          AND a.execution_version=NEW.execution_version AND a.input_revision=NEW.input_revision AND a.input_hash=NEW.input_hash
          AND a.created_at=NEW.created_at AND source.topic_id=NEW.topic_id
          AND (source.manifest-'input') IS NOT DISTINCT FROM (NEW.manifest-'input')
          AND ((source.manifest->'input')-ARRAY['materials','source_material'])
            IS NOT DISTINCT FROM ((NEW.manifest->'input')-ARRAY['materials','source_material']))))
      AND r.task_kind=CASE NEW.manifest->>'kind' WHEN 'document' THEN 'generation' WHEN 'qa' THEN 'qa' ELSE NULL END
  ) THEN
    RAISE EXCEPTION 'M4 snapshot must preserve its exact owned execution input and business origin'
      USING ERRCODE='23514',CONSTRAINT='bb_m4_execution_snapshot_exact';
  END IF;
  RETURN NEW;
END; $$;

-- 0133 final predicate, preserving V1/local/M4 hash semantics. Accepted V1 and
-- V2 remain pins while the same business run is nonterminal; drafts/plans do not.
CREATE OR REPLACE FUNCTION bb_material_bytes_pinned(p_owner text,p_project text,p_material text,p_version integer)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS(
    SELECT 1 FROM bb_projects p
    JOIN bb_runs r ON r.owner_user_id=p.owner_user_id AND r.project_id=p.id
    JOIN bb_run_execution_versions e ON e.owner_user_id=r.owner_user_id AND e.project_id=r.project_id AND e.run_id=r.id
      AND ((e.execution_version=1 AND e.input_revision=r.input_revision AND e.input_hash=r.input_hash)
        OR (e.execution_version=2 AND EXISTS(SELECT 1 FROM bb_run_test_successor_authorizations accepted
          WHERE accepted.owner_user_id=e.owner_user_id AND accepted.project_id=e.project_id AND accepted.run_id=e.run_id
            AND accepted.execution_version=e.execution_version AND accepted.input_revision=e.input_revision AND accepted.input_hash=e.input_hash)))
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
      AND ((e.execution_version=1 AND e.input_revision=r.input_revision AND e.input_hash=r.input_hash)
        OR (e.execution_version=2 AND EXISTS(SELECT 1 FROM bb_run_test_successor_authorizations accepted
          WHERE accepted.owner_user_id=e.owner_user_id AND accepted.project_id=e.project_id AND accepted.run_id=e.run_id
            AND accepted.execution_version=e.execution_version AND accepted.input_revision=e.input_revision AND accepted.input_hash=e.input_hash)))
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

-- Acquire the union in signed-key order before checking individual immutable
-- inputs. This retains the common purge barrier and post-wait checks.
CREATE FUNCTION bb_assert_run_execution_materials_available(p_owner text,p_project text,p_run text)
RETURNS void LANGUAGE plpgsql VOLATILE AS $$
DECLARE lock_key bigint;input_revision_to_check integer;
BEGIN
  IF current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'material lifecycle coordination requires READ COMMITTED isolation'
      USING ERRCODE='23514',CONSTRAINT='bb_material_lifecycle_isolation';END IF;
  FOR lock_key IN SELECT DISTINCT k.lifecycle_key FROM bb_run_execution_versions e
    CROSS JOIN LATERAL bb_material_lifecycle_input_keys(e.owner_user_id,e.project_id,e.input_revision) k
    WHERE e.owner_user_id=p_owner AND e.project_id=p_project AND e.run_id=p_run ORDER BY k.lifecycle_key
  LOOP PERFORM pg_advisory_xact_lock(lock_key);END LOOP;
  FOR input_revision_to_check IN SELECT DISTINCT e.input_revision FROM bb_run_execution_versions e
    WHERE e.owner_user_id=p_owner AND e.project_id=p_project AND e.run_id=p_run ORDER BY e.input_revision
  LOOP PERFORM bb_assert_material_lifecycle_available(p_owner,p_project,input_revision_to_check);END LOOP;
END;$$;

-- 0133 run restore: INSERT still checks the original input before V1 exists.
CREATE OR REPLACE FUNCTION bb_guard_run_material_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state IN ('succeeded','test_completed','failed','cancelled','rejected') THEN RETURN NEW; END IF;
  IF TG_OP='INSERT' THEN
    PERFORM bb_assert_material_lifecycle_available(NEW.owner_user_id,NEW.project_id,NEW.input_revision);
  ELSIF OLD.state IN ('succeeded','test_completed','failed','cancelled','rejected')
    OR NEW.task_kind IS DISTINCT FROM OLD.task_kind THEN
    PERFORM bb_assert_run_execution_materials_available(NEW.owner_user_id,NEW.project_id,NEW.id);
  END IF;
  RETURN NEW;
END $$;

-- 0133 execution/canonical-M4 insertion checks prospective V2 pins too.
CREATE OR REPLACE FUNCTION bb_guard_execution_material_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM bb_runs r WHERE r.owner_user_id=NEW.owner_user_id AND r.project_id=NEW.project_id
    AND r.id=NEW.run_id
    AND r.state NOT IN ('succeeded','test_completed','failed','cancelled','rejected')) THEN
    PERFORM bb_assert_material_lifecycle_available(NEW.owner_user_id,NEW.project_id,NEW.input_revision);
  END IF;
  RETURN NEW;
END $$;

-- 0133 job identity/subtype admission: all accepted execution references.
CREATE OR REPLACE FUNCTION bb_guard_job_material_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owned_run bb_runs%ROWTYPE;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF ROW(NEW.owner_user_id,NEW.run_id,NEW.subtype) IS NOT DISTINCT FROM ROW(OLD.owner_user_id,OLD.run_id,OLD.subtype) THEN
      RETURN NEW;
    END IF;
  END IF;
  SELECT * INTO owned_run FROM bb_runs WHERE owner_user_id=NEW.owner_user_id AND id=NEW.run_id;
  IF FOUND AND owned_run.state NOT IN ('succeeded','test_completed','failed','cancelled','rejected') THEN
    PERFORM bb_assert_run_execution_materials_available(owned_run.owner_user_id,owned_run.project_id,owned_run.id);
  END IF;
  RETURN NEW;
END $$;

-- 0125 final binder, with an explicit fail-closed milestone boundary.
CREATE OR REPLACE FUNCTION bb_bind_artifact_execution() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE execution bb_run_execution_versions%ROWTYPE;
BEGIN
  -- A delayed old writer must not be relabeled V2, and V2 bytes must not be
  -- silently bound to V1. The later artifact/delivery milestone stays CLOSED.
  IF NOT EXISTS(SELECT 1 FROM bb_run_execution_heads h JOIN bb_runs r
    ON r.owner_user_id=h.owner_user_id AND r.project_id=h.project_id AND r.id=h.run_id
    WHERE h.owner_user_id=NEW.owner_user_id AND h.run_id=NEW.run_id AND h.execution_version=1
      AND h.input_revision=r.input_revision AND h.input_hash=r.input_hash) THEN
    RAISE EXCEPTION 'successor artifact production is not enabled by test input adoption'
      USING ERRCODE='23514',CONSTRAINT='bb_test_successor_artifact_closed';END IF;
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
