-- Canonical original-execution billing identity. This migration neither admits
-- paid successors nor removes the existing one-reservation-per-run constraint.
-- Drain writers and retry if busy; never wait holding a partial deployment set.
LOCK TABLE bb_runs IN EXCLUSIVE MODE NOWAIT;
LOCK TABLE bb_run_execution_versions IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE bb_credit_reservations IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE bb_authoring_progress IN ACCESS EXCLUSIVE MODE NOWAIT;

CREATE TABLE bb_run_billing_segments (
  id text PRIMARY KEY, owner_user_id text NOT NULL, project_id text NOT NULL, run_id text NOT NULL,
  segment_number integer NOT NULL CHECK(segment_number=1),
  origin_execution_version integer NOT NULL CHECK(origin_execution_version=1),
  origin_input_revision integer NOT NULL CHECK(origin_input_revision>0),
  origin_input_hash char(64) NOT NULL CHECK(origin_input_hash ~ '^[a-f0-9]{64}$'),
  reservation_id text NOT NULL UNIQUE CHECK(reservation_id=id),
  source_quote_id text NOT NULL, billing_policy text NOT NULL,
  points bigint NOT NULL CHECK(points>0), created_at timestamptz NOT NULL,
  UNIQUE(run_id,segment_number), UNIQUE(owner_user_id,project_id,run_id,id),
  FOREIGN KEY(owner_user_id,reservation_id) REFERENCES bb_credit_reservations(owner_user_id,id),
  FOREIGN KEY(owner_user_id,project_id,run_id,origin_execution_version,origin_input_revision,origin_input_hash)
    REFERENCES bb_run_execution_versions(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash)
);

CREATE TABLE bb_run_execution_billing_bindings (
  owner_user_id text NOT NULL, project_id text NOT NULL, run_id text NOT NULL,
  execution_version integer NOT NULL CHECK(execution_version=1),
  input_revision integer NOT NULL CHECK(input_revision>0),
  input_hash char(64) NOT NULL CHECK(input_hash ~ '^[a-f0-9]{64}$'),
  billing_segment_id text NOT NULL UNIQUE,
  assignment_kind text NOT NULL CHECK(assignment_kind='original'),
  created_at timestamptz NOT NULL,
  PRIMARY KEY(run_id,execution_version),
  FOREIGN KEY(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash)
    REFERENCES bb_run_execution_versions(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash),
  FOREIGN KEY(owner_user_id,project_id,run_id,billing_segment_id)
    REFERENCES bb_run_billing_segments(owner_user_id,project_id,run_id,id)
);

CREATE TABLE bb_run_billing_progress (
  billing_segment_id text PRIMARY KEY,
  owner_user_id text NOT NULL, project_id text NOT NULL, run_id text NOT NULL,
  active_ms bigint NOT NULL DEFAULT 0 CHECK(active_ms>=0),
  work_bps integer NOT NULL DEFAULT 0 CHECK(work_bps BETWEEN 0 AND 2500),
  accrued_points bigint NOT NULL DEFAULT 0 CHECK(accrued_points>=0),
  clock_at timestamptz NOT NULL DEFAULT now(), lease_until timestamptz, last_activity_at timestamptz,
  FOREIGN KEY(owner_user_id,project_id,run_id,billing_segment_id)
    REFERENCES bb_run_billing_segments(owner_user_id,project_id,run_id,id)
);

CREATE FUNCTION bb_reject_billing_identity_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'original billing identity is immutable'
  USING ERRCODE='23514',CONSTRAINT='bb_run_billing_immutable'; END;$$;
CREATE TRIGGER bb_run_billing_segment_immutable BEFORE UPDATE OR DELETE ON bb_run_billing_segments
  FOR EACH ROW EXECUTE FUNCTION bb_reject_billing_identity_change();
CREATE TRIGGER bb_run_billing_segment_no_truncate BEFORE TRUNCATE ON bb_run_billing_segments
  FOR EACH STATEMENT EXECUTE FUNCTION bb_reject_billing_identity_change();
CREATE TRIGGER bb_run_execution_billing_immutable BEFORE UPDATE OR DELETE ON bb_run_execution_billing_bindings
  FOR EACH ROW EXECUTE FUNCTION bb_reject_billing_identity_change();
