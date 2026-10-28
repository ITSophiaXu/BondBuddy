-- Trial-03 standard business scopes. No old quote, balance or settlement is repriced.
INSERT INTO bb_credit_price_versions(id,prices,effective_at,actor,reason,pricing_mode)
 VALUES('outcome-cny-20261028-v2','{"interim":24900,"annual":24900,"two_years":49900,"three_years":49900,"migration":24900,"migration_two_years":49900,"migration_three_years":49900,"new_authoring":49900,"full_review":14900,"differential_review":14900,"review_revision":3900}',
 '2026-10-28T00:00:00.128Z','standard-outcome-migration','Scope calculator determines payable amount; these task-classification values are never an executable flat first-draft quote.','outcome_cny_v1');

ALTER TABLE bb_scope_quotations ADD CONSTRAINT bb_scope_price_version CHECK(price_version IN ('outcome-cny-20261028-v1','outcome-cny-20261028-v2'));
ALTER TABLE bb_scope_quotations DROP CONSTRAINT bb_scope_lifecycle;
ALTER TABLE bb_scope_quotations ADD CONSTRAINT bb_scope_lifecycle CHECK(
 status IN ('pending','quoted','unavailable','declined','expired') AND
 ((published_at IS NULL AND amount_fen IS NULL AND approved_by IS NULL AND lines='[]'::jsonb AND expires_at IS NULL AND status IN ('pending','unavailable')) OR
  (published_at IS NOT NULL AND amount_fen IS NOT NULL AND amount_fen BETWEEN 0 AND 100000000 AND approved_by IS NOT NULL AND length(trim(approved_by))>0 AND length(trim(reason))>0 AND expires_at IS NOT NULL AND expires_at>published_at AND jsonb_typeof(lines)='array' AND jsonb_array_length(lines) BETWEEN 1 AND 200 AND status<>'pending')) AND
 ((status IN ('pending','quoted') AND closed_at IS NULL AND decline_reason='' AND closure_reason='') OR
  (status IN ('unavailable','declined','expired') AND closed_at IS NOT NULL AND length(trim(closure_reason))>0)) AND
 (status<>'declined' OR length(trim(decline_reason)) BETWEEN 1 AND 1000));

-- Preserve the existing lifecycle guard and additionally freeze the classification and ownership pins.
CREATE FUNCTION bb_scope_standard_terms_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item jsonb; total bigint:=0; BEGIN
 IF TG_OP='UPDATE' AND OLD.published_at IS NOT NULL AND
  ROW(NEW.price_version,NEW.work_plan,NEW.pricing_items) IS DISTINCT FROM ROW(OLD.price_version,OLD.work_plan,OLD.pricing_items)
 THEN RAISE EXCEPTION 'Published pricing plan and coverage terms are immutable' USING ERRCODE='23514'; END IF;
 IF NEW.work_plan IS NOT NULL THEN
  IF NEW.price_version<>'outcome-cny-20261028-v2' OR NEW.work_plan->>'scope_status' IS DISTINCT FROM 'confirmed'
   OR NEW.work_plan ? 'owned_coverage' OR jsonb_array_length(NEW.work_plan->'items')=0
   OR jsonb_array_length(NEW.pricing_items)=0 OR NEW.published_at IS NULL
  THEN RAISE EXCEPTION 'Confirmed standard plan and server calculation required' USING ERRCODE='23514'; END IF;
  FOR item IN SELECT * FROM jsonb_array_elements(NEW.pricing_items) LOOP
   IF jsonb_typeof(item->'coverage_key') IS DISTINCT FROM 'string' OR length(trim(item->>'coverage_key'))=0
    OR (item->>'due_fen') !~ '^[0-9]{1,9}$' OR (item->>'due_fen')::bigint>100000000
    OR jsonb_typeof(item->'owned_coverage_ids') IS DISTINCT FROM 'array'
    OR ((item->>'due_fen')::bigint=0 AND jsonb_array_length(item->'owned_coverage_ids')=0)
   THEN RAISE EXCEPTION 'Valid work-item calculation and owned source pins required' USING ERRCODE='23514'; END IF;
   total:=total+(item->>'due_fen')::bigint;
  END LOOP;
  IF total IS DISTINCT FROM NEW.amount_fen THEN RAISE EXCEPTION 'Pricing items must equal scope total' USING ERRCODE='23514'; END IF;
 ELSIF NEW.amount_fen=0 OR NEW.pricing_items<>'[]'::jsonb THEN
  RAISE EXCEPTION 'Only confirmed owned standard scope may have zero price' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_scope_standard_terms BEFORE INSERT OR UPDATE ON bb_scope_quotations FOR EACH ROW EXECUTE FUNCTION bb_scope_standard_terms_guard();

ALTER TABLE bb_credit_quotes DROP CONSTRAINT bb_credit_quotes_points_check;
ALTER TABLE bb_credit_quotes ADD CONSTRAINT bb_credit_quotes_points_check CHECK(points BETWEEN 0 AND 1000000000 AND (points>0 OR pricing_mode='outcome_cny_v1' AND scope_quote_id IS NOT NULL));
ALTER TABLE bb_credit_quotes DROP CONSTRAINT bb_outcome_authoring_quote;
ALTER TABLE bb_credit_quotes ADD CONSTRAINT bb_outcome_authoring_quote CHECK(pricing_mode<>'outcome_cny_v1' OR
 (price_version IN ('outcome-cny-20261028-v1','outcome-cny-20261028-v2') AND scope_quote_id IS NOT NULL AND points>=0));
