-- Close only the four legacy/canonical review editor/report body copies when a
-- user-deleted project reaches its configured deletion window. Live-project
-- business bodies have no terminal-run/180-day expiry. This is not complete
-- project plaintext cleanup, and old artifact-only purge receipts are not body
-- receipts. Preserve exact origin/hash/time metadata without storing plaintext.
-- Fail rather than wait behind rolling writers that hold parents in a different
-- order. Retry the migration after those writers have drained.
LOCK TABLE bb_projects IN EXCLUSIVE MODE NOWAIT;
LOCK TABLE bb_runs IN EXCLUSIVE MODE NOWAIT;
LOCK TABLE bb_jobs IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE bb_run_execution_versions IN ACCESS SHARE MODE NOWAIT;
LOCK TABLE bb_review_editors,bb_review_execution_editors,
  bb_review_reports,bb_review_execution_reports IN SHARE ROW EXCLUSIVE MODE NOWAIT;

CREATE TABLE bb_review_body_purges (
  body_kind text NOT NULL CHECK(body_kind IN ('bb_review_editors','bb_review_execution_editors',
    'bb_review_reports','bb_review_execution_reports')),
  owner_user_id text NOT NULL, project_id text NOT NULL, run_id text NOT NULL,
  execution_version integer NOT NULL CHECK(execution_version>0),
  input_revision integer NOT NULL CHECK(input_revision>0),
  input_hash char(64) NOT NULL CHECK(input_hash ~ '^[a-f0-9]{64}$'),
  body_id text NOT NULL,
  body_sha256 char(64) NOT NULL CHECK(body_sha256 ~ '^[a-f0-9]{64}$'),
  body_created_at timestamptz NOT NULL,
  report_version integer CHECK(report_version>0),
  project_deleted_at timestamptz NOT NULL CHECK(isfinite(project_deleted_at)),
  purge_window_days bigint NOT NULL CHECK(purge_window_days BETWEEN 0 AND 9007199254740991),
  policy_version text NOT NULL CHECK(length(policy_version) BETWEEN 1 AND 128),
  purged_at timestamptz NOT NULL CHECK(isfinite(purged_at)),
  PRIMARY KEY(body_kind,run_id,execution_version),
  UNIQUE(owner_user_id,project_id,run_id,execution_version,body_kind),
  FOREIGN KEY(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash)
    REFERENCES bb_run_execution_versions(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash),
  CHECK((body_kind IN ('bb_review_editors','bb_review_execution_editors') AND body_id=run_id AND report_version IS NULL)
    OR (body_kind IN ('bb_review_reports','bb_review_execution_reports') AND report_version IS NOT NULL)),
  CHECK(body_kind NOT IN ('bb_review_editors','bb_review_reports') OR execution_version=1)
);
CREATE INDEX bb_review_body_purge_scope_idx
  ON bb_review_body_purges(owner_user_id,project_id,run_id,execution_version);