CREATE TRIGGER bb_run_execution_billing_no_truncate BEFORE TRUNCATE ON bb_run_execution_billing_bindings
  FOR EACH STATEMENT EXECUTE FUNCTION bb_reject_billing_identity_change();

CREATE FUNCTION bb_check_original_billing_segment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(
    SELECT 1 FROM bb_credit_reservations c
    JOIN bb_runs r ON r.owner_user_id=c.owner_user_id AND r.id=c.run_id AND r.reservation_id=c.id
    JOIN bb_run_execution_versions e ON e.owner_user_id=r.owner_user_id AND e.project_id=r.project_id
      AND e.run_id=r.id AND e.execution_version=1 AND e.input_revision=r.input_revision AND e.input_hash=r.input_hash
    WHERE c.id=NEW.id AND c.id=NEW.reservation_id AND c.owner_user_id=NEW.owner_user_id
      AND r.project_id=NEW.project_id AND c.run_id=NEW.run_id
      AND NEW.segment_number=1 AND NEW.origin_execution_version=e.execution_version
      AND NEW.origin_input_revision=e.input_revision AND NEW.origin_input_hash=e.input_hash
      AND NEW.source_quote_id=c.quote_id AND NEW.billing_policy=c.billing_policy
      AND NEW.points=c.points AND NEW.created_at=c.created_at
      AND r.billing_mode IN ('fixed_credits','metered_credits')
  ) THEN RAISE EXCEPTION 'billing segment must retain the exact original owned reservation and execution'
    USING ERRCODE='23514',CONSTRAINT='bb_run_billing_segment_exact'; END IF;
  RETURN NEW;
END;$$;
CREATE TRIGGER bb_run_billing_segment_exact BEFORE INSERT ON bb_run_billing_segments
  FOR EACH ROW EXECUTE FUNCTION bb_check_original_billing_segment();

CREATE FUNCTION bb_check_original_billing_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM bb_run_billing_segments s WHERE s.id=NEW.billing_segment_id
    AND s.owner_user_id=NEW.owner_user_id AND s.project_id=NEW.project_id AND s.run_id=NEW.run_id
    AND s.origin_execution_version=NEW.execution_version AND s.origin_input_revision=NEW.input_revision
    AND s.origin_input_hash=NEW.input_hash AND NEW.assignment_kind='original' AND NEW.created_at=s.created_at)
  THEN RAISE EXCEPTION 'billing assignment must retain the complete original execution identity'
    USING ERRCODE='23514',CONSTRAINT='bb_run_billing_binding_exact'; END IF;
  RETURN NEW;
END;$$;
CREATE TRIGGER bb_run_billing_binding_exact BEFORE INSERT ON bb_run_execution_billing_bindings
  FOR EACH ROW EXECUTE FUNCTION bb_check_original_billing_binding();

-- No financial value is changed by capture. The original reservation remains
-- the cap; its creation time and already-debited ledger remain historical facts.
CREATE FUNCTION bb_capture_original_run_billing(p_owner text,p_run text,p_historical boolean DEFAULT false) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r bb_runs%ROWTYPE;c bb_credit_reservations%ROWTYPE;captured_id text;
BEGIN
  SELECT * INTO r FROM bb_runs WHERE owner_user_id=p_owner AND id=p_run;
  IF r.id IS NULL OR r.reservation_id IS NULL THEN RETURN; END IF;
  SELECT * INTO c FROM bb_credit_reservations WHERE owner_user_id=p_owner AND run_id=p_run AND id=r.reservation_id;
  IF c.id IS NULL THEN RAISE EXCEPTION 'original billing reservation is missing'
    USING ERRCODE='23514',CONSTRAINT='bb_run_billing_capture_exact'; END IF;
  INSERT INTO bb_run_billing_segments(id,owner_user_id,project_id,run_id,segment_number,
    origin_execution_version,origin_input_revision,origin_input_hash,reservation_id,source_quote_id,billing_policy,points,created_at)
    VALUES(c.id,r.owner_user_id,r.project_id,r.id,1,1,r.input_revision,r.input_hash,c.id,c.quote_id,c.billing_policy,c.points,c.created_at)
    ON CONFLICT DO NOTHING RETURNING id INTO captured_id;
  INSERT INTO bb_run_execution_billing_bindings(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash,
    billing_segment_id,assignment_kind,created_at)
    VALUES(r.owner_user_id,r.project_id,r.id,1,r.input_revision,r.input_hash,c.id,'original',c.created_at)
    ON CONFLICT DO NOTHING;
  INSERT INTO bb_run_billing_progress(billing_segment_id,owner_user_id,project_id,run_id,
    active_ms,work_bps,accrued_points,clock_at,lease_until,last_activity_at)
    SELECT c.id,r.owner_user_id,r.project_id,r.id,active_ms,work_bps,accrued_points,clock_at,lease_until,last_activity_at
    FROM bb_authoring_progress WHERE owner_user_id=r.owner_user_id AND run_id=r.id
    ON CONFLICT DO NOTHING;
  INSERT INTO bb_run_billing_progress(billing_segment_id,owner_user_id,project_id,run_id)
    VALUES(c.id,r.owner_user_id,r.project_id,r.id) ON CONFLICT DO NOTHING;
  IF captured_id IS NOT NULL THEN
    INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload)
      VALUES('billing-segment-bound:'||c.id,r.owner_user_id,'run',r.id,'run.billing_segment_bound',
        jsonb_build_object('run_id',r.id,'billing_segment_id',c.id,'execution_version',1,
          'input_revision',r.input_revision,'input_hash',trim(r.input_hash),'source_quote_id',c.quote_id,
          'billing_policy',c.billing_policy,'points',c.points,
          'capture_kind',CASE WHEN p_historical THEN 'historical_backfill' ELSE 'runtime_origin' END));
  END IF;
