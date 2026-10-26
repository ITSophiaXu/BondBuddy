-- A saved candidate is not a delivery. Freeze the exact files and naming data
-- accepted by the terminal transaction. This does not enable a second execution,
-- adoption, a new price, or a new charge. Drain writers in their run -> job/file
-- order; do not acquire topic/input locks behind writers waiting for a run.
LOCK TABLE bb_runs IN EXCLUSIVE MODE;
LOCK TABLE bb_jobs, bb_artifact_versions IN EXCLUSIVE MODE;
LOCK TABLE bb_run_execution_versions, bb_artifact_execution_bindings IN EXCLUSIVE MODE;

CREATE TABLE bb_run_execution_deliveries (
  owner_user_id text NOT NULL, project_id text NOT NULL, run_id text NOT NULL,
  execution_version integer NOT NULL CHECK(execution_version>0),
  input_revision integer NOT NULL CHECK(input_revision>0),
  input_hash char(64) NOT NULL CHECK(input_hash ~ '^[a-f0-9]{64}$'),
  delivery_phase text NOT NULL CHECK(delivery_phase IN ('final','m4_durable')),
  terminal_state text CHECK(terminal_state IN ('succeeded','test_completed')),
  channel text NOT NULL CHECK(channel IN ('production','non_production_test')),
  test_grant_id text,
  primary_artifact_id text NOT NULL, primary_artifact_version integer NOT NULL CHECK(primary_artifact_version>0),
  primary_sha256 char(64) NOT NULL CHECK(primary_sha256 ~ '^[a-f0-9]{64}$'),
  delivered_at timestamptz NOT NULL, event_cursor integer CHECK(event_cursor>0),
  word_delivery_pair jsonb CHECK(word_delivery_pair IS NULL OR jsonb_typeof(word_delivery_pair)='object'),
  naming_manifest jsonb NOT NULL CHECK(jsonb_typeof(naming_manifest)='object'),
  naming_review_version integer CHECK(naming_review_version>0),
  naming_m4_manifest jsonb CHECK(naming_m4_manifest IS NULL OR jsonb_typeof(naming_m4_manifest)='object'),
  artifact_manifest jsonb NOT NULL CHECK(jsonb_typeof(artifact_manifest)='array' AND jsonb_array_length(artifact_manifest) BETWEEN 1 AND 32),
  source text NOT NULL CHECK(source IN ('terminal_transition','m4_durable_registration','legacy_backfill')),
  PRIMARY KEY(run_id,execution_version,delivery_phase),
  UNIQUE(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash,delivery_phase),
  FOREIGN KEY(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash)
    REFERENCES bb_run_execution_versions(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash),
  FOREIGN KEY(owner_user_id,run_id,primary_artifact_id,primary_artifact_version)
    REFERENCES bb_artifact_versions(owner_user_id,run_id,id,version),
  CHECK((delivery_phase='final' AND terminal_state IS NOT NULL AND event_cursor IS NOT NULL AND source IN ('terminal_transition','legacy_backfill') AND
    ((terminal_state='succeeded' AND channel='production' AND test_grant_id IS NULL)
      OR (terminal_state='test_completed' AND channel='non_production_test' AND test_grant_id IS NOT NULL)))
    OR (delivery_phase='m4_durable' AND terminal_state IS NULL AND event_cursor IS NULL AND channel='production' AND test_grant_id IS NULL
      AND source IN ('m4_durable_registration','legacy_backfill')))
);
CREATE INDEX bb_execution_deliveries_history_idx
  ON bb_run_execution_deliveries(owner_user_id,project_id,delivered_at DESC,run_id DESC,execution_version DESC);

ALTER TABLE bb_artifact_execution_bindings ADD CONSTRAINT bb_artifact_execution_delivery_key
  UNIQUE(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash,artifact_id,artifact_version);

