-- Review quotes pin the execution intent at draft_revision, while each review run
-- receives a fresh input_revision. Preserve every original source branch and add
-- only the paid-review case where those two revision counters legitimately differ.
-- No historic quotation, reservation, charge, or zero-price entitlement is changed.
CREATE OR REPLACE FUNCTION bb_commerce_scope_source_quotes(p_owner text,p_scope text,p_run text)
RETURNS TABLE(quote_id text,acceptance_id text) LANGUAGE sql STABLE AS $$
 SELECT q.id,NULL::text FROM bb_credit_quotes q JOIN bb_runs r ON r.owner_user_id=q.owner_user_id
  AND r.project_id=q.project_id AND r.input_revision=q.input_revision
 WHERE r.owner_user_id=p_owner AND r.id=p_run AND q.scope_quote_id=p_scope
 UNION ALL
 SELECT q.id,NULL::text FROM bb_credit_quotes q
 JOIN bb_credit_reservations h ON h.owner_user_id=q.owner_user_id AND h.quote_id=q.id AND h.points=q.points
 JOIN bb_runs r ON r.owner_user_id=h.owner_user_id AND r.id=h.run_id AND r.reservation_id=h.id AND r.project_id=q.project_id
 JOIN bb_review_executions e ON e.owner_user_id=r.owner_user_id AND e.run_id=r.id AND e.project_id=r.project_id
 JOIN bb_scope_quotations s ON s.owner_user_id=q.owner_user_id AND s.id=q.scope_quote_id AND s.project_id=q.project_id
  AND s.action='review' AND s.input_hash=q.intent_hash AND s.amount_fen=q.points AND s.price_version=q.price_version
  AND s.snapshot->>'task'=q.task_type
 WHERE r.owner_user_id=p_owner AND r.id=p_run AND q.scope_quote_id=p_scope
  AND q.pricing_mode='outcome_cny_v1' AND q.intent_hash IS NOT NULL AND q.points>0
  AND r.input_revision IS DISTINCT FROM q.input_revision
  AND q.task_type=CASE WHEN e.operation='revision' THEN 'review_revision' ELSE e.operation END
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
