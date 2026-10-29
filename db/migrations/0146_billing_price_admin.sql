-- Price management is separate from wallet ownership and log operations. No authority is granted here.
CREATE TABLE bb_billing_cost_versions(
 id text PRIMARY KEY,checksum char(64) NOT NULL CHECK(checksum~'^[a-f0-9]{64}$'),complete boolean NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),created_by text NOT NULL,change_reason text NOT NULL CHECK(length(trim(change_reason))>0),
 rows jsonb NOT NULL CHECK(jsonb_typeof(rows)='array' AND jsonb_array_length(rows)=12)
);
CREATE TRIGGER bb_billing_cost_versions_frozen BEFORE UPDATE OR DELETE ON bb_billing_cost_versions FOR EACH ROW EXECUTE FUNCTION bb_credit_immutable();

-- These eleven base fen are the original published authority; missing C_plan is deliberately NULL.
-- They can be compared, but cannot pass complete-cost validation or publish a new managed price.
WITH original(sku,base,cost) AS(VALUES
 ('quarter','5214',NULL),('annual','11965',NULL),('two_year','20335',NULL),('three_year','30808',NULL),
 ('migration','30368',NULL),('new','51058',NULL),('related','4685',NULL),('workpaper','2034',NULL),
 ('integrity','13375',NULL),('response','716',NULL),('check','3585',NULL),('full_review','15997','7.5454800512')
), frozen AS(SELECT jsonb_agg(jsonb_build_object('sku',sku,'planned_cost_cny',cost,'base_price_fen',base,'source',
 CASE WHEN cost IS NULL THEN 'Original 2026-10-29 spec base_fen; full-precision C_plan source not supplied'
 ELSE 'docs/product-decisions/2026-10-29-full-review-standard-cost.md; planned cost, not observed invoice' END) ORDER BY sku) rows FROM original)
INSERT INTO bb_billing_cost_versions(id,checksum,complete,created_by,change_reason,rows)
 SELECT 'bb-standard-cost-20261029-incomplete',encode(sha256(convert_to(rows::text,'UTF8')),'hex'),false,'migration:0146',
 'Original 1x bases frozen for comparison only. Eleven cost sources remain missing; existing v3 remains valid.',rows FROM frozen;

