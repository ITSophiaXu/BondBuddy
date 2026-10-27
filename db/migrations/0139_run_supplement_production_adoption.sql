-- Production V1 -> V2 adoption is one receipt/input/fee/head/queue transaction.
-- Internal test authority and its non-billable restrictions remain independent.
LOCK TABLE bb_projects IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE bb_runs IN EXCLUSIVE MODE NOWAIT;
LOCK TABLE bb_jobs IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE bb_run_execution_versions IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE bb_run_execution_heads IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE bb_credit_reservations IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE bb_run_billing_segments IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE bb_run_execution_billing_bindings IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE bb_run_billing_progress IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE bb_authoring_progress IN ACCESS EXCLUSIVE MODE NOWAIT;

CREATE TABLE bb_run_supplement_adoptions (
 id text PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 128),
 owner_user_id text NOT NULL,project_id text NOT NULL,run_id text NOT NULL,job_id text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('authoring','review','m4')),
 source_execution_version integer NOT NULL CHECK(source_execution_version=1),
 source_input_revision integer NOT NULL CHECK(source_input_revision>0),
 source_input_hash char(64) NOT NULL CHECK(source_input_hash ~ '^[a-f0-9]{64}$'),
 execution_version integer NOT NULL CHECK(execution_version=2),
 input_revision integer NOT NULL CHECK(input_revision>0 AND input_revision<>source_input_revision),
 input_hash char(64) NOT NULL CHECK(input_hash ~ '^[a-f0-9]{64}$'),
 supplement_revision integer NOT NULL CHECK(supplement_revision>0),
 receipt_request_id text NOT NULL,receipt_request_hash char(64) NOT NULL,
 processing_plan_id text NOT NULL,processing_plan_hash char(64) NOT NULL,
 checkpoint_hash char(64) NOT NULL,basis_hash char(64) NOT NULL,candidate_input_hash char(64) NOT NULL,
 quote_id text NOT NULL UNIQUE,quote_hash char(64) NOT NULL,confirmation_id text NOT NULL UNIQUE,
 total_points bigint NOT NULL CHECK(total_points BETWEEN 0 AND 1000000000),
 assignment_kind text NOT NULL CHECK(assignment_kind IN ('rework','carry','unbilled')),
 source_billing_segment_id text,target_billing_segment_id text,
 request_id text NOT NULL CHECK(length(request_id) BETWEEN 1 AND 128),
 request_hash char(64) NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(owner_user_id,run_id,request_id),UNIQUE(run_id,execution_version),
 UNIQUE(owner_user_id,project_id,run_id,id),
 CHECK((assignment_kind='rework' AND total_points>0 AND target_billing_segment_id IS NOT NULL AND source_billing_segment_id IS DISTINCT FROM target_billing_segment_id)
  OR (assignment_kind='carry' AND total_points=0 AND source_billing_segment_id IS NOT NULL AND source_billing_segment_id=target_billing_segment_id)
  OR (assignment_kind='unbilled' AND total_points=0 AND source_billing_segment_id IS NULL AND target_billing_segment_id IS NULL)),
 FOREIGN KEY(owner_user_id,project_id,run_id) REFERENCES bb_runs(owner_user_id,project_id,id),
 FOREIGN KEY(owner_user_id,job_id,run_id) REFERENCES bb_jobs(owner_user_id,id,run_id),
 FOREIGN KEY(owner_user_id,project_id,run_id,source_execution_version,source_input_revision,source_input_hash)
  REFERENCES bb_run_execution_versions(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash),
 FOREIGN KEY(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash)
  REFERENCES bb_run_execution_versions(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(owner_user_id,project_id,run_id,quote_id) REFERENCES bb_run_supplement_quotes(owner_user_id,project_id,run_id,id),
 FOREIGN KEY(confirmation_id) REFERENCES bb_run_supplement_quote_confirmations(id),
 FOREIGN KEY(source_billing_segment_id) REFERENCES bb_run_billing_segments(id),
 FOREIGN KEY(target_billing_segment_id) REFERENCES bb_run_billing_segments(id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TRIGGER bb_supplement_adoption_immutable BEFORE UPDATE OR DELETE ON bb_run_supplement_adoptions
 FOR EACH ROW EXECUTE FUNCTION bb_reject_billing_identity_change();
CREATE TRIGGER bb_supplement_adoption_no_truncate BEFORE TRUNCATE ON bb_run_supplement_adoptions
 FOR EACH STATEMENT EXECUTE FUNCTION bb_reject_billing_identity_change();

-- Relax cardinality only with production adoption and deferred completeness.
ALTER TABLE bb_credit_reservations DROP CONSTRAINT bb_credit_reservations_run_id_key;
CREATE INDEX bb_credit_reservation_run_idx ON bb_credit_reservations(owner_user_id,run_id);
ALTER TABLE bb_run_billing_segments DROP CONSTRAINT bb_run_billing_segments_segment_number_check;
ALTER TABLE bb_run_billing_segments ADD CONSTRAINT bb_run_billing_segment_number CHECK(segment_number IN (1,2));
ALTER TABLE bb_run_billing_segments DROP CONSTRAINT bb_run_billing_segments_origin_execution_version_check;
ALTER TABLE bb_run_billing_segments ADD CONSTRAINT bb_run_billing_segment_origin_version CHECK(origin_execution_version IN (1,2));
ALTER TABLE bb_run_billing_segments ADD COLUMN adoption_id text REFERENCES bb_run_supplement_adoptions(id);
ALTER TABLE bb_run_execution_billing_bindings DROP CONSTRAINT bb_run_execution_billing_bindings_execution_version_check;
ALTER TABLE bb_run_execution_billing_bindings ADD CONSTRAINT bb_run_billing_binding_version CHECK(execution_version IN (1,2));
ALTER TABLE bb_run_execution_billing_bindings DROP CONSTRAINT bb_run_execution_billing_bindings_billing_segment_id_key;
ALTER TABLE bb_run_execution_billing_bindings DROP CONSTRAINT bb_run_execution_billing_bindings_assignment_kind_check;
ALTER TABLE bb_run_execution_billing_bindings ADD CONSTRAINT bb_run_billing_binding_kind CHECK(assignment_kind IN ('original','rework','carry'));
ALTER TABLE bb_run_execution_billing_bindings ADD COLUMN adoption_id text REFERENCES bb_run_supplement_adoptions(id);

CREATE TABLE bb_run_billing_segment_closures (
 billing_segment_id text PRIMARY KEY REFERENCES bb_run_billing_segments(id),
 owner_user_id text NOT NULL,project_id text NOT NULL,run_id text NOT NULL,
 execution_version integer NOT NULL,input_revision integer NOT NULL,input_hash char(64) NOT NULL,
 adoption_id text NOT NULL REFERENCES bb_run_supplement_adoptions(id),
 disposition text NOT NULL CHECK(disposition IN ('superseded','succeeded','failed','cancelled','rejected')),
 charged_points bigint NOT NULL CHECK(charged_points>=0),released_points bigint NOT NULL CHECK(released_points>=0),
 refunded_points bigint NOT NULL CHECK(refunded_points>=0),closed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash)
  REFERENCES bb_run_execution_versions(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash)
);
CREATE TRIGGER bb_run_billing_closure_immutable BEFORE UPDATE OR DELETE ON bb_run_billing_segment_closures
 FOR EACH ROW EXECUTE FUNCTION bb_reject_billing_identity_change();
CREATE TRIGGER bb_run_billing_closure_no_truncate BEFORE TRUNCATE ON bb_run_billing_segment_closures
 FOR EACH STATEMENT EXECUTE FUNCTION bb_reject_billing_identity_change();

CREATE FUNCTION bb_check_production_supplement_adoption() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q bb_run_supplement_quotes%ROWTYPE;c bb_run_supplement_quote_confirmations%ROWTYPE;
 r bb_runs%ROWTYPE;j bb_jobs%ROWTYPE;p bb_run_supplement_processing_plans%ROWTYPE;
 source_segment text;target_input bb_input_revisions%ROWTYPE;source_project bb_projects%ROWTYPE;material bb_material_versions%ROWTYPE;
 planned_pins jsonb;candidate_pins jsonb;planned_refs jsonb;candidate_refs jsonb;staged_refs jsonb;
 project_to_lock text;pin_to_lock jsonb;key_to_lock bigint;
BEGIN
 SELECT * INTO q FROM bb_run_supplement_quotes WHERE id=NEW.quote_id AND owner_user_id=NEW.owner_user_id
  AND project_id=NEW.project_id AND run_id=NEW.run_id;
 IF q.id IS NULL THEN RAISE EXCEPTION 'exact owned confirmed supplement quote required'
  USING ERRCODE='23514',CONSTRAINT='bb_supplement_adoption_quote';END IF;
 IF NEW.processing_plan_id<>q.processing_plan_id OR NEW.source_input_revision<>q.source_input_revision
  OR NEW.source_input_hash<>q.source_input_hash OR NEW.input_hash<>q.candidate_input_hash
 THEN RAISE EXCEPTION 'adoption candidate and plan must match its exact quote'
  USING ERRCODE='23514',CONSTRAINT='bb_supplement_adoption_exact';END IF;
 -- Lock the parent scope before the ENTIRE source/target/plan key set.
 -- Earlier byte verification may already own target keys; new keys never wait.
 PERFORM 1 FROM bb_projects WHERE owner_user_id=NEW.owner_user_id AND id=NEW.project_id FOR UPDATE;
 SELECT * INTO r FROM bb_runs WHERE owner_user_id=NEW.owner_user_id AND project_id=NEW.project_id AND id=NEW.run_id FOR UPDATE;
 SELECT * INTO j FROM bb_jobs WHERE owner_user_id=NEW.owner_user_id AND run_id=NEW.run_id AND id=NEW.job_id FOR UPDATE;
 SELECT * INTO p FROM bb_run_supplement_processing_plans WHERE id=NEW.processing_plan_id
  AND owner_user_id=NEW.owner_user_id AND project_id=NEW.project_id AND run_id=NEW.run_id;
 SELECT COALESCE(jsonb_agg(CASE WHEN q.kind='authoring' THEN value||jsonb_build_object('source_project_id',NEW.project_id) ELSE value END),'[]'::jsonb)
  INTO planned_pins FROM jsonb_array_elements(p.body->'materials');
 FOR key_to_lock IN SELECT DISTINCT lifecycle_key FROM (
  SELECT lifecycle_key FROM bb_material_lifecycle_input_keys(NEW.owner_user_id,NEW.project_id,NEW.source_input_revision)
  UNION ALL SELECT lifecycle_key FROM bb_material_lifecycle_input_keys(NEW.owner_user_id,NEW.project_id,NEW.input_revision)
  UNION ALL SELECT bb_material_lifecycle_lock_key(NEW.owner_user_id,value->>'source_project_id',value->>'material_id',(value->>'material_version')::integer)
   FROM jsonb_array_elements(planned_pins)) keys ORDER BY lifecycle_key LOOP
  IF NOT pg_try_advisory_xact_lock(key_to_lock) THEN RAISE EXCEPTION 'candidate material lifecycle is busy'
   USING ERRCODE='55P03';END IF;
 END LOOP;
 PERFORM bb_assert_supplement_quote_live(q);
 SELECT * INTO c FROM bb_run_supplement_quote_confirmations WHERE id=NEW.confirmation_id;
 SELECT * INTO r FROM bb_runs WHERE owner_user_id=NEW.owner_user_id AND project_id=NEW.project_id AND id=NEW.run_id;
 SELECT * INTO j FROM bb_jobs WHERE owner_user_id=NEW.owner_user_id AND run_id=NEW.run_id AND id=NEW.job_id;
 SELECT * INTO p FROM bb_run_supplement_processing_plans WHERE id=NEW.processing_plan_id
  AND owner_user_id=NEW.owner_user_id AND project_id=NEW.project_id AND run_id=NEW.run_id;
 SELECT b.billing_segment_id INTO source_segment FROM bb_run_execution_billing_bindings b
  WHERE b.owner_user_id=NEW.owner_user_id AND b.project_id=NEW.project_id AND b.run_id=NEW.run_id
  AND b.execution_version=1 AND b.input_revision=NEW.source_input_revision AND b.input_hash=NEW.source_input_hash;
 IF r.id IS NULL OR j.id IS NULL OR p.id IS NULL OR c.id IS NULL OR r.channel<>'production' OR j.channel<>'production'
  OR r.test_grant_id IS NOT NULL OR j.test_grant_id IS NOT NULL
  OR NEW.kind<>q.kind OR NEW.job_id<>q.job_id OR NEW.source_execution_version<>q.source_execution_version
  OR NEW.source_input_revision<>q.source_input_revision OR NEW.source_input_hash<>q.source_input_hash
  OR NEW.supplement_revision<>q.supplement_revision OR NEW.receipt_request_id<>q.receipt_request_id
  OR NEW.receipt_request_hash<>q.receipt_request_hash OR NEW.processing_plan_id<>q.processing_plan_id
  OR NEW.processing_plan_hash<>q.processing_plan_hash OR NEW.checkpoint_hash<>q.checkpoint_hash
  OR NEW.basis_hash<>q.basis_hash OR NEW.candidate_input_hash<>q.candidate_input_hash OR NEW.input_hash<>q.candidate_input_hash
  OR NEW.quote_hash<>q.quote_hash OR NEW.total_points<>q.total_points
  OR c.owner_user_id<>NEW.owner_user_id OR c.project_id<>NEW.project_id OR c.run_id<>NEW.run_id
  OR c.quote_id<>q.id OR c.quote_hash<>q.quote_hash OR c.total_points<>q.total_points OR c.confirmed_by<>NEW.owner_user_id
  OR source_segment IS DISTINCT FROM r.reservation_id OR NEW.source_billing_segment_id IS DISTINCT FROM source_segment
  OR (source_segment IS NOT NULL AND NOT EXISTS(SELECT 1 FROM bb_credit_reservations reservation WHERE reservation.id=source_segment
    AND reservation.owner_user_id=NEW.owner_user_id AND reservation.run_id=NEW.run_id AND reservation.state='held'))
  OR (SELECT count(*) FROM bb_run_execution_versions WHERE run_id=NEW.run_id)<>1
  OR NOT EXISTS(SELECT 1 FROM bb_input_revisions i WHERE i.owner_user_id=NEW.owner_user_id AND i.project_id=NEW.project_id
    AND i.revision=NEW.input_revision AND i.input_hash=NEW.input_hash)
 THEN RAISE EXCEPTION 'production adoption must retain exact confirmed quote, source fee and prepared candidate'
  USING ERRCODE='23514',CONSTRAINT='bb_supplement_adoption_exact';END IF;
 NEW.created_at=clock_timestamp();
 IF q.expires_at<=NEW.created_at THEN RAISE EXCEPTION 'supplement quote expired before adoption'
  USING ERRCODE='23514',CONSTRAINT='bb_supplement_quote_expired';END IF;
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
    RAISE EXCEPTION 'production successor requires the complete exact live candidate material set'
      USING ERRCODE='23514',CONSTRAINT='bb_supplement_adoption_materials_available';END IF;
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
    RAISE EXCEPTION 'production successor requires the complete exact live candidate material set'
      USING ERRCODE='23514',CONSTRAINT='bb_supplement_adoption_materials_available';END IF;

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
      RAISE EXCEPTION 'production successor candidate source project is unavailable'
        USING ERRCODE='23514',CONSTRAINT='bb_supplement_adoption_materials_available';END IF;
  END LOOP;
  FOR pin_to_lock IN SELECT pin FROM jsonb_array_elements(planned_pins) refs(pin)
    ORDER BY pin->>'source_project_id',pin->>'material_id',(pin->>'material_version')::integer LOOP
    SELECT * INTO material FROM bb_material_versions WHERE owner_user_id=NEW.owner_user_id
      AND project_id=pin_to_lock->>'source_project_id' AND id=pin_to_lock->>'material_id'
      AND version=(pin_to_lock->>'material_version')::integer FOR SHARE NOWAIT;
    IF material.id IS NULL OR material.deleted_at IS NOT NULL
      OR trim(material.sha256) IS DISTINCT FROM pin_to_lock->>'sha256'
      OR material.role IS DISTINCT FROM pin_to_lock->>'role' THEN
      RAISE EXCEPTION 'production successor candidate material identity or availability changed'
        USING ERRCODE='23514',CONSTRAINT='bb_supplement_adoption_materials_available';END IF;
  END LOOP;
 RETURN NEW;
END;$$;
CREATE TRIGGER bb_supplement_adoption_exact BEFORE INSERT ON bb_run_supplement_adoptions
 FOR EACH ROW EXECUTE FUNCTION bb_check_production_supplement_adoption();

CREATE OR REPLACE FUNCTION bb_check_original_billing_segment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.origin_execution_version=1 THEN
  IF NEW.segment_number<>1 OR NEW.adoption_id IS NOT NULL OR NOT EXISTS(
   SELECT 1 FROM bb_credit_reservations c JOIN bb_runs r ON r.owner_user_id=c.owner_user_id AND r.id=c.run_id AND r.reservation_id=c.id
   WHERE c.id=NEW.id AND c.id=NEW.reservation_id AND c.owner_user_id=NEW.owner_user_id AND r.project_id=NEW.project_id AND c.run_id=NEW.run_id
    AND NEW.origin_input_revision=r.input_revision AND NEW.origin_input_hash=r.input_hash AND NEW.source_quote_id=c.quote_id
    AND NEW.billing_policy=c.billing_policy AND NEW.points=c.points AND NEW.created_at=c.created_at)
  THEN RAISE EXCEPTION 'original fee segment must retain its immutable V1 reservation'
   USING ERRCODE='23514',CONSTRAINT='bb_run_billing_segment_exact';END IF;
 ELSE
  IF NEW.segment_number<>2 OR NOT EXISTS(SELECT 1 FROM bb_run_supplement_adoptions a
   JOIN bb_credit_reservations c ON c.id=a.target_billing_segment_id AND c.owner_user_id=a.owner_user_id AND c.run_id=a.run_id
   WHERE a.id=NEW.adoption_id AND a.owner_user_id=NEW.owner_user_id AND a.project_id=NEW.project_id AND a.run_id=NEW.run_id
    AND a.assignment_kind='rework' AND a.target_billing_segment_id=NEW.id AND NEW.reservation_id=c.id
    AND a.execution_version=NEW.origin_execution_version AND a.input_revision=NEW.origin_input_revision AND a.input_hash=NEW.origin_input_hash
    AND c.quote_id=a.quote_id AND NEW.source_quote_id=a.quote_id AND c.points=a.total_points AND NEW.points=c.points
    AND c.billing_policy='authoring_balance_v2' AND NEW.billing_policy=c.billing_policy AND c.created_at=a.created_at AND NEW.created_at=a.created_at)
  THEN RAISE EXCEPTION 'additional fee requires its exact production adoption, positive quote and independent dynamic cap'
   USING ERRCODE='23514',CONSTRAINT='bb_run_billing_segment_exact';END IF;
 END IF;
 RETURN NEW;
END;$$;
CREATE OR REPLACE FUNCTION bb_check_original_billing_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.execution_version=1 THEN
  IF NEW.assignment_kind<>'original' OR NEW.adoption_id IS NOT NULL OR NOT EXISTS(SELECT 1 FROM bb_run_billing_segments s
    WHERE s.id=NEW.billing_segment_id AND s.owner_user_id=NEW.owner_user_id AND s.project_id=NEW.project_id AND s.run_id=NEW.run_id
    AND s.origin_execution_version=1 AND s.origin_input_revision=NEW.input_revision AND s.origin_input_hash=NEW.input_hash AND s.created_at=NEW.created_at)
  THEN RAISE EXCEPTION 'original fee assignment must retain the complete V1 identity'
   USING ERRCODE='23514',CONSTRAINT='bb_run_billing_binding_exact';END IF;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM bb_run_supplement_adoptions a JOIN bb_run_billing_segments s
   ON s.id=a.target_billing_segment_id AND s.owner_user_id=a.owner_user_id AND s.project_id=a.project_id AND s.run_id=a.run_id
   WHERE a.id=NEW.adoption_id AND a.owner_user_id=NEW.owner_user_id AND a.project_id=NEW.project_id AND a.run_id=NEW.run_id
    AND a.execution_version=NEW.execution_version AND a.input_revision=NEW.input_revision AND a.input_hash=NEW.input_hash
    AND a.target_billing_segment_id=NEW.billing_segment_id AND a.assignment_kind=NEW.assignment_kind AND a.created_at=NEW.created_at
    AND ((a.assignment_kind='rework' AND s.adoption_id=a.id AND s.origin_execution_version=2 AND s.origin_input_revision=a.input_revision AND s.origin_input_hash=a.input_hash)
     OR (a.assignment_kind='carry' AND s.id=a.source_billing_segment_id AND s.origin_execution_version=1)))
  THEN RAISE EXCEPTION 'successor fee assignment requires its exact immutable production adoption'
   USING ERRCODE='23514',CONSTRAINT='bb_run_billing_binding_exact';END IF;
 END IF;
 RETURN NEW;
