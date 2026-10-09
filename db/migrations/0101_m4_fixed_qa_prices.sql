-- Prices are published separately by trusted operations after a business decision.
-- No production price or historical quotation is changed by this migration.
CREATE TABLE bb_m4_qa_price_versions (
 id text PRIMARY KEY, points bigint NOT NULL CHECK(points>0 AND points<=1000000000),
 effective_at timestamptz NOT NULL UNIQUE, actor text NOT NULL, reason text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER bb_m4_qa_price_versions_immutable BEFORE UPDATE OR DELETE ON bb_m4_qa_price_versions
 FOR EACH ROW EXECUTE FUNCTION bb_credit_immutable();

ALTER TABLE bb_m4_quotes DROP CONSTRAINT bb_m4_fixed_quote_terms;
ALTER TABLE bb_m4_quotes ADD CONSTRAINT bb_m4_fixed_quote_terms CHECK(
 (billing_method='metered_capped' AND fixed_price_version IS NULL) OR
 (billing_method='fixed' AND task_type IN ('m4_G01','m4_G02','m4_G03','m4_G05','m4_Q01','m4_Q02','m4_Q03','m4_Q04','m4_Q05')
  AND config_id IS NULL AND reserve_points>0 AND fixed_price_version IS NOT NULL));

-- Retain the existing delivery, failure release and expiry compensation checks.
DO $$ DECLARE definition text;
 marker text := 'OR (q.billing_method=''fixed'' AND NEW.task_kind<>''generation'')';
BEGIN
 SELECT pg_get_functiondef('bb_m4_credit_finalize_run()'::regprocedure) INTO definition;
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'Unexpected M4 credit finalizer definition'; END IF;
 definition:=replace(definition,marker,
  'OR (q.billing_method=''fixed'' AND NOT (
    (NEW.task_kind=''generation'' AND q.task_type IN (''m4_G01'',''m4_G02'',''m4_G03'',''m4_G05'')) OR
    (NEW.task_kind=''qa'' AND q.task_type IN (''m4_Q01'',''m4_Q02'',''m4_Q03'',''m4_Q04'',''m4_Q05''))))');
 EXECUTE definition;
END $$;
