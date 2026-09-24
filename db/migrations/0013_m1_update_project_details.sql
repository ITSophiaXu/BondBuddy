-- Additive draft storage. Existing drafts have no asserted optional information.
ALTER TABLE bb_projects ADD COLUMN update_details jsonb NOT NULL DEFAULT '{}'::jsonb
  CHECK (jsonb_typeof(update_details) = 'object');
-- Historical input manifests remain immutable. New snapshots include update_details.
