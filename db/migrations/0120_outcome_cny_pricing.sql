-- Opt-in CNY outcome prices. Existing lots, quotes, reservations and policies are untouched.
-- One existing ledger unit represents one fen for new outcome quotes; no second wallet.
ALTER TABLE bb_credit_price_versions ADD COLUMN pricing_mode text NOT NULL DEFAULT 'legacy_credit'
 CHECK(pricing_mode IN ('legacy_credit','outcome_cny_v1'));
ALTER TABLE bb_credit_quotes ADD COLUMN pricing_mode text NOT NULL DEFAULT 'legacy_credit'
 CHECK(pricing_mode IN ('legacy_credit','outcome_cny_v1'));
ALTER TABLE bb_credit_quotes ADD COLUMN outcome_key text;
ALTER TABLE bb_m4_quotes ADD COLUMN pricing_mode text NOT NULL DEFAULT 'legacy_credit'
 CHECK(pricing_mode IN ('legacy_credit','outcome_cny_v1'));
ALTER TABLE bb_credit_quotes ADD COLUMN scope_quote_id text;
ALTER TABLE bb_credit_quotes ADD COLUMN scope_lines jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(scope_lines)='array');
ALTER TABLE bb_m4_quotes ADD COLUMN scope_quote_id text;
ALTER TABLE bb_m4_quotes ADD COLUMN scope_lines jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(scope_lines)='array');
ALTER TABLE bb_project_qa_quotes ADD COLUMN scope_quote_id text;
ALTER TABLE bb_project_qa_quotes ADD COLUMN scope_work_hash char(64);
ALTER TABLE bb_project_qa_quotes ADD COLUMN scope_lines jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(scope_lines)='array');
ALTER TABLE bb_project_file_update_quotes ADD COLUMN scope_quote_id text;
ALTER TABLE bb_project_file_update_quotes ADD COLUMN scope_work_hash char(64);
ALTER TABLE bb_project_file_update_quotes ADD COLUMN scope_lines jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(scope_lines)='array');

INSERT INTO bb_credit_price_versions(id,prices,effective_at,actor,reason,pricing_mode)
 VALUES('outcome-cny-20261028-v1','{"interim":24900,"annual":24900,"two_years":24900,"three_years":24900,"migration":24900,"migration_two_years":24900,"migration_three_years":24900,"new_authoring":59900,"full_review":14900,"differential_review":14900,"review_revision":3900}',
 '2026-10-28T00:00:00.120Z','commercial-billing-migration','Explicit opt-in outcome price experiment; migration and multiple periods require separately confirmed scope.','outcome_cny_v1');

ALTER TABLE bb_credit_quotes ADD CONSTRAINT bb_outcome_authoring_quote CHECK(pricing_mode<>'outcome_cny_v1' OR
 (price_version='outcome-cny-20261028-v1' AND scope_quote_id IS NOT NULL AND points>0));
ALTER TABLE bb_m4_quotes ADD CONSTRAINT bb_outcome_m4_quote CHECK(pricing_mode<>'outcome_cny_v1' OR
 (billing_method='fixed' AND fixed_price_version='outcome-cny-20261028-v1' AND billing_policy='on_delivery'
 AND scope_quote_id IS NOT NULL AND reserve_points>0));

ALTER TABLE bb_project_qa_quotes DROP CONSTRAINT bb_project_qa_quotes_unit_points_check;
ALTER TABLE bb_project_qa_quotes DROP CONSTRAINT bb_project_qa_quotes_price_version_check;
ALTER TABLE bb_project_qa_quotes DROP CONSTRAINT bb_project_qa_quotes_check;
ALTER TABLE bb_project_qa_quotes ADD CONSTRAINT bb_project_qa_price_terms CHECK(
 (price_version='project-qa-question-60-v1' AND unit_points=60 AND points=question_count*unit_points) OR
 (price_version='outcome-cny-20261028-v1' AND points>=0 AND unit_points>=0 AND (points=0 OR scope_quote_id IS NOT NULL)));
