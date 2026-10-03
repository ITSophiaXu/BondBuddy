-- M2 is opt-in. No historic trial task or demo balance is migrated or charged.
CREATE TABLE bb_credit_price_versions (
  id text PRIMARY KEY, prices jsonb NOT NULL, effective_at timestamptz NOT NULL UNIQUE,
  actor text NOT NULL, reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE bb_credit_accounts (owner_user_id text PRIMARY KEY REFERENCES bb_users(id), created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE bb_credit_lots (
  id text PRIMARY KEY, owner_user_id text NOT NULL REFERENCES bb_credit_accounts,
  source text NOT NULL CHECK(source IN ('purchase','existing_grant','correction','failure_compensation')),
  source_key text NOT NULL, original_points bigint NOT NULL CHECK(original_points > 0),
  remaining bigint NOT NULL CHECK(remaining >= 0 AND remaining <= original_points),
  frozen bigint NOT NULL DEFAULT 0 CHECK(frozen >= 0 AND frozen <= remaining),
  expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_user_id,source_key), UNIQUE(owner_user_id,id)
);
CREATE TABLE bb_credit_quotes (
  id text PRIMARY KEY, owner_user_id text NOT NULL, project_id text NOT NULL,
  input_revision integer NOT NULL, input_hash char(64) NOT NULL,
  price_version text NOT NULL REFERENCES bb_credit_price_versions,
  task_type text NOT NULL CHECK(task_type IN ('interim','annual','two_years','three_years','migration','migration_two_years','migration_three_years','new_authoring')),
  points bigint NOT NULL CHECK(points > 0 AND points <= 1000000000), reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_user_id,id), UNIQUE(owner_user_id,project_id,input_revision,price_version)
);
CREATE TABLE bb_credit_reservations (
  id text PRIMARY KEY, owner_user_id text NOT NULL REFERENCES bb_credit_accounts,
  run_id text NOT NULL UNIQUE REFERENCES bb_runs(id), quote_id text NOT NULL UNIQUE,
  points bigint NOT NULL CHECK(points > 0), state text NOT NULL DEFAULT 'held' CHECK(state IN ('held','settled','released')),
  created_at timestamptz NOT NULL DEFAULT now(), finalized_at timestamptz,
  FOREIGN KEY(owner_user_id,quote_id) REFERENCES bb_credit_quotes(owner_user_id,id), UNIQUE(owner_user_id,id)
);
CREATE TABLE bb_credit_allocations (
  reservation_id text NOT NULL REFERENCES bb_credit_reservations, lot_id text NOT NULL REFERENCES bb_credit_lots,
  points bigint NOT NULL CHECK(points > 0), PRIMARY KEY(reservation_id,lot_id)
);
CREATE TABLE bb_credit_events (
  id text PRIMARY KEY, owner_user_id text NOT NULL REFERENCES bb_credit_accounts,
  event_key text NOT NULL, kind text NOT NULL CHECK(kind IN ('grant','reserve','settle','release','correction')),
  points bigint NOT NULL CHECK(points > 0), reservation_id text, lot_id text, run_id text,
  actor text NOT NULL, reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_user_id,event_key)
);
ALTER TABLE bb_runs ADD COLUMN billing_mode text NOT NULL DEFAULT 'platform_trial'
  CHECK(billing_mode IN ('platform_trial','fixed_credits'));
ALTER TABLE bb_runs ADD COLUMN reservation_id text REFERENCES bb_credit_reservations;
ALTER TABLE bb_runs ADD COLUMN billing_exemption text CHECK(billing_exemption IS NULL OR billing_exemption='classification_pending');
ALTER TABLE bb_runs ADD CONSTRAINT bb_paid_run_reservation CHECK ((billing_mode='fixed_credits')=(reservation_id IS NOT NULL));

