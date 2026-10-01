-- #19 production release writer: bind published registry events to immutable
-- reviewer self-submissions instead of treating pack_snapshot.reviews booleans
-- as the authority. Existing historical events remain readable and unchanged.
ALTER TABLE bb_rule_pack_production_release_events
  ADD COLUMN manifest_id text,
  ADD COLUMN manifest_version integer,
  ADD COLUMN manifest_content_sha256 char(64),
  ADD COLUMN industry_attestation_event_id text,
  ADD COLUMN technical_attestation_event_id text;

ALTER TABLE bb_rule_pack_production_release_events
  ADD CONSTRAINT bb_rule_pack_prod_event_manifest_fk
    FOREIGN KEY (manifest_id, manifest_version, manifest_content_sha256)
    REFERENCES bb_production_review_manifests(manifest_id, manifest_version, content_sha256),
  ADD CONSTRAINT bb_rule_pack_prod_event_industry_attestation_fk
    FOREIGN KEY (industry_attestation_event_id) REFERENCES bb_production_review_attestation_events(attestation_event_id),
  ADD CONSTRAINT bb_rule_pack_prod_event_technical_attestation_fk
    FOREIGN KEY (technical_attestation_event_id) REFERENCES bb_production_review_attestation_events(attestation_event_id),
  ADD CONSTRAINT bb_rule_pack_prod_event_attestation_pair_ck
    CHECK ((industry_attestation_event_id IS NULL) = (technical_attestation_event_id IS NULL)),
  ADD CONSTRAINT bb_rule_pack_prod_event_manifest_pair_ck
    CHECK ((manifest_id IS NULL AND manifest_version IS NULL AND manifest_content_sha256 IS NULL)
        OR (manifest_id IS NOT NULL AND manifest_version IS NOT NULL AND manifest_content_sha256 IS NOT NULL));

-- The older 0036 evidence rows predate #367's date-semantic evidence hashes.
-- Keep these nullable for historical records; a new production writer requires
-- every referenced row to carry its exact #367 binding hash.
ALTER TABLE bb_rule_pack_production_source_checks
  ADD COLUMN source_check_sha256 char(64) CHECK (source_check_sha256 IS NULL OR source_check_sha256 ~ '^[a-f0-9]{64}$');
ALTER TABLE bb_rule_pack_sample_authorizations
  ADD COLUMN authorization_evidence_sha256 char(64) CHECK (authorization_evidence_sha256 IS NULL OR authorization_evidence_sha256 ~ '^[a-f0-9]{64}$');
ALTER TABLE bb_rule_pack_production_sample_evidence
  ADD COLUMN sample_evidence_sha256 char(64) CHECK (sample_evidence_sha256 IS NULL OR sample_evidence_sha256 ~ '^[a-f0-9]{64}$'),
  ADD COLUMN expected_outcome_sha256 char(64) CHECK (expected_outcome_sha256 IS NULL OR expected_outcome_sha256 ~ '^[a-f0-9]{64}$'),
  ADD COLUMN reviewed_result_sha256 char(64) CHECK (reviewed_result_sha256 IS NULL OR reviewed_result_sha256 ~ '^[a-f0-9]{64}$');

CREATE TABLE bb_rule_pack_production_release_audit (
  id text PRIMARY KEY,
  event_id text NOT NULL REFERENCES bb_rule_pack_production_release_events(id),
  actor_user_id text NOT NULL REFERENCES bb_users(id),
  action text NOT NULL CHECK (action IN ('production_release','production_withdrawal','production_rollback')),
  manifest_id text,
  manifest_version integer,
  manifest_content_sha256 char(64),
  operator_grant_id text NOT NULL REFERENCES bb_rule_pack_production_reviewer_grants(id),
  industry_grant_id text REFERENCES bb_rule_pack_production_reviewer_grants(id),
  technical_grant_id text REFERENCES bb_rule_pack_production_reviewer_grants(id),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object'),
  occurred_at timestamptz NOT NULL,
  FOREIGN KEY (manifest_id,manifest_version,manifest_content_sha256)
    REFERENCES bb_production_review_manifests(manifest_id,manifest_version,content_sha256),
  CHECK ((manifest_id IS NULL AND manifest_version IS NULL AND manifest_content_sha256 IS NULL)
      OR (manifest_id IS NOT NULL AND manifest_version IS NOT NULL AND manifest_content_sha256 IS NOT NULL))
);
CREATE FUNCTION bb_rule_pack_production_release_audit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'production release audit rows are append-only' USING ERRCODE='23514'; END $$;
CREATE TRIGGER bb_rule_pack_production_release_audit_immutable BEFORE UPDATE OR DELETE
  ON bb_rule_pack_production_release_audit FOR EACH ROW EXECUTE FUNCTION bb_rule_pack_production_release_audit_guard();

