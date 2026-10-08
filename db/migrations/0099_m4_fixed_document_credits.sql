-- New M4 document quotations use the approved fixed price. Existing quotes/runs keep their terms.
ALTER TABLE bb_m4_quotes ADD COLUMN billing_method text NOT NULL DEFAULT 'metered_capped'
 CHECK(billing_method IN ('fixed','metered_capped'));
ALTER TABLE bb_m4_quotes ADD COLUMN fixed_price_version text;
ALTER TABLE bb_m4_quotes ADD CONSTRAINT bb_m4_fixed_quote_terms CHECK(
 (billing_method='metered_capped' AND fixed_price_version IS NULL) OR
 (billing_method='fixed' AND task_type IN ('m4_G01','m4_G02','m4_G03','m4_G05')
  AND config_id IS NULL AND reserve_points>0 AND fixed_price_version IS NOT NULL));

-- Route only owned M4 reservations away from the M1/M2 fixed-credit finalizer.
-- Keep its existing recovery and expiry compensation behavior unchanged.
DO $$ DECLARE definition text; marker text := '  PERFORM 1 FROM bb_credit_accounts WHERE owner_user_id=NEW.owner_user_id FOR UPDATE;';
BEGIN
 SELECT pg_get_functiondef('bb_credit_finalize_run()'::regprocedure) INTO definition;
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'Unexpected fixed-credit finalizer definition'; END IF;
 definition:=replace(definition,marker,
   '  IF EXISTS(SELECT 1 FROM bb_credit_reservations m4_reservation JOIN bb_m4_quotes m4_quote ON m4_quote.id=m4_reservation.quote_id AND m4_quote.owner_user_id=m4_reservation.owner_user_id
     WHERE m4_reservation.id=NEW.reservation_id AND m4_reservation.run_id=NEW.id AND m4_reservation.owner_user_id=NEW.owner_user_id) THEN RETURN NEW; END IF;'||chr(10)||marker);
 EXECUTE definition;
END $$;

