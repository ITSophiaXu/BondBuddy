-- Persist each new M4 settlement's actual charge. Earlier partial metered
-- settlements omitted this projection; do not rewrite their financial events.
DO $$ DECLARE definition text; marker text; BEGIN
 SELECT pg_get_functiondef('bb_m4_credit_finalize_run()'::regprocedure) INTO definition;
 marker:='UPDATE bb_credit_lots SET frozen=frozen-allocation.points,remaining=remaining-take WHERE id=l.id;';
 IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN
  RAISE EXCEPTION 'M4 settlement allocation anchor changed'; END IF;
 EXECUTE replace(definition,marker,marker||E'\n   UPDATE bb_credit_allocations SET charged_points=take WHERE reservation_id=r.id AND lot_id=allocation.lot_id;');
END $$;

-- NULL means evidence is incomplete, never an assumed full charge. Historical
-- M4 metering is reconstructed using the original finalizer's lot_id ordering,
-- only when immutable quote, metering and append-only settlement totals agree.
CREATE FUNCTION bb_credit_allocation_charge(p_reservation text,p_lot text) RETURNS bigint LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN a.charged_points IS NOT NULL THEN a.charged_points
  WHEN r.state IN ('held','released') AND r.billing_policy='on_delivery' THEN 0
  WHEN r.state='settled' AND r.billing_policy='on_delivery'
   AND r.points=(SELECT sum(x.points) FROM bb_credit_allocations x WHERE x.reservation_id=r.id)
   AND COALESCE(r.charged_points,r.points)=(SELECT COALESCE(sum(e.points),0) FROM bb_credit_events e WHERE e.reservation_id=r.id AND e.kind='settle')
   AND COALESCE(r.charged_points,r.points)=r.points THEN a.points
  WHEN r.state='settled' AND r.billing_policy='on_delivery' AND r.charged_points BETWEEN 0 AND r.points
   AND r.points=(SELECT sum(x.points) FROM bb_credit_allocations x WHERE x.reservation_id=r.id)
   AND r.charged_points=(SELECT COALESCE(sum(e.points),0) FROM bb_credit_events e WHERE e.reservation_id=r.id AND e.kind='settle')
   AND EXISTS(SELECT 1 FROM bb_m4_quotes q JOIN bb_m4_metering m ON m.run_id=r.run_id AND m.owner_user_id=r.owner_user_id
     WHERE q.id=r.quote_id AND q.owner_user_id=r.owner_user_id AND q.billing_method='metered_capped' AND m.status IN ('verified','waived') AND m.charged_points=r.charged_points)
   THEN GREATEST(0,LEAST(a.points,r.charged_points-COALESCE((SELECT sum(x.points) FROM bb_credit_allocations x WHERE x.reservation_id=r.id AND x.lot_id<a.lot_id),0)))
  ELSE NULL END
 FROM bb_credit_allocations a JOIN bb_credit_reservations r ON r.id=a.reservation_id
 WHERE a.reservation_id=p_reservation AND a.lot_id=p_lot
$$;

-- Acceptance units remain immutable. Project only the portion of each original
-- lot slice that was actually charged, preserving the original item ordering.
CREATE FUNCTION bb_task_refund_actual_slices(p_reservation text,p_item text)
 RETURNS TABLE(origin_lot_id text,points bigint) LANGUAGE sql STABLE AS $$
 SELECT s.origin_lot_id,CASE WHEN bb_credit_allocation_charge(s.reservation_id,s.origin_lot_id) IS NULL THEN NULL
  ELSE GREATEST(0,LEAST(s.points,bb_credit_allocation_charge(s.reservation_id,s.origin_lot_id)-COALESCE((
   SELECT sum(previous.points) FROM bb_task_refund_unit_slices previous JOIN bb_task_refund_units pu USING(reservation_id,item_id)
   WHERE previous.reservation_id=s.reservation_id AND previous.origin_lot_id=s.origin_lot_id AND pu.ordinal<u.ordinal),0))) END
 FROM bb_task_refund_unit_slices s JOIN bb_task_refund_units u USING(reservation_id,item_id)
 WHERE s.reservation_id=p_reservation AND s.item_id=p_item
