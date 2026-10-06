-- Opt-in paid review. No existing task, price or credit right is changed.
ALTER TABLE bb_credit_quotes DROP CONSTRAINT bb_credit_quotes_task_type_check;
ALTER TABLE bb_credit_quotes ADD CONSTRAINT bb_credit_quotes_task_type_check CHECK(task_type IN ('interim','annual','two_years','three_years','migration','migration_two_years','migration_three_years','new_authoring','full_review','differential_review','review_revision'));
ALTER TABLE bb_credit_quotes ADD COLUMN intent_hash char(64);
DO $$ DECLARE constraint_name text; BEGIN
  SELECT c.conname INTO STRICT constraint_name FROM pg_constraint c WHERE c.conrelid='bb_credit_quotes'::regclass AND c.contype='u'
    AND (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(num,ord) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.num)=ARRAY['owner_user_id','project_id','input_revision','price_version'];
  EXECUTE format('ALTER TABLE bb_credit_quotes DROP CONSTRAINT %I',constraint_name);
END $$;
CREATE UNIQUE INDEX bb_authoring_quote_identity ON bb_credit_quotes(owner_user_id,project_id,input_revision,price_version) WHERE intent_hash IS NULL;
CREATE UNIQUE INDEX bb_review_quote_identity ON bb_credit_quotes(owner_user_id,project_id,intent_hash,price_version) WHERE intent_hash IS NOT NULL;
CREATE OR REPLACE FUNCTION bb_credit_finalize_run() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r bb_credit_reservations%ROWTYPE; a record; l bb_credit_lots%ROWTYPE; pair jsonb; artifact text; compensation text;
BEGIN
  IF NEW.billing_mode <> 'fixed_credits' OR NEW.state NOT IN ('succeeded','failed','cancelled','rejected') OR OLD.state=NEW.state THEN RETURN NEW; END IF;
  PERFORM 1 FROM bb_credit_accounts WHERE owner_user_id=NEW.owner_user_id FOR UPDATE;
  SELECT * INTO STRICT r FROM bb_credit_reservations WHERE id=NEW.reservation_id AND run_id=NEW.id AND owner_user_id=NEW.owner_user_id FOR UPDATE;
  IF r.state <> 'held' AND NOT (r.state='released' AND EXISTS(
    SELECT 1 FROM bb_jobs WHERE run_id=NEW.id AND checkpoint ? 'word_pair_delivery_recovery'
  )) THEN RAISE EXCEPTION 'Credit reservation already finalized' USING ERRCODE='23514'; END IF;
  IF NEW.state='succeeded' AND NEW.task_kind='review' THEN
    IF NOT EXISTS(SELECT 1 FROM bb_review_artifacts a JOIN bb_artifact_versions v ON v.id=a.artifact_id AND v.version=a.artifact_version
      WHERE a.owner_user_id=NEW.owner_user_id AND a.run_id=NEW.id AND a.project_id=NEW.project_id AND a.kind='report'
      AND v.owner_user_id=NEW.owner_user_id AND v.run_id=NEW.id AND v.id=NEW.artifact_id AND v.version=NEW.artifact_version AND v.delivery_status='available' AND v.quality_status='passed')
    THEN RAISE EXCEPTION 'Delivered review report required for settlement' USING ERRCODE='23514'; END IF;
  ELSIF NEW.state='succeeded' THEN
    SELECT checkpoint->'stages'->'word_delivery_pair' INTO pair FROM bb_jobs WHERE run_id=NEW.id AND owner_user_id=NEW.owner_user_id;
    IF pair->>'revision_artifact_id' IS NULL OR pair->>'clean_artifact_id' IS NULL OR NEW.artifact_id IS DISTINCT FROM pair->>'revision_artifact_id' THEN
      RAISE EXCEPTION 'Both generated Word files required for fixed-price settlement' USING ERRCODE='23514';
    END IF;
    FOREACH artifact IN ARRAY ARRAY[pair->>'revision_artifact_id',pair->>'clean_artifact_id'] LOOP
      IF NOT EXISTS(SELECT 1 FROM bb_artifact_versions v JOIN bb_word_delivery_evidence e ON e.id=v.word_delivery_evidence_id
        WHERE v.id=artifact AND v.owner_user_id=NEW.owner_user_id AND v.run_id=NEW.id AND v.delivery_status='available'
        AND e.owner_user_id=v.owner_user_id AND e.run_id=v.run_id AND e.artifact_id=v.id AND e.artifact_version=v.version
        AND e.delivery_code='readback_verified' AND e.delivery_status='available' AND e.readback_sha256=v.sha256 AND e.candidate_sha256=v.sha256)
      THEN RAISE EXCEPTION 'Word delivery unavailable for settlement' USING ERRCODE='23514'; END IF;
    END LOOP;
  END IF;
  -- Operator recovery of an already generated pair preserves the prior release.
  -- Delivering those files must never freeze again or retroactively charge.
  IF r.state='released' THEN RETURN NEW; END IF;
  FOR a IN SELECT * FROM bb_credit_allocations WHERE reservation_id=r.id ORDER BY lot_id LOOP
    SELECT * INTO STRICT l FROM bb_credit_lots WHERE id=a.lot_id AND owner_user_id=NEW.owner_user_id FOR UPDATE;
    UPDATE bb_credit_lots SET frozen=frozen-a.points, remaining=remaining-CASE WHEN NEW.state='succeeded' THEN a.points ELSE 0 END WHERE id=l.id;
    IF NEW.state='failed' AND l.expires_at <= now() THEN
      -- Preserve the original lot expiry; append the promised seven-day fault compensation.
      UPDATE bb_credit_lots SET remaining=remaining-a.points WHERE id=l.id;
      compensation := 'failure:'||r.id||':'||l.id;
      INSERT INTO bb_credit_lots(id,owner_user_id,source,source_key,original_points,remaining,expires_at)
        VALUES(compensation,NEW.owner_user_id,'failure_compensation',compensation,a.points,a.points,now()+interval '7 days');
      INSERT INTO bb_credit_events(id,owner_user_id,event_key,kind,points,lot_id,run_id,actor,reason)
        VALUES(compensation,NEW.owner_user_id,compensation,'grant',a.points,compensation,NEW.id,'system','expired_hold_platform_failure');
    END IF;
  END LOOP;
  UPDATE bb_credit_reservations SET state=CASE WHEN NEW.state='succeeded' THEN 'settled' ELSE 'released' END,finalized_at=now() WHERE id=r.id;
  INSERT INTO bb_credit_events(id,owner_user_id,event_key,kind,points,reservation_id,run_id,actor,reason)
    VALUES('final:'||r.id,NEW.owner_user_id,'final:'||r.id,CASE WHEN NEW.state='succeeded' THEN 'settle' ELSE 'release' END,r.points,r.id,NEW.id,'system',NEW.state);
  RETURN NEW;
END; $$;
