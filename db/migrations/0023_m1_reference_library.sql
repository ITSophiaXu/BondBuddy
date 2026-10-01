-- #78 (M1-33) backend prospectus reference library: source registry, immutable document versions,
-- business profile versions, review queue, atomic index releases, task selection locks and sync logs.
-- The library is platform data, not user data: it never references bb_material_versions, and every
-- blob key lives under library/ so a personal upload cannot be promoted into it by construction.
-- Library jobs and #79 rows use the fixed system owner below.

-- Deny by default. Mirrors the #79 bb_operator_grants shape (PR #152, not merged when this was written);
-- fold into that table once it lands.
CREATE TABLE bb_library_operator_grants (
 id text PRIMARY KEY,
 user_id text NOT NULL REFERENCES bb_users(id),
 role text NOT NULL CHECK (role IN ('library_reader','library_operator')),
 granted_by text NOT NULL,
 reason_code text NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9_]{0,63}$'),
 granted_at timestamptz NOT NULL DEFAULT now(),
 revoked_at timestamptz,
 CHECK (revoked_at IS NULL OR revoked_at>=granted_at)
);
CREATE UNIQUE INDEX bb_library_grant_active_idx ON bb_library_operator_grants(user_id,role) WHERE revoked_at IS NULL;
CREATE FUNCTION bb_guard_library_grant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'library grants are retained' USING ERRCODE='23514'; END IF;
 IF OLD.revoked_at IS NOT NULL OR NEW.id<>OLD.id OR NEW.user_id<>OLD.user_id OR NEW.role<>OLD.role
    OR NEW.granted_by<>OLD.granted_by OR NEW.reason_code<>OLD.reason_code OR NEW.granted_at<>OLD.granted_at
 THEN RAISE EXCEPTION 'library grant is immutable except one revocation' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_library_grant_guard BEFORE UPDATE OR DELETE ON bb_library_operator_grants
  FOR EACH ROW EXECUTE FUNCTION bb_guard_library_grant();

-- Source registry. usage_rights gates selection; evaluation_only sources may be synced and reviewed
-- but their versions are never returned to tasks.
CREATE TABLE bb_library_sources (
 id text PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9_]{0,63}$'),
 kind text NOT NULL CHECK (kind IN ('public_disclosure','operator_import')),
 display_name text NOT NULL,
 market text CHECK (market IS NULL OR market IN ('sse','szse','nafmii')),
 authorization_basis text NOT NULL CHECK (length(btrim(authorization_basis)) BETWEEN 1 AND 500),
 terms_url text,
 terms_checked_at timestamptz,
 usage_rights text NOT NULL CHECK (usage_rights IN ('commercial_licensed','evaluation_only','revoked')),
 enabled boolean NOT NULL DEFAULT true,
 cursor jsonb NOT NULL DEFAULT '{}'::jsonb,
 stale_after_seconds integer NOT NULL DEFAULT 172800 CHECK (stale_after_seconds BETWEEN 60 AND 31536000),
 last_attempt_at timestamptz,
 last_success_at timestamptz,
 last_error_code text CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE bb_library_documents (
 id text PRIMARY KEY,
 source_id text NOT NULL REFERENCES bb_library_sources(id),
 external_key text NOT NULL CHECK (length(external_key) BETWEEN 1 AND 256),
 issuer_key text NOT NULL CHECK (length(issuer_key) BETWEEN 1 AND 128),
 issuer_name text NOT NULL,
 title text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (source_id, external_key)
);

