-- #15: separate management-issued authority for reviewing an exact evidence context.
-- This follows #347's 0059 and #350's 0060; it does not upgrade candidates.
CREATE TABLE bb_fact_evidence_reviewer_grants (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES bb_users(id),
  role text NOT NULL CHECK (role='fact_evidence_reviewer'),
  granted_by text NOT NULL REFERENCES bb_users(id),
  reason_code text NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  authorization_basis text NOT NULL CHECK (length(btrim(authorization_basis)) BETWEEN 1 AND 2048),
  scope_owner_user_id text NOT NULL REFERENCES bb_users(id),
  scope_project_id text NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by text REFERENCES bb_users(id),
  revocation_reason text,
  CHECK (user_id<>scope_owner_user_id AND user_id<>granted_by),
  CHECK ((revoked_at IS NULL AND revoked_by IS NULL AND revocation_reason IS NULL) OR
    (revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND length(btrim(revocation_reason)) BETWEEN 1 AND 2048)),
  FOREIGN KEY(scope_owner_user_id,scope_project_id) REFERENCES bb_projects(owner_user_id,id),
  UNIQUE(id,user_id,scope_owner_user_id,scope_project_id)
);
CREATE UNIQUE INDEX bb_fact_evidence_reviewer_active_scope_idx
  ON bb_fact_evidence_reviewer_grants(user_id,scope_owner_user_id,scope_project_id) WHERE revoked_at IS NULL;

CREATE FUNCTION bb_fact_evidence_reviewer_grant_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE table_owner text; DECLARE actor_is_superuser boolean;
BEGIN
  SELECT owner.rolname,actor.rolsuper INTO table_owner,actor_is_superuser FROM pg_class c
    JOIN pg_roles owner ON owner.oid=c.relowner JOIN pg_roles actor ON actor.rolname=current_user WHERE c.oid=TG_RELID;
  IF table_owner IS NULL OR (NOT actor_is_superuser AND table_owner<>current_user) THEN
    RAISE EXCEPTION 'fact evidence grants require table owner or superuser' USING ERRCODE='42501';
  END IF;
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'fact evidence grants are retained' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.revoked_at IS NOT NULL OR NEW.revoked_by IS NOT NULL OR NEW.revocation_reason IS NOT NULL OR
      NOT EXISTS(SELECT 1 FROM bb_users u WHERE u.id=NEW.user_id AND u.status='active') OR
      NOT EXISTS(SELECT 1 FROM bb_users u WHERE u.id=NEW.granted_by AND u.status='active') OR
      NOT EXISTS(SELECT 1 FROM bb_projects p WHERE p.owner_user_id=NEW.scope_owner_user_id AND p.id=NEW.scope_project_id AND p.deleted_at IS NULL)
    THEN RAISE EXCEPTION 'invalid fact evidence grant scope or actor' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.revoked_at IS NOT NULL OR
    (to_jsonb(NEW)-'revoked_at'-'revoked_by'-'revocation_reason') IS DISTINCT FROM
    (to_jsonb(OLD)-'revoked_at'-'revoked_by'-'revocation_reason') OR NEW.revoked_at IS NULL OR
    NEW.revoked_by IS NULL OR NEW.revocation_reason IS NULL OR length(btrim(NEW.revocation_reason)) NOT BETWEEN 1 AND 2048 OR
    NOT EXISTS(SELECT 1 FROM bb_users u WHERE u.id=NEW.revoked_by AND u.status='active')
  THEN RAISE EXCEPTION 'fact evidence grant is immutable except one audited revocation' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bb_fact_evidence_reviewer_grant_guard BEFORE INSERT OR UPDATE OR DELETE
  ON bb_fact_evidence_reviewer_grants FOR EACH ROW EXECUTE FUNCTION bb_fact_evidence_reviewer_grant_guard();

