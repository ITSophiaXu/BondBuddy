-- B1 quotations and explicit consent are immutable facts, not successor or
-- billing authority. Existing paid accounting and 0135/0136 gates stay intact.
-- Fail and retry after drain rather than wait while holding a partial lock set.
LOCK TABLE bb_projects IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE bb_runs IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE bb_jobs IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE bb_run_execution_heads IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE bb_run_supplement_drafts IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE bb_run_supplement_processing_plans IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE bb_material_versions IN SHARE ROW EXCLUSIVE MODE NOWAIT;

CREATE TABLE bb_run_supplement_quotes (
  id text CONSTRAINT bb_supplement_quote_pk PRIMARY KEY CONSTRAINT bb_supplement_quote_id CHECK(length(id) BETWEEN 1 AND 128),
  owner_user_id text NOT NULL,project_id text NOT NULL,run_id text NOT NULL,job_id text NOT NULL,
  kind text NOT NULL CONSTRAINT bb_supplement_quote_kind CHECK(kind IN ('authoring','review','m4')),
  source_execution_version integer NOT NULL CONSTRAINT bb_supplement_quote_source_version CHECK(source_execution_version=1),
  source_input_revision integer NOT NULL CONSTRAINT bb_supplement_quote_source_revision CHECK(source_input_revision>0),
  source_input_hash char(64) NOT NULL CONSTRAINT bb_supplement_quote_source_hash CHECK(source_input_hash ~ '^[a-f0-9]{64}$'),
  supplement_revision integer NOT NULL CONSTRAINT bb_supplement_quote_revision CHECK(supplement_revision>0),
  receipt_request_id text NOT NULL CONSTRAINT bb_supplement_quote_receipt_request CHECK(length(receipt_request_id) BETWEEN 1 AND 128),
  receipt_request_hash char(64) NOT NULL CONSTRAINT bb_supplement_quote_receipt_hash CHECK(receipt_request_hash ~ '^[a-f0-9]{64}$'),
  processing_plan_id text NOT NULL,
  processing_plan_hash char(64) NOT NULL CONSTRAINT bb_supplement_quote_plan_hash CHECK(processing_plan_hash ~ '^[a-f0-9]{64}$'),
  checkpoint_hash char(64) NOT NULL CONSTRAINT bb_supplement_quote_checkpoint_hash CHECK(checkpoint_hash ~ '^[a-f0-9]{64}$'),
  basis_hash char(64) NOT NULL CONSTRAINT bb_supplement_quote_basis_hash CHECK(basis_hash ~ '^[a-f0-9]{64}$'),
  candidate_input_hash char(64) NOT NULL CONSTRAINT bb_supplement_quote_candidate_hash CHECK(candidate_input_hash ~ '^[a-f0-9]{64}$'),
  source_quote_id text CONSTRAINT bb_supplement_quote_source_quote_id CHECK(source_quote_id IS NULL OR length(source_quote_id) BETWEEN 1 AND 128),
  pricing_rule text NOT NULL CONSTRAINT bb_supplement_quote_rule CHECK(pricing_rule='b1_full_document_v1'),
  items jsonb NOT NULL CONSTRAINT bb_supplement_quote_item_count CHECK(jsonb_typeof(items)='array' AND jsonb_array_length(items)=1),
  total_points bigint NOT NULL CONSTRAINT bb_supplement_quote_total CHECK(total_points BETWEEN 0 AND 1000000000),
  canonical_snapshot_text text NOT NULL CONSTRAINT bb_supplement_quote_snapshot_text CHECK(length(canonical_snapshot_text) BETWEEN 1 AND 131072),
  quote_hash char(64) NOT NULL CONSTRAINT bb_supplement_quote_hash CHECK(quote_hash ~ '^[a-f0-9]{64}$'),
  request_id text NOT NULL CONSTRAINT bb_supplement_quote_request_id CHECK(length(request_id) BETWEEN 1 AND 128),
  request_hash char(64) NOT NULL CONSTRAINT bb_supplement_quote_request_hash CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  valid_for_seconds smallint NOT NULL DEFAULT 300 CONSTRAINT bb_supplement_quote_ttl CHECK(valid_for_seconds BETWEEN 1 AND 300),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp() CONSTRAINT bb_supplement_quote_created_clock CHECK(isfinite(created_at)),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp() CONSTRAINT bb_supplement_quote_expiry_clock CHECK(isfinite(expires_at)),
  CONSTRAINT bb_supplement_quote_request_unique UNIQUE(owner_user_id,run_id,request_id),
  CONSTRAINT bb_supplement_quote_owned_identity UNIQUE(owner_user_id,project_id,run_id,id),
  CONSTRAINT bb_supplement_quote_run_fk FOREIGN KEY(owner_user_id,project_id,run_id) REFERENCES bb_runs(owner_user_id,project_id,id),
  CONSTRAINT bb_supplement_quote_job_fk FOREIGN KEY(owner_user_id,job_id,run_id) REFERENCES bb_jobs(owner_user_id,id,run_id),
  CONSTRAINT bb_supplement_quote_plan_fk FOREIGN KEY(owner_user_id,project_id,run_id,processing_plan_id)
    REFERENCES bb_run_supplement_processing_plans(owner_user_id,project_id,run_id,id),
  CONSTRAINT bb_supplement_quote_receipt_fk FOREIGN KEY(owner_user_id,project_id,run_id,supplement_revision)
    REFERENCES bb_run_supplement_saved_work(owner_user_id,project_id,run_id,supplement_revision),
  CONSTRAINT bb_supplement_quote_source_fk FOREIGN KEY(owner_user_id,project_id,run_id,source_execution_version,source_input_revision,source_input_hash)
    REFERENCES bb_run_execution_versions(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash)
);

