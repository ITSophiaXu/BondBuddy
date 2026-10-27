-- Catalogue-driven workpapers reuse M4 runs, delivery, private artifacts and credit policy.
CREATE TABLE bb_workpaper_catalogues (
 id text PRIMARY KEY,owner_user_id text NOT NULL,project_id text NOT NULL,request_id text NOT NULL,request_hash char(64) NOT NULL,
 material jsonb NOT NULL,filename text NOT NULL,entries jsonb NOT NULL,warnings jsonb NOT NULL,sha256 char(64) NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(owner_user_id,id),UNIQUE(owner_user_id,request_id),
 FOREIGN KEY(owner_user_id,project_id) REFERENCES bb_projects(owner_user_id,id)
);
CREATE TRIGGER bb_workpaper_catalogue_immutable BEFORE UPDATE OR DELETE ON bb_workpaper_catalogues FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();
CREATE TABLE bb_workpaper_batches (
 id text PRIMARY KEY,owner_user_id text NOT NULL,project_id text NOT NULL,topic_id text NOT NULL,catalogue_id text NOT NULL,
 request_id text NOT NULL,request_hash char(64) NOT NULL,source jsonb NOT NULL,
 state text NOT NULL CHECK(state IN ('queued','running','paused','complete','partial','cancelled')),
 revision integer NOT NULL DEFAULT 1,total_points bigint NOT NULL,price_version text NOT NULL,error text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_user_id,id),UNIQUE(owner_user_id,request_id),
 FOREIGN KEY(owner_user_id,project_id) REFERENCES bb_projects(owner_user_id,id),
 FOREIGN KEY(owner_user_id,topic_id) REFERENCES bb_m4_topics(owner_user_id,id),
 FOREIGN KEY(owner_user_id,catalogue_id) REFERENCES bb_workpaper_catalogues(owner_user_id,id)
);
CREATE INDEX bb_workpaper_batches_pending ON bb_workpaper_batches(updated_at,id) WHERE state IN ('queued','running');
CREATE TABLE bb_workpaper_items (
 owner_user_id text NOT NULL,batch_id text NOT NULL,item_id text NOT NULL,ordinal integer NOT NULL,manifest jsonb NOT NULL,
 run_id text,attempt integer NOT NULL DEFAULT 1,error text,state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','succeeded','failed')),
 PRIMARY KEY(batch_id,item_id),UNIQUE(batch_id,ordinal),UNIQUE(run_id),
 FOREIGN KEY(owner_user_id,batch_id) REFERENCES bb_workpaper_batches(owner_user_id,id),
 FOREIGN KEY(owner_user_id,run_id) REFERENCES bb_runs(owner_user_id,id)
);
CREATE TABLE bb_workpaper_attempts (
 owner_user_id text NOT NULL,batch_id text NOT NULL,item_id text NOT NULL,attempt integer NOT NULL,run_id text NOT NULL UNIQUE,
 PRIMARY KEY(batch_id,item_id,attempt),FOREIGN KEY(batch_id,item_id) REFERENCES bb_workpaper_items(batch_id,item_id),
 FOREIGN KEY(owner_user_id,run_id) REFERENCES bb_runs(owner_user_id,id)
);
CREATE TRIGGER bb_workpaper_attempts_immutable BEFORE UPDATE OR DELETE ON bb_workpaper_attempts FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();
CREATE FUNCTION bb_workpaper_snapshot_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='bb_workpaper_items' THEN
  IF ROW(NEW.owner_user_id,NEW.batch_id,NEW.item_id,NEW.ordinal,NEW.manifest) IS DISTINCT FROM ROW(OLD.owner_user_id,OLD.batch_id,OLD.item_id,OLD.ordinal,OLD.manifest)
  THEN RAISE EXCEPTION 'Workpaper item input is immutable' USING ERRCODE='23514'; END IF;
 ELSE
  IF ROW(NEW.id,NEW.owner_user_id,NEW.project_id,NEW.topic_id,NEW.catalogue_id,NEW.request_id,NEW.request_hash,NEW.source,NEW.total_points,NEW.price_version)
  IS DISTINCT FROM ROW(OLD.id,OLD.owner_user_id,OLD.project_id,OLD.topic_id,OLD.catalogue_id,OLD.request_id,OLD.request_hash,OLD.source,OLD.total_points,OLD.price_version)
  THEN RAISE EXCEPTION 'Workpaper batch input is immutable' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_workpaper_item_guard BEFORE UPDATE ON bb_workpaper_items FOR EACH ROW EXECUTE FUNCTION bb_workpaper_snapshot_guard();
CREATE TRIGGER bb_workpaper_batch_guard BEFORE UPDATE ON bb_workpaper_batches FOR EACH ROW EXECUTE FUNCTION bb_workpaper_snapshot_guard();
DO $$ DECLARE tab text;col text;definition text;
BEGIN
 FOREACH tab IN ARRAY ARRAY['bb_m4_templates','bb_m4_drafts','bb_m4_artifacts','bb_m4_pending_requirements'] LOOP
  col:=CASE WHEN tab='bb_m4_pending_requirements' THEN 'consumed_document_type' ELSE 'document_type' END;
  SELECT pg_get_constraintdef(oid) INTO definition FROM pg_constraint WHERE conrelid=tab::regclass AND conname=tab||'_'||col||'_check';
  EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I',tab,tab||'_'||col||'_check');
  EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I %s',tab,tab||'_'||col||'_check',replace(definition,'''proceeds''','''workpaper''::text, ''proceeds'''));
 END LOOP;
 FOREACH tab IN ARRAY ARRAY['bb_m4_fixed_quote_terms','bb_m4_dynamic_document_policy'] LOOP
  SELECT pg_get_constraintdef(oid) INTO definition FROM pg_constraint WHERE conrelid='bb_m4_quotes'::regclass AND conname=tab;
  EXECUTE format('ALTER TABLE bb_m4_quotes DROP CONSTRAINT %I',tab);
  EXECUTE format('ALTER TABLE bb_m4_quotes ADD CONSTRAINT %I %s',tab,replace(definition,'''m4_proceeds''','''m4_workpaper''::text, ''m4_proceeds'''));
 END LOOP;
 SELECT pg_get_functiondef('bb_m4_credit_finalize_run()'::regprocedure) INTO definition;
 IF strpos(definition,'''m4_proceeds''')=0 THEN RAISE EXCEPTION 'Unexpected M4 finalizer'; END IF;
 EXECUTE replace(definition,'''m4_proceeds''','''m4_proceeds'',''m4_workpaper''');
END $$;
