-- #79/#16 operator-only platform probe. A log_operator enqueues one fixed synthetic prompt
-- template; the worker runs it through the contained Codex adapter and the durable journal so
-- the normal #79 attempt, usage, runtime and cost-ledger rows are written for real.
-- Every evidence table is keyed by owner/project/run, so probes are owned by one reserved
-- platform principal that cannot sign in (status 'disabled'), with one fixed synthetic project
-- and input revision. Probe jobs can never be owned by a user, and the principal owns nothing else.

CREATE TABLE bb_platform_principals (
 user_id text PRIMARY KEY REFERENCES bb_users(id),
 purpose text NOT NULL UNIQUE CHECK (purpose IN ('platform_probe')),
 project_id text NOT NULL,
 input_revision integer NOT NULL CHECK (input_revision>0),
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (user_id,project_id,input_revision) REFERENCES bb_input_revisions(owner_user_id,project_id,revision)
);
CREATE TRIGGER bb_platform_principal_immutable BEFORE UPDATE OR DELETE ON bb_platform_principals
  FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();

INSERT INTO bb_users(id,username,status) VALUES ('bb-platform-probe','bb_platform_probe','disabled');
INSERT INTO bb_projects(id,owner_user_id,name,kind,latest_input_revision)
  VALUES ('bb-platform-probe-project','bb-platform-probe','Platform model probe (synthetic)','platform_probe',1);
INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
  VALUES ('bb-platform-probe-project',1,'bb-platform-probe',1,
    encode(sha256(convert_to('bb-platform-probe-input-v1','UTF8')),'hex'),
    '{"synthetic":true,"purpose":"platform_probe","user_data":false}'::jsonb,'[]'::jsonb,'[]'::jsonb);
INSERT INTO bb_platform_principals(user_id,purpose,project_id,input_revision)
  VALUES ('bb-platform-probe','platform_probe','bb-platform-probe-project',1);

-- Binding: platform_probe jobs/runs belong to the platform principal only, and vice versa.
CREATE FUNCTION bb_guard_platform_probe_owner() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE is_platform boolean; is_probe boolean;
BEGIN
 SELECT EXISTS(SELECT 1 FROM bb_platform_principals p WHERE p.user_id=NEW.owner_user_id AND p.purpose='platform_probe') INTO is_platform;
 IF TG_TABLE_NAME='bb_jobs' THEN
   is_probe := NEW.job_type='platform_probe';
   IF is_probe AND NEW.subtype<>'model_probe' THEN RAISE EXCEPTION 'platform probe job subtype must be model_probe' USING ERRCODE='23514'; END IF;
 ELSE
   is_probe := NEW.task_kind='platform_probe';
 END IF;
 IF is_probe AND NOT is_platform THEN RAISE EXCEPTION 'platform probes are owned by the platform principal' USING ERRCODE='23514'; END IF;
 IF is_platform AND NOT is_probe THEN RAISE EXCEPTION 'the platform principal only owns platform probes' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_platform_probe_job_owner BEFORE INSERT OR UPDATE OF owner_user_id,job_type,subtype ON bb_jobs
  FOR EACH ROW EXECUTE FUNCTION bb_guard_platform_probe_owner();
CREATE TRIGGER bb_platform_probe_run_owner BEFORE INSERT OR UPDATE OF owner_user_id,task_kind ON bb_runs
  FOR EACH ROW EXECUTE FUNCTION bb_guard_platform_probe_owner();

-- A probe produces no Word deliverable. Its success is a completed, measured, stored provider
-- result (checked by the worker under the job lease). User runs keep the Word-delivery rule.
ALTER TABLE bb_runs DROP CONSTRAINT bb_runs_check;
ALTER TABLE bb_runs ADD CONSTRAINT bb_runs_check CHECK (state<>'succeeded' OR artifact_id IS NOT NULL OR task_kind='platform_probe');
ALTER TABLE bb_runs DROP CONSTRAINT bb_success_artifact_version;
ALTER TABLE bb_runs ADD CONSTRAINT bb_success_artifact_version CHECK (state<>'succeeded' OR artifact_version IS NOT NULL OR task_kind='platform_probe');
ALTER TABLE bb_runs ADD CONSTRAINT bb_platform_probe_no_artifact CHECK (task_kind<>'platform_probe' OR artifact_id IS NULL);
CREATE OR REPLACE FUNCTION bb_require_word_delivery_for_run_success() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.state='succeeded' AND NEW.task_kind='platform_probe' THEN
   IF NOT EXISTS (
     SELECT 1 FROM bb_jobs j JOIN bb_model_call_attempts a ON a.owner_user_id=j.owner_user_id AND a.job_id=j.id
     JOIN bb_provider_call_observations o ON o.attempt_id=a.id AND o.outcome='completed' AND o.usage_status='measured'
     WHERE j.owner_user_id=NEW.owner_user_id AND j.run_id=NEW.id AND j.job_type='platform_probe' AND a.status='completed'
   ) THEN
     RAISE EXCEPTION 'succeeded platform probe requires a completed measured provider attempt' USING ERRCODE='23514';
   END IF;
   RETURN NEW;
 END IF;
 IF NEW.state='succeeded' AND NOT EXISTS (
   SELECT 1 FROM bb_artifact_versions a
   JOIN bb_word_delivery_evidence e
     ON e.owner_user_id=a.owner_user_id AND e.run_id=a.run_id AND e.id=a.word_delivery_evidence_id
   WHERE a.owner_user_id=NEW.owner_user_id AND a.run_id=NEW.id
     AND a.id=NEW.artifact_id AND a.version=NEW.artifact_version
     AND a.media_type='application/vnd.openxmlformats-officedocument.wordprocessingml.document'
     AND a.quality_status='passed' AND a.delivery_status='available'
     AND e.quality_status='passed' AND e.delivery_status='available'
     AND e.delivery_code='readback_verified' AND e.candidate_sha256=a.sha256
     AND e.readback_sha256=a.sha256 AND e.readback_byte_size=e.byte_size
 ) THEN
   RAISE EXCEPTION 'succeeded run requires verified available Word delivery' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;

CREATE INDEX bb_platform_probe_claim_idx ON bb_jobs(state,lease_until,created_at) WHERE job_type='platform_probe';
