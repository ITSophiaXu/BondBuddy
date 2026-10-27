-- Review artifact rows are selections, not immutable report bodies. Preserve
-- pre-final replacement of a kind's artifact while fixing its exact execution.
-- Final delivery receipts/members remain the immutable publication boundary.
-- No successor execution, input adoption, price or charging policy is enabled.
--
-- Production writers hold run -> job before promoting/registering artifacts;
-- capture holds run -> job as well. Drain those parents before descendants.
-- Every existing-table lock is NOWAIT: a rolling legacy writer may already own
-- its slot while waiting for a parent, so the migration must roll back/retry
-- instead of waiting in the opposite order. No project lock is acquired.
LOCK TABLE bb_input_revisions IN ACCESS SHARE MODE NOWAIT;
LOCK TABLE bb_runs IN EXCLUSIVE MODE NOWAIT;
LOCK TABLE bb_jobs IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE bb_artifact_versions IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE bb_run_execution_versions IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE bb_review_execution_snapshots IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE bb_artifact_execution_bindings IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE bb_run_execution_deliveries,bb_run_execution_delivery_artifacts IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE bb_review_artifacts IN SHARE ROW EXCLUSIVE MODE NOWAIT;

CREATE TABLE bb_review_execution_artifacts (
  owner_user_id text NOT NULL, project_id text NOT NULL, run_id text NOT NULL,
  execution_version integer NOT NULL CHECK(execution_version>0),
  input_revision integer NOT NULL CHECK(input_revision>0),
  input_hash char(64) NOT NULL CHECK(input_hash ~ '^[a-f0-9]{64}$'),
  kind text NOT NULL CHECK(kind IN ('report','comments','revision','clean','baseline')),
  artifact_id text NOT NULL, artifact_version integer NOT NULL CHECK(artifact_version>0),
  filename text NOT NULL,
  PRIMARY KEY(run_id,execution_version,kind),
  FOREIGN KEY(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash)
    REFERENCES bb_run_execution_versions(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash),
  FOREIGN KEY(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash)
    REFERENCES bb_review_execution_snapshots(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash),
  FOREIGN KEY(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash,artifact_id,artifact_version)
    REFERENCES bb_artifact_execution_bindings(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash,artifact_id,artifact_version)
);
CREATE INDEX bb_review_execution_artifact_scope_idx
  ON bb_review_execution_artifacts(owner_user_id,project_id,run_id,execution_version);

CREATE FUNCTION bb_check_review_execution_artifact() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owned_run text;
BEGIN
  IF TG_OP='UPDATE' AND ROW(NEW.owner_user_id,NEW.project_id,NEW.run_id,NEW.execution_version,NEW.input_revision,NEW.input_hash,NEW.kind,NEW.filename)
    IS DISTINCT FROM ROW(OLD.owner_user_id,OLD.project_id,OLD.run_id,OLD.execution_version,OLD.input_revision,OLD.input_hash,OLD.kind,OLD.filename) THEN
    RAISE EXCEPTION 'review artifact slot identity and filename are fixed'
      USING ERRCODE='23514',CONSTRAINT='bb_review_execution_artifact_identity';
  END IF;
  -- The provenance join permits retained/revoked candidates as historical data;
  -- availability and quality remain delivery/reader checks. A slot may refer
  -- only to its own precisely bound artifact, never another run's candidate.
  SELECT r.id INTO STRICT owned_run
  FROM bb_runs r
  JOIN bb_run_execution_versions e ON e.owner_user_id=r.owner_user_id AND e.project_id=r.project_id AND e.run_id=r.id
    AND e.input_revision=r.input_revision AND e.input_hash=r.input_hash
  JOIN bb_review_execution_snapshots s ON s.owner_user_id=e.owner_user_id AND s.project_id=e.project_id AND s.run_id=e.run_id
    AND s.execution_version=e.execution_version AND s.input_revision=e.input_revision AND s.input_hash=e.input_hash
  JOIN bb_input_revisions i ON i.owner_user_id=e.owner_user_id AND i.project_id=e.project_id
    AND i.revision=e.input_revision AND i.input_hash=e.input_hash
  JOIN bb_artifact_execution_bindings b ON b.owner_user_id=e.owner_user_id AND b.project_id=e.project_id AND b.run_id=e.run_id
    AND b.execution_version=e.execution_version AND b.input_revision=e.input_revision AND b.input_hash=e.input_hash
  JOIN bb_execution_artifact_versions a ON a.owner_user_id=b.owner_user_id AND a.run_id=b.run_id
    AND a.id=b.artifact_id AND a.version=b.artifact_version AND a.created_at=b.created_at
  WHERE r.owner_user_id=NEW.owner_user_id AND r.project_id=NEW.project_id AND r.id=NEW.run_id
    AND e.execution_version=NEW.execution_version AND e.input_revision=NEW.input_revision AND e.input_hash=NEW.input_hash
    AND a.id=NEW.artifact_id AND a.version=NEW.artifact_version
    AND e.execution_version=1 AND (SELECT count(*) FROM bb_run_execution_versions WHERE run_id=r.id)=1
  FOR KEY SHARE OF r NOWAIT;
  -- A direct SQL registrar may already own its slot. Never wait for the parent
  -- in that reversed order: KEY SHARE NOWAIT either joins the production lock
  -- protocol or fails with 55P03. Terminal capture's FOR UPDATE serializes both
  -- replacement and a new slot (including INSERT/FK waits) against final freeze.
  RETURN NEW;
