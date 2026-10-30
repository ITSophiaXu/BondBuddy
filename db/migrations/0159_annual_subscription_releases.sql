-- Annual contracts are paid once. Only due monthly installments become wallet
-- lots; each installment owns 1/12 of the ORIGINAL annual consideration.
CREATE FUNCTION bb_subscription_clock(p_owner text) RETURNS timestamptz LANGUAGE sql STABLE AS $$ SELECT date_trunc('milliseconds',now()) $$;
ALTER TABLE bb_subscriptions ADD COLUMN billing_cycle text NOT NULL DEFAULT 'monthly' CHECK(billing_cycle IN ('monthly','annual'));
ALTER TABLE bb_subscriptions ADD COLUMN billing_amount_fen bigint;
UPDATE bb_subscriptions SET billing_amount_fen=CASE plan_id WHEN 'light' THEN 19900 WHEN 'professional' THEN 49900 ELSE 99900 END;
ALTER TABLE bb_subscriptions ALTER COLUMN billing_amount_fen SET NOT NULL;
ALTER TABLE bb_subscriptions ADD CHECK(billing_amount_fen>0);
CREATE FUNCTION bb_subscription_default_amount() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.billing_amount_fen IS NULL THEN NEW.billing_amount_fen:=CASE NEW.plan_id WHEN 'light' THEN 19900 WHEN 'professional' THEN 49900 ELSE 99900 END;
  IF NEW.billing_cycle='annual' THEN NEW.billing_amount_fen:=NEW.billing_amount_fen*108/10;END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER bb_subscription_default_amount BEFORE INSERT ON bb_subscriptions FOR EACH ROW EXECUTE FUNCTION bb_subscription_default_amount();
ALTER TABLE bb_subscription_periods ADD COLUMN billing_cycle text NOT NULL DEFAULT 'monthly' CHECK(billing_cycle IN ('monthly','annual'));
ALTER TABLE bb_subscription_periods ADD COLUMN monthly_points bigint GENERATED ALWAYS AS (points/CASE billing_cycle WHEN 'annual' THEN 12 ELSE 1 END) STORED;
DO $$ DECLARE item record; n integer:=0; BEGIN
 FOR item IN SELECT conname,pg_get_constraintdef(oid) definition FROM pg_constraint
  WHERE conrelid='bb_subscription_periods'::regclass AND contype='c' LOOP
  IF item.definition LIKE '%amount_fen =%' AND item.definition LIKE '%plan_id%' OR item.definition LIKE '%ends_at =%' THEN
   EXECUTE format('ALTER TABLE bb_subscription_periods DROP CONSTRAINT %I',item.conname);n:=n+1;
  END IF;
 END LOOP;
 IF n<>2 THEN RAISE EXCEPTION 'Expected exactly two legacy subscription term checks, found %',n;END IF;
END $$;
ALTER TABLE bb_subscription_periods ADD CHECK(starts_at IS NULL OR
 (ends_at=starts_at+CASE billing_cycle WHEN 'annual' THEN interval '12 months' ELSE interval '1 month' END
  AND credits_expires_at=starts_at+interval '90 days'));
ALTER TABLE bb_subscription_periods ADD CHECK(
 (billing_cycle='monthly' AND ((plan_id='light' AND amount_fen=19900 AND points=21000) OR
  (plan_id='professional' AND amount_fen=49900 AND points=55000) OR (plan_id='intensive' AND amount_fen=99900 AND points=114000))) OR
 (billing_cycle='annual' AND ((plan_id='light' AND amount_fen=214920 AND points=252000) OR
  (plan_id='professional' AND amount_fen=538920 AND points=660000) OR (plan_id='intensive' AND amount_fen=1078920 AND points=1368000))));
CREATE FUNCTION bb_subscription_billing_cycle_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.billing_cycle IS DISTINCT FROM OLD.billing_cycle THEN RAISE EXCEPTION 'Paid contract billing cycle is immutable' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER bb_subscription_billing_cycle_locked BEFORE UPDATE ON bb_subscription_periods FOR EACH ROW EXECUTE FUNCTION bb_subscription_billing_cycle_guard();