END;$$;

-- Preserve the deployed multi-family original quote guard. Only a positive
-- production adoption may introduce a B1 quote into the reservation ledger.
DO $$ DECLARE definition text;prefix text;
BEGIN
 SELECT pg_get_functiondef('bb_credit_reservation_quote_guard()'::regprocedure) INTO definition;
 prefix:=$prefix$BEGIN
 IF EXISTS(SELECT 1 FROM bb_run_supplement_quotes WHERE id=NEW.quote_id) THEN
  IF NOT EXISTS(SELECT 1 FROM bb_run_supplement_adoptions a WHERE a.owner_user_id=NEW.owner_user_id AND a.run_id=NEW.run_id
    AND a.quote_id=NEW.quote_id AND a.assignment_kind='rework' AND a.target_billing_segment_id=NEW.id
    AND a.total_points=NEW.points AND NEW.billing_policy='authoring_balance_v2' AND NEW.created_at=a.created_at)
  THEN RAISE EXCEPTION 'additional reservation requires its exact adopted positive quote'
   USING ERRCODE='23514',CONSTRAINT='bb_supplement_adoption_reservation';END IF;
  RETURN NEW;
 END IF;
$prefix$;
 IF strpos(definition,'Owned immutable quote required')=0 OR strpos(definition,'bb_project_qa_quotes')=0
  OR strpos(definition,'bb_integrity_quotes')=0 OR strpos(definition,'bb_project_file_update_quotes')=0
 THEN RAISE EXCEPTION 'Unexpected multi-family reservation quote predecessor';END IF;
 definition:=replace(definition,E'\r\n',E'\n');
 EXECUTE replace(definition,E'BEGIN\n',prefix);