EXCEPTION WHEN NO_DATA_FOUND THEN
  RAISE EXCEPTION 'review artifact requires its exact owned V1 execution and artifact origin'
    USING ERRCODE='23514',CONSTRAINT='bb_review_execution_artifact_origin';
END; $$;
CREATE TRIGGER bb_review_execution_artifact_exact BEFORE INSERT OR UPDATE ON bb_review_execution_artifacts
  FOR EACH ROW EXECUTE FUNCTION bb_check_review_execution_artifact();

-- Retain every legacy selection. The LEFT JOIN deliberately turns missing
-- origins into an error instead of skipping rows. There was no registry
-- timestamp in the old table; do not invent one from artifact creation time.
INSERT INTO bb_review_execution_artifacts(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash,kind,artifact_id,artifact_version,filename)
SELECT legacy.owner_user_id,legacy.project_id,legacy.run_id,e.execution_version,e.input_revision,e.input_hash,
  legacy.kind,legacy.artifact_id,legacy.artifact_version,legacy.filename
FROM bb_review_artifacts legacy LEFT JOIN bb_run_execution_versions e
  ON e.owner_user_id=legacy.owner_user_id AND e.project_id=legacy.project_id AND e.run_id=legacy.run_id AND e.execution_version=1;

-- Install the final guard only after the strict origin backfill. A historical
-- successful run may have a 0126 delivery gap, or a registry candidate that was
-- not ready/captured alongside its valid final members. Preserve those exact
-- selections as provenance without inventing membership or repairing a gap.
-- The provenance view below grants no delivered access to such candidates.

