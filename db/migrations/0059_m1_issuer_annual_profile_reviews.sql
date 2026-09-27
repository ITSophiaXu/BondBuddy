-- #33 target annual business-profile review authority is separate from both
-- #15 issuer identity review and the #77 reference-library review workflow.
ALTER TABLE bb_issuer_business_profiles
  ADD COLUMN source_material_sha256 char(64),
  ADD COLUMN parse_snapshot_id text,
  ADD COLUMN parse_snapshot_sha256 char(64),
  ADD COLUMN evidence_record_hashes jsonb,
  ADD COLUMN annual_revenue_basis jsonb,
  ADD COLUMN annual_revenue_total text,
  ADD COLUMN annual_revenue_total_evidence jsonb,
  ADD COLUMN third_place_tie_proof jsonb;

ALTER TABLE bb_issuer_business_profiles
  ADD CONSTRAINT bb_issuer_profile_source_sha_check CHECK (source_material_sha256 IS NULL OR source_material_sha256 ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT bb_issuer_profile_parse_sha_check CHECK (parse_snapshot_sha256 IS NULL OR parse_snapshot_sha256 ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT bb_issuer_profile_revenue_total_check CHECK (annual_revenue_total IS NULL OR annual_revenue_total ~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$'),
  ADD CONSTRAINT bb_issuer_profile_revenue_basis_check CHECK (annual_revenue_basis IS NULL OR jsonb_typeof(annual_revenue_basis)='object'),
  ADD CONSTRAINT bb_issuer_profile_total_evidence_check CHECK (annual_revenue_total_evidence IS NULL OR jsonb_typeof(annual_revenue_total_evidence)='array'),
  ADD CONSTRAINT bb_issuer_profile_tie_proof_check CHECK (third_place_tie_proof IS NULL OR jsonb_typeof(third_place_tie_proof)='object'),
  ADD CONSTRAINT bb_issuer_profile_record_hashes_check CHECK (evidence_record_hashes IS NULL OR jsonb_typeof(evidence_record_hashes)='object'),
  ADD CONSTRAINT bb_issuer_profile_parse_snapshot_fk FOREIGN KEY
    (owner_user_id,project_id,source_material_id,source_material_version,parse_snapshot_id)
    REFERENCES bb_parse_snapshots(owner_user_id,project_id,material_id,material_version,id);

-- SQL twin of loadVerifiedIssuerIdentitySourceRecord for write-time fail-closed checks.
CREATE FUNCTION bb_issuer_identity_profile_binding_current(p_owner text,p_project text,p_material text,p_material_version integer,
  p_record text,p_entity text) RETURNS boolean LANGUAGE sql STABLE AS $$
  WITH observations AS (
    SELECT r.*,rv.id AS review_id,rv.decision,rv.verified_entity_id,rv.entity_basis_kind,rv.entity_basis_ref,
      g.id AS active_grant_id,g.revoked_at
      FROM bb_issuer_identity_source_records r
      LEFT JOIN bb_issuer_identity_source_reviews rv ON rv.owner_user_id=r.owner_user_id AND rv.project_id=r.project_id
        AND rv.material_id=r.material_id AND rv.material_version=r.material_version AND rv.source_record_id=r.id
      LEFT JOIN bb_issuer_identity_reviewer_grants g ON g.id=rv.reviewer_grant_id AND g.user_id=rv.reviewer_user_id
        AND g.role='issuer_identity_reviewer' AND g.scope_owner_user_id=r.owner_user_id AND g.scope_project_id=r.project_id
     WHERE r.owner_user_id=p_owner AND r.project_id=p_project AND r.material_id=p_material AND r.material_version=p_material_version
  ), verified AS (SELECT * FROM observations WHERE decision='verified' AND active_grant_id IS NOT NULL AND revoked_at IS NULL)
  SELECT EXISTS(SELECT 1 FROM verified WHERE id=p_record AND entity_id IS NOT NULL AND verified_entity_id=p_entity
      AND identity_version=(SELECT max(identity_version) FROM verified))
    AND (SELECT count(*)>0 AND count(DISTINCT verified_entity_id)=1 AND min(verified_entity_id)=p_entity FROM verified)
    AND NOT EXISTS(SELECT 1 FROM observations WHERE review_id IS NULL OR active_grant_id IS NULL OR revoked_at IS NOT NULL
      OR decision NOT IN ('verified','rejected'))
    AND NOT EXISTS(SELECT 1 FROM observations WHERE decision='verified' AND (
      verified_entity_id IS NULL OR entity_basis_kind NOT IN ('uscc','registry_record','manual_attestation')
      OR entity_basis_ref IS NULL OR length(btrim(entity_basis_ref)) NOT BETWEEN 1 AND 512
      OR (verified_entity_id !~ '^uscc:[0-9A-HJ-NPQRTUWXY]{18}$' AND
          verified_entity_id !~ '^entity:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')
      OR (entity_basis_kind='uscc' AND verified_entity_id<>'uscc:'||entity_basis_ref)))
    AND NOT EXISTS(SELECT 1 FROM verified candidate
      JOIN bb_issuer_identity_source_records other ON other.owner_user_id=candidate.owner_user_id
        AND other.project_id=candidate.project_id AND other.entity_id=candidate.entity_id AND other.id<>candidate.id
      JOIN bb_issuer_identity_source_reviews other_review ON other_review.owner_user_id=other.owner_user_id
        AND other_review.project_id=other.project_id AND other_review.material_id=other.material_id
        AND other_review.material_version=other.material_version AND other_review.source_record_id=other.id
        AND other_review.decision='verified'
      JOIN bb_issuer_identity_reviewer_grants other_grant ON other_grant.id=other_review.reviewer_grant_id
        AND other_grant.user_id=other_review.reviewer_user_id AND other_grant.role='issuer_identity_reviewer'
        AND other_grant.scope_owner_user_id=other.owner_user_id AND other_grant.scope_project_id=other.project_id
        AND other_grant.revoked_at IS NULL
     WHERE candidate.entity_id LIKE 'issuer-name:%' AND other_review.verified_entity_id IS DISTINCT FROM p_entity);
$$;

CREATE FUNCTION bb_issuer_business_profile_source_proof_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE material_hash char(64);
DECLARE parse_hash char(64);
DECLARE parse_state text;
DECLARE latest_parse_id text;
DECLARE input_manifest jsonb;
DECLARE input_materials jsonb;
DECLARE source_role text;
DECLARE expected_refs text[];
DECLARE supplied_refs text[];
DECLARE revenue_sum numeric;
DECLARE revenue_lines integer;
DECLARE third_amount numeric;
DECLARE third_tie_count integer;
DECLARE tied_codes text[];
DECLARE proof_codes text[];
BEGIN
  IF TG_OP<>'INSERT' THEN RETURN NEW; END IF;
  IF NEW.source_material_sha256 IS NULL OR NEW.parse_snapshot_id IS NULL OR NEW.parse_snapshot_sha256 IS NULL
     OR NEW.evidence_record_hashes IS NULL OR NEW.annual_revenue_basis IS NULL OR NEW.annual_revenue_total IS NULL
     OR NEW.annual_revenue_total_evidence IS NULL OR NEW.third_place_tie_proof IS NULL THEN
    RAISE EXCEPTION 'complete issuer annual profile proof required' USING ERRCODE='23514';
  END IF;
  SELECT sha256,role INTO material_hash,source_role FROM bb_material_versions WHERE owner_user_id=NEW.owner_user_id AND project_id=NEW.project_id
    AND id=NEW.source_material_id AND version=NEW.source_material_version AND deleted_at IS NULL FOR SHARE;
  SELECT response_sha256,response_status INTO parse_hash,parse_state FROM bb_parse_snapshots WHERE owner_user_id=NEW.owner_user_id
    AND project_id=NEW.project_id AND material_id=NEW.source_material_id AND material_version=NEW.source_material_version
    AND id=NEW.parse_snapshot_id FOR SHARE;
  SELECT id INTO latest_parse_id FROM bb_parse_snapshots WHERE owner_user_id=NEW.owner_user_id AND project_id=NEW.project_id
    AND material_id=NEW.source_material_id AND material_version=NEW.source_material_version ORDER BY created_at DESC,id DESC LIMIT 1;
  IF material_hash IS DISTINCT FROM NEW.source_material_sha256 OR source_role NOT IN ('audit','financial','notes') OR parse_hash IS DISTINCT FROM NEW.parse_snapshot_sha256
     OR parse_state IS DISTINCT FROM 'parsed' OR latest_parse_id IS DISTINCT FROM NEW.parse_snapshot_id THEN
    RAISE EXCEPTION 'issuer annual profile source or latest parse snapshot changed' USING ERRCODE='23514';
  END IF;
  SELECT manifest,material_versions INTO input_manifest,input_materials FROM bb_input_revisions WHERE owner_user_id=NEW.owner_user_id
    AND project_id=NEW.project_id AND revision=NEW.input_revision AND input_hash=NEW.input_hash FOR SHARE;
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(input_materials) m WHERE m->>'material_id'=NEW.source_material_id
       AND (m->>'material_version')::int=NEW.source_material_version)
     OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(input_manifest->'materials') m WHERE m->>'material_id'=NEW.source_material_id
       AND (m->>'material_version')::int=NEW.source_material_version AND lower(m->>'sha256')=NEW.source_material_sha256)
     OR input_manifest#>>'{issuer_identity,status}'<>'verified'
     OR input_manifest#>>'{issuer_identity,entity_id}'<>NEW.profile->>'issuerId' THEN
    RAISE EXCEPTION 'issuer annual profile lacks exact input material and verified identity binding' USING ERRCODE='23514';
  END IF;
  IF NEW.profile->>'accountingScope'<>'consolidated' OR NEW.profile->>'revenueBasis'<>'main_business_revenue'
     OR NEW.profile->>'completeAnnualPeriod'<>'true' OR NEW.profile->>'latestCompleteAnnual'<>'true'
     OR NEW.profile->>'allComparableBusinessLinesPresent'<>'true'
     OR NEW.annual_revenue_total !~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$'
     OR (NEW.third_place_tie_proof->>'status') NOT IN ('clear','unresolved')
     OR NEW.third_place_tie_proof->>'thresholdRevenue' !~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$'
     OR jsonb_typeof(NEW.third_place_tie_proof->'tiedBusinessCodes')<>'array'
     OR jsonb_typeof(NEW.third_place_tie_proof->'evidence')<>'array' OR jsonb_array_length(NEW.third_place_tie_proof->'evidence')=0 THEN
    RAISE EXCEPTION 'annual profile must be complete consolidated main-business revenue' USING ERRCODE='23514';
  END IF;
  IF (NEW.annual_revenue_basis->>'fiscalYear')::int IS DISTINCT FROM (NEW.profile->>'fiscalYear')::int
     OR NEW.annual_revenue_basis->>'accountingScope' IS DISTINCT FROM NEW.profile->>'accountingScope'
     OR NEW.annual_revenue_basis->>'revenueBasis' IS DISTINCT FROM NEW.profile->>'revenueBasis'
     OR NEW.annual_revenue_basis->>'currency' IS DISTINCT FROM NEW.profile->>'currency'
     OR NEW.annual_revenue_basis->>'unit' IS DISTINCT FROM NEW.profile->>'unit' THEN
    RAISE EXCEPTION 'annual revenue denominator basis must match profile rows' USING ERRCODE='23514';
  END IF;
  SELECT count(*),COALESCE(sum((line->>'revenue')::numeric),0) INTO revenue_lines,revenue_sum
    FROM jsonb_array_elements(NEW.profile->'lines') AS line
   WHERE line->>'revenue' ~ '^(0|[1-9][0-9]*)(\.[0-9]+)?$';
  IF revenue_lines<3 OR revenue_lines<>jsonb_array_length(NEW.profile->'lines') OR revenue_sum<>NEW.annual_revenue_total::numeric THEN
    RAISE EXCEPTION 'annual profile rows do not reconcile to the same-basis denominator' USING ERRCODE='23514';
  END IF;
  SELECT (line->>'revenue')::numeric INTO third_amount FROM jsonb_array_elements(NEW.profile->'lines') AS line
    ORDER BY (line->>'revenue')::numeric DESC,line->>'code' LIMIT 1 OFFSET 2;
  SELECT count(*) INTO third_tie_count FROM jsonb_array_elements(NEW.profile->'lines') AS line WHERE (line->>'revenue')::numeric=third_amount;
  SELECT array_agg(line->>'code' ORDER BY line->>'code') INTO tied_codes FROM jsonb_array_elements(NEW.profile->'lines') AS line
    WHERE (line->>'revenue')::numeric=third_amount;
  SELECT array_agg(code ORDER BY code) INTO proof_codes FROM jsonb_array_elements_text(NEW.third_place_tie_proof->'tiedBusinessCodes') AS codes(code);
  IF third_amount IS NULL OR (NEW.third_place_tie_proof->>'thresholdRevenue')::numeric<>third_amount
     OR (NEW.third_place_tie_proof->>'status'='clear' AND third_tie_count<>1)
     OR (NEW.third_place_tie_proof->>'status'='unresolved' AND third_tie_count<2)
     OR tied_codes IS DISTINCT FROM proof_codes THEN
    RAISE EXCEPTION 'third-place tie proof does not match the complete revenue rows' USING ERRCODE='23514';
  END IF;
  IF EXISTS(SELECT 1 FROM (
    SELECT (line->>'rank')::int AS supplied_rank,row_number() OVER (ORDER BY (line->>'revenue')::numeric DESC,line->>'code') AS expected_rank
      FROM jsonb_array_elements(NEW.profile->'lines') AS line
  ) ranked WHERE supplied_rank<>expected_rank) THEN
    RAISE EXCEPTION 'annual profile revenue ranks do not match its complete rows' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM bb_issuer_identity_source_records r WHERE r.owner_user_id=NEW.owner_user_id
      AND r.project_id=NEW.project_id AND r.id=input_manifest#>>'{issuer_identity,record_id}'
      AND r.identity_version=(input_manifest#>>'{issuer_identity,version}')::int
      AND r.content_sha256=input_manifest#>>'{issuer_identity,content_hash}'
      AND r.material_id=input_manifest#>>'{issuer_identity,material_id}'
      AND r.material_version=(input_manifest#>>'{issuer_identity,material_version}')::int
      AND r.snapshot_id=input_manifest#>>'{issuer_identity,source_snapshot_id}'
      AND r.source_record_id=input_manifest#>>'{issuer_identity,source_record_id}'
      AND r.source_record_sha256=input_manifest#>>'{issuer_identity,source_record_sha256}')
    OR NOT bb_issuer_identity_profile_binding_current(NEW.owner_user_id,NEW.project_id,
      input_manifest#>>'{issuer_identity,material_id}',(input_manifest#>>'{issuer_identity,material_version}')::int,
      input_manifest#>>'{issuer_identity,record_id}',input_manifest#>>'{issuer_identity,entity_id}') THEN
    RAISE EXCEPTION 'current #15 verified issuer identity binding required' USING ERRCODE='23514';
  END IF;
  SELECT array_agg(DISTINCT ref ORDER BY ref) INTO expected_refs FROM (
    SELECT jsonb_array_elements_text(NEW.profile->'sourceEvidence') AS ref
    UNION ALL SELECT jsonb_array_elements_text(NEW.annual_revenue_total_evidence)
    UNION ALL SELECT jsonb_array_elements_text(NEW.third_place_tie_proof->'evidence')
    UNION ALL SELECT jsonb_array_elements_text(line->'evidence') FROM jsonb_array_elements(NEW.profile->'lines') AS line
    UNION ALL SELECT jsonb_array_elements_text(line->'classificationEvidence') FROM jsonb_array_elements(NEW.profile->'lines') AS line
  ) refs;
  SELECT array_agg(DISTINCT ref ORDER BY ref) INTO supplied_refs FROM (
    SELECT jsonb_array_elements_text(NEW.evidence_refs) AS ref
  ) refs;
  IF expected_refs IS DISTINCT FROM supplied_refs OR EXISTS(
    SELECT 1 FROM jsonb_each_text(NEW.evidence_record_hashes) h
    LEFT JOIN bb_parse_evidence e ON e.owner_user_id=NEW.owner_user_id AND e.project_id=NEW.project_id
      AND e.material_id=NEW.source_material_id AND e.material_version=NEW.source_material_version
      AND e.snapshot_id=NEW.parse_snapshot_id AND e.record_id=h.key AND e.record_sha256=h.value AND e.content_sha256=NEW.source_material_sha256
    WHERE e.record_id IS NULL
  ) OR (SELECT count(*) FROM jsonb_object_keys(NEW.evidence_record_hashes))<>cardinality(expected_refs) THEN
    RAISE EXCEPTION 'issuer annual profile evidence is not exact in pinned parse snapshot' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bb_issuer_business_profile_source_proof_guard BEFORE INSERT ON bb_issuer_business_profiles
  FOR EACH ROW EXECUTE FUNCTION bb_issuer_business_profile_source_proof_guard();

CREATE TABLE bb_issuer_annual_profile_reviewer_grants (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES bb_users(id),
  role text NOT NULL DEFAULT 'issuer_annual_profile_reviewer' CHECK(role='issuer_annual_profile_reviewer'),
  granted_by text NOT NULL REFERENCES bb_users(id),
  reason_code text NOT NULL CHECK(reason_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  authorization_basis text NOT NULL CHECK(length(btrim(authorization_basis)) BETWEEN 1 AND 2048),
  scope_owner_user_id text NOT NULL,
  scope_project_id text NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by text REFERENCES bb_users(id),
  revocation_reason_code text,
  revocation_basis text,
  UNIQUE(user_id,id,scope_owner_user_id,scope_project_id),
  FOREIGN KEY(scope_owner_user_id,scope_project_id) REFERENCES bb_projects(owner_user_id,id),
  CHECK(user_id<>scope_owner_user_id),
  CHECK((revoked_at IS NULL AND revoked_by IS NULL AND revocation_reason_code IS NULL AND revocation_basis IS NULL) OR
        (revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND revocation_reason_code ~ '^[a-z][a-z0-9_]{0,63}$'
          AND revocation_basis IS NOT NULL AND length(btrim(revocation_basis)) BETWEEN 1 AND 2048))
);
CREATE UNIQUE INDEX bb_issuer_annual_profile_reviewer_active_scope_idx
  ON bb_issuer_annual_profile_reviewer_grants(user_id,scope_owner_user_id,scope_project_id) WHERE revoked_at IS NULL;

CREATE FUNCTION bb_issuer_annual_profile_reviewer_grant_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'issuer annual profile reviewer grants are retained' USING ERRCODE='23514'; END IF;
  IF OLD.revoked_at IS NOT NULL OR NEW.id<>OLD.id OR NEW.user_id<>OLD.user_id OR NEW.role<>OLD.role
     OR NEW.granted_by<>OLD.granted_by OR NEW.reason_code<>OLD.reason_code OR NEW.authorization_basis<>OLD.authorization_basis
     OR NEW.scope_owner_user_id<>OLD.scope_owner_user_id OR NEW.scope_project_id<>OLD.scope_project_id OR NEW.granted_at<>OLD.granted_at
     OR OLD.revoked_by IS NOT NULL OR OLD.revocation_reason_code IS NOT NULL OR OLD.revocation_basis IS NOT NULL
     OR NEW.revoked_at IS NULL OR NEW.revoked_by IS NULL OR NEW.revocation_reason_code IS NULL OR NEW.revocation_basis IS NULL
  THEN RAISE EXCEPTION 'issuer annual profile reviewer grant permits one audited revocation only' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bb_issuer_annual_profile_reviewer_grant_guard BEFORE UPDATE OR DELETE
  ON bb_issuer_annual_profile_reviewer_grants FOR EACH ROW EXECUTE FUNCTION bb_issuer_annual_profile_reviewer_grant_guard();

CREATE TABLE bb_issuer_annual_profile_reviews (
  sequence_id bigserial UNIQUE NOT NULL,
  id text PRIMARY KEY,
  request_id text NOT NULL CHECK(request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  request_hash char(64) NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  owner_user_id text NOT NULL,
  project_id text NOT NULL,
  run_id text NOT NULL,
  profile_id text NOT NULL,
  profile_version integer NOT NULL CHECK(profile_version>0),
  profile_sha256 char(64) NOT NULL CHECK(profile_sha256 ~ '^[a-f0-9]{64}$'),
  input_revision integer NOT NULL CHECK(input_revision>0),
  input_hash char(64) NOT NULL CHECK(input_hash ~ '^[a-f0-9]{64}$'),
  source_material_id text NOT NULL,
  source_material_version integer NOT NULL CHECK(source_material_version>0),
  source_material_sha256 char(64) NOT NULL CHECK(source_material_sha256 ~ '^[a-f0-9]{64}$'),
  parse_snapshot_id text NOT NULL,
  parse_snapshot_sha256 char(64) NOT NULL CHECK(parse_snapshot_sha256 ~ '^[a-f0-9]{64}$'),
  issuer_identity_record_id text NOT NULL,
  issuer_identity_version integer NOT NULL CHECK(issuer_identity_version>0),
  issuer_identity_hash char(64) NOT NULL CHECK(issuer_identity_hash ~ '^[a-f0-9]{64}$'),
  verified_entity_id text NOT NULL,
  action text NOT NULL CHECK(action IN ('approve','request_more_evidence','withdraw')),
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2048),
  reviewer_attestation text NOT NULL CHECK(reviewer_attestation='manual_source_evidence_review'),
  reviewer_user_id text NOT NULL REFERENCES bb_users(id),
  reviewer_grant_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_user_id,project_id,request_id),
  FOREIGN KEY(owner_user_id,project_id,run_id) REFERENCES bb_runs(owner_user_id,project_id,id),
  FOREIGN KEY(profile_id) REFERENCES bb_issuer_business_profiles(id),
  FOREIGN KEY(reviewer_user_id,reviewer_grant_id,owner_user_id,project_id)
    REFERENCES bb_issuer_annual_profile_reviewer_grants(user_id,id,scope_owner_user_id,scope_project_id)
);
CREATE INDEX bb_issuer_annual_profile_reviews_latest_idx
  ON bb_issuer_annual_profile_reviews(owner_user_id,project_id,profile_id,sequence_id DESC);

CREATE FUNCTION bb_issuer_annual_profile_review_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE profile_row bb_issuer_business_profiles%ROWTYPE;
DECLARE grant_revoked timestamptz;
DECLARE input_manifest jsonb;
DECLARE input_materials jsonb;
DECLARE identity_entity text;
DECLARE identity_version integer;
DECLARE identity_hash char(64);
DECLARE previous_action text;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'issuer annual profile reviews are append-only' USING ERRCODE='23514'; END IF;
  SELECT g.revoked_at INTO grant_revoked FROM bb_issuer_annual_profile_reviewer_grants g
    JOIN bb_projects p ON p.owner_user_id=g.scope_owner_user_id AND p.id=g.scope_project_id AND p.deleted_at IS NULL
    JOIN bb_users u ON u.id=g.user_id AND u.status='active'
   WHERE g.id=NEW.reviewer_grant_id AND g.user_id=NEW.reviewer_user_id AND g.role='issuer_annual_profile_reviewer'
     AND g.scope_owner_user_id=NEW.owner_user_id AND g.scope_project_id=NEW.project_id FOR SHARE OF g,p,u;
  IF NOT FOUND OR grant_revoked IS NOT NULL OR NEW.reviewer_user_id=NEW.owner_user_id THEN
    RAISE EXCEPTION 'current exact annual profile reviewer grant required' USING ERRCODE='42501';
  END IF;
  SELECT action INTO previous_action FROM bb_issuer_annual_profile_reviews
    WHERE owner_user_id=NEW.owner_user_id AND project_id=NEW.project_id AND profile_id=NEW.profile_id
    ORDER BY sequence_id DESC LIMIT 1;
  IF previous_action='withdraw' THEN
    RAISE EXCEPTION 'withdrawn annual issuer profile is terminal' USING ERRCODE='23514';
  END IF;
  SELECT * INTO profile_row FROM bb_issuer_business_profiles p
   WHERE p.owner_user_id=NEW.owner_user_id AND p.project_id=NEW.project_id AND p.id=NEW.profile_id FOR SHARE;
  IF NOT FOUND OR profile_row.run_id<>NEW.run_id OR profile_row.profile_version<>NEW.profile_version
     OR profile_row.profile_sha256<>NEW.profile_sha256 OR profile_row.input_revision<>NEW.input_revision OR profile_row.input_hash<>NEW.input_hash
     OR profile_row.source_material_id<>NEW.source_material_id OR profile_row.source_material_version<>NEW.source_material_version
     OR profile_row.source_material_sha256<>NEW.source_material_sha256 OR profile_row.parse_snapshot_id<>NEW.parse_snapshot_id
     OR profile_row.parse_snapshot_sha256<>NEW.parse_snapshot_sha256 OR profile_row.annual_revenue_total IS NULL
     OR profile_row.annual_revenue_total_evidence IS NULL OR profile_row.third_place_tie_proof IS NULL THEN
    RAISE EXCEPTION 'annual profile review source pin mismatch or incomplete profile proof' USING ERRCODE='23514';
  END IF;
  SELECT i.manifest,i.material_versions INTO input_manifest,input_materials FROM bb_input_revisions i
   JOIN bb_runs r ON r.owner_user_id=i.owner_user_id AND r.project_id=i.project_id AND r.input_revision=i.revision AND r.input_hash=i.input_hash
   WHERE i.owner_user_id=NEW.owner_user_id AND i.project_id=NEW.project_id AND i.revision=NEW.input_revision
     AND i.input_hash=NEW.input_hash AND r.id=NEW.run_id FOR SHARE OF i,r;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(input_materials) m
      WHERE m->>'material_id'=NEW.source_material_id AND (m->>'material_version')::int=NEW.source_material_version)
     OR input_manifest#>>'{issuer_identity,status}'<>'verified'
     OR input_manifest#>>'{issuer_identity,entity_id}'<>NEW.verified_entity_id
     OR input_manifest#>>'{issuer_identity,record_id}'<>NEW.issuer_identity_record_id
     OR input_manifest#>>'{issuer_identity,content_hash}'<>NEW.issuer_identity_hash
     OR (input_manifest#>>'{issuer_identity,version}')::int<>NEW.issuer_identity_version THEN
    RAISE EXCEPTION 'annual profile run/input or verified issuer binding mismatch' USING ERRCODE='23514';
  END IF;
  SELECT rv.verified_entity_id,r.identity_version,r.content_sha256 INTO identity_entity,identity_version,identity_hash
    FROM bb_issuer_identity_source_records r
    JOIN bb_issuer_identity_source_reviews rv ON rv.owner_user_id=r.owner_user_id AND rv.project_id=r.project_id
      AND rv.material_id=r.material_id AND rv.material_version=r.material_version AND rv.source_record_id=r.id AND rv.decision='verified'
    JOIN bb_issuer_identity_reviewer_grants g ON g.id=rv.reviewer_grant_id AND g.user_id=rv.reviewer_user_id
      AND g.role='issuer_identity_reviewer' AND g.revoked_at IS NULL
      AND g.scope_owner_user_id=NEW.owner_user_id AND g.scope_project_id=NEW.project_id
   WHERE r.owner_user_id=NEW.owner_user_id AND r.project_id=NEW.project_id AND r.id=NEW.issuer_identity_record_id
     AND r.identity_version=NEW.issuer_identity_version AND r.content_sha256=NEW.issuer_identity_hash
     AND r.material_id=input_manifest#>>'{issuer_identity,material_id}'
     AND r.material_version=(input_manifest#>>'{issuer_identity,material_version}')::int
     AND r.identity_version=(SELECT max(latest.identity_version) FROM bb_issuer_identity_source_records latest
       JOIN bb_issuer_identity_source_reviews latest_review ON latest_review.owner_user_id=latest.owner_user_id
         AND latest_review.project_id=latest.project_id AND latest_review.material_id=latest.material_id
         AND latest_review.material_version=latest.material_version AND latest_review.source_record_id=latest.id
         AND latest_review.decision='verified'
       JOIN bb_issuer_identity_reviewer_grants latest_grant ON latest_grant.id=latest_review.reviewer_grant_id
         AND latest_grant.user_id=latest_review.reviewer_user_id AND latest_grant.role='issuer_identity_reviewer'
         AND latest_grant.revoked_at IS NULL
       WHERE latest.owner_user_id=r.owner_user_id AND latest.project_id=r.project_id
         AND latest.material_id=r.material_id AND latest.material_version=r.material_version);
  IF identity_entity IS DISTINCT FROM NEW.verified_entity_id OR identity_version IS DISTINCT FROM NEW.issuer_identity_version
     OR identity_hash IS DISTINCT FROM NEW.issuer_identity_hash THEN RAISE EXCEPTION 'current reviewed issuer identity required' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM bb_issuer_identity_source_records observed
      LEFT JOIN bb_issuer_identity_source_reviews observed_review ON observed_review.owner_user_id=observed.owner_user_id
        AND observed_review.project_id=observed.project_id AND observed_review.material_id=observed.material_id
        AND observed_review.material_version=observed.material_version AND observed_review.source_record_id=observed.id
      LEFT JOIN bb_issuer_identity_reviewer_grants observed_grant ON observed_grant.id=observed_review.reviewer_grant_id
        AND observed_grant.user_id=observed_review.reviewer_user_id AND observed_grant.role='issuer_identity_reviewer'
        AND observed_grant.scope_owner_user_id=observed.owner_user_id AND observed_grant.scope_project_id=observed.project_id
      WHERE observed.owner_user_id=NEW.owner_user_id AND observed.project_id=NEW.project_id
        AND observed.material_id=input_manifest#>>'{issuer_identity,material_id}'
        AND observed.material_version=(input_manifest#>>'{issuer_identity,material_version}')::int
        AND (observed_review.id IS NULL OR observed_review.decision NOT IN ('verified','rejected') OR observed_grant.id IS NULL
          OR observed_grant.revoked_at IS NOT NULL OR (observed_review.decision='verified' AND
            observed_review.verified_entity_id IS DISTINCT FROM NEW.verified_entity_id))) THEN
    RAISE EXCEPTION 'issuer identity observations are unresolved, revoked or conflicting' USING ERRCODE='23514';
  END IF;
  IF NOT bb_issuer_identity_profile_binding_current(NEW.owner_user_id,NEW.project_id,
      input_manifest#>>'{issuer_identity,material_id}',(input_manifest#>>'{issuer_identity,material_version}')::int,
      NEW.issuer_identity_record_id,NEW.verified_entity_id) THEN
    RAISE EXCEPTION 'current #15 issuer identity binding or project candidate uniqueness required' USING ERRCODE='23514';
  END IF;
  IF NEW.action='approve' AND ((profile_row.third_place_tie_proof->>'status')<>'clear'
     OR profile_row.profile->>'issuerId'<>NEW.verified_entity_id OR profile_row.profile->>'verificationStatus'<>'pending'
     OR profile_row.profile->>'accountingScope'<>'consolidated' OR profile_row.profile->>'revenueBasis'<>'main_business_revenue'
     OR profile_row.profile->>'completeAnnualPeriod'<>'true' OR profile_row.profile->>'latestCompleteAnnual'<>'true'
     OR profile_row.profile->>'allComparableBusinessLinesPresent'<>'true') THEN
    RAISE EXCEPTION 'annual profile is not complete consolidated main-business revenue' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bb_issuer_annual_profile_review_guard BEFORE INSERT OR UPDATE OR DELETE
  ON bb_issuer_annual_profile_reviews FOR EACH ROW EXECUTE FUNCTION bb_issuer_annual_profile_review_guard();
CREATE FUNCTION bb_issuer_annual_profile_review_no_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'issuer annual profile reviews are append-only' USING ERRCODE='23514'; END $$;
CREATE TRIGGER bb_issuer_annual_profile_review_no_truncate BEFORE TRUNCATE
  ON bb_issuer_annual_profile_reviews FOR EACH STATEMENT EXECUTE FUNCTION bb_issuer_annual_profile_review_no_truncate();

COMMENT ON TABLE bb_issuer_annual_profile_reviewer_grants IS
  'Privileged project-scoped #33 annual profile review authority, independent of identity and reference-library grants.';
COMMENT ON TABLE bb_issuer_annual_profile_reviews IS
  'Append-only authenticated manual source-evidence review, evidence request and withdrawal decisions pinned to complete target annual profile and current #15 identity/material/input evidence. Not professional signoff.';
