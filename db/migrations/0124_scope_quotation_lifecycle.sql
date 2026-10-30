-- Published prices remain immutable; closing a quotation changes only its lifecycle.
DROP TRIGGER bb_scope_quotation_locked ON bb_scope_quotations;
ALTER TABLE bb_scope_quotations ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK(revision>0);
ALTER TABLE bb_scope_quotations ADD COLUMN previous_quote_id text;
ALTER TABLE bb_scope_quotations ADD COLUMN expires_at timestamptz;
ALTER TABLE bb_scope_quotations ADD COLUMN closed_at timestamptz;
ALTER TABLE bb_scope_quotations ADD COLUMN decline_reason text NOT NULL DEFAULT '';
ALTER TABLE bb_scope_quotations ADD COLUMN closure_reason text NOT NULL DEFAULT '';
-- Historical quotations retain their approved terms, with a finite initial validity window.
UPDATE bb_scope_quotations SET expires_at=now()+interval '7 days' WHERE status='quoted';
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='bb_scope_quotations'::regclass AND
 ((contype='c' AND pg_get_constraintdef(oid) LIKE '%status%') OR
  (contype='u' AND pg_get_constraintdef(oid)='UNIQUE (owner_user_id, project_id, action, input_hash)'))
 LOOP EXECUTE format('ALTER TABLE bb_scope_quotations DROP CONSTRAINT %I',c.conname); END LOOP;
END $$;
ALTER TABLE bb_scope_quotations ADD UNIQUE(owner_user_id,project_id,action,input_hash,revision);
ALTER TABLE bb_scope_quotations ADD FOREIGN KEY(owner_user_id,previous_quote_id) REFERENCES bb_scope_quotations(owner_user_id,id);
CREATE UNIQUE INDEX bb_scope_revision_successor ON bb_scope_quotations(owner_user_id,previous_quote_id) WHERE previous_quote_id IS NOT NULL;
ALTER TABLE bb_scope_quotations ADD CONSTRAINT bb_scope_lifecycle CHECK(
 status IN ('pending','quoted','unavailable','declined','expired') AND
 ((published_at IS NULL AND amount_fen IS NULL AND approved_by IS NULL AND lines='[]'::jsonb AND expires_at IS NULL AND status IN ('pending','unavailable')) OR
  (published_at IS NOT NULL AND amount_fen IS NOT NULL AND amount_fen BETWEEN 1 AND 100000000 AND approved_by IS NOT NULL AND length(trim(approved_by))>0 AND length(trim(reason))>0 AND expires_at IS NOT NULL AND expires_at>published_at AND jsonb_typeof(lines)='array' AND jsonb_array_length(lines) BETWEEN 1 AND 200 AND status<>'pending')) AND
 ((status IN ('pending','quoted') AND closed_at IS NULL AND decline_reason='' AND closure_reason='') OR
  (status IN ('unavailable','declined','expired') AND closed_at IS NOT NULL AND length(trim(closure_reason))>0)) AND
 (status<>'declined' OR length(trim(decline_reason)) BETWEEN 1 AND 1000));

CREATE TABLE bb_scope_quotation_requests(
 owner_user_id text NOT NULL,request_id text NOT NULL,request_hash char(64) NOT NULL,
 action text NOT NULL CHECK(action IN ('decline','requote')),scope_quote_id text NOT NULL,result_quote_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(owner_user_id,request_id),
 FOREIGN KEY(owner_user_id,scope_quote_id) REFERENCES bb_scope_quotations(owner_user_id,id),
 FOREIGN KEY(owner_user_id,result_quote_id) REFERENCES bb_scope_quotations(owner_user_id,id));
CREATE FUNCTION bb_scope_audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 RAISE EXCEPTION 'Scope audit evidence is immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER bb_scope_request_immutable BEFORE UPDATE OR DELETE ON bb_scope_quotation_requests FOR EACH ROW EXECUTE FUNCTION bb_scope_audit_immutable();

-- A private batch acceptance proves the user accepted this exact input and price while valid.
CREATE TABLE bb_scope_acceptances(
 id text PRIMARY KEY,owner_user_id text NOT NULL,scope_quote_id text NOT NULL,
 context text NOT NULL CHECK(context IN ('file_generation_batch','file_update_batch')),
 context_id text NOT NULL,item_index integer NOT NULL CHECK(item_index>=0),manifest jsonb NOT NULL,
 accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(owner_user_id,id),UNIQUE(owner_user_id,context,context_id,item_index),
 FOREIGN KEY(owner_user_id,scope_quote_id) REFERENCES bb_scope_quotations(owner_user_id,id));