CREATE FUNCTION bb_guard_review_execution_artifact() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owned_run text;
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'review artifact slots cannot be deleted'
      USING ERRCODE='23514',CONSTRAINT='bb_review_execution_artifact_identity';
  END IF;
  -- Exact origin is checked by the preceding _exact trigger. Take the same
  -- nonblocking parent lock here as well so this guard has no late-parent wait
  -- and cannot silently treat an unowned/missing run as an unfrozen selection.
  SELECT r.id INTO STRICT owned_run FROM bb_runs r
  WHERE r.owner_user_id=NEW.owner_user_id AND r.project_id=NEW.project_id AND r.id=NEW.run_id
    AND r.input_revision=NEW.input_revision AND r.input_hash=NEW.input_hash
  FOR KEY SHARE NOWAIT;
  IF EXISTS(SELECT 1 FROM bb_run_execution_deliveries d
    WHERE d.owner_user_id=NEW.owner_user_id AND d.project_id=NEW.project_id AND d.run_id=NEW.run_id
      AND d.execution_version=NEW.execution_version AND d.input_revision=NEW.input_revision AND d.input_hash=NEW.input_hash AND d.delivery_phase='final')
    OR EXISTS(SELECT 1 FROM bb_runs r WHERE r.owner_user_id=NEW.owner_user_id AND r.project_id=NEW.project_id AND r.id=NEW.run_id
      AND r.state IN ('succeeded','test_completed')) THEN
    IF TG_OP='UPDATE' AND NEW.artifact_id=OLD.artifact_id AND NEW.artifact_version=OLD.artifact_version THEN RETURN NEW; END IF;
    -- INSERT ... ON CONFLICT may legitimately replay an already frozen slot.
    -- It may not create a new selection or replace that slot after capture.
    IF TG_OP='INSERT' AND EXISTS(SELECT 1 FROM bb_review_execution_artifacts c
      WHERE c.owner_user_id=NEW.owner_user_id AND c.project_id=NEW.project_id AND c.run_id=NEW.run_id
        AND c.execution_version=NEW.execution_version AND c.input_revision=NEW.input_revision AND c.input_hash=NEW.input_hash
        AND c.kind=NEW.kind AND c.filename=NEW.filename AND c.artifact_id=NEW.artifact_id AND c.artifact_version=NEW.artifact_version) THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'review artifact selection is frozen by its final delivery'
      USING ERRCODE='23514',CONSTRAINT='bb_review_execution_artifact_final';
  END IF;
  RETURN NEW;
EXCEPTION WHEN NO_DATA_FOUND THEN
  RAISE EXCEPTION 'review artifact requires its exact owned run'
    USING ERRCODE='23514',CONSTRAINT='bb_review_execution_artifact_origin';
END; $$;
CREATE TRIGGER bb_review_execution_artifact_guard BEFORE INSERT OR UPDATE OR DELETE ON bb_review_execution_artifacts
  FOR EACH ROW EXECUTE FUNCTION bb_guard_review_execution_artifact();

CREATE FUNCTION bb_guard_legacy_review_artifact() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE execution bb_run_execution_versions%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'legacy review artifact slots cannot be deleted'
      USING ERRCODE='23514',CONSTRAINT='bb_review_execution_artifact_identity';
  END IF;
  IF TG_OP='UPDATE' AND ROW(NEW.owner_user_id,NEW.project_id,NEW.run_id,NEW.kind,NEW.filename)
    IS DISTINCT FROM ROW(OLD.owner_user_id,OLD.project_id,OLD.run_id,OLD.kind,OLD.filename) THEN
    RAISE EXCEPTION 'legacy review artifact slot identity and filename are fixed'
      USING ERRCODE='23514',CONSTRAINT='bb_review_execution_artifact_identity';
  END IF;
  SELECT e.* INTO STRICT execution FROM bb_run_execution_versions e JOIN bb_runs r
    ON r.owner_user_id=e.owner_user_id AND r.project_id=e.project_id AND r.id=e.run_id
    AND r.input_revision=e.input_revision AND r.input_hash=e.input_hash
  WHERE e.owner_user_id=NEW.owner_user_id AND e.project_id=NEW.project_id AND e.run_id=NEW.run_id AND e.execution_version=1
    AND (SELECT count(*) FROM bb_run_execution_versions WHERE run_id=r.id)=1
  FOR KEY SHARE OF r NOWAIT;
  IF (EXISTS(SELECT 1 FROM bb_run_execution_deliveries d
    WHERE d.owner_user_id=execution.owner_user_id AND d.project_id=execution.project_id AND d.run_id=execution.run_id
      AND d.execution_version=execution.execution_version AND d.input_revision=execution.input_revision AND d.input_hash=execution.input_hash AND d.delivery_phase='final')
    OR EXISTS(SELECT 1 FROM bb_runs r WHERE r.owner_user_id=NEW.owner_user_id AND r.project_id=NEW.project_id AND r.id=NEW.run_id
      AND r.state IN ('succeeded','test_completed')))
    AND NOT EXISTS(SELECT 1 FROM bb_review_execution_artifacts c
      WHERE c.owner_user_id=NEW.owner_user_id AND c.project_id=NEW.project_id AND c.run_id=NEW.run_id
        AND c.execution_version=execution.execution_version AND c.input_revision=execution.input_revision AND c.input_hash=execution.input_hash
        AND c.kind=NEW.kind AND c.filename=NEW.filename AND c.artifact_id=NEW.artifact_id AND c.artifact_version=NEW.artifact_version) THEN
    RAISE EXCEPTION 'legacy review artifact selection is frozen by its final delivery'
      USING ERRCODE='23514',CONSTRAINT='bb_review_execution_artifact_final';
  END IF;
  RETURN NEW;
