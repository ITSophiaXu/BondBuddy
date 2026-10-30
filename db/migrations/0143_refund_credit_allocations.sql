-- A quality correction appends a source-preserving lot. Keep the payment refund
-- attached to the original authenticated order and allocate its actual credits.
CREATE TABLE bb_payment_refund_allocations (
 refund_id text NOT NULL REFERENCES bb_payment_refunds(id),owner_user_id text NOT NULL,
 lot_id text NOT NULL,points bigint NOT NULL CHECK(points>0 AND points<=1150000),
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(refund_id,lot_id),
 FOREIGN KEY(owner_user_id,lot_id) REFERENCES bb_credit_lots(owner_user_id,id)
);
INSERT INTO bb_payment_refund_allocations(refund_id,owner_user_id,lot_id,points,created_at)
 SELECT id,owner_user_id,lot_id,credit_points,created_at FROM bb_payment_refunds;
CREATE INDEX bb_payment_refund_allocation_lot ON bb_payment_refund_allocations(lot_id,refund_id);
CREATE INDEX bb_credit_cash_family ON bb_credit_lots(owner_user_id,cash_origin_lot_id,cash_order_id);
CREATE FUNCTION bb_payment_refund_allocation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r bb_payment_refunds%ROWTYPE; l bb_credit_lots%ROWTYPE; o bb_recharge_orders%ROWTYPE; BEGIN
 PERFORM 1 FROM bb_credit_accounts WHERE owner_user_id=NEW.owner_user_id FOR UPDATE;
 SELECT * INTO STRICT r FROM bb_payment_refunds WHERE id=NEW.refund_id AND owner_user_id=NEW.owner_user_id;
 SELECT * INTO STRICT l FROM bb_credit_lots WHERE id=NEW.lot_id AND owner_user_id=NEW.owner_user_id FOR UPDATE;
 SELECT * INTO STRICT o FROM bb_recharge_orders WHERE id=r.order_id AND owner_user_id=NEW.owner_user_id;
 IF r.state<>'requested' OR l.remaining-l.frozen<NEW.points OR (l.expires_at IS NOT NULL AND l.expires_at<=now())
   OR (l.id=r.lot_id OR (o.order_kind='recharge' AND l.cash_origin_lot_id=r.lot_id AND l.cash_order_id=o.id
     AND l.cash_basis_fen=o.amount_fen AND l.cash_basis_points=o.points AND l.source='purchase')) IS NOT TRUE
   OR (SELECT COALESCE(sum(points),0) FROM bb_payment_refund_allocations WHERE refund_id=r.id)+NEW.points>r.credit_points
 THEN RAISE EXCEPTION 'Refund allocation must use available original-payment source rights' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_payment_refund_allocation_valid BEFORE INSERT ON bb_payment_refund_allocations FOR EACH ROW EXECUTE FUNCTION bb_payment_refund_allocation_guard();
CREATE TRIGGER bb_payment_refund_allocation_immutable BEFORE UPDATE OR DELETE ON bb_payment_refund_allocations FOR EACH ROW EXECUTE FUNCTION bb_credit_immutable();
CREATE FUNCTION bb_payment_refund_allocation_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_state text; BEGIN
 IF NEW.credit_points<>(SELECT COALESCE(sum(points),0) FROM bb_payment_refund_allocations WHERE refund_id=NEW.id)
 THEN RAISE EXCEPTION 'Refund credit allocations must exactly cover the immutable refund quantity' USING ERRCODE='23514'; END IF;
 SELECT state INTO current_state FROM bb_payment_refunds WHERE id=NEW.id;
 IF current_state IN ('requested','processing') AND EXISTS(SELECT 1 FROM bb_payment_refund_allocations a
   JOIN bb_credit_lots l ON l.id=a.lot_id AND l.owner_user_id=a.owner_user_id WHERE a.refund_id=NEW.id AND l.frozen<a.points)
 THEN RAISE EXCEPTION 'Every unresolved refund allocation must remain frozen' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER bb_payment_refund_allocation_complete AFTER INSERT OR UPDATE ON bb_payment_refunds
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bb_payment_refund_allocation_complete();
