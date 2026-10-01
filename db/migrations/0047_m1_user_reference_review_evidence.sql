-- Reviewed project target and exact parser/heading attestations for structural references.
-- Existing accepted reviews/pins lack this evidence and fail closed at runtime.
CREATE TABLE bb_user_reference_target_contexts (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL,
  project_id text NOT NULL,
  target_market text NOT NULL,
  target_offering text NOT NULL,
  target_product text NOT NULL,
  target_document_stage text NOT NULL,
  content_hash char(64) NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK (status IN ('needs_review','accepted','rejected')),
  reviewer_user_id text NOT NULL,
  reviewer_grant_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_user_id,project_id,id),
  FOREIGN KEY(owner_user_id,project_id) REFERENCES bb_projects(owner_user_id,id),
  FOREIGN KEY(reviewer_grant_id,reviewer_user_id)
    REFERENCES bb_user_reference_reviewer_grants(id,reviewer_user_id)
);
CREATE INDEX bb_user_reference_target_context_latest_idx ON bb_user_reference_target_contexts
  (owner_user_id,project_id,created_at DESC,id DESC);
CREATE TRIGGER bb_user_reference_target_contexts_immutable BEFORE UPDATE OR DELETE ON bb_user_reference_target_contexts
  FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();

ALTER TABLE bb_user_reference_reviews
  ADD COLUMN confirmed_warning_codes jsonb,
  ADD COLUMN parse_response_sha256 char(64),
  ADD COLUMN signed_outline_sha256 char(64),
  ADD CONSTRAINT bb_user_reference_review_warning_codes CHECK
    (confirmed_warning_codes IS NULL OR (jsonb_typeof(confirmed_warning_codes) = 'array' AND
      octet_length(confirmed_warning_codes::text) <= 1024)),
  ADD CONSTRAINT bb_user_reference_review_outline_hash CHECK
    (signed_outline_sha256 IS NULL OR signed_outline_sha256 ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT bb_user_reference_review_parse_hash CHECK
    (parse_response_sha256 IS NULL OR parse_response_sha256 ~ '^[a-f0-9]{64}$');
ALTER TABLE bb_user_reference_reviews ADD CONSTRAINT bb_user_reference_new_acceptance_evidence
  CHECK (status <> 'accepted' OR
    (confirmed_warning_codes IS NOT NULL AND parse_response_sha256 IS NOT NULL AND signed_outline_sha256 IS NOT NULL))
  NOT VALID;

ALTER TABLE bb_user_reference_pins
  ALTER COLUMN target_product DROP NOT NULL,
  ALTER COLUMN target_document_stage DROP NOT NULL,
  ADD COLUMN target_context_id text,
  ADD COLUMN target_context_hash char(64),
  ADD COLUMN parse_response_sha256 char(64),
  ADD CONSTRAINT bb_user_reference_pin_target_context_fk FOREIGN KEY(owner_user_id,project_id,target_context_id)
    REFERENCES bb_user_reference_target_contexts(owner_user_id,project_id,id),
  ADD CONSTRAINT bb_user_reference_pin_target_hash CHECK
    (target_context_hash IS NULL OR target_context_hash ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT bb_user_reference_pin_parse_hash CHECK
    (parse_response_sha256 IS NULL OR parse_response_sha256 ~ '^[a-f0-9]{64}$');
ALTER TABLE bb_user_reference_pins ADD CONSTRAINT bb_user_reference_new_accepted_target
  CHECK (status <> 'accepted' OR
    (target_context_id IS NOT NULL AND target_context_hash IS NOT NULL AND parse_response_sha256 IS NOT NULL))
  NOT VALID;