CREATE TABLE bb_fact_evidence_reviews (
  id text PRIMARY KEY,
  request_id text NOT NULL,
  request_hash char(64) NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  owner_user_id text NOT NULL,
  project_id text NOT NULL,
  candidate_id text NOT NULL,
  candidate_identity_sha256 char(64) NOT NULL CHECK(candidate_identity_sha256 ~ '^[a-f0-9]{64}$'),
  candidate_snapshot jsonb NOT NULL CHECK(jsonb_typeof(candidate_snapshot)='object'),
  evidence_context_set_id text NOT NULL,
  evidence_set_sha256 char(64) NOT NULL CHECK(evidence_set_sha256 ~ '^[a-f0-9]{64}$'),
  input_revision integer NOT NULL,
  input_hash char(64) NOT NULL CHECK(input_hash ~ '^[a-f0-9]{64}$'),
  material_id text NOT NULL,
  material_version integer NOT NULL,
  material_sha256 char(64) NOT NULL CHECK(material_sha256 ~ '^[a-f0-9]{64}$'),
  snapshot_id text NOT NULL,
  parser_version text NOT NULL,
  parse_response_sha256 char(64) NOT NULL CHECK(parse_response_sha256 ~ '^[a-f0-9]{64}$'),
  source_kind text NOT NULL CHECK(source_kind IN ('audited','external')),
  assessments jsonb NOT NULL CHECK(jsonb_typeof(assessments)='array' AND jsonb_array_length(assessments) BETWEEN 1 AND 500),
  outcome text NOT NULL CHECK(outcome IN ('evidence_impact_reviewed','external_evidence_impact_reviewed','needs_more_evidence')),
  reviewer_user_id text NOT NULL,
  reviewer_grant_id text NOT NULL,
  authority text NOT NULL CHECK(authority='fact_evidence_reviewer'),
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2048),
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_user_id,project_id,request_id),
  UNIQUE(id,owner_user_id,project_id),
  FOREIGN KEY(owner_user_id,project_id,candidate_id) REFERENCES bb_fact_candidates(owner_user_id,project_id,id),
  FOREIGN KEY(owner_user_id,project_id,evidence_context_set_id) REFERENCES bb_fact_evidence_context_sets(owner_user_id,project_id,id),
  FOREIGN KEY(reviewer_grant_id,reviewer_user_id,owner_user_id,project_id)
    REFERENCES bb_fact_evidence_reviewer_grants(id,user_id,scope_owner_user_id,scope_project_id)
);
CREATE INDEX bb_fact_evidence_reviews_context_idx ON bb_fact_evidence_reviews(owner_user_id,project_id,evidence_context_set_id,reviewed_at DESC,id DESC);

CREATE FUNCTION bb_fact_evidence_candidate_snapshot(c bb_fact_candidates) RETURNS jsonb LANGUAGE SQL IMMUTABLE AS $$
  SELECT jsonb_build_object('candidate_id',c.id,'fact_key_hash',btrim(c.fact_key_hash::text),'fact_key',c.fact_key,
    'value_kind',c.value_kind,'value_decimal',c.value_decimal,'value_text',c.value_text,'source_kind',c.source_kind,
    'source_ref',c.source_ref,'status',c.status,'material_id',c.material_id,'material_version',c.material_version,
    'evidence',c.evidence,'uncertainty',c.uncertainty)
$$;

