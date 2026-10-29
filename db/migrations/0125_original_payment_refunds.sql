-- No historical cash evidence is inferred. Only verified payment receipts populate this mapping.
CREATE TABLE bb_payment_cash_proofs (
 order_id text PRIMARY KEY REFERENCES bb_recharge_orders(id),owner_user_id text NOT NULL,
 lot_id text NOT NULL UNIQUE,provider text NOT NULL CHECK(provider IN ('wechat','alipay')),
 merchant_id text NOT NULL,provider_txn_id text NOT NULL,currency text NOT NULL CHECK(currency='CNY'),
 order_amount_fen bigint NOT NULL CHECK(order_amount_fen>0),
 cash_amount_fen bigint NOT NULL CHECK(cash_amount_fen>=0 AND cash_amount_fen<=order_amount_fen),
 verified_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_user_id,order_id,lot_id),FOREIGN KEY(owner_user_id,lot_id) REFERENCES bb_credit_lots(owner_user_id,id)
);
CREATE FUNCTION bb_payment_cash_proof_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM bb_recharge_orders o JOIN bb_credit_lots l ON l.owner_user_id=o.owner_user_id AND l.source_key='recharge:'||o.id
   WHERE o.id=NEW.order_id AND o.owner_user_id=NEW.owner_user_id AND o.state='paid' AND o.pack_id='service_balance'
   AND o.points=o.amount_fen AND o.amount_fen=NEW.order_amount_fen AND o.currency=NEW.currency
   AND o.provider=NEW.provider AND o.merchant_id=NEW.merchant_id AND o.provider_txn_id=NEW.provider_txn_id
   AND l.id=NEW.lot_id AND l.source='purchase' AND l.original_points=o.amount_fen AND l.expires_at IS NULL)
 THEN RAISE EXCEPTION 'Verified original service payment and exact lot required' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_payment_cash_proof_valid BEFORE INSERT ON bb_payment_cash_proofs FOR EACH ROW EXECUTE FUNCTION bb_payment_cash_proof_guard();
CREATE TRIGGER bb_payment_cash_proof_immutable BEFORE UPDATE OR DELETE ON bb_payment_cash_proofs FOR EACH ROW EXECUTE FUNCTION bb_credit_immutable();

