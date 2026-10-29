-- Historical recharge bonuses share the ORIGINAL authenticated cash basis A/Q.
-- No receipt or subsidy composition is inferred from nominal credits.
CREATE OR REPLACE FUNCTION bb_payment_cash_proof_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM bb_recharge_orders o JOIN bb_credit_lots l ON l.owner_user_id=o.owner_user_id AND l.source_key='recharge:'||o.id
   LEFT JOIN bb_subscription_periods sp ON sp.order_id=o.id AND sp.owner_user_id=o.owner_user_id
   WHERE o.id=NEW.order_id AND o.owner_user_id=NEW.owner_user_id AND o.state='paid'
   AND o.amount_fen=NEW.order_amount_fen AND o.currency=NEW.currency
   AND o.amount_fen BETWEEN 1 AND 1000000 AND o.points BETWEEN 1 AND 1150000
   AND o.provider=NEW.provider AND o.merchant_id=NEW.merchant_id AND o.provider_txn_id=NEW.provider_txn_id AND l.id=NEW.lot_id
   AND ((o.order_kind='recharge' AND l.source='purchase' AND l.original_points=o.points AND l.expires_at IS NULL)
     OR (o.order_kind='subscription' AND sp.status='active' AND sp.lot_id=l.id AND sp.amount_fen=o.amount_fen AND sp.points=o.points
       AND l.source='subscription' AND l.original_points=o.points AND l.expires_at=sp.credits_expires_at)))
 THEN RAISE EXCEPTION 'Verified original payment and matching rights required' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION bb_payment_refund_credit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE l bb_credit_lots%ROWTYPE; sp bb_subscription_periods%ROWTYPE; o bb_recharge_orders%ROWTYPE;
 r numeric; f numeric; available numeric; BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.credit_points IS DISTINCT FROM OLD.credit_points THEN RAISE EXCEPTION 'Refund credit quantity is immutable' USING ERRCODE='23514'; END IF;
 ELSE
  -- Account serialization also protects direct writes from a stale refund cursor.
  PERFORM 1 FROM bb_credit_accounts WHERE owner_user_id=NEW.owner_user_id FOR UPDATE;
  SELECT * INTO STRICT o FROM bb_recharge_orders WHERE id=NEW.order_id AND owner_user_id=NEW.owner_user_id FOR UPDATE;
  SELECT * INTO STRICT l FROM bb_credit_lots WHERE id=NEW.lot_id AND owner_user_id=NEW.owner_user_id;
  IF NEW.credit_points NOT BETWEEN 1 AND 1150000 OR NEW.amount_fen NOT BETWEEN 1 AND 1000000
    OR l.source_key<>'recharge:'||o.id OR l.original_points<>o.points THEN
   RAISE EXCEPTION 'Cash refund requires the original purchased rights' USING ERRCODE='23514';
  END IF;
  IF o.order_kind='subscription' THEN
   PERFORM 1 FROM bb_credit_lots WHERE id=l.id FOR UPDATE;
   SELECT * INTO sp FROM bb_subscription_periods WHERE order_id=NEW.order_id AND lot_id=l.id AND owner_user_id=NEW.owner_user_id;
   IF sp.id IS NULL OR sp.status<>'active' OR l.source<>'subscription' OR now()>sp.starts_at+interval '7 days'
     OR NEW.amount_fen<>sp.amount_fen OR NEW.credit_points<>sp.points OR l.remaining<>sp.points OR l.frozen<>0
     OR EXISTS(SELECT 1 FROM bb_credit_allocations WHERE lot_id=l.id AND charged_points>0)
   THEN RAISE EXCEPTION 'Only a wholly unused subscription period within seven days is refundable' USING ERRCODE='23514'; END IF;
  ELSE
   IF l.source<>'purchase' OR l.expires_at IS NOT NULL THEN
    RAISE EXCEPTION 'Cash refund requires original purchased rights' USING ERRCODE='23514';
   END IF;
   PERFORM 1 FROM bb_credit_lots source WHERE source.owner_user_id=NEW.owner_user_id AND
     (source.id=l.id OR (source.cash_origin_lot_id=l.id AND source.cash_order_id=o.id AND source.cash_basis_fen=o.amount_fen
       AND source.cash_basis_points=o.points AND source.source='purchase'))
     AND (source.expires_at IS NULL OR source.expires_at>now()) ORDER BY source.id FOR UPDATE;
   SELECT COALESCE(sum(credit_points),0),COALESCE(sum(amount_fen),0) INTO r,f
    FROM bb_payment_refunds WHERE order_id=o.id AND owner_user_id=NEW.owner_user_id AND state='succeeded';
   SELECT COALESCE(sum(source.remaining-source.frozen),0) INTO available FROM bb_credit_lots source WHERE source.owner_user_id=NEW.owner_user_id AND
     (source.id=l.id OR (source.cash_origin_lot_id=l.id AND source.cash_order_id=o.id AND source.cash_basis_fen=o.amount_fen
       AND source.cash_basis_points=o.points AND source.source='purchase'))
     AND (source.expires_at IS NULL OR source.expires_at>now());
   IF NEW.credit_points>available OR r+NEW.credit_points>o.points OR f<>floor(o.amount_fen::numeric*r/o.points)
     OR NEW.amount_fen<>floor(o.amount_fen::numeric*(r+NEW.credit_points)/o.points)-f OR f+NEW.amount_fen>o.amount_fen THEN
    RAISE EXCEPTION 'Refund must preserve original A/Q consideration and successful cumulative rounding' USING ERRCODE='23514';
   END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
