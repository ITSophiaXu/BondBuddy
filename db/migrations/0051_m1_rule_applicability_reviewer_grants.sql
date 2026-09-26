-- #19: independent project-scoped authority for rule-applicability review.
-- This never reuses issuer-identity grants and is provisioned out of band.
CREATE TABLE bb_rule_applicability_reviewer_grants (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES bb_users(id),
  role text NOT NULL CHECK (role = 'rule_applicability_reviewer'),
  granted_by text NOT NULL REFERENCES bb_users(id),
  reason_code text NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  authorization_basis text NOT NULL CHECK (length(btrim(authorization_basis)) BETWEEN 1 AND 2048),
  scope_owner_user_id text NOT NULL REFERENCES bb_users(id),
  scope_project_id text NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by text REFERENCES bb_users(id),
  revocation_reason_code text CHECK (revocation_reason_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  revocation_basis text,
  CHECK (user_id <> scope_owner_user_id),
  CHECK (user_id <> granted_by),
  CHECK (revoked_at IS NULL OR revoked_at >= granted_at),
  CHECK ((revoked_at IS NULL AND revoked_by IS NULL AND revocation_reason_code IS NULL AND revocation_basis IS NULL)
    OR (revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND revocation_reason_code IS NOT NULL
      AND revocation_basis IS NOT NULL AND length(btrim(revocation_basis)) BETWEEN 1 AND 2048)),
  FOREIGN KEY (scope_owner_user_id, scope_project_id) REFERENCES bb_projects(owner_user_id, id),
  UNIQUE (user_id, id, scope_owner_user_id, scope_project_id)
);

CREATE UNIQUE INDEX bb_rule_applicability_reviewer_grant_active_scope_idx
  ON bb_rule_applicability_reviewer_grants(user_id, role, scope_owner_user_id, scope_project_id)
  WHERE revoked_at IS NULL;

CREATE INDEX bb_rule_applicability_reviewer_grant_scope_read_idx
  ON bb_rule_applicability_reviewer_grants(user_id, scope_owner_user_id, scope_project_id)
  WHERE revoked_at IS NULL;

CREATE FUNCTION bb_rule_applicability_reviewer_grant_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE table_owner text;
DECLARE actor_is_superuser boolean;
BEGIN
  SELECT owner.rolname, actor.rolsuper INTO table_owner, actor_is_superuser
    FROM pg_class c
    JOIN pg_roles owner ON owner.oid=c.relowner
    JOIN pg_roles actor ON actor.rolname=current_user
   WHERE c.oid=TG_RELID;
  IF table_owner IS NULL OR (NOT actor_is_superuser AND table_owner <> current_user) THEN
    RAISE EXCEPTION 'rule applicability grants require table owner or superuser' USING ERRCODE='42501';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'rule applicability grants are retained' USING ERRCODE='23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.revoked_at IS NOT NULL OR NEW.revoked_by IS NOT NULL OR NEW.revocation_reason_code IS NOT NULL
       OR NEW.revocation_basis IS NOT NULL
       OR NOT EXISTS (SELECT 1 FROM bb_projects p WHERE p.owner_user_id=NEW.scope_owner_user_id
         AND p.id=NEW.scope_project_id AND p.deleted_at IS NULL)
       OR NOT EXISTS (SELECT 1 FROM bb_users u WHERE u.id=NEW.user_id AND u.status='active')
       OR NOT EXISTS (SELECT 1 FROM bb_users u WHERE u.id=NEW.granted_by AND u.status='active')
    THEN RAISE EXCEPTION 'invalid or inactive rule applicability grant scope' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.revoked_at IS NOT NULL OR NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.role IS DISTINCT FROM OLD.role OR NEW.granted_by IS DISTINCT FROM OLD.granted_by
     OR NEW.reason_code IS DISTINCT FROM OLD.reason_code
     OR NEW.authorization_basis IS DISTINCT FROM OLD.authorization_basis
     OR NEW.scope_owner_user_id IS DISTINCT FROM OLD.scope_owner_user_id
     OR NEW.scope_project_id IS DISTINCT FROM OLD.scope_project_id
     OR NEW.granted_at IS DISTINCT FROM OLD.granted_at
     OR NEW.revoked_at IS NULL OR NEW.revoked_by IS NULL OR NEW.revocation_reason_code IS NULL
     OR NEW.revocation_basis IS NULL OR length(btrim(NEW.revocation_basis)) NOT BETWEEN 1 AND 2048
     OR NOT EXISTS (SELECT 1 FROM bb_users u WHERE u.id=NEW.revoked_by AND u.status='active')
  THEN RAISE EXCEPTION 'rule applicability grant is immutable except one audited revocation' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER bb_rule_applicability_reviewer_grant_guard
  BEFORE INSERT OR UPDATE OR DELETE ON bb_rule_applicability_reviewer_grants
  FOR EACH ROW EXECUTE FUNCTION bb_rule_applicability_reviewer_grant_guard();

COMMENT ON TABLE bb_rule_applicability_reviewer_grants IS
  'Privileged out-of-band rule-applicability review authorization. Exact owner/project only; independent from issuer identity grants; no self-service API.';
