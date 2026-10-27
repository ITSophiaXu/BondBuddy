-- Freeze each business snapshot against the same exact identity as its worker
-- lease. V1 is still the only executable version; this grants no adoption,
-- successor, quote or billing authority. Legacy rows remain unchanged.
-- M4 creation holds a topic FOR UPDATE before writing its input. Drain those
-- writers before blocking input writes, because the snapshot FK needs the same
-- topic row during backfill (SHARE ROW EXCLUSIVE would not drain row lockers).
LOCK TABLE bb_m4_topics IN EXCLUSIVE MODE;
LOCK TABLE bb_input_revisions, bb_runs, bb_run_execution_versions,
  bb_review_executions, bb_m4_executions IN SHARE ROW EXCLUSIVE MODE;

-- Storage shape checks complement the contracts schemas checked by readers.
-- They do not establish a second public input protocol.
CREATE FUNCTION bb_execution_material_pin_shape(pin jsonb, scoped boolean DEFAULT false)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(jsonb_typeof(pin)='object'
    AND jsonb_typeof(pin->'material_id')='string' AND length(pin->>'material_id') BETWEEN 1 AND 128
    AND CASE WHEN jsonb_typeof(pin->'material_version')='number'
      THEN (pin->>'material_version')::numeric>0
        AND trunc((pin->>'material_version')::numeric)=(pin->>'material_version')::numeric
      ELSE false END
    AND jsonb_typeof(pin->'sha256')='string' AND pin->>'sha256' ~ '^[a-f0-9]{64}$'
    AND (NOT scoped OR (jsonb_typeof(pin->'source_project_id')='string' AND length(pin->>'source_project_id') BETWEEN 1 AND 128))
    AND pin - CASE WHEN scoped THEN ARRAY['material_id','material_version','sha256','source_project_id']
      ELSE ARRAY['material_id','material_version','sha256'] END = '{}'::jsonb, false)
$$;

CREATE FUNCTION bb_execution_material_array_shape(pins jsonb, scoped boolean DEFAULT false)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN jsonb_typeof(pins)='array' THEN jsonb_array_length(pins)<=60
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(pins) pin WHERE NOT bb_execution_material_pin_shape(pin,scoped))
    ELSE false END
$$;

