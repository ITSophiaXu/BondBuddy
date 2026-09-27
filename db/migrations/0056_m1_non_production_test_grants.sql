-- Scoped, audited test access. A revocation is the only permitted update.
ALTER TABLE bb_input_revisions ADD CONSTRAINT bb_input_test_grant_scope_key
  UNIQUE(owner_user_id,project_id,revision,input_hash);
CREATE TABLE bb_non_production_test_grants (
  grant_id text PRIMARY KEY,
  user_id text NOT NULL,
  project_id text NOT NULL,
  input_revision integer NOT NULL,
  input_hash char(64) NOT NULL,
  sample_manifest_sha256 char(64) NOT NULL,
  taxonomy_hash char(64) NOT NULL,
  rule_pack_hash char(64) NOT NULL,
  granted_by text NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_by text,
  revoked_reason text,
  UNIQUE (grant_id,user_id,project_id,input_revision,input_hash),
  FOREIGN KEY (user_id,project_id,input_revision,input_hash)
    REFERENCES bb_input_revisions(owner_user_id,project_id,revision,input_hash),
  CHECK (expires_at > created_at),
  CHECK ((revoked_at IS NULL AND revoked_by IS NULL AND revoked_reason IS NULL) OR
         (revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND revoked_reason IS NOT NULL))
);
CREATE INDEX bb_non_production_test_grants_scope_idx ON bb_non_production_test_grants(user_id,project_id,input_revision);

CREATE FUNCTION bb_test_grant_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'test grant is append-only' USING ERRCODE='23514'; END IF;
  IF OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL OR NEW.revoked_by IS NULL OR NEW.revoked_reason IS NULL OR
     (to_jsonb(NEW) - 'revoked_at' - 'revoked_by' - 'revoked_reason') IS DISTINCT FROM
     (to_jsonb(OLD) - 'revoked_at' - 'revoked_by' - 'revoked_reason') THEN
    RAISE EXCEPTION 'test grant permits one audited revocation only' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bb_test_grant_immutable BEFORE UPDATE OR DELETE ON bb_non_production_test_grants
  FOR EACH ROW EXECUTE FUNCTION bb_test_grant_guard();

ALTER TABLE bb_runs ADD COLUMN channel text NOT NULL DEFAULT 'production';
ALTER TABLE bb_runs ADD COLUMN test_grant_id text;
ALTER TABLE bb_runs ADD COLUMN uncovered_items jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE bb_runs ADD CONSTRAINT bb_run_channel_check CHECK (
  (channel='production' AND test_grant_id IS NULL AND state <> 'test_completed') OR
  (channel='non_production_test' AND test_grant_id IS NOT NULL AND state NOT IN ('succeeded','settlement_pending'))
);
ALTER TABLE bb_runs ADD CONSTRAINT bb_run_test_grant_fk
  FOREIGN KEY (test_grant_id,owner_user_id,project_id,input_revision,input_hash)
  REFERENCES bb_non_production_test_grants(grant_id,user_id,project_id,input_revision,input_hash);
ALTER TABLE bb_runs ADD CONSTRAINT bb_run_uncovered_items_array CHECK (jsonb_typeof(uncovered_items)='array');
ALTER TABLE bb_runs ADD CONSTRAINT bb_test_completed_artifact_required
  CHECK(state <> 'test_completed' OR (artifact_id IS NOT NULL AND artifact_version IS NOT NULL));
ALTER TABLE bb_runs DROP CONSTRAINT bb_runs_state_check;
ALTER TABLE bb_runs ADD CONSTRAINT bb_runs_state_check CHECK(state IN ('preparing','rejected','queued','running','awaiting_input','paused','validating','delivering','settlement_pending','succeeded','test_completed','failed','cancelled'));

ALTER TABLE bb_jobs ADD COLUMN channel text NOT NULL DEFAULT 'production';
ALTER TABLE bb_jobs ADD COLUMN test_grant_id text;
ALTER TABLE bb_jobs ADD CONSTRAINT bb_job_test_channel_check CHECK (
  (channel='production' AND test_grant_id IS NULL) OR
  (channel='non_production_test' AND test_grant_id IS NOT NULL));
ALTER TABLE bb_jobs DROP CONSTRAINT bb_jobs_state_check;
ALTER TABLE bb_jobs ADD CONSTRAINT bb_jobs_state_check
  CHECK(state IN ('queued','running','paused','succeeded','test_completed','failed','cancelled','rejected'));
CREATE FUNCTION bb_run_channel_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.channel IS DISTINCT FROM OLD.channel OR NEW.test_grant_id IS DISTINCT FROM OLD.test_grant_id THEN
    RAISE EXCEPTION 'run channel and grant are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bb_run_channel_immutable BEFORE UPDATE ON bb_runs
  FOR EACH ROW EXECUTE FUNCTION bb_run_channel_immutable();
CREATE TRIGGER bb_job_channel_immutable BEFORE UPDATE ON bb_jobs
  FOR EACH ROW EXECUTE FUNCTION bb_run_channel_immutable();
