-- A distinct scoped grant is required for financial-period review. Existing
-- rule-applicability and issuer-identity reviewer grants do not confer it.
CREATE TABLE bb_target_period_reviewer_grants (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  granted_by text NOT NULL,
  reason_code text NOT NULL,
  authorization_basis text NOT NULL,
  scope_owner_user_id text NOT NULL,
  scope_project_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by text,
  revocation_reason text,
  UNIQUE(id,user_id,scope_owner_user_id,scope_project_id),
  FOREIGN KEY(scope_owner_user_id,scope_project_id) REFERENCES bb_projects(owner_user_id,id),
  CHECK(user_id <> scope_owner_user_id),
  CHECK(length(btrim(reason_code)) BETWEEN 1 AND 64),
  CHECK(length(btrim(authorization_basis)) BETWEEN 1 AND 2048),
  CHECK((revoked_at IS NULL AND revoked_by IS NULL AND revocation_reason IS NULL) OR
        (revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND length(btrim(revocation_reason)) > 0))
);
CREATE UNIQUE INDEX bb_target_period_reviewer_grants_active_idx
  ON bb_target_period_reviewer_grants(user_id,scope_owner_user_id,scope_project_id) WHERE revoked_at IS NULL;
CREATE FUNCTION bb_target_period_reviewer_grant_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL OR NEW.revoked_by IS NULL OR
     NEW.revocation_reason IS NULL OR
     (to_jsonb(NEW)-'revoked_at'-'revoked_by'-'revocation_reason') IS DISTINCT FROM
     (to_jsonb(OLD)-'revoked_at'-'revoked_by'-'revocation_reason') THEN
    RAISE EXCEPTION 'target period reviewer grant allows one audited revocation' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bb_target_period_reviewer_grant_immutable
  BEFORE UPDATE OR DELETE ON bb_target_period_reviewer_grants
  FOR EACH ROW EXECUTE FUNCTION bb_target_period_reviewer_grant_guard();

CREATE TABLE bb_target_period_evidence_decisions (
  id text PRIMARY KEY,
  request_id text NOT NULL,
  request_hash char(64) NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  owner_user_id text NOT NULL,
  project_id text NOT NULL,
  input_revision integer NOT NULL,
  input_hash char(64) NOT NULL CHECK(input_hash ~ '^[a-f0-9]{64}$'),
  locked_materials jsonb NOT NULL CHECK(jsonb_typeof(locked_materials)='array'),
  source_profile_material_id text NOT NULL,
  source_profile_material_version integer NOT NULL CHECK(source_profile_material_version > 0),
  source_profile_version integer NOT NULL CHECK(source_profile_version > 0),
  source_profile_sha256 char(64) NOT NULL CHECK(source_profile_sha256 ~ '^[a-f0-9]{64}$'),
  periods jsonb NOT NULL CHECK(jsonb_typeof(periods)='array' AND jsonb_array_length(periods) BETWEEN 1 AND 30),
  reviewer_user_id text NOT NULL,
  reviewer_grant_id text NOT NULL,
  authority text NOT NULL CHECK(authority='target_financial_period_reviewer'),
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_user_id,project_id,request_id),
  UNIQUE(id,owner_user_id,project_id),
  FOREIGN KEY(owner_user_id,project_id,input_revision,input_hash)
    REFERENCES bb_input_revisions(owner_user_id,project_id,revision,input_hash),
  FOREIGN KEY(owner_user_id,project_id,source_profile_material_id,source_profile_material_version,source_profile_version)
    REFERENCES bb_historical_profiles(owner_user_id,project_id,material_id,material_version,profile_version),
  FOREIGN KEY(reviewer_grant_id,reviewer_user_id,owner_user_id,project_id)
    REFERENCES bb_target_period_reviewer_grants(id,user_id,scope_owner_user_id,scope_project_id)
);
CREATE INDEX bb_target_period_evidence_decisions_revision_idx
  ON bb_target_period_evidence_decisions(owner_user_id,project_id,input_revision,reviewed_at DESC,id DESC);
CREATE FUNCTION bb_target_period_evidence_decision_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'target period evidence decisions are append-only' USING ERRCODE='23514'; END $$;
CREATE TRIGGER bb_target_period_evidence_decision_immutable
  BEFORE UPDATE OR DELETE ON bb_target_period_evidence_decisions
  FOR EACH ROW EXECUTE FUNCTION bb_target_period_evidence_decision_immutable();

-- Withdrawal is a separate append-only event; an accepted decision is never edited.
CREATE TABLE bb_target_period_evidence_decision_withdrawals (
  id text PRIMARY KEY,
  request_id text NOT NULL,
  request_hash char(64) NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  decision_id text NOT NULL UNIQUE,
  owner_user_id text NOT NULL,
  project_id text NOT NULL,
  reviewer_user_id text NOT NULL,
  reviewer_grant_id text NOT NULL,
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2048),
  withdrawn_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_user_id,project_id,request_id),
  FOREIGN KEY(decision_id,owner_user_id,project_id)
    REFERENCES bb_target_period_evidence_decisions(id,owner_user_id,project_id),
  FOREIGN KEY(reviewer_grant_id,reviewer_user_id,owner_user_id,project_id)
    REFERENCES bb_target_period_reviewer_grants(id,user_id,scope_owner_user_id,scope_project_id)
);
CREATE FUNCTION bb_target_period_evidence_withdrawal_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'target period decision withdrawals are append-only' USING ERRCODE='23514'; END $$;
CREATE TRIGGER bb_target_period_evidence_withdrawal_immutable
  BEFORE UPDATE OR DELETE ON bb_target_period_evidence_decision_withdrawals
  FOR EACH ROW EXECUTE FUNCTION bb_target_period_evidence_withdrawal_immutable();