CREATE TABLE bb_payment_refunds (
 id text PRIMARY KEY CHECK(id ~ '^[A-Za-z0-9_-]{1,32}$'),owner_user_id text NOT NULL,
 order_id text NOT NULL,lot_id text NOT NULL,request_id text NOT NULL,request_hash char(64) NOT NULL,
 provider text NOT NULL CHECK(provider IN ('wechat','alipay')),merchant_id text NOT NULL,provider_txn_id text NOT NULL,
 currency text NOT NULL CHECK(currency='CNY'),order_amount_fen bigint NOT NULL CHECK(order_amount_fen>0),
 amount_fen bigint NOT NULL CHECK(amount_fen>0 AND amount_fen<=order_amount_fen),
 state text NOT NULL DEFAULT 'requested' CHECK(state IN ('requested','processing','succeeded','failed')),
 provider_refund_id text,dispatch_started_at timestamptz,completed_at timestamptz,failure_code text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_user_id,request_id),UNIQUE(provider,merchant_id,provider_refund_id),
 FOREIGN KEY(owner_user_id,order_id,lot_id) REFERENCES bb_payment_cash_proofs(owner_user_id,order_id,lot_id),
 CHECK((state='requested')=(dispatch_started_at IS NULL)),
 CHECK((state IN ('succeeded','failed'))=(completed_at IS NOT NULL)),
 CHECK((state='failed')=(failure_code IS NOT NULL)),
 CHECK(state NOT IN ('succeeded','failed') OR provider_refund_id IS NOT NULL)
);
CREATE UNIQUE INDEX bb_payment_refund_one_active_order ON bb_payment_refunds(order_id) WHERE state IN ('requested','processing');
CREATE INDEX bb_payment_refund_owner_order ON bb_payment_refunds(owner_user_id,order_id,created_at DESC);
CREATE FUNCTION bb_payment_refund_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Refund history is append only' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
   IF NEW.state<>'requested' OR NOT EXISTS(SELECT 1 FROM bb_payment_cash_proofs p
     WHERE p.order_id=NEW.order_id AND p.owner_user_id=NEW.owner_user_id AND p.lot_id=NEW.lot_id
     AND p.cash_amount_fen=p.order_amount_fen AND p.order_amount_fen=NEW.order_amount_fen
     AND p.provider=NEW.provider AND p.merchant_id=NEW.merchant_id AND p.provider_txn_id=NEW.provider_txn_id AND p.currency=NEW.currency)
   THEN RAISE EXCEPTION 'Full verified cash payment required for automatic refund' USING ERRCODE='23514'; END IF;
 ELSE
   IF ROW(NEW.id,NEW.owner_user_id,NEW.order_id,NEW.lot_id,NEW.request_id,NEW.request_hash,NEW.provider,NEW.merchant_id,NEW.provider_txn_id,NEW.currency,NEW.order_amount_fen,NEW.amount_fen,NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id,OLD.owner_user_id,OLD.order_id,OLD.lot_id,OLD.request_id,OLD.request_hash,OLD.provider,OLD.merchant_id,OLD.provider_txn_id,OLD.currency,OLD.order_amount_fen,OLD.amount_fen,OLD.created_at)
     OR (OLD.dispatch_started_at IS NOT NULL AND NEW.dispatch_started_at IS DISTINCT FROM OLD.dispatch_started_at)
     OR (OLD.provider_refund_id IS NOT NULL AND NEW.provider_refund_id IS DISTINCT FROM OLD.provider_refund_id)
     OR (OLD.state IN ('succeeded','failed') AND NEW IS DISTINCT FROM OLD)
     OR (OLD.state='processing' AND NEW.state='requested')
   THEN RAISE EXCEPTION 'Refund identity and terminal outcome are locked' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_payment_refund_locked BEFORE INSERT OR UPDATE OR DELETE ON bb_payment_refunds FOR EACH ROW EXECUTE FUNCTION bb_payment_refund_guard();

-- Cash movements and wallet transitions are separately auditable; task charges keep their existing meaning.
CREATE TABLE bb_payment_refund_events (
 id text PRIMARY KEY,refund_id text NOT NULL REFERENCES bb_payment_refunds(id),owner_user_id text NOT NULL,
 lot_id text NOT NULL,event_key text NOT NULL UNIQUE,
 kind text NOT NULL CHECK(kind IN ('requested','dispatch','processing','succeeded','failed')),
 amount_fen bigint NOT NULL CHECK(amount_fen>0),cash_refunded_fen bigint NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(refund_id,kind),
 FOREIGN KEY(owner_user_id,lot_id) REFERENCES bb_credit_lots(owner_user_id,id),
 CHECK(cash_refunded_fen=CASE WHEN kind='succeeded' THEN amount_fen ELSE 0 END)
);
CREATE FUNCTION bb_payment_refund_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM bb_payment_refunds r WHERE r.id=NEW.refund_id AND r.owner_user_id=NEW.owner_user_id
   AND r.lot_id=NEW.lot_id AND r.amount_fen=NEW.amount_fen
   AND (r.state=NEW.kind OR (NEW.kind='dispatch' AND r.state='processing' AND r.dispatch_started_at IS NOT NULL)))
 THEN RAISE EXCEPTION 'Refund event must match the locked refund transition' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_payment_refund_event_valid BEFORE INSERT ON bb_payment_refund_events FOR EACH ROW EXECUTE FUNCTION bb_payment_refund_event_guard();
CREATE TRIGGER bb_payment_refund_event_immutable BEFORE UPDATE OR DELETE ON bb_payment_refund_events FOR EACH ROW EXECUTE FUNCTION bb_credit_immutable();
