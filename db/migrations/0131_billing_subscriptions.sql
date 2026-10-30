-- One wallet remains authoritative. Subscription periods describe purchased rights,
-- never an independent spendable balance. Old lots and orders retain their terms.
ALTER TABLE bb_credit_lots DROP CONSTRAINT bb_credit_lots_source_check;
ALTER TABLE bb_credit_lots ADD CONSTRAINT bb_credit_lots_source_check
 CHECK(source IN ('purchase','subscription','existing_grant','correction','failure_compensation'));
ALTER TABLE bb_credit_events DROP CONSTRAINT bb_credit_events_kind_check;
ALTER TABLE bb_credit_events ADD CONSTRAINT bb_credit_events_kind_check
 CHECK(kind IN ('grant','reserve','settle','release','correction','refund_hold','refund_settle','refund_release'));

ALTER TABLE bb_recharge_orders ADD COLUMN order_kind text NOT NULL DEFAULT 'recharge' CHECK(order_kind IN ('recharge','subscription'));
CREATE FUNCTION bb_recharge_kind_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.order_kind IS DISTINCT FROM OLD.order_kind THEN RAISE EXCEPTION 'Payment purpose is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_recharge_kind_locked BEFORE UPDATE ON bb_recharge_orders FOR EACH ROW EXECUTE FUNCTION bb_recharge_kind_guard();

CREATE TABLE bb_subscriptions (
 id text PRIMARY KEY,owner_user_id text NOT NULL UNIQUE REFERENCES bb_users(id),
 plan_id text NOT NULL CHECK(plan_id IN ('light','professional','intensive')),
 provider text NOT NULL CHECK(provider IN ('wechat','alipay')),merchant_id text NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','cancelled','past_due')),
 auto_renew boolean NOT NULL DEFAULT false,auto_renew_requested boolean NOT NULL DEFAULT false,
 mandate_status text NOT NULL DEFAULT 'none' CHECK(mandate_status IN ('none','pending','active','cancel_pending','cancelled')),
 mandate_request_id text,mandate_ref text,mandate_url text,
 current_period_start timestamptz,current_period_end timestamptz,
 task_price_version text NOT NULL REFERENCES bb_credit_price_versions(id),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_user_id,id),UNIQUE(provider,merchant_id,mandate_ref),
 CHECK((current_period_start IS NULL)=(current_period_end IS NULL)),
 CHECK(current_period_start IS NULL OR current_period_end>current_period_start),
 CHECK(NOT auto_renew OR (auto_renew_requested AND mandate_status='active' AND status='active' AND mandate_ref IS NOT NULL))
);
CREATE TABLE bb_subscription_periods (
 id text PRIMARY KEY,owner_user_id text NOT NULL,subscription_id text NOT NULL,cycle_index integer NOT NULL CHECK(cycle_index>0),
 order_id text NOT NULL UNIQUE REFERENCES bb_recharge_orders(id),
 plan_id text NOT NULL CHECK(plan_id IN ('light','professional','intensive')),catalog_version text NOT NULL,
 amount_fen bigint NOT NULL CHECK(amount_fen>0),points bigint NOT NULL CHECK(points>0),
 task_price_version text NOT NULL REFERENCES bb_credit_price_versions(id),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','refunded','failed')),
 automatic boolean NOT NULL DEFAULT false,payment_dispatch_started_at timestamptz,
 lot_id text UNIQUE,starts_at timestamptz,ends_at timestamptz,credits_expires_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(owner_user_id,subscription_id) REFERENCES bb_subscriptions(owner_user_id,id),
 FOREIGN KEY(owner_user_id,lot_id) REFERENCES bb_credit_lots(owner_user_id,id),
 UNIQUE(subscription_id,cycle_index),
 CHECK((lot_id IS NULL)=(starts_at IS NULL) AND (starts_at IS NULL)=(ends_at IS NULL) AND (starts_at IS NULL)=(credits_expires_at IS NULL)),
 CHECK(starts_at IS NULL OR (ends_at=starts_at+interval '1 month' AND credits_expires_at=starts_at+interval '90 days')),
 CHECK((status IN ('active','refunded'))=(lot_id IS NOT NULL)),
 CHECK((plan_id='light' AND amount_fen=19900 AND points=21000) OR
       (plan_id='professional' AND amount_fen=49900 AND points=55000) OR
       (plan_id='intensive' AND amount_fen=99900 AND points=114000))
);
CREATE UNIQUE INDEX bb_subscription_one_pending_period ON bb_subscription_periods(subscription_id) WHERE status='pending';
CREATE INDEX bb_subscription_due ON bb_subscriptions(current_period_end) WHERE auto_renew AND status='active';
CREATE TABLE bb_subscription_actions (
 owner_user_id text NOT NULL,request_id text NOT NULL,operation text NOT NULL,request_hash char(64) NOT NULL,
 subscription_id text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(owner_user_id,request_id),FOREIGN KEY(owner_user_id,subscription_id) REFERENCES bb_subscriptions(owner_user_id,id)
);
CREATE TRIGGER bb_subscription_actions_immutable BEFORE UPDATE OR DELETE ON bb_subscription_actions FOR EACH ROW EXECUTE FUNCTION bb_credit_immutable();
CREATE FUNCTION bb_subscription_period_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Subscription purchase history is immutable' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND (
  ROW(NEW.id,NEW.owner_user_id,NEW.subscription_id,NEW.cycle_index,NEW.order_id,NEW.plan_id,NEW.catalog_version,NEW.amount_fen,NEW.points,NEW.task_price_version,NEW.automatic,NEW.created_at)
   IS DISTINCT FROM ROW(OLD.id,OLD.owner_user_id,OLD.subscription_id,OLD.cycle_index,OLD.order_id,OLD.plan_id,OLD.catalog_version,OLD.amount_fen,OLD.points,OLD.task_price_version,OLD.automatic,OLD.created_at)
  OR (OLD.starts_at IS NOT NULL AND ROW(NEW.lot_id,NEW.starts_at,NEW.ends_at,NEW.credits_expires_at) IS DISTINCT FROM ROW(OLD.lot_id,OLD.starts_at,OLD.ends_at,OLD.credits_expires_at))
  OR (OLD.payment_dispatch_started_at IS NOT NULL AND NEW.payment_dispatch_started_at IS DISTINCT FROM OLD.payment_dispatch_started_at)
  OR (OLD.status='refunded' AND NEW IS DISTINCT FROM OLD)
 ) THEN RAISE EXCEPTION 'Subscription period terms are immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_subscription_period_locked BEFORE UPDATE OR DELETE ON bb_subscription_periods FOR EACH ROW EXECUTE FUNCTION bb_subscription_period_guard();

