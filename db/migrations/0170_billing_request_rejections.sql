-- A confirmed unaccepted request must never become a paid request after the
-- browser has released its pending intent. These receipts are append-only.
CREATE TABLE bb_billing_request_rejections (
  owner_user_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('integrity','refund')),
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  resource_id text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  reason_code text NOT NULL CHECK (reason_code IN ('QUOTE_CHANGED','QUOTE_REQUIRED','BILLING_PROTOCOL_REPLAY_ONLY')),
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id,kind,request_id)
);
CREATE TRIGGER bb_billing_request_rejection_immutable
  BEFORE UPDATE OR DELETE ON bb_billing_request_rejections
  FOR EACH ROW EXECUTE FUNCTION bb_credit_immutable();

-- Share the request fence with both current and already-running old handlers.
-- The acceptance triggers are a final guard even if an old process does not yet
-- know how to read the new rejection table.
CREATE FUNCTION bb_guard_billing_request_rejection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.owner_user_id||':'||NEW.kind||':'||NEW.request_id,0));
  IF (NEW.kind='integrity' AND EXISTS(SELECT 1 FROM bb_runs WHERE owner_user_id=NEW.owner_user_id AND execution_request_id='integrity:'||NEW.request_id))
    OR (NEW.kind='refund' AND EXISTS(SELECT 1 FROM bb_payment_refunds WHERE owner_user_id=NEW.owner_user_id AND request_id=NEW.request_id)) THEN
    RAISE EXCEPTION 'an accepted billing request cannot be rejected' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bb_billing_request_rejection_no_receipt
  BEFORE INSERT ON bb_billing_request_rejections
  FOR EACH ROW EXECUTE FUNCTION bb_guard_billing_request_rejection();

CREATE FUNCTION bb_guard_rejected_billing_request_acceptance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE request_kind text; request_key text;
BEGIN
  IF TG_TABLE_NAME='bb_runs' THEN
    IF NEW.execution_request_id NOT LIKE 'integrity:%' THEN RETURN NEW; END IF;
    request_kind:='integrity'; request_key:=substring(NEW.execution_request_id FROM 11);
  ELSE
    request_kind:='refund'; request_key:=NEW.request_id;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.owner_user_id||':'||request_kind||':'||request_key,0));
  IF EXISTS(SELECT 1 FROM bb_billing_request_rejections WHERE owner_user_id=NEW.owner_user_id AND kind=request_kind AND request_id=request_key) THEN
    RAISE EXCEPTION 'a rejected billing request cannot be accepted' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bb_integrity_request_not_rejected BEFORE INSERT ON bb_runs
  FOR EACH ROW EXECUTE FUNCTION bb_guard_rejected_billing_request_acceptance();
CREATE TRIGGER bb_refund_request_not_rejected BEFORE INSERT ON bb_payment_refunds
  FOR EACH ROW EXECUTE FUNCTION bb_guard_rejected_billing_request_acceptance();