CREATE FUNCTION bb_scope_acceptance_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s bb_scope_quotations; item jsonb; BEGIN
 SELECT * INTO s FROM bb_scope_quotations WHERE owner_user_id=NEW.owner_user_id AND id=NEW.scope_quote_id FOR UPDATE;
 IF s.id IS NULL OR s.status<>'quoted' OR s.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'Valid quote required for acceptance' USING ERRCODE='23514'; END IF;
 IF NEW.context='file_generation_batch' THEN
  SELECT items->NEW.item_index INTO item FROM bb_project_file_batches WHERE owner_user_id=NEW.owner_user_id AND id=NEW.context_id AND state='queued';
  IF s.action<>'m4_document' THEN RAISE EXCEPTION 'Wrong batch scope action' USING ERRCODE='23514'; END IF;
 ELSE
  SELECT items->NEW.item_index INTO item FROM bb_project_file_update_batches WHERE owner_user_id=NEW.owner_user_id AND id=NEW.context_id AND state='queued';
  IF s.action<>'project_file_patch' THEN RAISE EXCEPTION 'Wrong batch scope action' USING ERRCODE='23514'; END IF;
 END IF;
 IF item IS NULL OR item->>'scope_quote_id' IS DISTINCT FROM s.id OR (item->>'points')::bigint IS DISTINCT FROM s.amount_fen OR item->'manifest' IS DISTINCT FROM NEW.manifest OR
  (CASE WHEN NEW.context='file_generation_batch' THEN s.snapshot ELSE s.snapshot->'manifest' END) IS DISTINCT FROM NEW.manifest
 THEN RAISE EXCEPTION 'Acceptance must match the persisted owned batch item and approved snapshot' USING ERRCODE='23514'; END IF;
 NEW.accepted_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER bb_scope_acceptance_valid BEFORE INSERT ON bb_scope_acceptances FOR EACH ROW EXECUTE FUNCTION bb_scope_acceptance_guard();
CREATE TRIGGER bb_scope_acceptance_immutable BEFORE UPDATE OR DELETE ON bb_scope_acceptances FOR EACH ROW EXECUTE FUNCTION bb_scope_audit_immutable();
ALTER TABLE bb_m4_quotes ADD COLUMN scope_acceptance_id text;
ALTER TABLE bb_project_file_update_quotes ADD COLUMN scope_acceptance_id text;
ALTER TABLE bb_m4_quotes ADD FOREIGN KEY(owner_user_id,scope_acceptance_id) REFERENCES bb_scope_acceptances(owner_user_id,id);
ALTER TABLE bb_project_file_update_quotes ADD FOREIGN KEY(owner_user_id,scope_acceptance_id) REFERENCES bb_scope_acceptances(owner_user_id,id);

-- Legacy identities are retained; revised outcome quotations have independent executable identities.
DROP INDEX bb_authoring_quote_identity;
DROP INDEX bb_review_quote_identity;
CREATE UNIQUE INDEX bb_authoring_quote_identity ON bb_credit_quotes(owner_user_id,project_id,input_revision,price_version) WHERE intent_hash IS NULL AND scope_quote_id IS NULL;
CREATE UNIQUE INDEX bb_review_quote_identity ON bb_credit_quotes(owner_user_id,project_id,intent_hash,price_version) WHERE intent_hash IS NOT NULL AND scope_quote_id IS NULL;
CREATE UNIQUE INDEX bb_scope_credit_quote_identity ON bb_credit_quotes(owner_user_id,scope_quote_id) WHERE scope_quote_id IS NOT NULL;