ALTER TABLE bb_operations ADD COLUMN channel text NOT NULL DEFAULT 'production';
ALTER TABLE bb_observability_events ADD COLUMN channel text NOT NULL DEFAULT 'production';
ALTER TABLE bb_model_call_attempts ADD COLUMN channel text NOT NULL DEFAULT 'production';
ALTER TABLE bb_artifact_versions DROP CONSTRAINT bb_artifact_versions_delivery_status_check;
ALTER TABLE bb_artifact_versions ADD CONSTRAINT bb_artifact_versions_delivery_status_check
  CHECK(delivery_status IN ('pending','available','test_only','revoked'));
ALTER TABLE bb_artifact_versions ADD CONSTRAINT bb_artifact_test_only_quality_check
  CHECK(delivery_status <> 'test_only' OR quality_status='passed');
ALTER TABLE bb_artifact_versions DROP CONSTRAINT bb_available_artifact_requires_evidence;
ALTER TABLE bb_artifact_versions ADD CONSTRAINT bb_available_artifact_requires_evidence
  CHECK(delivery_status NOT IN ('available','test_only') OR word_delivery_evidence_id IS NOT NULL);

CREATE OR REPLACE FUNCTION bb_check_word_delivery_evidence_for_artifact() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE evidence bb_word_delivery_evidence%ROWTYPE; run_channel text;
BEGIN
  IF NEW.word_delivery_evidence_id IS NOT NULL THEN
    SELECT * INTO evidence FROM bb_word_delivery_evidence
     WHERE owner_user_id=NEW.owner_user_id AND run_id=NEW.run_id AND id=NEW.word_delivery_evidence_id;
    IF NOT FOUND OR evidence.artifact_id <> NEW.id OR evidence.artifact_version <> NEW.version
       OR evidence.candidate_sha256 <> NEW.sha256 OR evidence.quality_status <> NEW.quality_status THEN
      RAISE EXCEPTION 'artifact evidence identity mismatch' USING ERRCODE='23514';
    END IF;
  END IF;
  IF NEW.delivery_status IN ('available','test_only') THEN
    SELECT channel INTO run_channel FROM bb_runs WHERE owner_user_id=NEW.owner_user_id AND id=NEW.run_id;
    IF NEW.word_delivery_evidence_id IS NULL OR evidence.delivery_status <> 'available'
       OR evidence.delivery_code <> 'readback_verified'
       OR NEW.media_type <> 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
       OR NEW.quality_status <> 'passed'
       OR (NEW.delivery_status='test_only' AND run_channel <> 'non_production_test')
       OR (NEW.delivery_status='available' AND run_channel <> 'production') THEN
      RAISE EXCEPTION 'artifact requires matching verified Word evidence and channel' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION bb_require_word_delivery_for_run_success() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state='succeeded' AND NEW.task_kind='platform_probe' THEN
    IF NOT EXISTS (
      SELECT 1 FROM bb_jobs j JOIN bb_model_call_attempts a ON a.owner_user_id=j.owner_user_id AND a.job_id=j.id
      JOIN bb_provider_call_observations o ON o.attempt_id=a.id AND o.outcome='completed' AND o.usage_status='measured'
      WHERE j.owner_user_id=NEW.owner_user_id AND j.run_id=NEW.id AND j.job_type='platform_probe' AND a.status='completed'
    ) THEN RAISE EXCEPTION 'succeeded platform probe requires a completed measured provider attempt' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.state IN ('succeeded','test_completed') AND NOT EXISTS (
    SELECT 1 FROM bb_artifact_versions a
    JOIN bb_word_delivery_evidence e ON e.owner_user_id=a.owner_user_id AND e.run_id=a.run_id AND e.id=a.word_delivery_evidence_id
    WHERE a.owner_user_id=NEW.owner_user_id AND a.run_id=NEW.id AND a.id=NEW.artifact_id AND a.version=NEW.artifact_version
      AND a.media_type='application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      AND a.quality_status='passed'
      AND a.delivery_status=CASE WHEN NEW.state='test_completed' THEN 'test_only' ELSE 'available' END
      AND e.quality_status='passed' AND e.delivery_status='available' AND e.delivery_code='readback_verified'
      AND e.candidate_sha256=a.sha256 AND e.readback_sha256=a.sha256 AND e.readback_byte_size=e.byte_size
  ) THEN RAISE EXCEPTION 'terminal run requires verified Word delivery in its channel' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION bb_material_bytes_pinned(p_owner text, p_project text, p_material text, p_version integer)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM bb_projects p
    JOIN bb_input_revisions i ON i.owner_user_id=p.owner_user_id AND i.project_id=p.id
    JOIN bb_runs r ON r.owner_user_id=i.owner_user_id AND r.project_id=i.project_id AND r.input_revision=i.revision
    WHERE p.owner_user_id=p_owner AND p.id=p_project AND p.deleted_at IS NULL
      AND r.state NOT IN ('succeeded','test_completed','failed','cancelled','rejected')
      AND (i.material_versions @> jsonb_build_array(jsonb_build_object('material_id',p_material,'material_version',p_version))
        OR i.manifest->'materials' @> jsonb_build_array(jsonb_build_object('material_id',p_material,'material_version',p_version)))
  )
$$;
