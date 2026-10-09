-- Source PDF overlays have their own immutable receipt. Do not weaken Word/QA guards.
CREATE TABLE bb_review_pdf_delivery_evidence (
 id text PRIMARY KEY, owner_user_id text NOT NULL, run_id text NOT NULL,
 artifact_id text NOT NULL, artifact_version integer NOT NULL CHECK(artifact_version>0),
 sha256 char(64) NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),
 byte_size bigint NOT NULL CHECK(byte_size BETWEEN 8 AND 104857600), object_key text NOT NULL,
 source_material_id text NOT NULL, source_material_version integer NOT NULL CHECK(source_material_version>0),
 source_sha256 char(64) NOT NULL CHECK(source_sha256 ~ '^[0-9a-f]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(owner_user_id,run_id,id),
 FOREIGN KEY(owner_user_id,run_id) REFERENCES bb_runs(owner_user_id,id)
);
CREATE FUNCTION bb_reject_review_pdf_evidence_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'immutable review PDF delivery evidence' USING ERRCODE='23514'; END $$;
CREATE TRIGGER bb_review_pdf_evidence_immutable BEFORE UPDATE OR DELETE ON bb_review_pdf_delivery_evidence
 FOR EACH ROW EXECUTE FUNCTION bb_reject_review_pdf_evidence_change();
ALTER TABLE bb_artifact_versions ADD COLUMN review_pdf_delivery_evidence_id text;
ALTER TABLE bb_artifact_versions ADD FOREIGN KEY(owner_user_id,run_id,review_pdf_delivery_evidence_id)
 REFERENCES bb_review_pdf_delivery_evidence(owner_user_id,run_id,id);
ALTER TABLE bb_artifact_versions DROP CONSTRAINT bb_available_artifact_requires_evidence;
ALTER TABLE bb_artifact_versions ADD CONSTRAINT bb_available_artifact_requires_evidence
 CHECK(delivery_status NOT IN ('available','test_only') OR word_delivery_evidence_id IS NOT NULL OR
   delivery_status='available' AND media_type='text/plain' AND m4_text_delivery_evidence_id IS NOT NULL OR
   media_type='application/pdf' AND review_pdf_delivery_evidence_id IS NOT NULL);

CREATE FUNCTION bb_check_review_pdf_delivery_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.review_pdf_delivery_evidence_id IS NOT NULL AND (
   NEW.media_type<>'application/pdf' OR NEW.word_delivery_evidence_id IS NOT NULL OR NEW.m4_text_delivery_evidence_id IS NOT NULL
   OR NEW.quality_status<>'passed' OR NOT EXISTS(
     SELECT 1 FROM bb_review_pdf_delivery_evidence e
     JOIN bb_runs r ON r.id=e.run_id AND r.owner_user_id=e.owner_user_id
     JOIN bb_review_executions x ON x.run_id=r.id AND x.owner_user_id=r.owner_user_id
     JOIN bb_input_revisions i ON i.owner_user_id=r.owner_user_id AND i.project_id=r.project_id AND i.revision=r.input_revision
     WHERE e.id=NEW.review_pdf_delivery_evidence_id AND e.owner_user_id=NEW.owner_user_id AND e.run_id=NEW.run_id
       AND e.artifact_id=NEW.id AND e.artifact_version=NEW.version AND e.sha256=NEW.sha256 AND e.object_key=NEW.object_key
       AND x.operation IN ('full_review','differential_review')
       AND i.manifest#>>'{review,input,source_material_ref,material_id}'=e.source_material_id
       AND i.manifest#>>'{review,input,source_material_ref,material_version}'=e.source_material_version::text
       AND i.manifest#>>'{review,input,source_material_ref,sha256}'=trim(e.source_sha256)
       AND (NEW.delivery_status NOT IN ('available','test_only') OR
         NEW.delivery_status=CASE r.channel WHEN 'production' THEN 'available' ELSE 'test_only' END)
   )) THEN RAISE EXCEPTION 'PDF artifact requires exact source and verified delivery evidence' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER bb_artifact_delivery_evidence_guard ON bb_artifact_versions;
CREATE TRIGGER bb_artifact_delivery_evidence_guard BEFORE INSERT OR UPDATE OF id,version,owner_user_id,run_id,media_type,sha256,quality_status,delivery_status,word_delivery_evidence_id,m4_text_delivery_evidence_id,review_pdf_delivery_evidence_id
 ON bb_artifact_versions FOR EACH ROW WHEN (NEW.review_pdf_delivery_evidence_id IS NULL)
 EXECUTE FUNCTION bb_check_word_delivery_evidence_for_artifact();
CREATE TRIGGER bb_review_pdf_delivery_evidence_guard BEFORE INSERT OR UPDATE OF id,version,owner_user_id,run_id,media_type,sha256,object_key,quality_status,delivery_status,word_delivery_evidence_id,m4_text_delivery_evidence_id,review_pdf_delivery_evidence_id
 ON bb_artifact_versions FOR EACH ROW EXECUTE FUNCTION bb_check_review_pdf_delivery_evidence();