EXCEPTION WHEN NO_DATA_FOUND THEN
  RAISE EXCEPTION 'legacy review artifact requires its exact owned V1 run'
    USING ERRCODE='23514',CONSTRAINT='bb_review_execution_artifact_origin';
END; $$;
CREATE TRIGGER bb_review_artifact_slot_guard BEFORE INSERT OR UPDATE OR DELETE ON bb_review_artifacts
  FOR EACH ROW EXECUTE FUNCTION bb_guard_legacy_review_artifact();

CREATE FUNCTION bb_bridge_review_execution_artifact() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE execution bb_run_execution_versions%ROWTYPE;
BEGIN
  SELECT * INTO STRICT execution FROM bb_run_execution_versions
    WHERE owner_user_id=NEW.owner_user_id AND project_id=NEW.project_id AND run_id=NEW.run_id AND execution_version=1;
  -- A canonical-first mirror is already exact. Return before touching the row
  -- that the outer command just inserted/updated; no trigger-depth bypass is
  -- used, and every non-exact bridge still receives the full origin/final guard.
  IF EXISTS(SELECT 1 FROM bb_review_execution_artifacts c
    WHERE c.owner_user_id=NEW.owner_user_id AND c.project_id=NEW.project_id AND c.run_id=NEW.run_id
      AND c.execution_version=execution.execution_version AND c.input_revision=execution.input_revision AND c.input_hash=execution.input_hash
      AND c.kind=NEW.kind AND c.filename=NEW.filename AND c.artifact_id=NEW.artifact_id AND c.artifact_version=NEW.artifact_version) THEN RETURN NEW; END IF;
  INSERT INTO bb_review_execution_artifacts AS c(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash,kind,artifact_id,artifact_version,filename)
  VALUES(NEW.owner_user_id,NEW.project_id,NEW.run_id,execution.execution_version,execution.input_revision,execution.input_hash,NEW.kind,NEW.artifact_id,NEW.artifact_version,NEW.filename)
  ON CONFLICT(run_id,execution_version,kind) DO UPDATE SET artifact_id=EXCLUDED.artifact_id,artifact_version=EXCLUDED.artifact_version
    WHERE c.owner_user_id=EXCLUDED.owner_user_id AND c.project_id=EXCLUDED.project_id
      AND c.input_revision=EXCLUDED.input_revision AND c.input_hash=EXCLUDED.input_hash AND c.filename=EXCLUDED.filename;
  IF NOT EXISTS(SELECT 1 FROM bb_review_execution_artifacts c
    WHERE c.owner_user_id=NEW.owner_user_id AND c.project_id=NEW.project_id AND c.run_id=NEW.run_id
      AND c.execution_version=execution.execution_version AND c.input_revision=execution.input_revision AND c.input_hash=execution.input_hash
      AND c.kind=NEW.kind AND c.filename=NEW.filename AND c.artifact_id=NEW.artifact_id AND c.artifact_version=NEW.artifact_version) THEN
    RAISE EXCEPTION 'legacy review artifact must exactly mirror its V1 execution slot'
      USING ERRCODE='23514',CONSTRAINT='bb_review_execution_artifact_mirror';
  END IF;
  RETURN NEW;