-- A transaction-local service context selects one exact project and its actual
-- deletion-window policy. No client-provided future clock can make it eligible.
-- Source mutation and receipt insertion both recheck this after parent locks.
CREATE FUNCTION bb_review_body_purge_policy(p_owner text,p_project text)
RETURNS TABLE(deleted_at timestamptz,window_days bigint,policy_version text,checked_at timestamptz)
LANGUAGE plpgsql VOLATILE AS $$
DECLARE context jsonb; day_value numeric;
BEGIN
  IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN
    RAISE EXCEPTION 'review body deletion requires READ COMMITTED visibility'
      USING ERRCODE='23514',CONSTRAINT='bb_review_body_purge_isolation';
  END IF;
  BEGIN
    context:=current_setting('bb.review_body_purge',true)::jsonb;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'review body deletion requires its exact service policy context'
      USING ERRCODE='23514',CONSTRAINT='bb_review_body_purge_policy';
  END;
  IF context IS NULL OR jsonb_typeof(context) IS DISTINCT FROM 'object'
    OR context-ARRAY['version','owner_user_id','project_id','deleted_content_purge_days','policy_version']<>'{}'::jsonb
    OR jsonb_typeof(context->'version') IS DISTINCT FROM 'string'
    OR jsonb_typeof(context->'owner_user_id') IS DISTINCT FROM 'string'
    OR jsonb_typeof(context->'project_id') IS DISTINCT FROM 'string'
    OR context->>'version' IS DISTINCT FROM 'review_body_purge_v1'
    OR context->>'owner_user_id' IS DISTINCT FROM p_owner
    OR context->>'project_id' IS DISTINCT FROM p_project
    OR jsonb_typeof(context->'deleted_content_purge_days') IS DISTINCT FROM 'number'
    OR jsonb_typeof(context->'policy_version') IS DISTINCT FROM 'string'
    OR length(context->>'policy_version') NOT BETWEEN 1 AND 128 THEN
    RAISE EXCEPTION 'review body deletion requires its exact service policy context'
      USING ERRCODE='23514',CONSTRAINT='bb_review_body_purge_policy';
  END IF;
  day_value:=(context->>'deleted_content_purge_days')::numeric;
  IF day_value<0 OR day_value>9007199254740991 OR trunc(day_value)<>day_value THEN
    RAISE EXCEPTION 'review body deletion requires a safe nonnegative integer window'
      USING ERRCODE='23514',CONSTRAINT='bb_review_body_purge_policy';
  END IF;
  window_days:=day_value::bigint;
  policy_version:=context->>'policy_version';
  -- Normal service callers already own project -> run -> job locks. NOWAIT
  -- keeps an unsupported child-first direct writer from creating a lock cycle.
  BEGIN
    SELECT p.deleted_at INTO STRICT deleted_at FROM bb_projects p
      WHERE p.owner_user_id=p_owner AND p.id=p_project FOR UPDATE NOWAIT;
  EXCEPTION WHEN no_data_found OR lock_not_available THEN
    RAISE EXCEPTION 'review body deletion cannot lock its exact project scope'
      USING ERRCODE='23514',CONSTRAINT='bb_review_body_source_unavailable';
  END;
  checked_at:=clock_timestamp();
  IF deleted_at IS NULL OR NOT isfinite(deleted_at)
    OR extract(epoch FROM (checked_at-deleted_at))<window_days::numeric*86400 THEN
    RAISE EXCEPTION 'review business bodies remain until the deleted-project window is due'
      USING ERRCODE='23514',CONSTRAINT='bb_review_body_purge_policy';
  END IF;
  RETURN NEXT;
END; $$;

-- This guard precedes existing origin and mirror triggers, including an old
-- INSERT ... ON CONFLICT replay. SHARE (not KEY SHARE) conflicts with an ordinary
-- deleted_at UPDATE. A run-first old writer never waits for the parent: it fails
-- safely, so parent-first deletion cannot deadlock behind its child row/key.
CREATE FUNCTION bb_review_body_insert_live() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE project_deleted_at timestamptz; version integer;
BEGIN
  IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN
    RAISE EXCEPTION 'review body insertion requires READ COMMITTED visibility'
      USING ERRCODE='23514',CONSTRAINT='bb_review_body_purge_isolation';
  END IF;
  SELECT p.deleted_at INTO project_deleted_at FROM bb_projects p
    WHERE p.owner_user_id=NEW.owner_user_id AND p.id=NEW.project_id;
  IF NOT FOUND OR project_deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'deleted review business bodies cannot be recreated'
      USING ERRCODE='23514',CONSTRAINT='bb_review_body_source_unavailable';
  END IF;
  BEGIN
    SELECT p.deleted_at INTO STRICT project_deleted_at FROM bb_projects p
      WHERE p.owner_user_id=NEW.owner_user_id AND p.id=NEW.project_id FOR SHARE NOWAIT;
  EXCEPTION WHEN no_data_found OR lock_not_available THEN
    RAISE EXCEPTION 'review body insertion cannot lock its live project scope'
      USING ERRCODE='23514',CONSTRAINT='bb_review_body_source_unavailable';
  END;
  -- Use a fresh statement after the scope lock, rather than the first unlocked
  -- read or a stale transaction snapshot, before accepting any private body.
  SELECT p.deleted_at INTO STRICT project_deleted_at FROM bb_projects p
    WHERE p.owner_user_id=NEW.owner_user_id AND p.id=NEW.project_id;
  version:=CASE WHEN TG_TABLE_NAME IN ('bb_review_editors','bb_review_reports') THEN 1
    ELSE (to_jsonb(NEW)->>'execution_version')::integer END;
  IF project_deleted_at IS NOT NULL OR EXISTS(SELECT 1 FROM bb_review_body_purges t
    WHERE t.body_kind=TG_TABLE_NAME AND t.owner_user_id=NEW.owner_user_id AND t.project_id=NEW.project_id
      AND t.run_id=NEW.run_id AND t.execution_version=version) THEN
    RAISE EXCEPTION 'deleted review business bodies cannot be recreated'
      USING ERRCODE='23514',CONSTRAINT='bb_review_body_source_unavailable';
  END IF;
  RETURN NEW;
