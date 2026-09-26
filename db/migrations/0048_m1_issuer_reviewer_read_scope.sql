-- Project-scoped reviewer reads. Existing unscoped grants retain their review
-- history and existing write behavior, but cannot authorize cross-owner reads.
ALTER TABLE bb_issuer_identity_reviewer_grants
  ADD COLUMN scope_owner_user_id text REFERENCES bb_users(id),
  ADD COLUMN scope_project_id text;
ALTER TABLE bb_issuer_identity_reviewer_grants ADD CONSTRAINT bb_issuer_reviewer_scope_pair
  CHECK ((scope_owner_user_id IS NULL AND scope_project_id IS NULL)
    OR (scope_owner_user_id IS NOT NULL AND scope_project_id IS NOT NULL));
ALTER TABLE bb_issuer_identity_reviewer_grants ADD CONSTRAINT bb_issuer_reviewer_scope_project_fkey
  FOREIGN KEY (scope_owner_user_id, scope_project_id)
  REFERENCES bb_projects(owner_user_id, id);
CREATE OR REPLACE FUNCTION bb_issuer_identity_reviewer_grant_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'issuer identity reviewer grants are retained' USING ERRCODE='23514'; END IF;
  IF OLD.revoked_at IS NOT NULL OR NEW.id <> OLD.id OR NEW.user_id <> OLD.user_id OR NEW.role <> OLD.role
     OR NEW.granted_by <> OLD.granted_by OR NEW.reason_code <> OLD.reason_code OR NEW.granted_at <> OLD.granted_at
     OR NEW.authorization_basis IS DISTINCT FROM OLD.authorization_basis
     OR NEW.scope_owner_user_id IS DISTINCT FROM OLD.scope_owner_user_id
     OR NEW.scope_project_id IS DISTINCT FROM OLD.scope_project_id
     OR OLD.revoked_by IS NOT NULL OR OLD.revocation_reason_code IS NOT NULL OR OLD.revocation_basis IS NOT NULL
     OR NEW.revoked_at IS NULL OR NEW.revoked_by IS NULL OR NEW.revocation_reason_code IS NULL OR NEW.revocation_basis IS NULL
  THEN RAISE EXCEPTION 'issuer identity reviewer grant is immutable except one audited revocation' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE INDEX bb_issuer_reviewer_read_scope_idx ON bb_issuer_identity_reviewer_grants
  (user_id, scope_owner_user_id, scope_project_id) WHERE revoked_at IS NULL;
