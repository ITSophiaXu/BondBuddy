-- New v4 integrity contracts charge only distinct, evidenced successful query
-- pairs. Accepted older versions retain their original price and policy. The
-- original finalizer still owns lot locking, actual allocations, release events,
-- delivery checks, wallet isolation and exactly-once terminal settlement.
DO $$ DECLARE definition text; marker text; replacement text; BEGIN
 SELECT pg_get_functiondef('bb_credit_finalize_run()'::regprocedure) INTO definition;
 marker:='DECLARE r bb_credit_reservations%ROWTYPE;';
 IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN
  RAISE EXCEPTION 'Expected one generic settlement declaration anchor'; END IF;
 definition:=replace(definition,marker,'DECLARE actual_integrity_scope boolean := false; r bb_credit_reservations%ROWTYPE;');
 marker:='remaining_charge := charged;';
 IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN
  RAISE EXCEPTION 'Expected one generic actual-charge allocation anchor'; END IF;
 replacement:=$patch$IF NEW.state='succeeded' AND r.billing_policy='on_delivery' AND EXISTS(
   SELECT 1 FROM bb_integrity_quotes q WHERE q.id=r.quote_id AND q.owner_user_id=r.owner_user_id
    AND q.run_id=r.run_id AND q.price_version='bb-task-price-scope-20261111-v4') THEN
   actual_integrity_scope := true;
   SELECT LEAST(r.points,CASE WHEN success_count>0 THEN LEAST(22738::bigint,2000::bigint+85::bigint*success_count) ELSE 0 END)
    INTO charged FROM (SELECT bb_integrity_verified_query_pair_count(i.owner_user_id,i.run_id,i.result->'records') success_count
      FROM bb_integrity_runs i WHERE i.owner_user_id=NEW.owner_user_id AND i.run_id=NEW.id AND i.operation='check') verified;
   IF charged IS NULL OR charged<=0 THEN RAISE EXCEPTION 'Successful evidenced integrity query required for v4 settlement' USING ERRCODE='23514'; END IF;
  END IF;
  remaining_charge := charged;$patch$;
 definition:=replace(definition,marker,replacement);
 -- Match 0147 acceptance slices for the new partial scope contract. This
 -- preserves base/pair amounts and original source rights across cash and
 -- expiring grants. Accepted old contracts retain their original lot_id order.
 marker:='FOR a IN SELECT * FROM bb_credit_allocations WHERE reservation_id=r.id ORDER BY lot_id LOOP';
 IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN
  RAISE EXCEPTION 'Expected one generic settlement lot-order anchor'; END IF;
 replacement:=$patch$FOR a IN SELECT allocation.* FROM bb_credit_allocations allocation
   JOIN bb_credit_lots origin ON origin.id=allocation.lot_id WHERE allocation.reservation_id=r.id
   ORDER BY CASE WHEN actual_integrity_scope THEN CASE WHEN origin.source='purchase' THEN 1 ELSE 0 END END,
    CASE WHEN actual_integrity_scope THEN origin.expires_at END ASC NULLS LAST,
    CASE WHEN actual_integrity_scope THEN origin.created_at END,allocation.lot_id LOOP$patch$;
 EXECUTE replace(definition,marker,replacement);
END $$;
