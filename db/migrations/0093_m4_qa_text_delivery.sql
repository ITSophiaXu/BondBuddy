-- QA text is delivered as text. All historical Word and test-channel guards remain.
CREATE TABLE bb_m4_text_delivery_evidence (
 id text PRIMARY KEY, owner_user_id text NOT NULL, run_id text NOT NULL, artifact_id text NOT NULL, artifact_version integer NOT NULL,
 sha256 char(64) NOT NULL, byte_size bigint NOT NULL CHECK(byte_size>0), content text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(owner_user_id,run_id,id),
 FOREIGN KEY(owner_user_id,run_id) REFERENCES bb_runs(owner_user_id,id), CHECK(octet_length(content)=byte_size)
);
CREATE TRIGGER bb_m4_text_evidence_immutable BEFORE UPDATE OR DELETE ON bb_m4_text_delivery_evidence FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();
ALTER TABLE bb_artifact_versions ADD COLUMN m4_text_delivery_evidence_id text;
ALTER TABLE bb_artifact_versions ADD FOREIGN KEY(owner_user_id,run_id,m4_text_delivery_evidence_id) REFERENCES bb_m4_text_delivery_evidence(owner_user_id,run_id,id);
ALTER TABLE bb_artifact_versions DROP CONSTRAINT bb_available_artifact_requires_evidence;
ALTER TABLE bb_artifact_versions ADD CONSTRAINT bb_available_artifact_requires_evidence
 CHECK(delivery_status NOT IN ('available','test_only') OR word_delivery_evidence_id IS NOT NULL OR
   delivery_status='available' AND media_type='text/plain' AND m4_text_delivery_evidence_id IS NOT NULL);
CREATE OR REPLACE FUNCTION bb_check_word_delivery_evidence_for_artifact() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE evidence bb_word_delivery_evidence%ROWTYPE; run_channel text;
BEGIN
  IF NEW.m4_text_delivery_evidence_id IS NOT NULL THEN
    IF NEW.media_type<>'text/plain' OR NEW.word_delivery_evidence_id IS NOT NULL OR NEW.quality_status<>'passed' OR NEW.delivery_status<>'available'
      OR NOT EXISTS(SELECT 1 FROM bb_m4_text_delivery_evidence e JOIN bb_runs r ON r.id=e.run_id AND r.owner_user_id=e.owner_user_id
        JOIN bb_jobs j ON j.run_id=r.id AND j.owner_user_id=r.owner_user_id JOIN bb_m4_executions x ON x.run_id=r.id AND x.owner_user_id=r.owner_user_id
        WHERE e.id=NEW.m4_text_delivery_evidence_id AND e.owner_user_id=NEW.owner_user_id AND e.run_id=NEW.run_id
        AND e.artifact_id=NEW.id AND e.artifact_version=NEW.version AND e.sha256=NEW.sha256
        AND r.task_kind='qa' AND r.channel='production' AND j.subtype='m4_qa_v1' AND x.manifest->>'kind'='qa')
    THEN RAISE EXCEPTION 'M4 text delivery requires owned exact QA evidence' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.word_delivery_evidence_id IS NOT NULL THEN
    SELECT * INTO evidence FROM bb_word_delivery_evidence WHERE owner_user_id=NEW.owner_user_id AND run_id=NEW.run_id AND id=NEW.word_delivery_evidence_id;
    IF NOT FOUND OR evidence.artifact_id<>NEW.id OR evidence.artifact_version<>NEW.version OR evidence.candidate_sha256<>NEW.sha256 OR evidence.quality_status<>NEW.quality_status
    THEN RAISE EXCEPTION 'artifact evidence identity mismatch' USING ERRCODE='23514'; END IF;
  END IF;
  IF NEW.delivery_status IN ('available','test_only') THEN
    SELECT channel INTO run_channel FROM bb_runs WHERE owner_user_id=NEW.owner_user_id AND id=NEW.run_id;
    IF NEW.word_delivery_evidence_id IS NULL OR evidence.delivery_status<>'available' OR evidence.delivery_code<>'readback_verified'
      OR NEW.media_type<>'application/vnd.openxmlformats-officedocument.wordprocessingml.document' OR NEW.quality_status<>'passed'
      OR (NEW.delivery_status='test_only' AND run_channel<>'non_production_test') OR (NEW.delivery_status='available' AND run_channel<>'production')
    THEN RAISE EXCEPTION 'artifact requires matching verified Word evidence and channel' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER bb_artifact_delivery_evidence_guard ON bb_artifact_versions;