ALTER TABLE bb_project_file_update_quotes DROP CONSTRAINT bb_project_file_update_quotes_points_check;
ALTER TABLE bb_project_file_update_quotes DROP CONSTRAINT bb_project_file_update_quotes_price_version_check;
ALTER TABLE bb_project_file_update_quotes ADD CONSTRAINT bb_project_file_update_price_terms CHECK(
 (price_version='project-file-update-4500-v1' AND points=4500) OR
 (price_version='outcome-cny-20261028-v1' AND points>0 AND scope_quote_id IS NOT NULL));

CREATE TABLE bb_project_file_check_quotes (
 id text PRIMARY KEY,owner_user_id text NOT NULL,project_id text NOT NULL,run_id text NOT NULL UNIQUE,
 input_hash char(64) NOT NULL,source_fingerprint char(64) NOT NULL,file_versions jsonb NOT NULL,
 charged_file_versions jsonb NOT NULL,points bigint NOT NULL CHECK(points>=0),
 scope_quote_id text,scope_work_hash char(64),scope_lines jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(scope_lines)='array'),
 price_version text NOT NULL CHECK(price_version='outcome-cny-20261028-v1'),
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(owner_user_id,id),
 CHECK(jsonb_typeof(file_versions)='array' AND jsonb_array_length(file_versions) BETWEEN 1 AND 200),
 CHECK(jsonb_typeof(charged_file_versions)='array' AND ((points=0 AND jsonb_array_length(charged_file_versions)=0) OR (points>0 AND scope_quote_id IS NOT NULL))),
 FOREIGN KEY(owner_user_id,project_id) REFERENCES bb_projects(owner_user_id,id),
 FOREIGN KEY(owner_user_id,run_id) REFERENCES bb_project_file_operations(owner_user_id,run_id)
);
CREATE INDEX bb_project_file_check_paid_scope ON bb_project_file_check_quotes(owner_user_id,source_fingerprint);
CREATE TRIGGER bb_project_file_check_quote_immutable BEFORE UPDATE OR DELETE ON bb_project_file_check_quotes
 FOR EACH ROW EXECUTE FUNCTION bb_credit_immutable();

-- Retain all legacy, integrity and Q&A quote guards; add the paid check quote family.
DO $$ DECLARE definition text; marker text := 'THEN RAISE EXCEPTION ''Owned immutable quote required'''; BEGIN
 SELECT pg_get_functiondef('bb_credit_reservation_quote_guard()'::regprocedure) INTO definition;
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'Unexpected quote guard'; END IF;
 EXECUTE replace(definition,marker,$guard$AND NOT EXISTS(
 SELECT 1 FROM bb_project_file_check_quotes q JOIN bb_project_file_operations o ON o.run_id=q.run_id AND o.owner_user_id=q.owner_user_id
 WHERE q.owner_user_id=NEW.owner_user_id AND q.id=NEW.quote_id AND q.run_id=NEW.run_id AND q.points=NEW.points
 AND o.operation='check' AND o.input_hash=q.input_hash AND o.project_id=q.project_id AND NEW.billing_policy='on_delivery')
 THEN RAISE EXCEPTION 'Owned immutable quote required'$guard$);
END $$;

-- Make the pinned full-price delivery policy a database invariant as well as an API rule.
CREATE FUNCTION bb_outcome_reservation_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM bb_credit_quotes q WHERE q.owner_user_id=NEW.owner_user_id AND q.id=NEW.quote_id AND q.pricing_mode='outcome_cny_v1') THEN
   IF NEW.billing_policy<>'on_delivery' OR NOT EXISTS(SELECT 1 FROM bb_credit_quotes q WHERE q.owner_user_id=NEW.owner_user_id AND q.id=NEW.quote_id AND q.points=NEW.points)
   THEN RAISE EXCEPTION 'Outcome reservation requires full on-delivery price' USING ERRCODE='23514'; END IF;
 END IF;
 IF EXISTS(SELECT 1 FROM bb_m4_quotes q WHERE q.owner_user_id=NEW.owner_user_id AND q.id=NEW.quote_id AND q.pricing_mode='outcome_cny_v1')
 AND NEW.billing_policy<>'on_delivery' THEN RAISE EXCEPTION 'Outcome M4 reservation must settle on delivery' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_outcome_reservation_policy BEFORE INSERT ON bb_credit_reservations FOR EACH ROW EXECUTE FUNCTION bb_outcome_reservation_guard();

