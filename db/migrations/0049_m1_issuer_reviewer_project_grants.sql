-- #15 / #17: a reviewer may hold one active grant per exact owner/project.
-- Legacy unscoped grants remain as audit/history rows but cannot authorize new reviews.
DROP INDEX bb_issuer_identity_reviewer_grant_active_idx;

CREATE UNIQUE INDEX bb_issuer_identity_reviewer_grant_active_scope_idx
  ON bb_issuer_identity_reviewer_grants(user_id, role, scope_owner_user_id, scope_project_id)
  WHERE revoked_at IS NULL AND scope_owner_user_id IS NOT NULL AND scope_project_id IS NOT NULL;

-- Retain the pre-scope single-active-legacy invariant while allowing scoped grants alongside it.
CREATE UNIQUE INDEX bb_issuer_identity_reviewer_grant_active_legacy_idx
  ON bb_issuer_identity_reviewer_grants(user_id, role)
  WHERE revoked_at IS NULL AND scope_owner_user_id IS NULL AND scope_project_id IS NULL;

COMMENT ON INDEX bb_issuer_identity_reviewer_grant_active_scope_idx IS
  'At most one active issuer identity reviewer grant per reviewer, owner, and project.';
COMMENT ON INDEX bb_issuer_identity_reviewer_grant_active_legacy_idx IS
  'Preserves at most one active legacy unscoped grant; legacy rows are audit-only and never authorize new reviews.';
