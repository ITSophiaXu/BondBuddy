-- New authoring reservations opt in; existing runs retain their original cancellation terms.
ALTER TABLE bb_credit_reservations ADD COLUMN billing_policy text NOT NULL DEFAULT 'on_delivery'
 CHECK(billing_policy IN ('on_delivery','authoring_progress_v1'));
ALTER TABLE bb_credit_allocations ADD COLUMN charged_points bigint CHECK(charged_points>=0 AND charged_points<=points);
ALTER TABLE bb_jobs ADD COLUMN user_pause_requested boolean NOT NULL DEFAULT false;
CREATE TABLE bb_authoring_progress (
 run_id text PRIMARY KEY, owner_user_id text NOT NULL,
 active_ms bigint NOT NULL DEFAULT 0 CHECK(active_ms>=0), work_bps integer NOT NULL DEFAULT 0 CHECK(work_bps BETWEEN 0 AND 2500),
 accrued_points bigint NOT NULL DEFAULT 0 CHECK(accrued_points>=0),
 clock_at timestamptz NOT NULL DEFAULT now(), lease_until timestamptz,
 last_activity_at timestamptz,
 FOREIGN KEY(owner_user_id,run_id) REFERENCES bb_runs(owner_user_id,id)
);
CREATE OR REPLACE FUNCTION bb_credit_finalize_run() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r bb_credit_reservations%ROWTYPE; a record; l bb_credit_lots%ROWTYPE; pair jsonb; artifact text; compensation text; charged bigint; remaining_charge bigint; take bigint;
BEGIN
  IF NEW.billing_mode <> 'fixed_credits' OR NEW.state NOT IN ('succeeded','failed','cancelled','rejected') OR OLD.state=NEW.state THEN RETURN NEW; END IF;
  IF EXISTS(SELECT 1 FROM bb_m4_quotes q JOIN bb_credit_reservations c ON c.quote_id=q.id AND c.owner_user_id=q.owner_user_id WHERE c.id=NEW.reservation_id) THEN RETURN NEW; END IF;
  PERFORM 1 FROM bb_credit_accounts WHERE owner_user_id=NEW.owner_user_id FOR UPDATE;
  SELECT * INTO STRICT r FROM bb_credit_reservations WHERE id=NEW.reservation_id AND run_id=NEW.id AND owner_user_id=NEW.owner_user_id FOR UPDATE;
  IF r.state <> 'held' AND NOT (r.state='released' AND EXISTS(
    SELECT 1 FROM bb_jobs WHERE run_id=NEW.id AND checkpoint ? 'word_pair_delivery_recovery'
  )) THEN RAISE EXCEPTION 'Credit reservation already finalized' USING ERRCODE='23514'; END IF;
  IF NEW.state='succeeded' AND NEW.task_kind='review' THEN
    IF NOT EXISTS(SELECT 1 FROM bb_review_artifacts report JOIN bb_artifact_versions v ON v.id=report.artifact_id AND v.version=report.artifact_version
      WHERE report.owner_user_id=NEW.owner_user_id AND report.run_id=NEW.id AND report.project_id=NEW.project_id AND report.kind='report'
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
  charged := CASE WHEN NEW.state='succeeded' THEN r.points
    WHEN NEW.state='cancelled' AND r.billing_policy='authoring_progress_v1' THEN
      LEAST(r.points,COALESCE((SELECT accrued_points FROM bb_authoring_progress WHERE run_id=NEW.id AND owner_user_id=NEW.owner_user_id),0))
    ELSE 0 END;
  remaining_charge := charged;
  FOR a IN SELECT * FROM bb_credit_allocations WHERE reservation_id=r.id ORDER BY lot_id LOOP
    SELECT * INTO STRICT l FROM bb_credit_lots WHERE id=a.lot_id AND owner_user_id=NEW.owner_user_id FOR UPDATE;
    take := LEAST(a.points,remaining_charge); remaining_charge := remaining_charge-take;
    UPDATE bb_credit_lots SET frozen=frozen-a.points, remaining=remaining-take WHERE id=l.id;
    UPDATE bb_credit_allocations SET charged_points=take WHERE reservation_id=r.id AND lot_id=l.id;
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
  UPDATE bb_credit_reservations SET state=CASE WHEN charged>0 THEN 'settled' ELSE 'released' END,charged_points=charged,finalized_at=now() WHERE id=r.id;
  IF charged>0 THEN
    INSERT INTO bb_credit_events(id,owner_user_id,event_key,kind,points,reservation_id,run_id,actor,reason)
      VALUES('final:'||r.id,NEW.owner_user_id,'final:'||r.id,'settle',charged,r.id,NEW.id,'system',NEW.state);
  END IF;
  IF charged<r.points THEN
    INSERT INTO bb_credit_events(id,owner_user_id,event_key,kind,points,reservation_id,run_id,actor,reason)
      VALUES('release:'||r.id,NEW.owner_user_id,'release:'||r.id,'release',r.points-charged,r.id,NEW.id,'system',NEW.state);
  END IF;
  RETURN NEW;
END; $$;
