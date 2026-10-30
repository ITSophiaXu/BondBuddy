-- A historical task without an original independent allocation has one explicit
-- whole-task refund unit. Returning it also revokes every dependent task item.
CREATE OR REPLACE FUNCTION bb_task_item_was_refunded(p_owner text,p_run text,p_key text) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM bb_credit_reservations r JOIN bb_credit_events e ON e.reservation_id=r.id AND e.owner_user_id=r.owner_user_id
 JOIN bb_credit_lots l ON l.id=e.lot_id AND l.owner_user_id=e.owner_user_id
 WHERE r.owner_user_id=p_owner AND r.run_id=p_run AND e.kind='correction'
 AND (l.source_key LIKE 'settlement-correction:%' OR l.source_key LIKE 'failure:%' OR l.source_key LIKE 'dynamic-failure:%'))
 OR EXISTS(SELECT 1 FROM bb_task_refund_units u JOIN bb_task_refund_returned_items x USING(reservation_id,item_id)
 WHERE u.owner_user_id=p_owner AND u.run_id=p_run AND (u.evidence_kind='legacy_task' OR u.source_item_key=p_key))
$$;
