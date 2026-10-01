-- #78 / #77 (BB-M1-33-QUERY-COMPARABILITY): reviewed comparability facts on library profile versions
-- and explicit source->target applicability scopes for cross-market/offering chapter-mapping versions.
-- Served only on the internal reference-library-query-v1.1 response; never on a user-facing route.

-- Comparability facts. Nullable so rows written before this migration stay valid, but a profile can no
-- longer be published without them (guard below), so existing unreviewed data stays unpublishable.
ALTER TABLE bb_library_profiles
  ADD COLUMN revenue_basis text CHECK (revenue_basis IS NULL OR revenue_basis IN ('operating_revenue','main_business_revenue')),
  ADD COLUMN currency text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  ADD COLUMN unit text CHECK (unit IS NULL OR unit IN ('yuan','thousand_yuan','ten_thousand_yuan','million_yuan','hundred_million_yuan')),
  -- Reviewer attestation, written once by the approving transaction (pending_review -> published).
  ADD COLUMN reviewed_review_id text REFERENCES bb_library_review_items(id),
  ADD COLUMN reviewed_by text CHECK (reviewed_by IS NULL OR length(reviewed_by) BETWEEN 1 AND 128),
  ADD COLUMN reviewed_at timestamptz,
  ADD CONSTRAINT bb_library_profile_attestation_whole CHECK (
    (reviewed_review_id IS NULL) = (reviewed_by IS NULL) AND (reviewed_by IS NULL) = (reviewed_at IS NULL));

CREATE OR REPLACE FUNCTION bb_library_profile_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allowed boolean;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'library profiles are retained' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
   IF NEW.state<>'pending_review' THEN RAISE EXCEPTION 'library profile starts pending_review' USING ERRCODE='23514'; END IF;
   IF NEW.reviewed_review_id IS NOT NULL THEN RAISE EXCEPTION 'library profile attestation is written at publish' USING ERRCODE='23514'; END IF;
   INSERT INTO bb_library_audit(subject_type,subject_id,from_state,to_state,reason,actor) VALUES('profile',NEW.id,NULL,NEW.state,NEW.state_reason,NEW.state_actor);
   RETURN NEW;
 END IF;
 IF NEW.id<>OLD.id OR NEW.document_version_id<>OLD.document_version_id OR NEW.profile_version<>OLD.profile_version
    OR NEW.top3 IS DISTINCT FROM OLD.top3 OR NEW.set_key IS DISTINCT FROM OLD.set_key OR NEW.ranking_key IS DISTINCT FROM OLD.ranking_key
    OR NEW.fiscal_year IS DISTINCT FROM OLD.fiscal_year OR NEW.taxonomy_version<>OLD.taxonomy_version
    OR NEW.accounting_scope<>OLD.accounting_scope OR NEW.completeness<>OLD.completeness OR NEW.origin<>OLD.origin
    OR NEW.revenue_basis IS DISTINCT FROM OLD.revenue_basis OR NEW.currency IS DISTINCT FROM OLD.currency OR NEW.unit IS DISTINCT FROM OLD.unit
 THEN RAISE EXCEPTION 'library profile content is immutable; append a new profile version' USING ERRCODE='23514'; END IF;
 -- The attestation may be written exactly once, in the same update that publishes a pending profile.
 IF (NEW.reviewed_review_id IS DISTINCT FROM OLD.reviewed_review_id OR NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at)
    AND NOT (OLD.reviewed_review_id IS NULL AND OLD.state='pending_review' AND NEW.state='published')
 THEN RAISE EXCEPTION 'library profile attestation is immutable' USING ERRCODE='23514'; END IF;
 IF NEW.state IS DISTINCT FROM OLD.state THEN
   allowed := CASE OLD.state
     WHEN 'pending_review' THEN NEW.state IN ('published','rejected','superseded','withdrawn')
     WHEN 'published' THEN NEW.state IN ('superseded','withdrawn','rolled_back')
     WHEN 'superseded' THEN NEW.state IN ('published','withdrawn')
     WHEN 'rolled_back' THEN NEW.state IN ('published','withdrawn')
     ELSE false END;
   IF NOT allowed THEN RAISE EXCEPTION 'illegal library profile transition % -> %', OLD.state, NEW.state USING ERRCODE='23514'; END IF;
   -- Publish gate: a first publish needs a complete consolidated profile, all comparability facts and the attestation.
   IF OLD.state='pending_review' AND NEW.state='published' AND (NEW.completeness<>'complete' OR NEW.accounting_scope<>'consolidated'
      OR NEW.revenue_basis IS NULL OR NEW.currency IS NULL OR NEW.unit IS NULL OR NEW.fiscal_year IS NULL OR NEW.reviewed_review_id IS NULL)
   THEN RAISE EXCEPTION 'library profile lacks reviewed comparability facts' USING ERRCODE='23514'; END IF;
   INSERT INTO bb_library_audit(subject_type,subject_id,from_state,to_state,reason,actor) VALUES('profile',NEW.id,OLD.state,NEW.state,NEW.state_reason,NEW.state_actor);
 END IF;
 RETURN NEW;