CREATE TABLE bb_subscription_credit_releases (
 id text PRIMARY KEY,owner_user_id text NOT NULL,period_id text NOT NULL REFERENCES bb_subscription_periods(id),
 installment_index integer NOT NULL CHECK(installment_index BETWEEN 1 AND 12),due_at timestamptz NOT NULL,
 points bigint NOT NULL CHECK(points>0),amount_fen bigint NOT NULL CHECK(amount_fen>0),
 state text NOT NULL DEFAULT 'scheduled' CHECK(state IN ('scheduled','issued','cancelled')),
 lot_id text UNIQUE,issued_at timestamptz,expires_at timestamptz,
 UNIQUE(period_id,installment_index),FOREIGN KEY(owner_user_id,lot_id) REFERENCES bb_credit_lots(owner_user_id,id),
 CHECK((state='issued')=(lot_id IS NOT NULL)),CHECK((lot_id IS NULL)=(issued_at IS NULL) AND (lot_id IS NULL)=(expires_at IS NULL)),
 CHECK(expires_at IS NULL OR expires_at=issued_at+interval '90 days')
);
CREATE INDEX bb_subscription_credit_release_due ON bb_subscription_credit_releases(due_at,owner_user_id) WHERE state='scheduled';
CREATE FUNCTION bb_subscription_credit_release_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p bb_subscription_periods%ROWTYPE;l bb_credit_lots%ROWTYPE;BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Subscription installment history is immutable' USING ERRCODE='23514';END IF;
 SELECT * INTO STRICT p FROM bb_subscription_periods WHERE id=NEW.period_id AND owner_user_id=NEW.owner_user_id;
 IF TG_OP='INSERT' THEN
  IF p.billing_cycle<>'annual' OR p.status<>'pending' OR NEW.state<>'scheduled' OR NEW.points<>p.monthly_points OR NEW.amount_fen*12<>p.amount_fen
   OR NEW.due_at<>bb_subscription_clock(NEW.owner_user_id)+(NEW.installment_index-1)*interval '1 month'
   OR NOT EXISTS(SELECT 1 FROM bb_recharge_orders WHERE id=p.order_id AND state='paid')
  THEN RAISE EXCEPTION 'Annual installment must match its verified original contract' USING ERRCODE='23514';END IF;
 ELSE
  IF ROW(NEW.id,NEW.owner_user_id,NEW.period_id,NEW.installment_index,NEW.due_at,NEW.points,NEW.amount_fen)
   IS DISTINCT FROM ROW(OLD.id,OLD.owner_user_id,OLD.period_id,OLD.installment_index,OLD.due_at,OLD.points,OLD.amount_fen)
   OR OLD.state<>'scheduled' AND NEW IS DISTINCT FROM OLD
  THEN RAISE EXCEPTION 'Installment terms and final issuance are immutable' USING ERRCODE='23514';END IF;
  IF NEW.state='issued' AND OLD.state='scheduled' THEN
   SELECT * INTO l FROM bb_credit_lots WHERE id=NEW.lot_id AND owner_user_id=NEW.owner_user_id;
   IF l.id IS NULL OR l.source<>'subscription' OR l.original_points<>NEW.points OR l.cash_basis_fen IS DISTINCT FROM NEW.amount_fen OR l.cash_basis_points IS DISTINCT FROM NEW.points
    OR l.cash_order_id IS DISTINCT FROM p.order_id OR l.expires_at IS DISTINCT FROM NEW.expires_at OR NEW.issued_at IS DISTINCT FROM bb_subscription_clock(NEW.owner_user_id)
    OR NEW.due_at>NEW.issued_at
   THEN RAISE EXCEPTION 'Installment issuance requires the exact due wallet lot' USING ERRCODE='23514';END IF;
  ELSIF NEW.state='cancelled' AND OLD.state='scheduled' THEN
   IF p.status<>'refunded' OR NOT EXISTS(SELECT 1 FROM bb_payment_refunds WHERE order_id=p.order_id AND state='succeeded' AND amount_fen=p.amount_fen)
   THEN RAISE EXCEPTION 'Only a completed whole-contract refund cancels future installments' USING ERRCODE='23514';END IF;
  END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER bb_subscription_credit_release_locked BEFORE INSERT OR UPDATE OR DELETE ON bb_subscription_credit_releases FOR EACH ROW EXECUTE FUNCTION bb_subscription_credit_release_guard();

-- Preserve all earlier task-refund provenance rules and add the annual branch
-- before the generic order-points test, so a whole-year lot cannot be minted.
DO $$ DECLARE definition text; marker text; replacement text; BEGIN
 SELECT pg_get_functiondef('bb_credit_cash_basis_guard()'::regprocedure) INTO definition;
 definition:=replace(definition,'paid bb_recharge_orders%ROWTYPE;','paid bb_recharge_orders%ROWTYPE; installment record;');
 marker:='SELECT * INTO paid FROM bb_recharge_orders WHERE owner_user_id=NEW.owner_user_id AND ''recharge:''||id=NEW.source_key AND state=''paid'';';
 IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN RAISE EXCEPTION 'Cash consideration anchor changed';END IF;
 replacement:=$code$
 SELECT r.*,p.order_id,p.status period_status,o.state order_state INTO installment
 FROM bb_subscription_credit_releases r JOIN bb_subscription_periods p ON p.id=r.period_id
 JOIN bb_recharge_orders o ON o.id=p.order_id AND o.owner_user_id=r.owner_user_id
 WHERE r.owner_user_id=NEW.owner_user_id AND NEW.source_key=CASE WHEN r.installment_index=1 THEN 'recharge:'||p.order_id ELSE 'subscription-release:'||r.id END;
 IF installment.id IS NOT NULL THEN
  PERFORM bb_assert_wallet_writable(NEW.owner_user_id);
  IF NEW.source<>'subscription' OR installment.state<>'scheduled' OR installment.order_state<>'paid'
   OR NOT(installment.period_status='active' OR installment.period_status='pending' AND installment.installment_index=1)
   OR installment.due_at>bb_subscription_clock(NEW.owner_user_id) OR NEW.original_points<>installment.points
   OR NEW.expires_at IS DISTINCT FROM bb_subscription_clock(NEW.owner_user_id)+interval '90 days'
   OR EXISTS(SELECT 1 FROM bb_payment_refunds WHERE order_id=installment.order_id AND state IN ('requested','processing','succeeded'))
  THEN RAISE EXCEPTION 'Only due, paid, unrefunded monthly rights can be issued' USING ERRCODE='23514';END IF;
  NEW.cash_basis_fen:=installment.amount_fen;NEW.cash_basis_points:=installment.points;
  NEW.cash_order_id:=installment.order_id;NEW.cash_origin_lot_id:=NEW.id;RETURN NEW;
 END IF;
 $code$||marker||$code$
 IF paid.order_kind='subscription' AND EXISTS(SELECT 1 FROM bb_subscription_periods WHERE order_id=paid.id AND billing_cycle='annual') THEN
  RAISE EXCEPTION 'An annual payment requires its exact scheduled monthly installment' USING ERRCODE='23514';END IF;
 $code$;
 EXECUTE replace(definition,marker,replacement);
