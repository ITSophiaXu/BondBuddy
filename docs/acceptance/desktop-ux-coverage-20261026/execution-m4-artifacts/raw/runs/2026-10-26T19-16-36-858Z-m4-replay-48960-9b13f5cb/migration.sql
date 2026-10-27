-- Version the immutable M4 Word registry without changing publication or fees.
-- QA remains a separate, precisely typed legacy text branch. A missing Word
-- canonical row never falls back to the legacy Word registry. Existing frozen
-- delivery receipts retain their independent generic download authority.
-- Drain run -> job promoters before descendants. A rolling writer may already
-- own a registry/table lock, so every existing-table lock is nonblocking.
LOCK TABLE bb_input_revisions IN ACCESS SHARE MODE NOWAIT;
LOCK TABLE bb_runs IN EXCLUSIVE MODE NOWAIT;
LOCK TABLE bb_jobs IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE bb_artifact_versions IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE bb_run_execution_versions IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE bb_m4_execution_snapshots IN ACCESS EXCLUSIVE MODE NOWAIT;
LOCK TABLE bb_artifact_execution_bindings IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE bb_m4_artifacts IN SHARE ROW EXCLUSIVE MODE NOWAIT;

ALTER TABLE bb_m4_execution_snapshots ADD CONSTRAINT bb_m4_execution_snapshot_artifact_key
  UNIQUE(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash,topic_id);

CREATE TABLE bb_m4_execution_artifacts (
  owner_user_id text NOT NULL, project_id text NOT NULL, run_id text NOT NULL,
  execution_version integer NOT NULL CHECK(execution_version>0),
  input_revision integer NOT NULL CHECK(input_revision>0),
  input_hash char(64) NOT NULL CHECK(input_hash ~ '^[a-f0-9]{64}$'),
  topic_id text NOT NULL, artifact_id text NOT NULL,
  artifact_version integer NOT NULL CHECK(artifact_version>0),
  kind text NOT NULL CHECK(kind IN ('document','preparation_note')),
  filename text NOT NULL, byte_size bigint NOT NULL CHECK(byte_size>0),
  document_type text CHECK(document_type IN ('init','private_summary','underwriter','legal','application','recommendation',
    'annual','semiannual','issuer','financial','credit','proceeds')),
  base_artifact jsonb, body_content text, preview_content text,
  created_at timestamptz NOT NULL DEFAULT now(),
  revision_number integer CHECK(revision_number>0),
  PRIMARY KEY(run_id,execution_version,kind),
  UNIQUE(artifact_id,artifact_version),
  FOREIGN KEY(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash)
    REFERENCES bb_run_execution_versions(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash),
  FOREIGN KEY(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash,topic_id)
    REFERENCES bb_m4_execution_snapshots(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash,topic_id),
  FOREIGN KEY(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash,artifact_id,artifact_version)
    REFERENCES bb_artifact_execution_bindings(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash,artifact_id,artifact_version)
);
CREATE UNIQUE INDEX bb_m4_execution_document_revision_number
  ON bb_m4_execution_artifacts(topic_id,document_type,revision_number) WHERE kind='document';
CREATE INDEX bb_m4_execution_artifact_scope_idx
  ON bb_m4_execution_artifacts(owner_user_id,project_id,run_id,execution_version);