EXCEPTION WHEN NO_DATA_FOUND THEN
  RAISE EXCEPTION 'legacy review artifact requires its exact V1 origin'
    USING ERRCODE='23514',CONSTRAINT='bb_review_execution_artifact_origin';
END; $$;
CREATE TRIGGER bb_review_execution_artifact_bridge AFTER INSERT OR UPDATE ON bb_review_artifacts
  FOR EACH ROW EXECUTE FUNCTION bb_bridge_review_execution_artifact();

CREATE FUNCTION bb_mirror_review_execution_artifact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.execution_version<>1 THEN
    RAISE EXCEPTION 'only V1 review artifact mirrors are supported'
      USING ERRCODE='23514',CONSTRAINT='bb_review_execution_artifact_origin';
  END IF;
  IF EXISTS(SELECT 1 FROM bb_review_artifacts legacy
    WHERE legacy.owner_user_id=NEW.owner_user_id AND legacy.project_id=NEW.project_id AND legacy.run_id=NEW.run_id
      AND legacy.kind=NEW.kind AND legacy.filename=NEW.filename AND legacy.artifact_id=NEW.artifact_id AND legacy.artifact_version=NEW.artifact_version) THEN RETURN NEW; END IF;
  INSERT INTO bb_review_artifacts AS legacy(owner_user_id,project_id,run_id,artifact_id,artifact_version,kind,filename)
  VALUES(NEW.owner_user_id,NEW.project_id,NEW.run_id,NEW.artifact_id,NEW.artifact_version,NEW.kind,NEW.filename)
  ON CONFLICT(run_id,kind) DO UPDATE SET artifact_id=EXCLUDED.artifact_id,artifact_version=EXCLUDED.artifact_version
    WHERE legacy.owner_user_id=EXCLUDED.owner_user_id AND legacy.project_id=EXCLUDED.project_id AND legacy.filename=EXCLUDED.filename;
  IF NOT EXISTS(SELECT 1 FROM bb_review_artifacts legacy
    WHERE legacy.owner_user_id=NEW.owner_user_id AND legacy.project_id=NEW.project_id AND legacy.run_id=NEW.run_id
      AND legacy.kind=NEW.kind AND legacy.filename=NEW.filename AND legacy.artifact_id=NEW.artifact_id AND legacy.artifact_version=NEW.artifact_version) THEN
    RAISE EXCEPTION 'review execution artifact must exactly mirror its legacy V1 slot'
      USING ERRCODE='23514',CONSTRAINT='bb_review_execution_artifact_mirror';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER bb_review_execution_artifact_mirror AFTER INSERT OR UPDATE ON bb_review_execution_artifacts
  FOR EACH ROW EXECUTE FUNCTION bb_mirror_review_execution_artifact();

-- Provenance only: public readers must still require delivered membership and
-- their live owner/project/channel/status checks. The V1 origin gate inherited
-- from bb_execution_artifact_versions remains intact; no current draft is used.
CREATE VIEW bb_review_execution_artifact_versions AS
SELECT c.*,a.sha256 AS artifact_sha256,a.media_type,a.object_key,a.quality_status,a.delivery_status,
  a.created_at AS artifact_created_at,i.manifest,s.version AS review_version,s.operation,s.source_report_id,s.snapshot AS execution_snapshot
FROM bb_review_execution_artifacts c
JOIN bb_run_execution_versions e ON e.owner_user_id=c.owner_user_id AND e.project_id=c.project_id AND e.run_id=c.run_id
  AND e.execution_version=c.execution_version AND e.input_revision=c.input_revision AND e.input_hash=c.input_hash
JOIN bb_review_execution_snapshots s ON s.owner_user_id=c.owner_user_id AND s.project_id=c.project_id AND s.run_id=c.run_id
  AND s.execution_version=c.execution_version AND s.input_revision=c.input_revision AND s.input_hash=c.input_hash
JOIN bb_input_revisions i ON i.owner_user_id=c.owner_user_id AND i.project_id=c.project_id
  AND i.revision=c.input_revision AND i.input_hash=c.input_hash