-- Immutable per-point consideration belongs to the original lot, not to its
-- current remaining balance. NULL means missing evidence, never nominal cash.
ALTER TABLE bb_credit_lots ADD COLUMN cash_basis_fen bigint;
ALTER TABLE bb_credit_lots ADD COLUMN cash_basis_points bigint;
ALTER TABLE bb_credit_lots ADD COLUMN cash_order_id text REFERENCES bb_recharge_orders(id);
ALTER TABLE bb_credit_lots ADD COLUMN cash_origin_lot_id text REFERENCES bb_credit_lots(id);
ALTER TABLE bb_credit_lots ADD CONSTRAINT bb_credit_cash_basis CHECK(
 (cash_basis_fen IS NULL AND cash_basis_points IS NULL) OR
 (cash_basis_fen IS NOT NULL AND cash_basis_points IS NOT NULL AND cash_basis_fen>=0 AND cash_basis_points>0));
UPDATE bb_credit_lots l SET cash_basis_fen=o.amount_fen,cash_basis_points=o.points,cash_order_id=o.id,cash_origin_lot_id=l.id
 FROM bb_recharge_orders o WHERE l.owner_user_id=o.owner_user_id AND l.source_key='recharge:'||o.id AND o.state='paid';
UPDATE bb_credit_lots SET cash_basis_fen=0,cash_basis_points=1 WHERE source='existing_grant' AND cash_basis_fen IS NULL;
DO $$ DECLARE changed integer; BEGIN
 LOOP
  UPDATE bb_credit_lots l SET cash_basis_fen=origin.cash_basis_fen,cash_basis_points=origin.cash_basis_points,
    cash_order_id=origin.cash_order_id,cash_origin_lot_id=COALESCE(origin.cash_origin_lot_id,origin.id)
   FROM bb_credit_allocations a JOIN bb_credit_lots origin ON origin.id=a.lot_id
   WHERE l.owner_user_id=origin.owner_user_id AND l.cash_basis_fen IS NULL AND origin.cash_basis_fen IS NOT NULL
   AND l.source_key IN ('failure:'||a.reservation_id||':'||a.lot_id,'dynamic-failure:'||a.reservation_id||':'||a.lot_id,'settlement-correction:'||a.reservation_id||':'||a.lot_id);
  GET DIAGNOSTICS changed=ROW_COUNT; EXIT WHEN changed=0;
 END LOOP;
