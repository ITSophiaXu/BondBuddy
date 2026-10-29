-- Separate billing authority. No existing log/library/operator grant acquires it.
CREATE TABLE bb_billing_operator_grants (
 id text PRIMARY KEY,user_id text NOT NULL REFERENCES bb_users(id),
 permission text NOT NULL CHECK(permission IN ('price_draft','price_publish','task_refund_approve','billing_repair','credit_adjust_approve')),
 request_id text NOT NULL UNIQUE,request_hash char(64) NOT NULL,
 granted_by text NOT NULL CHECK(length(trim(granted_by))>0),reason text NOT NULL CHECK(length(trim(reason))>0),
 created_at timestamptz NOT NULL DEFAULT now(),
 revoked_at timestamptz,revoked_by text,revocation_reason text,revocation_request_id text UNIQUE,revocation_hash char(64),
 CHECK((revoked_at IS NULL AND revoked_by IS NULL AND revocation_reason IS NULL AND revocation_request_id IS NULL AND revocation_hash IS NULL)
   OR(revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND revocation_reason IS NOT NULL
     AND length(trim(revoked_by))>0 AND length(trim(revocation_reason))>0 AND revocation_request_id IS NOT NULL AND revocation_hash IS NOT NULL))
);
CREATE UNIQUE INDEX bb_billing_operator_active ON bb_billing_operator_grants(user_id,permission) WHERE revoked_at IS NULL;

CREATE FUNCTION bb_billing_operator_grant_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Billing permission history is immutable' USING ERRCODE='23514'; END IF;
 IF OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL
    OR (to_jsonb(NEW)-ARRAY['revoked_at','revoked_by','revocation_reason','revocation_request_id','revocation_hash'])
       IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['revoked_at','revoked_by','revocation_reason','revocation_request_id','revocation_hash'])
 THEN RAISE EXCEPTION 'Billing permission may only be revoked once; history is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_billing_operator_grant_immutable BEFORE UPDATE OR DELETE ON bb_billing_operator_grants
 FOR EACH ROW EXECUTE FUNCTION bb_billing_operator_grant_guard();
