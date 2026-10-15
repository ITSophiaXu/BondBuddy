-- Add application letters and the two case-backed NAFMII recommendation types.
-- Existing inputs, quotes, prices and credit allocations are unchanged.
ALTER TABLE bb_m4_templates DROP CONSTRAINT bb_m4_templates_document_type_check;
ALTER TABLE bb_m4_templates ADD CONSTRAINT bb_m4_templates_document_type_check
 CHECK(document_type IN ('init','private_summary','underwriter','legal','application','recommendation'));
ALTER TABLE bb_m4_drafts DROP CONSTRAINT bb_m4_drafts_document_type_check;
ALTER TABLE bb_m4_drafts ADD CONSTRAINT bb_m4_drafts_document_type_check
 CHECK(document_type IN ('init','private_summary','underwriter','legal','application','recommendation'));
ALTER TABLE bb_m4_artifacts DROP CONSTRAINT bb_m4_artifacts_document_type_check;
ALTER TABLE bb_m4_artifacts ADD CONSTRAINT bb_m4_artifacts_document_type_check
 CHECK(document_type IN ('init','private_summary','underwriter','legal','application','recommendation'));
ALTER TABLE bb_m4_pending_requirements DROP CONSTRAINT bb_m4_pending_requirements_consumed_document_type_check;
ALTER TABLE bb_m4_pending_requirements ADD CONSTRAINT bb_m4_pending_requirements_consumed_document_type_check
 CHECK(consumed_document_type IS NULL OR consumed_document_type IN ('init','private_summary','underwriter','legal','application','recommendation'));

ALTER TABLE bb_m4_quotes DROP CONSTRAINT bb_m4_fixed_quote_terms;
ALTER TABLE bb_m4_quotes ADD CONSTRAINT bb_m4_fixed_quote_terms CHECK(
 (billing_method='metered_capped' AND fixed_price_version IS NULL) OR
 (billing_method='fixed' AND task_type IN ('m4_G01','m4_G02','m4_G03','m4_G05','m4_G04','m4_application','m4_Q01','m4_Q02','m4_Q03','m4_Q04','m4_Q05')
  AND config_id IS NULL AND reserve_points>0 AND fixed_price_version IS NOT NULL));
ALTER TABLE bb_m4_quotes DROP CONSTRAINT bb_m4_dynamic_document_policy;
ALTER TABLE bb_m4_quotes ADD CONSTRAINT bb_m4_dynamic_document_policy CHECK(
 billing_policy='on_delivery' OR (billing_method='fixed' AND task_type IN ('m4_G01','m4_G02','m4_G03','m4_G05','m4_G04','m4_application')));

-- Extend only the recognized document task list, keeping the deployed finalizer's
-- two-file delivery, immutable quote, debit, pause, refund and isolation checks.
DO $$ DECLARE definition text;
BEGIN
 SELECT pg_get_functiondef('bb_m4_credit_finalize_run()'::regprocedure) INTO definition;
 IF strpos(definition,'''m4_G05''')=0 OR strpos(definition,'authoring_balance_v2')=0
 THEN RAISE EXCEPTION 'Unexpected M4 credit finalizer definition'; END IF;
 EXECUTE replace(definition,'''m4_G05''','''m4_G05'',''m4_G04'',''m4_application''');
END $$;