END;$$;

CREATE FUNCTION bb_production_successor_execution_origin(p_owner text,p_project text,p_run text,p_execution integer,p_revision integer,p_hash text)
RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT p_execution=2 AND EXISTS(SELECT 1 FROM bb_run_supplement_adoptions a
 JOIN bb_runs r ON r.owner_user_id=a.owner_user_id AND r.project_id=a.project_id AND r.id=a.run_id
  AND r.input_revision=a.source_input_revision AND r.input_hash=a.source_input_hash AND r.channel='production'
 JOIN bb_jobs j ON j.owner_user_id=a.owner_user_id AND j.run_id=a.run_id AND j.id=a.job_id AND j.channel='production'
 JOIN bb_run_execution_versions e ON e.owner_user_id=a.owner_user_id AND e.project_id=a.project_id AND e.run_id=a.run_id
  AND e.execution_version=a.execution_version AND e.input_revision=a.input_revision AND e.input_hash=a.input_hash AND e.created_at=a.created_at
 JOIN bb_run_execution_versions source ON source.owner_user_id=a.owner_user_id AND source.project_id=a.project_id AND source.run_id=a.run_id
  AND source.execution_version=a.source_execution_version AND source.input_revision=a.source_input_revision AND source.input_hash=a.source_input_hash
 JOIN bb_run_supplement_quotes q ON q.id=a.quote_id AND q.owner_user_id=a.owner_user_id AND q.project_id=a.project_id AND q.run_id=a.run_id
  AND q.quote_hash=a.quote_hash AND q.total_points=a.total_points AND q.candidate_input_hash=a.input_hash
  AND q.processing_plan_id=a.processing_plan_id AND q.processing_plan_hash=a.processing_plan_hash AND q.checkpoint_hash=a.checkpoint_hash AND q.basis_hash=a.basis_hash
 JOIN bb_run_supplement_quote_confirmations consent ON consent.id=a.confirmation_id AND consent.owner_user_id=a.owner_user_id
  AND consent.project_id=a.project_id AND consent.run_id=a.run_id AND consent.quote_id=q.id AND consent.quote_hash=q.quote_hash
  AND consent.total_points=q.total_points AND consent.confirmed_by=a.owner_user_id
 WHERE a.owner_user_id=p_owner AND a.project_id=p_project AND a.run_id=p_run
  AND a.execution_version=p_execution AND a.input_revision=p_revision AND a.input_hash=p_hash
  AND ((a.assignment_kind='unbilled' AND NOT EXISTS(SELECT 1 FROM bb_run_execution_billing_bindings b WHERE b.run_id=a.run_id AND b.execution_version=2))
   OR (a.assignment_kind IN ('rework','carry') AND EXISTS(SELECT 1 FROM bb_run_execution_billing_bindings b
    JOIN bb_run_billing_segments s ON s.id=b.billing_segment_id AND s.owner_user_id=b.owner_user_id AND s.project_id=b.project_id AND s.run_id=b.run_id
    JOIN bb_credit_reservations c ON c.id=s.reservation_id AND c.owner_user_id=s.owner_user_id AND c.run_id=s.run_id
     AND c.quote_id=s.source_quote_id AND c.points=s.points AND c.billing_policy=s.billing_policy AND c.created_at=s.created_at
    JOIN bb_run_billing_progress m ON m.billing_segment_id=s.id AND m.owner_user_id=s.owner_user_id AND m.project_id=s.project_id AND m.run_id=s.run_id
    WHERE b.owner_user_id=a.owner_user_id AND b.project_id=a.project_id AND b.run_id=a.run_id AND b.execution_version=2
     AND b.input_revision=a.input_revision AND b.input_hash=a.input_hash AND b.billing_segment_id=a.target_billing_segment_id
     AND b.adoption_id=a.id AND b.assignment_kind=a.assignment_kind AND b.created_at=a.created_at
     AND ((a.assignment_kind='rework' AND s.adoption_id=a.id AND s.segment_number=2 AND s.origin_execution_version=2
       AND s.origin_input_revision=a.input_revision AND s.origin_input_hash=a.input_hash AND c.quote_id=a.quote_id AND c.points=a.total_points
       AND c.billing_policy='authoring_balance_v2' AND (a.source_billing_segment_id IS NULL OR EXISTS(
        SELECT 1 FROM bb_run_billing_segment_closures closed WHERE closed.billing_segment_id=a.source_billing_segment_id
         AND closed.adoption_id=a.id AND closed.disposition='superseded')))
      OR (a.assignment_kind='carry' AND s.segment_number=1 AND s.id=a.source_billing_segment_id AND s.origin_execution_version=1
       AND s.origin_input_revision=a.source_input_revision AND s.origin_input_hash=a.source_input_hash)))))
 )
$$;
CREATE FUNCTION bb_assert_production_successor_execution_active(p_owner text,p_project text,p_run text,p_execution integer,p_revision integer,p_hash text)
RETURNS void LANGUAGE plpgsql VOLATILE AS $$
BEGIN
 IF NOT COALESCE(bb_production_successor_execution_origin(p_owner,p_project,p_run,p_execution,p_revision,p_hash),false)
 THEN RAISE EXCEPTION 'exact production successor authority and fee assignment required'
  USING ERRCODE='23514',CONSTRAINT='bb_supplement_adoption_active';END IF;
 PERFORM 1 FROM bb_projects p JOIN bb_users u ON u.id=p.owner_user_id
  WHERE p.owner_user_id=p_owner AND p.id=p_project AND p.deleted_at IS NULL AND p.archived_at IS NULL
   AND u.closed_at IS NULL AND u.status<>'closed' FOR SHARE OF p,u NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'production successor project is unavailable'
  USING ERRCODE='23514',CONSTRAINT='bb_supplement_adoption_active';END IF;
 PERFORM 1 FROM bb_runs r JOIN bb_jobs j ON j.owner_user_id=r.owner_user_id AND j.run_id=r.id
  WHERE r.owner_user_id=p_owner AND r.project_id=p_project AND r.id=p_run
   AND j.checkpoint->'stage_execution'=jsonb_build_object('execution_version',p_execution,'input_revision',p_revision,'input_hash',p_hash)
  FOR KEY SHARE OF r,j NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'production successor requires its exact explicit stage identity'
  USING ERRCODE='23514',CONSTRAINT='bb_supplement_adoption_active';END IF;
 PERFORM 1 FROM bb_run_execution_heads h JOIN bb_run_supplement_adoptions a
  ON a.owner_user_id=h.owner_user_id AND a.project_id=h.project_id AND a.run_id=h.run_id
   AND a.execution_version=h.execution_version AND a.input_revision=h.input_revision AND a.input_hash=h.input_hash AND a.created_at=h.activated_at
  WHERE h.owner_user_id=p_owner AND h.project_id=p_project AND h.run_id=p_run
   AND h.execution_version=p_execution AND h.input_revision=p_revision AND h.input_hash=p_hash FOR SHARE OF h NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'production successor head changed'
  USING ERRCODE='23514',CONSTRAINT='bb_supplement_adoption_active';END IF;
 -- Quote expiry and available balance are admission checks. Never discard an
 -- in-flight result because the quote expired or its meter exhausted credits.
END;$$;
CREATE FUNCTION bb_successor_execution_origin(p_owner text,p_project text,p_run text,p_execution integer,p_revision integer,p_hash text)
RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT bb_test_successor_execution_origin(p_owner,p_project,p_run,p_execution,p_revision,p_hash)
  OR bb_production_successor_execution_origin(p_owner,p_project,p_run,p_execution,p_revision,p_hash)
$$;
CREATE FUNCTION bb_assert_successor_execution_active(p_owner text,p_project text,p_run text,p_execution integer,p_revision integer,p_hash text)
RETURNS void LANGUAGE plpgsql VOLATILE AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM bb_runs WHERE owner_user_id=p_owner AND project_id=p_project AND id=p_run AND channel='production')
 THEN PERFORM bb_assert_production_successor_execution_active(p_owner,p_project,p_run,p_execution,p_revision,p_hash);
 ELSE PERFORM bb_assert_test_successor_execution_active(p_owner,p_project,p_run,p_execution,p_revision,p_hash);END IF;
END;$$;

