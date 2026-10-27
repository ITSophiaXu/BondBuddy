-- Freeze editor bodies against the complete immutable execution identity.
-- The legacy table and its run-only primary key remain unchanged. This storage
-- key permits later execution versions; the global V1 execution gate is intact.
--
-- Registration takes project -> run before business snapshots; workers/queue
-- take run -> job. A legacy editor INSERT can already own its table write lock
-- while waiting for a parent FK. Never wait for that descendant while holding
-- a conflicting parent lock: acquire every required lock NOWAIT in parent order
-- and let the migration transaction roll back/retry if a writer is in flight.
-- No job rows/table are read or locked here. The snapshot lock includes the
-- strength needed by ADD UNIQUE, so there is no later blocking lock upgrade.
LOCK TABLE bb_projects IN EXCLUSIVE MODE NOWAIT;
LOCK TABLE bb_runs IN EXCLUSIVE MODE NOWAIT;
LOCK TABLE bb_run_execution_versions IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE bb_review_execution_snapshots IN ACCESS EXCLUSIVE MODE NOWAIT;
LOCK TABLE bb_review_editors IN SHARE ROW EXCLUSIVE MODE NOWAIT;

ALTER TABLE bb_review_execution_snapshots
  ADD CONSTRAINT bb_review_execution_snapshot_editor_key
  UNIQUE(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash);

-- Private storage canonicalizer, matching canonicalInputManifest for this
-- schema's fixed ASCII keys, strings, booleans, arrays and nulls. Numeric JSON
-- has deliberately no representation here: review-editor-v1 has no numbers,
-- and PostgreSQL numeric formatting is not JavaScript JSON.stringify.
-- Schema validation below rejects unknown keys before this function is used.
CREATE FUNCTION bb_review_editor_canonical_json(value jsonb)
RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE kind text; result text; separator text; item record;
BEGIN
  kind := jsonb_typeof(value);
  IF kind IN ('string','boolean','null') THEN RETURN value::text; END IF;
  result := CASE kind WHEN 'object' THEN '{' WHEN 'array' THEN '[' ELSE NULL END;
  IF result IS NULL THEN
    RAISE EXCEPTION 'review editor canonical JSON excludes numeric values'
      USING ERRCODE='23514',CONSTRAINT='bb_review_editor_canonical_shape';
  END IF;
  separator := '';
  IF kind='object' THEN
    FOR item IN SELECT key, val FROM jsonb_each(value) AS entry(key,val) ORDER BY key COLLATE "C" LOOP
      IF item.key !~ '^[a-z_][a-z0-9_]*$' THEN
        RAISE EXCEPTION 'review editor canonical JSON requires fixed ASCII schema keys'
          USING ERRCODE='23514',CONSTRAINT='bb_review_editor_canonical_shape';
      END IF;
      result := result || separator || to_jsonb(item.key)::text || ':' || bb_review_editor_canonical_json(item.val);
      separator := ',';
    END LOOP;
    RETURN result || '}';
  END IF;
  FOR item IN SELECT val FROM jsonb_array_elements(value) WITH ORDINALITY AS entry(val,ordinal) ORDER BY ordinal LOOP
    result := result || separator || bb_review_editor_canonical_json(item.val);
    separator := ',';
  END LOOP;
  RETURN result || ']';
END; $$;

