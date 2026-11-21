-- Opt-in physical phases; provider permits retain their independent 4/8 node gate.
ALTER TABLE bb_execution_capacity_policy
 ADD COLUMN workflow_slots_enabled boolean NOT NULL DEFAULT false,
 ADD COLUMN authoring_slots integer NOT NULL DEFAULT 1 CHECK(authoring_slots BETWEEN 1 AND 2),
 ADD COLUMN postprocess_slots integer NOT NULL DEFAULT 1 CHECK(postprocess_slots BETWEEN 1 AND 2),
 ADD COLUMN expansion_budget_review_sha256 char(64);
ALTER TABLE bb_execution_capacity_policy DROP CONSTRAINT bb_execution_capacity_policy_max_nodes_check;
ALTER TABLE bb_execution_capacity_policy ADD CONSTRAINT bb_execution_capacity_policy_max_nodes_check CHECK(max_nodes BETWEEN 1 AND 64),
 ADD CONSTRAINT bb_execution_capacity_policy_max_nodes_budget_check CHECK(max_nodes<=2 OR COALESCE(expansion_budget_review_sha256 ~ '^[a-f0-9]{64}$',false)),
 ADD CONSTRAINT bb_execution_workflow_managed CHECK(NOT workflow_slots_enabled OR managed_nodes);
ALTER TABLE bb_execution_node_sessions ADD COLUMN workflow_protocol_version integer NOT NULL DEFAULT 0 CHECK(workflow_protocol_version IN (0,1));
ALTER TABLE bb_jobs ADD COLUMN execution_admission_phase text CHECK(execution_admission_phase IN ('legacy','authoring','postprocess'));
UPDATE bb_jobs SET execution_admission_phase='legacy' WHERE lease_token IS NOT NULL AND execution_node_id IS NOT NULL;
CREATE FUNCTION bb_workflow_run_eligible(p_job text) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM bb_jobs j JOIN bb_runs r ON r.id=j.run_id JOIN bb_input_revisions i
  ON i.project_id=r.project_id AND i.owner_user_id=r.owner_user_id AND i.revision=r.input_revision
  WHERE j.id=p_job AND j.job_type IN ('generation','update') AND j.subtype IN ('default','update_pipeline_v1')
   AND r.task_kind IN ('generation','update') AND i.manifest#>>'{authoring,version}'='unified_v1'
   AND NOT COALESCE(i.manifest->'authoring','{}'::jsonb) ? 'review_revision')
$$;

