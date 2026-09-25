-- #19 production registry is separate from the 0018 test ledger.
-- Reviewer grants and evidence rows are provisioned out-of-band; this migration
-- does not seed grants, sources, samples, or releases.

CREATE TABLE bb_rule_pack_production_reviewer_grants (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES bb_users(id),
  role text NOT NULL CHECK (role IN ('rule_pack_operator','rule_pack_industry_reviewer','rule_pack_technical_reviewer')),
  market text NOT NULL CHECK (market IN ('sse','szse','nafmii')),
  offering text NOT NULL CHECK (offering IN ('private','public','public_all','ppn','mtn','cp','scp','dfi')),
  granted_by text NOT NULL REFERENCES bb_users(id),
  reason_code text NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CHECK (user_id <> granted_by),
  CHECK (revoked_at IS NULL OR revoked_at >= granted_at),
  CHECK ((market = 'sse' AND offering IN ('private','public','public_all')) OR
         (market = 'szse' AND offering IN ('private','public','public_all')) OR
         (market = 'nafmii' AND offering IN ('ppn','mtn','cp','scp','dfi'))),
  UNIQUE (user_id, id),
  UNIQUE (id, user_id),
  UNIQUE (id, user_id, role, market, offering)
);
CREATE UNIQUE INDEX bb_rule_pack_prod_grant_active_idx
  ON bb_rule_pack_production_reviewer_grants(user_id, role, market, offering) WHERE revoked_at IS NULL;

CREATE FUNCTION bb_rule_pack_prod_grant_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'production reviewer grants are retained' USING ERRCODE='23514'; END IF;
  IF OLD.revoked_at IS NOT NULL OR NEW.id <> OLD.id OR NEW.user_id <> OLD.user_id OR NEW.role <> OLD.role
     OR NEW.market <> OLD.market OR NEW.offering <> OLD.offering OR NEW.granted_by <> OLD.granted_by
     OR NEW.reason_code <> OLD.reason_code OR NEW.granted_at <> OLD.granted_at
  THEN RAISE EXCEPTION 'production reviewer grant is immutable except one revocation' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bb_rule_pack_prod_grant_guard
  BEFORE UPDATE OR DELETE ON bb_rule_pack_production_reviewer_grants
  FOR EACH ROW EXECUTE FUNCTION bb_rule_pack_prod_grant_guard();

CREATE TABLE bb_rule_pack_production_source_checks (
  id text PRIMARY KEY,
  pack_id text NOT NULL,
  pack_version text NOT NULL,
  pack_hash char(64) NOT NULL CHECK (pack_hash ~ '^[a-f0-9]{64}$'),
  source_id text NOT NULL,
  authority text NOT NULL CHECK (length(btrim(authority)) > 0),
  official_url text NOT NULL CHECK (official_url ~ '^https://'),
  source_version text NOT NULL CHECK (length(btrim(source_version)) > 0),
  market text NOT NULL CHECK (market IN ('sse','szse','nafmii')),
  offering text NOT NULL CHECK (offering IN ('private','public','public_all','ppn','mtn','cp','scp','dfi')),
  document_hash char(64) CHECK (document_hash IS NULL OR document_hash ~ '^[a-f0-9]{64}$'),
  clause_locator text NOT NULL CHECK (length(btrim(clause_locator)) > 0),
  exact_quote text NOT NULL CHECK (length(btrim(exact_quote)) > 0),
  checked_at timestamptz NOT NULL,
  effective_from date NOT NULL,
  effective_to date,
  verifier_user_id text NOT NULL,
  verifier_grant_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pack_id, pack_version, pack_hash, source_id),
  UNIQUE (id, pack_id, pack_version, pack_hash),
  FOREIGN KEY (verifier_grant_id, verifier_user_id) REFERENCES bb_rule_pack_production_reviewer_grants(id, user_id),
  CHECK ((market IN ('sse','szse') AND offering IN ('private','public','public_all')) OR
         (market='nafmii' AND offering IN ('ppn','mtn','cp','scp','dfi'))),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