CREATE FUNCTION bb_rule_pack_production_dimension_covers(wanted jsonb, allowed jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN allowed->>'mode'='reviewed_unrestricted' THEN true
    WHEN allowed->>'mode'='explicit_codes' AND wanted->>'mode'='explicit_codes'
      AND allowed->>'dictionary_version'=wanted->>'dictionary_version'
      THEN COALESCE((wanted->'codes') <@ (allowed->'codes'),false)
    ELSE false
  END
$$;

CREATE FUNCTION bb_rule_pack_production_grant_covers(
  requested_grant_id text, requested_user_id text, requested_role text,
  requested_market text, requested_offering text, requested_scope jsonb
) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM bb_rule_pack_production_reviewer_grants g
    JOIN bb_rule_pack_production_grant_scopes s ON s.grant_id=g.id
    JOIN bb_users u ON u.id=g.user_id
    WHERE g.id=requested_grant_id AND g.user_id=requested_user_id AND g.role=requested_role
      AND g.market=requested_market AND g.offering=requested_offering AND g.revoked_at IS NULL
      AND u.status='active'
      AND requested_scope->'instruments' <@ to_jsonb(s.instruments)
      AND requested_scope->'document_stages' <@ to_jsonb(s.document_stages)
      AND bb_rule_pack_production_dimension_covers(requested_scope->'issuer_scopes',s.issuer_scopes)
      AND bb_rule_pack_production_dimension_covers(requested_scope->'investor_scopes',s.investor_scopes)
      AND bb_rule_pack_production_dimension_covers(requested_scope->'industry_codes',s.industry_codes)
      AND bb_rule_pack_production_dimension_covers(requested_scope->'special_feature_scope',s.special_feature_scope)
  )
$$;