JOIN bb_runs r ON r.owner_user_id=c.owner_user_id AND r.project_id=c.project_id AND r.id=c.run_id
JOIN bb_artifact_execution_bindings b ON b.owner_user_id=c.owner_user_id AND b.project_id=c.project_id AND b.run_id=c.run_id
  AND b.execution_version=c.execution_version AND b.input_revision=c.input_revision AND b.input_hash=c.input_hash
  AND b.artifact_id=c.artifact_id AND b.artifact_version=c.artifact_version
JOIN bb_execution_artifact_versions a ON a.owner_user_id=b.owner_user_id AND a.run_id=b.run_id
  AND a.id=b.artifact_id AND a.version=b.artifact_version AND a.created_at=b.created_at
WHERE e.execution_version=1 AND (SELECT count(*) FROM bb_run_execution_versions WHERE run_id=c.run_id)=1;

-- Preserve the existing report-only versus correction-three-file settlement
-- rule. Only its source registry changes; prices, debits and outer billing
-- triggers are untouched. Resolve the same fixed V1 tuple rather than a draft.
CREATE OR REPLACE FUNCTION bb_review_delivery_ready(r bb_runs) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE correction boolean; pair jsonb; execution bb_run_execution_versions%ROWTYPE;
BEGIN
 SELECT * INTO execution FROM bb_run_execution_versions e
 WHERE e.owner_user_id=r.owner_user_id AND e.project_id=r.project_id AND e.run_id=r.id AND e.execution_version=1
   AND e.input_revision=r.input_revision AND e.input_hash=r.input_hash
   AND (SELECT count(*) FROM bb_run_execution_versions WHERE run_id=r.id)=1;
 IF NOT FOUND THEN RETURN false; END IF;
 SELECT manifest #>> '{review,file_delivery,version}' = 'review-correction-v2' INTO correction
 FROM bb_input_revisions WHERE owner_user_id=execution.owner_user_id AND project_id=execution.project_id
   AND revision=execution.input_revision AND input_hash=execution.input_hash;
 IF correction IS DISTINCT FROM true THEN
   RETURN EXISTS(SELECT 1 FROM bb_review_execution_artifacts a JOIN bb_execution_artifact_versions v ON v.id=a.artifact_id AND v.version=a.artifact_version
     WHERE a.owner_user_id=execution.owner_user_id AND a.project_id=execution.project_id AND a.run_id=execution.run_id
       AND a.execution_version=execution.execution_version AND a.input_revision=execution.input_revision AND a.input_hash=execution.input_hash AND a.kind='report'
       AND v.owner_user_id=r.owner_user_id AND v.run_id=r.id AND v.id=r.artifact_id AND v.version=r.artifact_version
       AND v.delivery_status='available' AND v.quality_status='passed');
 END IF;
 SELECT checkpoint #> '{stages,word_delivery_pair}' INTO pair FROM bb_jobs WHERE owner_user_id=r.owner_user_id AND run_id=r.id;
 IF pair->>'revision_artifact_id' IS NULL OR pair->>'clean_artifact_id' IS NULL OR r.artifact_id IS DISTINCT FROM pair->>'revision_artifact_id' THEN RETURN false; END IF;
 RETURN (SELECT count(DISTINCT a.kind)=3 FROM bb_review_execution_artifacts a
   JOIN bb_execution_artifact_versions v ON v.id=a.artifact_id AND v.version=a.artifact_version AND v.owner_user_id=a.owner_user_id AND v.run_id=a.run_id
   JOIN bb_word_delivery_evidence evidence ON evidence.id=v.word_delivery_evidence_id AND evidence.owner_user_id=v.owner_user_id AND evidence.run_id=v.run_id
     AND evidence.artifact_id=v.id AND evidence.artifact_version=v.version
   WHERE a.owner_user_id=execution.owner_user_id AND a.project_id=execution.project_id AND a.run_id=execution.run_id
     AND a.execution_version=execution.execution_version AND a.input_revision=execution.input_revision AND a.input_hash=execution.input_hash
     AND v.delivery_status='available' AND v.quality_status='passed' AND evidence.delivery_status='available' AND evidence.delivery_code='readback_verified'
     AND evidence.readback_sha256=v.sha256 AND evidence.candidate_sha256=v.sha256
     AND (a.kind='report' OR (a.kind='revision' AND v.id=r.artifact_id AND v.version=r.artifact_version)
       OR (a.kind='clean' AND v.id=pair->>'clean_artifact_id')));