CREATE FUNCTION bb_review_editor_snapshot_shape(body jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE item jsonb; field text;
  top_keys text[] := ARRAY['version','source_filename','source_sha256','source_format','warnings','paragraphs','issues'];
  issue_keys text[] := ARRAY['id','decision','manual_text','category','title','original','replacement','reason','evidence','missing','uncertain','paragraph_id','applied','limitation'];
BEGIN
  IF jsonb_typeof(body) IS DISTINCT FROM 'object' OR NOT body ?& top_keys OR body-top_keys<>'{}'::jsonb THEN RETURN false; END IF;
  IF body->>'version' IS DISTINCT FROM 'review-editor-v1'
    OR jsonb_typeof(body->'source_filename') IS DISTINCT FROM 'string'
    OR jsonb_typeof(body->'source_sha256') IS DISTINCT FROM 'string' OR body->>'source_sha256' !~ '^[a-f0-9]{64}$'
    OR jsonb_typeof(body->'source_format') IS DISTINCT FROM 'string' OR body->>'source_format' NOT IN ('docx','pdf')
    OR jsonb_typeof(body->'warnings') IS DISTINCT FROM 'array'
    OR jsonb_typeof(body->'paragraphs') IS DISTINCT FROM 'array'
    OR jsonb_typeof(body->'issues') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(body->'warnings') LOOP
    IF jsonb_typeof(item) IS DISTINCT FROM 'string' THEN RETURN false; END IF;
  END LOOP;
  FOR item IN SELECT value FROM jsonb_array_elements(body->'paragraphs') LOOP
    IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR NOT item ?& ARRAY['id','text']
      OR item-ARRAY['id','text']<>'{}'::jsonb
      OR jsonb_typeof(item->'id') IS DISTINCT FROM 'string'
      OR jsonb_typeof(item->'text') IS DISTINCT FROM 'string' THEN RETURN false; END IF;
  END LOOP;
  FOR item IN SELECT value FROM jsonb_array_elements(body->'issues') LOOP
    IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR NOT item ?& issue_keys OR item-issue_keys<>'{}'::jsonb THEN RETURN false; END IF;
    FOREACH field IN ARRAY ARRAY['id','decision','manual_text','category','title','original','replacement','reason','evidence','missing','limitation'] LOOP
      IF jsonb_typeof(item->field) IS DISTINCT FROM 'string' THEN RETURN false; END IF;
    END LOOP;
    IF length(item->>'id') NOT BETWEEN 1 AND 128 OR length(item->>'manual_text')>12000
      OR item->>'decision' NOT IN ('suggested','original','manual')
      OR jsonb_typeof(item->'uncertain') IS DISTINCT FROM 'boolean'
      OR jsonb_typeof(item->'applied') IS DISTINCT FROM 'boolean'
      OR jsonb_typeof(item->'paragraph_id') NOT IN ('string','null') THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END; $$;

CREATE TABLE bb_review_execution_editors (
  owner_user_id text NOT NULL, project_id text NOT NULL, run_id text NOT NULL,
  execution_version integer NOT NULL CHECK(execution_version>0),
  input_revision integer NOT NULL CHECK(input_revision>0),
  input_hash char(64) NOT NULL CHECK(input_hash ~ '^[a-f0-9]{64}$'),
  snapshot jsonb NOT NULL,
  sha256 char(64) NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(run_id,execution_version),
  FOREIGN KEY(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash)
    REFERENCES bb_run_execution_versions(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash),
  FOREIGN KEY(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash)
    REFERENCES bb_review_execution_snapshots(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash),
  CHECK(bb_review_editor_snapshot_shape(snapshot))
);
CREATE INDEX bb_review_execution_editor_scope_idx
  ON bb_review_execution_editors(owner_user_id,project_id,run_id,execution_version);

CREATE FUNCTION bb_check_review_execution_editor() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE review_body jsonb; manifest jsonb; source_pin jsonb; manifest_pin jsonb;
  review_created_at timestamptz; execution_created_at timestamptz; source_format text;
BEGIN
  IF NOT bb_review_editor_snapshot_shape(NEW.snapshot) THEN
    RAISE EXCEPTION 'review editor body must match review-editor-v1'
      USING ERRCODE='23514',CONSTRAINT='bb_review_execution_editor_shape';
  END IF;
  IF encode(sha256(convert_to(bb_review_editor_canonical_json(NEW.snapshot),'UTF8')),'hex') IS DISTINCT FROM NEW.sha256::text THEN
    RAISE EXCEPTION 'review editor hash must match its canonical immutable body'
      USING ERRCODE='23514',CONSTRAINT='bb_review_execution_editor_hash';
  END IF;
  -- Read only immutable origin rows. In particular, do not infer a historical
  -- editor's execution from the current mutable bb_runs input or lock parent
  -- rows in a trigger running after a writer already holds its run/job lease.
  SELECT s.snapshot,i.manifest,s.created_at,e.created_at
    INTO STRICT review_body,manifest,review_created_at,execution_created_at
  FROM bb_review_execution_snapshots s
  JOIN bb_run_execution_versions e
    ON e.owner_user_id=s.owner_user_id AND e.project_id=s.project_id AND e.run_id=s.run_id
    AND e.execution_version=s.execution_version AND e.input_revision=s.input_revision AND e.input_hash=s.input_hash
  JOIN bb_input_revisions i
    ON i.owner_user_id=e.owner_user_id AND i.project_id=e.project_id AND i.revision=e.input_revision AND i.input_hash=e.input_hash
  WHERE s.owner_user_id=NEW.owner_user_id AND s.project_id=NEW.project_id AND s.run_id=NEW.run_id
    AND s.execution_version=NEW.execution_version AND s.input_revision=NEW.input_revision AND s.input_hash=NEW.input_hash;
  source_pin := review_body#>'{input,source_material_ref}';
  IF manifest#>>'{review,version}'='review_v1' THEN
    manifest_pin := manifest#>'{review,input,source_material_ref}';
  ELSIF manifest#>>'{authoring,version}'='unified_v1' THEN
    manifest_pin := manifest#>'{authoring,review_result,source_material}';
  ELSE manifest_pin := NULL;
  END IF;
  IF NOT bb_execution_material_pin_shape(source_pin) OR source_pin IS DISTINCT FROM manifest_pin
    OR NOT COALESCE(review_body#>'{input,material_versions}' @> jsonb_build_array(source_pin),false)
    OR NEW.snapshot->>'source_sha256' IS DISTINCT FROM source_pin->>'sha256'
    OR NEW.created_at<review_created_at OR NEW.created_at<execution_created_at THEN
    RAISE EXCEPTION 'review editor must preserve its exact execution source pin and creation time'
      USING ERRCODE='23514',CONSTRAINT='bb_review_execution_editor_origin';
  END IF;
  -- Validate the live source registration at insertion, with joint owner and
  -- project scope. No material FK/reference is added: an editor is not a new
  -- permanent raw-material retention pin, and normal source deletion remains
  -- governed by the existing lifecycle.
  SELECT CASE m.media_type
      WHEN 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' THEN 'docx'
      WHEN 'application/pdf' THEN 'pdf' ELSE NULL END
    INTO STRICT source_format
  FROM bb_material_versions m
  WHERE m.owner_user_id=NEW.owner_user_id AND m.project_id=NEW.project_id
    AND m.id=source_pin->>'material_id' AND m.version::numeric=(source_pin->>'material_version')::numeric
    AND m.sha256=source_pin->>'sha256';
  IF source_format IS NULL OR NEW.snapshot->>'source_format' IS DISTINCT FROM source_format THEN
    RAISE EXCEPTION 'review editor source format must match its exact owned material pin'
      USING ERRCODE='23514',CONSTRAINT='bb_review_execution_editor_source';
  END IF;
  RETURN NEW;
EXCEPTION WHEN NO_DATA_FOUND THEN
  RAISE EXCEPTION 'review editor requires its exact execution review snapshot and owned source registration'
    USING ERRCODE='23514',CONSTRAINT='bb_review_execution_editor_origin';
END; $$;
CREATE TRIGGER bb_review_execution_editor_exact BEFORE INSERT ON bb_review_execution_editors
  FOR EACH ROW EXECUTE FUNCTION bb_check_review_execution_editor();
CREATE TRIGGER bb_review_execution_editor_immutable BEFORE UPDATE OR DELETE ON bb_review_execution_editors
  FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();

-- Retain every legacy row in the SELECT: missing/mismatched origin, source,
-- schema, hash or time aborts the whole migration instead of being skipped.
INSERT INTO bb_review_execution_editors(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash,snapshot,sha256,created_at)
SELECT legacy.owner_user_id,legacy.project_id,legacy.run_id,e.execution_version,e.input_revision,e.input_hash,
  legacy.snapshot,legacy.sha256,legacy.created_at
FROM bb_review_editors legacy LEFT JOIN bb_run_execution_versions e
  ON e.owner_user_id=legacy.owner_user_id AND e.project_id=legacy.project_id AND e.run_id=legacy.run_id AND e.execution_version=1;

CREATE FUNCTION bb_bridge_review_execution_editor() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE execution bb_run_execution_versions%ROWTYPE;
BEGIN
  SELECT e.* INTO STRICT execution FROM bb_run_execution_versions e
    WHERE e.owner_user_id=NEW.owner_user_id AND e.project_id=NEW.project_id AND e.run_id=NEW.run_id AND e.execution_version=1;
  INSERT INTO bb_review_execution_editors(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash,snapshot,sha256,created_at)
    VALUES(NEW.owner_user_id,NEW.project_id,NEW.run_id,execution.execution_version,execution.input_revision,execution.input_hash,
      NEW.snapshot,NEW.sha256,NEW.created_at)
    ON CONFLICT(run_id,execution_version) DO NOTHING;
  -- Both legacy-first writers and canonical-first V1 mirrors are atomic.
  -- A conflict is an exact replay only; it never authorizes changed body,
  -- hash, creation time, owner/project or execution/input identity.
  IF NOT EXISTS(
    SELECT 1 FROM bb_review_execution_editors editor
    WHERE editor.owner_user_id=NEW.owner_user_id AND editor.project_id=NEW.project_id AND editor.run_id=NEW.run_id
      AND editor.execution_version=execution.execution_version
      AND editor.input_revision=execution.input_revision AND editor.input_hash=execution.input_hash
      AND editor.snapshot=NEW.snapshot AND editor.sha256=NEW.sha256 AND editor.created_at=NEW.created_at
  ) THEN
    RAISE EXCEPTION 'legacy review editor must exactly mirror its canonical V1 editor'
      USING ERRCODE='23514',CONSTRAINT='bb_review_execution_editor_mirror';
  END IF;
  RETURN NEW;
EXCEPTION WHEN NO_DATA_FOUND THEN
  RAISE EXCEPTION 'legacy review editor requires its exact owned V1 execution origin'
    USING ERRCODE='23514',CONSTRAINT='bb_review_execution_editor_origin';
END; $$;
CREATE TRIGGER bb_review_execution_editor_bridge AFTER INSERT ON bb_review_editors
  FOR EACH ROW EXECUTE FUNCTION bb_bridge_review_execution_editor();

COMMENT ON TABLE bb_review_execution_editors IS
  'Immutable editor bodies keyed by exact execution; legacy V1 bridge only, no successor/adoption/billing authority and no additional raw-material retention pin.';
