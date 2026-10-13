-- New quotations pin their policy. Existing quotes and reservations remain on delivery.
ALTER TABLE bb_m4_quotes ADD COLUMN billing_policy text NOT NULL DEFAULT 'on_delivery'
 CHECK(billing_policy IN ('on_delivery','authoring_balance_v2'));
ALTER TABLE bb_m4_quotes ADD CONSTRAINT bb_m4_dynamic_document_policy CHECK(
 billing_policy='on_delivery' OR (billing_method='fixed' AND task_type IN ('m4_G01','m4_G02','m4_G03','m4_G05')));

CREATE OR REPLACE FUNCTION bb_m4_credit_finalize_run() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r bb_credit_reservations%ROWTYPE; q bb_m4_quotes%ROWTYPE; allocation record; charged bigint; remaining_charge bigint; take bigint; l bb_credit_lots%ROWTYPE; compensation text;
BEGIN
 IF NEW.billing_mode NOT IN ('fixed_credits','metered_credits') OR NEW.state NOT IN ('succeeded','failed','cancelled','rejected') OR OLD.state=NEW.state THEN RETURN NEW; END IF;
 SELECT quotes.* INTO q FROM bb_credit_reservations reservations JOIN bb_m4_quotes quotes
   ON quotes.id=reservations.quote_id AND quotes.owner_user_id=reservations.owner_user_id
   WHERE reservations.id=NEW.reservation_id AND reservations.owner_user_id=NEW.owner_user_id AND reservations.run_id=NEW.id;
 IF NOT FOUND THEN RETURN NEW; END IF;
 IF (NEW.billing_mode='fixed_credits') IS DISTINCT FROM (q.billing_method='fixed')
   OR (q.billing_method='fixed' AND NOT ((NEW.task_kind='generation' AND q.task_type IN ('m4_G01','m4_G02','m4_G03','m4_G05')) OR (NEW.task_kind='qa' AND q.task_type IN ('m4_Q01','m4_Q02','m4_Q03','m4_Q04','m4_Q05'))))
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
  IF r.billing_policy='authoring_balance_v2' THEN
    IF NEW.state='succeeded' AND COALESCE(r.charged_points,0)<>r.points THEN
      RAISE EXCEPTION 'Dynamic authoring balance not fully settled' USING ERRCODE='23514';
    END IF;
    -- Each progress debit is already in the append-only ledger. Platform failures refund it.
    IF NEW.state IN ('failed','rejected') THEN
      FOR allocation IN SELECT * FROM bb_credit_allocations WHERE reservation_id=r.id AND charged_points>0 ORDER BY lot_id LOOP
        SELECT * INTO STRICT l FROM bb_credit_lots WHERE id=allocation.lot_id AND owner_user_id=NEW.owner_user_id FOR UPDATE;
        compensation := 'dynamic-failure:'||r.id||':'||l.id;
        INSERT INTO bb_credit_lots(id,owner_user_id,source,source_key,original_points,remaining,expires_at)
          VALUES(compensation,NEW.owner_user_id,CASE WHEN l.source='purchase' THEN 'purchase' ELSE 'correction' END,
          compensation,allocation.charged_points,allocation.charged_points,CASE WHEN l.expires_at<=now() THEN now()+interval '7 days' ELSE l.expires_at END);
        INSERT INTO bb_credit_events(id,owner_user_id,event_key,kind,points,lot_id,reservation_id,run_id,actor,reason)
          VALUES(compensation,NEW.owner_user_id,compensation,'correction',allocation.charged_points,compensation,r.id,NEW.id,'system','authoring_platform_failure_refund');
      END LOOP;
    END IF;
    UPDATE bb_credit_reservations SET state=CASE WHEN NEW.state IN ('failed','rejected') OR COALESCE(charged_points,0)=0 THEN 'released' ELSE 'settled' END,
      finalized_at=now() WHERE id=r.id;
    RETURN NEW;
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
