-- Worker terminal writes enter SQL directly. Acquire the SAME safety key before
-- the original wallet lock, never from a lot-update trigger after that lock.
CREATE FUNCTION bb_assert_wallet_writable(p_owner text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('billing-safety:wallet:'||p_owner,0));
 IF EXISTS(SELECT 1 FROM bb_billing_safety_blocks WHERE scope_key='wallet:'||p_owner AND resume_event_id IS NULL)
 THEN RAISE EXCEPTION 'BILLING_NOT_READY: wallet is isolated' USING ERRCODE='55000'; END IF;
END $$;
CREATE FUNCTION bb_assert_channel_writable(p_provider text,p_merchant text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('billing-safety:channel:'||p_provider||':'||p_merchant,0));
 IF EXISTS(SELECT 1 FROM bb_billing_safety_blocks WHERE scope_key='channel:'||p_provider||':'||p_merchant AND resume_event_id IS NULL)
 THEN RAISE EXCEPTION 'BILLING_NOT_READY: payment channel is isolated' USING ERRCODE='55000'; END IF;
END $$;

-- Patch the installed definitions so newer business and delivery rules from all
-- earlier migrations are retained. Fail migration if the precise lock anchor is
-- absent/duplicated; do not silently leave a writer unprotected.
DO $$ DECLARE fn text; definition text; marker text; replacement text; occurrence integer; BEGIN
 FOREACH fn IN ARRAY ARRAY['bb_credit_finalize_run()','bb_m4_credit_finalize_run()','bb_task_refund_credit_guard()','bb_capture_task_refund_units()'] LOOP
   SELECT pg_get_functiondef(fn::regprocedure) INTO definition;
   marker:=CASE WHEN fn='bb_capture_task_refund_units()' THEN 'PERFORM 1 FROM bb_credit_accounts WHERE owner_user_id=r.owner_user_id FOR UPDATE;'
     ELSE 'PERFORM 1 FROM bb_credit_accounts WHERE owner_user_id=NEW.owner_user_id FOR UPDATE;' END;
   replacement:=CASE WHEN fn='bb_capture_task_refund_units()' THEN 'PERFORM bb_assert_wallet_writable(r.owner_user_id);'
     ELSE 'PERFORM bb_assert_wallet_writable(NEW.owner_user_id);' END||E'\n '||marker;
   occurrence:=(length(definition)-length(replace(definition,marker,'')))/length(marker);
   IF occurrence<>1 THEN RAISE EXCEPTION 'Expected exactly one pre-wallet lock anchor in %, found %',fn,occurrence; END IF;
   EXECUTE replace(definition,marker,replacement);
 END LOOP;

 -- Refund state transitions and source allocations are guarded for both the
 -- channel and wallet. Control operations (cancel renewal/close checkout) use
 -- neither of these refund-money functions and remain available.
 SELECT pg_get_functiondef('bb_payment_refund_credit_guard()'::regprocedure) INTO definition;
 marker:='IF TG_OP=''UPDATE'' THEN';
 IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN RAISE EXCEPTION 'Refund credit state anchor changed'; END IF;
 EXECUTE replace(definition,marker,'PERFORM bb_assert_channel_writable(NEW.provider,NEW.merchant_id);'||E'\n PERFORM bb_assert_wallet_writable(NEW.owner_user_id);\n '||marker);

 SELECT pg_get_functiondef('bb_payment_refund_allocation_guard()'::regprocedure) INTO definition;
 marker:='PERFORM 1 FROM bb_credit_accounts WHERE owner_user_id=NEW.owner_user_id FOR UPDATE;';
 IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN RAISE EXCEPTION 'Refund allocation lock anchor changed'; END IF;
 replacement:='SELECT * INTO STRICT r FROM bb_payment_refunds WHERE id=NEW.refund_id AND owner_user_id=NEW.owner_user_id;'||
   E'\n PERFORM bb_assert_channel_writable(r.provider,r.merchant_id);\n PERFORM bb_assert_wallet_writable(NEW.owner_user_id);\n '||marker;
 EXECUTE replace(definition,marker,replacement);
END $$;