CREATE OR REPLACE FUNCTION bb_approved_scope_price_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s bb_scope_quotations; a bb_scope_acceptances; price bigint; target_project text; action_name text; work_hash text; acceptance_id text; manifest jsonb; BEGIN
 acceptance_id:=to_jsonb(NEW)->>'scope_acceptance_id';
 IF NEW.scope_quote_id IS NULL AND acceptance_id IS NOT NULL THEN RAISE EXCEPTION 'Acceptance requires scope' USING ERRCODE='23514'; END IF;
 IF NEW.scope_quote_id IS NOT NULL THEN
  SELECT * INTO s FROM bb_scope_quotations WHERE id=NEW.scope_quote_id AND owner_user_id=NEW.owner_user_id FOR UPDATE;
  IF TG_TABLE_NAME='bb_m4_quotes' THEN price:=NEW.reserve_points; ELSE price:=NEW.points; END IF;
  CASE TG_TABLE_NAME
   WHEN 'bb_credit_quotes' THEN target_project:=NEW.project_id;action_name:=CASE WHEN NEW.intent_hash IS NULL THEN 'authoring' ELSE 'review' END;work_hash:=COALESCE(NEW.intent_hash,NEW.input_hash);
   WHEN 'bb_m4_quotes' THEN SELECT project_id INTO target_project FROM bb_m4_topics WHERE owner_user_id=NEW.owner_user_id AND id=NEW.topic_id;action_name:=CASE WHEN NEW.task_type LIKE 'm4_Q%' THEN 'm4_qa' ELSE 'm4_document' END;work_hash:=NEW.intent_hash;manifest:=NEW.snapshot;
   WHEN 'bb_project_qa_quotes' THEN SELECT project_id INTO target_project FROM bb_project_qa_runs WHERE run_id=NEW.run_id AND owner_user_id=NEW.owner_user_id;action_name:='project_qa_answer';work_hash:=NEW.scope_work_hash;
   WHEN 'bb_project_file_check_quotes' THEN target_project:=NEW.project_id;action_name:='project_file_check';work_hash:=NEW.scope_work_hash;
   WHEN 'bb_project_file_update_quotes' THEN target_project:=NEW.project_id;action_name:='project_file_patch';work_hash:=NEW.scope_work_hash;SELECT o.manifest INTO manifest FROM bb_project_file_operations o WHERE o.run_id=NEW.run_id AND o.owner_user_id=NEW.owner_user_id;
   WHEN 'bb_integrity_quotes' THEN SELECT project_id INTO target_project FROM bb_integrity_runs WHERE run_id=NEW.run_id AND owner_user_id=NEW.owner_user_id;action_name:='integrity_round';work_hash:=NEW.scope_work_hash;
   ELSE RAISE EXCEPTION 'Unsupported scope quote family';
  END CASE;
  IF s.id IS NULL OR s.published_at IS NULL OR s.amount_fen IS DISTINCT FROM price OR s.project_id IS DISTINCT FROM target_project OR s.action IS DISTINCT FROM action_name OR s.input_hash IS DISTINCT FROM work_hash OR s.lines IS DISTINCT FROM NEW.scope_lines
  THEN RAISE EXCEPTION 'Approved owned matching scope and amount required' USING ERRCODE='23514'; END IF;
  IF acceptance_id IS NOT NULL THEN
   SELECT * INTO a FROM bb_scope_acceptances WHERE id=acceptance_id AND owner_user_id=NEW.owner_user_id AND scope_quote_id=s.id;
   IF a.id IS NULL OR a.manifest IS DISTINCT FROM manifest OR (TG_TABLE_NAME='bb_m4_quotes' AND a.context<>'file_generation_batch') OR (TG_TABLE_NAME='bb_project_file_update_quotes' AND a.context<>'file_update_batch')
   THEN RAISE EXCEPTION 'Owned matching batch acceptance required' USING ERRCODE='23514'; END IF;
  ELSIF s.status<>'quoted' OR s.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'Quotation closed or expired' USING ERRCODE='23514'; END IF;
 END IF;RETURN NEW;
END $$;

-- An old executable quote cannot bypass validity by going directly to wallet reservation.
CREATE FUNCTION bb_scope_reservation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q jsonb; s bb_scope_quotations; a bb_scope_acceptances; BEGIN
 SELECT to_jsonb(x) INTO q FROM (
  SELECT id,owner_user_id,scope_quote_id,NULL::text AS scope_acceptance_id FROM bb_credit_quotes WHERE id=NEW.quote_id
  UNION ALL SELECT id,owner_user_id,scope_quote_id,scope_acceptance_id FROM bb_m4_quotes WHERE id=NEW.quote_id
  UNION ALL SELECT id,owner_user_id,scope_quote_id,NULL FROM bb_project_qa_quotes WHERE id=NEW.quote_id
  UNION ALL SELECT id,owner_user_id,scope_quote_id,NULL FROM bb_project_file_check_quotes WHERE id=NEW.quote_id
  UNION ALL SELECT id,owner_user_id,scope_quote_id,scope_acceptance_id FROM bb_project_file_update_quotes WHERE id=NEW.quote_id
  UNION ALL SELECT id,owner_user_id,scope_quote_id,NULL FROM bb_integrity_quotes WHERE id=NEW.quote_id
 ) x WHERE owner_user_id=NEW.owner_user_id;
 IF q->>'scope_quote_id' IS NOT NULL THEN
  SELECT * INTO s FROM bb_scope_quotations WHERE id=q->>'scope_quote_id' AND owner_user_id=NEW.owner_user_id FOR UPDATE;
  IF q->>'scope_acceptance_id' IS NOT NULL THEN
   SELECT * INTO a FROM bb_scope_acceptances WHERE id=q->>'scope_acceptance_id' AND owner_user_id=NEW.owner_user_id AND scope_quote_id=s.id;
   IF a.id IS NULL THEN RAISE EXCEPTION 'Batch acceptance unavailable' USING ERRCODE='23514'; END IF;
  ELSIF s.id IS NULL OR s.status<>'quoted' OR s.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'Quotation closed or expired' USING ERRCODE='23514'; END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER bb_scope_reservation_valid BEFORE INSERT ON bb_credit_reservations FOR EACH ROW EXECUTE FUNCTION bb_scope_reservation_guard();