-- The only preparation-time model call is the journaled outline. It must be a
-- measured completed result tied to the immutable context and prompt snapshot.
CREATE FUNCTION bb_workflow_preparation_calls_safe(p_job text,p_checkpoint jsonb) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM bb_model_call_attempts WHERE job_id=p_job)
  THEN NOT p_checkpoint ? 'provider_results'
  ELSE EXISTS(SELECT 1 FROM bb_jobs j JOIN bb_runs r ON r.id=j.run_id
   JOIN bb_model_call_attempts a ON a.job_id=j.id AND (p_checkpoint#>>'{stages,workflow_outline_v1,attempt_id}' IS NULL OR a.id=p_checkpoint#>>'{stages,workflow_outline_v1,attempt_id}')
   JOIN bb_call_usage u ON u.attempt_id=a.id
   JOIN bb_provider_result_refs p ON p.attempt_id=a.id AND p.result_schema_version='workflow-outline-v1'
   WHERE j.id=p_job AND a.status='completed' AND u.usage_status='measured' AND u.conflicting_measurements=0
    AND COALESCE(p_checkpoint#>>'{stages,workflow_outline_v1,context_hash}',p_checkpoint#>>'{stages,chapter_context_v1,material_snapshot_hash}') ~ '^[a-f0-9]{64}$'
    AND (p_checkpoint#>>'{stages,workflow_outline_v1,logical_call_id}' IS NULL OR a.logical_call_id=p_checkpoint#>>'{stages,workflow_outline_v1,logical_call_id}')
    AND a.logical_call_id=encode(sha256(convert_to(replace(jsonb_build_array(r.id,trim(r.input_hash),COALESCE(p_checkpoint#>>'{stages,workflow_outline_v1,context_hash}',p_checkpoint#>>'{stages,chapter_context_v1,material_snapshot_hash}'),'outline-v1')::text,', ',','),'UTF8')),'hex')
    AND a.prompt_snapshot_id=p_checkpoint#>>'{stages,workflow_outline_prompt,snapshot_id}'
    AND a.attempt_no=(SELECT max(attempt_no) FROM bb_model_call_attempts WHERE job_id=j.id AND logical_call_id=a.logical_call_id)
    AND NOT EXISTS(SELECT 1 FROM bb_model_call_attempts other LEFT JOIN bb_call_usage usage ON usage.attempt_id=other.id
     WHERE other.job_id=j.id AND (other.logical_call_id<>a.logical_call_id OR other.status NOT IN ('completed','failed','confirmed_not_sent')
      OR other.status<>'confirmed_not_sent' AND (usage.usage_status IS DISTINCT FROM 'measured' OR usage.conflicting_measurements<>0)))
    AND jsonb_typeof(p_checkpoint->'provider_results')='array'
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_checkpoint->'provider_results') ref WHERE ref->>'logical_call_id' IS DISTINCT FROM a.logical_call_id
     OR NOT EXISTS(SELECT 1 FROM bb_provider_result_refs stored WHERE stored.id=ref->>'result_id' AND stored.attempt_id=ref->>'call_id'
      AND stored.job_id=j.id AND stored.logical_call_id=a.logical_call_id AND stored.result_ref=ref->>'result_ref' AND trim(stored.result_sha256)=ref->>'result_sha256'))
    AND EXISTS(SELECT 1 FROM jsonb_array_elements(p_checkpoint->'provider_results') ref WHERE ref->>'result_id'=p.id)) END
$$;

CREATE OR REPLACE FUNCTION bb_execution_claim_context() RETURNS bb_execution_nodes LANGUAGE plpgsql AS $$
DECLARE n bb_execution_nodes;s bb_execution_node_sessions;node_key text;session_key uuid;epoch_key uuid;p bb_execution_capacity_policy;occupied integer;phase text;
BEGIN
 SELECT * INTO p FROM bb_execution_capacity_policy WHERE singleton FOR SHARE;
 node_key:=NULLIF(current_setting('bb.execution_node_id',true),'');
 IF node_key IS NULL THEN
  IF p.managed_nodes THEN RAISE EXCEPTION 'Execution node admission required' USING ERRCODE='55000'; END IF;
  RETURN NULL;
 END IF;
 epoch_key:=NULLIF(current_setting('bb.execution_node_epoch',true),'')::uuid;
 session_key:=NULLIF(current_setting('bb.execution_session_id',true),'')::uuid;
 SELECT * INTO n FROM bb_execution_nodes WHERE id=node_key FOR UPDATE;
 SELECT * INTO s FROM bb_execution_node_sessions WHERE session_id=session_key AND node_id=node_key AND epoch=epoch_key;
 IF NOT p.budget_available THEN RAISE EXCEPTION 'Execution admission budget unavailable' USING ERRCODE='55000'; END IF;
 IF n.id IS NULL OR n.epoch IS DISTINCT FROM epoch_key OR n.state<>'ready' OR s.state IS DISTINCT FROM 'active'
  OR s.ready IS DISTINCT FROM true OR s.heartbeat_at<=clock_timestamp()-interval '30 seconds'
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(n.expected_services) svc WHERE svc->>'service_id'=s.service_id)
  THEN RAISE EXCEPTION 'Execution node not ready' USING ERRCODE='55000'; END IF;
 phase:=NULLIF(current_setting('bb.execution_workflow_phase',true),'');
 IF phase IS NOT NULL THEN
  IF phase NOT IN ('authoring','postprocess') OR NOT p.workflow_slots_enabled OR s.workflow_protocol_version<>1
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(n.expected_services) svc WHERE svc->>'service_id'=s.service_id
    AND svc->>'workflow_protocol_version'='1' AND svc->'capabilities' ? phase)
   THEN RAISE EXCEPTION 'Execution workflow phase capability mismatch' USING ERRCODE='55000'; END IF;
  -- A legacy native lease conservatively consumes either reserved phase until drained.
  SELECT (SELECT count(*) FROM bb_jobs WHERE execution_node_id=n.id AND lease_token IS NOT NULL
   AND (execution_admission_phase=phase OR execution_admission_phase='legacy'))
   +(SELECT count(*) FROM bb_review_messages WHERE execution_node_id=n.id AND lease_token IS NOT NULL) INTO occupied;
  IF occupied>=(CASE phase WHEN 'authoring' THEN p.authoring_slots ELSE p.postprocess_slots END)
   THEN RAISE EXCEPTION 'Execution node phase claim slots full' USING ERRCODE='55000'; END IF;
 ELSE
  SELECT (SELECT count(*) FROM bb_jobs WHERE execution_node_id=n.id AND lease_token IS NOT NULL)
   +(SELECT count(*) FROM bb_review_messages WHERE execution_node_id=n.id AND lease_token IS NOT NULL) INTO occupied;
  IF occupied>=p.node_model_limit THEN RAISE EXCEPTION 'Execution node claim slots full' USING ERRCODE='55000'; END IF;
 END IF;
 RETURN n;
END $$;

CREATE OR REPLACE FUNCTION bb_execution_guard_claim() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n bb_execution_nodes;capability text;phase text;
BEGIN
 IF NEW.lease_token IS NULL OR (TG_OP='UPDATE' AND NEW.lease_token IS NOT DISTINCT FROM OLD.lease_token) THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME='bb_jobs' THEN IF NEW.job_type='parse' THEN RETURN NEW; END IF; END IF;
 IF TG_OP='UPDATE' AND OLD.execution_node_id IS NOT NULL AND OLD.lease_token IS NOT NULL
  THEN RAISE EXCEPTION 'Owned node lease requires positive process recovery' USING ERRCODE='55000'; END IF;
 phase:=NULLIF(current_setting('bb.execution_workflow_phase',true),'');
 IF TG_TABLE_NAME='bb_jobs' THEN
  IF NEW.checkpoint ? 'workflow_v1' AND (phase IS NULL OR NEW.checkpoint#>>'{workflow_v1,protocol_version}'<>'1'
   OR phase IS DISTINCT FROM NEW.checkpoint#>>'{workflow_v1,phase}')
   THEN RAISE EXCEPTION 'Execution workflow phase mismatch' USING ERRCODE='55000'; END IF;
  IF NEW.checkpoint ? 'workflow_admission_v1' AND (phase IS DISTINCT FROM 'authoring' AND NOT NEW.checkpoint ? 'workflow_v1')
   THEN RAISE EXCEPTION 'Execution preparation phase mismatch' USING ERRCODE='55000'; END IF;
  IF phase IS NULL AND TG_OP='UPDATE' AND OLD.attempts=0 AND NOT OLD.checkpoint ? 'workflow_v1'
   AND bb_workflow_run_eligible(NEW.id) AND (SELECT workflow_slots_enabled FROM bb_execution_capacity_policy WHERE singleton)
   AND NOT EXISTS(SELECT 1 FROM bb_model_call_attempts WHERE job_id=NEW.id)
   AND NOT EXISTS(SELECT 1 FROM jsonb_object_keys(COALESCE(OLD.checkpoint->'stages','{}'::jsonb)) stage
    WHERE stage NOT IN ('input_lock','materials_ready','workflow_budget_v1','chapter_context_v1'))
   THEN RAISE EXCEPTION 'New workflow requires versioned preparation admission' USING ERRCODE='55000'; END IF;
  IF phase IS NOT NULL AND NOT NEW.checkpoint ? 'workflow_v1' AND (phase<>'authoring' OR TG_OP<>'UPDATE'
   OR (OLD.attempts<>0 AND OLD.checkpoint#>>'{workflow_admission_v1,protocol_version}' IS DISTINCT FROM '1')
   OR EXISTS(SELECT 1 FROM jsonb_object_keys(COALESCE(OLD.checkpoint->'stages','{}'::jsonb)) stage
    WHERE stage NOT IN ('input_lock','materials_ready','workflow_budget_v1','chapter_context_v1','workflow_outline_v1','workflow_outline_prompt'))
   OR NOT bb_workflow_preparation_calls_safe(NEW.id,OLD.checkpoint))
   THEN RAISE EXCEPTION 'Legacy execution cannot change workflow protocol' USING ERRCODE='55000'; END IF;
 END IF;
 n:=bb_execution_claim_context();
 IF n.id IS NOT NULL THEN
  capability:=CASE WHEN TG_TABLE_NAME='bb_review_messages' THEN 'assistant' ELSE NULL END;
  IF TG_TABLE_NAME='bb_jobs' THEN capability:=COALESCE(phase,CASE WHEN NEW.job_type='platform_probe' THEN 'probe' WHEN NEW.job_type='review' THEN 'review' ELSE 'authoring' END); END IF;
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(n.expected_services) svc
   WHERE svc->>'service_id'=(SELECT service_id FROM bb_execution_node_sessions WHERE session_id=NULLIF(current_setting('bb.execution_session_id',true),'')::uuid)
   AND svc->'capabilities' ? capability) THEN RAISE EXCEPTION 'Execution service capability mismatch' USING ERRCODE='55000'; END IF;
  UPDATE bb_execution_nodes SET idle_since=NULL WHERE id=n.id;
  NEW.execution_node_id:=n.id;NEW.execution_node_epoch:=n.epoch;
  SELECT revision INTO NEW.execution_admission_policy_revision FROM bb_execution_capacity_policy WHERE singleton;
  NEW.execution_session_id:=NULLIF(current_setting('bb.execution_session_id',true),'')::uuid;
  IF TG_TABLE_NAME='bb_jobs' THEN NEW.execution_admission_phase:=COALESCE(phase,'legacy'); END IF;
 END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION bb_execution_phase_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.lease_token IS NOT NULL AND NEW.lease_token IS NOT NULL
  AND NEW.execution_admission_phase IS DISTINCT FROM OLD.execution_admission_phase
  THEN RAISE EXCEPTION 'Execution admission phase immutable while owned' USING ERRCODE='55000'; END IF;
 IF NEW.lease_token IS NULL THEN NEW.execution_admission_phase:=NULL; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_execution_phase_identity BEFORE UPDATE ON bb_jobs FOR EACH ROW EXECUTE FUNCTION bb_execution_phase_immutable();

-- Old operator/legacy resume writers cannot requeue a v1 job without the common
-- object verification gate. Positive task release itself may perform its handoff.
CREATE FUNCTION bb_execution_workflow_requeue_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.state='queued' AND OLD.state IS DISTINCT FROM 'queued'
  AND (NEW.checkpoint ? 'workflow_v1' OR NEW.checkpoint ? 'workflow_admission_v1') THEN
  IF NOT COALESCE((OLD.lease_token IS NOT NULL AND NEW.lease_token IS NULL
   AND NEW.checkpoint#>>'{positive_release_v1,lease_token}'=OLD.lease_token
   AND NEW.checkpoint#>>'{positive_release_v1,session_id}'=OLD.execution_session_id::text),false)
   AND NULLIF(current_setting('bb.workflow_resume_verified_hash',true),'') IS NULL
   THEN RAISE EXCEPTION 'Workflow requeue requires verified recovery' USING ERRCODE='55000'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_execution_workflow_requeue BEFORE UPDATE ON bb_jobs FOR EACH ROW EXECUTE FUNCTION bb_execution_workflow_requeue_guard();

CREATE FUNCTION bb_execution_workflow_activation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.workflow_slots_enabled,NEW.authoring_slots,NEW.postprocess_slots) IS DISTINCT FROM ROW(OLD.workflow_slots_enabled,OLD.authoring_slots,OLD.postprocess_slots)
  AND (EXISTS(SELECT 1 FROM bb_jobs WHERE execution_node_id IS NOT NULL AND lease_token IS NOT NULL)
   OR EXISTS(SELECT 1 FROM bb_review_messages WHERE execution_node_id IS NOT NULL AND lease_token IS NOT NULL)
   OR EXISTS(SELECT 1 FROM bb_model_capacity_holders WHERE execution_node_id IS NOT NULL))
  THEN RAISE EXCEPTION 'Workflow capacity change requires positive drain' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_execution_workflow_activation_guard BEFORE UPDATE ON bb_execution_capacity_policy FOR EACH ROW EXECUTE FUNCTION bb_execution_workflow_activation();

-- Immutable capture evidence is deliberately separate from provider results and billing.
CREATE TABLE bb_sealed_model_captures (
 id text PRIMARY KEY,owner_user_id text NOT NULL,project_id text NOT NULL,run_id text NOT NULL,job_id text NOT NULL,
 attempt_id text NOT NULL UNIQUE,logical_call_id text NOT NULL,attempt_no integer NOT NULL,
 execution_node_id text NOT NULL REFERENCES bb_execution_nodes(id),execution_node_epoch uuid NOT NULL,
 execution_session_id uuid NOT NULL REFERENCES bb_execution_node_sessions(session_id),lease_token text NOT NULL,
 spool_id text NOT NULL,manifest_sha256 char(64) NOT NULL CHECK(manifest_sha256 ~ '^[a-f0-9]{64}$'),
 call_exit_proof jsonb NOT NULL,raw_usage jsonb,raw_outcome jsonb NOT NULL,evidence_sha256 char(64) NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(owner_user_id,job_id,logical_call_id,attempt_no,attempt_id) REFERENCES bb_model_call_attempts(owner_user_id,job_id,logical_call_id,attempt_no,id)
);
CREATE TRIGGER bb_sealed_model_captures_immutable BEFORE UPDATE OR DELETE ON bb_sealed_model_captures FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();
CREATE TABLE bb_recovered_capture_evidence (
 id text PRIMARY KEY,owner_user_id text NOT NULL,project_id text NOT NULL,run_id text NOT NULL,job_id text NOT NULL,
 attempt_id text NOT NULL,logical_call_id text NOT NULL,attempt_no integer NOT NULL,
 original_node_id text NOT NULL REFERENCES bb_execution_nodes(id),original_epoch uuid NOT NULL,
 original_session_id uuid NOT NULL REFERENCES bb_execution_node_sessions(session_id),
 recovery_session_id uuid NOT NULL REFERENCES bb_execution_node_sessions(session_id),
 capture_ref text NOT NULL,capture_sha256 char(64) NOT NULL CHECK(capture_sha256 ~ '^[a-f0-9]{64}$'),
 byte_size bigint NOT NULL CHECK(byte_size>0 AND byte_size<=104857600),manifest_sha256 char(64) NOT NULL,evidence_sha256 char(64) NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(attempt_id,capture_sha256),
 FOREIGN KEY(owner_user_id,job_id,logical_call_id,attempt_no,attempt_id) REFERENCES bb_model_call_attempts(owner_user_id,job_id,logical_call_id,attempt_no,id),
 CHECK(capture_ref='users/'||owner_user_id||'/projects/'||project_id||'/recovered-captures/'||attempt_id||'-'||trim(capture_sha256)||'.json')
);
CREATE TRIGGER bb_recovered_capture_evidence_immutable BEFORE UPDATE OR DELETE ON bb_recovered_capture_evidence FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();
