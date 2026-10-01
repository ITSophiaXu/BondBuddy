-- OCR records and rendered pages remain private; user corrections never promote evidence to audited facts.
CREATE TABLE bb_ocr_snapshots (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL,
  project_id text NOT NULL,
  material_id text NOT NULL,
  material_version integer NOT NULL CHECK(material_version>0),
  request_id text NOT NULL,
  request_hash char(64) NOT NULL,
  result_hash char(64) NOT NULL,
  result_key text NOT NULL,
  purpose text NOT NULL CHECK(purpose IN ('source_preflight','full_ocr')),
  run_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_user_id,project_id,request_id),
  UNIQUE(owner_user_id,project_id,id),
  FOREIGN KEY(owner_user_id,project_id) REFERENCES bb_projects(owner_user_id,id),
  FOREIGN KEY(owner_user_id,project_id,material_id,material_version) REFERENCES bb_material_versions(owner_user_id,project_id,id,version),
  CHECK((purpose='source_preflight' AND run_id IS NULL) OR (purpose='full_ocr' AND run_id IS NOT NULL))
);
CREATE INDEX bb_ocr_latest ON bb_ocr_snapshots(owner_user_id,project_id,material_id,created_at DESC,id);
CREATE TABLE bb_ocr_corrections (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL,
  project_id text NOT NULL,
  snapshot_id text NOT NULL,
  record_id text NOT NULL,
  revision integer NOT NULL CHECK(revision>0),
  request_id text NOT NULL,
  request_hash char(64) NOT NULL,
  correction jsonb NOT NULL CHECK(correction->>'status'='user_asserted' AND correction->>'eligible_for_manuscript'='false'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(snapshot_id,record_id,revision),
  UNIQUE(owner_user_id,project_id,request_id),
  FOREIGN KEY(owner_user_id,project_id,snapshot_id) REFERENCES bb_ocr_snapshots(owner_user_id,project_id,id)
);
CREATE FUNCTION bb_reject_ocr_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'OCR evidence and corrections are append-only' USING ERRCODE='23514'; END $$;
CREATE TRIGGER bb_ocr_snapshot_immutable BEFORE UPDATE OR DELETE ON bb_ocr_snapshots FOR EACH ROW EXECUTE FUNCTION bb_reject_ocr_rewrite();
CREATE TRIGGER bb_ocr_correction_immutable BEFORE UPDATE OR DELETE ON bb_ocr_corrections FOR EACH ROW EXECUTE FUNCTION bb_reject_ocr_rewrite();