CREATE FUNCTION bb_fact_evidence_review_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ctx bb_fact_evidence_context_sets%ROWTYPE;
DECLARE candidate bb_fact_candidates%ROWTYPE;
DECLARE expected_count integer;
DECLARE actual_count integer;
DECLARE unresolved boolean;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'fact evidence reviews are append-only' USING ERRCODE='23514'; END IF;
  SELECT * INTO ctx FROM bb_fact_evidence_context_sets WHERE id=NEW.evidence_context_set_id
    AND owner_user_id=NEW.owner_user_id AND project_id=NEW.project_id AND candidate_id=NEW.candidate_id FOR SHARE;
  SELECT * INTO candidate FROM bb_fact_candidates WHERE id=NEW.candidate_id AND owner_user_id=NEW.owner_user_id
    AND project_id=NEW.project_id FOR SHARE;
  IF ctx.id IS NULL OR candidate.id IS NULL OR ctx.evidence_set_sha256<>NEW.evidence_set_sha256 OR
    ctx.input_revision<>NEW.input_revision OR ctx.input_hash<>NEW.input_hash OR ctx.material_id<>NEW.material_id OR
    ctx.material_version<>NEW.material_version OR ctx.snapshot_id<>NEW.snapshot_id OR ctx.parser_version<>NEW.parser_version OR
    ctx.parse_response_sha256<>NEW.parse_response_sha256 OR NEW.candidate_identity_sha256<>candidate.fact_key_hash OR
    NEW.source_kind<>candidate.source_kind OR ctx.manifest->>'candidate_identity_sha256'<>btrim(candidate.fact_key_hash::text) OR
    ctx.manifest->>'source_kind'<>candidate.source_kind OR NEW.candidate_snapshot IS DISTINCT FROM bb_fact_evidence_candidate_snapshot(candidate) OR NOT EXISTS(SELECT 1 FROM bb_fact_evidence_reviewer_grants g
      JOIN bb_users u ON u.id=g.user_id AND u.status='active' WHERE g.id=NEW.reviewer_grant_id AND g.user_id=NEW.reviewer_user_id
       AND g.role='fact_evidence_reviewer' AND g.scope_owner_user_id=NEW.owner_user_id AND g.scope_project_id=NEW.project_id AND g.revoked_at IS NULL)
  THEN RAISE EXCEPTION 'fact evidence review pins or active grant mismatch' USING ERRCODE='23514'; END IF;
  expected_count:=jsonb_array_length(ctx.manifest->'selected_body')+jsonb_array_length(ctx.manifest->'auxiliary_targets');
  actual_count:=jsonb_array_length(NEW.assessments);
  IF expected_count<>actual_count OR EXISTS(SELECT value->>'target_id' FROM jsonb_array_elements(NEW.assessments) GROUP BY value->>'target_id' HAVING count(*)<>1) OR
    EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.assessments) a WHERE a->>'assessment' NOT IN ('supports_candidate','contradicts_candidate','not_relevant','unresolved') OR length(btrim(a->>'reason'))=0) OR
    EXISTS(SELECT 1 FROM (SELECT value->>'record_id' target_id FROM jsonb_array_elements(ctx.manifest->'selected_body')
      UNION ALL SELECT value->>'target_id' FROM jsonb_array_elements(ctx.manifest->'auxiliary_targets')) expected
      WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.assessments) a WHERE a->>'target_id'=expected.target_id)) OR
    EXISTS(SELECT 1 FROM jsonb_array_elements(ctx.manifest->'selected_body') b JOIN jsonb_array_elements(NEW.assessments) a
      ON a->>'target_id'=b->>'record_id' WHERE a->>'assessment'='not_relevant')
  THEN RAISE EXCEPTION 'fact evidence review must assess every exact context member once' USING ERRCODE='23514'; END IF;
  unresolved:=NOT ctx.reviewable OR candidate.status IN ('conflicted','superseded') OR
    (candidate.source_kind='audited' AND jsonb_array_length(candidate.uncertainty)>0) OR
    EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.assessments) a WHERE a->>'assessment' IN ('contradicts_candidate','unresolved'));
  IF NEW.outcome<>(CASE WHEN unresolved THEN 'needs_more_evidence'
    WHEN candidate.source_kind='external' THEN 'external_evidence_impact_reviewed' ELSE 'evidence_impact_reviewed' END)
  THEN RAISE EXCEPTION 'fact evidence review outcome must be derived from pinned source and assessments' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bb_fact_evidence_review_guard BEFORE INSERT OR UPDATE OR DELETE ON bb_fact_evidence_reviews
  FOR EACH ROW EXECUTE FUNCTION bb_fact_evidence_review_guard();

CREATE TABLE bb_fact_evidence_review_withdrawals (
  id text PRIMARY KEY,
  request_id text NOT NULL,
  request_hash char(64) NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  review_id text NOT NULL UNIQUE,
  owner_user_id text NOT NULL,
  project_id text NOT NULL,
  reviewer_user_id text NOT NULL,
  reviewer_grant_id text NOT NULL,
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2048),
  withdrawn_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_user_id,project_id,request_id),
  FOREIGN KEY(review_id,owner_user_id,project_id) REFERENCES bb_fact_evidence_reviews(id,owner_user_id,project_id),
  FOREIGN KEY(reviewer_grant_id,reviewer_user_id,owner_user_id,project_id)
    REFERENCES bb_fact_evidence_reviewer_grants(id,user_id,scope_owner_user_id,scope_project_id)
);
CREATE FUNCTION bb_fact_evidence_withdrawal_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' OR NOT EXISTS(SELECT 1 FROM bb_fact_evidence_reviewer_grants g
    JOIN bb_users u ON u.id=g.user_id AND u.status='active' WHERE g.id=NEW.reviewer_grant_id AND g.user_id=NEW.reviewer_user_id
    AND g.role='fact_evidence_reviewer' AND g.scope_owner_user_id=NEW.owner_user_id AND g.scope_project_id=NEW.project_id AND g.revoked_at IS NULL)
  THEN RAISE EXCEPTION 'fact evidence withdrawal is append-only and requires active exact reviewer grant' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bb_fact_evidence_withdrawal_guard BEFORE INSERT OR UPDATE OR DELETE ON bb_fact_evidence_review_withdrawals
  FOR EACH ROW EXECUTE FUNCTION bb_fact_evidence_withdrawal_guard();

