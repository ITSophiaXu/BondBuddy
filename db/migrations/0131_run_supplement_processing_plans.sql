-- Durable internal continuation recipes. These rows intentionally grant no
-- material retention, download, execution, successor-input or billing authority.
CREATE TABLE bb_run_supplement_processing_plans (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  owner_user_id text NOT NULL,
  project_id text NOT NULL,
  run_id text NOT NULL,
  supplement_revision integer NOT NULL CHECK (supplement_revision > 0),
  job_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('authoring','review','m4')),
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  receipt_request_id text NOT NULL,
  receipt_request_hash char(64) NOT NULL CHECK (receipt_request_hash ~ '^[a-f0-9]{64}$'),
  execution_version integer NOT NULL CHECK (execution_version=1),
  input_revision integer NOT NULL CHECK (input_revision > 0),
  input_hash char(64) NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  checkpoint_hash char(64) NOT NULL CHECK (checkpoint_hash ~ '^[a-f0-9]{64}$'),
  candidate_input_hash char(64) NOT NULL CHECK (candidate_input_hash ~ '^[a-f0-9]{64}$'),
  basis_hash char(64) NOT NULL CHECK (basis_hash ~ '^[a-f0-9]{64}$'),
  plan_hash char(64) NOT NULL CHECK (plan_hash ~ '^[a-f0-9]{64}$'),
  body jsonb NOT NULL CHECK (jsonb_typeof(body)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_user_id,run_id,request_id),
  UNIQUE(owner_user_id,project_id,run_id,id),
  FOREIGN KEY(owner_user_id,project_id,run_id) REFERENCES bb_runs(owner_user_id,project_id,id),
  FOREIGN KEY(owner_user_id,job_id,run_id) REFERENCES bb_jobs(owner_user_id,id,run_id),
  FOREIGN KEY(owner_user_id,project_id,run_id,supplement_revision)
    REFERENCES bb_run_supplement_saved_work(owner_user_id,project_id,run_id,supplement_revision),
  FOREIGN KEY(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash)
    REFERENCES bb_run_execution_versions(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash)
);

CREATE FUNCTION bb_supplement_processing_material_pin_valid(pin jsonb, scoped boolean) RETURNS boolean
  LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(jsonb_typeof(pin)='object' AND pin=jsonb_build_object(
    'material_id',pin->'material_id','material_version',pin->'material_version','role',pin->'role','sha256',pin->'sha256')
      || CASE WHEN scoped THEN jsonb_build_object('source_project_id',pin->'source_project_id') ELSE '{}'::jsonb END
    AND jsonb_typeof(pin->'material_id')='string' AND length(pin->>'material_id') BETWEEN 1 AND 160
    AND jsonb_typeof(pin->'material_version')='number' AND pin->>'material_version' ~ '^[1-9][0-9]*$'
    AND jsonb_typeof(pin->'role')='string' AND length(pin->>'role') BETWEEN 1 AND 64
    AND jsonb_typeof(pin->'sha256')='string' AND pin->>'sha256' ~ '^[a-f0-9]{64}$'
    AND (NOT scoped OR (jsonb_typeof(pin->'source_project_id')='string' AND length(pin->>'source_project_id') BETWEEN 1 AND 160)),false)
$$;

CREATE FUNCTION bb_check_supplement_processing_plan() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r bb_runs%ROWTYPE; j bb_jobs%ROWTYPE; w bb_run_supplement_saved_work%ROWTYPE;
  d bb_run_supplement_drafts%ROWTYPE; manifest jsonb; prior jsonb; f jsonb; expected_schema text;
