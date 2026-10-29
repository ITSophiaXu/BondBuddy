-- New ordinary file checks settle one independently delivered file per child.
-- Old aggregate runs and their frozen scopes retain the existing finalizer.
CREATE TABLE bb_project_file_check_batches (
 id text PRIMARY KEY,owner_user_id text NOT NULL,project_id text NOT NULL,request_id text NOT NULL,request_hash char(64) NOT NULL,
 source jsonb NOT NULL,price_version text NOT NULL REFERENCES bb_credit_price_versions(id),points bigint NOT NULL CHECK(points>=0),created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_user_id,id),UNIQUE(owner_user_id,request_id),
 FOREIGN KEY(owner_user_id,project_id) REFERENCES bb_projects(owner_user_id,id)
);
CREATE TABLE bb_project_file_check_batch_items (
 owner_user_id text NOT NULL,batch_id text NOT NULL,ordinal integer NOT NULL CHECK(ordinal>=0),file_version_id text NOT NULL,
 manifest jsonb NOT NULL,price_snapshot jsonb NOT NULL,scope_quote_id text,points bigint NOT NULL CHECK(points>=0),
 PRIMARY KEY(batch_id,ordinal),UNIQUE(batch_id,file_version_id),UNIQUE(owner_user_id,batch_id,ordinal),
 FOREIGN KEY(owner_user_id,batch_id) REFERENCES bb_project_file_check_batches(owner_user_id,id),
 FOREIGN KEY(owner_user_id,file_version_id) REFERENCES bb_project_file_versions(owner_user_id,id),
 FOREIGN KEY(owner_user_id,scope_quote_id) REFERENCES bb_scope_quotations(owner_user_id,id)
);
CREATE TABLE bb_project_file_check_attempts (
 owner_user_id text NOT NULL,batch_id text NOT NULL,ordinal integer NOT NULL,attempt integer NOT NULL CHECK(attempt>0),run_id text NOT NULL,
 PRIMARY KEY(batch_id,ordinal,attempt),UNIQUE(owner_user_id,run_id),
 FOREIGN KEY(owner_user_id,batch_id,ordinal) REFERENCES bb_project_file_check_batch_items(owner_user_id,batch_id,ordinal),
 FOREIGN KEY(owner_user_id,run_id) REFERENCES bb_runs(owner_user_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE bb_project_file_check_retries (
 owner_user_id text NOT NULL,request_id text NOT NULL,batch_id text NOT NULL,request_hash char(64) NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(owner_user_id,request_id),FOREIGN KEY(owner_user_id,batch_id) REFERENCES bb_project_file_check_batches(owner_user_id,id)
);
CREATE TRIGGER bb_project_file_check_batch_locked BEFORE UPDATE OR DELETE ON bb_project_file_check_batches FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();
CREATE TRIGGER bb_project_file_check_item_locked BEFORE UPDATE OR DELETE ON bb_project_file_check_batch_items FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();
CREATE TRIGGER bb_project_file_check_attempt_locked BEFORE UPDATE OR DELETE ON bb_project_file_check_attempts FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();
CREATE TRIGGER bb_project_file_check_retry_locked BEFORE UPDATE OR DELETE ON bb_project_file_check_retries FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();

ALTER TABLE bb_scope_acceptances DROP CONSTRAINT bb_scope_acceptances_context_check;
ALTER TABLE bb_scope_acceptances ADD CONSTRAINT bb_scope_acceptances_context_check CHECK(context IN ('file_generation_batch','file_update_batch','file_check_batch'));
CREATE OR REPLACE FUNCTION bb_scope_acceptance_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s bb_scope_quotations; item jsonb; BEGIN
 SELECT * INTO s FROM bb_scope_quotations WHERE owner_user_id=NEW.owner_user_id AND id=NEW.scope_quote_id FOR UPDATE;
 IF s.id IS NULL OR s.status<>'quoted' OR s.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'Valid quote required for acceptance' USING ERRCODE='23514'; END IF;
 IF NEW.context='file_generation_batch' THEN
  SELECT items->NEW.item_index INTO item FROM bb_project_file_batches WHERE owner_user_id=NEW.owner_user_id AND id=NEW.context_id AND state='queued';
  IF s.action<>'m4_document' THEN RAISE EXCEPTION 'Wrong batch scope action' USING ERRCODE='23514'; END IF;
 ELSIF NEW.context='file_check_batch' THEN
  SELECT to_jsonb(i) INTO item FROM bb_project_file_check_batch_items i JOIN bb_project_file_check_batches b ON b.owner_user_id=i.owner_user_id AND b.id=i.batch_id
   WHERE i.owner_user_id=NEW.owner_user_id AND i.batch_id=NEW.context_id AND i.ordinal=NEW.item_index AND b.project_id=s.project_id;
  IF s.action<>'project_file_check' THEN RAISE EXCEPTION 'Wrong batch scope action' USING ERRCODE='23514'; END IF;
 ELSE
  SELECT items->NEW.item_index INTO item FROM bb_project_file_update_batches WHERE owner_user_id=NEW.owner_user_id AND id=NEW.context_id AND state='queued';
  IF s.action<>'project_file_patch' THEN RAISE EXCEPTION 'Wrong batch scope action' USING ERRCODE='23514'; END IF;
 END IF;
 IF item IS NULL OR item->>'scope_quote_id' IS DISTINCT FROM s.id OR (item->>'points')::bigint IS DISTINCT FROM s.amount_fen OR item->'manifest' IS DISTINCT FROM NEW.manifest OR
  (CASE WHEN NEW.context='file_generation_batch' THEN s.snapshot ELSE s.snapshot->'manifest' END) IS DISTINCT FROM NEW.manifest
 THEN RAISE EXCEPTION 'Acceptance must match the persisted owned batch item and approved snapshot' USING ERRCODE='23514'; END IF;
 NEW.accepted_at:=clock_timestamp();RETURN NEW;
END $$;
ALTER TABLE bb_project_file_check_quotes ADD COLUMN scope_acceptance_id text;
ALTER TABLE bb_project_file_check_quotes ADD FOREIGN KEY(owner_user_id,scope_acceptance_id) REFERENCES bb_scope_acceptances(owner_user_id,id);

DO $$ DECLARE definition text; marker text; BEGIN
 SELECT pg_get_functiondef('bb_approved_scope_price_guard()'::regprocedure) INTO definition;
 marker:='WHEN ''bb_project_file_check_quotes'' THEN target_project:=NEW.project_id;action_name:=''project_file_check'';work_hash:=NEW.scope_work_hash;';
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'Unexpected approved scope guard'; END IF;
 definition:=replace(definition,marker,marker||'SELECT o.manifest INTO manifest FROM bb_project_file_operations o WHERE o.run_id=NEW.run_id AND o.owner_user_id=NEW.owner_user_id;');
 marker:='(TG_TABLE_NAME=''bb_project_file_update_quotes'' AND a.context<>''file_update_batch'')';
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'Unexpected accepted scope context guard'; END IF;
 EXECUTE replace(definition,marker,marker||' OR (TG_TABLE_NAME=''bb_project_file_check_quotes'' AND a.context<>''file_check_batch'')');
 SELECT pg_get_functiondef('bb_scope_reservation_guard()'::regprocedure) INTO definition;
 marker:='SELECT id,owner_user_id,scope_quote_id,NULL FROM bb_project_file_check_quotes WHERE id=NEW.quote_id';
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'Unexpected scope reservation guard'; END IF;
 EXECUTE replace(definition,marker,'SELECT id,owner_user_id,scope_quote_id,scope_acceptance_id FROM bb_project_file_check_quotes WHERE id=NEW.quote_id');
 SELECT pg_get_functiondef('bb_m3_project_run_mutex()'::regprocedure) INTO definition;
 marker:='AND NOT bb_is_workpaper_assessment(r.owner_user_id,r.project_id,r.input_revision)';
 IF strpos(definition,marker)=0 THEN RAISE EXCEPTION 'Unexpected canonical run mutex'; END IF;
 EXECUTE replace(definition,marker,marker||$guard$
 AND NOT EXISTS(SELECT 1 FROM bb_project_file_check_attempts existing JOIN bb_project_file_check_attempts incoming
  ON incoming.owner_user_id=existing.owner_user_id AND incoming.batch_id=existing.batch_id
  WHERE existing.owner_user_id=r.owner_user_id AND existing.run_id=r.id AND incoming.run_id=NEW.id)$guard$);
END $$;