CREATE FUNCTION bb_rule_pack_production_event_attestation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  industry bb_production_review_attestation_events%ROWTYPE;
  technical bb_production_review_attestation_events%ROWTYPE;
  manifest_content jsonb;
  review_scope jsonb;
  bad_count integer;
  prior bb_rule_pack_production_release_events%ROWTYPE;
  current_event bb_rule_pack_production_release_events%ROWTYPE;
  has_current boolean;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'production rule-pack release events are append-only' USING ERRCODE='23514'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('rule-pack:' || NEW.pack_id, 0));
  SELECT * INTO current_event FROM bb_rule_pack_production_release_events
    WHERE pack_id=NEW.pack_id ORDER BY sequence DESC LIMIT 1;
  has_current := FOUND;

  IF NEW.action='production_release' THEN
    IF NEW.manifest_id IS NULL OR NEW.manifest_version IS NULL OR NEW.manifest_content_sha256 IS NULL
       OR NEW.industry_attestation_event_id IS NULL OR NEW.technical_attestation_event_id IS NULL
       OR NEW.manifest_id<>NEW.pack_id THEN
      RAISE EXCEPTION 'production release requires an exactly pinned manifest and both self-attestations' USING ERRCODE='23514';
    END IF;
    SELECT * INTO industry FROM bb_production_review_attestation_events
      WHERE attestation_event_id=NEW.industry_attestation_event_id;
    SELECT * INTO technical FROM bb_production_review_attestation_events
      WHERE attestation_event_id=NEW.technical_attestation_event_id;
    SELECT content INTO manifest_content FROM bb_production_review_manifests
      WHERE manifest_id=NEW.manifest_id AND manifest_version=NEW.manifest_version
        AND content_sha256=NEW.manifest_content_sha256;
    review_scope := manifest_content->'applicability_scope';
    IF industry.attestation_event_id IS NULL OR technical.attestation_event_id IS NULL
       OR industry.reviewer_role<>'industry' OR technical.reviewer_role<>'technical'
       OR industry.decision<>'approve' OR technical.decision<>'approve'
       OR industry.manifest_id<>NEW.manifest_id OR technical.manifest_id<>NEW.manifest_id
       OR industry.manifest_version<>NEW.manifest_version OR technical.manifest_version<>NEW.manifest_version
       OR industry.content_sha256<>NEW.manifest_content_sha256 OR technical.content_sha256<>NEW.manifest_content_sha256
       OR industry.reviewer_user_id=technical.reviewer_user_id
       OR industry.reviewer_user_id=NEW.operator_user_id OR technical.reviewer_user_id=NEW.operator_user_id
       OR industry.grant_id<>NEW.industry_reviewer_grant_id OR technical.grant_id<>NEW.technical_reviewer_grant_id
       OR industry.reviewer_user_id<>NEW.industry_reviewer_user_id OR technical.reviewer_user_id<>NEW.technical_reviewer_user_id
       OR industry.reviewed_at>NEW.occurred_at OR technical.reviewed_at>NEW.occurred_at
       OR EXISTS (SELECT 1 FROM bb_production_review_attestation_withdrawals w
         WHERE w.attestation_event_id IN (industry.attestation_event_id,technical.attestation_event_id)) THEN
      RAISE EXCEPTION 'active distinct approvals for the exact manifest are required' USING ERRCODE='23514';
    END IF;
    IF NOT bb_rule_pack_production_grant_covers(NEW.operator_grant_id,NEW.operator_user_id,'rule_pack_operator',NEW.market,NEW.offering,review_scope)
       OR NOT bb_rule_pack_production_grant_covers(NEW.industry_reviewer_grant_id,NEW.industry_reviewer_user_id,'rule_pack_industry_reviewer',NEW.market,NEW.offering,review_scope)
       OR NOT bb_rule_pack_production_grant_covers(NEW.technical_reviewer_grant_id,NEW.technical_reviewer_user_id,'rule_pack_technical_reviewer',NEW.market,NEW.offering,review_scope)
       OR manifest_content->'rule_pack'->>'id' IS DISTINCT FROM NEW.pack_id
       OR manifest_content->'rule_pack'->>'version' IS DISTINCT FROM NEW.pack_version
       OR manifest_content->'rule_pack'->>'sha256' IS DISTINCT FROM NEW.content_hash
       OR manifest_content->'chapter_template'->>'version' IS DISTINCT FROM NEW.template_version
       OR manifest_content->'chapter_template'->>'sha256' IS DISTINCT FROM NEW.template_hash
       OR manifest_content->'coverage_manifest'->>'version' IS DISTINCT FROM NEW.coverage_version
       OR manifest_content->'coverage_manifest'->>'sha256' IS DISTINCT FROM NEW.coverage_hash
       OR manifest_content->'applicability_scope'->>'market' IS DISTINCT FROM NEW.market
       OR manifest_content->'applicability_scope'->>'offering' IS DISTINCT FROM NEW.offering
       OR manifest_content->'applicability_scope'->'instruments' IS DISTINCT FROM to_jsonb(NEW.instruments)
       OR manifest_content->'applicability_scope'->'document_stages' IS DISTINCT FROM to_jsonb(NEW.document_stages) THEN
      RAISE EXCEPTION 'operator and reviewer grants must actively cover the exact frozen manifest scope' USING ERRCODE='23514';
    END IF;
    SELECT count(*) INTO bad_count FROM jsonb_array_elements(manifest_content->'source_date_evidence') source
      LEFT JOIN bb_rule_pack_production_source_checks s ON s.id=source->>'source_evidence_id'
        AND s.source_check_sha256=source->>'source_check_sha256'
        AND s.pack_id=NEW.pack_id AND s.pack_version=NEW.pack_version AND s.pack_hash=NEW.content_hash
        AND s.market=NEW.market AND s.offering=NEW.offering
      WHERE s.id IS NULL;
    IF bad_count>0 THEN RAISE EXCEPTION 'frozen manifest source/date evidence must bind exact verified source rows' USING ERRCODE='23514'; END IF;
    SELECT count(*) INTO bad_count FROM jsonb_array_elements(manifest_content->'authorized_real_sample_evidence') sample
      LEFT JOIN bb_rule_pack_production_sample_evidence se ON se.id=sample->>'sample_evidence_id'
        AND se.sample_evidence_sha256=sample->>'sample_evidence_sha256'
        AND se.expected_outcome_sha256=sample->>'expected_outcome_sha256'
        AND se.reviewed_result_sha256=sample->>'reviewed_result_sha256'
        AND se.sample_case_id=sample->>'sample_case_id' AND se.polarity=sample->>'polarity'
        AND se.pack_id=NEW.pack_id AND se.pack_version=NEW.pack_version AND se.pack_hash=NEW.content_hash
      JOIN bb_rule_pack_sample_authorizations a ON a.id=se.authorization_id
        AND a.authorization_evidence_sha256=sample->>'authorization_evidence_sha256'
        AND a.revoked_at IS NULL AND a.authorization_scope='rule_pack_validation'
        AND a.market=NEW.market AND a.offering=NEW.offering
      WHERE se.id IS NULL OR a.id IS NULL;
    IF bad_count>0 THEN RAISE EXCEPTION 'frozen manifest authorized-real sample hashes must bind exact non-revoked evidence' USING ERRCODE='23514'; END IF;
  ELSIF NEW.action='production_withdrawal' THEN
    IF NOT has_current OR current_event.action NOT IN ('production_release','production_rollback')
       OR NEW.target_event_id<>current_event.id
       OR NEW.manifest_id IS DISTINCT FROM current_event.manifest_id
       OR NEW.manifest_version IS DISTINCT FROM current_event.manifest_version
       OR NEW.manifest_content_sha256 IS DISTINCT FROM current_event.manifest_content_sha256
       OR NEW.industry_attestation_event_id IS DISTINCT FROM current_event.industry_attestation_event_id
       OR NEW.technical_attestation_event_id IS DISTINCT FROM current_event.technical_attestation_event_id THEN
      RAISE EXCEPTION 'withdrawal must retain the current immutable release attestation binding' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.action='production_rollback' THEN
    SELECT * INTO prior FROM bb_rule_pack_production_release_events
      WHERE pack_id=NEW.pack_id AND id=NEW.target_event_id;
    IF prior.id IS NULL OR prior.action NOT IN ('production_release','production_rollback')
       OR NEW.manifest_id IS DISTINCT FROM prior.manifest_id
       OR NEW.manifest_version IS DISTINCT FROM prior.manifest_version
       OR NEW.manifest_content_sha256 IS DISTINCT FROM prior.manifest_content_sha256
       OR NEW.industry_attestation_event_id IS DISTINCT FROM prior.industry_attestation_event_id
       OR NEW.technical_attestation_event_id IS DISTINCT FROM prior.technical_attestation_event_id THEN
      RAISE EXCEPTION 'rollback must retain the exact immutable historical attestation binding' USING ERRCODE='23514';
    END IF;
    SELECT content INTO manifest_content FROM bb_production_review_manifests
      WHERE manifest_id=prior.manifest_id AND manifest_version=prior.manifest_version
        AND content_sha256=prior.manifest_content_sha256;
    review_scope := manifest_content->'applicability_scope';
    SELECT * INTO industry FROM bb_production_review_attestation_events WHERE attestation_event_id=prior.industry_attestation_event_id;
    SELECT * INTO technical FROM bb_production_review_attestation_events WHERE attestation_event_id=prior.technical_attestation_event_id;
    IF industry.attestation_event_id IS NULL OR technical.attestation_event_id IS NULL
       OR industry.decision<>'approve' OR technical.decision<>'approve'
       OR EXISTS (SELECT 1 FROM bb_production_review_attestation_withdrawals w
         WHERE w.attestation_event_id IN (industry.attestation_event_id,technical.attestation_event_id))
       OR NOT bb_rule_pack_production_grant_covers(NEW.operator_grant_id,NEW.operator_user_id,'rule_pack_operator',NEW.market,NEW.offering,review_scope)
       OR NOT bb_rule_pack_production_grant_covers(prior.industry_reviewer_grant_id,prior.industry_reviewer_user_id,'rule_pack_industry_reviewer',NEW.market,NEW.offering,review_scope)
       OR NOT bb_rule_pack_production_grant_covers(prior.technical_reviewer_grant_id,prior.technical_reviewer_user_id,'rule_pack_technical_reviewer',NEW.market,NEW.offering,review_scope) THEN
      RAISE EXCEPTION 'rollback requires still-active exact-scope approvals and operator grant' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bb_rule_pack_production_event_attestation_guard
  BEFORE INSERT OR UPDATE OR DELETE ON bb_rule_pack_production_release_events
  FOR EACH ROW EXECUTE FUNCTION bb_rule_pack_production_event_attestation_guard();

