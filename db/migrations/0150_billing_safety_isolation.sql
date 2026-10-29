-- Durable isolation is a separate transaction from the business mutation that failed.
-- Original credit/payment facts are never rewritten by an isolation or a resumption.
CREATE TABLE bb_billing_safety_incidents (
 id text PRIMARY KEY,scope_kind text NOT NULL CHECK(scope_kind IN ('wallet','channel')),
 owner_user_id text REFERENCES bb_users(id),provider text,merchant_id text,
 scope_key text GENERATED ALWAYS AS (CASE WHEN scope_kind='wallet' THEN 'wallet:'||owner_user_id ELSE 'channel:'||provider||':'||merchant_id END) STORED,
 evidence jsonb NOT NULL,detected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((scope_kind='wallet' AND owner_user_id IS NOT NULL AND provider IS NULL AND merchant_id IS NULL)
   OR(scope_kind='channel' AND owner_user_id IS NULL AND provider IN ('wechat','alipay') AND length(trim(merchant_id))>0))
);
CREATE TABLE bb_billing_safety_audit (
 id text PRIMARY KEY,incident_id text NOT NULL REFERENCES bb_billing_safety_incidents(id),
 operation text NOT NULL CHECK(operation IN ('isolated','recheck_failed','resumed','projection_repaired','repair_rejected')),
 actor text NOT NULL,authority_grant_id text REFERENCES bb_billing_operator_grants(id),
 request_id text NOT NULL UNIQUE,request_hash char(64) NOT NULL,
 reason text NOT NULL CHECK(length(trim(reason))>0),evidence jsonb NOT NULL,result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((operation='isolated' AND actor='system' AND authority_grant_id IS NULL)
   OR(operation<>'isolated' AND authority_grant_id IS NOT NULL))
);
CREATE INDEX bb_billing_safety_audit_incident ON bb_billing_safety_audit(incident_id,created_at,id);
CREATE TABLE bb_billing_safety_blocks (
 incident_id text PRIMARY KEY REFERENCES bb_billing_safety_incidents(id),scope_key text NOT NULL,
 resume_event_id text REFERENCES bb_billing_safety_audit(id)
);
CREATE UNIQUE INDEX bb_billing_safety_active_scope ON bb_billing_safety_blocks(scope_key) WHERE resume_event_id IS NULL;
CREATE TRIGGER bb_billing_safety_incidents_immutable BEFORE UPDATE OR DELETE ON bb_billing_safety_incidents FOR EACH ROW EXECUTE FUNCTION bb_credit_immutable();
CREATE TRIGGER bb_billing_safety_audit_immutable BEFORE UPDATE OR DELETE ON bb_billing_safety_audit FOR EACH ROW EXECUTE FUNCTION bb_credit_immutable();

CREATE FUNCTION bb_billing_safety_audit_authority() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.operation<>'isolated' AND NOT EXISTS(SELECT 1 FROM bb_billing_operator_grants g JOIN bb_users u ON u.id=g.user_id
   WHERE g.id=NEW.authority_grant_id AND g.user_id=NEW.actor AND g.permission='billing_repair' AND g.revoked_at IS NULL AND u.status='active')
 THEN RAISE EXCEPTION 'Independent active billing repair authority required' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_billing_safety_audit_authorized BEFORE INSERT ON bb_billing_safety_audit FOR EACH ROW EXECUTE FUNCTION bb_billing_safety_audit_authority();

CREATE FUNCTION bb_billing_safety_block_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Billing isolation history is immutable' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
   IF NEW.resume_event_id IS NOT NULL OR NOT EXISTS(SELECT 1 FROM bb_billing_safety_incidents i JOIN bb_billing_safety_audit a ON a.incident_id=i.id
     WHERE i.id=NEW.incident_id AND i.scope_key=NEW.scope_key AND a.operation='isolated')
   THEN RAISE EXCEPTION 'Original isolation evidence and event required' USING ERRCODE='23514'; END IF;
 ELSE
   IF OLD.resume_event_id IS NOT NULL OR NEW.resume_event_id IS NULL OR NEW.incident_id<>OLD.incident_id OR NEW.scope_key<>OLD.scope_key
     OR NOT EXISTS(SELECT 1 FROM bb_billing_safety_audit a WHERE a.id=NEW.resume_event_id AND a.incident_id=OLD.incident_id AND a.operation='resumed')
   THEN RAISE EXCEPTION 'Only an audited verified resumption can release isolation' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_billing_safety_block_locked BEFORE INSERT OR UPDATE OR DELETE ON bb_billing_safety_blocks FOR EACH ROW EXECUTE FUNCTION bb_billing_safety_block_guard();