CREATE FUNCTION bb_close_run_billing_segment(p_segment text,p_execution integer,p_revision integer,p_hash text,p_disposition text,p_adoption text)
RETURNS void LANGUAGE plpgsql VOLATILE AS $$
DECLARE s bb_run_billing_segments%ROWTYPE;c bb_credit_reservations%ROWTYPE;a bb_run_supplement_adoptions%ROWTYPE;
 closed bb_run_billing_segment_closures%ROWTYPE;allocation record;l bb_credit_lots%ROWTYPE;
 charged bigint;left_to_charge bigint;take bigint;released bigint:=0;refunded bigint:=0;compensation text;
BEGIN
 SELECT * INTO a FROM bb_run_supplement_adoptions WHERE id=p_adoption;
 SELECT * INTO s FROM bb_run_billing_segments WHERE id=p_segment;
 IF a.id IS NULL OR s.id IS NULL OR s.owner_user_id<>a.owner_user_id OR s.project_id<>a.project_id OR s.run_id<>a.run_id
  OR NOT ((p_disposition='superseded' AND a.assignment_kind='rework' AND s.id=a.source_billing_segment_id
    AND p_execution=a.source_execution_version AND p_revision=a.source_input_revision AND p_hash=a.source_input_hash)
   OR (p_disposition IN ('succeeded','failed','cancelled','rejected') AND s.id=a.target_billing_segment_id
    AND p_execution=a.execution_version AND p_revision=a.input_revision AND p_hash=a.input_hash
    AND EXISTS(SELECT 1 FROM bb_runs r JOIN bb_run_execution_heads h ON h.owner_user_id=r.owner_user_id AND h.project_id=r.project_id AND h.run_id=r.id
      WHERE r.owner_user_id=a.owner_user_id AND r.id=a.run_id AND r.state=p_disposition
       AND h.execution_version=p_execution AND h.input_revision=p_revision AND h.input_hash=p_hash)))
 THEN RAISE EXCEPTION 'fee closure must match the adopted source retirement or exact current terminal execution'
  USING ERRCODE='23514',CONSTRAINT='bb_supplement_adoption_fee_closure';END IF;
 PERFORM 1 FROM bb_runs WHERE owner_user_id=a.owner_user_id AND id=a.run_id FOR UPDATE NOWAIT;
 PERFORM 1 FROM bb_credit_accounts WHERE owner_user_id=a.owner_user_id FOR UPDATE;
 SELECT * INTO closed FROM bb_run_billing_segment_closures WHERE billing_segment_id=p_segment;
 IF closed.billing_segment_id IS NOT NULL THEN
  IF closed.adoption_id<>p_adoption OR closed.disposition<>p_disposition OR closed.execution_version<>p_execution
   OR closed.input_revision<>p_revision OR closed.input_hash<>p_hash
  THEN RAISE EXCEPTION 'fee segment already has another immutable closure'
   USING ERRCODE='23514',CONSTRAINT='bb_supplement_adoption_fee_closure';END IF;
  PERFORM bb_assert_billing_segment_closure_record(closed);
  RETURN;
 END IF;
 SELECT * INTO STRICT c FROM bb_credit_reservations WHERE id=s.reservation_id AND owner_user_id=s.owner_user_id AND run_id=s.run_id FOR UPDATE;
 IF c.state<>'held' THEN RAISE EXCEPTION 'active adopted fee reservation required'
  USING ERRCODE='23514',CONSTRAINT='bb_supplement_adoption_fee_closure';END IF;
 IF c.billing_policy='authoring_balance_v2' THEN
  charged:=COALESCE(c.charged_points,0);
  IF p_disposition='succeeded' AND charged<>c.points THEN RAISE EXCEPTION 'Dynamic authoring balance not fully settled'
   USING ERRCODE='23514',CONSTRAINT='bb_supplement_adoption_fee_closure';END IF;
  IF p_disposition IN ('failed','rejected') THEN
   FOR allocation IN SELECT * FROM bb_credit_allocations WHERE reservation_id=c.id AND charged_points>0 ORDER BY lot_id LOOP
    SELECT * INTO STRICT l FROM bb_credit_lots WHERE id=allocation.lot_id AND owner_user_id=a.owner_user_id FOR UPDATE;
    compensation:='dynamic-failure:'||c.id||':'||l.id;
    INSERT INTO bb_credit_lots(id,owner_user_id,source,source_key,original_points,remaining,expires_at)
     VALUES(compensation,a.owner_user_id,CASE WHEN l.source='purchase' THEN 'purchase' ELSE 'correction' END,
      compensation,allocation.charged_points,allocation.charged_points,CASE WHEN l.expires_at<=now() THEN now()+interval '7 days' ELSE l.expires_at END);
    INSERT INTO bb_credit_events(id,owner_user_id,event_key,kind,points,lot_id,reservation_id,run_id,actor,reason)
     VALUES(compensation,a.owner_user_id,compensation,'correction',allocation.charged_points,compensation,c.id,a.run_id,'system','authoring_platform_failure_refund');
    refunded:=refunded+allocation.charged_points;
   END LOOP;
  END IF;
  UPDATE bb_credit_reservations SET state=CASE WHEN p_disposition IN ('failed','rejected') OR charged=0 THEN 'released' ELSE 'settled' END,
   finalized_at=now() WHERE id=c.id;
 ELSE
  -- A retired legacy scope follows its existing cancellation policy using the
  -- already persisted paused meter. Do not recalculate time, price or history.
  charged:=CASE WHEN p_disposition='succeeded' THEN c.points
   WHEN p_disposition IN ('cancelled','superseded') AND c.billing_policy='authoring_progress_v1' THEN
    LEAST(c.points,COALESCE((SELECT accrued_points FROM bb_run_billing_progress WHERE billing_segment_id=s.id),0)) ELSE 0 END;
  left_to_charge:=charged;
  FOR allocation IN SELECT * FROM bb_credit_allocations WHERE reservation_id=c.id ORDER BY lot_id LOOP
   SELECT * INTO STRICT l FROM bb_credit_lots WHERE id=allocation.lot_id AND owner_user_id=a.owner_user_id FOR UPDATE;
   take:=LEAST(allocation.points,left_to_charge);left_to_charge:=left_to_charge-take;
   UPDATE bb_credit_lots SET frozen=frozen-allocation.points,remaining=remaining-take WHERE id=l.id;
   UPDATE bb_credit_allocations SET charged_points=take WHERE reservation_id=c.id AND lot_id=l.id;
   IF p_disposition='failed' AND l.expires_at<=now() THEN
    UPDATE bb_credit_lots SET remaining=remaining-allocation.points WHERE id=l.id;
    compensation:='failure:'||c.id||':'||l.id;
    INSERT INTO bb_credit_lots(id,owner_user_id,source,source_key,original_points,remaining,expires_at)
     VALUES(compensation,a.owner_user_id,'failure_compensation',compensation,allocation.points,allocation.points,now()+interval '7 days');
    INSERT INTO bb_credit_events(id,owner_user_id,event_key,kind,points,lot_id,run_id,actor,reason)
     VALUES(compensation,a.owner_user_id,compensation,'grant',allocation.points,compensation,a.run_id,'system','expired_hold_platform_failure');
   END IF;
  END LOOP;
  IF left_to_charge<>0 THEN RAISE EXCEPTION 'legacy fee allocation is incomplete'
   USING ERRCODE='23514',CONSTRAINT='bb_supplement_adoption_fee_closure';END IF;
  released:=c.points-charged;
  UPDATE bb_credit_reservations SET state=CASE WHEN charged>0 THEN 'settled' ELSE 'released' END,
   charged_points=charged,finalized_at=now() WHERE id=c.id;
  IF charged>0 THEN INSERT INTO bb_credit_events(id,owner_user_id,event_key,kind,points,reservation_id,run_id,actor,reason)
   VALUES('final:'||c.id,a.owner_user_id,'final:'||c.id,'settle',charged,c.id,a.run_id,'system',p_disposition);END IF;
  IF released>0 THEN INSERT INTO bb_credit_events(id,owner_user_id,event_key,kind,points,reservation_id,run_id,actor,reason)
   VALUES('release:'||c.id,a.owner_user_id,'release:'||c.id,'release',released,c.id,a.run_id,'system',p_disposition);END IF;
 END IF;
 UPDATE bb_run_billing_progress SET lease_until=NULL,clock_at=clock_timestamp() WHERE billing_segment_id=s.id;
 INSERT INTO bb_run_billing_segment_closures(billing_segment_id,owner_user_id,project_id,run_id,execution_version,input_revision,input_hash,
  adoption_id,disposition,charged_points,released_points,refunded_points)
 VALUES(s.id,a.owner_user_id,a.project_id,a.run_id,p_execution,p_revision,p_hash,a.id,p_disposition,charged,released,refunded);
 INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload)
 VALUES('billing-segment-closed:'||s.id,a.owner_user_id,'run',a.run_id,'run.billing_segment_closed',
  jsonb_build_object('run_id',a.run_id,'billing_segment_id',s.id,'adoption_id',a.id,'execution_version',p_execution,
   'input_revision',p_revision,'input_hash',p_hash,'disposition',p_disposition,'charged_points',charged,'released_points',released,'refunded_points',refunded));
END;$$;