-- Preserve the substantial 0036 gate and make the narrow semantic changes it
-- needs for this writer: use Felix's shared advisory key, allow a NULL legal
-- effective date when a source has a separate approved method window, and emit
-- one authenticated actor-owned outbox record enriched with attestation refs.
DO $$
DECLARE
  definition text;
BEGIN
  SELECT pg_get_functiondef('bb_rule_pack_production_event_guard()'::regprocedure) INTO definition;
  IF position('rule-pack-production:' IN definition)=0
     OR position('s.effective_from<=NEW.occurred_at::date' IN definition)=0
     OR position('''system'',''rule_pack_production''' IN definition)=0 THEN
    RAISE EXCEPTION '0036 production event guard changed; review 0073 compatibility patch before applying';
  END IF;
  definition := replace(definition, 'rule-pack-production:', 'rule-pack:');
  definition := replace(definition, 's.effective_from<=NEW.occurred_at::date',
    '(s.effective_from IS NULL OR s.effective_from<=NEW.occurred_at::date)');
  definition := replace(definition,
    $legacy_release_metadata$OR NEW.pack_snapshot->'release'->>'released_by' IS DISTINCT FROM NEW.operator_user_id
      OR (NEW.pack_snapshot->'release'->>'released_at')::timestamptz IS DISTINCT FROM NEW.occurred_at
      OR NEW.pack_snapshot->'release'->>'reason' IS DISTINCT FROM NEW.reason$legacy_release_metadata$,
    $immutable_rollback_metadata$OR (NEW.action='production_release' AND (
        NEW.pack_snapshot->'release'->>'released_by' IS DISTINCT FROM NEW.operator_user_id
        OR (NEW.pack_snapshot->'release'->>'released_at')::timestamptz IS DISTINCT FROM NEW.occurred_at
        OR NEW.pack_snapshot->'release'->>'reason' IS DISTINCT FROM NEW.reason))$immutable_rollback_metadata$);
  definition := replace(definition, '''system'',''rule_pack_production'',NEW.pack_id',
    'NEW.operator_user_id,''rule_pack_release'',NEW.pack_id');
  definition := replace(definition,
    '''target_event_id'',NEW.target_event_id));',
    '''target_event_id'',NEW.target_event_id,''manifest_id'',NEW.manifest_id,''manifest_version'',NEW.manifest_version,'
      || '''manifest_content_sha256'',NEW.manifest_content_sha256,''operator_grant_id'',NEW.operator_grant_id,'
      || '''industry_grant_id'',NEW.industry_reviewer_grant_id,''industry_role'',''industry'','
      || '''industry_attestation_event_id'',NEW.industry_attestation_event_id,''technical_grant_id'',NEW.technical_reviewer_grant_id,'
      || '''technical_role'',''technical'',''technical_attestation_event_id'',NEW.technical_attestation_event_id));');
  IF definition NOT LIKE '%s.effective_from IS NULL OR s.effective_from<=NEW.occurred_at::date%'
     OR definition NOT LIKE '%NEW.operator_user_id,%' OR definition NOT LIKE '%manifest_content_sha256%'
     OR definition NOT LIKE '%NEW.action=''production_release'' AND (%'
     OR definition LIKE '%rule-pack-production:%' THEN
    RAISE EXCEPTION '0036 production event guard compatibility patch incomplete';
  END IF;
  EXECUTE definition;
END $$;

CREATE INDEX bb_rule_pack_production_attestation_manifest_idx
  ON bb_rule_pack_production_release_events(manifest_id,manifest_version,manifest_content_sha256);

COMMENT ON COLUMN bb_rule_pack_production_release_events.industry_attestation_event_id IS
  'Immutable self-submitted industry approval for the exact frozen manifest; pack_snapshot.reviews is only a legacy compatibility projection.';
COMMENT ON TABLE bb_rule_pack_production_release_audit IS
  'Actor-bound append-only release/withdrawal/rollback audit. API writes this row and the actor-owned outbox in the same transaction as the release event.';