-- The FK above cannot constrain a role that varies by source scope. This trigger
-- makes source verification explicitly an active industry-reviewer decision.
CREATE FUNCTION bb_rule_pack_prod_source_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'production source checks are immutable' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM bb_rule_pack_production_reviewer_grants g
    WHERE g.id=NEW.verifier_grant_id AND g.user_id=NEW.verifier_user_id
      AND g.role='rule_pack_industry_reviewer' AND g.market=NEW.market AND g.offering=NEW.offering AND g.revoked_at IS NULL
  ) THEN RAISE EXCEPTION 'active industry reviewer grant required for official source check' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bb_rule_pack_prod_source_guard
  BEFORE INSERT OR UPDATE OR DELETE ON bb_rule_pack_production_source_checks
  FOR EACH ROW EXECUTE FUNCTION bb_rule_pack_prod_source_guard();

CREATE TABLE bb_rule_pack_sample_authorizations (
  id text PRIMARY KEY,
  material_sha256 char(64) NOT NULL CHECK (material_sha256 ~ '^[a-f0-9]{64}$'),
  authorization_document_sha256 char(64) NOT NULL CHECK (authorization_document_sha256 ~ '^[a-f0-9]{64}$'),
  authorization_scope text NOT NULL CHECK (authorization_scope = 'rule_pack_validation'),
  market text NOT NULL CHECK (market IN ('sse','szse','nafmii')),
  offering text NOT NULL CHECK (offering IN ('private','public','public_all','ppn','mtn','cp','scp','dfi')),
  authorized_by_user_id text NOT NULL,
  authorizer_grant_id text NOT NULL,
  authorized_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (authorizer_grant_id, authorized_by_user_id) REFERENCES bb_rule_pack_production_reviewer_grants(id, user_id),
  CHECK ((market IN ('sse','szse') AND offering IN ('private','public','public_all')) OR
         (market='nafmii' AND offering IN ('ppn','mtn','cp','scp','dfi'))),
  CHECK (revoked_at IS NULL OR revoked_at >= authorized_at),
  UNIQUE (id, material_sha256, market, offering)
);
CREATE FUNCTION bb_rule_pack_sample_authorization_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'sample authorization records are retained' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' THEN
    IF OLD.revoked_at IS NOT NULL OR NEW.id<>OLD.id OR NEW.material_sha256<>OLD.material_sha256
      OR NEW.authorization_document_sha256<>OLD.authorization_document_sha256
      OR NEW.authorization_scope<>OLD.authorization_scope OR NEW.market<>OLD.market OR NEW.offering<>OLD.offering
      OR NEW.authorized_by_user_id<>OLD.authorized_by_user_id OR NEW.authorizer_grant_id<>OLD.authorizer_grant_id
      OR NEW.authorized_at<>OLD.authorized_at
    THEN RAISE EXCEPTION 'sample authorization is immutable except one revocation' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM bb_rule_pack_production_reviewer_grants g
    WHERE g.id=NEW.authorizer_grant_id AND g.user_id=NEW.authorized_by_user_id
      AND g.role='rule_pack_operator' AND g.market=NEW.market AND g.offering=NEW.offering AND g.revoked_at IS NULL)
  THEN RAISE EXCEPTION 'active scoped operator grant required to record sample authorization' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bb_rule_pack_sample_authorization_guard
  BEFORE INSERT OR UPDATE OR DELETE ON bb_rule_pack_sample_authorizations
  FOR EACH ROW EXECUTE FUNCTION bb_rule_pack_sample_authorization_guard();