BEGIN
  -- Keep the same project -> run -> job order as the service writer. No content
  -- locks or Blob I/O occur in this transaction.
  PERFORM 1 FROM bb_projects p JOIN bb_users u ON u.id=p.owner_user_id
    WHERE p.owner_user_id=NEW.owner_user_id AND p.id=NEW.project_id
      AND p.deleted_at IS NULL AND p.archived_at IS NULL AND u.closed_at IS NULL AND u.status<>'closed'
    FOR UPDATE OF p;
  IF NOT FOUND THEN RAISE EXCEPTION 'processing plan project is unavailable'
    USING ERRCODE='23514',CONSTRAINT='bb_supplement_processing_plan_origin'; END IF;
  SELECT * INTO r FROM bb_runs WHERE owner_user_id=NEW.owner_user_id AND project_id=NEW.project_id AND id=NEW.run_id FOR UPDATE;
  SELECT * INTO j FROM bb_jobs WHERE owner_user_id=NEW.owner_user_id AND run_id=NEW.run_id AND id=NEW.job_id FOR UPDATE;
  SELECT * INTO w FROM bb_run_supplement_saved_work WHERE owner_user_id=NEW.owner_user_id AND project_id=NEW.project_id
    AND run_id=NEW.run_id AND supplement_revision=NEW.supplement_revision;
  SELECT * INTO d FROM bb_run_supplement_drafts WHERE owner_user_id=NEW.owner_user_id AND project_id=NEW.project_id
    AND run_id=NEW.run_id AND revision=NEW.supplement_revision;
  SELECT i.manifest INTO manifest FROM bb_input_revisions i JOIN bb_run_execution_versions e
    ON e.owner_user_id=i.owner_user_id AND e.project_id=i.project_id AND e.input_revision=i.revision AND e.input_hash=i.input_hash
    WHERE e.owner_user_id=NEW.owner_user_id AND e.project_id=NEW.project_id AND e.run_id=NEW.run_id
      AND e.execution_version=NEW.execution_version AND e.input_revision=NEW.input_revision AND e.input_hash=NEW.input_hash;
  IF r.id IS NULL OR j.id IS NULL OR w.run_id IS NULL OR d.run_id IS NULL OR manifest IS NULL
    OR r.state<>'paused' OR j.state<>'paused' OR NOT j.user_pause_requested
    OR j.lease_token IS NOT NULL OR j.lease_until IS NOT NULL
    OR r.input_revision<>NEW.input_revision OR r.input_hash<>NEW.input_hash
    OR w.job_id<>NEW.job_id OR w.execution_version<>NEW.execution_version
    OR w.input_revision<>NEW.input_revision OR w.input_hash<>NEW.input_hash
    OR w.checkpoint_hash<>NEW.checkpoint_hash OR w.source_checkpoint<>j.checkpoint
    OR d.request_id<>NEW.receipt_request_id OR d.request_hash<>NEW.receipt_request_hash
    OR d.base_input_revision<>NEW.input_revision OR d.base_input_hash<>NEW.input_hash
    OR EXISTS(SELECT 1 FROM bb_model_call_attempts WHERE job_id=j.id AND status='pending_reconcile')
    OR (CASE NEW.kind
      WHEN 'authoring' THEN r.task_kind IN ('update','generation') AND manifest->'authoring'->>'version'='unified_v1'
        AND NOT (manifest ? 'review') AND NOT ((manifest->'authoring') ? 'review_result') AND NOT ((manifest->'authoring') ? 'review_revision')
      WHEN 'review' THEN r.task_kind='review' AND manifest->'review'->>'operation' IN ('full_review','differential_review')
        AND manifest->'review'->'file_delivery'->>'version' IN ('review-file-v1','review-correction-v2')
      WHEN 'm4' THEN r.task_kind='generation' AND j.subtype='m4_document_v1'
        AND manifest->>'version'='m4-document-input-v1' AND manifest->>'kind'='document'
      ELSE false END) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'processing plan must match the exact safe receipt and execution'
      USING ERRCODE='23514',CONSTRAINT='bb_supplement_processing_plan_origin';
  END IF;
  prior=NEW.body->'priorWork';
  -- Reconstruct every top-level field. No manifest, user text, prompt, report
  -- body or caller-selected executable recipe belongs in this table.
  IF NEW.body IS DISTINCT FROM jsonb_build_object(
    'version','run-supplement-processing-plan-v1','kind',NEW.kind,'owner',NEW.owner_user_id,
    'projectId',NEW.project_id,'runId',NEW.run_id,'revision',NEW.supplement_revision,'requestId',NEW.request_id,
    'receipt',jsonb_build_object('requestId',NEW.receipt_request_id,'requestHash',trim(NEW.receipt_request_hash)),
    'sourceExecution',jsonb_build_object('executionVersion',NEW.execution_version,'inputRevision',NEW.input_revision,'inputHash',trim(NEW.input_hash)),
    'checkpointHash',trim(NEW.checkpoint_hash),'candidateInputHash',trim(NEW.candidate_input_hash),'basisHash',trim(NEW.basis_hash),
    'materials',NEW.body->'materials','delta',NEW.body->'delta','priorWorkStatus',NEW.body->'priorWorkStatus','priorWork',prior,
    'recipe',jsonb_build_object('version','supplement-conservative-full-review-v1','candidateScope','all_candidate_materials',
      'previousWork',CASE WHEN prior='null'::jsonb THEN 'none'
        WHEN NEW.kind='authoring' AND NEW.body->'delta'->'discardPreviousOutput'='false'::jsonb THEN 'saved_clean_editing_baseline'
        ELSE 'source_reference_only' END,
      'retainedClaims','recheck_against_complete_candidate','operationScope','preserve_frozen_operation_and_selected_findings',
      'unsavedScratch','unavailable'))
    OR jsonb_typeof(NEW.body->'materials') IS DISTINCT FROM 'array'
    OR jsonb_array_length(NEW.body->'materials')>240
    OR jsonb_typeof(NEW.body->'delta') IS DISTINCT FROM 'object'
    OR NEW.body->'delta' IS DISTINCT FROM jsonb_build_object('additions',NEW.body->'delta'->'additions',
      'replacements',NEW.body->'delta'->'replacements','unchanged',NEW.body->'delta'->'unchanged',
      'discardPreviousOutput',NEW.body->'delta'->'discardPreviousOutput')
    OR jsonb_typeof(NEW.body->'delta'->'additions') IS DISTINCT FROM 'array'
    OR jsonb_typeof(NEW.body->'delta'->'replacements') IS DISTINCT FROM 'array'
    OR jsonb_typeof(NEW.body->'delta'->'unchanged') IS DISTINCT FROM 'array'
    OR jsonb_typeof(NEW.body->'delta'->'discardPreviousOutput') IS DISTINCT FROM 'boolean' THEN
    RAISE EXCEPTION 'processing plan requires the fixed conservative recipe'
      USING ERRCODE='23514',CONSTRAINT='bb_supplement_processing_plan_recipe';
  END IF;
  FOR f IN SELECT value FROM jsonb_array_elements(NEW.body->'materials') LOOP
    IF NOT bb_supplement_processing_material_pin_valid(f,NEW.kind<>'authoring') THEN
      RAISE EXCEPTION 'processing plan contains an invalid candidate material pin'
        USING ERRCODE='23514',CONSTRAINT='bb_supplement_processing_plan_recipe';
    END IF;
  END LOOP;
  FOR f IN SELECT value FROM jsonb_array_elements(NEW.body->'delta'->'additions')
    UNION ALL SELECT value FROM jsonb_array_elements(NEW.body->'delta'->'unchanged') LOOP
    IF NOT bb_supplement_processing_material_pin_valid(f,true) THEN
      RAISE EXCEPTION 'processing plan contains an invalid material delta pin'
        USING ERRCODE='23514',CONSTRAINT='bb_supplement_processing_plan_recipe';
    END IF;
  END LOOP;
  FOR f IN SELECT value FROM jsonb_array_elements(NEW.body->'delta'->'replacements') LOOP
    IF f IS DISTINCT FROM jsonb_build_object('previous',f->'previous','current',f->'current')
      OR NOT bb_supplement_processing_material_pin_valid(f->'previous',true)
      OR NOT bb_supplement_processing_material_pin_valid(f->'current',true) THEN
      RAISE EXCEPTION 'processing plan contains an invalid replacement pair'
        USING ERRCODE='23514',CONSTRAINT='bb_supplement_processing_plan_recipe';
    END IF;
  END LOOP;
  IF NEW.body->>'priorWorkStatus'='no_prior_work' THEN
    IF prior IS DISTINCT FROM 'null'::jsonb OR (w.source_checkpoint->'stages') ? 'model_generation'
      OR COALESCE(w.source_checkpoint->'provider_results','[]'::jsonb)<>'[]'::jsonb
      OR EXISTS(SELECT 1 FROM bb_model_call_attempts WHERE job_id=j.id)
      OR EXISTS(SELECT 1 FROM bb_provider_result_refs WHERE job_id=j.id)
      OR EXISTS(SELECT 1 FROM bb_run_supplement_saved_results WHERE run_id=NEW.run_id AND supplement_revision=NEW.supplement_revision)
      OR EXISTS(SELECT 1 FROM bb_run_working_objects WHERE run_id=NEW.run_id) THEN
      RAISE EXCEPTION 'absence of prior work must be proven, not inferred from missing content'
        USING ERRCODE='23514',CONSTRAINT='bb_supplement_processing_plan_prior_work';
    END IF;
  ELSIF NEW.body->>'priorWorkStatus'='captured_complete' THEN
    expected_schema=CASE NEW.kind WHEN 'authoring' THEN 'codex-file-word-v1' WHEN 'review' THEN 'codex-review-file-v1' ELSE 'codex-m4-document-v1' END;
    IF jsonb_typeof(prior) IS DISTINCT FROM 'object'
      OR prior IS DISTINCT FROM jsonb_build_object('source',prior->'source','resultHash',prior->'resultHash','files',prior->'files','metadata',prior->'metadata')
      OR jsonb_typeof(prior->'files') IS DISTINCT FROM 'array' OR jsonb_array_length(prior->'files') NOT BETWEEN 1 AND 9
      OR prior->'source' IS DISTINCT FROM jsonb_build_object('kind','provider_result','resultId',prior->'source'->>'resultId','resultSchemaVersion',expected_schema)
      OR NOT EXISTS(SELECT 1 FROM bb_run_supplement_saved_results c JOIN bb_provider_result_refs p ON p.id=c.result_id AND p.attempt_id=c.attempt_id
        JOIN bb_model_call_attempts a ON a.id=p.attempt_id AND a.job_id=p.job_id AND a.status='completed'
        WHERE c.owner_user_id=NEW.owner_user_id AND c.project_id=NEW.project_id AND c.run_id=NEW.run_id
          AND c.supplement_revision=NEW.supplement_revision AND p.id=prior->'source'->>'resultId'
          AND p.job_id=j.id AND p.result_schema_version=expected_schema AND trim(p.result_sha256)=prior->>'resultHash'
          AND NOT EXISTS(SELECT 1 FROM bb_log_content_tombstones t WHERE (t.content_kind='provider_result' AND t.content_id=p.id)
            OR (t.content_kind='prompt_snapshot' AND t.content_id=p.prompt_snapshot_ref)))
      OR prior->'metadata' IS DISTINCT FROM (CASE WHEN NEW.kind='m4' THEN jsonb_build_object(
        'method_hash',prior->'metadata'->>'method_hash','skill_sha256',w.source_checkpoint->'stages'->'m4_document_method'->>'skill_sha256') ELSE '{}'::jsonb END)
      OR (NEW.kind='m4' AND (jsonb_typeof(prior->'metadata'->'method_hash') IS DISTINCT FROM 'string'
        OR (prior->'metadata'->>'method_hash' ~ '^[a-f0-9]{64}$') IS DISTINCT FROM true
        OR jsonb_typeof(prior->'metadata'->'skill_sha256') IS DISTINCT FROM 'string'
        OR (prior->'metadata'->>'skill_sha256' ~ '^[a-f0-9]{64}$') IS DISTINCT FROM true)) THEN
      RAISE EXCEPTION 'processing plan prior work must be captured by its exact receipt'
        USING ERRCODE='23514',CONSTRAINT='bb_supplement_processing_plan_prior_work';
    END IF;
    FOR f IN SELECT value FROM jsonb_array_elements(prior->'files') LOOP
      IF jsonb_typeof(f) IS DISTINCT FROM 'object' OR f IS DISTINCT FROM jsonb_build_object(
        'version','captured-supplement-file-v1','owner',NEW.owner_user_id,'projectId',NEW.project_id,'runId',NEW.run_id,
        'revision',NEW.supplement_revision,'executionVersion',NEW.execution_version,'inputRevision',NEW.input_revision,
        'inputHash',trim(NEW.input_hash),'checkpointHash',trim(NEW.checkpoint_hash),'sourceHash',prior->>'resultHash',
        'source',prior->'source','name',f->'name','key',f->'key','sha256',f->'sha256','byteSize',f->'byteSize','mediaType',f->'mediaType')
        OR jsonb_typeof(f->'sha256') IS DISTINCT FROM 'string' OR (f->>'sha256' ~ '^[a-f0-9]{64}$') IS DISTINCT FROM true
        OR jsonb_typeof(f->'name') IS DISTINCT FROM 'string' OR length(f->>'name') NOT BETWEEN 1 AND 160
        OR jsonb_typeof(f->'key') IS DISTINCT FROM 'string' OR length(f->>'key') NOT BETWEEN 1 AND 2048
        OR jsonb_typeof(f->'mediaType') IS DISTINCT FROM 'string' OR length(f->>'mediaType') NOT BETWEEN 1 AND 255
        OR jsonb_typeof(f->'byteSize') IS DISTINCT FROM 'number'
        OR (f->>'byteSize' ~ '^[1-9][0-9]{0,8}$') IS DISTINCT FROM true
        OR (f->>'byteSize')::numeric>104857600 THEN
        RAISE EXCEPTION 'processing plan files must retain exact captured provenance'
          USING ERRCODE='23514',CONSTRAINT='bb_supplement_processing_plan_prior_work';
      END IF;
    END LOOP;
  ELSE
    RAISE EXCEPTION 'processing plan requires an explicit prior work status'
      USING ERRCODE='23514',CONSTRAINT='bb_supplement_processing_plan_prior_work';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER bb_supplement_processing_plan_origin BEFORE INSERT ON bb_run_supplement_processing_plans
  FOR EACH ROW EXECUTE FUNCTION bb_check_supplement_processing_plan();
CREATE TRIGGER bb_supplement_processing_plan_immutable BEFORE UPDATE OR DELETE ON bb_run_supplement_processing_plans
  FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();
COMMENT ON TABLE bb_run_supplement_processing_plans IS
  'Private immutable provenance and conservative preparation recipe. Not accepted input, retention pin, download, execution, quote, reservation or charge authority.';