ALTER TABLE bb_m4_quotes DROP CONSTRAINT bb_outcome_m4_quote;
ALTER TABLE bb_m4_quotes ADD CONSTRAINT bb_outcome_m4_quote CHECK(pricing_mode<>'outcome_cny_v1' OR
 (billing_method='fixed' AND fixed_price_version IN ('outcome-cny-20261028-v1','outcome-cny-20261028-v2') AND billing_policy='on_delivery' AND scope_quote_id IS NOT NULL AND reserve_points>=0));
DO $$ DECLARE definition text; BEGIN
 SELECT pg_get_constraintdef(oid) INTO STRICT definition FROM pg_constraint WHERE conrelid='bb_m4_quotes'::regclass AND conname='bb_m4_fixed_quote_terms';
 IF strpos(definition,'reserve_points > 0')=0 THEN RAISE EXCEPTION 'Unexpected M4 fixed terms'; END IF;
 ALTER TABLE bb_m4_quotes DROP CONSTRAINT bb_m4_fixed_quote_terms;
 EXECUTE 'ALTER TABLE bb_m4_quotes ADD CONSTRAINT bb_m4_fixed_quote_terms '||replace(definition,'reserve_points > 0','reserve_points >= 0 AND (reserve_points > 0 OR (pricing_mode=''outcome_cny_v1'' AND scope_quote_id IS NOT NULL))');
END $$;

ALTER TABLE bb_project_qa_quotes DROP CONSTRAINT bb_project_qa_price_terms;
ALTER TABLE bb_project_qa_quotes ADD CONSTRAINT bb_project_qa_price_terms CHECK(
 (price_version='project-qa-question-60-v1' AND unit_points=60 AND points=question_count*unit_points) OR
 (price_version IN ('outcome-cny-20261028-v1','outcome-cny-20261028-v2') AND points>=0 AND unit_points>=0 AND (points=0 OR scope_quote_id IS NOT NULL)));
ALTER TABLE bb_project_file_update_quotes DROP CONSTRAINT bb_project_file_update_price_terms;
ALTER TABLE bb_project_file_update_quotes ADD CONSTRAINT bb_project_file_update_price_terms CHECK(
 (price_version='project-file-update-4500-v1' AND points=4500) OR
 (price_version IN ('outcome-cny-20261028-v1','outcome-cny-20261028-v2') AND points>=0 AND scope_quote_id IS NOT NULL));
ALTER TABLE bb_project_file_check_quotes DROP CONSTRAINT bb_project_file_check_quotes_price_version_check;
ALTER TABLE bb_project_file_check_quotes ADD CONSTRAINT bb_project_file_check_quotes_price_version_check CHECK(price_version IN ('outcome-cny-20261028-v1','outcome-cny-20261028-v2'));
-- Zero standard reuse may still name the originally requested file versions.
DO $$ DECLARE n text; BEGIN
 SELECT conname INTO STRICT n FROM pg_constraint WHERE conrelid='bb_project_file_check_quotes'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%charged_file_versions%';
 EXECUTE format('ALTER TABLE bb_project_file_check_quotes DROP CONSTRAINT %I',n);
END $$;
ALTER TABLE bb_project_file_check_quotes ADD CONSTRAINT bb_file_check_charged_versions CHECK(jsonb_typeof(charged_file_versions)='array' AND
 ((points=0 AND jsonb_array_length(charged_file_versions)=0) OR scope_quote_id IS NOT NULL));
ALTER TABLE bb_integrity_quotes DROP CONSTRAINT bb_integrity_quote_price_terms;
ALTER TABLE bb_integrity_quotes ADD CONSTRAINT bb_integrity_quote_price_terms CHECK(
 (scope_quote_id IS NULL AND price_version='integrity-round-5000-v1' AND points=5000) OR
 (scope_quote_id IS NOT NULL AND price_version IN ('outcome-cny-20261028-v1','outcome-cny-20261028-v2') AND points>0));

-- Family quotes must preserve the exact stored pricing version, including historical v1.
DO $$ DECLARE definition text; marker text:='IF s.id IS NULL OR s.published_at IS NULL'; BEGIN
 SELECT pg_get_functiondef('bb_approved_scope_price_guard()'::regprocedure) INTO definition;
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'Unexpected scope quote guard'; END IF;
 EXECUTE replace(definition,marker,marker||' OR s.price_version IS DISTINCT FROM COALESCE(to_jsonb(NEW)->>''fixed_price_version'',to_jsonb(NEW)->>''price_version'')');
END $$;
-- Keep the existing original-question proof for old explicit followups. New zero standard
-- scopes instead require a matching approved plan (and the immutable run binding).
DO $$ DECLARE definition text; marker text:='IF NEW.price_version=''outcome-cny-20261028-v1'' AND NEW.points=0 AND NOT EXISTS('; BEGIN
 SELECT pg_get_functiondef('bb_outcome_qa_followup_guard()'::regprocedure) INTO definition;
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'Unexpected QA followup guard'; END IF;
 definition:=replace(definition,marker,'IF NEW.price_version IN (''outcome-cny-20261028-v1'',''outcome-cny-20261028-v2'') AND NEW.points=0 AND NEW.scope_quote_id IS NULL AND NOT EXISTS(');
 definition:=replace(definition,'price.price_version=NEW.price_version','price.price_version IN (''outcome-cny-20261028-v1'',''outcome-cny-20261028-v2'')');
 EXECUTE definition;
END $$;