CREATE FUNCTION bb_credit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Credit history is append only' USING ERRCODE='23514'; END; $$;
CREATE TRIGGER bb_credit_events_immutable BEFORE UPDATE OR DELETE ON bb_credit_events FOR EACH ROW EXECUTE FUNCTION bb_credit_immutable();
CREATE TRIGGER bb_credit_prices_immutable BEFORE UPDATE OR DELETE ON bb_credit_price_versions FOR EACH ROW EXECUTE FUNCTION bb_credit_immutable();
CREATE TRIGGER bb_credit_quotes_immutable BEFORE UPDATE OR DELETE ON bb_credit_quotes FOR EACH ROW EXECUTE FUNCTION bb_credit_immutable();

-- Every terminal path (worker, cancellation, deletion, operator) shares the same
-- transaction. The account lock also serializes different projects' reservations.
CREATE FUNCTION bb_credit_finalize_run() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r bb_credit_reservations%ROWTYPE; a record; l bb_credit_lots%ROWTYPE; pair jsonb; artifact text; compensation text;
BEGIN
  IF NEW.billing_mode <> 'fixed_credits' OR NEW.state NOT IN ('succeeded','failed','cancelled','rejected') OR OLD.state=NEW.state THEN RETURN NEW; END IF;
  PERFORM 1 FROM bb_credit_accounts WHERE owner_user_id=NEW.owner_user_id FOR UPDATE;
  SELECT * INTO STRICT r FROM bb_credit_reservations WHERE id=NEW.reservation_id AND run_id=NEW.id AND owner_user_id=NEW.owner_user_id FOR UPDATE;
  IF r.state <> 'held' AND NOT (r.state='released' AND EXISTS(
    SELECT 1 FROM bb_jobs WHERE run_id=NEW.id AND checkpoint ? 'word_pair_delivery_recovery'
  )) THEN RAISE EXCEPTION 'Credit reservation already finalized' USING ERRCODE='23514'; END IF;
  IF NEW.state='succeeded' THEN
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
CREATE TRIGGER bb_credit_finalize AFTER UPDATE OF state ON bb_runs FOR EACH ROW EXECUTE FUNCTION bb_credit_finalize_run();

CREATE TABLE bb_recharge_orders (
  id text PRIMARY KEY, owner_user_id text NOT NULL REFERENCES bb_users(id), request_id text NOT NULL, request_hash char(64) NOT NULL,
  provider text NOT NULL CHECK(provider IN ('wechat','alipay')), pack_id text NOT NULL, pack_version text NOT NULL,
  amount_fen bigint NOT NULL CHECK(amount_fen>0), points bigint NOT NULL CHECK(points>0), currency text NOT NULL CHECK(currency='CNY'),
  project_id text, merchant_id text NOT NULL, provider_txn_id text,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','paid','expired','failed')),
  checkout_url text, expires_at timestamptz NOT NULL, credited_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_user_id,request_id), UNIQUE(provider,merchant_id,provider_txn_id)
);
CREATE FUNCTION bb_recharge_order_locked_fields() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id,NEW.owner_user_id,NEW.request_id,NEW.request_hash,NEW.provider,NEW.pack_id,NEW.pack_version,NEW.amount_fen,NEW.points,NEW.currency,NEW.project_id,NEW.merchant_id,NEW.expires_at,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.owner_user_id,OLD.request_id,OLD.request_hash,OLD.provider,OLD.pack_id,OLD.pack_version,OLD.amount_fen,OLD.points,OLD.currency,OLD.project_id,OLD.merchant_id,OLD.expires_at,OLD.created_at)
    OR (OLD.state='paid' AND ROW(NEW.state,NEW.provider_txn_id,NEW.credited_at) IS DISTINCT FROM ROW(OLD.state,OLD.provider_txn_id,OLD.credited_at))
  THEN RAISE EXCEPTION 'Recharge order values are locked' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER bb_recharge_order_locked BEFORE UPDATE ON bb_recharge_orders FOR EACH ROW EXECUTE FUNCTION bb_recharge_order_locked_fields();
