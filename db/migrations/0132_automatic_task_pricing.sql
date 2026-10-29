-- New task policy; no historical quote, price, entitlement or settlement is rewritten.
INSERT INTO bb_credit_price_versions(id,prices,effective_at,actor,reason,pricing_mode) VALUES
 ('bb-task-price-170-20261029-v2','{"interim":8864,"annual":20341,"two_years":34570,"three_years":52374,"migration":51626,"migration_two_years":51626,"migration_three_years":51626,"new_authoring":86799,"full_review":14900,"differential_review":14900,"review_revision":14900}',
 '2026-10-29T00:00:00.132Z','subscription-billing-migration','Task tariff in points. Actual consideration follows original paid lot. Opt-in only.','outcome_cny_v1');
ALTER TABLE bb_scope_quotations ADD COLUMN automatic_price jsonb;
ALTER TABLE bb_scope_quotations ADD CONSTRAINT bb_automatic_scope_shape CHECK(automatic_price IS NULL OR
 (jsonb_typeof(automatic_price)='object' AND price_version='bb-task-price-170-20261029-v2' AND work_plan IS NULL));

-- Extend the explicit version allowlists, preserving every old condition.
ALTER TABLE bb_scope_quotations DROP CONSTRAINT bb_scope_price_version;
ALTER TABLE bb_scope_quotations ADD CONSTRAINT bb_scope_price_version CHECK(price_version IN ('outcome-cny-20261028-v1','outcome-cny-20261028-v2','bb-task-price-170-20261029-v2'));
ALTER TABLE bb_credit_quotes DROP CONSTRAINT bb_outcome_authoring_quote;
ALTER TABLE bb_credit_quotes ADD CONSTRAINT bb_outcome_authoring_quote CHECK(pricing_mode<>'outcome_cny_v1' OR
 (price_version IN ('outcome-cny-20261028-v1','outcome-cny-20261028-v2','bb-task-price-170-20261029-v2') AND scope_quote_id IS NOT NULL AND points>=0));
ALTER TABLE bb_m4_quotes DROP CONSTRAINT bb_outcome_m4_quote;
ALTER TABLE bb_m4_quotes ADD CONSTRAINT bb_outcome_m4_quote CHECK(pricing_mode<>'outcome_cny_v1' OR
 (billing_method='fixed' AND fixed_price_version IN ('outcome-cny-20261028-v1','outcome-cny-20261028-v2','bb-task-price-170-20261029-v2') AND billing_policy='on_delivery' AND scope_quote_id IS NOT NULL AND reserve_points>=0));
ALTER TABLE bb_project_qa_quotes DROP CONSTRAINT bb_project_qa_price_terms;
ALTER TABLE bb_project_qa_quotes ADD CONSTRAINT bb_project_qa_price_terms CHECK(
 (price_version='project-qa-question-60-v1' AND unit_points=60 AND points=question_count*unit_points) OR
 (price_version IN ('outcome-cny-20261028-v1','outcome-cny-20261028-v2','bb-task-price-170-20261029-v2') AND points>=0 AND unit_points>=0 AND (points=0 OR scope_quote_id IS NOT NULL)));
ALTER TABLE bb_project_file_update_quotes DROP CONSTRAINT bb_project_file_update_price_terms;
ALTER TABLE bb_project_file_update_quotes ADD CONSTRAINT bb_project_file_update_price_terms CHECK(
 (price_version='project-file-update-4500-v1' AND points=4500) OR
 (price_version IN ('outcome-cny-20261028-v1','outcome-cny-20261028-v2','bb-task-price-170-20261029-v2') AND points>=0 AND scope_quote_id IS NOT NULL));
ALTER TABLE bb_project_file_check_quotes DROP CONSTRAINT bb_project_file_check_quotes_price_version_check;
ALTER TABLE bb_project_file_check_quotes ADD CONSTRAINT bb_project_file_check_quotes_price_version_check CHECK(price_version IN ('outcome-cny-20261028-v1','outcome-cny-20261028-v2','bb-task-price-170-20261029-v2'));
ALTER TABLE bb_integrity_quotes DROP CONSTRAINT bb_integrity_quote_price_terms;
ALTER TABLE bb_integrity_quotes ADD CONSTRAINT bb_integrity_quote_price_terms CHECK(
 (scope_quote_id IS NULL AND price_version='integrity-round-5000-v1' AND points=5000) OR
 (scope_quote_id IS NOT NULL AND price_version IN ('outcome-cny-20261028-v1','outcome-cny-20261028-v2','bb-task-price-170-20261029-v2') AND points>0));

-- The old work-plan calculator must not reinterpret a new automatic tariff snapshot.
DO $$ DECLARE definition text; marker text:='IF NEW.work_plan IS NOT NULL THEN'; BEGIN
 SELECT pg_get_functiondef('bb_scope_standard_terms_guard()'::regprocedure) INTO definition;
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'Unexpected standard-scope guard'; END IF;
 EXECUTE replace(definition,marker,'IF NEW.automatic_price IS NOT NULL THEN RETURN NEW; END IF; '||marker);
