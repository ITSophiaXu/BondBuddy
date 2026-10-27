-- Register structured review reports against their complete immutable execution
-- identity. The legacy run-only registry remains unchanged; the global V1
-- execution gate is not relaxed by this independent storage boundary.
--
-- A registrar holds project -> run before inserting a report; workers also take
-- run -> job. Acquire all existing-table locks NOWAIT in parent order so an
-- in-flight legacy writer cannot wait for a parent while this migration waits
-- for its report table. No job or parent row locks are taken here. The snapshot
-- already has its six-field supporting UNIQUE from 0127, so no DDL lock upgrade
-- is needed. Pre-acquire the immutable input read lock as well, without blocking
-- normal input INSERTs.
LOCK TABLE bb_projects IN EXCLUSIVE MODE NOWAIT;
LOCK TABLE bb_input_revisions IN ACCESS SHARE MODE NOWAIT;
LOCK TABLE bb_runs IN EXCLUSIVE MODE NOWAIT;
LOCK TABLE bb_run_execution_versions IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE bb_review_execution_snapshots IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE bb_review_reports IN SHARE ROW EXCLUSIVE MODE NOWAIT;

-- This is a storage envelope, not a second ReviewReport contract. Findings,
-- coverage, cross-references, dates and evidence remain subject to the unique
-- contracts isReviewReport validator in every trusted registrar and reader.
-- In particular, evidence locators may contain arbitrary JSON numbers and
-- Unicode keys: neither jsonb::text nor 0127's numeric-excluding editor
-- canonicalizer can reproduce canonicalInputManifest for these report bodies.
CREATE FUNCTION bb_review_report_storage_shape(body jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE item jsonb; field text;
  required_keys text[] := ARRAY['report_id','project_id','run_id','input_revision','version','source_material','scope','findings','coverage','limitations','created_at'];
BEGIN
  IF jsonb_typeof(body) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  IF NOT body ?& required_keys OR body-(required_keys || ARRAY['follow_up'])<>'{}'::jsonb THEN RETURN false; END IF;
  FOREACH field IN ARRAY ARRAY['report_id','project_id','run_id'] LOOP
    IF jsonb_typeof(body->field) IS DISTINCT FROM 'string'
      OR length(body->>field) NOT BETWEEN 1 AND 160 THEN RETURN false; END IF;
  END LOOP;
  IF jsonb_typeof(body->'source_material') IS DISTINCT FROM 'object'
    OR jsonb_typeof(body->'scope') IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  IF jsonb_typeof(body->'input_revision') IS DISTINCT FROM 'number'
    OR jsonb_typeof(body->'version') IS DISTINCT FROM 'number'
    OR NOT bb_execution_material_pin_shape(body->'source_material')
    OR NOT (body->'scope') ?& ARRAY['mode','finding_ids']
    OR (body->'scope')-ARRAY['mode','finding_ids']<>'{}'::jsonb
    OR jsonb_typeof(body#>'{scope,mode}') IS DISTINCT FROM 'string'
    OR body#>>'{scope,mode}' NOT IN ('full_review','differential_review')
    OR jsonb_typeof(body#>'{scope,finding_ids}') IS DISTINCT FROM 'array'
    OR jsonb_typeof(body->'findings') IS DISTINCT FROM 'array'
    OR jsonb_typeof(body->'coverage') IS DISTINCT FROM 'array'
    OR jsonb_typeof(body->'limitations') IS DISTINCT FROM 'array'
    OR jsonb_typeof(body->'created_at') IS DISTINCT FROM 'string'
    OR body->>'created_at' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$'
    OR (body ? 'follow_up' AND jsonb_typeof(body->'follow_up') IS DISTINCT FROM 'object') THEN RETURN false; END IF;
  IF jsonb_array_length(body#>'{scope,finding_ids}')>2000
    OR jsonb_array_length(body->'findings')>10000 OR jsonb_array_length(body->'coverage')>10000
    OR jsonb_array_length(body->'limitations')>200 THEN RETURN false; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(body#>'{scope,finding_ids}') LOOP
    IF jsonb_typeof(item) IS DISTINCT FROM 'string' OR length(item #>> '{}') NOT BETWEEN 1 AND 160 THEN RETURN false; END IF;
  END LOOP;
  FOR item IN SELECT value FROM jsonb_array_elements(body->'findings') LOOP
    IF jsonb_typeof(item) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  END LOOP;
  FOR item IN SELECT value FROM jsonb_array_elements(body->'coverage') LOOP
    IF jsonb_typeof(item) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  END LOOP;
  FOR item IN SELECT value FROM jsonb_array_elements(body->'limitations') LOOP
    IF jsonb_typeof(item) IS DISTINCT FROM 'string' THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END; $$;

CREATE TABLE bb_review_execution_reports (
  id text NOT NULL UNIQUE,
  owner_user_id text NOT NULL, project_id text NOT NULL, run_id text NOT NULL,
  execution_version integer NOT NULL CHECK(execution_version>0),
  input_revision integer NOT NULL CHECK(input_revision>0),
  input_hash char(64) NOT NULL CHECK(input_hash ~ '^[a-f0-9]{64}$'),
  version integer NOT NULL CHECK(version>0),
  content_sha256 char(64) NOT NULL CHECK(content_sha256 ~ '^[a-f0-9]{64}$'),
  report jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now() CHECK(isfinite(created_at)),
  PRIMARY KEY(run_id,execution_version),
  FOREIGN KEY(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash)
    REFERENCES bb_run_execution_versions(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash),
  FOREIGN KEY(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash)
    REFERENCES bb_review_execution_snapshots(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash),
  CHECK(bb_review_report_storage_shape(report))
);
CREATE INDEX bb_review_execution_report_scope_idx
  ON bb_review_execution_reports(owner_user_id,project_id,version DESC,run_id,execution_version);

CREATE FUNCTION bb_check_review_execution_report() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE review_body jsonb; manifest jsonb; source_pin jsonb; review_version integer; operation text; task_kind text;
  review_created_at timestamptz; execution_created_at timestamptz;
BEGIN
  IF NOT bb_review_report_storage_shape(NEW.report) THEN
    RAISE EXCEPTION 'review report must preserve its storage envelope'
      USING ERRCODE='23514',CONSTRAINT='bb_review_execution_report_shape';
  END IF;
  -- Numeric identity fields compare as JSONB to trusted PostgreSQL integers;
  -- never cast arbitrary report numbers to integer or hash JSONB text here.
  IF NEW.report->>'report_id' IS DISTINCT FROM NEW.id
    OR NEW.report->>'project_id' IS DISTINCT FROM NEW.project_id
    OR NEW.report->>'run_id' IS DISTINCT FROM NEW.run_id
    OR NEW.report->'input_revision' IS DISTINCT FROM to_jsonb(NEW.input_revision)
    OR NEW.report->'version' IS DISTINCT FROM to_jsonb(NEW.version) THEN
    RAISE EXCEPTION 'review report body must match its registered identity'
      USING ERRCODE='23514',CONSTRAINT='bb_review_execution_report_identity';
  END IF;
  -- Canonical registration depends only on immutable execution/input/business
  -- origins, never on a legacy report or the current mutable run input.
  SELECT s.snapshot,s.version,s.operation,i.manifest,s.created_at,e.created_at,r.task_kind
    INTO STRICT review_body,review_version,operation,manifest,review_created_at,execution_created_at,task_kind
  FROM bb_review_execution_snapshots s
  JOIN bb_run_execution_versions e
    ON e.owner_user_id=s.owner_user_id AND e.project_id=s.project_id AND e.run_id=s.run_id
    AND e.execution_version=s.execution_version AND e.input_revision=s.input_revision AND e.input_hash=s.input_hash
  JOIN bb_input_revisions i
    ON i.owner_user_id=e.owner_user_id AND i.project_id=e.project_id AND i.revision=e.input_revision AND i.input_hash=e.input_hash
  JOIN bb_runs r ON r.owner_user_id=e.owner_user_id AND r.project_id=e.project_id AND r.id=e.run_id
  WHERE s.owner_user_id=NEW.owner_user_id AND s.project_id=NEW.project_id AND s.run_id=NEW.run_id
    AND s.execution_version=NEW.execution_version AND s.input_revision=NEW.input_revision AND s.input_hash=NEW.input_hash;
  source_pin := review_body#>'{input,source_material_ref}';
  IF task_kind IS DISTINCT FROM 'review' OR manifest#>>'{review,version}' IS DISTINCT FROM 'review_v1'
    OR manifest#>>'{review,report_id}' IS DISTINCT FROM NEW.id
    OR manifest#>'{review,version_number}' IS DISTINCT FROM to_jsonb(NEW.version)
    OR review_version IS DISTINCT FROM NEW.version OR operation NOT IN ('full_review','differential_review')
    OR manifest#>>'{review,operation}' IS DISTINCT FROM operation
    OR NEW.report#>>'{scope,mode}' IS DISTINCT FROM operation
    OR NEW.report#>'{scope,finding_ids}' IS DISTINCT FROM review_body->'finding_ids'
    OR manifest#>'{review,finding_ids}' IS DISTINCT FROM review_body->'finding_ids'
    OR manifest#>'{review,input}' IS DISTINCT FROM review_body->'input'
    OR NOT bb_execution_material_pin_shape(source_pin)
    OR source_pin IS DISTINCT FROM manifest#>'{review,input,source_material_ref}'
    OR NEW.report->'source_material' IS DISTINCT FROM source_pin
    OR NOT COALESCE(review_body#>'{input,material_versions}' @> jsonb_build_array(source_pin),false)
    OR NEW.created_at<review_created_at OR NEW.created_at<execution_created_at THEN
    RAISE EXCEPTION 'review report must preserve its exact execution review input and source pin'
      USING ERRCODE='23514',CONSTRAINT='bb_review_execution_report_origin';
  END IF;
  -- The row registration time and report body's completion timestamp have
  -- distinct meanings. Preserve both; no equality or timestamp rewriting is
  -- imposed. A report adds no permanent raw-material retention reference.
  RETURN NEW;
EXCEPTION WHEN NO_DATA_FOUND THEN
  RAISE EXCEPTION 'review report requires its exact owned execution review origin'
    USING ERRCODE='23514',CONSTRAINT='bb_review_execution_report_origin';
END; $$;
CREATE TRIGGER bb_review_execution_report_exact BEFORE INSERT ON bb_review_execution_reports
  FOR EACH ROW EXECUTE FUNCTION bb_check_review_execution_report();
CREATE TRIGGER bb_review_execution_report_immutable BEFORE UPDATE OR DELETE ON bb_review_execution_reports
  FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();

-- Retain every legacy row. Missing origin, bad storage shape/hash format or an
-- inconsistent identity aborts the entire migration instead of skipping data.
-- Copy the existing hash unchanged; a valid-looking hash is not a SQL proof of
-- the JavaScript canonical body digest. Trusted writers/readers must separately
-- require isReviewReport(body) and inputManifestHash(body)===content_sha256.
INSERT INTO bb_review_execution_reports(id,owner_user_id,project_id,run_id,execution_version,input_revision,input_hash,
  version,content_sha256,report,created_at)
SELECT legacy.id,legacy.owner_user_id,legacy.project_id,legacy.run_id,e.execution_version,e.input_revision,e.input_hash,
  legacy.version,legacy.content_sha256,legacy.report,legacy.created_at
FROM bb_review_reports legacy LEFT JOIN bb_run_execution_versions e
  ON e.owner_user_id=legacy.owner_user_id AND e.project_id=legacy.project_id AND e.run_id=legacy.run_id AND e.execution_version=1;

CREATE FUNCTION bb_bridge_review_execution_report() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE execution bb_run_execution_versions%ROWTYPE;
BEGIN
  SELECT e.* INTO STRICT execution FROM bb_run_execution_versions e
    WHERE e.owner_user_id=NEW.owner_user_id AND e.project_id=NEW.project_id AND e.run_id=NEW.run_id AND e.execution_version=1;
  INSERT INTO bb_review_execution_reports(id,owner_user_id,project_id,run_id,execution_version,input_revision,input_hash,
    version,content_sha256,report,created_at)
  VALUES(NEW.id,NEW.owner_user_id,NEW.project_id,NEW.run_id,execution.execution_version,execution.input_revision,execution.input_hash,
    NEW.version,NEW.content_sha256,NEW.report,NEW.created_at)
  ON CONFLICT(run_id,execution_version) DO NOTHING;
  -- A legacy-first insert and a canonical-first V1 mirror share one atomic
  -- transaction. Replays must match every stored value, including the complete
  -- JSONB body and original PostgreSQL microsecond timestamp. Canonical-first
  -- registrars mirror with INSERT ... SELECT, never a JavaScript Date roundtrip.
  IF NOT EXISTS(
    SELECT 1 FROM bb_review_execution_reports report
    WHERE report.id=NEW.id AND report.owner_user_id=NEW.owner_user_id AND report.project_id=NEW.project_id AND report.run_id=NEW.run_id
      AND report.execution_version=execution.execution_version
      AND report.input_revision=execution.input_revision AND report.input_hash=execution.input_hash
      AND report.version=NEW.version AND report.content_sha256::text=NEW.content_sha256::text
      AND report.report=NEW.report AND report.created_at=NEW.created_at
  ) THEN
    RAISE EXCEPTION 'legacy review report must exactly mirror its canonical V1 report'
      USING ERRCODE='23514',CONSTRAINT='bb_review_execution_report_mirror';
  END IF;
  RETURN NEW;
EXCEPTION WHEN NO_DATA_FOUND THEN
  RAISE EXCEPTION 'legacy review report requires its exact owned V1 execution origin'
    USING ERRCODE='23514',CONSTRAINT='bb_review_execution_report_origin';
END; $$;
CREATE TRIGGER bb_review_execution_report_bridge AFTER INSERT ON bb_review_reports
  FOR EACH ROW EXECUTE FUNCTION bb_bridge_review_execution_report();

-- Read-only canonical provenance. Readers retain authorization, V1 gates and
-- full contracts/hash checks. The view neither falls back to legacy reports nor
-- infers historical input from the mutable run's current revision/hash.
CREATE VIEW bb_review_execution_report_versions AS
SELECT report.*,i.manifest
FROM bb_review_execution_reports report
JOIN bb_run_execution_versions e
  ON e.owner_user_id=report.owner_user_id AND e.project_id=report.project_id AND e.run_id=report.run_id
  AND e.execution_version=report.execution_version AND e.input_revision=report.input_revision AND e.input_hash=report.input_hash
JOIN bb_review_execution_snapshots s
  ON s.owner_user_id=report.owner_user_id AND s.project_id=report.project_id AND s.run_id=report.run_id
  AND s.execution_version=report.execution_version AND s.input_revision=report.input_revision AND s.input_hash=report.input_hash
JOIN bb_input_revisions i
  ON i.owner_user_id=report.owner_user_id AND i.project_id=report.project_id AND i.revision=report.input_revision AND i.input_hash=report.input_hash
JOIN bb_runs r ON r.owner_user_id=report.owner_user_id AND r.project_id=report.project_id AND r.id=report.run_id;

COMMENT ON TABLE bb_review_execution_reports IS
  'Immutable structured reports keyed by exact execution; legacy V1 exact mirror only. Hash format and origin are SQL-checked; the unique contracts validator and JS canonical digest remain mandatory for trusted writers/readers. No successor, adoption, pricing, billing or raw-material retention authority.';