END; $$;

CREATE FUNCTION bb_review_body_change_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE row_metadata jsonb; version integer; origin bb_run_execution_versions%ROWTYPE;
BEGIN
  IF TG_OP IS DISTINCT FROM 'DELETE' THEN
    RAISE EXCEPTION 'review business snapshots remain immutable'
      USING ERRCODE='23514',CONSTRAINT='bb_review_body_immutable';
  END IF;
  PERFORM * FROM bb_review_body_purge_policy(OLD.owner_user_id,OLD.project_id);
  BEGIN
    PERFORM r.id FROM bb_runs r WHERE r.owner_user_id=OLD.owner_user_id
      AND r.project_id=OLD.project_id AND r.id=OLD.run_id FOR UPDATE NOWAIT;
    IF NOT FOUND THEN RAISE no_data_found; END IF;
    PERFORM j.id FROM bb_jobs j WHERE j.owner_user_id=OLD.owner_user_id AND j.run_id=OLD.run_id
      ORDER BY j.id FOR UPDATE NOWAIT;
  EXCEPTION WHEN no_data_found OR lock_not_available THEN
    RAISE EXCEPTION 'review body deletion cannot lock its exact execution scope'
      USING ERRCODE='23514',CONSTRAINT='bb_review_body_source_unavailable';
  END;
  row_metadata:=to_jsonb(OLD);
  version:=CASE WHEN TG_TABLE_NAME IN ('bb_review_editors','bb_review_reports') THEN 1
    ELSE (row_metadata->>'execution_version')::integer END;
  SELECT e.* INTO origin FROM bb_run_execution_versions e
    WHERE e.owner_user_id=OLD.owner_user_id AND e.project_id=OLD.project_id
      AND e.run_id=OLD.run_id AND e.execution_version=version;
  IF NOT FOUND OR (TG_TABLE_NAME IN ('bb_review_execution_editors','bb_review_execution_reports')
    AND (to_jsonb(origin)->'input_revision' IS DISTINCT FROM row_metadata->'input_revision'
      OR btrim(origin.input_hash::text) IS DISTINCT FROM row_metadata->>'input_hash'))
    OR EXISTS(SELECT 1 FROM bb_review_body_purges t WHERE t.body_kind=TG_TABLE_NAME
      AND t.run_id=OLD.run_id AND t.execution_version=version) THEN
    RAISE EXCEPTION 'review body deletion requires its unchanged exact execution origin'
      USING ERRCODE='23514',CONSTRAINT='bb_review_body_purge_origin';
  END IF;
  RETURN OLD;
END; $$;