$$;

-- Snapshot new requested amounts separately; old immutable applications retain
-- their original requested cap and report the exact credits actually approved.
CREATE TABLE bb_task_refund_requested_amounts(
 request_id text NOT NULL,item_id text NOT NULL,points bigint NOT NULL CHECK(points>0),
 PRIMARY KEY(request_id,item_id),FOREIGN KEY(request_id,item_id) REFERENCES bb_task_refund_request_items(request_id,item_id)
);
CREATE TRIGGER bb_task_refund_requested_amounts_immutable BEFORE UPDATE OR DELETE ON bb_task_refund_requested_amounts
 FOR EACH ROW EXECUTE FUNCTION bb_credit_immutable();

CREATE OR REPLACE FUNCTION bb_task_refund_credit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cap bigint; old_returns numeric; allocated bigint; unit_owner text; total_charge bigint; BEGIN
 PERFORM bb_assert_wallet_writable(NEW.owner_user_id);
 PERFORM 1 FROM bb_credit_accounts WHERE owner_user_id=NEW.owner_user_id FOR UPDATE;
 SELECT u.owner_user_id,s.points INTO unit_owner,cap FROM bb_task_refund_units u
 JOIN LATERAL bb_task_refund_actual_slices(u.reservation_id,u.item_id) s ON true
 JOIN bb_credit_reservations r ON r.id=u.reservation_id JOIN bb_runs run ON run.id=r.run_id
 WHERE u.reservation_id=NEW.reservation_id AND u.item_id=NEW.item_id AND s.origin_lot_id=NEW.origin_lot_id
 AND r.state='settled' AND run.state='succeeded';
 IF unit_owner IS DISTINCT FROM NEW.owner_user_id OR cap IS DISTINCT FROM NEW.points
 THEN RAISE EXCEPTION 'Actual charged task slice required' USING ERRCODE='23514'; END IF;
 SELECT bb_credit_allocation_charge(NEW.reservation_id,NEW.origin_lot_id) INTO allocated;
 SELECT COALESCE(sum(points),0) INTO old_returns FROM bb_task_refund_credits WHERE reservation_id=NEW.reservation_id AND origin_lot_id=NEW.origin_lot_id;
 SELECT old_returns+COALESCE(sum(original_points),0) INTO old_returns FROM bb_credit_lots
 WHERE owner_user_id=NEW.owner_user_id AND source_key IN ('settlement-correction:'||NEW.reservation_id||':'||NEW.origin_lot_id,'failure:'||NEW.reservation_id||':'||NEW.origin_lot_id,'dynamic-failure:'||NEW.reservation_id||':'||NEW.origin_lot_id);
 IF allocated IS NULL OR old_returns+NEW.points>allocated THEN RAISE EXCEPTION 'Task return exceeds original charge' USING ERRCODE='23514'; END IF;
 SELECT COALESCE(charged_points,points) INTO total_charge FROM bb_credit_reservations WHERE id=NEW.reservation_id;
 SELECT COALESCE(sum(e.points),0) INTO old_returns FROM bb_credit_events e WHERE e.reservation_id=NEW.reservation_id AND e.kind='correction';
 -- Current transaction credits precede their events, so count them exactly once.
 SELECT old_returns+COALESCE(sum(t.points),0) INTO old_returns FROM bb_task_refund_credits t
 WHERE t.reservation_id=NEW.reservation_id AND NOT EXISTS(SELECT 1 FROM bb_credit_events e WHERE e.reservation_id=t.reservation_id AND e.lot_id=t.return_lot_id AND e.kind='correction');
 IF old_returns+NEW.points>total_charge THEN RAISE EXCEPTION 'Task return exceeds total actual charge' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