END; $$;

COMMENT ON TABLE bb_review_execution_artifacts IS
  'Exact V1 review artifact selections; only artifact references can change before final delivery. Final receipts freeze publication, legacy INSERT/UPDATE mirrors stay exact, and no successor/adoption/billing authority is granted.';

-- Replay-test teardown: drop bb_review_execution_artifacts CASCADE, then drop
-- bb_check_review_execution_artifact(),bb_guard_review_execution_artifact(),
-- bb_guard_legacy_review_artifact(),bb_bridge_review_execution_artifact(),
-- bb_mirror_review_execution_artifact() CASCADE to remove both legacy triggers.
-- The replacements below intentionally retain their pre-existing signatures.

-- The 0126 builder below changes only the review membership and naming sources.
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
    SELECT count(*) INTO registration_count FROM bb_m4_artifacts q WHERE q.owner_user_id=r.owner_user_id AND q.run_id=r.id;
    -- Some existing callers register document and note in two transactions.
    -- The first call is a no-op; it must not freeze a partial delivery.
    IF registration_count<>(CASE WHEN registration_kind='qa_text' THEN 1 ELSE 2 END)
      OR NOT EXISTS(SELECT 1 FROM bb_m4_artifacts WHERE owner_user_id=r.owner_user_id AND run_id=r.id AND kind=registration_kind)
      OR (registration_kind='document' AND NOT EXISTS(SELECT 1 FROM bb_m4_artifacts WHERE owner_user_id=r.owner_user_id AND run_id=r.id AND kind='preparation_note')) THEN RETURN NULL; END IF;
    SELECT artifact_id,artifact_version INTO STRICT r.artifact_id,r.artifact_version FROM bb_m4_artifacts
      WHERE owner_user_id=r.owner_user_id AND run_id=r.id AND kind=registration_kind;
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
    SELECT max(created_at) INTO d.delivered_at FROM bb_m4_artifacts WHERE owner_user_id=r.owner_user_id AND run_id=r.id;
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
    FROM bb_m4_artifacts q JOIN bb_artifact_versions v ON v.owner_user_id=q.owner_user_id AND v.run_id=q.run_id AND v.id=q.artifact_id AND v.version=q.artifact_version
    WHERE q.owner_user_id=r.owner_user_id AND q.run_id=r.id AND (phase='m4_durable' OR bb_execution_delivery_artifact_ready(v,r.channel,d.delivered_at))
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
      'naming_m4_kind',(SELECT kind FROM bb_m4_artifacts WHERE owner_user_id=r.owner_user_id AND run_id=r.id AND artifact_id=a.id AND artifact_version=a.version),
      'naming_m4_revision',(SELECT revision_number FROM bb_m4_artifacts WHERE owner_user_id=r.owner_user_id AND run_id=r.id AND artifact_id=a.id AND artifact_version=a.version),
      'naming_m4_type',(SELECT document_type FROM bb_m4_artifacts WHERE owner_user_id=r.owner_user_id AND run_id=r.id AND artifact_id=a.id AND artifact_version=a.version));
    members:=members||jsonb_build_array(member);
    IF a.id=r.artifact_id AND a.version=r.artifact_version THEN d.primary_sha256:=a.sha256; END IF;
  END LOOP;
  SELECT jsonb_agg(value ORDER BY value->>'artifact_id',(value->>'artifact_version')::integer) INTO d.artifact_manifest FROM jsonb_array_elements(members);
  d.word_delivery_pair:=pair;
  RETURN to_jsonb(d);
END; $$;
