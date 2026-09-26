ALTER TABLE bb_issuer_identity_reviewer_grants
  ADD COLUMN authorization_basis text,
  ADD COLUMN revoked_by text REFERENCES bb_users(id),
  ADD COLUMN revocation_basis text,
  ADD COLUMN revocation_reason_code text CHECK (revocation_reason_code ~ '^[a-z][a-z0-9_]{0,63}$');
ALTER TABLE bb_issuer_identity_reviewer_grants ADD CONSTRAINT bb_issuer_grant_revocation_audit
  CHECK ((revoked_at IS NULL AND revoked_by IS NULL AND revocation_reason_code IS NULL AND revocation_basis IS NULL)
    OR (revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND revocation_reason_code IS NOT NULL AND revocation_basis IS NOT NULL)) NOT VALID;
CREATE OR REPLACE FUNCTION bb_issuer_identity_reviewer_grant_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'issuer identity reviewer grants are retained' USING ERRCODE='23514'; END IF;
  IF OLD.revoked_at IS NOT NULL OR NEW.id <> OLD.id OR NEW.user_id <> OLD.user_id OR NEW.role <> OLD.role
     OR NEW.granted_by <> OLD.granted_by OR NEW.reason_code <> OLD.reason_code OR NEW.granted_at <> OLD.granted_at
     OR NEW.authorization_basis IS DISTINCT FROM OLD.authorization_basis
     OR OLD.revoked_by IS NOT NULL OR OLD.revocation_reason_code IS NOT NULL OR OLD.revocation_basis IS NOT NULL
     OR NEW.revoked_at IS NULL OR NEW.revoked_by IS NULL OR NEW.revocation_reason_code IS NULL OR NEW.revocation_basis IS NULL
  THEN RAISE EXCEPTION 'issuer identity reviewer grant is immutable except one audited revocation' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
