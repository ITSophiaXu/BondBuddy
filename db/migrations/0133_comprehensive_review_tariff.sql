-- A new published tariff, never an edit to v2 or any quote, subscription period or wallet lot.
-- Review C_plan 7.5454800512 -> base_fen 15997 -> ceil(15997 * 1.7) = 27195 points.
INSERT INTO bb_credit_price_versions(id,prices,effective_at,actor,reason,pricing_mode) VALUES
 ('bb-task-price-170-20261029-v3','{"interim":8864,"annual":20341,"two_years":34570,"three_years":52374,"migration":51626,"migration_two_years":51626,"migration_three_years":51626,"new_authoring":86799,"full_review":27195,"differential_review":14900,"review_revision":14900}',
 '2026-10-29T00:00:00.133Z','comprehensive-review-migration','Comprehensive review uses planned attributable cost and two-stage 1.7 rounding. Differential review and separately commissioned revision retain their prior prices. Historical v2 contracts remain valid.','outcome_cny_v1');

ALTER TABLE bb_scope_quotations DROP CONSTRAINT bb_automatic_scope_shape;
ALTER TABLE bb_scope_quotations ADD CONSTRAINT bb_automatic_scope_shape CHECK(automatic_price IS NULL OR
 (jsonb_typeof(automatic_price)='object' AND price_version IN ('bb-task-price-170-20261029-v2','bb-task-price-170-20261029-v3') AND work_plan IS NULL));
ALTER TABLE bb_scope_quotations DROP CONSTRAINT bb_scope_price_version;
ALTER TABLE bb_scope_quotations ADD CONSTRAINT bb_scope_price_version CHECK(price_version IN ('outcome-cny-20261028-v1','outcome-cny-20261028-v2','bb-task-price-170-20261029-v2','bb-task-price-170-20261029-v3'));
ALTER TABLE bb_credit_quotes DROP CONSTRAINT bb_outcome_authoring_quote;
ALTER TABLE bb_credit_quotes ADD CONSTRAINT bb_outcome_authoring_quote CHECK(pricing_mode<>'outcome_cny_v1' OR
 (price_version IN ('outcome-cny-20261028-v1','outcome-cny-20261028-v2','bb-task-price-170-20261029-v2','bb-task-price-170-20261029-v3') AND scope_quote_id IS NOT NULL AND points>=0));
ALTER TABLE bb_m4_quotes DROP CONSTRAINT bb_outcome_m4_quote;
ALTER TABLE bb_m4_quotes ADD CONSTRAINT bb_outcome_m4_quote CHECK(pricing_mode<>'outcome_cny_v1' OR
 (billing_method='fixed' AND fixed_price_version IN ('outcome-cny-20261028-v1','outcome-cny-20261028-v2','bb-task-price-170-20261029-v2','bb-task-price-170-20261029-v3') AND billing_policy='on_delivery' AND scope_quote_id IS NOT NULL AND reserve_points>=0));
ALTER TABLE bb_project_qa_quotes DROP CONSTRAINT bb_project_qa_price_terms;
ALTER TABLE bb_project_qa_quotes ADD CONSTRAINT bb_project_qa_price_terms CHECK(
 (price_version='project-qa-question-60-v1' AND unit_points=60 AND points=question_count*unit_points) OR
 (price_version IN ('outcome-cny-20261028-v1','outcome-cny-20261028-v2','bb-task-price-170-20261029-v2','bb-task-price-170-20261029-v3') AND points>=0 AND unit_points>=0 AND (points=0 OR scope_quote_id IS NOT NULL)));
ALTER TABLE bb_project_file_update_quotes DROP CONSTRAINT bb_project_file_update_price_terms;
ALTER TABLE bb_project_file_update_quotes ADD CONSTRAINT bb_project_file_update_price_terms CHECK(
 (price_version='project-file-update-4500-v1' AND points=4500) OR
 (price_version IN ('outcome-cny-20261028-v1','outcome-cny-20261028-v2','bb-task-price-170-20261029-v2','bb-task-price-170-20261029-v3') AND points>=0 AND scope_quote_id IS NOT NULL));
ALTER TABLE bb_project_file_check_quotes DROP CONSTRAINT bb_project_file_check_quotes_price_version_check;
ALTER TABLE bb_project_file_check_quotes ADD CONSTRAINT bb_project_file_check_quotes_price_version_check CHECK(price_version IN ('outcome-cny-20261028-v1','outcome-cny-20261028-v2','bb-task-price-170-20261029-v2','bb-task-price-170-20261029-v3'));
ALTER TABLE bb_integrity_quotes DROP CONSTRAINT bb_integrity_quote_price_terms;
ALTER TABLE bb_integrity_quotes ADD CONSTRAINT bb_integrity_quote_price_terms CHECK(
 (scope_quote_id IS NULL AND price_version='integrity-round-5000-v1' AND points=5000) OR
 (scope_quote_id IS NOT NULL AND price_version IN ('outcome-cny-20261028-v1','outcome-cny-20261028-v2','bb-task-price-170-20261029-v2','bb-task-price-170-20261029-v3') AND points>0));

-- Preserve all invariant checks; extend only the exact list of recognised automatic policies.
DO $$ DECLARE definition text; marker text:='IF NEW.price_version=''bb-task-price-170-20261029-v2'' THEN'; BEGIN
 SELECT pg_get_functiondef('bb_automatic_scope_price_guard()'::regprocedure) INTO definition;
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'Unexpected automatic scope price guard'; END IF;
 EXECUTE replace(definition,marker,'IF NEW.price_version IN (''bb-task-price-170-20261029-v2'',''bb-task-price-170-20261029-v3'') THEN');
END $$;
DO $$ DECLARE definition text; marker text:='''outcome-cny-20261028-v1'',''outcome-cny-20261028-v2'',''bb-task-price-170-20261029-v2'''; BEGIN
 SELECT pg_get_functiondef('bb_outcome_qa_followup_guard()'::regprocedure) INTO definition;
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'Unexpected outcome QA followup guard'; END IF;
 EXECUTE replace(definition,marker,marker||',''bb-task-price-170-20261029-v3''');
END $$;