CREATE OR REPLACE FUNCTION bb_m4_credit_finalize_run() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r bb_credit_reservations%ROWTYPE; q bb_m4_quotes%ROWTYPE; allocation record; charged bigint; remaining_charge bigint; take bigint; l bb_credit_lots%ROWTYPE; compensation text;
BEGIN
 IF NEW.billing_mode NOT IN ('fixed_credits','metered_credits') OR NEW.state NOT IN ('succeeded','failed','cancelled','rejected') OR OLD.state=NEW.state THEN RETURN NEW; END IF;
 SELECT quotes.* INTO q FROM bb_credit_reservations reservations JOIN bb_m4_quotes quotes
   ON quotes.id=reservations.quote_id AND quotes.owner_user_id=reservations.owner_user_id
   WHERE reservations.id=NEW.reservation_id AND reservations.owner_user_id=NEW.owner_user_id AND reservations.run_id=NEW.id;
 IF NOT FOUND THEN RETURN NEW; END IF;
 IF (NEW.billing_mode='fixed_credits') IS DISTINCT FROM (q.billing_method='fixed')
   OR (q.billing_method='fixed' AND NEW.task_kind<>'generation')
 THEN RAISE EXCEPTION 'M4 billing mode does not match immutable quotation' USING ERRCODE='23514'; END IF;
 PERFORM 1 FROM bb_credit_accounts WHERE owner_user_id=NEW.owner_user_id FOR UPDATE;
 SELECT * INTO STRICT r FROM bb_credit_reservations WHERE id=NEW.reservation_id AND owner_user_id=NEW.owner_user_id AND run_id=NEW.id FOR UPDATE;
 IF r.state<>'held' THEN RAISE EXCEPTION 'M4 reservation already finalized' USING ERRCODE='23514'; END IF;
 charged:=0;
 IF NEW.state='succeeded' THEN
   IF q.billing_method='fixed' THEN charged:=r.points;
   ELSE SELECT charged_points INTO STRICT charged FROM bb_m4_metering WHERE run_id=NEW.id AND owner_user_id=NEW.owner_user_id;
   END IF;
   IF charged>r.points THEN RAISE EXCEPTION 'M4 charge exceeds reservation' USING ERRCODE='23514'; END IF;
   IF NEW.task_kind='generation' THEN
     IF (SELECT count(*) FROM bb_m4_artifacts a JOIN bb_artifact_versions v ON v.id=a.artifact_id AND v.version=a.artifact_version
       JOIN bb_word_delivery_evidence e ON e.id=v.word_delivery_evidence_id
       WHERE a.owner_user_id=NEW.owner_user_id AND a.run_id=NEW.id AND a.kind IN ('document','preparation_note')
       AND v.owner_user_id=a.owner_user_id AND v.run_id=a.run_id AND v.delivery_status='available'
       AND e.owner_user_id=v.owner_user_id AND e.run_id=v.run_id AND e.artifact_id=v.id AND e.artifact_version=v.version
       AND e.delivery_code='readback_verified' AND e.delivery_status='available' AND e.readback_sha256=v.sha256 AND e.candidate_sha256=v.sha256)<>2
     THEN RAISE EXCEPTION 'M4 document and preparation note must be delivered' USING ERRCODE='23514'; END IF;
   ELSIF NEW.task_kind='qa' AND NOT EXISTS(SELECT 1 FROM bb_m4_artifacts a JOIN bb_artifact_versions v ON v.id=a.artifact_id AND v.version=a.artifact_version
     WHERE a.owner_user_id=NEW.owner_user_id AND a.run_id=NEW.id AND a.kind='qa_text' AND v.owner_user_id=a.owner_user_id AND v.run_id=a.run_id
     AND v.id=NEW.artifact_id AND v.version=NEW.artifact_version AND v.media_type='text/plain' AND v.delivery_status='available')
   THEN RAISE EXCEPTION 'M4 QA text must be delivered' USING ERRCODE='23514'; END IF;
 END IF;
 remaining_charge:=charged;
 FOR allocation IN SELECT * FROM bb_credit_allocations WHERE reservation_id=r.id ORDER BY lot_id LOOP
   SELECT * INTO STRICT l FROM bb_credit_lots WHERE id=allocation.lot_id AND owner_user_id=NEW.owner_user_id FOR UPDATE;
   take:=LEAST(allocation.points,remaining_charge); remaining_charge:=remaining_charge-take;
   UPDATE bb_credit_lots SET frozen=frozen-allocation.points,remaining=remaining-take WHERE id=l.id;
   IF NEW.state='failed' AND l.expires_at<=now() THEN
     UPDATE bb_credit_lots SET remaining=remaining-allocation.points WHERE id=l.id;
     compensation:='failure:'||r.id||':'||l.id;
     INSERT INTO bb_credit_lots(id,owner_user_id,source,source_key,original_points,remaining,expires_at)
       VALUES(compensation,NEW.owner_user_id,'failure_compensation',compensation,allocation.points,allocation.points,now()+interval '7 days');
     INSERT INTO bb_credit_events(id,owner_user_id,event_key,kind,points,lot_id,run_id,actor,reason)
       VALUES(compensation,NEW.owner_user_id,compensation,'grant',allocation.points,compensation,NEW.id,'system','expired_hold_platform_failure');
   END IF;
 END LOOP;
 UPDATE bb_credit_reservations SET state=CASE WHEN NEW.state='succeeded' THEN 'settled' ELSE 'released' END,charged_points=charged,finalized_at=now() WHERE id=r.id;
 IF charged>0 THEN INSERT INTO bb_credit_events(id,owner_user_id,event_key,kind,points,reservation_id,run_id,actor,reason)
   VALUES('final:'||r.id,NEW.owner_user_id,'final:'||r.id,'settle',charged,r.id,NEW.id,'system',CASE WHEN q.billing_method='fixed' THEN 'm4_fixed_price_delivery' ELSE 'm4_verified_cost_capped' END); END IF;
 IF r.points>charged THEN INSERT INTO bb_credit_events(id,owner_user_id,event_key,kind,points,reservation_id,run_id,actor,reason)
   VALUES('release:'||r.id,NEW.owner_user_id,'release:'||r.id,'release',r.points-charged,r.id,NEW.id,'system',NEW.state); END IF;
 RETURN NEW;
END $$;
