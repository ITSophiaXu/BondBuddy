-- #19 aggregate applicability decisions are append-only and never edit the source draft.
CREATE TABLE bb_rule_applicability_overall_reviews (
  sequence_id bigserial UNIQUE NOT NULL,
  id text PRIMARY KEY,
  request_id text NOT NULL CHECK (request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  owner_user_id text NOT NULL,
  project_id text NOT NULL,
  context_id text NOT NULL,
  context_version integer NOT NULL CHECK (context_version > 0),
  context_content_hash char(64) NOT NULL CHECK (context_content_hash ~ '^[a-f0-9]{64}$'),
  source_input_revision integer NOT NULL CHECK (source_input_revision > 0),
  source_input_hash char(64) NOT NULL CHECK (source_input_hash ~ '^[a-f0-9]{64}$'),
  action text NOT NULL CHECK (action IN ('approve','request_more_evidence','withdraw')),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2048),
  applicability_values jsonb,
  value_evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(value_evidence)='object'),
  feature_evidence jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(feature_evidence)='array'),
  taxonomy_version text,
  reviewer_user_id text NOT NULL REFERENCES bb_users(id),
  reviewer_grant_id text NOT NULL,
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_user_id,project_id,request_id),
  FOREIGN KEY(owner_user_id,project_id,context_id,context_version)
    REFERENCES bb_rule_applicability_context_drafts(owner_user_id,project_id,id,version),
  FOREIGN KEY(reviewer_user_id,reviewer_grant_id,owner_user_id,project_id)
    REFERENCES bb_rule_applicability_reviewer_grants(user_id,id,scope_owner_user_id,scope_project_id),
  CHECK(source_input_hash=lower(btrim(source_input_hash::text))),
  CHECK(request_hash=lower(btrim(request_hash::text))),
  CHECK(action<>'approve' OR (applicability_values IS NOT NULL AND jsonb_typeof(applicability_values)='object'
    AND taxonomy_version IS NOT NULL AND length(btrim(taxonomy_version))>0
    AND jsonb_typeof(value_evidence)='object' AND jsonb_typeof(feature_evidence)='array')),
  CHECK(action='approve' OR applicability_values IS NULL)
);

CREATE INDEX bb_rule_applicability_overall_review_latest_idx
  ON bb_rule_applicability_overall_reviews(owner_user_id,project_id,context_id,context_version,sequence_id DESC);

CREATE FUNCTION bb_rule_applicability_overall_review_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE grant_revoked timestamptz;
DECLARE draft_hash char(64);
DECLARE draft_input_revision integer;
DECLARE draft_input_hash char(64);
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'rule applicability overall reviews are append-only' USING ERRCODE='23514';
  END IF;
  SELECT g.revoked_at INTO grant_revoked FROM bb_rule_applicability_reviewer_grants g
    JOIN bb_projects p ON p.owner_user_id=g.scope_owner_user_id AND p.id=g.scope_project_id AND p.deleted_at IS NULL
    JOIN bb_users u ON u.id=g.user_id AND u.status='active'
   WHERE g.id=NEW.reviewer_grant_id AND g.user_id=NEW.reviewer_user_id AND g.role='rule_applicability_reviewer'
     AND g.scope_owner_user_id=NEW.owner_user_id AND g.scope_project_id=NEW.project_id FOR SHARE OF g,p,u;
  IF NOT FOUND OR grant_revoked IS NOT NULL OR NEW.reviewer_user_id=NEW.owner_user_id THEN
    RAISE EXCEPTION 'current exact rule-applicability reviewer grant required' USING ERRCODE='42501';
  END IF;
  SELECT content_hash,source_input_revision,source_input_hash INTO draft_hash,draft_input_revision,draft_input_hash
    FROM bb_rule_applicability_context_drafts
   WHERE owner_user_id=NEW.owner_user_id AND project_id=NEW.project_id AND id=NEW.context_id AND version=NEW.context_version FOR SHARE;
  IF NOT FOUND OR draft_hash IS DISTINCT FROM NEW.context_content_hash
     OR draft_input_revision IS DISTINCT FROM NEW.source_input_revision OR draft_input_hash IS DISTINCT FROM NEW.source_input_hash THEN
    RAISE EXCEPTION 'overall review source context mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER bb_rule_applicability_overall_review_guard
  BEFORE INSERT OR UPDATE OR DELETE ON bb_rule_applicability_overall_reviews
  FOR EACH ROW EXECUTE FUNCTION bb_rule_applicability_overall_review_guard();

CREATE FUNCTION bb_rule_applicability_overall_review_no_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'rule applicability overall reviews are append-only' USING ERRCODE='23514';
END $$;
CREATE TRIGGER bb_rule_applicability_overall_review_no_truncate
  BEFORE TRUNCATE ON bb_rule_applicability_overall_reviews
  FOR EACH STATEMENT EXECUTE FUNCTION bb_rule_applicability_overall_review_no_truncate();

COMMENT ON TABLE bb_rule_applicability_overall_reviews IS
  'Append-only aggregate applicability approvals and withdrawals against exact context/input pins. Approval is not a professional attestation to laws, samples, or generated deliverables.';