CREATE TABLE bb_billing_price_drafts(
 id text PRIMARY KEY CHECK(id~'^bb-task-price-managed-[a-f0-9]{32}$'),
 base_cost_version text NOT NULL REFERENCES bb_billing_cost_versions(id),base_cost_checksum char(64) NOT NULL,
 multiplier_bps text NOT NULL CHECK(multiplier_bps~'^[1-9][0-9]{0,6}$' AND multiplier_bps::bigint<=1000000),
 comparison_version text NOT NULL REFERENCES bb_credit_price_versions(id),change_reason text NOT NULL CHECK(length(trim(change_reason))>0),
 rollback_of text REFERENCES bb_billing_price_drafts(id),rows jsonb NOT NULL CHECK(jsonb_typeof(rows)='array' AND jsonb_array_length(rows)=12),
 checksum char(64) NOT NULL CHECK(checksum~'^[a-f0-9]{64}$'),validated_checksum char(64),validation_checks jsonb NOT NULL DEFAULT '[]',
 state text NOT NULL DEFAULT 'DRAFT' CHECK(state IN ('DRAFT','PUBLISHED')),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 created_by text NOT NULL REFERENCES bb_users(id),effective_at timestamptz,published_at timestamptz,published_by text REFERENCES bb_users(id),
 publish_grant_id text REFERENCES bb_billing_operator_grants(id),
 CHECK(validated_checksum IS NULL OR validated_checksum=checksum),
 CHECK((state='DRAFT' AND effective_at IS NULL AND published_at IS NULL AND published_by IS NULL AND publish_grant_id IS NULL) OR
       (state='PUBLISHED' AND effective_at IS NOT NULL AND published_at IS NOT NULL AND published_by IS NOT NULL AND publish_grant_id IS NOT NULL AND validated_checksum=checksum))
);
CREATE INDEX bb_billing_price_scheduled ON bb_billing_price_drafts(effective_at) WHERE state='PUBLISHED';
CREATE TABLE bb_billing_price_audit(
 id text PRIMARY KEY,actor text NOT NULL REFERENCES bb_users(id),aggregate_id text NOT NULL,operation text NOT NULL,
 payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER bb_billing_price_audit_frozen BEFORE UPDATE OR DELETE ON bb_billing_price_audit FOR EACH ROW EXECUTE FUNCTION bb_credit_immutable();
CREATE FUNCTION bb_billing_price_draft_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Price history cannot be deleted' USING ERRCODE='23514'; END IF;
 IF OLD.state='PUBLISHED' AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Published price is immutable; rollback creates a future version' USING ERRCODE='23514'; END IF;
 IF ROW(NEW.id,NEW.base_cost_version,NEW.base_cost_checksum,NEW.multiplier_bps,NEW.comparison_version,NEW.change_reason,NEW.rollback_of,NEW.rows,NEW.checksum,NEW.created_at,NEW.created_by)
 IS DISTINCT FROM ROW(OLD.id,OLD.base_cost_version,OLD.base_cost_checksum,OLD.multiplier_bps,OLD.comparison_version,OLD.change_reason,OLD.rollback_of,OLD.rows,OLD.checksum,OLD.created_at,OLD.created_by)
 THEN RAISE EXCEPTION 'Draft content is frozen; changes require a new draft and validation' USING ERRCODE='23514'; END IF;
 IF NEW.state='PUBLISHED' AND OLD.state='DRAFT' THEN
  IF NEW.effective_at<=clock_timestamp() OR NOT EXISTS(SELECT 1 FROM bb_billing_cost_versions c WHERE c.id=NEW.base_cost_version AND c.complete AND c.checksum=NEW.base_cost_checksum)
   OR jsonb_array_length(NEW.validation_checks)<7 OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.validation_checks) c WHERE c->>'passed' IS DISTINCT FROM 'true')
   OR NOT EXISTS(SELECT 1 FROM bb_credit_price_versions p WHERE p.id=NEW.id AND p.effective_at=NEW.effective_at AND p.actor=NEW.published_by AND p.pricing_mode='outcome_cny_v1')
   OR NOT EXISTS(SELECT 1 FROM bb_billing_operator_grants g JOIN bb_users u ON u.id=g.user_id WHERE g.id=NEW.publish_grant_id AND g.user_id=NEW.published_by AND g.permission='price_publish' AND g.revoked_at IS NULL AND u.status='active')
  THEN RAISE EXCEPTION 'Validated complete costs, future schedule and active publishing authority required' USING ERRCODE='23514'; END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER bb_billing_price_draft_frozen BEFORE UPDATE OR DELETE ON bb_billing_price_drafts FOR EACH ROW EXECUTE FUNCTION bb_billing_price_draft_guard();
