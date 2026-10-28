-- Contract coverage is earned by an exactly bound, successfully settled delivery.
-- Historical quotations retain their original price version and earn no inferred coverage.
ALTER TABLE bb_scope_quotations ADD COLUMN price_version text NOT NULL DEFAULT 'outcome-cny-20261028-v1';
ALTER TABLE bb_scope_quotations ADD COLUMN work_plan jsonb;
ALTER TABLE bb_scope_quotations ADD COLUMN pricing_items jsonb NOT NULL DEFAULT '[]';
ALTER TABLE bb_scope_quotations ADD CONSTRAINT bb_scope_work_plan_shape CHECK
 (work_plan IS NULL OR (jsonb_typeof(work_plan)='object' AND jsonb_typeof(work_plan->'items') IS NOT DISTINCT FROM 'array'));
ALTER TABLE bb_scope_quotations ADD CONSTRAINT bb_scope_pricing_items_shape CHECK(jsonb_typeof(pricing_items)='array');

CREATE TABLE bb_commerce_scope_runs (
 owner_user_id text NOT NULL,scope_quote_id text PRIMARY KEY,run_id text NOT NULL UNIQUE,
 plan jsonb NOT NULL CHECK(jsonb_typeof(plan)='object' AND jsonb_typeof(plan->'items') IS NOT DISTINCT FROM 'array'),
 pricing_items jsonb NOT NULL CHECK(jsonb_typeof(pricing_items)='array' AND jsonb_array_length(pricing_items)>0),
 bound_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(owner_user_id,scope_quote_id),
 FOREIGN KEY(owner_user_id,scope_quote_id) REFERENCES bb_scope_quotations(owner_user_id,id),
 FOREIGN KEY(owner_user_id,run_id) REFERENCES bb_runs(owner_user_id,id)
);
CREATE INDEX bb_commerce_scope_runs_owner ON bb_commerce_scope_runs(owner_user_id,bound_at,scope_quote_id);

-- The executable family quote, rather than a coincidentally equal run input hash,
-- proves the scope/run association. Full run inputs can also contain billing pins.
CREATE FUNCTION bb_commerce_scope_source_quotes(p_owner text,p_scope text,p_run text)
RETURNS TABLE(quote_id text,acceptance_id text) LANGUAGE sql STABLE AS $$
 SELECT q.id,NULL::text FROM bb_credit_quotes q JOIN bb_runs r ON r.owner_user_id=q.owner_user_id
  AND r.project_id=q.project_id AND r.input_revision=q.input_revision
 WHERE r.owner_user_id=p_owner AND r.id=p_run AND q.scope_quote_id=p_scope
 UNION ALL
 SELECT q.id,q.scope_acceptance_id FROM bb_m4_quotes q
 JOIN bb_m4_executions x ON x.owner_user_id=q.owner_user_id AND x.topic_id=q.topic_id
 JOIN bb_runs r ON r.owner_user_id=x.owner_user_id AND r.id=x.run_id
 JOIN bb_m4_topics t ON t.owner_user_id=q.owner_user_id AND t.id=q.topic_id AND t.project_id=r.project_id
 WHERE r.owner_user_id=p_owner AND r.id=p_run AND q.scope_quote_id=p_scope
 UNION ALL
 SELECT q.id,NULL::text FROM bb_project_qa_quotes q WHERE q.owner_user_id=p_owner AND q.run_id=p_run AND q.scope_quote_id=p_scope
 UNION ALL
 SELECT q.id,NULL::text FROM bb_project_file_check_quotes q WHERE q.owner_user_id=p_owner AND q.run_id=p_run AND q.scope_quote_id=p_scope
 UNION ALL
 SELECT q.id,q.scope_acceptance_id FROM bb_project_file_update_quotes q WHERE q.owner_user_id=p_owner AND q.run_id=p_run AND q.scope_quote_id=p_scope
 UNION ALL
 SELECT q.id,NULL::text FROM bb_integrity_quotes q WHERE q.owner_user_id=p_owner AND q.run_id=p_run AND q.scope_quote_id=p_scope
$$;

CREATE FUNCTION bb_commerce_scope_run_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s bb_scope_quotations; r bb_runs; BEGIN
 SELECT * INTO s FROM bb_scope_quotations WHERE owner_user_id=NEW.owner_user_id AND id=NEW.scope_quote_id FOR UPDATE;
 SELECT * INTO r FROM bb_runs WHERE owner_user_id=NEW.owner_user_id AND id=NEW.run_id;
 IF s.id IS NULL OR r.id IS NULL OR s.project_id IS DISTINCT FROM r.project_id OR s.published_at IS NULL
  OR s.amount_fen IS NULL OR s.amount_fen<0 OR s.work_plan IS NULL OR NEW.plan IS DISTINCT FROM s.work_plan
  OR NEW.pricing_items IS DISTINCT FROM s.pricing_items
  OR NOT EXISTS(SELECT 1 FROM bb_commerce_scope_source_quotes(NEW.owner_user_id,s.id,r.id))
 THEN RAISE EXCEPTION 'Owned accepted scope, exact executable quote and immutable plan required' USING ERRCODE='23514'; END IF;
 IF NOT (s.status='quoted' AND s.expires_at>clock_timestamp()) AND NOT EXISTS(
  SELECT 1 FROM bb_commerce_scope_source_quotes(NEW.owner_user_id,s.id,r.id) q
   JOIN bb_scope_acceptances a ON a.owner_user_id=NEW.owner_user_id AND a.id=q.acceptance_id AND a.scope_quote_id=s.id)
 THEN RAISE EXCEPTION 'Valid quotation or exact prior batch acceptance required' USING ERRCODE='23514'; END IF;
 IF s.amount_fen>0 AND NOT EXISTS(
  SELECT 1 FROM bb_credit_reservations res JOIN bb_commerce_scope_source_quotes(NEW.owner_user_id,s.id,r.id) q ON q.quote_id=res.quote_id
  WHERE res.id=r.reservation_id AND res.owner_user_id=r.owner_user_id AND res.run_id=r.id AND res.points=s.amount_fen)
 THEN RAISE EXCEPTION 'Exact owned scope reservation required' USING ERRCODE='23514'; END IF;
 IF s.amount_fen=0 AND (r.reservation_id IS NOT NULL OR EXISTS(
  SELECT 1 FROM jsonb_array_elements(NEW.pricing_items) item WHERE
   (item->>'due_fen')::bigint IS DISTINCT FROM 0 OR jsonb_typeof(item->'owned_coverage_ids') IS DISTINCT FROM 'array'
   OR jsonb_array_length(item->'owned_coverage_ids')=0))
 THEN RAISE EXCEPTION 'Zero-price continuation requires owned source coverage, never a pending placeholder' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_commerce_scope_run_valid BEFORE INSERT ON bb_commerce_scope_runs FOR EACH ROW EXECUTE FUNCTION bb_commerce_scope_run_guard();
CREATE TRIGGER bb_commerce_scope_run_immutable BEFORE UPDATE OR DELETE ON bb_commerce_scope_runs FOR EACH ROW EXECUTE FUNCTION bb_scope_audit_immutable();
