-- A label such as "one document" is not a complexity estimate. Quote the actual pinned work scope.
CREATE TABLE bb_scope_quotations (
 id text PRIMARY KEY,owner_user_id text NOT NULL,project_id text NOT NULL,
 action text NOT NULL CHECK(action ~ '^[a-z][a-z0-9_]{0,63}$'),input_hash char(64) NOT NULL,
 snapshot jsonb NOT NULL,status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','quoted')),
 lines jsonb NOT NULL DEFAULT '[]',amount_fen bigint,approved_by text,reason text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT now(),published_at timestamptz,
 UNIQUE(owner_user_id,project_id,action,input_hash),UNIQUE(owner_user_id,id),
 FOREIGN KEY(owner_user_id,project_id) REFERENCES bb_projects(owner_user_id,id),
 CHECK((status='pending' AND amount_fen IS NULL AND published_at IS NULL AND approved_by IS NULL AND lines='[]'::jsonb) OR
 (status='quoted' AND amount_fen IS NOT NULL AND amount_fen BETWEEN 1 AND 100000000 AND published_at IS NOT NULL AND approved_by IS NOT NULL AND length(trim(approved_by))>0 AND length(trim(reason))>0 AND jsonb_typeof(lines)='array' AND jsonb_array_length(lines) BETWEEN 1 AND 200))
);
CREATE FUNCTION bb_scope_quotation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item jsonb; total bigint:=0; keys text[]:='{}'; BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Scope quotations are retained'; END IF;
 IF TG_OP='UPDATE' AND (OLD.status='quoted' AND NEW IS DISTINCT FROM OLD OR
  ROW(NEW.id,NEW.owner_user_id,NEW.project_id,NEW.action,NEW.input_hash,NEW.snapshot,NEW.created_at) IS DISTINCT FROM
  ROW(OLD.id,OLD.owner_user_id,OLD.project_id,OLD.action,OLD.input_hash,OLD.snapshot,OLD.created_at))
 THEN RAISE EXCEPTION 'Scope and published price are immutable' USING ERRCODE='23514'; END IF;
 IF NEW.status='quoted' THEN
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
ALTER TABLE bb_credit_quotes ADD FOREIGN KEY(owner_user_id,scope_quote_id) REFERENCES bb_scope_quotations(owner_user_id,id);
ALTER TABLE bb_m4_quotes ADD FOREIGN KEY(owner_user_id,scope_quote_id) REFERENCES bb_scope_quotations(owner_user_id,id);
ALTER TABLE bb_project_qa_quotes ADD FOREIGN KEY(owner_user_id,scope_quote_id) REFERENCES bb_scope_quotations(owner_user_id,id);
ALTER TABLE bb_project_file_check_quotes ADD FOREIGN KEY(owner_user_id,scope_quote_id) REFERENCES bb_scope_quotations(owner_user_id,id);
ALTER TABLE bb_project_file_update_quotes ADD FOREIGN KEY(owner_user_id,scope_quote_id) REFERENCES bb_scope_quotations(owner_user_id,id);
CREATE FUNCTION bb_approved_scope_price_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s bb_scope_quotations; price bigint; target_project text; action_name text; work_hash text; input_manifest jsonb; BEGIN
 IF NEW.scope_quote_id IS NOT NULL THEN
  SELECT * INTO s FROM bb_scope_quotations WHERE id=NEW.scope_quote_id AND owner_user_id=NEW.owner_user_id;
  IF TG_TABLE_NAME='bb_m4_quotes' THEN price:=NEW.reserve_points; ELSE price:=NEW.points; END IF;
  CASE TG_TABLE_NAME
   WHEN 'bb_credit_quotes' THEN target_project:=NEW.project_id;action_name:=CASE WHEN NEW.intent_hash IS NULL THEN 'authoring' ELSE 'review' END;work_hash:=COALESCE(NEW.intent_hash,NEW.input_hash);
   WHEN 'bb_m4_quotes' THEN SELECT project_id INTO target_project FROM bb_m4_topics WHERE owner_user_id=NEW.owner_user_id AND id=NEW.topic_id;action_name:=CASE WHEN NEW.task_type LIKE 'm4_Q%' THEN 'm4_qa' ELSE 'm4_document' END;work_hash:=NEW.intent_hash;
   WHEN 'bb_project_qa_quotes' THEN SELECT project_id INTO target_project FROM bb_project_qa_runs WHERE run_id=NEW.run_id AND owner_user_id=NEW.owner_user_id;action_name:='project_qa_answer';work_hash:=NEW.scope_work_hash;
   WHEN 'bb_project_file_check_quotes' THEN target_project:=NEW.project_id;action_name:='project_file_check';work_hash:=NEW.scope_work_hash;
   WHEN 'bb_project_file_update_quotes' THEN target_project:=NEW.project_id;action_name:='project_file_patch';work_hash:=NEW.scope_work_hash;
   WHEN 'bb_integrity_quotes' THEN SELECT project_id INTO target_project FROM bb_integrity_runs WHERE run_id=NEW.run_id AND owner_user_id=NEW.owner_user_id;action_name:='integrity_round';work_hash:=NEW.scope_work_hash;
   ELSE RAISE EXCEPTION 'Unsupported scope quote family';
  END CASE;
  IF s.id IS NULL OR s.status<>'quoted' OR s.amount_fen IS DISTINCT FROM price OR s.project_id IS DISTINCT FROM target_project OR s.action IS DISTINCT FROM action_name OR s.input_hash IS DISTINCT FROM work_hash OR s.lines IS DISTINCT FROM NEW.scope_lines
  THEN RAISE EXCEPTION 'Approved owned matching scope and amount required' USING ERRCODE='23514'; END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER bb_credit_scope_price BEFORE INSERT ON bb_credit_quotes FOR EACH ROW EXECUTE FUNCTION bb_approved_scope_price_guard();
CREATE TRIGGER bb_m4_scope_price BEFORE INSERT ON bb_m4_quotes FOR EACH ROW EXECUTE FUNCTION bb_approved_scope_price_guard();
CREATE TRIGGER bb_qa_scope_price BEFORE INSERT ON bb_project_qa_quotes FOR EACH ROW EXECUTE FUNCTION bb_approved_scope_price_guard();
CREATE TRIGGER bb_file_check_scope_price BEFORE INSERT ON bb_project_file_check_quotes FOR EACH ROW EXECUTE FUNCTION bb_approved_scope_price_guard();
CREATE TRIGGER bb_file_update_scope_price BEFORE INSERT ON bb_project_file_update_quotes FOR EACH ROW EXECUTE FUNCTION bb_approved_scope_price_guard();