CREATE FUNCTION bb_is_automatic_price_version(v text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT v IN ('bb-task-price-170-20261029-v2','bb-task-price-170-20261029-v3') OR v~'^bb-task-price-managed-[a-f0-9]{32}$'
$$;
CREATE FUNCTION bb_is_outcome_price_version(v text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT v IN ('outcome-cny-20261028-v1','outcome-cny-20261028-v2') OR bb_is_automatic_price_version(v)
$$;
ALTER TABLE bb_scope_quotations DROP CONSTRAINT bb_automatic_scope_shape;
ALTER TABLE bb_scope_quotations ADD CONSTRAINT bb_automatic_scope_shape CHECK(automatic_price IS NULL OR
 (jsonb_typeof(automatic_price)='object' AND bb_is_automatic_price_version(price_version) AND work_plan IS NULL));
ALTER TABLE bb_scope_quotations DROP CONSTRAINT bb_scope_price_version;
ALTER TABLE bb_scope_quotations ADD CONSTRAINT bb_scope_price_version CHECK(bb_is_outcome_price_version(price_version));
ALTER TABLE bb_credit_quotes DROP CONSTRAINT bb_outcome_authoring_quote;
ALTER TABLE bb_credit_quotes ADD CONSTRAINT bb_outcome_authoring_quote CHECK(pricing_mode<>'outcome_cny_v1' OR
 (bb_is_outcome_price_version(price_version) AND scope_quote_id IS NOT NULL AND points>=0));
ALTER TABLE bb_m4_quotes DROP CONSTRAINT bb_outcome_m4_quote;
ALTER TABLE bb_m4_quotes ADD CONSTRAINT bb_outcome_m4_quote CHECK(pricing_mode<>'outcome_cny_v1' OR
 (billing_method='fixed' AND bb_is_outcome_price_version(fixed_price_version) AND billing_policy='on_delivery' AND scope_quote_id IS NOT NULL AND reserve_points>=0));
ALTER TABLE bb_project_qa_quotes DROP CONSTRAINT bb_project_qa_price_terms;
ALTER TABLE bb_project_qa_quotes ADD CONSTRAINT bb_project_qa_price_terms CHECK(
 (price_version='project-qa-question-60-v1' AND unit_points=60 AND points=question_count*unit_points) OR
 (bb_is_outcome_price_version(price_version) AND points>=0 AND unit_points>=0 AND (points=0 OR scope_quote_id IS NOT NULL)));
ALTER TABLE bb_project_file_update_quotes DROP CONSTRAINT bb_project_file_update_price_terms;
ALTER TABLE bb_project_file_update_quotes ADD CONSTRAINT bb_project_file_update_price_terms CHECK(
 (price_version='project-file-update-4500-v1' AND points=4500) OR (bb_is_outcome_price_version(price_version) AND points>=0 AND scope_quote_id IS NOT NULL));
ALTER TABLE bb_project_file_check_quotes DROP CONSTRAINT bb_project_file_check_quotes_price_version_check;
ALTER TABLE bb_project_file_check_quotes ADD CONSTRAINT bb_project_file_check_quotes_price_version_check CHECK(bb_is_outcome_price_version(price_version));
ALTER TABLE bb_integrity_quotes DROP CONSTRAINT bb_integrity_quote_price_terms;
ALTER TABLE bb_integrity_quotes ADD CONSTRAINT bb_integrity_quote_price_terms CHECK(
 (scope_quote_id IS NULL AND price_version='integrity-round-5000-v1' AND points=5000) OR (scope_quote_id IS NOT NULL AND bb_is_outcome_price_version(price_version) AND points>0));
-- Preserve the existing arithmetic/paid-parent guards and extend the recognized policy family.
DO $$ DECLARE definition text; marker text:='IF NEW.price_version IN (''bb-task-price-170-20261029-v2'',''bb-task-price-170-20261029-v3'') THEN'; BEGIN
 SELECT pg_get_functiondef('bb_automatic_scope_price_guard()'::regprocedure) INTO definition;
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'Unexpected automatic scope guard'; END IF;
 EXECUTE replace(definition,marker,'IF bb_is_automatic_price_version(NEW.price_version) THEN
  IF NOT EXISTS(SELECT 1 FROM bb_credit_price_versions p LEFT JOIN bb_billing_price_drafts d ON d.id=p.id
    WHERE p.id=NEW.price_version AND p.effective_at<=now() AND p.pricing_mode=''outcome_cny_v1''
      AND (p.id IN (''bb-task-price-170-20261029-v2'',''bb-task-price-170-20261029-v3'') OR d.state=''PUBLISHED''))
  THEN RAISE EXCEPTION ''Published effective automatic tariff required'' USING ERRCODE=''23514''; END IF;');
END $$;
DO $$ DECLARE definition text; marker text:='IN (''outcome-cny-20261028-v1'',''outcome-cny-20261028-v2'',''bb-task-price-170-20261029-v2'',''bb-task-price-170-20261029-v3'')'; BEGIN
 SELECT pg_get_functiondef('bb_outcome_qa_followup_guard()'::regprocedure) INTO definition;
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'Unexpected QA followup guard'; END IF;
 definition:=replace(definition,'NEW.price_version '||marker,'bb_is_outcome_price_version(NEW.price_version)');
 definition:=replace(definition,'price.price_version '||marker,'bb_is_outcome_price_version(price.price_version)');EXECUTE definition;
END $$;