CREATE TABLE bb_run_execution_delivery_artifacts (
  owner_user_id text NOT NULL, project_id text NOT NULL, run_id text NOT NULL,
  execution_version integer NOT NULL, input_revision integer NOT NULL, input_hash char(64) NOT NULL,
  delivery_phase text NOT NULL CHECK(delivery_phase IN ('final','m4_durable')),
  artifact_id text NOT NULL, artifact_version integer NOT NULL CHECK(artifact_version>0),
  artifact_sha256 char(64) NOT NULL CHECK(artifact_sha256 ~ '^[a-f0-9]{64}$'),
  role text NOT NULL CHECK(role IN ('primary','revision','clean','baseline','report','comments','document','preparation_note','qa_text','company','person')),
  is_primary boolean NOT NULL,
  naming_created_at timestamptz NOT NULL,
  naming_integrity_kind text, naming_review_kind text, naming_m4_kind text,
  naming_m4_revision integer, naming_m4_type text,
  PRIMARY KEY(run_id,execution_version,delivery_phase,artifact_id,artifact_version),
  FOREIGN KEY(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash,delivery_phase)
    REFERENCES bb_run_execution_deliveries(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash,delivery_phase),
  CONSTRAINT bb_execution_delivery_member_origin FOREIGN KEY(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash,artifact_id,artifact_version)
    REFERENCES bb_artifact_execution_bindings(owner_user_id,project_id,run_id,execution_version,input_revision,input_hash,artifact_id,artifact_version)
);
CREATE UNIQUE INDEX bb_execution_delivery_primary_idx
  ON bb_run_execution_delivery_artifacts(run_id,execution_version,delivery_phase) WHERE is_primary;
CREATE INDEX bb_execution_delivery_artifact_lookup_idx
  ON bb_run_execution_delivery_artifacts(owner_user_id,artifact_id,artifact_version);