-- Both INSERT paths call this VOLATILE function, so checks following lock waits
-- see current committed values at READ COMMITTED. No Blob I/O or account writes.
CREATE FUNCTION bb_assert_supplement_quote_live(q bb_run_supplement_quotes) RETURNS void LANGUAGE plpgsql VOLATILE AS $$
DECLARE r bb_runs%ROWTYPE;j bb_jobs%ROWTYPE;p bb_run_supplement_processing_plans%ROWTYPE;
  w bb_run_supplement_saved_work%ROWTYPE;d bb_run_supplement_drafts%ROWTYPE;
  reservation bb_credit_reservations%ROWTYPE;catalog bb_credit_price_versions%ROWTYPE;
  material bb_material_versions%ROWTYPE;source_project bb_projects%ROWTYPE;
  manifest jsonb;item jsonb;prior jsonb;pin jsonb;planned_pins jsonb;f jsonb;
  source_task text;expected_task text;expected_unit text;expected_schema text;
  project_to_lock text;key_to_lock bigint;fixed_run boolean;parsed_snapshot jsonb;
BEGIN
  PERFORM 1 FROM bb_projects project JOIN bb_users u ON u.id=project.owner_user_id
    WHERE project.owner_user_id=q.owner_user_id AND project.id=q.project_id
      AND project.deleted_at IS NULL AND project.archived_at IS NULL AND u.closed_at IS NULL AND u.status<>'closed'
    FOR UPDATE OF project;
  IF NOT FOUND THEN RAISE EXCEPTION 'supplement quote requires a live owned project'
    USING ERRCODE='23514',CONSTRAINT='bb_supplement_quote_origin';END IF;
  SELECT * INTO r FROM bb_runs WHERE owner_user_id=q.owner_user_id AND project_id=q.project_id AND id=q.run_id FOR UPDATE;
  SELECT * INTO j FROM bb_jobs WHERE owner_user_id=q.owner_user_id AND run_id=q.run_id AND id=q.job_id FOR UPDATE;
  SELECT * INTO p FROM bb_run_supplement_processing_plans WHERE owner_user_id=q.owner_user_id AND project_id=q.project_id
    AND run_id=q.run_id AND id=q.processing_plan_id;
  SELECT * INTO w FROM bb_run_supplement_saved_work WHERE owner_user_id=q.owner_user_id AND project_id=q.project_id
    AND run_id=q.run_id AND supplement_revision=q.supplement_revision;
  SELECT * INTO d FROM bb_run_supplement_drafts WHERE owner_user_id=q.owner_user_id AND project_id=q.project_id
    AND run_id=q.run_id AND revision=q.supplement_revision;
  SELECT i.manifest INTO manifest FROM bb_input_revisions i JOIN bb_run_execution_versions e
    ON e.owner_user_id=i.owner_user_id AND e.project_id=i.project_id AND e.input_revision=i.revision AND e.input_hash=i.input_hash
    WHERE e.owner_user_id=q.owner_user_id AND e.project_id=q.project_id AND e.run_id=q.run_id
      AND e.execution_version=q.source_execution_version AND e.input_revision=q.source_input_revision AND e.input_hash=q.source_input_hash;
  IF r.id IS NULL OR j.id IS NULL OR p.id IS NULL OR w.run_id IS NULL OR d.run_id IS NULL OR manifest IS NULL
    OR r.state<>'paused' OR j.state<>'paused' OR NOT j.user_pause_requested OR j.lease_token IS NOT NULL OR j.lease_until IS NOT NULL
    OR r.input_revision<>q.source_input_revision OR r.input_hash<>q.source_input_hash
    OR p.job_id<>q.job_id OR p.kind<>q.kind OR p.supplement_revision<>q.supplement_revision
    OR p.execution_version<>q.source_execution_version OR p.input_revision<>q.source_input_revision OR p.input_hash<>q.source_input_hash
    OR p.receipt_request_id<>q.receipt_request_id OR p.receipt_request_hash<>q.receipt_request_hash
    OR p.plan_hash<>q.processing_plan_hash OR p.checkpoint_hash<>q.checkpoint_hash OR p.basis_hash<>q.basis_hash
    OR p.candidate_input_hash<>q.candidate_input_hash
    OR p.body->>'candidateInputHash' IS DISTINCT FROM trim(q.candidate_input_hash)
    OR p.body->>'checkpointHash' IS DISTINCT FROM trim(q.checkpoint_hash)
    OR p.body->>'basisHash' IS DISTINCT FROM trim(q.basis_hash)
    OR w.job_id<>q.job_id OR w.execution_version<>q.source_execution_version
    OR w.input_revision<>q.source_input_revision OR w.input_hash<>q.source_input_hash
    OR w.checkpoint_hash<>q.checkpoint_hash OR w.source_checkpoint IS DISTINCT FROM j.checkpoint
    OR d.request_id<>q.receipt_request_id OR d.request_hash<>q.receipt_request_hash
    OR d.base_input_revision<>q.source_input_revision OR d.base_input_hash<>q.source_input_hash
    OR q.supplement_revision<>(SELECT max(revision) FROM bb_run_supplement_drafts WHERE owner_user_id=q.owner_user_id AND run_id=q.run_id)
    OR NOT EXISTS(SELECT 1 FROM bb_run_execution_heads h WHERE h.owner_user_id=q.owner_user_id AND h.project_id=q.project_id
      AND h.run_id=q.run_id AND h.execution_version=q.source_execution_version
      AND h.input_revision=q.source_input_revision AND h.input_hash=q.source_input_hash)
    OR (CASE q.kind
      WHEN 'authoring' THEN r.task_kind IN ('update','generation') AND manifest#>>'{authoring,version}'='unified_v1'
        AND NOT (manifest ? 'review') AND NOT ((manifest->'authoring') ? 'review_result') AND NOT ((manifest->'authoring') ? 'review_revision')
      WHEN 'review' THEN r.task_kind='review' AND manifest#>>'{review,operation}' IN ('full_review','differential_review')
        AND manifest#>>'{review,file_delivery,version}' IN ('review-file-v1','review-correction-v2')
      WHEN 'm4' THEN r.task_kind='generation' AND j.subtype='m4_document_v1'
        AND manifest->>'version'='m4-document-input-v1' AND manifest->>'kind'='document'
      ELSE false END) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'supplement quote requires the latest exact receipt, plan and safe source execution'
      USING ERRCODE='23514',CONSTRAINT='bb_supplement_quote_origin';
  END IF;

  fixed_run=r.billing_mode='fixed_credits' OR r.billing_mode='metered_credits' AND j.subtype IN ('m4_document_v1','m4_qa_v1');
  IF EXISTS(SELECT 1 FROM bb_model_call_attempts a LEFT JOIN bb_call_usage u ON u.attempt_id=a.id WHERE a.job_id=j.id AND (
    a.status='pending_reconcile'
    OR (a.status='failed' AND NOT (COALESCE(j.checkpoint->'operator_reconciliations','{}'::jsonb) ? a.id) AND (
      COALESCE(u.usage_status,'unknown')<>'measured' OR COALESCE(u.conflicting_measurements,0)>0
      OR EXISTS(SELECT 1 FROM bb_provider_result_refs result WHERE result.attempt_id=a.id)
      OR NOT EXISTS(SELECT 1 FROM bb_provider_call_observations o WHERE o.attempt_id=a.id AND o.outcome='failed' AND o.usage_status='measured')))
    OR (a.status='completed' AND ((NOT fixed_run AND (COALESCE(u.usage_status,'unknown')<>'measured' OR COALESCE(u.conflicting_measurements,0)>0))
      OR (SELECT count(*) FROM bb_provider_result_refs result WHERE result.attempt_id=a.id)<>1
      OR NOT EXISTS(SELECT 1 FROM bb_provider_call_observations o JOIN bb_provider_result_refs result ON result.id=o.result_id AND result.attempt_id=o.attempt_id
        WHERE o.attempt_id=a.id AND ((o.outcome='completed' AND (o.usage_status='measured' OR fixed_run))
          OR (fixed_run AND o.outcome='pending_reconcile' AND o.finish_reason='stop' AND o.error_code IN ('MODEL_USAGE_PENDING','USAGE_PENDING'))))))
  )) THEN RAISE EXCEPTION 'supplement quote requires reconciled prior calls'
    USING ERRCODE='23514',CONSTRAINT='bb_supplement_quote_prior_work';END IF;

  IF jsonb_typeof(q.items) IS DISTINCT FROM 'array' OR jsonb_array_length(q.items)<>1 THEN
    RAISE EXCEPTION 'B1 quotes one business document, never its individual delivery variants'
      USING ERRCODE='23514',CONSTRAINT='bb_supplement_quote_items';END IF;
  item=q.items->0;
  expected_unit=CASE q.kind WHEN 'authoring' THEN 'm1_word_pair' WHEN 'review' THEN 'm3_review_outputs' ELSE 'm4_document_and_note' END;
  IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR item IS DISTINCT FROM jsonb_build_object(
      'target_id',q.run_id,'document_name',item->'document_name','needs_redo',item->'needs_redo',
      'task_type',item->'task_type','price_source',item->'price_source','price_version',item->'price_version',
      'full_price_points',item->'full_price_points','points',item->'points','billing_unit',expected_unit)
    OR jsonb_typeof(item->'document_name') IS DISTINCT FROM 'string' OR length(item->>'document_name') NOT BETWEEN 1 AND 500
    OR jsonb_typeof(item->'needs_redo') IS DISTINCT FROM 'boolean'
    OR NOT (item->'task_type'='null'::jsonb OR jsonb_typeof(item->'task_type')='string')
    OR jsonb_typeof(item->'price_source') IS DISTINCT FROM 'string' OR item->>'price_source' NOT IN ('none','fixed_catalog','m4_document_fixed')
    OR NOT (item->'price_version'='null'::jsonb OR (jsonb_typeof(item->'price_version')='string' AND length(item->>'price_version') BETWEEN 1 AND 128))
    OR NOT (item->'full_price_points'='null'::jsonb OR (jsonb_typeof(item->'full_price_points')='number'
      AND (item->>'full_price_points' ~ '^[1-9][0-9]{0,9}$') AND (item->>'full_price_points')::numeric<=1000000000))
    OR jsonb_typeof(item->'points') IS DISTINCT FROM 'number' OR (item->>'points' ~ '^(0|[1-9][0-9]{0,9})$') IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'B1 item must retain its exact typed target, billing unit and price terms'
      USING ERRCODE='23514',CONSTRAINT='bb_supplement_quote_items';END IF;
  IF (item->>'points')::numeric>1000000000 OR q.total_points IS DISTINCT FROM (item->>'points')::bigint THEN
    RAISE EXCEPTION 'B1 total must equal the exact item amount'
      USING ERRCODE='23514',CONSTRAINT='bb_supplement_quote_items';END IF;

  -- Existing paid runs retain their real original quote and task classification.
  -- There is deliberately no M1 reporting-period classifier copied into SQL.
  SELECT * INTO reservation FROM bb_credit_reservations WHERE owner_user_id=q.owner_user_id AND run_id=q.run_id;
  IF r.reservation_id IS NOT NULL OR reservation.id IS NOT NULL THEN
    IF reservation.id IS NULL OR r.reservation_id IS DISTINCT FROM reservation.id OR q.source_quote_id IS DISTINCT FROM reservation.quote_id THEN
      RAISE EXCEPTION 'B1 must retain the original owned reservation quote'
        USING ERRCODE='23514',CONSTRAINT='bb_supplement_quote_source_price';END IF;
    IF q.kind='m4' THEN
      SELECT task_type INTO source_task FROM bb_m4_quotes WHERE owner_user_id=q.owner_user_id AND id=reservation.quote_id
        AND topic_id=manifest->>'topic_id' AND intent_hash=q.source_input_hash AND snapshot=manifest AND reserve_points=reservation.points;
    ELSE
      SELECT task_type INTO source_task FROM bb_credit_quotes WHERE owner_user_id=q.owner_user_id AND id=reservation.quote_id
        AND project_id=q.project_id AND points=reservation.points AND (
          (q.kind='review' AND intent_hash IS NOT NULL AND input_hash=intent_hash
            AND jsonb_typeof(manifest->'draft_revision')='number' AND input_revision::text=manifest->>'draft_revision')
          OR (q.kind='authoring' AND intent_hash IS NULL AND input_revision=q.source_input_revision AND input_hash=q.source_input_hash));
    END IF;
    IF source_task IS NULL OR (item->'needs_redo'='true'::jsonb AND item->>'task_type' IS DISTINCT FROM source_task) THEN
      RAISE EXCEPTION 'B1 task must match the original owned paid quote'
        USING ERRCODE='23514',CONSTRAINT='bb_supplement_quote_source_price';END IF;
  ELSIF q.source_quote_id IS NOT NULL THEN
    RAISE EXCEPTION 'an unreserved source cannot claim an original paid quote'
      USING ERRCODE='23514',CONSTRAINT='bb_supplement_quote_source_price';
  END IF;
  expected_task=CASE q.kind WHEN 'review' THEN manifest#>>'{review,operation}' WHEN 'm4' THEN
    CASE manifest#>>'{input,document_type}'
      WHEN 'init' THEN 'm4_G01' WHEN 'underwriter' THEN 'm4_G02' WHEN 'legal' THEN 'm4_G03' WHEN 'private_summary' THEN 'm4_G05'
      WHEN 'application' THEN 'm4_application' WHEN 'recommendation' THEN 'm4_G04' WHEN 'annual' THEN 'm4_annual' WHEN 'semiannual' THEN 'm4_semiannual'
      WHEN 'issuer' THEN 'm4_issuer' WHEN 'financial' THEN 'm4_financial' WHEN 'credit' THEN 'm4_credit' WHEN 'proceeds' THEN 'm4_proceeds' END ELSE NULL END;
  IF (item->'task_type'<>'null'::jsonb AND ((q.kind='authoring' AND item->>'task_type' NOT IN
      ('interim','annual','two_years','three_years','migration','migration_two_years','migration_three_years','new_authoring'))
      OR (q.kind IN ('review','m4') AND item->>'task_type' IS DISTINCT FROM expected_task)))
    OR (source_task IS NOT NULL AND ((q.kind='authoring' AND source_task NOT IN
      ('interim','annual','two_years','three_years','migration','migration_two_years','migration_three_years','new_authoring'))
      OR (q.kind IN ('review','m4') AND source_task IS DISTINCT FROM expected_task)))
    OR (q.kind='m4' AND (expected_task IS NULL OR manifest->>'billing_task' IS DISTINCT FROM expected_task)) THEN
    RAISE EXCEPTION 'B1 must preserve the frozen document kind and operation'
      USING ERRCODE='23514',CONSTRAINT='bb_supplement_quote_source_price';END IF;

  prior=p.body->'priorWork';
  IF p.body->>'priorWorkStatus'='no_prior_work' THEN
    IF prior IS DISTINCT FROM 'null'::jsonb OR (w.source_checkpoint->'stages') ? 'model_generation'
      OR COALESCE(w.source_checkpoint->'provider_results','[]'::jsonb)<>'[]'::jsonb
      OR EXISTS(SELECT 1 FROM bb_model_call_attempts WHERE job_id=j.id)
      OR EXISTS(SELECT 1 FROM bb_provider_result_refs WHERE job_id=j.id)
      OR EXISTS(SELECT 1 FROM bb_run_supplement_saved_results WHERE run_id=q.run_id AND supplement_revision=q.supplement_revision)
      OR EXISTS(SELECT 1 FROM bb_run_working_objects WHERE run_id=q.run_id)
      OR item->'needs_redo' IS DISTINCT FROM 'false'::jsonb OR item->>'price_source'<>'none'
      OR item->'task_type' IS DISTINCT FROM 'null'::jsonb
      OR item->'price_version' IS DISTINCT FROM 'null'::jsonb OR item->'full_price_points' IS DISTINCT FROM 'null'::jsonb OR q.total_points<>0 THEN
      RAISE EXCEPTION 'zero additional work requires genuine zero-attempt history and a free quote'
        USING ERRCODE='23514',CONSTRAINT='bb_supplement_quote_prior_work';END IF;
  ELSIF p.body->>'priorWorkStatus'='captured_complete' THEN
    expected_schema=CASE q.kind WHEN 'authoring' THEN 'codex-file-word-v1' WHEN 'review' THEN 'codex-review-file-v1' ELSE 'codex-m4-document-v1' END;
    IF NOT EXISTS(SELECT 1 FROM bb_run_supplement_saved_results captured JOIN bb_provider_result_refs result
      ON result.id=captured.result_id AND result.attempt_id=captured.attempt_id
      JOIN bb_model_call_attempts a ON a.id=result.attempt_id AND a.job_id=result.job_id AND a.status='completed'
      WHERE captured.owner_user_id=q.owner_user_id AND captured.project_id=q.project_id AND captured.run_id=q.run_id
        AND captured.supplement_revision=q.supplement_revision AND result.id=prior#>>'{source,resultId}'
        AND result.job_id=j.id AND result.result_schema_version=expected_schema AND trim(result.result_sha256)=prior->>'resultHash'
        AND NOT EXISTS(SELECT 1 FROM bb_log_content_tombstones t WHERE (t.content_kind='provider_result' AND t.content_id=result.id)
          OR (t.content_kind='prompt_snapshot' AND t.content_id=result.prompt_snapshot_ref)))
      OR item->'needs_redo' IS DISTINCT FROM 'true'::jsonb OR jsonb_typeof(item->'task_type') IS DISTINCT FROM 'string'
      OR jsonb_typeof(item->'full_price_points') IS DISTINCT FROM 'number' OR q.total_points=0
      OR item->'points' IS DISTINCT FROM item->'full_price_points' THEN
      RAISE EXCEPTION 'captured work requires its exact retained result and a full-document rework price'
        USING ERRCODE='23514',CONSTRAINT='bb_supplement_quote_prior_work';END IF;
    FOR f IN SELECT value FROM jsonb_array_elements(prior->'files') LOOP
      IF EXISTS(SELECT 1 FROM bb_run_working_objects o LEFT JOIN bb_run_working_object_state s ON s.object_key=o.object_key
        WHERE o.object_key=f->>'key' AND (o.owner_user_id<>q.owner_user_id OR o.project_id<>q.project_id OR o.run_id<>q.run_id
          OR trim(o.sha256) IS DISTINCT FROM f->>'sha256' OR o.byte_size<>(f->>'byteSize')::bigint
          OR o.media_type IS DISTINCT FROM f->>'mediaType' OR o.filename IS DISTINCT FROM f->>'name'
          OR s.stored_at IS NULL OR s.purge_started_at IS NOT NULL OR s.purged_at IS NOT NULL)) THEN
        RAISE EXCEPTION 'captured rework files are unavailable'
          USING ERRCODE='23514',CONSTRAINT='bb_supplement_quote_prior_work';END IF;
    END LOOP;
    IF q.kind='m4' THEN
      IF item->>'price_source' IS DISTINCT FROM 'm4_document_fixed' OR item->>'price_version' IS DISTINCT FROM 'm4-document-fixed-20261008-v1' OR q.total_points<>4500 THEN
        RAISE EXCEPTION 'M4 rework requires the current whole document and note price'
          USING ERRCODE='23514',CONSTRAINT='bb_supplement_quote_current_price';END IF;
    ELSE
      PERFORM pg_advisory_xact_lock_shared(hashtextextended('bb-fixed-prices',0));
      SELECT * INTO catalog FROM bb_credit_price_versions WHERE effective_at<=clock_timestamp() ORDER BY effective_at DESC,id DESC LIMIT 1;
      IF catalog.id IS NULL OR item->>'price_source'<>'fixed_catalog' OR item->>'price_version' IS DISTINCT FROM catalog.id
        OR catalog.prices->(item->>'task_type') IS DISTINCT FROM item->'full_price_points' THEN
        RAISE EXCEPTION 'B1 rework requires the current immutable whole-document catalog price'
          USING ERRCODE='23514',CONSTRAINT='bb_supplement_quote_current_price';END IF;
    END IF;
  ELSE RAISE EXCEPTION 'B1 requires an explicit verified prior-work status'
    USING ERRCODE='23514',CONSTRAINT='bb_supplement_quote_prior_work';END IF;

  -- Quotes retain no bytes. Lock the complete candidate set only until this
  -- transaction commits, coordinating with both purge starts and soft deletion.
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'material lifecycle coordination requires READ COMMITTED isolation'
    USING ERRCODE='23514',CONSTRAINT='bb_supplement_quote_material_isolation';END IF;
  SELECT COALESCE(jsonb_agg(CASE WHEN q.kind='authoring' THEN value||jsonb_build_object('source_project_id',q.project_id) ELSE value END),'[]'::jsonb)
    INTO planned_pins FROM jsonb_array_elements(p.body->'materials');
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(planned_pins) refs(value) WHERE (value->>'material_version')::numeric>2147483647) THEN
    RAISE EXCEPTION 'candidate material version exceeds storage range'
      USING ERRCODE='23514',CONSTRAINT='bb_supplement_quote_materials';END IF;
  FOR key_to_lock IN SELECT DISTINCT lifecycle_key FROM (
    SELECT lifecycle_key FROM bb_material_lifecycle_input_keys(q.owner_user_id,q.project_id,q.source_input_revision)
    UNION ALL SELECT bb_material_lifecycle_lock_key(q.owner_user_id,value->>'source_project_id',value->>'material_id',(value->>'material_version')::integer)
      FROM jsonb_array_elements(planned_pins)) keys ORDER BY lifecycle_key LOOP
    PERFORM pg_advisory_xact_lock(key_to_lock);
  END LOOP;
  FOR project_to_lock IN SELECT DISTINCT value->>'source_project_id' FROM jsonb_array_elements(planned_pins) ORDER BY 1 LOOP
    SELECT * INTO source_project FROM bb_projects WHERE owner_user_id=q.owner_user_id AND id=project_to_lock FOR SHARE NOWAIT;
    IF source_project.id IS NULL OR source_project.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'candidate source project is unavailable'
      USING ERRCODE='23514',CONSTRAINT='bb_supplement_quote_materials';END IF;
  END LOOP;
  FOR pin IN SELECT value FROM jsonb_array_elements(planned_pins) ORDER BY value->>'source_project_id',value->>'material_id',(value->>'material_version')::integer LOOP
    SELECT * INTO material FROM bb_material_versions WHERE owner_user_id=q.owner_user_id AND project_id=pin->>'source_project_id'
      AND id=pin->>'material_id' AND version=(pin->>'material_version')::integer FOR SHARE NOWAIT;
    IF material.id IS NULL OR material.deleted_at IS NOT NULL OR trim(material.sha256) IS DISTINCT FROM pin->>'sha256'
      OR material.role IS DISTINCT FROM pin->>'role'
      OR EXISTS(SELECT 1 FROM bb_storage_tombstones t WHERE t.owner_user_id=q.owner_user_id AND t.project_id=material.project_id
        AND t.object_kind='material' AND t.material_id=material.id AND t.material_version=material.version
        AND (t.state='purged' OR EXISTS(SELECT 1 FROM bb_storage_purge_starts s WHERE s.tombstone_id=t.id))) THEN
      RAISE EXCEPTION 'candidate material identity or byte availability changed'
        USING ERRCODE='23514',CONSTRAINT='bb_supplement_quote_materials';END IF;
  END LOOP;

  BEGIN parsed_snapshot=q.canonical_snapshot_text::jsonb;
  EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'invalid B1 snapshot JSON'
    USING ERRCODE='23514',CONSTRAINT='bb_supplement_quote_snapshot';END;
  IF parsed_snapshot IS DISTINCT FROM jsonb_build_object(
      'version','run-supplement-rework-b1-v1','pricing_rule',q.pricing_rule,
      'owner_user_id',q.owner_user_id,'project_id',q.project_id,'run_id',q.run_id,'job_id',q.job_id,'kind',q.kind,
      'source_execution_version',q.source_execution_version,'source_input_revision',q.source_input_revision,'source_input_hash',trim(q.source_input_hash),
      'supplement_revision',q.supplement_revision,'receipt_request_id',q.receipt_request_id,'receipt_request_hash',trim(q.receipt_request_hash),
      'processing_plan_id',q.processing_plan_id,'processing_plan_hash',trim(q.processing_plan_hash),'checkpoint_hash',trim(q.checkpoint_hash),
      'basis_hash',trim(q.basis_hash),'candidate_input_hash',trim(q.candidate_input_hash),'source_quote_id',q.source_quote_id,
      'items',q.items,'total_points',q.total_points)
    OR encode(sha256(convert_to(q.canonical_snapshot_text,'UTF8')),'hex') IS DISTINCT FROM trim(q.quote_hash) THEN
    RAISE EXCEPTION 'B1 snapshot and hash must match the exact quoted scope and amount'
      USING ERRCODE='23514',CONSTRAINT='bb_supplement_quote_snapshot';END IF;
  IF q.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'B1 quote expired; obtain and confirm a fresh quotation'
    USING ERRCODE='23514',CONSTRAINT='bb_supplement_quote_expired';END IF;
