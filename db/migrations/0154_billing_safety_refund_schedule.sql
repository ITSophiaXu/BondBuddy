-- Isolation fences money/state transitions, not recovery scheduling metadata.
-- Otherwise one isolated refund would abort a multi-wallet reconciliation claim.
DO $$ DECLARE definition text; marker text; replacement text; BEGIN
 SELECT pg_get_functiondef('bb_payment_refund_credit_guard()'::regprocedure) INTO definition;
 marker:='PERFORM bb_assert_channel_writable(NEW.provider,NEW.merchant_id);'||E'\n PERFORM bb_assert_wallet_writable(NEW.owner_user_id);';
 IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN RAISE EXCEPTION 'Expected exact refund safety guard from 0151'; END IF;
 replacement:='IF TG_OP=''INSERT'' OR (to_jsonb(NEW)-ARRAY[''reconcile_attempts'',''next_reconcile_at'',''updated_at''])'||
   E'\n   IS DISTINCT FROM (to_jsonb(OLD)-ARRAY[''reconcile_attempts'',''next_reconcile_at'',''updated_at'']) THEN\n '||marker||E'\n END IF;';
 EXECUTE replace(definition,marker,replacement);
END $$;