END;$$;

CREATE FUNCTION bb_assert_original_run_billing(p_owner text,p_run text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r bb_runs%ROWTYPE;
BEGIN
  SELECT * INTO r FROM bb_runs WHERE owner_user_id=p_owner AND id=p_run;
  IF r.id IS NULL THEN RAISE EXCEPTION 'billing run is missing'
    USING ERRCODE='23514',CONSTRAINT='bb_run_billing_capture_exact'; END IF;
  IF r.reservation_id IS NULL THEN
    IF EXISTS(SELECT 1 FROM bb_credit_reservations WHERE owner_user_id=p_owner AND run_id=p_run)
      OR EXISTS(SELECT 1 FROM bb_run_billing_segments WHERE run_id=p_run)
      OR EXISTS(SELECT 1 FROM bb_run_execution_billing_bindings WHERE run_id=p_run)
    THEN RAISE EXCEPTION 'unreserved run cannot own a billing segment'
      USING ERRCODE='23514',CONSTRAINT='bb_run_billing_capture_exact'; END IF;
    RETURN;
  END IF;
  IF NOT EXISTS(
    SELECT 1 FROM bb_credit_reservations c
    JOIN bb_run_billing_segments s ON s.id=c.id AND s.reservation_id=c.id
      AND s.owner_user_id=c.owner_user_id AND s.run_id=c.run_id
      AND s.source_quote_id=c.quote_id AND s.points=c.points AND s.billing_policy=c.billing_policy AND s.created_at=c.created_at
    JOIN bb_run_execution_billing_bindings b ON b.owner_user_id=s.owner_user_id AND b.project_id=s.project_id
      AND b.run_id=s.run_id AND b.billing_segment_id=s.id AND b.assignment_kind='original' AND b.created_at=s.created_at
      AND b.execution_version=s.origin_execution_version AND b.input_revision=s.origin_input_revision AND b.input_hash=s.origin_input_hash
    JOIN bb_run_execution_versions e ON e.owner_user_id=b.owner_user_id AND e.project_id=b.project_id
      AND e.run_id=b.run_id AND e.execution_version=b.execution_version AND e.input_revision=b.input_revision AND e.input_hash=b.input_hash
    JOIN bb_run_billing_progress m ON m.billing_segment_id=s.id AND m.owner_user_id=s.owner_user_id
      AND m.project_id=s.project_id AND m.run_id=s.run_id
    JOIN bb_authoring_progress legacy ON legacy.owner_user_id=m.owner_user_id AND legacy.run_id=m.run_id
      AND ROW(legacy.active_ms,legacy.work_bps,legacy.accrued_points,legacy.clock_at,legacy.lease_until,legacy.last_activity_at)
        IS NOT DISTINCT FROM ROW(m.active_ms,m.work_bps,m.accrued_points,m.clock_at,m.lease_until,m.last_activity_at)
    WHERE c.id=r.reservation_id AND c.owner_user_id=r.owner_user_id AND c.run_id=r.id AND s.project_id=r.project_id
      AND s.segment_number=1 AND b.execution_version=1 AND b.input_revision=r.input_revision AND b.input_hash=r.input_hash
      AND r.billing_mode IN ('fixed_credits','metered_credits')
  ) THEN RAISE EXCEPTION 'billing requires its exact original reservation, execution assignment and mirrored meter'
    USING ERRCODE='23514',CONSTRAINT='bb_run_billing_capture_exact'; END IF;
END;$$;

-- A rolling old writer and a canonical writer must serialize through the same
-- parent. NOWAIT prevents a descendant-row writer reversing another run lock.
CREATE FUNCTION bb_lock_original_billing_meter() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND (
    NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id OR NEW.run_id IS DISTINCT FROM OLD.run_id
    OR (TG_TABLE_NAME='bb_run_billing_progress' AND
      (to_jsonb(NEW)->'project_id' IS DISTINCT FROM to_jsonb(OLD)->'project_id'
        OR to_jsonb(NEW)->'billing_segment_id' IS DISTINCT FROM to_jsonb(OLD)->'billing_segment_id'))
  ) THEN RAISE EXCEPTION 'billing meter identity is immutable'
    USING ERRCODE='23514',CONSTRAINT='bb_run_billing_meter_exact'; END IF;
  PERFORM 1 FROM bb_runs WHERE owner_user_id=NEW.owner_user_id AND id=NEW.run_id FOR UPDATE NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'billing meter requires its exact owned run'
    USING ERRCODE='23514',CONSTRAINT='bb_run_billing_meter_exact'; END IF;
  RETURN NEW;
END;$$;
CREATE TRIGGER bb_run_billing_progress_lock BEFORE INSERT OR UPDATE ON bb_run_billing_progress
  FOR EACH ROW EXECUTE FUNCTION bb_lock_original_billing_meter();
CREATE TRIGGER bb_authoring_progress_billing_lock BEFORE INSERT OR UPDATE ON bb_authoring_progress
  FOR EACH ROW EXECUTE FUNCTION bb_lock_original_billing_meter();

CREATE FUNCTION bb_mirror_original_billing_progress() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s bb_run_billing_segments%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME='bb_run_billing_progress' THEN
    SELECT * INTO s FROM bb_run_billing_segments WHERE id=NEW.billing_segment_id
      AND owner_user_id=NEW.owner_user_id AND project_id=NEW.project_id AND run_id=NEW.run_id;
    IF s.id IS NULL THEN RAISE EXCEPTION 'canonical meter requires its exact original billing segment'
      USING ERRCODE='23514',CONSTRAINT='bb_run_billing_meter_exact'; END IF;
    PERFORM 1 FROM bb_authoring_progress WHERE run_id=NEW.run_id FOR UPDATE NOWAIT;
    INSERT INTO bb_authoring_progress(run_id,owner_user_id,active_ms,work_bps,accrued_points,clock_at,lease_until,last_activity_at)
      VALUES(NEW.run_id,NEW.owner_user_id,NEW.active_ms,NEW.work_bps,NEW.accrued_points,NEW.clock_at,NEW.lease_until,NEW.last_activity_at)
      ON CONFLICT(run_id) DO UPDATE SET active_ms=excluded.active_ms,work_bps=excluded.work_bps,
        accrued_points=excluded.accrued_points,clock_at=excluded.clock_at,lease_until=excluded.lease_until,last_activity_at=excluded.last_activity_at
      WHERE bb_authoring_progress.owner_user_id=excluded.owner_user_id
        AND ROW(bb_authoring_progress.active_ms,bb_authoring_progress.work_bps,bb_authoring_progress.accrued_points,
          bb_authoring_progress.clock_at,bb_authoring_progress.lease_until,bb_authoring_progress.last_activity_at)
        IS DISTINCT FROM ROW(excluded.active_ms,excluded.work_bps,excluded.accrued_points,excluded.clock_at,excluded.lease_until,excluded.last_activity_at);
  ELSE
    SELECT * INTO s FROM bb_run_billing_segments WHERE owner_user_id=NEW.owner_user_id AND run_id=NEW.run_id AND segment_number=1;
    IF s.id IS NULL THEN
      -- Free runs retain their legacy meter. Before reserve's pointer UPDATE,
      -- any old meter is captured by the immediate run trigger below.
      IF EXISTS(SELECT 1 FROM bb_runs WHERE id=NEW.run_id AND owner_user_id=NEW.owner_user_id AND reservation_id IS NOT NULL)
      THEN RAISE EXCEPTION 'paid legacy meter is missing its canonical original segment'
        USING ERRCODE='23514',CONSTRAINT='bb_run_billing_meter_exact'; END IF;
      RETURN NEW;
    END IF;
    PERFORM 1 FROM bb_run_billing_progress WHERE billing_segment_id=s.id FOR UPDATE NOWAIT;
    INSERT INTO bb_run_billing_progress(billing_segment_id,owner_user_id,project_id,run_id,
      active_ms,work_bps,accrued_points,clock_at,lease_until,last_activity_at)
      VALUES(s.id,s.owner_user_id,s.project_id,s.run_id,NEW.active_ms,NEW.work_bps,NEW.accrued_points,NEW.clock_at,NEW.lease_until,NEW.last_activity_at)
      ON CONFLICT(billing_segment_id) DO UPDATE SET active_ms=excluded.active_ms,work_bps=excluded.work_bps,
        accrued_points=excluded.accrued_points,clock_at=excluded.clock_at,lease_until=excluded.lease_until,last_activity_at=excluded.last_activity_at
      WHERE ROW(bb_run_billing_progress.active_ms,bb_run_billing_progress.work_bps,bb_run_billing_progress.accrued_points,
          bb_run_billing_progress.clock_at,bb_run_billing_progress.lease_until,bb_run_billing_progress.last_activity_at)
        IS DISTINCT FROM ROW(excluded.active_ms,excluded.work_bps,excluded.accrued_points,excluded.clock_at,excluded.lease_until,excluded.last_activity_at);
  END IF;
  RETURN NEW;
END;$$;
CREATE TRIGGER bb_run_billing_progress_mirror AFTER INSERT OR UPDATE ON bb_run_billing_progress
  FOR EACH ROW EXECUTE FUNCTION bb_mirror_original_billing_progress();
CREATE TRIGGER bb_authoring_progress_billing_mirror AFTER INSERT OR UPDATE ON bb_authoring_progress
  FOR EACH ROW EXECUTE FUNCTION bb_mirror_original_billing_progress();

CREATE FUNCTION bb_keep_original_billing_meter() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='bb_run_billing_progress'
  THEN RAISE EXCEPTION 'original billing meter must retain its exact legacy mirror'
    USING ERRCODE='23514',CONSTRAINT='bb_run_billing_meter_exact'; END IF;
  IF TG_OP='TRUNCATE' THEN
    IF EXISTS(SELECT 1 FROM bb_run_billing_segments)
    THEN RAISE EXCEPTION 'original billing meter must retain its exact legacy mirror'
      USING ERRCODE='23514',CONSTRAINT='bb_run_billing_meter_exact'; END IF;
    RETURN NULL;
  END IF;
  IF EXISTS(SELECT 1 FROM bb_run_billing_segments WHERE run_id=OLD.run_id)
  THEN RAISE EXCEPTION 'original billing meter must retain its exact legacy mirror'
    USING ERRCODE='23514',CONSTRAINT='bb_run_billing_meter_exact'; END IF;
  RETURN OLD;
END;$$;
CREATE TRIGGER bb_run_billing_progress_keep BEFORE DELETE ON bb_run_billing_progress
  FOR EACH ROW EXECUTE FUNCTION bb_keep_original_billing_meter();
CREATE TRIGGER bb_run_billing_progress_no_truncate BEFORE TRUNCATE ON bb_run_billing_progress
  FOR EACH STATEMENT EXECUTE FUNCTION bb_keep_original_billing_meter();
CREATE TRIGGER bb_authoring_progress_billing_keep BEFORE DELETE ON bb_authoring_progress
  FOR EACH ROW EXECUTE FUNCTION bb_keep_original_billing_meter();
CREATE TRIGGER bb_authoring_progress_billing_no_truncate BEFORE TRUNCATE ON bb_authoring_progress
  FOR EACH STATEMENT EXECUTE FUNCTION bb_keep_original_billing_meter();

CREATE FUNCTION bb_guard_original_billing_reservation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR ROW(NEW.id,NEW.owner_user_id,NEW.run_id,NEW.quote_id,NEW.points,NEW.billing_policy,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.owner_user_id,OLD.run_id,OLD.quote_id,OLD.points,OLD.billing_policy,OLD.created_at)
  THEN RAISE EXCEPTION 'original reservation price, policy and ownership are immutable'
    USING ERRCODE='23514',CONSTRAINT='bb_run_billing_reservation_immutable'; END IF;
  RETURN NEW;
END;$$;
CREATE TRIGGER bb_credit_reservation_origin_immutable BEFORE UPDATE OR DELETE ON bb_credit_reservations
  FOR EACH ROW EXECUTE FUNCTION bb_guard_original_billing_reservation();

CREATE FUNCTION bb_guard_original_run_billing() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.reservation_id IS NOT NULL AND ROW(NEW.reservation_id,NEW.billing_mode) IS DISTINCT FROM ROW(OLD.reservation_id,OLD.billing_mode)
  THEN RAISE EXCEPTION 'run must retain its original billing reservation and mode'
    USING ERRCODE='23514',CONSTRAINT='bb_run_billing_origin_immutable'; END IF;
  RETURN NEW;
END;$$;
CREATE TRIGGER bb_run_billing_origin_immutable BEFORE UPDATE OF reservation_id,billing_mode ON bb_runs
  FOR EACH ROW EXECUTE FUNCTION bb_guard_original_run_billing();

CREATE FUNCTION bb_capture_original_run_billing_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM bb_capture_original_run_billing(NEW.owner_user_id,NEW.id); RETURN NEW; END;$$;
-- Reserve inserts the reservation, then sets the original run pointer. Capture
-- here makes canonical identity visible to enqueue/progress before COMMIT.
CREATE TRIGGER bb_run_billing_capture AFTER INSERT OR UPDATE OF reservation_id,billing_mode ON bb_runs
  FOR EACH ROW WHEN(NEW.reservation_id IS NOT NULL) EXECUTE FUNCTION bb_capture_original_run_billing_trigger();

CREATE FUNCTION bb_check_original_run_billing_deferred() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='bb_runs' THEN PERFORM bb_assert_original_run_billing(NEW.owner_user_id,NEW.id);
  ELSE PERFORM bb_assert_original_run_billing(NEW.owner_user_id,NEW.run_id); END IF;
  RETURN NEW;
END;$$;
CREATE CONSTRAINT TRIGGER bb_run_billing_complete AFTER INSERT OR UPDATE ON bb_runs
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bb_check_original_run_billing_deferred();
CREATE CONSTRAINT TRIGGER bb_credit_reservation_billing_complete AFTER INSERT OR UPDATE ON bb_credit_reservations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bb_check_original_run_billing_deferred();

DO $$ DECLARE r record;
BEGIN
  IF EXISTS(SELECT 1 FROM bb_credit_reservations c LEFT JOIN bb_runs origin
    ON origin.owner_user_id=c.owner_user_id AND origin.id=c.run_id AND origin.reservation_id=c.id
    WHERE origin.id IS NULL)
  THEN RAISE EXCEPTION 'historical reservation must retain its exact owned original run pointer'
    USING ERRCODE='23514',CONSTRAINT='bb_run_billing_capture_exact'; END IF;
  FOR r IN SELECT owner_user_id,id FROM bb_runs ORDER BY owner_user_id,id LOOP
    PERFORM bb_capture_original_run_billing(r.owner_user_id,r.id,true);
    PERFORM bb_assert_original_run_billing(r.owner_user_id,r.id);
  END LOOP;
END;$$;

-- Preserve every deployed delivery predicate, allocation, ledger event and
-- refund rule. Only resolve the already-owned V1 reservation and meter through
-- their canonical mapping. Unexpected predecessor definitions fail deployment.
DO $$
DECLARE definition text; old_source text; new_source text; function_name text; guard text;
BEGIN
  guard:='IF NEW.reservation_id IS NOT NULL AND NEW.state IN (''succeeded'',''failed'',''cancelled'',''rejected'') AND OLD.state IS DISTINCT FROM NEW.state THEN PERFORM bb_assert_original_run_billing(NEW.owner_user_id,NEW.id); END IF;';
  FOREACH function_name IN ARRAY ARRAY['bb_credit_finalize_run','bb_m4_credit_finalize_run'] LOOP
    SELECT pg_get_functiondef((function_name||'()')::regprocedure) INTO definition;
    definition:=replace(definition,E'\r\n',E'\n');
    old_source:=CASE WHEN function_name='bb_credit_finalize_run'
      THEN 'SELECT * INTO STRICT r FROM bb_credit_reservations WHERE id=NEW.reservation_id AND run_id=NEW.id AND owner_user_id=NEW.owner_user_id FOR UPDATE;'
      ELSE 'SELECT * INTO STRICT r FROM bb_credit_reservations WHERE id=NEW.reservation_id AND owner_user_id=NEW.owner_user_id AND run_id=NEW.id FOR UPDATE;' END;
    new_source:='SELECT c.* INTO STRICT r FROM bb_run_execution_billing_bindings b JOIN bb_run_billing_segments s ON s.id=b.billing_segment_id AND s.owner_user_id=b.owner_user_id AND s.project_id=b.project_id AND s.run_id=b.run_id JOIN bb_credit_reservations c ON c.id=s.reservation_id AND c.owner_user_id=s.owner_user_id AND c.run_id=s.run_id WHERE b.owner_user_id=NEW.owner_user_id AND b.project_id=NEW.project_id AND b.run_id=NEW.id AND b.execution_version=1 AND b.input_revision=NEW.input_revision AND b.input_hash=NEW.input_hash AND b.assignment_kind=''original'' AND s.id=NEW.reservation_id FOR UPDATE OF c;';
    IF (length(definition)-length(replace(definition,old_source,'')))/length(old_source)<>1
      OR strpos(definition,'authoring_platform_failure_refund')=0
      OR strpos(definition,'Dynamic authoring balance not fully settled')=0
      OR strpos(definition,E'BEGIN\n')=0
    THEN RAISE EXCEPTION 'Unexpected billing finalizer predecessor'
      USING ERRCODE='23514',CONSTRAINT='bb_run_billing_predecessor'; END IF;
    definition:=replace(definition,old_source,new_source);
    definition:=replace(definition,E'BEGIN\n',E'BEGIN\n  '||guard||E'\n');
    IF function_name='bb_credit_finalize_run' THEN
      old_source:='SELECT accrued_points FROM bb_authoring_progress WHERE run_id=NEW.id AND owner_user_id=NEW.owner_user_id';
      new_source:='SELECT accrued_points FROM bb_run_billing_progress WHERE billing_segment_id=r.id AND run_id=NEW.id AND owner_user_id=NEW.owner_user_id AND project_id=NEW.project_id';
      IF (length(definition)-length(replace(definition,old_source,'')))/length(old_source)<>1
      THEN RAISE EXCEPTION 'Unexpected authoring finalizer meter predecessor'
        USING ERRCODE='23514',CONSTRAINT='bb_run_billing_predecessor'; END IF;
      definition:=replace(definition,old_source,new_source);
    END IF;
    EXECUTE definition;
  END LOOP;
END;$$;

-- Bind B1 source pricing to the original pointer explicitly. The reservation
-- run UNIQUE constraint remains installed; this prepares the lookup without
-- admitting or funding any successor execution.
DO $$ DECLARE definition text;old_source text;new_source text;
BEGIN
  SELECT pg_get_functiondef('bb_assert_supplement_quote_live(bb_run_supplement_quotes)'::regprocedure) INTO definition;
  old_source:='SELECT * INTO reservation FROM bb_credit_reservations WHERE owner_user_id=q.owner_user_id AND run_id=q.run_id;';
  new_source:='SELECT * INTO reservation FROM bb_credit_reservations WHERE owner_user_id=q.owner_user_id AND run_id=q.run_id AND id=r.reservation_id;';
  IF (length(definition)-length(replace(definition,old_source,'')))/length(old_source)<>1
  THEN RAISE EXCEPTION 'Unexpected supplement source reservation predecessor'
    USING ERRCODE='23514',CONSTRAINT='bb_run_billing_predecessor'; END IF;
  EXECUTE replace(definition,old_source,new_source);
END;$$;

COMMENT ON TABLE bb_run_billing_segments IS
  'Immutable original V1 fee cap identity over the unchanged original reservation. No successor adoption, additional reservation or charge authority.';
COMMENT ON TABLE bb_run_execution_billing_bindings IS
  'Exact original execution assignment to its fee segment. Successor and zero-additional assignments require a later authorized migration.';
COMMENT ON TABLE bb_run_billing_progress IS
  'Canonical original fee-segment meter, exactly mirrored to legacy authoring progress. Capture preserves previously accrued and charged history.';