CREATE TABLE bb_library_document_versions (
 id text PRIMARY KEY,
 document_id text NOT NULL REFERENCES bb_library_documents(id),
 version integer NOT NULL CHECK (version>0),
 -- Source-side ordering (e.g. SSE FILE_VERSION); a late job carrying a lower rank never replaces a higher one.
 source_revision text NOT NULL,
 source_revision_rank bigint NOT NULL,
 sha256 char(64) NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
 byte_size bigint NOT NULL CHECK (byte_size>0),
 media_type text NOT NULL,
 blob_key text NOT NULL CHECK (blob_key ~ '^library/[A-Za-z0-9/_.-]+$' AND length(blob_key)<=400),
 source_url text,
 disclosed_at date,
 market text CHECK (market IS NULL OR market IN ('sse','szse','nafmii')),
 offering text CHECK (offering IS NULL OR offering IN ('private','public','public_all','ppn','mtn','cp','scp','dfi')),
 instrument text,
 document_stage text CHECK (document_stage IS NULL OR document_stage IN ('registration','issuance')),
 parse_summary jsonb,
 state text NOT NULL DEFAULT 'pending_parse' CHECK (state IN
   ('pending_parse','pending_classify','pending_review','published','superseded','withdrawn','license_revoked','rolled_back','rejected','failed')),
 state_reason text NOT NULL CHECK (state_reason ~ '^[a-z][a-z0-9_]{0,63}$'),
 state_actor text NOT NULL CHECK (length(state_actor) BETWEEN 1 AND 128),
 state_changed_at timestamptz NOT NULL DEFAULT now(),
 fetched_by_job_id text,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (document_id, version),
 UNIQUE (document_id, sha256)
);
CREATE INDEX bb_library_versions_state_idx ON bb_library_document_versions(state, state_changed_at);

CREATE TABLE bb_library_profiles (
 id text PRIMARY KEY,
 document_version_id text NOT NULL REFERENCES bb_library_document_versions(id),
 profile_version integer NOT NULL CHECK (profile_version>0),
 fiscal_year integer CHECK (fiscal_year IS NULL OR fiscal_year BETWEEN 1900 AND 9999),
 taxonomy_version text NOT NULL,
 accounting_scope text NOT NULL CHECK (accounting_scope IN ('consolidated','parent','mixed','unknown')),
 -- Ordered top-three lines [{code,label,rank,revenue,evidence[]}]; null when not evidenced.
 top3 jsonb,
 set_key text,
 ranking_key text,
 completeness text NOT NULL CHECK (completeness IN ('complete','incomplete')),
 origin text NOT NULL CHECK (origin IN ('classifier','operator_correction')),
 state text NOT NULL DEFAULT 'pending_review' CHECK (state IN ('pending_review','published','superseded','rejected','withdrawn','rolled_back')),
 state_reason text NOT NULL CHECK (state_reason ~ '^[a-z][a-z0-9_]{0,63}$'),
 state_actor text NOT NULL,
 state_changed_at timestamptz NOT NULL DEFAULT now(),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (document_version_id, profile_version),
 CHECK ((completeness='complete') = (top3 IS NOT NULL AND set_key IS NOT NULL AND ranking_key IS NOT NULL AND fiscal_year IS NOT NULL AND accounting_scope='consolidated'))
);

CREATE TABLE bb_library_review_items (
 id text PRIMARY KEY,
 document_version_id text NOT NULL REFERENCES bb_library_document_versions(id),
 profile_id text REFERENCES bb_library_profiles(id),
 state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','approved','rejected','superseded')),
 opened_reason text NOT NULL CHECK (opened_reason ~ '^[a-z][a-z0-9_]{0,63}$'),
 decided_by text,
 decision_reason text CHECK (decision_reason IS NULL OR decision_reason ~ '^[a-z][a-z0-9_]{0,63}$'),
 decided_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK ((state='open') = (decided_at IS NULL))
);
CREATE UNIQUE INDEX bb_library_review_open_idx ON bb_library_review_items(document_version_id) WHERE state='open';