CREATE TABLE bb_rule_pack_production_sample_evidence (
  id text PRIMARY KEY,
  sample_case_id text NOT NULL,
  pack_id text NOT NULL,
  pack_version text NOT NULL,
  pack_hash char(64) NOT NULL CHECK (pack_hash ~ '^[a-f0-9]{64}$'),
  polarity text NOT NULL CHECK (polarity IN ('positive','negative','boundary')),
  material_sha256 char(64) NOT NULL CHECK (material_sha256 ~ '^[a-f0-9]{64}$'),
  authorization_id text NOT NULL,
  market text NOT NULL CHECK (market IN ('sse','szse','nafmii')),
  offering text NOT NULL CHECK (offering IN ('private','public','public_all','ppn','mtn','cp','scp','dfi')),
  expected_outcome text NOT NULL CHECK (expected_outcome IN ('pass','issue','not_applicable','needs_evidence')),
  observed_outcome text NOT NULL CHECK (observed_outcome = expected_outcome),
  source_anchor text NOT NULL CHECK (length(btrim(source_anchor)) > 0),
  reviewer_user_id text NOT NULL,
  reviewer_grant_id text NOT NULL,
  reviewed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pack_id, pack_version, pack_hash, id),
  UNIQUE (pack_id, pack_version, pack_hash, sample_case_id),
  FOREIGN KEY (reviewer_user_id, reviewer_grant_id) REFERENCES bb_rule_pack_production_reviewer_grants(user_id, id),
  FOREIGN KEY (authorization_id, material_sha256, market, offering) REFERENCES bb_rule_pack_sample_authorizations(id, material_sha256, market, offering)
);
CREATE FUNCTION bb_rule_pack_prod_sample_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'production sample evidence is immutable' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM bb_rule_pack_production_reviewer_grants g
    WHERE g.id=NEW.reviewer_grant_id AND g.user_id=NEW.reviewer_user_id
      AND g.role IN ('rule_pack_industry_reviewer','rule_pack_technical_reviewer')
      AND g.market=NEW.market AND g.offering=NEW.offering AND g.revoked_at IS NULL
  ) THEN RAISE EXCEPTION 'active rule-pack reviewer grant required for sample evidence' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS (SELECT 1 FROM bb_rule_pack_sample_authorizations a WHERE a.id=NEW.authorization_id
    AND a.material_sha256=NEW.material_sha256 AND a.market=NEW.market AND a.offering=NEW.offering AND a.revoked_at IS NULL)
  THEN RAISE EXCEPTION 'active exact-hash sample authorization required' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bb_rule_pack_prod_sample_guard
  BEFORE INSERT OR UPDATE OR DELETE ON bb_rule_pack_production_sample_evidence
  FOR EACH ROW EXECUTE FUNCTION bb_rule_pack_prod_sample_guard();

CREATE TABLE bb_rule_pack_production_release_events (
  id text PRIMARY KEY,
  pack_id text NOT NULL,
  request_id text NOT NULL,
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  sequence integer NOT NULL CHECK (sequence > 0),
  action text NOT NULL CHECK (action IN ('production_release','production_withdrawal','production_rollback')),
  pack_version text NOT NULL,
  content_hash char(64) NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  template_version text NOT NULL,
  template_hash char(64) NOT NULL CHECK (template_hash ~ '^[a-f0-9]{64}$'),
  coverage_version text NOT NULL,
  coverage_hash char(64) NOT NULL CHECK (coverage_hash ~ '^[a-f0-9]{64}$'),
  target_event_id text,
  market text NOT NULL CHECK (market IN ('sse','szse','nafmii')),
  offering text NOT NULL CHECK (offering IN ('private','public','public_all','ppn','mtn','cp','scp','dfi')),
  instruments text[] NOT NULL CHECK (cardinality(instruments) > 0 AND array_position(instruments, '') IS NULL),
  document_stages text[] NOT NULL CHECK (cardinality(document_stages) > 0 AND document_stages <@ ARRAY['registration','issuance']::text[]),
  effective_from date NOT NULL,
  effective_to date,
  pack_snapshot jsonb NOT NULL CHECK (jsonb_typeof(pack_snapshot) = 'object'),
  template_snapshot jsonb NOT NULL CHECK (jsonb_typeof(template_snapshot) = 'object'),
  coverage_snapshot jsonb NOT NULL CHECK (jsonb_typeof(coverage_snapshot) = 'object'),
  source_check_ids text[] NOT NULL DEFAULT '{}',
  sample_evidence_ids text[] NOT NULL DEFAULT '{}',
  operator_user_id text NOT NULL,
  operator_grant_id text NOT NULL,
  industry_reviewer_user_id text,
  industry_reviewer_grant_id text,
  technical_reviewer_user_id text,
  technical_reviewer_grant_id text,
  reason text NOT NULL CHECK (length(btrim(reason)) > 0),
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pack_id, request_id),
  UNIQUE (pack_id, sequence),
  UNIQUE (pack_id, id),
  FOREIGN KEY (pack_id, target_event_id) REFERENCES bb_rule_pack_production_release_events(pack_id, id),
  FOREIGN KEY (operator_grant_id, operator_user_id) REFERENCES bb_rule_pack_production_reviewer_grants(id, user_id),
  FOREIGN KEY (industry_reviewer_grant_id, industry_reviewer_user_id) REFERENCES bb_rule_pack_production_reviewer_grants(id, user_id),
  FOREIGN KEY (technical_reviewer_grant_id, technical_reviewer_user_id) REFERENCES bb_rule_pack_production_reviewer_grants(id, user_id),
  CHECK ((market = 'sse' AND offering IN ('private','public','public_all')) OR
         (market = 'szse' AND offering IN ('private','public','public_all')) OR
         (market = 'nafmii' AND offering IN ('ppn','mtn','cp','scp','dfi'))),
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CHECK ((action IN ('production_withdrawal','production_rollback')) = (target_event_id IS NOT NULL)),
  CHECK (pack_snapshot->>'pack_id' = pack_id AND pack_snapshot->>'version' = pack_version),
  CHECK (pack_snapshot->>'status' = CASE WHEN action='production_withdrawal' THEN 'withdrawn' ELSE 'published' END),
  CHECK (pack_snapshot->'release'->>'channel' = 'production'),
  CHECK (pack_snapshot->'release'->>'content_hash' = content_hash),
  CHECK (template_snapshot->>'rule_pack_id' = pack_id AND template_snapshot->>'version' = template_version),
  CHECK (template_snapshot->>'market' = market AND template_snapshot->>'offering' = offering),
  CHECK (coverage_snapshot->>'rule_pack_id' = pack_id AND coverage_snapshot->>'version' = coverage_version),
  CHECK (jsonb_array_length(COALESCE(coverage_snapshot->'open_blockers','[]'::jsonb)) = 0),
  CHECK (pack_snapshot->'scope'->>'market' = market AND pack_snapshot->'scope'->>'offering' = offering),
  CHECK (pack_snapshot->'scope'->'instruments' = to_jsonb(instruments)),
  CHECK (pack_snapshot->'scope'->'document_stages' = to_jsonb(document_stages)),
  CHECK ((pack_snapshot->'validity'->>'effective_from')::date = effective_from),
  CHECK (NULLIF(pack_snapshot->'validity'->>'effective_to','')::date IS NOT DISTINCT FROM effective_to),
  CHECK (content_hash = lower(btrim(content_hash::text)))
);
CREATE INDEX bb_rule_pack_production_latest_idx ON bb_rule_pack_production_release_events(pack_id, sequence DESC);
CREATE INDEX bb_rule_pack_production_scope_idx ON bb_rule_pack_production_release_events(market, offering, effective_from, effective_to);