-- Receipt admission is only reached by a four-table AFTER DELETE recorder,
-- after the source row has disappeared in the same transaction. Direct receipt
-- inserts are rejected, so a receipt cannot stand in for an actual deletion.
-- No deferred constraint is needed; SET CONSTRAINTS ALL IMMEDIATE is supported.
CREATE FUNCTION bb_check_review_body_purge_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE policy record; source_present boolean;
BEGIN
  IF pg_trigger_depth()<>2 OR NEW.body_kind NOT IN ('bb_review_editors','bb_review_execution_editors',
    'bb_review_reports','bb_review_execution_reports') THEN
    RAISE EXCEPTION 'review body purge receipts require their exact deletion recorder'
      USING ERRCODE='23514',CONSTRAINT='bb_review_body_purge_receipt';
  END IF;
  SELECT * INTO STRICT policy FROM bb_review_body_purge_policy(NEW.owner_user_id,NEW.project_id);
  SELECT EXISTS(
    SELECT 1 FROM bb_review_editors b WHERE NEW.body_kind='bb_review_editors' AND b.owner_user_id=NEW.owner_user_id
      AND b.project_id=NEW.project_id AND b.run_id=NEW.run_id
    UNION ALL SELECT 1 FROM bb_review_execution_editors b WHERE NEW.body_kind='bb_review_execution_editors'
      AND b.owner_user_id=NEW.owner_user_id AND b.project_id=NEW.project_id AND b.run_id=NEW.run_id
      AND b.execution_version=NEW.execution_version
    UNION ALL SELECT 1 FROM bb_review_reports b WHERE NEW.body_kind='bb_review_reports' AND b.owner_user_id=NEW.owner_user_id
      AND b.project_id=NEW.project_id AND b.run_id=NEW.run_id
    UNION ALL SELECT 1 FROM bb_review_execution_reports b WHERE NEW.body_kind='bb_review_execution_reports'
      AND b.owner_user_id=NEW.owner_user_id AND b.project_id=NEW.project_id AND b.run_id=NEW.run_id
      AND b.execution_version=NEW.execution_version
  ) INTO source_present;
  IF source_present OR NEW.project_deleted_at IS DISTINCT FROM policy.deleted_at
    OR NEW.purge_window_days IS DISTINCT FROM policy.window_days OR NEW.policy_version IS DISTINCT FROM policy.policy_version THEN
    RAISE EXCEPTION 'review body purge receipt differs from its exact deletion policy'
      USING ERRCODE='23514',CONSTRAINT='bb_review_body_purge_receipt';
  END IF;
  -- Always assign the receipt timestamp from this fresh database clock check.
  NEW.purged_at:=policy.checked_at;
  RETURN NEW;
END; $$;
CREATE TRIGGER bb_review_body_purge_receipt_exact BEFORE INSERT ON bb_review_body_purges
  FOR EACH ROW EXECUTE FUNCTION bb_check_review_body_purge_receipt();
CREATE TRIGGER bb_review_body_purge_receipt_immutable BEFORE UPDATE OR DELETE ON bb_review_body_purges
  FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();

CREATE FUNCTION bb_record_review_body_purge() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE row_metadata jsonb; version integer; origin bb_run_execution_versions%ROWTYPE; policy record;
BEGIN
  row_metadata:=to_jsonb(OLD);
  version:=CASE WHEN TG_TABLE_NAME IN ('bb_review_editors','bb_review_reports') THEN 1
    ELSE (row_metadata->>'execution_version')::integer END;
  SELECT e.* INTO STRICT origin FROM bb_run_execution_versions e
    WHERE e.owner_user_id=OLD.owner_user_id AND e.project_id=OLD.project_id
      AND e.run_id=OLD.run_id AND e.execution_version=version;
  SELECT * INTO STRICT policy FROM bb_review_body_purge_policy(OLD.owner_user_id,OLD.project_id);
  INSERT INTO bb_review_body_purges(body_kind,owner_user_id,project_id,run_id,execution_version,input_revision,input_hash,
    body_id,body_sha256,body_created_at,report_version,project_deleted_at,purge_window_days,policy_version,purged_at)
  VALUES(TG_TABLE_NAME,OLD.owner_user_id,OLD.project_id,OLD.run_id,version,origin.input_revision,origin.input_hash,
    COALESCE(row_metadata->>'id',OLD.run_id),COALESCE(row_metadata->>'sha256',row_metadata->>'content_sha256'),OLD.created_at,
    CASE WHEN TG_TABLE_NAME IN ('bb_review_reports','bb_review_execution_reports') THEN (row_metadata->>'version')::integer END,
    policy.deleted_at,policy.window_days,policy.policy_version,policy.checked_at);
  RETURN OLD;
END; $$;