CREATE FUNCTION bb_execution_id_array_shape(ids jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN jsonb_typeof(ids)='array' THEN jsonb_array_length(ids)<=2000
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(ids) id
      WHERE jsonb_typeof(id)<>'string' OR length(id #>> '{}') NOT BETWEEN 1 AND 128)
    ELSE false END
$$;

CREATE FUNCTION bb_execution_review_input_shape(input jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(CASE WHEN jsonb_typeof(input)='object' THEN
    input - ARRAY['source_material_ref','material_versions','requirements','as_of','evidence_links']='{}'::jsonb
    AND (input->'source_material_ref'='null'::jsonb OR bb_execution_material_pin_shape(input->'source_material_ref'))
    AND bb_execution_material_array_shape(input->'material_versions')
    AND CASE WHEN jsonb_typeof(input->'requirements')='array' THEN jsonb_array_length(input->'requirements')<=100
      AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(input->'requirements') requirement
        WHERE jsonb_typeof(requirement)<>'string' OR length(requirement #>> '{}')>12000) ELSE false END
    AND (input->'as_of'='null'::jsonb OR (jsonb_typeof(input->'as_of')='string' AND input->>'as_of' ~ '^\d{4}-\d{2}-\d{2}$'))
    AND CASE WHEN NOT input ? 'evidence_links' THEN true WHEN jsonb_typeof(input->'evidence_links')='array'
      THEN jsonb_array_length(input->'evidence_links')<=2000
        AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(input->'evidence_links') link
          WHERE jsonb_typeof(link)<>'object' OR link-ARRAY['report_id','finding_id','material_ref']<>'{}'::jsonb
            OR jsonb_typeof(link->'report_id') IS DISTINCT FROM 'string' OR length(link->>'report_id') NOT BETWEEN 1 AND 128
            OR jsonb_typeof(link->'finding_id') IS DISTINCT FROM 'string' OR length(link->>'finding_id') NOT BETWEEN 1 AND 128
            OR NOT bb_execution_material_pin_shape(link->'material_ref')) ELSE false END
    ELSE false END, false)
$$;

CREATE TABLE bb_review_execution_snapshots (
  owner_user_id text NOT NULL, project_id text NOT NULL, run_id text NOT NULL,
  execution_version integer NOT NULL CHECK(execution_version>0),
  input_revision integer NOT NULL CHECK(input_revision>0),
  input_hash char(64) NOT NULL CHECK(input_hash ~ '^[a-f0-9]{64}$'),
  version integer NOT NULL CHECK(version>0),
  operation text NOT NULL CHECK(operation IN ('full_review','differential_review','revision')),
  source_report_id text, snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY(run_id,execution_version),
  FOREIGN KEY(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash)
    REFERENCES bb_run_execution_versions(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash),
  CHECK(COALESCE(jsonb_typeof(snapshot)='object' AND bb_execution_review_input_shape(snapshot->'input')
    AND bb_execution_id_array_shape(snapshot->'finding_ids')
    AND (NOT snapshot ? 'origin' OR snapshot->'origin'='null'::jsonb OR jsonb_typeof(snapshot->'origin')='object')
    AND (NOT snapshot ? 'plan' OR snapshot->'plan'='null'::jsonb OR jsonb_typeof(snapshot->'plan')='object')
    AND (NOT snapshot ? 'context_messages' OR jsonb_typeof(snapshot->'context_messages')='array'),false))
);

CREATE TABLE bb_m4_execution_snapshots (
  owner_user_id text NOT NULL, project_id text NOT NULL, run_id text NOT NULL,
  execution_version integer NOT NULL CHECK(execution_version>0),
  input_revision integer NOT NULL CHECK(input_revision>0),
  input_hash char(64) NOT NULL CHECK(input_hash ~ '^[a-f0-9]{64}$'),
  topic_id text NOT NULL, manifest jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY(run_id,execution_version),
  FOREIGN KEY(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash)
    REFERENCES bb_run_execution_versions(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash),
  FOREIGN KEY(owner_user_id,topic_id) REFERENCES bb_m4_topics(owner_user_id,id),
  CHECK(COALESCE(jsonb_typeof(manifest)='object' AND manifest->>'topic_id'=topic_id
    AND jsonb_typeof(manifest->'billing_task')='string'
    AND ((manifest->>'version'='m4-document-input-v1' AND manifest->>'kind'='document'
      AND jsonb_typeof(manifest->'input')='object'
      AND bb_execution_material_array_shape(manifest#>'{input,materials}',true)
      AND jsonb_typeof(manifest#>'{input,fields}')='object' AND jsonb_typeof(manifest#>'{input,requirements}')='array')
      OR (manifest->>'version'='m4-qa-input-v1' AND manifest->>'kind'='qa'
        AND jsonb_typeof(manifest->'content')='string' AND jsonb_typeof(manifest->'context')='object'
        AND jsonb_typeof(manifest->'context_snapshot')='object'
        AND bb_execution_material_array_shape(manifest->'materials',true))),false))
);

CREATE FUNCTION bb_check_review_execution_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE manifest jsonb; task_kind text; materials jsonb; valid boolean;
BEGIN
  SELECT i.manifest,r.task_kind INTO STRICT manifest,task_kind
  FROM bb_run_execution_versions e
  JOIN bb_runs r ON r.owner_user_id=e.owner_user_id AND r.project_id=e.project_id AND r.id=e.run_id
  JOIN bb_input_revisions i ON i.owner_user_id=e.owner_user_id AND i.project_id=e.project_id
    AND i.revision=e.input_revision AND i.input_hash=e.input_hash
  JOIN bb_review_executions legacy ON legacy.owner_user_id=e.owner_user_id AND legacy.project_id=e.project_id AND legacy.run_id=e.run_id
  WHERE e.owner_user_id=NEW.owner_user_id AND e.project_id=NEW.project_id AND e.run_id=NEW.run_id
    AND e.execution_version=NEW.execution_version AND e.input_revision=NEW.input_revision AND e.input_hash=NEW.input_hash
    AND legacy.version=NEW.version AND legacy.operation=NEW.operation
    AND legacy.source_report_id IS NOT DISTINCT FROM NEW.source_report_id
    AND legacy.snapshot=NEW.snapshot AND legacy.created_at=NEW.created_at;
  IF manifest ? 'review' THEN
    valid := jsonb_typeof(manifest->'review')='object' AND manifest#>>'{review,version}'='review_v1'
      AND manifest#>'{review,version_number}'=to_jsonb(NEW.version) AND manifest#>>'{review,operation}'=NEW.operation
      AND manifest#>>'{review,source_report_id}' IS NOT DISTINCT FROM NEW.source_report_id
      AND manifest#>'{review,input}'=NEW.snapshot->'input'
      AND manifest#>'{review,finding_ids}'=NEW.snapshot->'finding_ids'
      AND COALESCE(manifest#>'{review,origin}','null'::jsonb)=COALESCE(NEW.snapshot->'origin','null'::jsonb);
  ELSIF jsonb_typeof(manifest#>'{authoring,review_result}')='object' AND jsonb_typeof(manifest->'materials')='array' THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object('material_id',m->'material_id','material_version',m->'material_version','sha256',m->'sha256') ORDER BY ordinal),'[]'::jsonb)
      INTO materials FROM jsonb_array_elements(manifest->'materials') WITH ORDINALITY p(m,ordinal);
    valid := task_kind='update' AND NEW.operation='revision' AND manifest#>>'{authoring,version}'='unified_v1'
      AND NEW.snapshot->>'source_run_id'=manifest#>>'{authoring,review_result,run_id}'
      AND NEW.snapshot#>'{input,source_material_ref}'=manifest#>'{authoring,review_result,source_material}'
      AND NEW.snapshot#>'{input,material_versions}'=materials
      AND materials @> jsonb_build_array(manifest#>'{authoring,review_result,source_material}')
      AND NEW.snapshot#>'{input,requirements}'=CASE WHEN COALESCE(manifest#>>'{authoring,review_result,requirements}','')=''
        THEN '[]'::jsonb ELSE jsonb_build_array(manifest#>>'{authoring,review_result,requirements}') END;
  ELSE valid := false;
  END IF;
  IF NOT COALESCE(valid,false) THEN
    RAISE EXCEPTION 'review snapshot must match its exact execution input'
      USING ERRCODE='23514',CONSTRAINT='bb_review_execution_snapshot_exact';
  END IF;
  RETURN NEW;
EXCEPTION WHEN NO_DATA_FOUND THEN
  RAISE EXCEPTION 'review snapshot must preserve its owned immutable business origin'
    USING ERRCODE='23514',CONSTRAINT='bb_review_execution_snapshot_exact';
END; $$;
CREATE TRIGGER bb_review_execution_snapshot_exact BEFORE INSERT ON bb_review_execution_snapshots
  FOR EACH ROW EXECUTE FUNCTION bb_check_review_execution_snapshot();

CREATE FUNCTION bb_check_m4_execution_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(
    SELECT 1 FROM bb_run_execution_versions e
    JOIN bb_runs r ON r.owner_user_id=e.owner_user_id AND r.project_id=e.project_id AND r.id=e.run_id
    JOIN bb_input_revisions i ON i.owner_user_id=e.owner_user_id AND i.project_id=e.project_id
      AND i.revision=e.input_revision AND i.input_hash=e.input_hash
    JOIN bb_m4_executions legacy ON legacy.owner_user_id=e.owner_user_id AND legacy.run_id=e.run_id
    JOIN bb_m4_topics t ON t.owner_user_id=legacy.owner_user_id AND t.id=legacy.topic_id AND t.project_id=e.project_id
    WHERE e.owner_user_id=NEW.owner_user_id AND e.project_id=NEW.project_id AND e.run_id=NEW.run_id
      AND e.execution_version=NEW.execution_version AND e.input_revision=NEW.input_revision AND e.input_hash=NEW.input_hash
      AND legacy.topic_id=NEW.topic_id AND legacy.manifest=NEW.manifest AND legacy.input_hash=NEW.input_hash
      AND legacy.created_at=NEW.created_at AND i.manifest=NEW.manifest
      AND r.task_kind=CASE NEW.manifest->>'kind' WHEN 'document' THEN 'generation' WHEN 'qa' THEN 'qa' ELSE NULL END
  ) THEN
    RAISE EXCEPTION 'M4 snapshot must preserve its exact owned execution input and business origin'
      USING ERRCODE='23514',CONSTRAINT='bb_m4_execution_snapshot_exact';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER bb_m4_execution_snapshot_exact BEFORE INSERT ON bb_m4_execution_snapshots
  FOR EACH ROW EXECUTE FUNCTION bb_check_m4_execution_snapshot();

-- LEFT JOIN deliberately makes missing/mismatched V1 identity fail instead of
-- silently omitting an existing legacy business snapshot from the backfill.
INSERT INTO bb_review_execution_snapshots(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash,
  version,operation,source_report_id,snapshot,created_at)
SELECT b.owner_user_id,b.project_id,b.run_id,e.execution_version,e.input_revision,e.input_hash,
  b.version,b.operation,b.source_report_id,b.snapshot,b.created_at
FROM bb_review_executions b LEFT JOIN bb_run_execution_versions e
  ON e.owner_user_id=b.owner_user_id AND e.project_id=b.project_id AND e.run_id=b.run_id AND e.execution_version=1;
INSERT INTO bb_m4_execution_snapshots(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash,
  topic_id,manifest,created_at)
SELECT b.owner_user_id,t.project_id,b.run_id,e.execution_version,e.input_revision,e.input_hash,b.topic_id,b.manifest,b.created_at
FROM bb_m4_executions b LEFT JOIN bb_m4_topics t ON t.owner_user_id=b.owner_user_id AND t.id=b.topic_id
LEFT JOIN bb_run_execution_versions e ON e.owner_user_id=b.owner_user_id AND e.project_id=t.project_id AND e.run_id=b.run_id AND e.execution_version=1;

CREATE FUNCTION bb_bridge_review_execution_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE execution bb_run_execution_versions%ROWTYPE;
BEGIN
  SELECT * INTO STRICT execution FROM bb_run_execution_versions
    WHERE owner_user_id=NEW.owner_user_id AND project_id=NEW.project_id AND run_id=NEW.run_id AND execution_version=1;
  INSERT INTO bb_review_execution_snapshots(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash,
    version,operation,source_report_id,snapshot,created_at)
  VALUES(NEW.owner_user_id,NEW.project_id,NEW.run_id,execution.execution_version,execution.input_revision,execution.input_hash,
    NEW.version,NEW.operation,NEW.source_report_id,NEW.snapshot,NEW.created_at);
  RETURN NEW;
END; $$;
CREATE TRIGGER bb_review_execution_snapshot_bridge AFTER INSERT ON bb_review_executions
  FOR EACH ROW EXECUTE FUNCTION bb_bridge_review_execution_snapshot();
CREATE FUNCTION bb_bridge_m4_execution_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE execution bb_run_execution_versions%ROWTYPE;
BEGIN
  SELECT e.* INTO STRICT execution FROM bb_run_execution_versions e
    JOIN bb_m4_topics t ON t.owner_user_id=e.owner_user_id AND t.project_id=e.project_id AND t.id=NEW.topic_id
    WHERE e.owner_user_id=NEW.owner_user_id AND e.run_id=NEW.run_id AND e.execution_version=1;
  INSERT INTO bb_m4_execution_snapshots(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash,topic_id,manifest,created_at)
  VALUES(NEW.owner_user_id,execution.project_id,NEW.run_id,execution.execution_version,execution.input_revision,execution.input_hash,
    NEW.topic_id,NEW.manifest,NEW.created_at);
  RETURN NEW;
END; $$;
CREATE TRIGGER bb_m4_execution_snapshot_bridge AFTER INSERT ON bb_m4_executions
  FOR EACH ROW EXECUTE FUNCTION bb_bridge_m4_execution_snapshot();

CREATE TRIGGER bb_review_execution_snapshot_immutable BEFORE UPDATE OR DELETE ON bb_review_execution_snapshots
  FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();
CREATE TRIGGER bb_m4_execution_snapshot_immutable BEFORE UPDATE OR DELETE ON bb_m4_execution_snapshots
  FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();