CREATE FUNCTION bb_rule_pack_production_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  bad_count integer;
  polarity_count integer;
  has_current boolean;
  current_event bb_rule_pack_production_release_events%ROWTYPE;
  rollback_target bb_rule_pack_production_release_events%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'production rule-pack release events are append-only' USING ERRCODE='23514'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('rule-pack-production:' || NEW.pack_id, 0));
  SELECT * INTO current_event FROM bb_rule_pack_production_release_events
    WHERE pack_id=NEW.pack_id ORDER BY sequence DESC LIMIT 1;
  has_current := FOUND;
  IF has_current THEN
    IF NEW.sequence<>current_event.sequence+1 THEN RAISE EXCEPTION 'production rule-pack event sequence conflict' USING ERRCODE='23514'; END IF;
  ELSIF NEW.sequence<>1 THEN RAISE EXCEPTION 'production rule-pack event sequence must start at one' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS (SELECT 1 FROM bb_rule_pack_production_reviewer_grants g WHERE g.id=NEW.operator_grant_id
      AND g.user_id=NEW.operator_user_id AND g.role='rule_pack_operator' AND g.market=NEW.market AND g.offering=NEW.offering
      AND g.granted_at<=NEW.occurred_at AND g.revoked_at IS NULL)
  THEN RAISE EXCEPTION 'active scoped production operator grant required' USING ERRCODE='23514'; END IF;
  IF NEW.action IN ('production_release','production_rollback') AND (
    NOT EXISTS (SELECT 1 FROM bb_rule_pack_production_reviewer_grants g WHERE g.id=NEW.industry_reviewer_grant_id
      AND g.user_id=NEW.industry_reviewer_user_id AND g.role='rule_pack_industry_reviewer' AND g.market=NEW.market AND g.offering=NEW.offering
      AND g.granted_at<=NEW.occurred_at AND g.revoked_at IS NULL)
    OR NOT EXISTS (SELECT 1 FROM bb_rule_pack_production_reviewer_grants g WHERE g.id=NEW.technical_reviewer_grant_id
      AND g.user_id=NEW.technical_reviewer_user_id AND g.role='rule_pack_technical_reviewer' AND g.market=NEW.market AND g.offering=NEW.offering
      AND g.granted_at<=NEW.occurred_at AND g.revoked_at IS NULL)
    OR NEW.industry_reviewer_user_id=NEW.technical_reviewer_user_id
  ) THEN RAISE EXCEPTION 'active scoped distinct reviewer grants required' USING ERRCODE='23514'; END IF;
  IF NEW.action='production_release' AND has_current AND current_event.action<>'production_withdrawal' THEN
    RAISE EXCEPTION 'withdraw current release before publishing a replacement' USING ERRCODE='23514';
  END IF;
  IF NEW.action='production_release' AND has_current AND NEW.pack_snapshot->>'supersedes_version' IS DISTINCT FROM current_event.pack_version THEN
    RAISE EXCEPTION 'replacement must supersede current pack version' USING ERRCODE='23514';
  END IF;
  IF NEW.action='production_withdrawal' THEN
    IF NOT has_current OR current_event.action NOT IN ('production_release','production_rollback')
      OR NEW.target_event_id<>current_event.id OR NEW.pack_version<>current_event.pack_version
      OR NEW.content_hash<>current_event.content_hash
      OR (NEW.pack_snapshot-'status'-'withdrawal') IS DISTINCT FROM (current_event.pack_snapshot-'status'-'withdrawal')
      OR NEW.template_snapshot IS DISTINCT FROM current_event.template_snapshot
      OR NEW.coverage_snapshot IS DISTINCT FROM current_event.coverage_snapshot
      OR NEW.template_version<>current_event.template_version OR NEW.template_hash<>current_event.template_hash
      OR NEW.coverage_version<>current_event.coverage_version OR NEW.coverage_hash<>current_event.coverage_hash
      OR NEW.source_check_ids IS DISTINCT FROM current_event.source_check_ids
      OR NEW.sample_evidence_ids IS DISTINCT FROM current_event.sample_evidence_ids
      OR NEW.pack_snapshot->'withdrawal'->>'withdrawn_by' IS DISTINCT FROM NEW.operator_user_id
      OR (NEW.pack_snapshot->'withdrawal'->>'withdrawn_at')::timestamptz IS DISTINCT FROM NEW.occurred_at
      OR NEW.pack_snapshot->'withdrawal'->>'reason' IS DISTINCT FROM NEW.reason
    THEN RAISE EXCEPTION 'withdrawal must target current active immutable production release' USING ERRCODE='23514'; END IF;
  END IF;
  IF NEW.action='production_rollback' THEN
    SELECT * INTO rollback_target FROM bb_rule_pack_production_release_events
      WHERE pack_id=NEW.pack_id AND id=NEW.target_event_id;
    IF NOT FOUND OR NOT has_current OR rollback_target.id=current_event.id
      OR rollback_target.sequence>=current_event.sequence
      OR rollback_target.action NOT IN ('production_release','production_rollback')
      OR NEW.pack_version<>rollback_target.pack_version OR NEW.content_hash<>rollback_target.content_hash
      OR NEW.market<>rollback_target.market OR NEW.offering<>rollback_target.offering
      OR NEW.instruments<>rollback_target.instruments OR NEW.document_stages<>rollback_target.document_stages
      OR NEW.effective_from<>rollback_target.effective_from OR NEW.effective_to IS DISTINCT FROM rollback_target.effective_to
      OR NEW.pack_snapshot IS DISTINCT FROM rollback_target.pack_snapshot
      OR NEW.template_snapshot IS DISTINCT FROM rollback_target.template_snapshot
      OR NEW.coverage_snapshot IS DISTINCT FROM rollback_target.coverage_snapshot
      OR NEW.template_version<>rollback_target.template_version OR NEW.template_hash<>rollback_target.template_hash
      OR NEW.coverage_version<>rollback_target.coverage_version OR NEW.coverage_hash<>rollback_target.coverage_hash
      OR NEW.source_check_ids<>rollback_target.source_check_ids OR NEW.sample_evidence_ids<>rollback_target.sample_evidence_ids
      OR NEW.industry_reviewer_user_id<>rollback_target.industry_reviewer_user_id
      OR NEW.industry_reviewer_grant_id<>rollback_target.industry_reviewer_grant_id
      OR NEW.technical_reviewer_user_id<>rollback_target.technical_reviewer_user_id
      OR NEW.technical_reviewer_grant_id<>rollback_target.technical_reviewer_grant_id
    THEN RAISE EXCEPTION 'rollback must replay an exact immutable historical production release' USING ERRCODE='23514'; END IF;
  END IF;
  IF NEW.action IN ('production_release','production_rollback') THEN
    SELECT count(*) INTO bad_count FROM jsonb_array_elements(NEW.coverage_snapshot->'items') item
      WHERE item->>'disposition'='uncovered';
    IF bad_count>0 OR jsonb_array_length(NEW.coverage_snapshot->'items')=0 THEN
      RAISE EXCEPTION 'complete bundle coverage evidence required' USING ERRCODE='23514';
    END IF;
    -- Match publishRulePack's business gates even when an event is inserted
    -- directly into the registry rather than produced by the domain publisher.
    SELECT count(*) INTO bad_count FROM jsonb_array_elements(NEW.pack_snapshot->'sources') src
      WHERE src->>'kind'='unverified_lead'
        OR (src->>'kind'<>'unverified_lead' AND
            (NULLIF(src->>'verified_by','') IS NULL OR NULLIF(src->>'verified_at','') IS NULL))
        OR (src->>'kind' IN ('formal_rule','official_interpretation') AND
            (NULLIF(src->>'published_on','') IS NULL OR NULLIF(src->>'effective_from','') IS NULL))
        OR (NULLIF(src->>'effective_from','') IS NOT NULL AND NULLIF(src->>'effective_to','') IS NOT NULL
            AND (src->>'effective_to')::date<(src->>'effective_from')::date)
        OR (NULLIF(src->>'effective_to','') IS NOT NULL AND (src->>'effective_to')::date<NEW.occurred_at::date)
        OR (NULLIF(src->>'verified_at','') IS NOT NULL AND (src->>'verified_at')::timestamptz>NEW.occurred_at);
    IF NEW.action='production_release'
      AND NEW.pack_snapshot->'validity'->>'published_on' IS DISTINCT FROM NEW.occurred_at::date::text THEN
      RAISE EXCEPTION 'pack publication date must match release event date' USING ERRCODE='23514';
    END IF;
    IF bad_count>0 OR (NULLIF(NEW.pack_snapshot->'validity'->>'effective_to','') IS NOT NULL
        AND (NEW.pack_snapshot->'validity'->>'effective_to')::date<NEW.occurred_at::date) THEN
      RAISE EXCEPTION 'expired or unverified sources cannot be production published' USING ERRCODE='23514';
    END IF;
    SELECT count(*) INTO bad_count FROM jsonb_array_elements(NEW.pack_snapshot->'rules') r
      WHERE r->>'enabled' IS DISTINCT FROM 'true' OR r->>'enforcement'='research_only';
    IF bad_count>0 THEN RAISE EXCEPTION 'disabled or research-only rules cannot be production published' USING ERRCODE='23514'; END IF;
    SELECT count(*) INTO bad_count FROM jsonb_array_elements(NEW.pack_snapshot->'sample_suite'->'cases') c
      WHERE c->>'result' IS DISTINCT FROM 'passed'
        OR NULLIF(c->>'reviewed_at','') IS NULL
        OR (c->>'reviewed_at')::timestamptz>NEW.occurred_at;
    IF bad_count>0 OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.pack_snapshot->'sample_suite'->'cases') c WHERE c->>'polarity'='positive')
      OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.pack_snapshot->'sample_suite'->'cases') c WHERE c->>'polarity'='negative')
      OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.pack_snapshot->'sample_suite'->'cases') c WHERE c->>'polarity'='boundary') THEN
      RAISE EXCEPTION 'production release requires passed positive negative and boundary samples reviewed by release time' USING ERRCODE='23514';
    END IF;
    SELECT count(*) INTO bad_count FROM jsonb_array_elements(NEW.pack_snapshot->'reviews') r
      WHERE NULLIF(r->>'reviewed_at','') IS NULL OR (r->>'reviewed_at')::timestamptz>NEW.occurred_at;
    IF bad_count>0 THEN RAISE EXCEPTION 'future review attestations cannot authorize a production release' USING ERRCODE='23514'; END IF;
    IF NEW.pack_snapshot->'sample_suite'->>'data_classification' IS DISTINCT FROM 'authorized_real'
      OR NEW.operator_user_id=NEW.industry_reviewer_user_id
      OR NEW.operator_user_id=NEW.technical_reviewer_user_id
      OR NEW.pack_snapshot->'release'->>'released_by' IS DISTINCT FROM NEW.operator_user_id
      OR (NEW.pack_snapshot->'release'->>'released_at')::timestamptz IS DISTINCT FROM NEW.occurred_at
      OR NEW.pack_snapshot->'release'->>'reason' IS DISTINCT FROM NEW.reason
      OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.pack_snapshot->'reviews') r
        WHERE r->>'reviewer_id'=NEW.industry_reviewer_user_id AND r->>'reviewer_role'='industry_reviewer'
          AND r->>'source_verified'='true' AND r->>'scope_verified'='true' AND r->>'samples_verified'='true')
      OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.pack_snapshot->'reviews') r
        WHERE r->>'reviewer_id'=NEW.technical_reviewer_user_id AND r->>'reviewer_role'='technical_reviewer'
          AND r->>'source_verified'='true' AND r->>'scope_verified'='true' AND r->>'samples_verified'='true')
    THEN RAISE EXCEPTION 'authorized-real sample pack and grant-bound review attestations required' USING ERRCODE='23514'; END IF;
    SELECT count(*) INTO bad_count FROM unnest(NEW.source_check_ids) sid
    LEFT JOIN bb_rule_pack_production_source_checks s ON s.id=sid
      AND s.pack_id=NEW.pack_id AND s.pack_version=NEW.pack_version AND s.pack_hash=NEW.content_hash
      AND s.checked_at<=NEW.occurred_at AND s.effective_from<=NEW.occurred_at::date
      AND s.created_at<=NEW.occurred_at AND (s.effective_to IS NULL OR s.effective_to>=NEW.occurred_at::date)
      AND EXISTS (SELECT 1 FROM bb_rule_pack_production_reviewer_grants sg WHERE sg.id=s.verifier_grant_id
        AND sg.user_id=s.verifier_user_id AND sg.granted_at<=NEW.occurred_at)
    WHERE s.id IS NULL;
    IF cardinality(NEW.source_check_ids)=0 OR bad_count>0 THEN
      RAISE EXCEPTION 'current official source verification evidence required' USING ERRCODE='23514';
    END IF;
    SELECT count(*) INTO bad_count FROM jsonb_array_elements(NEW.pack_snapshot->'sources') src
      WHERE NOT EXISTS (SELECT 1 FROM bb_rule_pack_production_source_checks s
        WHERE s.id=ANY(NEW.source_check_ids) AND s.pack_id=NEW.pack_id AND s.pack_version=NEW.pack_version
          AND s.pack_hash=NEW.content_hash AND s.source_id=src->>'source_id'
          AND s.market=NEW.market AND s.offering=NEW.offering
          AND s.authority=src->>'authority' AND s.official_url=src->>'official_url'
          AND s.source_version=src->>'source_version' AND s.document_hash IS NOT DISTINCT FROM NULLIF(src->>'document_hash','')::char(64)
          AND s.clause_locator=src->>'clause_locator' AND s.exact_quote=src->>'exact_quote'
          AND s.effective_from IS NOT DISTINCT FROM NULLIF(src->>'effective_from','')::date
          AND s.effective_to IS NOT DISTINCT FROM NULLIF(src->>'effective_to','')::date);
    IF bad_count>0 THEN RAISE EXCEPTION 'each pack source requires exact current verification evidence' USING ERRCODE='23514'; END IF;
    SELECT count(DISTINCT polarity) INTO polarity_count FROM unnest(NEW.sample_evidence_ids) sid
      JOIN bb_rule_pack_production_sample_evidence s ON s.id=sid AND s.pack_id=NEW.pack_id
        AND s.pack_version=NEW.pack_version AND s.pack_hash=NEW.content_hash
        AND s.market=NEW.market AND s.offering=NEW.offering;
    IF cardinality(NEW.sample_evidence_ids)<3 OR polarity_count<>3 OR
       cardinality(NEW.sample_evidence_ids)<>(SELECT count(DISTINCT x) FROM unnest(NEW.sample_evidence_ids) x) THEN
      RAISE EXCEPTION 'authorized positive negative and boundary sample evidence required' USING ERRCODE='23514';
    END IF;
    SELECT count(*) INTO bad_count FROM jsonb_array_elements(NEW.pack_snapshot->'sample_suite'->'cases') c
      WHERE NOT EXISTS (SELECT 1 FROM bb_rule_pack_production_sample_evidence s
        JOIN bb_rule_pack_production_reviewer_grants g ON g.id=s.reviewer_grant_id AND g.user_id=s.reviewer_user_id
        JOIN bb_rule_pack_sample_authorizations a ON a.id=s.authorization_id AND a.material_sha256=s.material_sha256
          AND a.market=s.market AND a.offering=s.offering
        JOIN bb_rule_pack_production_reviewer_grants ag ON ag.id=a.authorizer_grant_id AND ag.user_id=a.authorized_by_user_id
        WHERE s.id=ANY(NEW.sample_evidence_ids) AND s.pack_id=NEW.pack_id AND s.pack_version=NEW.pack_version
          AND s.pack_hash=NEW.content_hash AND s.market=NEW.market AND s.offering=NEW.offering
          AND s.sample_case_id=c->>'case_id' AND s.polarity=c->>'polarity'
          AND s.expected_outcome=c->>'expected_outcome' AND c->>'result'='passed'
          AND s.reviewer_user_id=c->>'reviewed_by' AND g.role IN ('rule_pack_industry_reviewer','rule_pack_technical_reviewer')
          AND g.market=NEW.market AND g.offering=NEW.offering AND g.revoked_at IS NULL
          AND a.revoked_at IS NULL AND a.authorization_scope='rule_pack_validation' AND a.authorized_at<=NEW.occurred_at
          AND ag.role='rule_pack_operator' AND ag.market=NEW.market AND ag.offering=NEW.offering AND ag.revoked_at IS NULL
          AND ag.granted_at<=NEW.occurred_at AND s.reviewed_at<=NEW.occurred_at AND g.granted_at<=NEW.occurred_at
          AND a.authorization_document_sha256 ~ '^[a-f0-9]{64}$');
    IF bad_count>0 OR jsonb_array_length(NEW.pack_snapshot->'sample_suite'->'cases')<>cardinality(NEW.sample_evidence_ids) THEN
      RAISE EXCEPTION 'every positive negative and boundary pack sample requires exact authorized material and reviewer evidence' USING ERRCODE='23514';
    END IF;
  END IF;
  INSERT INTO bb_outbox (id,owner_user_id,aggregate_type,aggregate_id,event_type,payload)
  VALUES ('rule-pack-prod-' || NEW.id,'system','rule_pack_production',NEW.pack_id,'rule_pack.' || NEW.action,
    jsonb_build_object('event_id',NEW.id,'pack_id',NEW.pack_id,'version',NEW.pack_version,
      'content_hash',NEW.content_hash,'market',NEW.market,'offering',NEW.offering,'action',NEW.action,
      'target_event_id',NEW.target_event_id));
  RETURN NEW;
END $$;
CREATE TRIGGER bb_rule_pack_production_event_guard
  BEFORE INSERT OR UPDATE OR DELETE ON bb_rule_pack_production_release_events
  FOR EACH ROW EXECUTE FUNCTION bb_rule_pack_production_event_guard();

COMMENT ON TABLE bb_rule_pack_production_reviewer_grants IS
  'Privileged, out-of-band role grants linked to authenticated users; no worker/API grant creation path exists.';
COMMENT ON TABLE bb_rule_pack_production_source_checks IS
  'Immutable official-source verification records bound to an exact pack content hash and active industry-reviewer grant.';
COMMENT ON TABLE bb_rule_pack_production_sample_evidence IS
  'Immutable authorized real positive/negative/boundary sample results; empty until authorization and professional evidence are supplied.';
COMMENT ON TABLE bb_rule_pack_production_release_events IS
  'Separate append-only production registry. Every event requires scoped database grants, current sources, authorized real samples, exact applicability scope, idempotency key, and transactional outbox.';