CREATE FUNCTION bb_adopt_run_supplement_billing(p_adoption text) RETURNS void LANGUAGE plpgsql VOLATILE AS $$
DECLARE a bb_run_supplement_adoptions%ROWTYPE;available bigint;
BEGIN
 SELECT * INTO STRICT a FROM bb_run_supplement_adoptions WHERE id=p_adoption;
 PERFORM 1 FROM bb_runs r JOIN bb_jobs j ON j.owner_user_id=r.owner_user_id AND j.run_id=r.id
  JOIN bb_run_execution_heads h ON h.owner_user_id=r.owner_user_id AND h.project_id=r.project_id AND h.run_id=r.id
  WHERE r.owner_user_id=a.owner_user_id AND r.project_id=a.project_id AND r.id=a.run_id AND j.id=a.job_id
   AND r.state='paused' AND j.state='paused' AND j.user_pause_requested AND j.lease_token IS NULL AND j.lease_until IS NULL
   AND h.execution_version=1 AND h.input_revision=a.source_input_revision AND h.input_hash=a.source_input_hash
  FOR UPDATE OF r,j NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'billing adoption requires the locked exact paused V1 source'
  USING ERRCODE='23514',CONSTRAINT='bb_supplement_adoption_exact';END IF;
 IF EXISTS(SELECT 1 FROM bb_run_execution_billing_bindings WHERE run_id=a.run_id AND execution_version=2) THEN
  IF NOT EXISTS(SELECT 1 FROM bb_run_execution_billing_bindings WHERE run_id=a.run_id AND execution_version=2 AND adoption_id=a.id)
  THEN RAISE EXCEPTION 'successor fee already assigned by another adoption'
   USING ERRCODE='23514',CONSTRAINT='bb_supplement_adoption_exact';END IF;
  RETURN;
 END IF;
 IF a.assignment_kind='unbilled' THEN RETURN;END IF;
 IF a.assignment_kind='rework' THEN
  INSERT INTO bb_credit_accounts(owner_user_id) VALUES(a.owner_user_id) ON CONFLICT DO NOTHING;
  PERFORM 1 FROM bb_credit_accounts WHERE owner_user_id=a.owner_user_id FOR UPDATE;
  IF a.source_billing_segment_id IS NOT NULL THEN
   PERFORM bb_close_run_billing_segment(a.source_billing_segment_id,1,a.source_input_revision,trim(a.source_input_hash),'superseded',a.id);
  END IF;
  SELECT COALESCE(sum(remaining-frozen),0) INTO available FROM bb_credit_lots WHERE owner_user_id=a.owner_user_id
   AND remaining>frozen AND (expires_at IS NULL OR expires_at>now());
  IF available<1 THEN RAISE EXCEPTION 'available credits required to start the additional dynamic fee'
   USING ERRCODE='23514',CONSTRAINT='bb_supplement_adoption_insufficient_credits';END IF;
  INSERT INTO bb_credit_reservations(id,owner_user_id,run_id,quote_id,points,billing_policy,charged_points,created_at)
   VALUES(a.target_billing_segment_id,a.owner_user_id,a.run_id,a.quote_id,a.total_points,'authoring_balance_v2',0,a.created_at);
  INSERT INTO bb_run_billing_segments(id,owner_user_id,project_id,run_id,segment_number,origin_execution_version,origin_input_revision,
   origin_input_hash,reservation_id,source_quote_id,billing_policy,points,created_at,adoption_id)
   VALUES(a.target_billing_segment_id,a.owner_user_id,a.project_id,a.run_id,2,2,a.input_revision,a.input_hash,
    a.target_billing_segment_id,a.quote_id,'authoring_balance_v2',a.total_points,a.created_at,a.id);
  INSERT INTO bb_run_billing_progress(billing_segment_id,owner_user_id,project_id,run_id,clock_at)
   VALUES(a.target_billing_segment_id,a.owner_user_id,a.project_id,a.run_id,a.created_at);
  INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload)
   VALUES('billing-segment-bound:'||a.target_billing_segment_id,a.owner_user_id,'run',a.run_id,'run.billing_segment_bound',
    jsonb_build_object('run_id',a.run_id,'billing_segment_id',a.target_billing_segment_id,'adoption_id',a.id,'execution_version',2,
     'input_revision',a.input_revision,'input_hash',trim(a.input_hash),'source_quote_id',a.quote_id,'billing_policy','authoring_balance_v2',
     'points',a.total_points,'capture_kind','confirmed_rework'));
 ELSE
  PERFORM 1 FROM bb_credit_accounts WHERE owner_user_id=a.owner_user_id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM bb_credit_reservations WHERE id=a.target_billing_segment_id
    AND billing_policy='authoring_balance_v2' AND COALESCE(charged_points,0)<points) THEN
   SELECT COALESCE(sum(remaining-frozen),0) INTO available FROM bb_credit_lots WHERE owner_user_id=a.owner_user_id
    AND remaining>frozen AND (expires_at IS NULL OR expires_at>now());
   IF available<1 THEN RAISE EXCEPTION 'available credits required to continue the remaining original dynamic fee'
    USING ERRCODE='23514',CONSTRAINT='bb_supplement_adoption_insufficient_credits';END IF;
  END IF;
  -- Carry preserves the exact meter prefix and fee cap; paused time stays free.
  UPDATE bb_run_billing_progress SET lease_until=NULL,clock_at=clock_timestamp() WHERE billing_segment_id=a.target_billing_segment_id;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM bb_run_supplement_quotes WHERE id=a.quote_id AND expires_at>clock_timestamp())
 THEN RAISE EXCEPTION 'supplement quote expired while adopting fees'
  USING ERRCODE='23514',CONSTRAINT='bb_supplement_quote_expired';END IF;
 INSERT INTO bb_run_execution_billing_bindings(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash,
  billing_segment_id,assignment_kind,created_at,adoption_id)
 VALUES(a.owner_user_id,a.project_id,a.run_id,2,a.input_revision,a.input_hash,a.target_billing_segment_id,a.assignment_kind,a.created_at,a.id);
END;$$;

CREATE FUNCTION bb_current_billing_segment_id(p_owner text,p_run text) RETURNS text LANGUAGE sql STABLE AS $$
 SELECT b.billing_segment_id FROM bb_run_execution_billing_bindings b JOIN bb_run_execution_heads h
  ON h.owner_user_id=b.owner_user_id AND h.project_id=b.project_id AND h.run_id=b.run_id
   AND h.execution_version=b.execution_version AND h.input_revision=b.input_revision AND h.input_hash=b.input_hash
 WHERE b.owner_user_id=p_owner AND b.run_id=p_run
$$;
CREATE OR REPLACE FUNCTION bb_lock_original_billing_meter() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_segment text;
BEGIN
 IF TG_OP='UPDATE' AND (NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id OR NEW.run_id IS DISTINCT FROM OLD.run_id
  OR (TG_TABLE_NAME='bb_run_billing_progress' AND (to_jsonb(NEW)->'project_id' IS DISTINCT FROM to_jsonb(OLD)->'project_id'
   OR to_jsonb(NEW)->'billing_segment_id' IS DISTINCT FROM to_jsonb(OLD)->'billing_segment_id')))
 THEN RAISE EXCEPTION 'billing meter identity is immutable'
  USING ERRCODE='23514',CONSTRAINT='bb_run_billing_meter_exact';END IF;
 PERFORM 1 FROM bb_runs WHERE owner_user_id=NEW.owner_user_id AND id=NEW.run_id FOR UPDATE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'billing meter requires its exact owned run'
  USING ERRCODE='23514',CONSTRAINT='bb_run_billing_meter_exact';END IF;
 current_segment:=bb_current_billing_segment_id(NEW.owner_user_id,NEW.run_id);
 IF TG_TABLE_NAME='bb_run_billing_progress' THEN
  IF TG_OP='UPDATE' AND NEW IS DISTINCT FROM OLD AND EXISTS(SELECT 1 FROM bb_run_billing_segment_closures
   WHERE billing_segment_id=to_jsonb(NEW)->>'billing_segment_id')
  THEN RAISE EXCEPTION 'closed fee meter is immutable'
   USING ERRCODE='23514',CONSTRAINT='bb_run_billing_meter_exact';END IF;
 ELSE
  IF current_segment IS NOT NULL AND EXISTS(SELECT 1 FROM bb_run_execution_heads WHERE run_id=NEW.run_id AND execution_version=2)
   AND NOT EXISTS(SELECT 1 FROM bb_run_billing_progress m WHERE m.billing_segment_id=current_segment
    AND ROW(m.active_ms,m.work_bps,m.accrued_points,m.clock_at,m.lease_until,m.last_activity_at)
     IS NOT DISTINCT FROM ROW(NEW.active_ms,NEW.work_bps,NEW.accrued_points,NEW.clock_at,NEW.lease_until,NEW.last_activity_at))
  THEN RAISE EXCEPTION 'late legacy writer cannot change an adopted execution meter'
   USING ERRCODE='23514',CONSTRAINT='bb_run_billing_meter_exact';END IF;
 END IF;
 RETURN NEW;
END;$$;
CREATE OR REPLACE FUNCTION bb_mirror_original_billing_progress() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s bb_run_billing_segments%ROWTYPE;current_segment text;
BEGIN
 current_segment:=bb_current_billing_segment_id(NEW.owner_user_id,NEW.run_id);
 IF TG_TABLE_NAME='bb_run_billing_progress' THEN
  IF NEW.billing_segment_id IS DISTINCT FROM current_segment THEN RETURN NEW;END IF;
  PERFORM 1 FROM bb_authoring_progress WHERE run_id=NEW.run_id FOR UPDATE NOWAIT;
  INSERT INTO bb_authoring_progress(run_id,owner_user_id,active_ms,work_bps,accrued_points,clock_at,lease_until,last_activity_at)
   VALUES(NEW.run_id,NEW.owner_user_id,NEW.active_ms,NEW.work_bps,NEW.accrued_points,NEW.clock_at,NEW.lease_until,NEW.last_activity_at)
   ON CONFLICT(run_id) DO UPDATE SET active_ms=excluded.active_ms,work_bps=excluded.work_bps,accrued_points=excluded.accrued_points,
    clock_at=excluded.clock_at,lease_until=excluded.lease_until,last_activity_at=excluded.last_activity_at
   WHERE bb_authoring_progress.owner_user_id=excluded.owner_user_id
    AND ROW(bb_authoring_progress.active_ms,bb_authoring_progress.work_bps,bb_authoring_progress.accrued_points,
     bb_authoring_progress.clock_at,bb_authoring_progress.lease_until,bb_authoring_progress.last_activity_at)
    IS DISTINCT FROM ROW(excluded.active_ms,excluded.work_bps,excluded.accrued_points,excluded.clock_at,excluded.lease_until,excluded.last_activity_at);
 ELSE
  IF current_segment IS NULL THEN RETURN NEW;END IF;
  SELECT * INTO STRICT s FROM bb_run_billing_segments WHERE id=current_segment AND owner_user_id=NEW.owner_user_id AND run_id=NEW.run_id;
  PERFORM 1 FROM bb_run_billing_progress WHERE billing_segment_id=s.id FOR UPDATE NOWAIT;
  INSERT INTO bb_run_billing_progress(billing_segment_id,owner_user_id,project_id,run_id,active_ms,work_bps,accrued_points,clock_at,lease_until,last_activity_at)
   VALUES(s.id,s.owner_user_id,s.project_id,s.run_id,NEW.active_ms,NEW.work_bps,NEW.accrued_points,NEW.clock_at,NEW.lease_until,NEW.last_activity_at)
   ON CONFLICT(billing_segment_id) DO UPDATE SET active_ms=excluded.active_ms,work_bps=excluded.work_bps,accrued_points=excluded.accrued_points,
    clock_at=excluded.clock_at,lease_until=excluded.lease_until,last_activity_at=excluded.last_activity_at
   WHERE ROW(bb_run_billing_progress.active_ms,bb_run_billing_progress.work_bps,bb_run_billing_progress.accrued_points,
     bb_run_billing_progress.clock_at,bb_run_billing_progress.lease_until,bb_run_billing_progress.last_activity_at)
    IS DISTINCT FROM ROW(excluded.active_ms,excluded.work_bps,excluded.accrued_points,excluded.clock_at,excluded.lease_until,excluded.last_activity_at);
 END IF;
 RETURN NEW;