CREATE OR REPLACE FUNCTION bb_scope_quotation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item jsonb; total bigint:=0; keys text[]:='{}'; BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Scope quotations are retained'; END IF;
 IF TG_OP='UPDATE' AND (
 ROW(NEW.id,NEW.owner_user_id,NEW.project_id,NEW.action,NEW.input_hash,NEW.snapshot,NEW.created_at,NEW.revision,NEW.previous_quote_id) IS DISTINCT FROM ROW(OLD.id,OLD.owner_user_id,OLD.project_id,OLD.action,OLD.input_hash,OLD.snapshot,OLD.created_at,OLD.revision,OLD.previous_quote_id) OR
 (OLD.published_at IS NOT NULL AND ROW(NEW.lines,NEW.amount_fen,NEW.approved_by,NEW.reason,NEW.published_at,NEW.expires_at) IS DISTINCT FROM ROW(OLD.lines,OLD.amount_fen,OLD.approved_by,OLD.reason,OLD.published_at,OLD.expires_at)) OR
 (OLD.status IN ('unavailable','declined','expired') AND NEW IS DISTINCT FROM OLD) OR
 (OLD.status='pending' AND NEW.status NOT IN ('pending','quoted','unavailable')) OR
 (OLD.status='quoted' AND NEW.status NOT IN ('quoted','declined','expired','unavailable')) OR
 (OLD.status=NEW.status AND NEW IS DISTINCT FROM OLD))
 THEN RAISE EXCEPTION 'Scope identity, published terms and terminal audit are immutable' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' AND ((NEW.previous_quote_id IS NULL AND NEW.revision<>1) OR (NEW.previous_quote_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM bb_scope_quotations old WHERE old.id=NEW.previous_quote_id AND old.owner_user_id=NEW.owner_user_id AND old.project_id=NEW.project_id AND old.action=NEW.action AND old.input_hash=NEW.input_hash AND old.snapshot=NEW.snapshot AND old.revision=NEW.revision-1 AND old.status IN ('unavailable','declined','expired'))))
 THEN RAISE EXCEPTION 'Requotation must retain the exact prior scope' USING ERRCODE='23514'; END IF;
 IF NEW.status='quoted' AND (NEW.expires_at IS NULL OR NEW.expires_at<=clock_timestamp()) THEN RAISE EXCEPTION 'Future expiry required' USING ERRCODE='23514'; END IF;
 IF NEW.published_at IS NOT NULL THEN
  FOR item IN SELECT * FROM jsonb_array_elements(NEW.lines) LOOP
   IF NOT(item ?& ARRAY['key','label','quantity','unit','unit_price_fen','amount_fen','evidence']) OR jsonb_typeof(item)<>'object'
    OR jsonb_typeof(item->'key') IS DISTINCT FROM 'string' OR jsonb_typeof(item->'label') IS DISTINCT FROM 'string' OR jsonb_typeof(item->'unit') IS DISTINCT FROM 'string'
    OR jsonb_typeof(item->'quantity') IS DISTINCT FROM 'number' OR jsonb_typeof(item->'unit_price_fen') IS DISTINCT FROM 'number' OR jsonb_typeof(item->'amount_fen') IS DISTINCT FROM 'number'
    OR length(trim(item->>'key'))=0 OR item->>'key'=ANY(keys) OR length(trim(item->>'label'))=0 OR length(trim(item->>'unit'))=0
    OR jsonb_typeof(item->'evidence') IS DISTINCT FROM 'array' OR jsonb_array_length(item->'evidence')<1
    OR (item->>'quantity') !~ '^[1-9][0-9]{0,5}$' OR (item->>'quantity')::bigint>100000
    OR (item->>'unit_price_fen') !~ '^[0-9]{1,9}$' OR (item->>'unit_price_fen')::bigint>100000000
    OR (item->>'amount_fen')::bigint<>(item->>'quantity')::bigint*(item->>'unit_price_fen')::bigint
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(item->'evidence') e WHERE jsonb_typeof(e)<>'string' OR length(trim(e#>>'{}'))=0)
   THEN RAISE EXCEPTION 'Invalid evidence-based scope line' USING ERRCODE='23514'; END IF;
   keys:=array_append(keys,item->>'key');total:=total+(item->>'amount_fen')::bigint;
  END LOOP;
  IF total<>NEW.amount_fen THEN RAISE EXCEPTION 'Scope total must equal work-item amounts' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_scope_quotation_locked BEFORE INSERT OR UPDATE OR DELETE ON bb_scope_quotations FOR EACH ROW EXECUTE FUNCTION bb_scope_quotation_guard();