END $$;

CREATE OR REPLACE FUNCTION bb_payment_cash_proof_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM bb_recharge_orders o JOIN bb_credit_lots l ON l.owner_user_id=o.owner_user_id AND l.source_key='recharge:'||o.id
  LEFT JOIN bb_subscription_periods p ON p.order_id=o.id AND p.owner_user_id=o.owner_user_id
  WHERE o.id=NEW.order_id AND o.owner_user_id=NEW.owner_user_id AND o.state='paid' AND o.amount_fen=NEW.order_amount_fen AND o.currency=NEW.currency
   AND o.provider=NEW.provider AND o.merchant_id=NEW.merchant_id AND o.provider_txn_id=NEW.provider_txn_id AND l.id=NEW.lot_id
   AND ((o.order_kind='recharge' AND o.amount_fen BETWEEN 1 AND 1000000 AND o.points BETWEEN 1 AND 1150000
     AND l.source='purchase' AND l.original_points=o.points AND l.expires_at IS NULL)
    OR (o.order_kind='subscription' AND p.status='active' AND p.lot_id=l.id AND p.amount_fen=o.amount_fen AND p.points=o.points
     AND l.source='subscription' AND l.original_points=p.monthly_points AND l.expires_at=p.credits_expires_at
     AND (p.billing_cycle='monthly' OR EXISTS(SELECT 1 FROM bb_subscription_credit_releases r WHERE r.period_id=p.id AND r.installment_index=1
       AND r.lot_id=l.id AND r.state='issued' AND r.amount_fen*12=o.amount_fen)))))
 THEN RAISE EXCEPTION 'Verified original payment and matching issued rights required' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;

-- Whole-contract withdrawal removes ISSUED credits and cancels the unissued
-- rights. Cash is refunded once for the order, never once per installment.
DO $$ DECLARE definition text;marker text;BEGIN
 SELECT pg_get_functiondef('bb_payment_refund_credit_guard()'::regprocedure) INTO definition;
 definition:=replace(definition,'now()>sp.starts_at+interval ''7 days''','bb_subscription_clock(NEW.owner_user_id)>sp.starts_at+interval ''7 days''');
 marker:='IF NEW.credit_points NOT BETWEEN 1 AND 1150000 OR NEW.amount_fen NOT BETWEEN 1 AND 1000000';
 IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN RAISE EXCEPTION 'Original refund guard anchor changed';END IF;
 EXECUTE replace(definition,marker,$code$
 IF o.order_kind='subscription' THEN
  SELECT * INTO sp FROM bb_subscription_periods WHERE order_id=o.id AND owner_user_id=NEW.owner_user_id;
  IF sp.billing_cycle='annual' THEN
   IF sp.status<>'active' OR sp.lot_id<>l.id OR l.source<>'subscription' OR l.source_key<>'recharge:'||o.id
    OR bb_subscription_clock(NEW.owner_user_id)>sp.starts_at+interval '7 days' OR bb_subscription_clock(NEW.owner_user_id)<sp.starts_at
    OR NEW.amount_fen<>o.amount_fen OR NEW.credit_points<>sp.monthly_points OR l.original_points<>sp.monthly_points
    OR l.remaining<>sp.monthly_points OR l.frozen<>0
    OR (SELECT count(*) FROM bb_subscription_credit_releases WHERE period_id=sp.id AND state='issued')<>1
    OR EXISTS(SELECT 1 FROM bb_credit_allocations a JOIN bb_credit_lots source ON source.id=a.lot_id
      WHERE source.cash_order_id=o.id AND a.charged_points>0)
    OR EXISTS(SELECT 1 FROM bb_payment_refunds WHERE order_id=o.id AND state IN ('requested','processing','succeeded'))
   THEN RAISE EXCEPTION 'Annual refund requires one wholly unused contract within seven days' USING ERRCODE='23514';END IF;
   RETURN NEW;
  END IF;
 END IF;
 $code$||marker);
END $$;
