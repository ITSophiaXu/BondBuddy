-- Closing a checkout never reverses an authenticated payment or issues a refund.
ALTER TABLE bb_recharge_orders ADD COLUMN close_requested_at timestamptz;
ALTER TABLE bb_recharge_orders ADD COLUMN close_confirmed_at timestamptz;
ALTER TABLE bb_recharge_orders ADD COLUMN provider_paid_at timestamptz;
CREATE FUNCTION bb_payment_close_intent_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.close_requested_at IS NOT NULL AND NEW.close_requested_at IS DISTINCT FROM OLD.close_requested_at
   OR OLD.close_confirmed_at IS NOT NULL AND NEW.close_confirmed_at IS DISTINCT FROM OLD.close_confirmed_at
   OR NEW.close_confirmed_at IS NOT NULL AND NEW.close_requested_at IS NULL
   OR OLD.provider_paid_at IS NOT NULL AND NEW.provider_paid_at IS DISTINCT FROM OLD.provider_paid_at
 THEN RAISE EXCEPTION 'Original payment close intent and channel time are immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_payment_close_intent_locked BEFORE UPDATE ON bb_recharge_orders FOR EACH ROW EXECUTE FUNCTION bb_payment_close_intent_guard();
