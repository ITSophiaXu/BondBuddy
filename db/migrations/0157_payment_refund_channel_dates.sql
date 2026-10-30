-- Authenticated channel resource times. Never backfill from local created_at,
-- completed_at or a notification envelope's create_time.
ALTER TABLE bb_payment_refunds ADD COLUMN provider_created_at timestamptz;
ALTER TABLE bb_payment_refunds ADD COLUMN provider_succeeded_at timestamptz;
ALTER TABLE bb_payment_refunds ADD CONSTRAINT bb_refund_channel_dates_valid CHECK (
  (provider_created_at IS NULL OR (isfinite(provider_created_at) AND state<>'requested')) AND
  (provider_succeeded_at IS NULL OR (isfinite(provider_succeeded_at) AND state='succeeded')) AND
  (provider_created_at IS NULL OR provider_succeeded_at IS NULL OR provider_succeeded_at>=provider_created_at)
);
CREATE FUNCTION bb_refund_channel_dates_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.provider_created_at IS NOT NULL AND NEW.provider_created_at IS DISTINCT FROM OLD.provider_created_at
   OR OLD.provider_succeeded_at IS NOT NULL AND NEW.provider_succeeded_at IS DISTINCT FROM OLD.provider_succeeded_at
 THEN RAISE EXCEPTION 'Authenticated refund channel dates are immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_refund_channel_dates_locked BEFORE UPDATE ON bb_payment_refunds
 FOR EACH ROW EXECUTE FUNCTION bb_refund_channel_dates_guard();
-- Preserve every terminal financial field. Only first channel-time evidence and
-- the bounded reconciliation schedule may change after a refund is terminal.
CREATE OR REPLACE FUNCTION bb_payment_refund_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
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
     OR (OLD.state IN ('succeeded','failed') AND
       (to_jsonb(NEW)-ARRAY['provider_created_at','provider_succeeded_at','next_reconcile_at','reconcile_attempts']) IS DISTINCT FROM
       (to_jsonb(OLD)-ARRAY['provider_created_at','provider_succeeded_at','next_reconcile_at','reconcile_attempts']))
     OR (OLD.state='processing' AND NEW.state='requested')
   THEN RAISE EXCEPTION 'Refund identity and terminal outcome are locked' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE INDEX bb_refunds_channel_application_day ON bb_payment_refunds(provider,merchant_id,provider_created_at)
 WHERE provider_created_at IS NOT NULL;