END $$;
CREATE FUNCTION bb_automatic_scope_price_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item jsonb; total bigint:=0; BEGIN
 IF TG_OP='UPDATE' AND OLD.published_at IS NOT NULL AND NEW.automatic_price IS DISTINCT FROM OLD.automatic_price
 THEN RAISE EXCEPTION 'Automatic pricing snapshot is immutable' USING ERRCODE='23514'; END IF;
 IF NEW.price_version='bb-task-price-170-20261029-v2' THEN
  IF NEW.automatic_price IS NULL OR NEW.automatic_price->>'version' IS DISTINCT FROM NEW.price_version
   OR NEW.automatic_price->'lines' IS DISTINCT FROM NEW.lines
   OR jsonb_typeof(NEW.automatic_price->'source_quote_ids') IS DISTINCT FROM 'array'
   OR (NEW.automatic_price->>'points') !~ '^[0-9]{1,9}$'
   OR (NEW.automatic_price->>'points')::bigint IS DISTINCT FROM NEW.amount_fen
   OR NEW.approved_by IS DISTINCT FROM 'service:automatic-tariff'
  THEN RAISE EXCEPTION 'Exact automatic tariff snapshot required' USING ERRCODE='23514'; END IF;
  FOR item IN SELECT * FROM jsonb_array_elements(NEW.lines) LOOP
   IF (item->>'amount_fen') !~ '^[0-9]{1,9}$' OR (item->>'quantity')::bigint<1
    OR (item->>'amount_fen')::bigint IS DISTINCT FROM (item->>'quantity')::bigint*(item->>'unit_price_fen')::bigint
   THEN RAISE EXCEPTION 'Invalid automatic item arithmetic' USING ERRCODE='23514'; END IF;
   total:=total+(item->>'amount_fen')::bigint;
  END LOOP;
  IF total IS DISTINCT FROM NEW.amount_fen OR (total=0 AND jsonb_array_length(NEW.automatic_price->'source_quote_ids')=0)
  THEN RAISE EXCEPTION 'Automatic total or paid coverage proof missing' USING ERRCODE='23514'; END IF;
 END IF; RETURN NEW;
END $$;
CREATE TRIGGER bb_automatic_scope_price_valid BEFORE INSERT OR UPDATE ON bb_scope_quotations
 FOR EACH ROW EXECUTE FUNCTION bb_automatic_scope_price_guard();

-- Execution/coverage index only; bb_credit_lots/allocations/events remain the sole funds ledger.
CREATE TABLE bb_automatic_scope_runs(
 owner_user_id text NOT NULL,scope_quote_id text NOT NULL,run_id text PRIMARY KEY,
 bound_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(owner_user_id,scope_quote_id) REFERENCES bb_scope_quotations(owner_user_id,id),
 FOREIGN KEY(owner_user_id,run_id) REFERENCES bb_runs(owner_user_id,id));
CREATE INDEX bb_automatic_scope_runs_scope ON bb_automatic_scope_runs(owner_user_id,scope_quote_id);
CREATE FUNCTION bb_automatic_scope_run_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s bb_scope_quotations; r bb_runs; BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('commerce-coverage:'||NEW.owner_user_id,0));
 SELECT * INTO s FROM bb_scope_quotations WHERE owner_user_id=NEW.owner_user_id AND id=NEW.scope_quote_id FOR UPDATE;
 SELECT * INTO r FROM bb_runs WHERE owner_user_id=NEW.owner_user_id AND id=NEW.run_id;
 IF s.automatic_price IS NULL OR r.id IS NULL OR s.project_id IS DISTINCT FROM r.project_id OR
  NOT EXISTS(SELECT 1 FROM bb_commerce_scope_source_quotes(NEW.owner_user_id,s.id,r.id)) OR
  (s.amount_fen>0 AND NOT EXISTS(SELECT 1 FROM bb_credit_reservations h
   JOIN bb_commerce_scope_source_quotes(NEW.owner_user_id,s.id,r.id) q ON q.quote_id=h.quote_id
   WHERE h.owner_user_id=NEW.owner_user_id AND h.id=r.reservation_id AND h.run_id=r.id AND h.points=s.amount_fen)) OR
  (s.amount_fen=0 AND r.reservation_id IS NOT NULL)
 THEN RAISE EXCEPTION 'Exact owned automatic scope and reservation required' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM bb_automatic_scope_runs a JOIN bb_runs prior_run ON prior_run.id=a.run_id AND prior_run.owner_user_id=a.owner_user_id
  LEFT JOIN bb_credit_reservations h ON h.id=prior_run.reservation_id AND h.owner_user_id=prior_run.owner_user_id
  WHERE a.owner_user_id=NEW.owner_user_id AND a.scope_quote_id=NEW.scope_quote_id AND a.run_id<>NEW.run_id
  AND (prior_run.state NOT IN ('failed','cancelled','rejected') OR (prior_run.reservation_id IS NOT NULL AND h.state IS DISTINCT FROM 'released')))
 THEN RAISE EXCEPTION 'Automatic scope already running or delivered' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_automatic_scope_run_valid BEFORE INSERT ON bb_automatic_scope_runs
 FOR EACH ROW EXECUTE FUNCTION bb_automatic_scope_run_guard();
CREATE TRIGGER bb_automatic_scope_run_immutable BEFORE UPDATE OR DELETE ON bb_automatic_scope_runs
 FOR EACH ROW EXECUTE FUNCTION bb_scope_audit_immutable();

-- Existing same-question followup proof also applies to the new paid policy.
DO $$ DECLARE definition text; BEGIN
 SELECT pg_get_functiondef('bb_outcome_qa_followup_guard()'::regprocedure) INTO definition;
 definition:=replace(definition,'''outcome-cny-20261028-v1'',''outcome-cny-20261028-v2''','''outcome-cny-20261028-v1'',''outcome-cny-20261028-v2'',''bb-task-price-170-20261029-v2''');
 EXECUTE definition;
END $$;