END $$;

-- Chapter-mapping versions. Each version is an accepted, immutable mapping of one source scope onto one
-- target scope (market/offering/instrument, plus stage and rule version); only a withdrawal may follow.
-- The query returns a version only when its source is the candidate's scope and its target is the request.
CREATE TABLE bb_library_chapter_mapping_versions (
 id text PRIMARY KEY,
 mapping_key text NOT NULL CHECK (mapping_key ~ '^[a-z][a-z0-9_.-]{0,127}$'),
 version integer NOT NULL CHECK (version>0),
 source_market text NOT NULL CHECK (source_market IN ('sse','szse','nafmii')),
 source_offering text NOT NULL CHECK (source_offering IN ('private','public','public_all','ppn','mtn','cp','scp','dfi')),
 source_instrument text NOT NULL CHECK (length(source_instrument) BETWEEN 1 AND 64),
 target_market text NOT NULL CHECK (target_market IN ('sse','szse','nafmii')),
 target_offering text NOT NULL CHECK (target_offering IN ('private','public','public_all','ppn','mtn','cp','scp','dfi')),
 target_instrument text NOT NULL CHECK (length(target_instrument) BETWEEN 1 AND 64),
 document_stage text NOT NULL CHECK (document_stage IN ('registration','issuance')),
 rule_version text NOT NULL CHECK (length(rule_version) BETWEEN 1 AND 128),
 state text NOT NULL DEFAULT 'accepted' CHECK (state IN ('accepted','withdrawn')),
 reviewed_by text NOT NULL CHECK (length(reviewed_by) BETWEEN 1 AND 128),
 reason text NOT NULL CHECK (reason ~ '^[a-z][a-z0-9_]{0,63}$'),
 state_actor text NOT NULL CHECK (length(state_actor) BETWEEN 1 AND 128),
 created_at timestamptz NOT NULL DEFAULT now(),
 state_changed_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (mapping_key, version),
 CHECK (source_market<>target_market OR source_offering<>target_offering)
);
CREATE INDEX bb_library_mapping_lookup_idx ON bb_library_chapter_mapping_versions(target_market,target_offering,target_instrument,document_stage,rule_version) WHERE state='accepted';

ALTER TABLE bb_library_audit DROP CONSTRAINT bb_library_audit_subject_type_check;
ALTER TABLE bb_library_audit ADD CONSTRAINT bb_library_audit_subject_type_check
  CHECK (subject_type IN ('document_version','profile','source','release','review','grant','chapter_mapping'));

CREATE FUNCTION bb_library_mapping_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'chapter mapping versions are retained' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
   IF NEW.state<>'accepted' THEN RAISE EXCEPTION 'chapter mapping version starts accepted' USING ERRCODE='23514'; END IF;
 ELSIF (to_jsonb(NEW) - 'state' - 'state_changed_at' - 'reason' - 'state_actor')
       IS DISTINCT FROM (to_jsonb(OLD) - 'state' - 'state_changed_at' - 'reason' - 'state_actor')
    OR NOT (OLD.state='accepted' AND NEW.state='withdrawn')
 THEN RAISE EXCEPTION 'chapter mapping version is immutable except one withdrawal' USING ERRCODE='23514'; END IF;
 INSERT INTO bb_library_audit(subject_type,subject_id,from_state,to_state,reason,actor)
   VALUES('chapter_mapping',NEW.id,CASE WHEN TG_OP='UPDATE' THEN OLD.state END,NEW.state,NEW.reason,NEW.state_actor);
 RETURN NEW;
END $$;
CREATE TRIGGER bb_library_mapping_guard BEFORE INSERT OR UPDATE OR DELETE ON bb_library_chapter_mapping_versions
  FOR EACH ROW EXECUTE FUNCTION bb_library_mapping_guard();

COMMENT ON TABLE bb_library_chapter_mapping_versions IS
  '#78: accepted cross-market/offering chapter-mapping versions with an explicit source->target applicability scope.';