-- JSON equality must not depend on the writer's or reader's session TimeZone.
-- Persist one UTC, microsecond representation for the only member timestamp.
CREATE FUNCTION bb_execution_delivery_member_json(m bb_run_execution_delivery_artifacts)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT (to_jsonb(m)-ARRAY['owner_user_id','project_id','run_id','execution_version','input_revision','input_hash','delivery_phase','naming_created_at'])
    ||jsonb_build_object('naming_created_at',to_char(m.naming_created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
$$;

-- Gaps are immutable migration facts, never an alternate authorization path.
-- A later explicit repair can create a valid receipt without erasing the gap.
CREATE TABLE bb_run_execution_delivery_gaps (
  owner_user_id text NOT NULL, project_id text NOT NULL, run_id text NOT NULL,
  execution_version integer NOT NULL DEFAULT 1 CHECK(execution_version=1),
  delivery_phase text NOT NULL CHECK(delivery_phase IN ('final','m4_durable')),
  terminal_state text NOT NULL, diagnostic jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(run_id,execution_version,delivery_phase),
  FOREIGN KEY(owner_user_id,project_id,run_id) REFERENCES bb_runs(owner_user_id,project_id,id)
);

-- Validate the persisted readback receipt, not merely the candidate's status.
CREATE FUNCTION bb_execution_delivery_artifact_ready(a bb_artifact_versions, expected_channel text, not_after timestamptz DEFAULT NULL)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT a.quality_status='passed' AND (not_after IS NULL OR a.created_at<=not_after)
    AND a.delivery_status=CASE WHEN expected_channel='non_production_test' THEN 'test_only' ELSE 'available' END
    AND CASE
      WHEN a.media_type='application/vnd.openxmlformats-officedocument.wordprocessingml.document' THEN EXISTS(
        SELECT 1 FROM bb_word_delivery_evidence e WHERE e.id=a.word_delivery_evidence_id
          AND e.owner_user_id=a.owner_user_id AND e.run_id=a.run_id AND e.artifact_id=a.id AND e.artifact_version=a.version
          AND e.quality_status='passed' AND e.delivery_status='available' AND e.delivery_code='readback_verified'
          AND e.candidate_sha256=a.sha256 AND e.readback_sha256=a.sha256 AND e.readback_byte_size=e.byte_size
          AND (not_after IS NULL OR e.created_at<=not_after))
      WHEN a.media_type='application/pdf' THEN EXISTS(
        SELECT 1 FROM bb_review_pdf_delivery_evidence e WHERE e.id=a.review_pdf_delivery_evidence_id
          AND e.owner_user_id=a.owner_user_id AND e.run_id=a.run_id AND e.artifact_id=a.id AND e.artifact_version=a.version
          AND e.sha256=a.sha256 AND e.object_key=a.object_key AND (not_after IS NULL OR e.created_at<=not_after))
      WHEN a.media_type='text/plain' AND expected_channel='production' THEN EXISTS(
        SELECT 1 FROM bb_m4_text_delivery_evidence e WHERE e.id=a.m4_text_delivery_evidence_id
          AND e.owner_user_id=a.owner_user_id AND e.run_id=a.run_id AND e.artifact_id=a.id AND e.artifact_version=a.version
          AND e.sha256=a.sha256 AND e.byte_size=octet_length(e.content)
          AND encode(sha256(convert_to(e.content,'UTF8')),'hex')=a.sha256 AND (not_after IS NULL OR e.created_at<=not_after))
      ELSE false END
$$;

-- The same builder serves insertion, exact replay and the INSERT guard. It
-- takes no browser-supplied members, timestamps, input or naming metadata.
CREATE FUNCTION bb_run_execution_delivery_plan(owned_by text, target_run text, origin text, phase text DEFAULT 'final')
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
    FROM bb_review_artifacts q JOIN bb_artifact_versions v ON v.owner_user_id=q.owner_user_id AND v.run_id=q.run_id AND v.id=q.artifact_id AND v.version=q.artifact_version
    WHERE phase='final' AND q.owner_user_id=r.owner_user_id AND q.project_id=r.project_id AND q.run_id=r.id AND bb_execution_delivery_artifact_ready(v,r.channel,d.delivered_at)
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
      'naming_review_kind',(SELECT kind FROM bb_review_artifacts WHERE owner_user_id=r.owner_user_id AND run_id=r.id AND artifact_id=a.id AND artifact_version=a.version),
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

CREATE FUNCTION bb_check_run_execution_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF to_jsonb(NEW) IS DISTINCT FROM bb_run_execution_delivery_plan(NEW.owner_user_id,NEW.run_id,NEW.source,NEW.delivery_phase) THEN
    RAISE EXCEPTION 'delivery must preserve its exact terminal snapshot' USING ERRCODE='23514',CONSTRAINT='bb_execution_delivery_exact';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER bb_execution_delivery_exact BEFORE INSERT ON bb_run_execution_deliveries
  FOR EACH ROW EXECUTE FUNCTION bb_check_run_execution_delivery();

CREATE FUNCTION bb_check_run_execution_delivery_artifact() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected jsonb;
BEGIN
  SELECT item INTO expected FROM bb_run_execution_deliveries d CROSS JOIN LATERAL jsonb_array_elements(d.artifact_manifest) item
    WHERE d.owner_user_id=NEW.owner_user_id AND d.project_id=NEW.project_id AND d.run_id=NEW.run_id
      AND d.execution_version=NEW.execution_version AND d.input_revision=NEW.input_revision AND d.input_hash=NEW.input_hash AND d.delivery_phase=NEW.delivery_phase
      AND item->>'artifact_id'=NEW.artifact_id AND (item->>'artifact_version')::integer=NEW.artifact_version;
  IF expected IS NULL OR expected IS DISTINCT FROM bb_execution_delivery_member_json(NEW)
    OR NOT EXISTS(SELECT 1 FROM bb_execution_artifact_versions a WHERE a.owner_user_id=NEW.owner_user_id AND a.run_id=NEW.run_id
      AND a.id=NEW.artifact_id AND a.version=NEW.artifact_version AND a.sha256=NEW.artifact_sha256 AND a.created_at=NEW.naming_created_at) THEN
    RAISE EXCEPTION 'delivery member does not match its immutable selection' USING ERRCODE='23514',CONSTRAINT='bb_execution_delivery_member';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER bb_execution_delivery_member_exact BEFORE INSERT ON bb_run_execution_delivery_artifacts
  FOR EACH ROW EXECUTE FUNCTION bb_check_run_execution_delivery_artifact();

CREATE FUNCTION bb_capture_run_execution_delivery(owned_by text, target_run text, origin text DEFAULT 'terminal_transition', phase text DEFAULT 'final')
RETURNS void LANGUAGE plpgsql AS $$
DECLARE payload jsonb; saved jsonb; d bb_run_execution_deliveries%ROWTYPE;
BEGIN
  payload:=bb_run_execution_delivery_plan(owned_by,target_run,origin,phase);
  IF payload IS NULL THEN RETURN; END IF;
  d:=jsonb_populate_record(NULL::bb_run_execution_deliveries,payload);
  SELECT to_jsonb(old) INTO saved FROM bb_run_execution_deliveries old WHERE run_id=d.run_id AND execution_version=d.execution_version AND delivery_phase=d.delivery_phase;
  IF saved IS NOT NULL THEN
    IF saved IS DISTINCT FROM payload THEN
      RAISE EXCEPTION 'delivery replay differs from the accepted snapshot' USING ERRCODE='23514',CONSTRAINT='bb_execution_delivery_replay';
    END IF;
    IF d.artifact_manifest IS DISTINCT FROM (SELECT jsonb_agg(bb_execution_delivery_member_json(m) ORDER BY m.artifact_id,m.artifact_version)
      FROM bb_run_execution_delivery_artifacts m WHERE m.run_id=d.run_id AND m.execution_version=d.execution_version AND m.delivery_phase=d.delivery_phase) THEN
      RAISE EXCEPTION 'delivery replay has missing or changed members' USING ERRCODE='23514',CONSTRAINT='bb_execution_delivery_member';
    END IF;
    RETURN;
  END IF;
  INSERT INTO bb_run_execution_deliveries SELECT d.*;
  INSERT INTO bb_run_execution_delivery_artifacts
    SELECT d.owner_user_id,d.project_id,d.run_id,d.execution_version,d.input_revision,d.input_hash,d.delivery_phase,
      x.artifact_id,x.artifact_version,x.artifact_sha256,x.role,x.is_primary,x.naming_created_at,
      x.naming_integrity_kind,x.naming_review_kind,x.naming_m4_kind,x.naming_m4_revision,x.naming_m4_type
    FROM jsonb_to_recordset(d.artifact_manifest) AS x(artifact_id text,artifact_version integer,artifact_sha256 char(64),role text,is_primary boolean,
      naming_created_at timestamptz,naming_integrity_kind text,naming_review_kind text,naming_m4_kind text,naming_m4_revision integer,naming_m4_type text);
END; $$;

CREATE FUNCTION bb_capture_m4_durable_delivery(owned_by text, target_run text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM bb_capture_run_execution_delivery(owned_by,target_run,'m4_durable_registration','m4_durable');
END; $$;

CREATE FUNCTION bb_capture_terminal_execution_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state IN ('succeeded','test_completed') AND OLD.state IS DISTINCT FROM NEW.state
    AND NEW.task_kind<>'platform_probe' AND NEW.artifact_id IS NOT NULL THEN
    PERFORM bb_capture_run_execution_delivery(NEW.owner_user_id,NEW.id);
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER bb_run_execution_delivery_terminal AFTER UPDATE OF state ON bb_runs
  FOR EACH ROW EXECUTE FUNCTION bb_capture_terminal_execution_delivery();

CREATE TRIGGER bb_execution_delivery_immutable BEFORE UPDATE OR DELETE ON bb_run_execution_deliveries
  FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();
CREATE TRIGGER bb_execution_delivery_member_immutable BEFORE UPDATE OR DELETE ON bb_run_execution_delivery_artifacts
  FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();
CREATE TRIGGER bb_execution_delivery_gap_immutable BEFORE UPDATE OR DELETE ON bb_run_execution_delivery_gaps
  FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();

DO $$ DECLARE r record; error_state text; error_constraint text;
BEGIN
  FOR r IN SELECT owner_user_id,project_id,id,state FROM bb_runs
    WHERE state IN ('succeeded','test_completed') AND task_kind<>'platform_probe' AND artifact_id IS NOT NULL ORDER BY id LOOP
    BEGIN
      PERFORM bb_capture_run_execution_delivery(r.owner_user_id,r.id,'legacy_backfill');
    EXCEPTION WHEN check_violation OR no_data_found OR too_many_rows OR foreign_key_violation OR invalid_text_representation OR numeric_value_out_of_range THEN
      GET STACKED DIAGNOSTICS error_state=RETURNED_SQLSTATE,error_constraint=CONSTRAINT_NAME;
      INSERT INTO bb_run_execution_delivery_gaps(owner_user_id,project_id,run_id,execution_version,delivery_phase,terminal_state,diagnostic)
        VALUES(r.owner_user_id,r.project_id,r.id,1,'final',r.state,jsonb_build_object('code','legacy_delivery_not_reconstructable','sqlstate',error_state,'constraint',error_constraint));
    END;
  END LOOP;
  FOR r IN SELECT DISTINCT runs.owner_user_id,runs.project_id,runs.id,runs.state FROM bb_runs runs
    JOIN bb_m4_artifacts a ON a.owner_user_id=runs.owner_user_id AND a.run_id=runs.id ORDER BY runs.id LOOP
    BEGIN
      PERFORM bb_capture_run_execution_delivery(r.owner_user_id,r.id,'legacy_backfill','m4_durable');
    EXCEPTION WHEN check_violation OR no_data_found OR too_many_rows OR foreign_key_violation OR invalid_text_representation OR numeric_value_out_of_range THEN
      GET STACKED DIAGNOSTICS error_state=RETURNED_SQLSTATE,error_constraint=CONSTRAINT_NAME;
      INSERT INTO bb_run_execution_delivery_gaps(owner_user_id,project_id,run_id,execution_version,delivery_phase,terminal_state,diagnostic)
        VALUES(r.owner_user_id,r.project_id,r.id,1,'m4_durable',r.state,jsonb_build_object('code','legacy_delivery_not_reconstructable','sqlstate',error_state,'constraint',error_constraint));
    END;
  END LOOP;
END; $$;

-- Keep the complete phase proof behind a non-inlined, cached PL/pgSQL plan.
-- Inlining the origin tree into every artifact/name/history join causes a large
-- plan even for a single file. The proof remains bounded to this exact receipt,
-- so owner/artifact filters can use the member lookup index before invoking it.
CREATE FUNCTION bb_execution_delivery_phase_valid(accepted bb_run_execution_deliveries)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY INVOKER AS $$
DECLARE actual_manifest jsonb; has_primary boolean;
BEGIN
  SELECT jsonb_agg(bb_execution_delivery_member_json(m) ORDER BY m.artifact_id,m.artifact_version),
    COALESCE(bool_or(m.is_primary AND m.artifact_id=accepted.primary_artifact_id
      AND m.artifact_version=accepted.primary_artifact_version AND m.artifact_sha256=accepted.primary_sha256),false)
    INTO actual_manifest,has_primary
  FROM bb_run_execution_delivery_artifacts m
  JOIN bb_execution_artifact_versions a ON a.owner_user_id=m.owner_user_id AND a.run_id=m.run_id
    AND a.id=m.artifact_id AND a.version=m.artifact_version AND a.sha256=m.artifact_sha256 AND a.created_at=m.naming_created_at
  JOIN bb_artifact_execution_bindings b ON b.owner_user_id=m.owner_user_id AND b.project_id=m.project_id AND b.run_id=m.run_id
    AND b.execution_version=m.execution_version AND b.input_revision=m.input_revision AND b.input_hash=m.input_hash
    AND b.artifact_id=m.artifact_id AND b.artifact_version=m.artifact_version AND b.created_at=m.naming_created_at
  WHERE m.owner_user_id=accepted.owner_user_id AND m.project_id=accepted.project_id AND m.run_id=accepted.run_id
    AND m.execution_version=accepted.execution_version AND m.input_revision=accepted.input_revision AND m.input_hash=accepted.input_hash
    AND m.delivery_phase=accepted.delivery_phase;
  -- Losing one member or any exact origin invalidates the entire phase. Status
  -- and revocation are deliberately not filtered: callers still check them.
  RETURN has_primary AND actual_manifest IS NOT DISTINCT FROM accepted.artifact_manifest;
END; $$;

-- Validate the complete phase before preferring final to an independently valid
-- M4 durable phase. Live grants, ownership and project access remain caller checks.
CREATE VIEW bb_run_execution_delivery_artifact_details AS
SELECT DISTINCT ON (m.owner_user_id,m.artifact_id,m.artifact_version)
  m.artifact_id,m.artifact_version,m.owner_user_id,m.project_id,m.run_id,m.execution_version,m.input_revision,m.input_hash,m.delivery_phase,
  d.terminal_state,d.channel,d.test_grant_id,d.delivered_at,d.event_cursor,
  d.primary_artifact_id,d.primary_artifact_version,d.primary_sha256,d.word_delivery_pair,
  m.role,m.is_primary,m.artifact_sha256,d.source,
  m.naming_created_at,d.input_revision AS naming_input_revision,d.naming_manifest,d.naming_review_version,m.naming_review_kind,
  m.naming_m4_kind,m.naming_m4_revision,m.naming_m4_type,d.naming_m4_manifest,d.word_delivery_pair AS naming_pair,m.naming_integrity_kind
FROM bb_run_execution_delivery_artifacts m
JOIN bb_run_execution_deliveries d ON d.owner_user_id=m.owner_user_id AND d.project_id=m.project_id AND d.run_id=m.run_id
  AND d.execution_version=m.execution_version AND d.input_revision=m.input_revision AND d.input_hash=m.input_hash AND d.delivery_phase=m.delivery_phase
JOIN bb_artifact_versions a ON a.owner_user_id=m.owner_user_id AND a.run_id=m.run_id AND a.id=m.artifact_id AND a.version=m.artifact_version
  AND a.sha256=m.artifact_sha256 AND a.created_at=m.naming_created_at
WHERE bb_execution_delivery_phase_valid(d)
ORDER BY m.owner_user_id,m.artifact_id,m.artifact_version,CASE WHEN m.delivery_phase='final' THEN 0 ELSE 1 END;

CREATE VIEW bb_delivered_artifact_versions AS
SELECT a.* FROM bb_execution_artifact_versions a
JOIN bb_run_execution_delivery_artifact_details d ON d.owner_user_id=a.owner_user_id AND d.run_id=a.run_id
  AND d.artifact_id=a.id AND d.artifact_version=a.version AND d.artifact_sha256=a.sha256;