CREATE TRIGGER bb_artifact_delivery_evidence_guard BEFORE INSERT OR UPDATE OF id,version,owner_user_id,run_id,media_type,sha256,quality_status,delivery_status,word_delivery_evidence_id,m4_text_delivery_evidence_id
 ON bb_artifact_versions FOR EACH ROW EXECUTE FUNCTION bb_check_word_delivery_evidence_for_artifact();
CREATE OR REPLACE FUNCTION bb_require_word_delivery_for_run_success() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state='succeeded' AND NEW.task_kind='qa' AND EXISTS(SELECT 1 FROM bb_jobs WHERE owner_user_id=NEW.owner_user_id AND run_id=NEW.id AND subtype='m4_qa_v1') THEN
    IF NEW.channel<>'production' OR NOT EXISTS(SELECT 1 FROM bb_artifact_versions a JOIN bb_m4_text_delivery_evidence e ON e.id=a.m4_text_delivery_evidence_id
      JOIN bb_m4_artifacts d ON d.artifact_id=a.id AND d.artifact_version=a.version
      WHERE a.owner_user_id=NEW.owner_user_id AND a.run_id=NEW.id AND a.id=NEW.artifact_id AND a.version=NEW.artifact_version
      AND a.media_type='text/plain' AND a.quality_status='passed' AND a.delivery_status='available' AND e.owner_user_id=a.owner_user_id AND e.run_id=a.run_id
      AND e.artifact_id=a.id AND e.artifact_version=a.version AND e.sha256=a.sha256 AND d.owner_user_id=a.owner_user_id AND d.run_id=a.run_id
      AND d.kind='qa_text' AND d.body_content=e.content AND d.byte_size=e.byte_size)
    THEN RAISE EXCEPTION 'M4 QA success requires delivered text evidence' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.state='succeeded' AND NEW.task_kind='platform_probe' THEN
    IF NOT EXISTS(SELECT 1 FROM bb_jobs j JOIN bb_model_call_attempts a ON a.owner_user_id=j.owner_user_id AND a.job_id=j.id
      JOIN bb_provider_call_observations o ON o.attempt_id=a.id AND o.outcome='completed' AND o.usage_status='measured'
      WHERE j.owner_user_id=NEW.owner_user_id AND j.run_id=NEW.id AND j.job_type='platform_probe' AND a.status='completed')
    THEN RAISE EXCEPTION 'succeeded platform probe requires a completed measured provider attempt' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.state IN ('succeeded','test_completed') AND NOT EXISTS(SELECT 1 FROM bb_artifact_versions a JOIN bb_word_delivery_evidence e
    ON e.owner_user_id=a.owner_user_id AND e.run_id=a.run_id AND e.id=a.word_delivery_evidence_id
    WHERE a.owner_user_id=NEW.owner_user_id AND a.run_id=NEW.id AND a.id=NEW.artifact_id AND a.version=NEW.artifact_version
      AND a.media_type='application/vnd.openxmlformats-officedocument.wordprocessingml.document' AND a.quality_status='passed'
      AND a.delivery_status=CASE WHEN NEW.state='test_completed' THEN 'test_only' ELSE 'available' END
      AND e.quality_status='passed' AND e.delivery_status='available' AND e.delivery_code='readback_verified'
      AND e.candidate_sha256=a.sha256 AND e.readback_sha256=a.sha256 AND e.readback_byte_size=e.byte_size)
  THEN RAISE EXCEPTION 'terminal run requires verified Word delivery in its channel' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