CREATE FUNCTION bb_outcome_qa_followup_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.price_version='outcome-cny-20261028-v1' AND NEW.points=0 AND NOT EXISTS(
   SELECT 1 FROM bb_project_qa_runs child JOIN bb_project_qa_runs parent ON parent.run_id=child.manifest->>'included_followup_of' AND parent.owner_user_id=child.owner_user_id AND parent.project_id=child.project_id
   JOIN bb_runs run ON run.id=parent.run_id AND run.owner_user_id=parent.owner_user_id
   JOIN bb_credit_reservations paid ON paid.run_id=parent.run_id AND paid.owner_user_id=parent.owner_user_id
   JOIN bb_project_qa_quotes price ON price.id=paid.quote_id AND price.owner_user_id=paid.owner_user_id
   WHERE child.run_id=NEW.run_id AND child.owner_user_id=NEW.owner_user_id AND child.input_hash=NEW.input_hash
   AND jsonb_array_length(child.manifest->'questions')=NEW.question_count AND child.manifest->>'points'='0'
   AND child.operation='answer' AND parent.operation='answer'
   AND run.state='succeeded' AND paid.state='settled' AND paid.charged_points=price.points AND price.points>0 AND price.scope_quote_id IS NOT NULL AND price.price_version=NEW.price_version
   AND child.manifest->>'requirements'=parent.manifest->>'requirements' AND child.manifest#>'{source,asset}'=parent.manifest#>'{source,asset}'
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(child.manifest->'questions') question WHERE NOT (parent.manifest->'questions' @> jsonb_build_array(question))))
 THEN RAISE EXCEPTION 'Owned settled original-scope QA task required' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_outcome_qa_followup BEFORE INSERT ON bb_project_qa_quotes FOR EACH ROW EXECUTE FUNCTION bb_outcome_qa_followup_guard();

-- Approved scope lines determine each update's amount, including evidenced reuse.
-- No hardcoded upgrade price is inferred from document count.

-- A check delivers its immutable structured report, rather than a generated Word pair.
CREATE FUNCTION bb_project_file_check_delivery_ready(r bb_runs) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM bb_project_file_operations o WHERE o.run_id=r.id AND o.owner_user_id=r.owner_user_id AND o.operation='check'
 AND o.result IS NOT NULL AND o.result_hash IS NOT NULL AND o.result->>'version'='project-file-check-v1'
 AND jsonb_array_length(o.result->'files')=jsonb_array_length(o.manifest->'files')
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(o.manifest->'files') f WHERE NOT EXISTS(
   SELECT 1 FROM jsonb_array_elements(o.result->'files') delivered WHERE delivered->>'file_version_id'=f->>'file_version_id')));
$$;
DO $$ DECLARE definition text; marker text := 'IF NEW.state=''succeeded'' AND EXISTS(SELECT 1 FROM bb_project_qa_runs'; BEGIN
 SELECT pg_get_functiondef('bb_credit_finalize_run()'::regprocedure) INTO definition;
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'Unexpected credit finalizer'; END IF;
 EXECUTE replace(definition,marker,$guard$IF NEW.state='succeeded' AND EXISTS(SELECT 1 FROM bb_project_file_operations WHERE run_id=NEW.id AND owner_user_id=NEW.owner_user_id AND operation='check') THEN
   IF NOT bb_project_file_check_delivery_ready(NEW) THEN RAISE EXCEPTION 'Delivered immutable consistency report required' USING ERRCODE='23514'; END IF;
 ELSIF NEW.state='succeeded' AND EXISTS(SELECT 1 FROM bb_project_qa_runs$guard$);
END $$;