END;$$;
CREATE FUNCTION bb_mirror_adopted_billing_head() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE segment text;
BEGIN
 segment:=bb_current_billing_segment_id(NEW.owner_user_id,NEW.run_id);
 IF segment IS NOT NULL THEN UPDATE bb_run_billing_progress SET clock_at=clock_at WHERE billing_segment_id=segment;
 ELSE UPDATE bb_authoring_progress SET lease_until=NULL,clock_at=clock_timestamp() WHERE owner_user_id=NEW.owner_user_id AND run_id=NEW.run_id;END IF;
 RETURN NEW;
END;$$;
CREATE TRIGGER bb_run_execution_head_billing_mirror AFTER UPDATE ON bb_run_execution_heads
 FOR EACH ROW EXECUTE FUNCTION bb_mirror_adopted_billing_head();

CREATE OR REPLACE FUNCTION bb_assert_original_run_billing(p_owner text,p_run text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r bb_runs%ROWTYPE;current_segment text;
BEGIN
 SELECT * INTO r FROM bb_runs WHERE owner_user_id=p_owner AND id=p_run;
 IF r.id IS NULL THEN RAISE EXCEPTION 'billing run is missing'
  USING ERRCODE='23514',CONSTRAINT='bb_run_billing_capture_exact';END IF;
 IF r.reservation_id IS NULL THEN
  IF EXISTS(SELECT 1 FROM bb_run_billing_segments WHERE run_id=p_run AND origin_execution_version=1)
   OR EXISTS(SELECT 1 FROM bb_run_execution_billing_bindings WHERE run_id=p_run AND execution_version=1)
  THEN RAISE EXCEPTION 'unreserved V1 cannot acquire an original fee'
   USING ERRCODE='23514',CONSTRAINT='bb_run_billing_capture_exact';END IF;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM bb_run_billing_segments s JOIN bb_run_execution_billing_bindings b
   ON b.owner_user_id=s.owner_user_id AND b.project_id=s.project_id AND b.run_id=s.run_id AND b.billing_segment_id=s.id
   WHERE s.id=r.reservation_id AND s.owner_user_id=r.owner_user_id AND s.project_id=r.project_id AND s.run_id=r.id
    AND s.segment_number=1 AND s.origin_execution_version=1 AND s.origin_input_revision=r.input_revision AND s.origin_input_hash=r.input_hash
    AND s.adoption_id IS NULL AND b.execution_version=1 AND b.input_revision=r.input_revision AND b.input_hash=r.input_hash
    AND b.assignment_kind='original' AND b.adoption_id IS NULL AND b.created_at=s.created_at)
  THEN RAISE EXCEPTION 'original run pointer and V1 fee assignment must remain exact'
   USING ERRCODE='23514',CONSTRAINT='bb_run_billing_capture_exact';END IF;
 END IF;
 IF EXISTS(SELECT 1 FROM bb_credit_reservations c LEFT JOIN bb_run_billing_segments s
  ON s.id=c.id AND s.reservation_id=c.id AND s.owner_user_id=c.owner_user_id AND s.run_id=c.run_id
   AND s.source_quote_id=c.quote_id AND s.billing_policy=c.billing_policy AND s.points=c.points AND s.created_at=c.created_at
  LEFT JOIN bb_run_billing_progress m ON m.billing_segment_id=s.id AND m.owner_user_id=s.owner_user_id AND m.project_id=s.project_id AND m.run_id=s.run_id
  LEFT JOIN bb_run_execution_versions e ON e.owner_user_id=s.owner_user_id AND e.project_id=s.project_id AND e.run_id=s.run_id
   AND e.execution_version=s.origin_execution_version AND e.input_revision=s.origin_input_revision AND e.input_hash=s.origin_input_hash
  WHERE c.run_id=p_run AND (c.owner_user_id<>p_owner OR s.id IS NULL OR m.billing_segment_id IS NULL OR e.run_id IS NULL OR s.project_id<>r.project_id
   OR (s.origin_execution_version=1 AND s.id IS DISTINCT FROM r.reservation_id)
   OR (s.origin_execution_version=2 AND NOT EXISTS(SELECT 1 FROM bb_run_supplement_adoptions a WHERE a.id=s.adoption_id
    AND a.owner_user_id=p_owner AND a.run_id=p_run AND a.assignment_kind='rework' AND a.target_billing_segment_id=s.id))))
 THEN RAISE EXCEPTION 'every reservation requires its exact original or adopted fee segment and meter'
  USING ERRCODE='23514',CONSTRAINT='bb_run_billing_capture_exact';END IF;
 IF EXISTS(SELECT 1 FROM bb_run_supplement_adoptions a WHERE a.owner_user_id=p_owner AND a.run_id=p_run
  AND NOT bb_production_successor_execution_origin(a.owner_user_id,a.project_id,a.run_id,a.execution_version,a.input_revision,a.input_hash))
 THEN RAISE EXCEPTION 'adopted billing assignment is incomplete'
  USING ERRCODE='23514',CONSTRAINT='bb_run_billing_capture_exact';END IF;
 current_segment:=bb_current_billing_segment_id(p_owner,p_run);
 IF current_segment IS NOT NULL AND NOT EXISTS(SELECT 1 FROM bb_run_billing_progress m JOIN bb_authoring_progress legacy
  ON legacy.owner_user_id=m.owner_user_id AND legacy.run_id=m.run_id
  WHERE m.billing_segment_id=current_segment AND ROW(m.active_ms,m.work_bps,m.accrued_points,m.clock_at,m.lease_until,m.last_activity_at)
   IS NOT DISTINCT FROM ROW(legacy.active_ms,legacy.work_bps,legacy.accrued_points,legacy.clock_at,legacy.lease_until,legacy.last_activity_at))
 THEN RAISE EXCEPTION 'current execution fee meter requires its exact legacy compatibility mirror'
  USING ERRCODE='23514',CONSTRAINT='bb_run_billing_capture_exact';END IF;
END;$$;

CREATE FUNCTION bb_check_production_supplement_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r bb_runs%ROWTYPE;j bb_jobs%ROWTYPE;w bb_run_supplement_saved_work%ROWTYPE;
BEGIN
 SELECT * INTO r FROM bb_runs WHERE owner_user_id=NEW.owner_user_id AND project_id=NEW.project_id AND id=NEW.run_id;
 SELECT * INTO j FROM bb_jobs WHERE owner_user_id=NEW.owner_user_id AND run_id=NEW.run_id AND id=NEW.job_id;
 SELECT * INTO w FROM bb_run_supplement_saved_work WHERE owner_user_id=NEW.owner_user_id AND project_id=NEW.project_id
  AND run_id=NEW.run_id AND supplement_revision=NEW.supplement_revision;
 IF NOT COALESCE(bb_production_successor_execution_origin(NEW.owner_user_id,NEW.project_id,NEW.run_id,2,NEW.input_revision,NEW.input_hash),false)
  OR r.state<>'queued' OR r.stage<>'queued' OR j.state<>'queued' OR j.stage<>'queued'
  OR j.user_pause_requested OR j.credit_pause_requested OR j.lease_token IS NOT NULL OR j.lease_until IS NOT NULL
  OR j.checkpoint->'stages' IS DISTINCT FROM '{}'::jsonb
  OR j.checkpoint->'stage_execution' IS DISTINCT FROM jsonb_build_object('execution_version',2,'input_revision',NEW.input_revision,'input_hash',trim(NEW.input_hash))
  OR (j.checkpoint-ARRAY['stages','stage_execution','provider_results','operator_reconciliations'])<>'{}'::jsonb
  OR COALESCE(j.checkpoint->'provider_results','[]'::jsonb) IS DISTINCT FROM COALESCE(w.source_checkpoint->'provider_results','[]'::jsonb)
  OR COALESCE(j.checkpoint->'operator_reconciliations','[]'::jsonb) IS DISTINCT FROM COALESCE(w.source_checkpoint->'operator_reconciliations','[]'::jsonb)
  OR (SELECT count(*) FROM bb_run_execution_versions WHERE run_id=NEW.run_id)<>2
  OR NOT EXISTS(SELECT 1 FROM bb_run_execution_heads WHERE owner_user_id=NEW.owner_user_id AND project_id=NEW.project_id AND run_id=NEW.run_id
    AND execution_version=2 AND input_revision=NEW.input_revision AND input_hash=NEW.input_hash AND activated_at=NEW.created_at)
  OR (NEW.kind='review' AND NOT EXISTS(SELECT 1 FROM bb_review_execution_snapshots WHERE owner_user_id=NEW.owner_user_id AND project_id=NEW.project_id
    AND run_id=NEW.run_id AND execution_version=2 AND input_revision=NEW.input_revision AND input_hash=NEW.input_hash))
  OR (NEW.kind='m4' AND NOT EXISTS(SELECT 1 FROM bb_m4_execution_snapshots WHERE owner_user_id=NEW.owner_user_id AND project_id=NEW.project_id
    AND run_id=NEW.run_id AND execution_version=2 AND input_revision=NEW.input_revision AND input_hash=NEW.input_hash))
  OR (NEW.kind<>'review' AND EXISTS(SELECT 1 FROM bb_review_execution_snapshots WHERE run_id=NEW.run_id AND execution_version=2))
  OR (NEW.kind<>'m4' AND EXISTS(SELECT 1 FROM bb_m4_execution_snapshots WHERE run_id=NEW.run_id AND execution_version=2))
  OR NOT EXISTS(SELECT 1 FROM bb_run_events event WHERE event.owner_user_id=NEW.owner_user_id AND event.run_id=NEW.run_id
    AND event.type='run.state_changed' AND event.state='queued' AND event.payload->>'adoption_id'=NEW.id
    AND event.payload->'execution_version'='2'::jsonb AND event.payload->>'input_hash'=trim(NEW.input_hash))
  OR NOT EXISTS(SELECT 1 FROM bb_outbox event WHERE event.owner_user_id=NEW.owner_user_id AND event.aggregate_id=NEW.run_id
    AND event.event_type='run.state_changed' AND event.payload->>'adoption_id'=NEW.id)
  OR (NEW.assignment_kind='rework' AND NOT EXISTS(SELECT 1 FROM bb_credit_reservations c JOIN bb_run_billing_progress m ON m.billing_segment_id=c.id
    WHERE c.id=NEW.target_billing_segment_id AND c.state='held' AND COALESCE(c.charged_points,0)=0
     AND m.active_ms=0 AND m.work_bps=0 AND m.accrued_points=0 AND m.lease_until IS NULL
     AND NOT EXISTS(SELECT 1 FROM bb_credit_allocations WHERE reservation_id=c.id)
     AND NOT EXISTS(SELECT 1 FROM bb_credit_events WHERE reservation_id=c.id)))
  OR (NEW.assignment_kind='carry' AND NOT EXISTS(SELECT 1 FROM bb_credit_reservations c WHERE c.id=NEW.target_billing_segment_id
    AND c.state='held' AND NOT EXISTS(SELECT 1 FROM bb_run_billing_segment_closures WHERE billing_segment_id=c.id)))
 THEN RAISE EXCEPTION 'production adoption must commit exact authority, fee closure/carry, snapshots, head and fresh queue atomically'
  USING ERRCODE='23514',CONSTRAINT='bb_supplement_adoption_complete';END IF;
 IF NOT EXISTS(SELECT 1 FROM bb_run_supplement_quotes WHERE id=NEW.quote_id AND expires_at>clock_timestamp())
 THEN RAISE EXCEPTION 'supplement quote expired before adoption committed'
  USING ERRCODE='23514',CONSTRAINT='bb_supplement_quote_expired';END IF;
 PERFORM bb_assert_original_run_billing(NEW.owner_user_id,NEW.run_id);
 RETURN NEW;