-- Index releases are immutable snapshots. Exactly one is active; publish, withdraw and rollback each
-- append a new release in the same transaction that moves body/profile states.
CREATE TABLE bb_library_index_releases (
 id text PRIMARY KEY,
 release_no bigint NOT NULL UNIQUE CHECK (release_no>0),
 previous_release_id text REFERENCES bb_library_index_releases(id),
 action text NOT NULL CHECK (action IN ('genesis','publish','withdraw','license_revoke','rollback','supersede')),
 reason text NOT NULL CHECK (reason ~ '^[a-z][a-z0-9_]{0,63}$'),
 actor text NOT NULL,
 active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX bb_library_one_active_release ON bb_library_index_releases((true)) WHERE active;

CREATE TABLE bb_library_index_entries (
 release_id text NOT NULL REFERENCES bb_library_index_releases(id),
 document_id text NOT NULL REFERENCES bb_library_documents(id),
 document_version_id text NOT NULL REFERENCES bb_library_document_versions(id),
 profile_id text NOT NULL REFERENCES bb_library_profiles(id),
 set_key text NOT NULL,
 market text NOT NULL, offering text NOT NULL, instrument text NOT NULL, document_stage text NOT NULL,
 taxonomy_version text NOT NULL, fiscal_year integer NOT NULL,
 disclosed_at date,
 review_quality integer NOT NULL CHECK (review_quality BETWEEN 0 AND 100),
 applicable_scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
 chapter_mapping_versions jsonb NOT NULL DEFAULT '[]'::jsonb,
 PRIMARY KEY (release_id, document_id)
);
CREATE INDEX bb_library_entries_lookup_idx ON bb_library_index_entries(release_id, set_key, market, offering);

-- Task locks. A run/project pins the exact versions it selected; later releases never rewrite a lock.
CREATE TABLE bb_library_selection_locks (
 id text PRIMARY KEY,
 owner_user_id text NOT NULL,
 project_id text NOT NULL,
 run_id text,
 query_schema_version text NOT NULL,
 document_version_id text NOT NULL REFERENCES bb_library_document_versions(id),
 profile_id text NOT NULL REFERENCES bb_library_profiles(id),
 taxonomy_version text NOT NULL,
 index_release_id text NOT NULL REFERENCES bb_library_index_releases(id),
 locked_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (owner_user_id, project_id) REFERENCES bb_projects(owner_user_id, id)
);
CREATE INDEX bb_library_locks_owner_idx ON bb_library_selection_locks(owner_user_id, project_id);

-- Append-only audit of every state change (written by trigger, so no code path can skip it).
CREATE TABLE bb_library_audit (
 id bigserial PRIMARY KEY,
 subject_type text NOT NULL CHECK (subject_type IN ('document_version','profile','source','release','review','grant')),
 subject_id text NOT NULL,
 from_state text, to_state text NOT NULL,
 reason text NOT NULL, actor text NOT NULL,
 occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bb_library_audit_subject_idx ON bb_library_audit(subject_type, subject_id, id);

CREATE TABLE bb_library_sync_runs (
 id text PRIMARY KEY,
 source_id text NOT NULL REFERENCES bb_library_sources(id),
 job_id text NOT NULL UNIQUE,
 mode text NOT NULL CHECK (mode IN ('scheduled','import','record_rerun')),
 cursor_before jsonb NOT NULL DEFAULT '{}'::jsonb,
 cursor_after jsonb,
 state text NOT NULL DEFAULT 'running' CHECK (state IN ('running','succeeded','partial','failed')),
 started_at timestamptz NOT NULL DEFAULT now(),
 finished_at timestamptz
);
CREATE TABLE bb_library_sync_items (
 sync_run_id text NOT NULL REFERENCES bb_library_sync_runs(id),
 item_key text NOT NULL,
 outcome text NOT NULL CHECK (outcome IN ('new_document','new_version','unchanged','stale_ignored','ineligible','failed')),
 attempts integer NOT NULL DEFAULT 1 CHECK (attempts>0),
 error_code text CHECK (error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
 document_version_id text REFERENCES bb_library_document_versions(id),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (sync_run_id, item_key)
);

-- Miss summary for operators: only the query shape and a hash of the set key, never owner data.
CREATE TABLE bb_library_query_misses (
 id text PRIMARY KEY,
 occurred_at timestamptz NOT NULL DEFAULT now(),
 index_release_id text,
 market text, offering text, instrument text, document_stage text,
 set_key_hash char(64),
 reason text NOT NULL CHECK (reason ~ '^[a-z][a-z0-9_]{0,63}$')
);
CREATE INDEX bb_library_misses_time_idx ON bb_library_query_misses(occurred_at DESC);

-- Library jobs run on the #17 bb_jobs lease model under the system owner.
ALTER TABLE bb_jobs ADD COLUMN library_source_id text REFERENCES bb_library_sources(id);
ALTER TABLE bb_jobs ADD COLUMN library_version_id text REFERENCES bb_library_document_versions(id);
ALTER TABLE bb_jobs DROP CONSTRAINT bb_job_binding;
ALTER TABLE bb_jobs ADD CONSTRAINT bb_job_binding CHECK (
  (job_type NOT IN ('parse','library') AND run_id IS NOT NULL AND material_id IS NULL AND library_source_id IS NULL)
  OR (job_type = 'parse' AND subtype = 'material_parse' AND run_id IS NULL
      AND project_id IS NOT NULL AND material_id IS NOT NULL AND material_version > 0
      AND material_sha256 ~ '^[a-f0-9]{64}$'
      AND parser_version ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
      AND trace_id IS NOT NULL AND max_attempts BETWEEN 1 AND 10
      AND ((state = 'failed') = (error_code IS NOT NULL))
      AND (error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{0,63}$')
      AND (state <> 'succeeded' OR result IS NOT NULL)
      AND library_source_id IS NULL)
  OR (job_type = 'library' AND subtype IN ('library_sync','library_record') AND run_id IS NULL AND project_id IS NULL
      AND material_id IS NULL AND owner_user_id = 'system-reference-library'
      AND library_source_id IS NOT NULL AND trace_id IS NOT NULL AND max_attempts BETWEEN 1 AND 10
      AND ((subtype = 'library_record') = (library_version_id IS NOT NULL))
      AND ((state = 'failed') = (error_code IS NOT NULL))
      AND (error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'))
);
-- At most one live sync per source; a second trigger while one runs reuses it.
CREATE UNIQUE INDEX bb_library_live_sync_idx ON bb_jobs(library_source_id)
  WHERE job_type='library' AND subtype='library_sync' AND state IN ('queued','running');
CREATE UNIQUE INDEX bb_library_live_record_idx ON bb_jobs(library_version_id)
  WHERE job_type='library' AND subtype='library_record' AND state IN ('queued','running');
CREATE INDEX bb_library_job_claim_idx ON bb_jobs(state, lease_until, created_at) WHERE job_type='library';

-- State machines. Every transition needs a reason and actor; the trigger writes the audit row and an outbox row.
CREATE FUNCTION bb_library_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allowed boolean;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'library versions are retained' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
   IF NEW.state<>'pending_parse' THEN RAISE EXCEPTION 'library version starts pending_parse' USING ERRCODE='23514'; END IF;
   INSERT INTO bb_library_audit(subject_type,subject_id,from_state,to_state,reason,actor) VALUES('document_version',NEW.id,NULL,NEW.state,NEW.state_reason,NEW.state_actor);
   RETURN NEW;
 END IF;
 IF NEW.id<>OLD.id OR NEW.document_id<>OLD.document_id OR NEW.version<>OLD.version OR NEW.sha256<>OLD.sha256
    OR NEW.byte_size<>OLD.byte_size OR NEW.blob_key<>OLD.blob_key OR NEW.source_revision<>OLD.source_revision
    OR NEW.source_revision_rank<>OLD.source_revision_rank OR NEW.media_type<>OLD.media_type
 THEN RAISE EXCEPTION 'library version bytes and identity are immutable' USING ERRCODE='23514'; END IF;
 IF OLD.state IN ('published','superseded','withdrawn','license_revoked','rolled_back') AND
    (NEW.market IS DISTINCT FROM OLD.market OR NEW.offering IS DISTINCT FROM OLD.offering OR NEW.instrument IS DISTINCT FROM OLD.instrument
     OR NEW.document_stage IS DISTINCT FROM OLD.document_stage OR NEW.parse_summary IS DISTINCT FROM OLD.parse_summary)
 THEN RAISE EXCEPTION 'reviewed library version classification is immutable' USING ERRCODE='23514'; END IF;
 IF NEW.state IS DISTINCT FROM OLD.state THEN
   allowed := CASE OLD.state
     WHEN 'pending_parse' THEN NEW.state IN ('pending_classify','failed','withdrawn','license_revoked','superseded')
     WHEN 'pending_classify' THEN NEW.state IN ('pending_review','pending_parse','failed','withdrawn','license_revoked','superseded')
     WHEN 'pending_review' THEN NEW.state IN ('published','rejected','pending_parse','superseded','withdrawn','license_revoked')
     WHEN 'failed' THEN NEW.state IN ('pending_parse','superseded','withdrawn','license_revoked')
     WHEN 'rejected' THEN NEW.state IN ('pending_parse','pending_review','superseded','withdrawn','license_revoked')
     WHEN 'published' THEN NEW.state IN ('superseded','withdrawn','license_revoked','rolled_back')
     WHEN 'superseded' THEN NEW.state IN ('published','withdrawn','license_revoked')
     WHEN 'rolled_back' THEN NEW.state IN ('published','withdrawn','license_revoked')
     ELSE false END;  -- withdrawn and license_revoked are terminal
   IF NOT allowed THEN RAISE EXCEPTION 'illegal library version transition % -> %', OLD.state, NEW.state USING ERRCODE='23514'; END IF;
   INSERT INTO bb_library_audit(subject_type,subject_id,from_state,to_state,reason,actor) VALUES('document_version',NEW.id,OLD.state,NEW.state,NEW.state_reason,NEW.state_actor);
   INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload)
     VALUES(gen_random_uuid()::text,'system-reference-library','library_document_version',NEW.id,'library.version_state_changed',
            jsonb_build_object('from',OLD.state,'to',NEW.state,'reason',NEW.state_reason));
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_library_version_guard BEFORE INSERT OR UPDATE OR DELETE ON bb_library_document_versions
  FOR EACH ROW EXECUTE FUNCTION bb_library_version_guard();

CREATE FUNCTION bb_library_profile_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allowed boolean;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'library profiles are retained' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
   IF NEW.state<>'pending_review' THEN RAISE EXCEPTION 'library profile starts pending_review' USING ERRCODE='23514'; END IF;
   INSERT INTO bb_library_audit(subject_type,subject_id,from_state,to_state,reason,actor) VALUES('profile',NEW.id,NULL,NEW.state,NEW.state_reason,NEW.state_actor);
   RETURN NEW;
 END IF;
 IF NEW.id<>OLD.id OR NEW.document_version_id<>OLD.document_version_id OR NEW.profile_version<>OLD.profile_version
    OR NEW.top3 IS DISTINCT FROM OLD.top3 OR NEW.set_key IS DISTINCT FROM OLD.set_key OR NEW.ranking_key IS DISTINCT FROM OLD.ranking_key
    OR NEW.fiscal_year IS DISTINCT FROM OLD.fiscal_year OR NEW.taxonomy_version<>OLD.taxonomy_version
    OR NEW.accounting_scope<>OLD.accounting_scope OR NEW.completeness<>OLD.completeness OR NEW.origin<>OLD.origin
 THEN RAISE EXCEPTION 'library profile content is immutable; append a new profile version' USING ERRCODE='23514'; END IF;
 IF NEW.state IS DISTINCT FROM OLD.state THEN
   allowed := CASE OLD.state
     WHEN 'pending_review' THEN NEW.state IN ('published','rejected','superseded','withdrawn')
     WHEN 'published' THEN NEW.state IN ('superseded','withdrawn','rolled_back')
     WHEN 'superseded' THEN NEW.state IN ('published','withdrawn')
     WHEN 'rolled_back' THEN NEW.state IN ('published','withdrawn')
     ELSE false END;
   IF NOT allowed THEN RAISE EXCEPTION 'illegal library profile transition % -> %', OLD.state, NEW.state USING ERRCODE='23514'; END IF;
   INSERT INTO bb_library_audit(subject_type,subject_id,from_state,to_state,reason,actor) VALUES('profile',NEW.id,OLD.state,NEW.state,NEW.state_reason,NEW.state_actor);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_library_profile_guard BEFORE INSERT OR UPDATE OR DELETE ON bb_library_profiles
  FOR EACH ROW EXECUTE FUNCTION bb_library_profile_guard();

CREATE FUNCTION bb_library_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME USING ERRCODE='23514'; END $$;
CREATE TRIGGER bb_library_entries_immutable BEFORE UPDATE OR DELETE ON bb_library_index_entries FOR EACH ROW EXECUTE FUNCTION bb_library_immutable();
CREATE TRIGGER bb_library_locks_immutable BEFORE UPDATE OR DELETE ON bb_library_selection_locks FOR EACH ROW EXECUTE FUNCTION bb_library_immutable();
CREATE TRIGGER bb_library_audit_immutable BEFORE UPDATE OR DELETE ON bb_library_audit FOR EACH ROW EXECUTE FUNCTION bb_library_immutable();

CREATE FUNCTION bb_library_release_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'index releases are retained' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND (NEW.id<>OLD.id OR NEW.release_no<>OLD.release_no OR NEW.action<>OLD.action OR NEW.reason<>OLD.reason
    OR NEW.actor<>OLD.actor OR NEW.previous_release_id IS DISTINCT FROM OLD.previous_release_id OR (NEW.active AND NOT OLD.active))
 THEN RAISE EXCEPTION 'index release may only be deactivated' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
   INSERT INTO bb_library_audit(subject_type,subject_id,from_state,to_state,reason,actor) VALUES('release',NEW.id,NULL,NEW.action,NEW.reason,NEW.actor);
   INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload)
     VALUES(gen_random_uuid()::text,'system-reference-library','library_index_release',NEW.id,'library.index_released',
            jsonb_build_object('release_no',NEW.release_no,'action',NEW.action,'reason',NEW.reason));
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_library_release_guard BEFORE INSERT OR UPDATE OR DELETE ON bb_library_index_releases
  FOR EACH ROW EXECUTE FUNCTION bb_library_release_guard();

-- Commit-time invariant: body, profile and index move together. The active release lists exactly the
-- published versions, each with its published profile, and a document has at most one published version.
CREATE FUNCTION bb_library_check_consistency() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE active_id text;
BEGIN
 SELECT id INTO active_id FROM bb_library_index_releases WHERE active;
 IF active_id IS NULL THEN
   IF EXISTS (SELECT 1 FROM bb_library_document_versions WHERE state='published') THEN
     RAISE EXCEPTION 'published library version without an active index release' USING ERRCODE='23514'; END IF;
   RETURN NULL;
 END IF;
 IF EXISTS (SELECT 1 FROM bb_library_index_entries e JOIN bb_library_document_versions v ON v.id=e.document_version_id
             JOIN bb_library_profiles p ON p.id=e.profile_id
            WHERE e.release_id=active_id AND (v.state<>'published' OR p.state<>'published' OR p.document_version_id<>v.id OR v.document_id<>e.document_id))
    OR EXISTS (SELECT 1 FROM bb_library_document_versions v WHERE v.state='published'
            AND NOT EXISTS (SELECT 1 FROM bb_library_index_entries e WHERE e.release_id=active_id AND e.document_version_id=v.id))
    OR EXISTS (SELECT 1 FROM bb_library_profiles p WHERE p.state='published'
            AND NOT EXISTS (SELECT 1 FROM bb_library_index_entries e WHERE e.release_id=active_id AND e.profile_id=p.id))
 THEN RAISE EXCEPTION 'library body, profile and active index are inconsistent' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER bb_library_consistency_versions AFTER INSERT OR UPDATE ON bb_library_document_versions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bb_library_check_consistency();
CREATE CONSTRAINT TRIGGER bb_library_consistency_profiles AFTER INSERT OR UPDATE ON bb_library_profiles
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bb_library_check_consistency();
CREATE CONSTRAINT TRIGGER bb_library_consistency_releases AFTER INSERT OR UPDATE ON bb_library_index_releases
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bb_library_check_consistency();

CREATE FUNCTION bb_library_source_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'library sources are retained' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' OR NEW.usage_rights IS DISTINCT FROM OLD.usage_rights OR NEW.enabled IS DISTINCT FROM OLD.enabled
    OR NEW.authorization_basis IS DISTINCT FROM OLD.authorization_basis THEN
   INSERT INTO bb_library_audit(subject_type,subject_id,from_state,to_state,reason,actor)
     VALUES('source',NEW.id,CASE WHEN TG_OP='UPDATE' THEN OLD.usage_rights END,NEW.usage_rights,
            COALESCE(current_setting('bondbuddy.library_reason',true),'source_registered'),COALESCE(current_setting('bondbuddy.library_actor',true),'system'));
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_library_source_audit BEFORE INSERT OR UPDATE OR DELETE ON bb_library_sources
  FOR EACH ROW EXECUTE FUNCTION bb_library_source_audit();

-- Genesis release so the invariant always has an active release to check against.
INSERT INTO bb_library_index_releases(id,release_no,previous_release_id,action,reason,actor,active)
  VALUES('library-release-genesis',1,NULL,'genesis','library_created','migration_0023',true);

COMMENT ON TABLE bb_library_document_versions IS
  '#78: immutable prospectus bytes (private Blob under library/) + hash; state machine audited by trigger.';
COMMENT ON TABLE bb_library_selection_locks IS
  '#78: versions a task selected; reads re-check current rights and withdrawal at read time.';
