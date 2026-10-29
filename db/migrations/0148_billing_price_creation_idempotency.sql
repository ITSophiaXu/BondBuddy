-- Network retries preserve the original frozen cost or price draft. Prior history remains untouched.
ALTER TABLE bb_billing_cost_versions ADD COLUMN request_id text,ADD COLUMN request_hash char(64),
 ADD CONSTRAINT bb_billing_cost_request_shape CHECK((request_id IS NULL)=(request_hash IS NULL)),
 ADD CONSTRAINT bb_billing_cost_request UNIQUE(created_by,request_id);
ALTER TABLE bb_billing_price_drafts ADD COLUMN request_id text,ADD COLUMN request_hash char(64),
 ADD CONSTRAINT bb_billing_price_request_shape CHECK((request_id IS NULL)=(request_hash IS NULL)),
 ADD CONSTRAINT bb_billing_price_request UNIQUE(created_by,request_id);
DO $$ DECLARE definition text;marker text:='ROW(NEW.id,NEW.base_cost_version'; BEGIN
 SELECT pg_get_functiondef('bb_billing_price_draft_guard()'::regprocedure) INTO definition;
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'Unexpected price draft guard'; END IF;
 definition:=replace(definition,marker,'ROW(NEW.request_id,NEW.request_hash,NEW.id,NEW.base_cost_version');
 definition:=replace(definition,'ROW(OLD.id,OLD.base_cost_version','ROW(OLD.request_id,OLD.request_hash,OLD.id,OLD.base_cost_version');
 EXECUTE definition;
END $$;