END;$$;
CREATE CONSTRAINT TRIGGER bb_supplement_adoption_complete AFTER INSERT ON bb_run_supplement_adoptions
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bb_check_production_supplement_complete();

-- A common immutable origin projection is used only by canonical successor
-- guards. Test admission/live-grant functions themselves remain unchanged.
CREATE VIEW bb_run_successor_authorizations AS
 SELECT id,owner_user_id,project_id,run_id,job_id,source_execution_version,source_input_revision,source_input_hash,
  supplement_revision,processing_plan_id,request_id,request_hash,execution_version,input_revision,input_hash,test_grant_id,created_at
 FROM bb_run_test_successor_authorizations
 UNION ALL
 SELECT id,owner_user_id,project_id,run_id,job_id,source_execution_version,source_input_revision,source_input_hash,
  supplement_revision,processing_plan_id,request_id,request_hash,execution_version,input_revision,input_hash,NULL::text,created_at
 FROM bb_run_supplement_adoptions;

DO $$ DECLARE definition text;name text;expected integer;actual integer;
BEGIN
 FOREACH name IN ARRAY ARRAY['bb_check_initial_execution','bb_check_review_execution_snapshot','bb_check_m4_execution_snapshot','bb_material_bytes_pinned'] LOOP
  SELECT pg_get_functiondef(p.oid) INTO STRICT definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE p.proname=name AND n.nspname=current_schema();
  expected:=CASE WHEN name='bb_material_bytes_pinned' THEN 2 ELSE 1 END;
  actual:=(length(definition)-length(replace(definition,'bb_run_test_successor_authorizations','')))/length('bb_run_test_successor_authorizations');
  IF actual<>expected THEN RAISE EXCEPTION 'Unexpected canonical successor origin predecessor: %',name;END IF;
  definition:=replace(definition,'bb_run_test_successor_authorizations','bb_run_successor_authorizations');
  IF name='bb_check_initial_execution' THEN
   IF strpos(definition,'r.channel=''non_production_test'' AND r.state=''paused''')=0 THEN RAISE EXCEPTION 'Unexpected initial execution channel predecessor';END IF;
   definition:=replace(definition,'r.channel=''non_production_test'' AND r.state=''paused''','r.channel IN (''non_production_test'',''production'') AND r.state=''paused''');
  END IF;
  EXECUTE definition;
 END LOOP;
END;$$;

DO $$ DECLARE definition text;marker text;production_branch text;
BEGIN
 SELECT pg_get_functiondef('bb_guard_test_successor_head()'::regprocedure) INTO definition;
 marker:='IF NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW;END IF;';
 production_branch:=$branch$
 IF EXISTS(SELECT 1 FROM bb_run_supplement_adoptions a WHERE a.owner_user_id=NEW.owner_user_id AND a.project_id=NEW.project_id
  AND a.run_id=NEW.run_id AND a.execution_version=NEW.execution_version AND a.input_revision=NEW.input_revision AND a.input_hash=NEW.input_hash) THEN
  IF ROW(NEW.owner_user_id,NEW.project_id,NEW.run_id) IS DISTINCT FROM ROW(OLD.owner_user_id,OLD.project_id,OLD.run_id)
   OR OLD.execution_version<>1 OR NEW.execution_version<>2
   OR NOT EXISTS(SELECT 1 FROM bb_run_supplement_adoptions a JOIN bb_runs r
    ON r.owner_user_id=a.owner_user_id AND r.project_id=a.project_id AND r.id=a.run_id
    JOIN bb_jobs j ON j.owner_user_id=a.owner_user_id AND j.run_id=a.run_id AND j.id=a.job_id
    WHERE a.owner_user_id=NEW.owner_user_id AND a.project_id=NEW.project_id AND a.run_id=NEW.run_id
     AND a.source_execution_version=OLD.execution_version AND a.source_input_revision=OLD.input_revision AND a.source_input_hash=OLD.input_hash
     AND a.execution_version=NEW.execution_version AND a.input_revision=NEW.input_revision AND a.input_hash=NEW.input_hash AND a.created_at=NEW.activated_at
     AND r.channel='production' AND j.channel='production' AND r.state='paused' AND j.state='paused' AND j.user_pause_requested
     AND j.lease_token IS NULL AND j.lease_until IS NULL
     AND bb_production_successor_execution_origin(a.owner_user_id,a.project_id,a.run_id,a.execution_version,a.input_revision,a.input_hash))
  THEN RAISE EXCEPTION 'production head requires exact atomic V1 to V2 authority and fee assignment'
   USING ERRCODE='23514',CONSTRAINT='bb_supplement_adoption_head';END IF;
  PERFORM bb_assert_material_lifecycle_available(NEW.owner_user_id,NEW.project_id,NEW.input_revision);
  RETURN NEW;
 END IF;
$branch$;
 IF strpos(definition,marker)=0 OR strpos(definition,'bb_non_production_test_grants')=0 THEN RAISE EXCEPTION 'Unexpected test head predecessor';END IF;
 EXECUTE replace(definition,marker,marker||production_branch);
END;$$;

-- Open every explicit canonical producer/registration/view to the parallel
-- production authority. Legacy V1 defaults and V2 mirror no-ops stay intact.
DO $$ DECLARE definition text;name text;
BEGIN
 FOREACH name IN ARRAY ARRAY['bb_check_prompt_explicit_execution','bb_bind_artifact_execution','bb_check_model_call_execution_binding',
  'bb_check_run_working_source','bb_check_artifact_execution_binding','bb_check_review_execution_editor','bb_check_review_execution_report',
  'bb_check_review_execution_artifact','bb_check_m4_execution_artifact','bb_guard_review_execution_artifact','bb_review_delivery_ready'] LOOP
  SELECT pg_get_functiondef(p.oid) INTO STRICT definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE p.proname=name AND n.nspname=current_schema();
  IF strpos(definition,'bb_assert_test_successor_execution_active')=0 AND strpos(definition,'bb_test_successor_execution_origin')=0
  THEN RAISE EXCEPTION 'Unexpected explicit successor guard predecessor: %',name;END IF;
  definition:=replace(definition,'bb_assert_test_successor_execution_active','bb_assert_successor_execution_active');
  definition:=replace(definition,'bb_test_successor_execution_origin','bb_successor_execution_origin');
  EXECUTE definition;
 END LOOP;
 FOREACH name IN ARRAY ARRAY['bb_execution_artifact_versions','bb_review_execution_artifact_versions','bb_m4_execution_artifact_versions'] LOOP
  SELECT pg_get_viewdef(name::regclass,true) INTO definition;
  IF strpos(definition,'bb_test_successor_execution_origin')=0 THEN RAISE EXCEPTION 'Unexpected successor origin view predecessor: %',name;END IF;
  EXECUTE 'CREATE OR REPLACE VIEW '||quote_ident(name)||' AS '||replace(definition,'bb_test_successor_execution_origin','bb_successor_execution_origin');
 END LOOP;
END;$$;

DO $$ DECLARE definition text;old_gate text;new_gate text;
BEGIN
 SELECT pg_get_functiondef('bb_run_execution_delivery_plan(text,text,text,text)'::regprocedure) INTO definition;
 definition:=replace(definition,E'\r\n',E'\n');
 old_gate:=$old$IF phase<>'final' OR origin<>'terminal_transition' OR r.state<>'test_completed' OR j.state<>'test_completed' THEN$old$;
 new_gate:=$new$IF phase<>'final' OR origin<>'terminal_transition'
  OR (r.channel='non_production_test' AND (r.state<>'test_completed' OR j.state<>'test_completed'))
  OR (r.channel='production' AND (r.state<>'succeeded' OR j.state<>'succeeded')) THEN$new$;
 IF strpos(definition,old_gate)=0 OR strpos(definition,'bb_assert_test_successor_execution_active')=0
  OR strpos(definition,'SELECT test_grant_id INTO STRICT d.test_grant_id FROM bb_run_test_successor_authorizations')=0
 THEN RAISE EXCEPTION 'Unexpected successor Word delivery predecessor';END IF;
 definition:=replace(definition,old_gate,new_gate);
 definition:=replace(definition,'bb_assert_test_successor_execution_active','bb_assert_successor_execution_active');
 definition:=replace(definition,'SELECT test_grant_id INTO STRICT d.test_grant_id FROM bb_run_test_successor_authorizations',
  'SELECT test_grant_id INTO STRICT d.test_grant_id FROM bb_run_successor_authorizations');
 definition:=replace(definition,'IF phase=''m4_durable'' THEN',
  'IF phase=''m4_durable'' AND EXISTS(SELECT 1 FROM bb_run_execution_heads WHERE run_id=r.id AND execution_version=2) THEN RETURN NULL;END IF; IF phase=''m4_durable'' THEN');
 EXECUTE definition;
