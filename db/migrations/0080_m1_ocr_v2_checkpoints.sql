-- Internal OCR v2 physical-page ledger. v1 snapshots and corrections remain untouched.
CREATE TABLE bb_ocr_v2_batches (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL,
  project_id text NOT NULL,
  material_id text NOT NULL,
  material_version integer NOT NULL,
  document_identity jsonb NOT NULL,
  context jsonb NOT NULL,
  job_id text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('source_preflight', 'full_ocr')),
  request jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('started', 'finished', 'interrupted')),
  attempted_pages integer CHECK (attempted_pages BETWEEN 0 AND 50),
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  FOREIGN KEY (owner_user_id, project_id, material_id, material_version)
    REFERENCES bb_material_versions(owner_user_id, project_id, id, version),
  FOREIGN KEY (owner_user_id, job_id) REFERENCES bb_jobs(owner_user_id, id),
  CHECK ((state = 'started' AND response IS NULL AND finished_at IS NULL AND attempted_pages IS NULL)
    OR (state = 'interrupted' AND response IS NULL AND finished_at IS NOT NULL AND attempted_pages IS NULL)
    OR (state = 'finished' AND response IS NOT NULL AND finished_at IS NOT NULL)),
  CHECK ((purpose = 'source_preflight' AND context->>'purpose' = 'source_preflight')
    OR (purpose = 'full_ocr' AND context->>'purpose' = 'full_ocr'))
);
CREATE UNIQUE INDEX bb_ocr_v2_batch_owner_request ON bb_ocr_v2_batches(owner_user_id, id);
CREATE INDEX bb_ocr_v2_batch_source ON bb_ocr_v2_batches
  (owner_user_id, project_id, material_id, material_version, purpose, created_at);

CREATE TABLE bb_ocr_v2_pages (
  owner_user_id text NOT NULL,
  project_id text NOT NULL,
  material_id text NOT NULL,
  material_version integer NOT NULL,
  identity_sha256 char(64) NOT NULL,
  result_sha256 char(64) NOT NULL,
  source_request_id text NOT NULL,
  page integer NOT NULL CHECK (page BETWEEN 1 AND 1500),
  checkpoint_key text NOT NULL,
  checkpoint_blob_sha256 char(64) NOT NULL,
  image_key text NOT NULL,
  image_sha256 char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, project_id, identity_sha256),
  FOREIGN KEY (owner_user_id, source_request_id)
    REFERENCES bb_ocr_v2_batches(owner_user_id, id),
  FOREIGN KEY (owner_user_id, project_id, material_id, material_version)
    REFERENCES bb_material_versions(owner_user_id, project_id, id, version)
);
CREATE INDEX bb_ocr_v2_page_source ON bb_ocr_v2_pages
  (owner_user_id, project_id, material_id, material_version, page);

CREATE FUNCTION bb_guard_ocr_v2_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'OCR v2 evidence is append-only' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER bb_ocr_v2_page_immutable BEFORE UPDATE OR DELETE ON bb_ocr_v2_pages
  FOR EACH ROW EXECUTE FUNCTION bb_guard_ocr_v2_evidence();
CREATE FUNCTION bb_guard_ocr_v2_batch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.state <> 'started'
    OR NEW.id IS DISTINCT FROM OLD.id
    OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.material_id IS DISTINCT FROM OLD.material_id
    OR NEW.material_version IS DISTINCT FROM OLD.material_version
    OR NEW.document_identity IS DISTINCT FROM OLD.document_identity
    OR NEW.context IS DISTINCT FROM OLD.context
    OR NEW.job_id IS DISTINCT FROM OLD.job_id
    OR NEW.purpose IS DISTINCT FROM OLD.purpose
    OR NEW.request IS DISTINCT FROM OLD.request
    OR NEW.state = 'started'
  THEN RAISE EXCEPTION 'OCR v2 batch binding is immutable' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bb_ocr_v2_batch_guard BEFORE UPDATE OR DELETE ON bb_ocr_v2_batches
  FOR EACH ROW EXECUTE FUNCTION bb_guard_ocr_v2_batch();
