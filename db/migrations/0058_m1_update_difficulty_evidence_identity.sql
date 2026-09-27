-- A difficulty snapshot is a derivation of the locked target-period evidence
-- state, not just of the target/input tuple. Keep old rows as legacy identities.
ALTER TABLE bb_update_difficulty_snapshots
  ADD COLUMN evidence_identity char(64),
  ADD CONSTRAINT bb_update_difficulty_snapshot_evidence_identity_check
    CHECK (evidence_identity IS NULL OR evidence_identity ~ '^[a-f0-9]{64}$');

-- 0016's generated unique key was scoped only to source/profile/target/input,
-- which prevents a preflight estimate from being superseded by a reviewed one.
ALTER TABLE bb_update_difficulty_snapshots
  DROP CONSTRAINT bb_update_difficulty_snapshot_owner_user_id_project_id_sour_key;

-- NULL is retained for pre-0058 snapshots; NULLS NOT DISTINCT preserves their
-- prior one-snapshot guard while allowing one immutable row per evidence state.
ALTER TABLE bb_update_difficulty_snapshots
  ADD CONSTRAINT bb_update_difficulty_snapshot_evidence_identity_key
  UNIQUE NULLS NOT DISTINCT (owner_user_id, project_id, source_material_id, source_material_version,
    source_profile_version, target_revision, input_revision, evidence_identity);