-- Keep the exception narrow. The global bb_reject_snapshot_change and every
-- other immutable snapshot, origin, execution, artifact and billing guard stay.
DROP TRIGGER bb_review_editors_immutable ON bb_review_editors;
DROP TRIGGER bb_review_execution_editor_immutable ON bb_review_execution_editors;
DROP TRIGGER bb_review_report_immutable ON bb_review_reports;
DROP TRIGGER bb_review_execution_report_immutable ON bb_review_execution_reports;

CREATE TRIGGER bb_00_review_body_insert_live BEFORE INSERT ON bb_review_editors
  FOR EACH ROW EXECUTE FUNCTION bb_review_body_insert_live();
CREATE TRIGGER bb_00_review_body_insert_live BEFORE INSERT ON bb_review_execution_editors
  FOR EACH ROW EXECUTE FUNCTION bb_review_body_insert_live();
CREATE TRIGGER bb_00_review_body_insert_live BEFORE INSERT ON bb_review_reports
  FOR EACH ROW EXECUTE FUNCTION bb_review_body_insert_live();
CREATE TRIGGER bb_00_review_body_insert_live BEFORE INSERT ON bb_review_execution_reports
  FOR EACH ROW EXECUTE FUNCTION bb_review_body_insert_live();

CREATE TRIGGER bb_review_editors_immutable BEFORE UPDATE OR DELETE ON bb_review_editors
  FOR EACH ROW EXECUTE FUNCTION bb_review_body_change_guard();
CREATE TRIGGER bb_review_execution_editor_immutable BEFORE UPDATE OR DELETE ON bb_review_execution_editors
  FOR EACH ROW EXECUTE FUNCTION bb_review_body_change_guard();
CREATE TRIGGER bb_review_report_immutable BEFORE UPDATE OR DELETE ON bb_review_reports
  FOR EACH ROW EXECUTE FUNCTION bb_review_body_change_guard();
CREATE TRIGGER bb_review_execution_report_immutable BEFORE UPDATE OR DELETE ON bb_review_execution_reports
  FOR EACH ROW EXECUTE FUNCTION bb_review_body_change_guard();

CREATE TRIGGER bb_review_body_deleted AFTER DELETE ON bb_review_editors
  FOR EACH ROW EXECUTE FUNCTION bb_record_review_body_purge();
CREATE TRIGGER bb_review_body_deleted AFTER DELETE ON bb_review_execution_editors
  FOR EACH ROW EXECUTE FUNCTION bb_record_review_body_purge();
CREATE TRIGGER bb_review_body_deleted AFTER DELETE ON bb_review_reports
  FOR EACH ROW EXECUTE FUNCTION bb_record_review_body_purge();
CREATE TRIGGER bb_review_body_deleted AFTER DELETE ON bb_review_execution_reports
  FOR EACH ROW EXECUTE FUNCTION bb_record_review_body_purge();

-- TRUNCATE does not fire row DELETE triggers. It must not bypass exact body
-- receipts or erase the retained append-only metadata, including via CASCADE.
CREATE TRIGGER bb_review_body_no_truncate BEFORE TRUNCATE ON bb_review_editors
  FOR EACH STATEMENT EXECUTE FUNCTION bb_reject_snapshot_change();
CREATE TRIGGER bb_review_body_no_truncate BEFORE TRUNCATE ON bb_review_execution_editors
  FOR EACH STATEMENT EXECUTE FUNCTION bb_reject_snapshot_change();
CREATE TRIGGER bb_review_body_no_truncate BEFORE TRUNCATE ON bb_review_reports
  FOR EACH STATEMENT EXECUTE FUNCTION bb_reject_snapshot_change();
CREATE TRIGGER bb_review_body_no_truncate BEFORE TRUNCATE ON bb_review_execution_reports
  FOR EACH STATEMENT EXECUTE FUNCTION bb_reject_snapshot_change();
CREATE TRIGGER bb_review_body_purge_no_truncate BEFORE TRUNCATE ON bb_review_body_purges
  FOR EACH STATEMENT EXECUTE FUNCTION bb_reject_snapshot_change();

COMMENT ON TABLE bb_review_body_purges IS
  'Append-only exact identity/hash/time receipts for four review body tables deleted after their user-deleted project window; no plaintext, live-project expiry, full project cleanup, adoption, pricing or billing authority.';