CREATE FUNCTION bb_check_m4_execution_artifact() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owned_run text;
BEGIN
  SELECT r.id INTO STRICT owned_run
  FROM bb_runs r
  JOIN bb_jobs j ON j.owner_user_id=r.owner_user_id AND j.run_id=r.id
  JOIN bb_run_execution_versions e ON e.owner_user_id=r.owner_user_id AND e.project_id=r.project_id AND e.run_id=r.id
    AND e.input_revision=r.input_revision AND e.input_hash=r.input_hash
  JOIN bb_m4_execution_snapshots s ON s.owner_user_id=e.owner_user_id AND s.project_id=e.project_id AND s.run_id=e.run_id
    AND s.execution_version=e.execution_version AND s.input_revision=e.input_revision AND s.input_hash=e.input_hash
  JOIN bb_input_revisions i ON i.owner_user_id=e.owner_user_id AND i.project_id=e.project_id
    AND i.revision=e.input_revision AND i.input_hash=e.input_hash AND i.manifest=s.manifest
  JOIN bb_m4_topics t ON t.owner_user_id=s.owner_user_id AND t.project_id=s.project_id AND t.id=s.topic_id
  JOIN bb_artifact_execution_bindings b ON b.owner_user_id=e.owner_user_id AND b.project_id=e.project_id AND b.run_id=e.run_id
    AND b.execution_version=e.execution_version AND b.input_revision=e.input_revision AND b.input_hash=e.input_hash
  JOIN bb_execution_artifact_versions a ON a.owner_user_id=b.owner_user_id AND a.run_id=b.run_id
    AND a.id=b.artifact_id AND a.version=b.artifact_version AND a.created_at=b.created_at
  WHERE e.owner_user_id=NEW.owner_user_id AND e.project_id=NEW.project_id AND e.run_id=NEW.run_id
    AND e.execution_version=NEW.execution_version AND e.input_revision=NEW.input_revision AND e.input_hash=NEW.input_hash
    AND s.topic_id=NEW.topic_id AND a.id=NEW.artifact_id AND a.version=NEW.artifact_version
    AND r.task_kind='generation' AND j.subtype='m4_document_v1'
    AND s.manifest->>'version'='m4-document-input-v1' AND s.manifest->>'kind'='document'
    AND s.manifest#>>'{input,document_type}'=NEW.document_type
    AND COALESCE(s.manifest#>'{input,edit_base}','null'::jsonb)=COALESCE(NEW.base_artifact,'null'::jsonb)
    AND a.media_type='application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    AND e.execution_version=1 AND (SELECT count(*) FROM bb_run_execution_versions WHERE run_id=r.id)=1
  FOR KEY SHARE OF r NOWAIT;
  -- This validates provenance, including retained/revoked candidates. Delivery
  -- status, readback readiness and publication remain separate consumer gates.
  IF EXISTS(SELECT 1 FROM bb_m4_execution_artifacts c
    WHERE ((c.run_id=NEW.run_id AND c.execution_version=NEW.execution_version AND c.kind=NEW.kind)
      OR (c.artifact_id=NEW.artifact_id AND c.artifact_version=NEW.artifact_version))
      AND to_jsonb(c) IS DISTINCT FROM to_jsonb(NEW)) THEN
    RAISE EXCEPTION 'M4 execution Word registration replay must preserve every field'
      USING ERRCODE='23514',CONSTRAINT='bb_m4_execution_artifact_replay';
  END IF;
  RETURN NEW;
EXCEPTION WHEN NO_DATA_FOUND THEN
  RAISE EXCEPTION 'M4 Word registration requires its exact owned V1 document execution and artifact origin'
    USING ERRCODE='23514',CONSTRAINT='bb_m4_execution_artifact_origin';
END; $$;
CREATE TRIGGER bb_m4_execution_artifact_exact BEFORE INSERT ON bb_m4_execution_artifacts
  FOR EACH ROW EXECUTE FUNCTION bb_check_m4_execution_artifact();
CREATE TRIGGER bb_m4_execution_artifact_immutable BEFORE UPDATE OR DELETE ON bb_m4_execution_artifacts
  FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();

-- Preserve every legacy Word field, its real registration timestamp and any
-- pre-0095 NULL draft sequence. LEFT JOIN makes incompatible origin fail rather
-- than silently omitting a row; historical delivery gaps are not repaired here.
INSERT INTO bb_m4_execution_artifacts(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash,
  topic_id,artifact_id,artifact_version,kind,filename,byte_size,document_type,base_artifact,body_content,preview_content,created_at,revision_number)
SELECT legacy.owner_user_id,e.project_id,legacy.run_id,e.execution_version,e.input_revision,legacy.input_hash,
  legacy.topic_id,legacy.artifact_id,legacy.artifact_version,legacy.kind,legacy.filename,legacy.byte_size,legacy.document_type,
  legacy.base_artifact,legacy.body_content,legacy.preview_content,legacy.created_at,legacy.revision_number
FROM bb_m4_artifacts legacy LEFT JOIN bb_runs r ON r.owner_user_id=legacy.owner_user_id AND r.id=legacy.run_id
LEFT JOIN bb_run_execution_versions e ON e.owner_user_id=r.owner_user_id AND e.project_id=r.project_id AND e.run_id=r.id AND e.execution_version=1
WHERE legacy.kind IN ('document','preparation_note');

-- A rolling legacy INSERT must join the parent protocol before it owns a
-- unique registry slot or reaches a blocking parent FK. Otherwise a canonical
-- production writer holding run -> job could wait on that legacy slot while
-- its old writer waits on the run. Do not wait in this reversed order.
CREATE FUNCTION bb_guard_legacy_m4_artifact() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owned_run text;
BEGIN
  IF NEW.kind NOT IN ('document','preparation_note') THEN RETURN NEW; END IF;
  SELECT r.id INTO STRICT owned_run FROM bb_runs r
  JOIN bb_run_execution_versions e ON e.owner_user_id=r.owner_user_id AND e.project_id=r.project_id AND e.run_id=r.id
    AND e.execution_version=1 AND e.input_revision=r.input_revision AND e.input_hash=r.input_hash
  JOIN bb_m4_execution_snapshots s ON s.owner_user_id=e.owner_user_id AND s.project_id=e.project_id AND s.run_id=e.run_id
    AND s.execution_version=e.execution_version AND s.input_revision=e.input_revision AND s.input_hash=e.input_hash
  JOIN bb_jobs j ON j.owner_user_id=r.owner_user_id AND j.run_id=r.id
  WHERE r.owner_user_id=NEW.owner_user_id AND r.id=NEW.run_id AND e.input_hash=NEW.input_hash AND s.topic_id=NEW.topic_id
    AND r.task_kind='generation' AND j.subtype='m4_document_v1'
    AND s.manifest->>'version'='m4-document-input-v1' AND s.manifest->>'kind'='document'
    AND (SELECT count(*) FROM bb_run_execution_versions WHERE run_id=r.id)=1
  FOR KEY SHARE OF r NOWAIT;
  -- BEFORE INSERT also runs for ON CONFLICT DO NOTHING; the AFTER bridge alone
  -- cannot reject a conflicting replay that the unique constraint suppresses.
  IF EXISTS(SELECT 1 FROM bb_m4_artifacts legacy
    WHERE ((legacy.run_id=NEW.run_id AND legacy.kind=NEW.kind)
      OR (legacy.artifact_id=NEW.artifact_id AND legacy.artifact_version=NEW.artifact_version))
      AND to_jsonb(legacy) IS DISTINCT FROM to_jsonb(NEW)) THEN
    RAISE EXCEPTION 'legacy M4 Word registration replay must preserve every field'
      USING ERRCODE='23514',CONSTRAINT='bb_m4_execution_artifact_replay';
  END IF;
  RETURN NEW;
EXCEPTION WHEN NO_DATA_FOUND THEN
  RAISE EXCEPTION 'legacy M4 Word registration requires its exact owned V1 document execution'
    USING ERRCODE='23514',CONSTRAINT='bb_m4_execution_artifact_origin';
END; $$;
CREATE TRIGGER bb_m4_artifact_origin_guard BEFORE INSERT ON bb_m4_artifacts
  FOR EACH ROW EXECUTE FUNCTION bb_guard_legacy_m4_artifact();

CREATE FUNCTION bb_bridge_m4_execution_artifact() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE execution bb_run_execution_versions%ROWTYPE;
BEGIN
  IF NEW.kind NOT IN ('document','preparation_note') THEN RETURN NEW; END IF;
  SELECT e.* INTO STRICT execution FROM bb_run_execution_versions e
    JOIN bb_runs r ON r.owner_user_id=e.owner_user_id AND r.project_id=e.project_id AND r.id=e.run_id
    WHERE e.owner_user_id=NEW.owner_user_id AND e.run_id=NEW.run_id AND e.execution_version=1;
  IF EXISTS(SELECT 1 FROM bb_m4_execution_artifacts c WHERE c.run_id=NEW.run_id AND c.execution_version=1 AND c.kind=NEW.kind
    AND (to_jsonb(c)-ARRAY['project_id','execution_version','input_revision'])=to_jsonb(NEW)) THEN RETURN NEW; END IF;
  INSERT INTO bb_m4_execution_artifacts(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash,
    topic_id,artifact_id,artifact_version,kind,filename,byte_size,document_type,base_artifact,body_content,preview_content,created_at,revision_number)
  VALUES(NEW.owner_user_id,execution.project_id,NEW.run_id,execution.execution_version,execution.input_revision,NEW.input_hash,
    NEW.topic_id,NEW.artifact_id,NEW.artifact_version,NEW.kind,NEW.filename,NEW.byte_size,NEW.document_type,
    NEW.base_artifact,NEW.body_content,NEW.preview_content,NEW.created_at,NEW.revision_number)
  ON CONFLICT DO NOTHING;
  IF NOT EXISTS(SELECT 1 FROM bb_m4_execution_artifacts c WHERE c.run_id=NEW.run_id AND c.execution_version=1 AND c.kind=NEW.kind
    AND (to_jsonb(c)-ARRAY['project_id','execution_version','input_revision'])=to_jsonb(NEW)) THEN
    RAISE EXCEPTION 'legacy M4 Word registration must exactly mirror its execution registry'
      USING ERRCODE='23514',CONSTRAINT='bb_m4_execution_artifact_mirror';
  END IF;
  RETURN NEW;
EXCEPTION WHEN NO_DATA_FOUND THEN
  RAISE EXCEPTION 'legacy M4 Word registration requires its exact owned V1 execution'
    USING ERRCODE='23514',CONSTRAINT='bb_m4_execution_artifact_origin';
END; $$;
CREATE TRIGGER bb_m4_execution_artifact_bridge AFTER INSERT ON bb_m4_artifacts
  FOR EACH ROW EXECUTE FUNCTION bb_bridge_m4_execution_artifact();

CREATE FUNCTION bb_mirror_m4_execution_artifact() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE legacy_row jsonb := to_jsonb(NEW)-ARRAY['project_id','execution_version','input_revision'];
BEGIN
  IF NEW.execution_version<>1 THEN
    RAISE EXCEPTION 'only V1 M4 Word registration mirrors are supported'
      USING ERRCODE='23514',CONSTRAINT='bb_m4_execution_artifact_origin';
  END IF;
  IF EXISTS(SELECT 1 FROM bb_m4_artifacts legacy WHERE legacy.run_id=NEW.run_id AND legacy.kind=NEW.kind
    AND to_jsonb(legacy)=legacy_row) THEN RETURN NEW; END IF;
  INSERT INTO bb_m4_artifacts(owner_user_id,topic_id,run_id,artifact_id,artifact_version,kind,filename,byte_size,
    document_type,base_artifact,input_hash,body_content,preview_content,created_at,revision_number)
  VALUES(NEW.owner_user_id,NEW.topic_id,NEW.run_id,NEW.artifact_id,NEW.artifact_version,NEW.kind,NEW.filename,NEW.byte_size,
    NEW.document_type,NEW.base_artifact,NEW.input_hash,NEW.body_content,NEW.preview_content,NEW.created_at,NEW.revision_number)
  ON CONFLICT DO NOTHING;
  IF NOT EXISTS(SELECT 1 FROM bb_m4_artifacts legacy WHERE legacy.run_id=NEW.run_id AND legacy.kind=NEW.kind
    AND to_jsonb(legacy)=legacy_row) THEN
    RAISE EXCEPTION 'M4 execution Word registration must exactly mirror its legacy registry'
      USING ERRCODE='23514',CONSTRAINT='bb_m4_execution_artifact_mirror';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER bb_m4_execution_artifact_mirror AFTER INSERT ON bb_m4_execution_artifacts
  FOR EACH ROW EXECUTE FUNCTION bb_mirror_m4_execution_artifact();

-- Origin only: no delivery receipt, public availability, terminal state or
-- charging authority is granted by either view. Typed readers also require the
-- existing delivered-member, owner, project, channel and live-status gates.
CREATE VIEW bb_m4_execution_artifact_versions AS
SELECT c.*,s.manifest,a.sha256 AS artifact_sha256,a.media_type,a.object_key,a.quality_status,a.delivery_status,
  a.created_at AS artifact_created_at
FROM bb_m4_execution_artifacts c
JOIN bb_run_execution_versions e ON e.owner_user_id=c.owner_user_id AND e.project_id=c.project_id AND e.run_id=c.run_id
  AND e.execution_version=c.execution_version AND e.input_revision=c.input_revision AND e.input_hash=c.input_hash
JOIN bb_m4_execution_snapshots s ON s.owner_user_id=c.owner_user_id AND s.project_id=c.project_id AND s.run_id=c.run_id
  AND s.execution_version=c.execution_version AND s.input_revision=c.input_revision AND s.input_hash=c.input_hash AND s.topic_id=c.topic_id
JOIN bb_input_revisions i ON i.owner_user_id=c.owner_user_id AND i.project_id=c.project_id
  AND i.revision=c.input_revision AND i.input_hash=c.input_hash AND i.manifest=s.manifest
JOIN bb_runs r ON r.owner_user_id=c.owner_user_id AND r.project_id=c.project_id AND r.id=c.run_id
  AND r.input_revision=c.input_revision AND r.input_hash=c.input_hash
JOIN bb_jobs j ON j.owner_user_id=c.owner_user_id AND j.run_id=c.run_id
JOIN bb_m4_topics t ON t.owner_user_id=c.owner_user_id AND t.project_id=c.project_id AND t.id=c.topic_id
JOIN bb_artifact_execution_bindings b ON b.owner_user_id=c.owner_user_id AND b.project_id=c.project_id AND b.run_id=c.run_id
  AND b.execution_version=c.execution_version AND b.input_revision=c.input_revision AND b.input_hash=c.input_hash
  AND b.artifact_id=c.artifact_id AND b.artifact_version=c.artifact_version
JOIN bb_execution_artifact_versions a ON a.owner_user_id=c.owner_user_id AND a.run_id=c.run_id
  AND a.id=c.artifact_id AND a.version=c.artifact_version AND a.created_at=b.created_at
WHERE r.task_kind='generation' AND j.subtype='m4_document_v1'
  AND s.manifest->>'version'='m4-document-input-v1' AND s.manifest->>'kind'='document'
  AND s.manifest#>>'{input,document_type}'=c.document_type
  AND COALESCE(s.manifest#>'{input,edit_base}','null'::jsonb)=COALESCE(c.base_artifact,'null'::jsonb)
  AND a.media_type='application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  AND e.execution_version=1 AND (SELECT count(*) FROM bb_run_execution_versions WHERE run_id=c.run_id)=1;

-- Exactly 18 columns for mixed old/new M4 consumers. The second UNION branch
-- is explicitly QA text; it cannot supply a missing canonical Word selection.
CREATE VIEW bb_m4_artifact_execution_versions AS
SELECT c.owner_user_id,c.project_id,c.run_id,c.execution_version,c.input_revision,c.input_hash,
  c.topic_id,c.artifact_id,c.artifact_version,c.kind,c.filename,c.byte_size,c.document_type,c.base_artifact,
  c.body_content,c.preview_content,c.created_at,c.revision_number
FROM bb_m4_execution_artifact_versions c
UNION ALL
SELECT q.owner_user_id,e.project_id,q.run_id,e.execution_version,e.input_revision,q.input_hash,
  q.topic_id,q.artifact_id,q.artifact_version,q.kind,q.filename,q.byte_size,q.document_type,q.base_artifact,
  q.body_content,q.preview_content,q.created_at,q.revision_number
FROM bb_m4_artifacts q
JOIN bb_runs r ON r.owner_user_id=q.owner_user_id AND r.id=q.run_id
JOIN bb_jobs j ON j.owner_user_id=r.owner_user_id AND j.run_id=r.id
JOIN bb_run_execution_versions e ON e.owner_user_id=r.owner_user_id AND e.project_id=r.project_id AND e.run_id=r.id
  AND e.input_revision=r.input_revision AND e.input_hash=r.input_hash AND e.input_hash=q.input_hash
JOIN bb_m4_execution_snapshots s ON s.owner_user_id=e.owner_user_id AND s.project_id=e.project_id AND s.run_id=e.run_id
  AND s.execution_version=e.execution_version AND s.input_revision=e.input_revision AND s.input_hash=e.input_hash AND s.topic_id=q.topic_id
JOIN bb_input_revisions i ON i.owner_user_id=e.owner_user_id AND i.project_id=e.project_id
  AND i.revision=e.input_revision AND i.input_hash=e.input_hash AND i.manifest=s.manifest
JOIN bb_m4_topics t ON t.owner_user_id=s.owner_user_id AND t.project_id=s.project_id AND t.id=s.topic_id
JOIN bb_artifact_execution_bindings b ON b.owner_user_id=e.owner_user_id AND b.project_id=e.project_id AND b.run_id=e.run_id
  AND b.execution_version=e.execution_version AND b.input_revision=e.input_revision AND b.input_hash=e.input_hash
  AND b.artifact_id=q.artifact_id AND b.artifact_version=q.artifact_version
JOIN bb_execution_artifact_versions a ON a.owner_user_id=q.owner_user_id AND a.run_id=q.run_id
  AND a.id=q.artifact_id AND a.version=q.artifact_version AND a.created_at=b.created_at
JOIN bb_m4_text_delivery_evidence evidence ON evidence.id=a.m4_text_delivery_evidence_id
  AND evidence.owner_user_id=a.owner_user_id AND evidence.run_id=a.run_id
  AND evidence.artifact_id=a.id AND evidence.artifact_version=a.version AND evidence.sha256=a.sha256
  AND evidence.byte_size=q.byte_size AND evidence.content=q.body_content
WHERE q.kind='qa_text' AND a.media_type='text/plain' AND r.task_kind='qa' AND r.channel='production' AND j.subtype='m4_qa_v1'
  AND s.manifest->>'version'='m4-qa-input-v1' AND s.manifest->>'kind'='qa'
  AND evidence.byte_size=octet_length(evidence.content) AND encode(sha256(convert_to(evidence.content,'UTF8')),'hex')=a.sha256
  AND e.execution_version=1 AND (SELECT count(*) FROM bb_run_execution_versions WHERE run_id=q.run_id)=1;

COMMENT ON TABLE bb_m4_execution_artifacts IS
  'Immutable exact V1 M4 Word registrations with preserved legacy metadata, insertion bridges and draft sequence. No adoption, successor execution, new billing or publication authority.';
COMMENT ON VIEW bb_m4_artifact_execution_versions IS
  'Provenance only: canonical Word plus explicitly typed exact legacy QA text. Typed public readers still require delivered membership; frozen generic receipts remain independent.';


-- Preserve the 0129 builder except its M4 registration, naming and typed capture gates.
CREATE OR REPLACE FUNCTION bb_run_execution_delivery_plan(owned_by text, target_run text, origin text, phase text DEFAULT 'final')
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r bb_runs%ROWTYPE; j bb_jobs%ROWTYPE; e bb_run_execution_versions%ROWTYPE;
  d bb_run_execution_deliveries%ROWTYPE; a bb_artifact_versions%ROWTYPE;
  pair jsonb; refs jsonb; item jsonb; member jsonb; members jsonb := '[]'::jsonb;
  role_name text; member_role text; member_version integer; matches integer; existing jsonb;
  review_version integer; m4_manifest jsonb; terminal_event bb_run_events%ROWTYPE;
  registration_count integer; registration_kind text;
BEGIN
  IF phase NOT IN ('final','m4_durable') OR origin NOT IN ('terminal_transition','m4_durable_registration','legacy_backfill')
    OR (phase='final' AND origin='m4_durable_registration') OR (phase='m4_durable' AND origin='terminal_transition') THEN
    RAISE EXCEPTION 'unsupported delivery source' USING ERRCODE='23514',CONSTRAINT='bb_execution_delivery_exact';
  END IF;
  SELECT * INTO STRICT r FROM bb_runs WHERE owner_user_id=owned_by AND id=target_run FOR UPDATE;
  SELECT * INTO STRICT j FROM bb_jobs WHERE owner_user_id=owned_by AND run_id=r.id FOR UPDATE;
  IF r.task_kind='platform_probe' OR j.job_type='platform_probe' THEN RETURN NULL; END IF;
  IF phase='m4_durable' THEN
    -- Preserve the existing non-dynamic M4 durable-read contract. This records
    -- persistence, never terminal success or a new billing authorization.
    IF r.channel<>'production' OR j.subtype NOT IN ('m4_document_v1','m4_qa_v1') OR EXISTS(
      SELECT 1 FROM bb_credit_reservations c WHERE c.id=r.reservation_id AND c.owner_user_id=r.owner_user_id AND c.billing_policy='authoring_balance_v2'
    ) THEN RETURN NULL; END IF;
    registration_kind:=CASE WHEN j.subtype='m4_qa_v1' THEN 'qa_text' ELSE 'document' END;
    SELECT count(*) INTO registration_count FROM bb_m4_artifact_execution_versions q WHERE q.owner_user_id=r.owner_user_id AND q.project_id=r.project_id AND q.run_id=r.id AND q.execution_version=1 AND q.input_revision=r.input_revision AND q.input_hash=r.input_hash;
    -- Some existing callers register document and note in two transactions.
    -- The first call is a no-op; it must not freeze a partial delivery.
    IF registration_count<>(CASE WHEN registration_kind='qa_text' THEN 1 ELSE 2 END)
      OR NOT EXISTS(SELECT 1 FROM bb_m4_artifact_execution_versions WHERE owner_user_id=r.owner_user_id AND project_id=r.project_id AND run_id=r.id AND execution_version=1 AND input_revision=r.input_revision AND input_hash=r.input_hash AND kind=registration_kind)
      OR (registration_kind='document' AND NOT EXISTS(SELECT 1 FROM bb_m4_artifact_execution_versions WHERE owner_user_id=r.owner_user_id AND project_id=r.project_id AND run_id=r.id AND execution_version=1 AND input_revision=r.input_revision AND input_hash=r.input_hash AND kind='preparation_note')) THEN RETURN NULL; END IF;
    SELECT artifact_id,artifact_version INTO STRICT r.artifact_id,r.artifact_version FROM bb_m4_artifact_execution_versions
      WHERE owner_user_id=r.owner_user_id AND project_id=r.project_id AND run_id=r.id AND execution_version=1 AND input_revision=r.input_revision AND input_hash=r.input_hash AND kind=registration_kind;
  ELSIF r.artifact_id IS NULL THEN RETURN NULL;
  END IF;
  IF phase='final' AND (r.state NOT IN ('succeeded','test_completed') OR j.state<>r.state OR r.artifact_version IS NULL
    OR j.lease_token IS NOT NULL OR j.lease_until IS NOT NULL) THEN
    RAISE EXCEPTION 'completed user delivery required' USING ERRCODE='23514',CONSTRAINT='bb_execution_delivery_terminal';
  END IF;
  -- V1 remains the only executable version. Never infer a successor from a
  -- matching input or the newest draft. A future active cursor replaces this.
  SELECT * INTO STRICT e FROM bb_run_execution_versions
    WHERE owner_user_id=r.owner_user_id AND project_id=r.project_id AND run_id=r.id AND execution_version=1;
  IF e.input_revision<>r.input_revision OR e.input_hash<>r.input_hash
    OR (SELECT count(*) FROM bb_run_execution_versions WHERE run_id=r.id)<>1 THEN
    RAISE EXCEPTION 'delivery execution does not match its fixed input' USING ERRCODE='23514',CONSTRAINT='bb_execution_delivery_exact';
  END IF;
  d.owner_user_id:=r.owner_user_id; d.project_id:=r.project_id; d.run_id:=r.id;
  d.execution_version:=e.execution_version; d.input_revision:=e.input_revision; d.input_hash:=e.input_hash;
  d.delivery_phase:=phase; d.terminal_state:=CASE WHEN phase='final' THEN r.state END;
  d.channel:=r.channel; d.test_grant_id:=r.test_grant_id;
  -- The first capture's source is historical fact. Replays preserve it.
  SELECT source INTO d.source FROM bb_run_execution_deliveries WHERE run_id=r.id AND execution_version=e.execution_version AND delivery_phase=phase;
  d.source:=COALESCE(d.source,origin); origin:=d.source;
  d.primary_artifact_id:=r.artifact_id; d.primary_artifact_version:=r.artifact_version;
  IF phase='m4_durable' THEN
    SELECT max(created_at) INTO d.delivered_at FROM bb_m4_artifact_execution_versions WHERE owner_user_id=r.owner_user_id AND project_id=r.project_id AND run_id=r.id AND execution_version=1 AND input_revision=r.input_revision AND input_hash=r.input_hash;
    d.event_cursor:=NULL;
  ELSIF origin='legacy_backfill' THEN
    SELECT * INTO STRICT terminal_event FROM bb_run_events
      WHERE owner_user_id=r.owner_user_id AND run_id=r.id AND state=r.state AND type='run.state_changed'
        AND seq<=r.event_cursor ORDER BY seq DESC LIMIT 1;
    IF EXISTS(SELECT 1 FROM bb_run_events WHERE run_id=r.id AND seq>terminal_event.seq AND state<>r.state) THEN
      RAISE EXCEPTION 'ambiguous historical terminal event' USING ERRCODE='23514',CONSTRAINT='bb_execution_delivery_history';
    END IF;
    d.delivered_at:=terminal_event.occurred_at; d.event_cursor:=terminal_event.seq;
  ELSE
    -- The event INSERT follows the run UPDATE. Do not query a future event.
    d.delivered_at:=r.updated_at; d.event_cursor:=r.event_cursor;
  END IF;
  SELECT manifest INTO STRICT d.naming_manifest FROM bb_input_revisions
    WHERE owner_user_id=r.owner_user_id AND project_id=r.project_id AND revision=e.input_revision AND input_hash=e.input_hash;
  SELECT s.version INTO review_version FROM bb_review_execution_snapshots s
    WHERE s.owner_user_id=e.owner_user_id AND s.project_id=e.project_id AND s.run_id=e.run_id
      AND s.execution_version=e.execution_version AND s.input_revision=e.input_revision AND s.input_hash=e.input_hash;
  SELECT s.manifest INTO m4_manifest FROM bb_m4_execution_snapshots s
    WHERE s.owner_user_id=e.owner_user_id AND s.project_id=e.project_id AND s.run_id=e.run_id
      AND s.execution_version=e.execution_version AND s.input_revision=e.input_revision AND s.input_hash=e.input_hash;
  IF (EXISTS(SELECT 1 FROM bb_review_executions WHERE run_id=r.id) AND review_version IS NULL)
    OR (EXISTS(SELECT 1 FROM bb_m4_executions WHERE run_id=r.id) AND m4_manifest IS NULL) THEN
    RAISE EXCEPTION 'delivery business snapshot is missing' USING ERRCODE='23514',CONSTRAINT='bb_execution_delivery_exact';
  END IF;
  -- M4 typed capture requires the complete exact registry even when the run's
  -- primary alone would be a valid generic artifact. Do not publish a partial
  -- Word pair or treat a QA subtype/snapshot as document registration fallback.
  IF j.subtype IN ('m4_document_v1','m4_qa_v1') OR m4_manifest IS NOT NULL THEN
    registration_kind:=CASE
      WHEN j.subtype='m4_document_v1' AND r.task_kind='generation'
        AND m4_manifest->>'version'='m4-document-input-v1' AND m4_manifest->>'kind'='document' THEN 'document'
      WHEN j.subtype='m4_qa_v1' AND r.task_kind='qa' AND r.channel='production'
        AND m4_manifest->>'version'='m4-qa-input-v1' AND m4_manifest->>'kind'='qa' THEN 'qa_text'
      ELSE NULL END;
    IF registration_kind IS NULL THEN
      RAISE EXCEPTION 'M4 delivery requires its exact document or QA business type'
        USING ERRCODE='23514',CONSTRAINT='bb_execution_delivery_exact';
    END IF;
    SELECT count(*) INTO registration_count FROM bb_m4_artifact_execution_versions q
      WHERE q.owner_user_id=e.owner_user_id AND q.project_id=e.project_id AND q.run_id=e.run_id
        AND q.execution_version=e.execution_version AND q.input_revision=e.input_revision AND q.input_hash=e.input_hash;
    IF registration_count<>(CASE WHEN registration_kind='qa_text' THEN 1 ELSE 2 END)
      OR NOT EXISTS(SELECT 1 FROM bb_m4_artifact_execution_versions q
        WHERE q.owner_user_id=e.owner_user_id AND q.project_id=e.project_id AND q.run_id=e.run_id
          AND q.execution_version=e.execution_version AND q.input_revision=e.input_revision AND q.input_hash=e.input_hash
          AND q.kind=registration_kind AND q.artifact_id=r.artifact_id AND q.artifact_version=r.artifact_version)
      OR (registration_kind='document' AND NOT EXISTS(SELECT 1 FROM bb_m4_artifact_execution_versions q
        WHERE q.owner_user_id=e.owner_user_id AND q.project_id=e.project_id AND q.run_id=e.run_id
          AND q.execution_version=e.execution_version AND q.input_revision=e.input_revision AND q.input_hash=e.input_hash
          AND q.kind='preparation_note')) THEN
      RAISE EXCEPTION 'M4 delivery requires its complete exact registered output and primary'
        USING ERRCODE='23514',CONSTRAINT='bb_execution_delivery_member';
    END IF;
  END IF;
  d.naming_review_version:=review_version; d.naming_m4_manifest:=m4_manifest;
  pair:=CASE WHEN phase='final' THEN j.checkpoint#>'{stages,word_delivery_pair}' END;
  IF pair='null'::jsonb THEN pair:=NULL; END IF;
  refs:=jsonb_build_array(jsonb_build_object('artifact_id',r.artifact_id,'artifact_version',r.artifact_version,'role','primary'));
  IF pair IS NOT NULL THEN
    IF jsonb_typeof(pair)<>'object' OR jsonb_typeof(pair->'revision_artifact_id') IS DISTINCT FROM 'string'
      OR jsonb_typeof(pair->'clean_artifact_id') IS DISTINCT FROM 'string' OR pair->>'revision_artifact_id'<>r.artifact_id THEN
      RAISE EXCEPTION 'delivery pair does not name its primary' USING ERRCODE='23514',CONSTRAINT='bb_execution_delivery_pair';
    END IF;
    FOREACH role_name IN ARRAY ARRAY['revision','clean','baseline'] LOOP
      IF pair ? (role_name||'_artifact_id') THEN
        IF jsonb_typeof(pair->(role_name||'_artifact_id'))<>'string' THEN
          RAISE EXCEPTION 'invalid delivery pair member' USING ERRCODE='23514',CONSTRAINT='bb_execution_delivery_pair';
        END IF;
        refs:=refs||jsonb_build_array(jsonb_build_object('artifact_id',pair->>(role_name||'_artifact_id'),
          'artifact_version',CASE WHEN role_name='revision' THEN to_jsonb(r.artifact_version) ELSE pair->(role_name||'_artifact_version') END,
          'role',role_name));
      END IF;
    END LOOP;
  END IF;
  -- Registries are explicit output selections, unlike the run's pool of
  -- candidates. Only ready, precisely versioned registrations are added.
  SELECT refs||COALESCE(jsonb_agg(x.ref),'[]'::jsonb) INTO refs FROM (
    SELECT jsonb_build_object('artifact_id',v.id,'artifact_version',v.version,'role',q.kind) AS ref
    FROM bb_review_execution_artifacts q JOIN bb_artifact_versions v ON v.owner_user_id=q.owner_user_id AND v.run_id=q.run_id AND v.id=q.artifact_id AND v.version=q.artifact_version
    WHERE phase='final' AND q.owner_user_id=e.owner_user_id AND q.project_id=e.project_id AND q.run_id=e.run_id
      AND q.execution_version=e.execution_version AND q.input_revision=e.input_revision AND q.input_hash=e.input_hash
      AND bb_execution_delivery_artifact_ready(v,r.channel,d.delivered_at)
    UNION ALL
    SELECT jsonb_build_object('artifact_id',v.id,'artifact_version',v.version,'role',q.kind)
    FROM bb_m4_artifact_execution_versions q JOIN bb_artifact_versions v ON v.owner_user_id=q.owner_user_id AND v.run_id=q.run_id AND v.id=q.artifact_id AND v.version=q.artifact_version
    -- Every M4 registration is mandatory. Let the exact member loop reject an
    -- unavailable note instead of silently publishing only its ready document.
    WHERE q.owner_user_id=r.owner_user_id AND q.project_id=r.project_id AND q.run_id=r.id AND q.execution_version=1 AND q.input_revision=r.input_revision AND q.input_hash=r.input_hash
    UNION ALL
    SELECT jsonb_build_object('artifact_id',v.id,'artifact_version',v.version,'role',q.kind)
    FROM bb_integrity_artifacts q JOIN bb_artifact_versions v ON v.owner_user_id=q.owner_user_id AND v.run_id=q.run_id AND v.id=q.artifact_id AND v.version=q.artifact_version
    WHERE phase='final' AND q.owner_user_id=r.owner_user_id AND q.run_id=r.id AND bb_execution_delivery_artifact_ready(v,r.channel,d.delivered_at)
  ) x;
  FOR item IN SELECT value FROM jsonb_array_elements(refs) LOOP
    member_role:=item->>'role'; member_version:=NULL;
    IF item->'artifact_version' IS NOT NULL AND item->'artifact_version'<>'null'::jsonb THEN
      IF jsonb_typeof(item->'artifact_version')<>'number' OR (item->>'artifact_version') !~ '^[1-9][0-9]*$' THEN
        RAISE EXCEPTION 'invalid delivery artifact version' USING ERRCODE='23514',CONSTRAINT='bb_execution_delivery_pair';
      END IF;
      member_version:=(item->>'artifact_version')::integer;
    END IF;
    SELECT count(*),min(v.version) INTO matches,member_version
    -- PostgreSQL gives a view its own composite type. Pass a real base-table
    -- row to the readiness helper while retaining the exact provenance gate.
    FROM bb_artifact_versions v
    JOIN bb_execution_artifact_versions verified_origin ON verified_origin.owner_user_id=v.owner_user_id AND verified_origin.run_id=v.run_id
      AND verified_origin.id=v.id AND verified_origin.version=v.version AND verified_origin.sha256=v.sha256 AND verified_origin.created_at=v.created_at
    JOIN bb_artifact_execution_bindings b ON b.artifact_id=v.id AND b.artifact_version=v.version
    WHERE v.owner_user_id=e.owner_user_id AND v.run_id=e.run_id AND v.id=item->>'artifact_id'
      AND (member_version IS NULL OR v.version=member_version)
      AND b.project_id=e.project_id AND b.execution_version=e.execution_version AND b.input_revision=e.input_revision AND b.input_hash=e.input_hash
      AND bb_execution_delivery_artifact_ready(v,r.channel,d.delivered_at);
    IF matches<>1 THEN
      RAISE EXCEPTION 'delivery member requires one exact verified artifact version' USING ERRCODE='23514',CONSTRAINT='bb_execution_delivery_member';
    END IF;
    SELECT * INTO STRICT a FROM bb_artifact_versions WHERE owner_user_id=r.owner_user_id AND run_id=r.id AND id=item->>'artifact_id' AND version=member_version FOR SHARE;
    IF pair IS NOT NULL AND member_role IN ('revision','clean','baseline') THEN
      IF pair ? (member_role||'_artifact_version') AND pair->(member_role||'_artifact_version') IS DISTINCT FROM to_jsonb(member_version) THEN
        RAISE EXCEPTION 'delivery pair version differs from exact member' USING ERRCODE='23514',CONSTRAINT='bb_execution_delivery_pair';
      END IF;
      pair:=pair||jsonb_build_object(member_role||'_artifact_version',member_version);
    END IF;
    SELECT value INTO existing FROM jsonb_array_elements(members)
      WHERE value->>'artifact_id'=a.id AND (value->>'artifact_version')::integer=a.version;
    IF existing IS NOT NULL THEN
      IF member_role='primary' OR existing->>'role'=member_role THEN CONTINUE; END IF;
      IF existing->>'role'<>'primary' THEN
        RAISE EXCEPTION 'one delivered file has conflicting roles' USING ERRCODE='23514',CONSTRAINT='bb_execution_delivery_member';
      END IF;
      SELECT COALESCE(jsonb_agg(value),'[]'::jsonb) INTO members FROM jsonb_array_elements(members)
        WHERE NOT(value->>'artifact_id'=a.id AND (value->>'artifact_version')::integer=a.version);
    END IF;
    member:=jsonb_build_object('artifact_id',a.id,'artifact_version',a.version,'artifact_sha256',a.sha256,
      'role',member_role,'is_primary',a.id=r.artifact_id AND a.version=r.artifact_version,
      'naming_created_at',to_char(a.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'naming_integrity_kind',(SELECT kind FROM bb_integrity_artifacts WHERE owner_user_id=r.owner_user_id AND run_id=r.id AND artifact_id=a.id AND artifact_version=a.version),
      'naming_review_kind',(SELECT kind FROM bb_review_execution_artifacts WHERE owner_user_id=e.owner_user_id AND project_id=e.project_id AND run_id=e.run_id AND execution_version=e.execution_version AND input_revision=e.input_revision AND input_hash=e.input_hash AND artifact_id=a.id AND artifact_version=a.version),
      'naming_m4_kind',(SELECT kind FROM bb_m4_artifact_execution_versions WHERE owner_user_id=r.owner_user_id AND project_id=r.project_id AND run_id=r.id AND execution_version=1 AND input_revision=r.input_revision AND input_hash=r.input_hash AND artifact_id=a.id AND artifact_version=a.version),
      'naming_m4_revision',(SELECT revision_number FROM bb_m4_artifact_execution_versions WHERE owner_user_id=r.owner_user_id AND project_id=r.project_id AND run_id=r.id AND execution_version=1 AND input_revision=r.input_revision AND input_hash=r.input_hash AND artifact_id=a.id AND artifact_version=a.version),
      'naming_m4_type',(SELECT document_type FROM bb_m4_artifact_execution_versions WHERE owner_user_id=r.owner_user_id AND project_id=r.project_id AND run_id=r.id AND execution_version=1 AND input_revision=r.input_revision AND input_hash=r.input_hash AND artifact_id=a.id AND artifact_version=a.version));
    members:=members||jsonb_build_array(member);
    IF a.id=r.artifact_id AND a.version=r.artifact_version THEN d.primary_sha256:=a.sha256; END IF;
  END LOOP;
  SELECT jsonb_agg(value ORDER BY value->>'artifact_id',(value->>'artifact_version')::integer) INTO d.artifact_manifest FROM jsonb_array_elements(members);
  d.word_delivery_pair:=pair;
  RETURN to_jsonb(d);
END; $$;

-- Keep the deployed 0105 finalizer, including the 0106/0111 quote-task
-- extensions and every debit/refund/settlement statement. Replace only its
-- two registry sources and tighten their exact execution/primary predicates.
-- An unexpected predecessor definition must fail instead of modifying a
-- different billing function by a broad textual substitution.
DO $$
DECLARE definition text;
  old_relation text := 'FROM bb_m4_artifacts a JOIN bb_artifact_versions v';
  new_relation text := 'FROM bb_m4_artifact_execution_versions a JOIN bb_artifact_versions v';
  old_scope text := 'WHERE a.owner_user_id=NEW.owner_user_id AND a.run_id=NEW.id AND a.kind';
  new_scope text := 'WHERE a.owner_user_id=NEW.owner_user_id AND a.project_id=NEW.project_id AND a.run_id=NEW.id AND a.execution_version=1 AND a.input_revision=NEW.input_revision AND a.input_hash=NEW.input_hash AND a.kind';
  old_document text := 'a.kind IN (''document'',''preparation_note'')';
  new_document text := 'a.kind IN (''document'',''preparation_note'') AND (a.kind<>''document'' OR (a.artifact_id=NEW.artifact_id AND a.artifact_version=NEW.artifact_version))';
BEGIN
  SELECT pg_get_functiondef('bb_m4_credit_finalize_run()'::regprocedure) INTO definition;
  IF (length(definition)-length(replace(definition,old_relation,'')))/length(old_relation)<>2
    OR (length(definition)-length(replace(definition,old_scope,'')))/length(old_scope)<>2
    OR (length(definition)-length(replace(definition,old_document,'')))/length(old_document)<>1
    OR (length(definition)-length(replace(definition,'bb_m4_artifacts','')))/length('bb_m4_artifacts')<>2
    OR strpos(definition,'''authoring_balance_v2''')=0
    OR strpos(definition,'Dynamic authoring balance not fully settled')=0
    OR strpos(definition,'''m4_G04''')=0 OR strpos(definition,'''m4_application''')=0
    OR strpos(definition,'''m4_proceeds''')=0
    OR strpos(definition,'authoring_platform_failure_refund')=0
    OR strpos(definition,'''qa_text''')=0 THEN
    RAISE EXCEPTION 'Unexpected M4 credit finalizer predecessor definition';
  END IF;
  definition:=replace(definition,old_relation,new_relation);
  definition:=replace(definition,old_scope,new_scope);
  definition:=replace(definition,old_document,new_document);
  EXECUTE definition;
END $$;