END $$;
CREATE FUNCTION bb_credit_cash_basis_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE origin bb_credit_lots%ROWTYPE; paid bb_recharge_orders%ROWTYPE; BEGIN
 IF TG_OP='UPDATE' THEN
  IF ROW(NEW.cash_basis_fen,NEW.cash_basis_points,NEW.cash_order_id,NEW.cash_origin_lot_id) IS DISTINCT FROM ROW(OLD.cash_basis_fen,OLD.cash_basis_points,OLD.cash_order_id,OLD.cash_origin_lot_id)
   THEN RAISE EXCEPTION 'Lot consideration evidence is immutable' USING ERRCODE='23514'; END IF;
 ELSE
  NEW.cash_basis_fen:=NULL; NEW.cash_basis_points:=NULL; NEW.cash_order_id:=NULL; NEW.cash_origin_lot_id:=NULL;
  SELECT * INTO paid FROM bb_recharge_orders WHERE owner_user_id=NEW.owner_user_id AND 'recharge:'||id=NEW.source_key AND state='paid';
  IF paid.id IS NOT NULL AND NEW.source IN ('purchase','subscription') AND NEW.original_points=paid.points THEN
   NEW.cash_basis_fen:=paid.amount_fen; NEW.cash_basis_points:=paid.points; NEW.cash_order_id:=paid.id; NEW.cash_origin_lot_id:=NEW.id;
  ELSE
   SELECT l.* INTO origin FROM bb_credit_allocations a JOIN bb_credit_lots l ON l.id=a.lot_id
    WHERE l.owner_user_id=NEW.owner_user_id AND NEW.source_key IN
     ('failure:'||a.reservation_id||':'||a.lot_id,'dynamic-failure:'||a.reservation_id||':'||a.lot_id,'settlement-correction:'||a.reservation_id||':'||a.lot_id) LIMIT 1;
   IF origin.id IS NOT NULL THEN
    NEW.cash_basis_fen:=origin.cash_basis_fen; NEW.cash_basis_points:=origin.cash_basis_points;
    NEW.cash_order_id:=origin.cash_order_id; NEW.cash_origin_lot_id:=COALESCE(origin.cash_origin_lot_id,origin.id);
    IF origin.source='subscription' THEN NEW.source:='subscription'; END IF;
   ELSIF NEW.source='existing_grant' THEN NEW.cash_basis_fen:=0; NEW.cash_basis_points:=1;
   END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_credit_cash_basis_locked BEFORE INSERT OR UPDATE ON bb_credit_lots FOR EACH ROW EXECUTE FUNCTION bb_credit_cash_basis_guard();

-- A refund's cash amount and removed credits are different units for subscriptions.
ALTER TABLE bb_payment_refunds ADD COLUMN credit_points bigint;
-- The new column is a derivation of legacy 1:1 refund facts, not a change to them.
ALTER TABLE bb_payment_refunds DISABLE TRIGGER bb_payment_refund_locked;
UPDATE bb_payment_refunds SET credit_points=amount_fen;
ALTER TABLE bb_payment_refunds ENABLE TRIGGER bb_payment_refund_locked;
ALTER TABLE bb_payment_refunds ALTER COLUMN credit_points SET NOT NULL;
ALTER TABLE bb_payment_refunds ADD CHECK(credit_points>0);
CREATE OR REPLACE FUNCTION bb_payment_cash_proof_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM bb_recharge_orders o JOIN bb_credit_lots l ON l.owner_user_id=o.owner_user_id AND l.source_key='recharge:'||o.id
   LEFT JOIN bb_subscription_periods sp ON sp.order_id=o.id AND sp.owner_user_id=o.owner_user_id
   WHERE o.id=NEW.order_id AND o.owner_user_id=NEW.owner_user_id AND o.state='paid'
   AND o.amount_fen=NEW.order_amount_fen AND o.currency=NEW.currency
   AND o.provider=NEW.provider AND o.merchant_id=NEW.merchant_id AND o.provider_txn_id=NEW.provider_txn_id AND l.id=NEW.lot_id
   AND ((o.order_kind='recharge' AND o.pack_id='service_balance' AND o.points=o.amount_fen AND l.source='purchase' AND l.original_points=o.amount_fen AND l.expires_at IS NULL)
     OR (o.order_kind='subscription' AND sp.status='active' AND sp.lot_id=l.id AND sp.amount_fen=o.amount_fen AND sp.points=o.points
       AND l.source='subscription' AND l.original_points=o.points AND l.expires_at=sp.credits_expires_at)))
 THEN RAISE EXCEPTION 'Verified original payment and matching rights required' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION bb_payment_refund_credit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE l bb_credit_lots%ROWTYPE; sp bb_subscription_periods%ROWTYPE; BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.credit_points IS DISTINCT FROM OLD.credit_points THEN RAISE EXCEPTION 'Refund credit quantity is immutable' USING ERRCODE='23514'; END IF;
 ELSE
  SELECT * INTO STRICT l FROM bb_credit_lots WHERE id=NEW.lot_id AND owner_user_id=NEW.owner_user_id;
  IF l.source='subscription' THEN
   SELECT * INTO sp FROM bb_subscription_periods WHERE order_id=NEW.order_id AND lot_id=l.id AND owner_user_id=NEW.owner_user_id;
   IF sp.id IS NULL OR sp.status<>'active' OR now()>sp.starts_at+interval '7 days'
     OR NEW.amount_fen<>sp.amount_fen OR NEW.credit_points<>sp.points OR l.remaining<>sp.points OR l.frozen<>0
     OR EXISTS(SELECT 1 FROM bb_credit_allocations WHERE lot_id=l.id AND charged_points>0)
   THEN RAISE EXCEPTION 'Only a wholly unused subscription period within seven days is refundable' USING ERRCODE='23514'; END IF;
  ELSIF l.source<>'purchase' OR NEW.credit_points<>NEW.amount_fen THEN
   RAISE EXCEPTION 'Cash refund requires original purchased rights' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_payment_refund_credit_locked BEFORE INSERT OR UPDATE ON bb_payment_refunds FOR EACH ROW EXECUTE FUNCTION bb_payment_refund_credit_guard();