-- Latest review only; revoked grants, withdrawal, changed draft/input/material or a newer
-- parse snapshot all remove the row immediately. This is audit state, never verified status.
CREATE VIEW bb_current_fact_evidence_reviews AS
WITH latest AS (
 SELECT DISTINCT ON(owner_user_id,project_id,evidence_context_set_id) r.* FROM bb_fact_evidence_reviews r
 ORDER BY owner_user_id,project_id,evidence_context_set_id,reviewed_at DESC,id DESC
)
SELECT r.* FROM latest r
JOIN bb_projects p ON p.owner_user_id=r.owner_user_id AND p.id=r.project_id AND p.deleted_at IS NULL
JOIN bb_input_revisions i ON i.owner_user_id=r.owner_user_id AND i.project_id=r.project_id AND i.revision=r.input_revision
 AND i.input_hash=r.input_hash AND i.draft_revision=p.draft_revision
JOIN bb_material_versions m ON m.owner_user_id=r.owner_user_id AND m.project_id=r.project_id AND m.id=r.material_id
 AND m.version=r.material_version AND m.deleted_at IS NULL AND m.sha256=r.material_sha256
JOIN bb_fact_candidates c ON c.owner_user_id=r.owner_user_id AND c.project_id=r.project_id AND c.id=r.candidate_id
 AND c.fact_key_hash=r.candidate_identity_sha256 AND c.source_kind=r.source_kind
 AND r.candidate_snapshot=bb_fact_evidence_candidate_snapshot(c)
JOIN bb_fact_evidence_context_sets x ON x.owner_user_id=r.owner_user_id AND x.project_id=r.project_id
 AND x.id=r.evidence_context_set_id AND x.evidence_set_sha256=r.evidence_set_sha256
JOIN bb_parse_snapshots s ON s.owner_user_id=r.owner_user_id AND s.project_id=r.project_id AND s.id=r.snapshot_id
 AND s.material_id=r.material_id AND s.material_version=r.material_version AND s.parser_version=r.parser_version
 AND s.response_sha256=r.parse_response_sha256
JOIN bb_fact_evidence_reviewer_grants g ON g.id=r.reviewer_grant_id AND g.user_id=r.reviewer_user_id
 AND g.scope_owner_user_id=r.owner_user_id AND g.scope_project_id=r.project_id AND g.revoked_at IS NULL
JOIN bb_users reviewer ON reviewer.id=g.user_id AND reviewer.status='active'
WHERE p.latest_input_revision=r.input_revision AND p.draft_revision=i.draft_revision
 AND NOT EXISTS(SELECT 1 FROM bb_material_versions newer WHERE newer.owner_user_id=m.owner_user_id AND newer.id=m.id AND newer.version>m.version AND newer.deleted_at IS NULL)
 AND NOT EXISTS(SELECT 1 FROM bb_parse_snapshots newer WHERE newer.owner_user_id=s.owner_user_id AND newer.project_id=s.project_id
   AND newer.material_id=s.material_id AND newer.material_version=s.material_version AND (newer.created_at,newer.id)>(s.created_at,s.id))
 AND NOT EXISTS(SELECT 1 FROM bb_fact_evidence_review_withdrawals w WHERE w.review_id=r.id);

COMMENT ON TABLE bb_fact_evidence_reviewer_grants IS 'Management-issued exact owner/project fact-evidence review authority; independent role, no self-service grant route.';
COMMENT ON TABLE bb_fact_evidence_reviews IS 'Append-only #15 review pinned to a complete server-derived evidence context and exact candidate snapshot. Never changes candidate verification, confidence, uncertainty, or source kind.';
COMMENT ON VIEW bb_current_fact_evidence_reviews IS 'Fail-closed current review projection; excludes input/material/parse changes, grant revocation, and withdrawn decisions. Not an offerable-facts or verification view.';
