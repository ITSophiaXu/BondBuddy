-- #19 phase 1: bounded grant scopes and an append-only manifest/reviewer ledger.
-- No grants are seeded and no production release writer is installed here.

CREATE TABLE bb_rule_pack_production_grant_scopes (
  grant_id text PRIMARY KEY REFERENCES bb_rule_pack_production_reviewer_grants(id),
  instruments text[] NOT NULL CHECK (cardinality(instruments)>0 AND array_position(instruments,'') IS NULL),
  document_stages text[] NOT NULL CHECK (cardinality(document_stages)>0 AND document_stages <@ ARRAY['registration','issuance']::text[]),
  issuer_scopes jsonb NOT NULL CHECK (jsonb_typeof(issuer_scopes)='object'),
  investor_scopes jsonb NOT NULL CHECK (jsonb_typeof(investor_scopes)='object'),
  industry_codes jsonb NOT NULL CHECK (jsonb_typeof(industry_codes)='object'),
  special_feature_scope jsonb NOT NULL CHECK (jsonb_typeof(special_feature_scope)='object'),
  scope_hash char(64) NOT NULL CHECK (scope_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION bb_rule_pack_production_grant_scope_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE grant_time timestamptz;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'production grant scopes are immutable' USING ERRCODE='23514'; END IF;
  SELECT granted_at INTO grant_time FROM bb_rule_pack_production_reviewer_grants WHERE id=NEW.grant_id;
  IF NOT FOUND OR grant_time<>NEW.created_at OR NEW.created_at<>now() THEN
    RAISE EXCEPTION 'production grant scope must be created with its grant in the same transaction' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bb_rule_pack_production_grant_scope_guard BEFORE UPDATE OR DELETE
  ON bb_rule_pack_production_grant_scopes FOR EACH ROW EXECUTE FUNCTION bb_rule_pack_production_grant_scope_guard();
CREATE FUNCTION bb_rule_pack_production_grant_requires_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM bb_rule_pack_production_grant_scopes s WHERE s.grant_id=NEW.id) THEN
    RAISE EXCEPTION 'new production reviewer grant requires an immutable applicability scope in the same transaction' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER bb_rule_pack_production_grant_requires_scope
  AFTER INSERT ON bb_rule_pack_production_reviewer_grants DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION bb_rule_pack_production_grant_requires_scope();
COMMENT ON TABLE bb_rule_pack_production_grant_scopes IS
  'One immutable reviewed applicability scope per 0036 production grant; missing rows fail closed. Scope hash uses production-review canonical JSON.';

CREATE TABLE bb_production_review_manifests (
  manifest_id text NOT NULL,
  manifest_version integer NOT NULL CHECK (manifest_version>0),
  content_sha256 char(64) NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  content jsonb NOT NULL CHECK (jsonb_typeof(content)='object'),
  request_id text NOT NULL,
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  frozen_by_user_id text NOT NULL REFERENCES bb_users(id),
  frozen_by_grant_id text NOT NULL REFERENCES bb_rule_pack_production_reviewer_grants(id),
  frozen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (manifest_id,manifest_version),
  UNIQUE (manifest_id,request_id),
  UNIQUE (manifest_id,manifest_version,content_sha256),
  FOREIGN KEY (frozen_by_grant_id,frozen_by_user_id) REFERENCES bb_rule_pack_production_reviewer_grants(id,user_id)
);
CREATE FUNCTION bb_production_review_manifest_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'production review manifests are immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bb_production_review_manifest_guard BEFORE UPDATE OR DELETE
  ON bb_production_review_manifests FOR EACH ROW EXECUTE FUNCTION bb_production_review_manifest_guard();
CREATE INDEX bb_production_review_manifest_history_idx ON bb_production_review_manifests(manifest_id,manifest_version DESC);

CREATE TABLE bb_production_review_attestation_events (
  attestation_event_id text PRIMARY KEY,
  manifest_id text NOT NULL,
  manifest_version integer NOT NULL,
  content_sha256 char(64) NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  request_id text NOT NULL,
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  reviewer_role text NOT NULL CHECK (reviewer_role IN ('industry','technical')),
  reviewer_user_id text NOT NULL REFERENCES bb_users(id),
  grant_id text NOT NULL REFERENCES bb_rule_pack_production_reviewer_grants(id),
  decision text NOT NULL CHECK (decision IN ('approve','request_more_evidence','reject')),
  reason text NOT NULL CHECK (length(btrim(reason))>0),
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence)='object'),
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (manifest_id,manifest_version,content_sha256)
    REFERENCES bb_production_review_manifests(manifest_id,manifest_version,content_sha256),
  UNIQUE (manifest_id,manifest_version,reviewer_role,reviewer_user_id,request_id)
);
CREATE INDEX bb_production_review_attestation_lookup_idx
  ON bb_production_review_attestation_events(manifest_id,manifest_version,reviewer_role,reviewed_at DESC);

CREATE TABLE bb_production_review_attestation_withdrawals (
  withdrawal_event_id text PRIMARY KEY,
  attestation_event_id text NOT NULL UNIQUE REFERENCES bb_production_review_attestation_events(attestation_event_id),
  request_id text NOT NULL,
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  withdrawn_by_user_id text NOT NULL REFERENCES bb_users(id),
  grant_id text NOT NULL REFERENCES bb_rule_pack_production_reviewer_grants(id),
  reason text NOT NULL CHECK (length(btrim(reason))>0),
  withdrawn_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE bb_production_review_audit (
  id text PRIMARY KEY,
  actor_user_id text NOT NULL REFERENCES bb_users(id),
  action text NOT NULL CHECK (action IN ('manifest.frozen','attestation.submitted','attestation.withdrawn')),
  aggregate_id text NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object'),
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION bb_production_review_append_only_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'production review ledger rows are append-only' USING ERRCODE='23514'; END $$;
CREATE TRIGGER bb_production_review_attestation_guard BEFORE UPDATE OR DELETE ON bb_production_review_attestation_events
  FOR EACH ROW EXECUTE FUNCTION bb_production_review_append_only_guard();
CREATE TRIGGER bb_production_review_withdrawal_guard BEFORE UPDATE OR DELETE ON bb_production_review_attestation_withdrawals
  FOR EACH ROW EXECUTE FUNCTION bb_production_review_append_only_guard();
CREATE TRIGGER bb_production_review_audit_guard BEFORE UPDATE OR DELETE ON bb_production_review_audit
  FOR EACH ROW EXECUTE FUNCTION bb_production_review_append_only_guard();

COMMENT ON TABLE bb_production_review_manifests IS 'Immutable content-only snapshots; versions are server assigned and content hashes use #367 canonicalization.';
COMMENT ON TABLE bb_production_review_attestation_events IS 'Append-only authenticated self-submitted decisions pinned to exact manifest content hash.';
COMMENT ON TABLE bb_production_review_attestation_withdrawals IS 'Append-only self-withdrawal events that retain the original reviewer decision.';