END;$$;

-- Original deployed finalizers retain every V1 financial path. A production
-- successor is finalized independently against its current assigned fee only.
DO $$ DECLARE definition text;name text;dispatch text;
BEGIN
 dispatch:=$dispatch$BEGIN
 IF NEW.channel='production' AND EXISTS(SELECT 1 FROM bb_run_execution_heads WHERE owner_user_id=NEW.owner_user_id
  AND project_id=NEW.project_id AND run_id=NEW.id AND execution_version=2) THEN RETURN NEW;END IF;
$dispatch$;
 FOREACH name IN ARRAY ARRAY['bb_credit_finalize_run','bb_m4_credit_finalize_run'] LOOP
  SELECT pg_get_functiondef((name||'()')::regprocedure) INTO definition;
  definition:=replace(definition,E'\r\n',E'\n');
  IF strpos(definition,'bb_assert_original_run_billing')=0 OR strpos(definition,'authoring_platform_failure_refund')=0
   OR strpos(definition,E'BEGIN\n')=0 THEN RAISE EXCEPTION 'Unexpected original segment finalizer predecessor';END IF;
  EXECUTE replace(definition,E'BEGIN\n',dispatch);
 END LOOP;
END;$$;
CREATE FUNCTION bb_finalize_production_successor_billing() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a bb_run_supplement_adoptions%ROWTYPE;delivery jsonb;
BEGIN
 IF NEW.channel<>'production' OR NEW.state NOT IN ('succeeded','failed','cancelled','rejected') OR OLD.state=NEW.state THEN RETURN NEW;END IF;
 SELECT adoption.* INTO a FROM bb_run_supplement_adoptions adoption JOIN bb_run_execution_heads h
  ON h.owner_user_id=adoption.owner_user_id AND h.project_id=adoption.project_id AND h.run_id=adoption.run_id
   AND h.execution_version=adoption.execution_version AND h.input_revision=adoption.input_revision AND h.input_hash=adoption.input_hash
  WHERE adoption.owner_user_id=NEW.owner_user_id AND adoption.project_id=NEW.project_id AND adoption.run_id=NEW.id;
 IF a.id IS NULL THEN RETURN NEW;END IF;
 IF NOT COALESCE(bb_production_successor_execution_origin(a.owner_user_id,a.project_id,a.run_id,2,a.input_revision,a.input_hash),false)
 THEN RAISE EXCEPTION 'terminal billing requires the exact adopted execution and fee'
  USING ERRCODE='23514',CONSTRAINT='bb_supplement_adoption_fee_closure';END IF;
 IF NEW.state='succeeded' THEN
  delivery:=bb_run_execution_delivery_plan(NEW.owner_user_id,NEW.id,'terminal_transition');
  IF delivery IS NULL OR (delivery->>'execution_version')::integer<>2 OR delivery->>'input_hash' IS DISTINCT FROM trim(a.input_hash)
  THEN RAISE EXCEPTION 'exact delivered successor Word outputs required for fee settlement'
   USING ERRCODE='23514',CONSTRAINT='bb_supplement_adoption_fee_closure';END IF;
 END IF;
 IF a.target_billing_segment_id IS NOT NULL THEN
  PERFORM bb_close_run_billing_segment(a.target_billing_segment_id,2,a.input_revision,trim(a.input_hash),NEW.state,a.id);
 END IF;
 RETURN NEW;
END;$$;
CREATE TRIGGER bb_production_successor_billing_finalize AFTER UPDATE OF state ON bb_runs
 FOR EACH ROW EXECUTE FUNCTION bb_finalize_production_successor_billing();

COMMENT ON TABLE bb_run_supplement_adoptions IS
 'Immutable production V1-to-V2 adoption only after exact B1 confirmation and byte-verified preparation; atomic fee closure/carry, execution, head and queue required.';
COMMENT ON TABLE bb_run_billing_segment_closures IS
 'Immutable fee-specific finalization or source retirement. Positive successor failures refund their own fee only; carry keeps one original fee and meter.';

-- Closing a fee is a durable financial boundary, including against direct SQL.
CREATE FUNCTION bb_assert_billing_segment_closure_record(x bb_run_billing_segment_closures) RETURNS void LANGUAGE plpgsql STABLE AS $$
DECLARE s bb_run_billing_segments%ROWTYPE;c bb_credit_reservations%ROWTYPE;a bb_run_supplement_adoptions%ROWTYPE;
BEGIN
 SELECT * INTO s FROM bb_run_billing_segments WHERE id=x.billing_segment_id;
 SELECT * INTO c FROM bb_credit_reservations WHERE id=s.reservation_id;
 SELECT * INTO a FROM bb_run_supplement_adoptions WHERE id=x.adoption_id;
 IF s.id IS NULL OR c.id IS NULL OR a.id IS NULL
  OR x.owner_user_id<>s.owner_user_id OR x.project_id<>s.project_id OR x.run_id<>s.run_id
  OR a.owner_user_id<>s.owner_user_id OR a.project_id<>s.project_id OR a.run_id<>s.run_id
  OR c.owner_user_id<>s.owner_user_id OR c.run_id<>s.run_id OR c.quote_id<>s.source_quote_id OR c.points<>s.points OR c.billing_policy<>s.billing_policy
  OR NOT ((x.disposition='superseded' AND a.assignment_kind='rework' AND s.id=a.source_billing_segment_id
    AND x.execution_version=a.source_execution_version AND x.input_revision=a.source_input_revision AND x.input_hash=a.source_input_hash)
   OR (x.disposition IN ('succeeded','failed','cancelled','rejected') AND s.id=a.target_billing_segment_id
    AND x.execution_version=a.execution_version AND x.input_revision=a.input_revision AND x.input_hash=a.input_hash
    AND EXISTS(SELECT 1 FROM bb_runs r WHERE r.owner_user_id=a.owner_user_id AND r.id=a.run_id AND r.state=x.disposition)))
  OR x.charged_points<>COALESCE(c.charged_points,0) OR x.charged_points>c.points OR c.finalized_at IS NULL
  OR c.state<>(CASE WHEN c.billing_policy='authoring_balance_v2' AND x.disposition IN ('failed','rejected') OR x.charged_points=0 THEN 'released' ELSE 'settled' END)
  OR x.released_points<>(CASE WHEN c.billing_policy='authoring_balance_v2' THEN 0 ELSE c.points-x.charged_points END)
  OR x.refunded_points<>(CASE WHEN c.billing_policy='authoring_balance_v2' AND x.disposition IN ('failed','rejected') THEN x.charged_points ELSE 0 END)
  OR NOT EXISTS(SELECT 1 FROM bb_run_billing_progress m WHERE m.billing_segment_id=s.id AND m.owner_user_id=s.owner_user_id
    AND m.project_id=s.project_id AND m.run_id=s.run_id AND m.lease_until IS NULL)
  OR x.charged_points<>(SELECT COALESCE(sum(charged_points),0) FROM bb_credit_allocations WHERE reservation_id=c.id)
  OR x.charged_points<>(SELECT COALESCE(sum(points),0) FROM bb_credit_events WHERE reservation_id=c.id AND kind='settle')
  OR (c.billing_policy='authoring_balance_v2' AND (EXISTS(SELECT 1 FROM bb_credit_events WHERE reservation_id=c.id AND kind IN ('reserve','release'))
    OR x.charged_points<>(SELECT COALESCE(sum(points),0) FROM bb_credit_allocations WHERE reservation_id=c.id)))
  OR (c.billing_policy<>'authoring_balance_v2' AND (c.points<>(SELECT COALESCE(sum(points),0) FROM bb_credit_allocations WHERE reservation_id=c.id)
    OR x.released_points<>(SELECT COALESCE(sum(points),0) FROM bb_credit_events WHERE reservation_id=c.id AND kind='release')))
  OR (x.refunded_points>0 AND EXISTS(SELECT 1 FROM bb_credit_allocations allocation WHERE allocation.reservation_id=c.id AND allocation.charged_points>0
    AND NOT EXISTS(SELECT 1 FROM bb_credit_events event WHERE event.owner_user_id=c.owner_user_id AND event.reservation_id=c.id
      AND event.event_key='dynamic-failure:'||c.id||':'||allocation.lot_id AND event.kind='correction' AND event.points=allocation.charged_points
      AND event.reason='authoring_platform_failure_refund')))
 THEN RAISE EXCEPTION 'fee closure must retain exact adoption, execution, reservation, allocation and ledger amounts'
  USING ERRCODE='23514',CONSTRAINT='bb_supplement_adoption_fee_closure';END IF;
END;$$;
CREATE FUNCTION bb_check_billing_segment_closure() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 NEW.closed_at=clock_timestamp();
 PERFORM bb_assert_billing_segment_closure_record(NEW);
 RETURN NEW;
END;$$;
CREATE TRIGGER bb_run_billing_closure_exact BEFORE INSERT ON bb_run_billing_segment_closures
 FOR EACH ROW EXECUTE FUNCTION bb_check_billing_segment_closure();
CREATE FUNCTION bb_guard_closed_billing_reservation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM bb_run_billing_segment_closures WHERE billing_segment_id=OLD.id)
  AND ROW(NEW.state,NEW.charged_points,NEW.finalized_at) IS DISTINCT FROM ROW(OLD.state,OLD.charged_points,OLD.finalized_at)
 THEN RAISE EXCEPTION 'closed fee reservation financial state is immutable'
  USING ERRCODE='23514',CONSTRAINT='bb_supplement_adoption_fee_closure';END IF;
 RETURN NEW;
END;$$;
CREATE TRIGGER bb_credit_reservation_closed_immutable BEFORE UPDATE ON bb_credit_reservations
 FOR EACH ROW EXECUTE FUNCTION bb_guard_closed_billing_reservation();