END;$$;

CREATE FUNCTION bb_check_supplement_quote() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.created_at=clock_timestamp();
  NEW.expires_at=NEW.created_at+make_interval(secs=>NEW.valid_for_seconds);
  PERFORM bb_assert_supplement_quote_live(NEW);
  RETURN NEW;
END;$$;
CREATE TRIGGER bb_supplement_quote_exact BEFORE INSERT ON bb_run_supplement_quotes
  FOR EACH ROW EXECUTE FUNCTION bb_check_supplement_quote();
CREATE FUNCTION bb_reject_supplement_quote_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'supplement quote and confirmation history is append only'
  USING ERRCODE='23514',CONSTRAINT='bb_supplement_quote_immutable';END;$$;
CREATE TRIGGER bb_supplement_quote_immutable BEFORE UPDATE OR DELETE ON bb_run_supplement_quotes
  FOR EACH ROW EXECUTE FUNCTION bb_reject_supplement_quote_change();
CREATE TRIGGER bb_supplement_quote_no_truncate BEFORE TRUNCATE ON bb_run_supplement_quotes
  FOR EACH STATEMENT EXECUTE FUNCTION bb_reject_supplement_quote_change();

CREATE TABLE bb_run_supplement_quote_confirmations (
  id text CONSTRAINT bb_supplement_quote_confirmation_pk PRIMARY KEY CONSTRAINT bb_supplement_quote_confirmation_id CHECK(length(id) BETWEEN 1 AND 128),
  owner_user_id text NOT NULL,project_id text NOT NULL,run_id text NOT NULL,quote_id text NOT NULL,
  quote_hash char(64) NOT NULL CONSTRAINT bb_supplement_quote_confirmation_hash CHECK(quote_hash ~ '^[a-f0-9]{64}$'),
  total_points bigint NOT NULL CONSTRAINT bb_supplement_quote_confirmation_total CHECK(total_points BETWEEN 0 AND 1000000000),
  request_id text NOT NULL CONSTRAINT bb_supplement_quote_confirmation_request_id CHECK(length(request_id) BETWEEN 1 AND 128),
  request_hash char(64) NOT NULL CONSTRAINT bb_supplement_quote_confirmation_request_hash CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  confirmed_by text NOT NULL CONSTRAINT bb_supplement_quote_confirmation_actor CHECK(confirmed_by=owner_user_id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp() CONSTRAINT bb_supplement_quote_confirmation_clock CHECK(isfinite(created_at)),
  CONSTRAINT bb_supplement_quote_confirmation_quote_unique UNIQUE(quote_id),
  CONSTRAINT bb_supplement_quote_confirmation_request_unique UNIQUE(owner_user_id,run_id,request_id),
  CONSTRAINT bb_supplement_quote_confirmation_quote_fk FOREIGN KEY(owner_user_id,project_id,run_id,quote_id)
    REFERENCES bb_run_supplement_quotes(owner_user_id,project_id,run_id,id)
);
CREATE FUNCTION bb_check_supplement_quote_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q bb_run_supplement_quotes%ROWTYPE;
BEGIN
  SELECT * INTO q FROM bb_run_supplement_quotes WHERE id=NEW.quote_id AND owner_user_id=NEW.owner_user_id
    AND project_id=NEW.project_id AND run_id=NEW.run_id;
  IF q.id IS NULL OR NEW.confirmed_by IS DISTINCT FROM NEW.owner_user_id OR q.quote_hash IS DISTINCT FROM NEW.quote_hash
    OR q.total_points IS DISTINCT FROM NEW.total_points THEN RAISE EXCEPTION 'confirmation must accept the exact owned B1 quotation'
    USING ERRCODE='23514',CONSTRAINT='bb_supplement_quote_confirmation_exact';END IF;
  PERFORM bb_assert_supplement_quote_live(q);
  NEW.created_at=clock_timestamp();
  IF q.expires_at<=NEW.created_at THEN RAISE EXCEPTION 'B1 quote expired before confirmation'
    USING ERRCODE='23514',CONSTRAINT='bb_supplement_quote_expired';END IF;
  RETURN NEW;
END;$$;
CREATE TRIGGER bb_supplement_quote_confirmation_exact BEFORE INSERT ON bb_run_supplement_quote_confirmations
  FOR EACH ROW EXECUTE FUNCTION bb_check_supplement_quote_confirmation();
CREATE TRIGGER bb_supplement_quote_confirmation_immutable BEFORE UPDATE OR DELETE ON bb_run_supplement_quote_confirmations
  FOR EACH ROW EXECUTE FUNCTION bb_reject_supplement_quote_change();
CREATE TRIGGER bb_supplement_quote_confirmation_no_truncate BEFORE TRUNCATE ON bb_run_supplement_quote_confirmations
  FOR EACH STATEMENT EXECUTE FUNCTION bb_reject_supplement_quote_change();

COMMENT ON TABLE bb_run_supplement_quotes IS
  'Immutable latest-receipt B1 quote only. No material retention, candidate input allocation, successor execution, reservation, charge or download authority. TTL is trusted internal metadata.';
COMMENT ON TABLE bb_run_supplement_quote_confirmations IS
  'Immutable user acceptance of exact B1 scope and amount. Not payment, reservation, successor adoption or execution authority; existing paid gates remain closed.';
