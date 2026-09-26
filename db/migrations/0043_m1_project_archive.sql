-- #10; independent of the concurrent #79 migrations 0040-0042.
ALTER TABLE bb_projects ADD COLUMN archived_at timestamptz;
CREATE INDEX bb_projects_archive_activity_idx
  ON bb_projects(owner_user_id, (archived_at IS NOT NULL), updated_at DESC, id DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX bb_runs_project_activity_idx ON bb_runs(owner_user_id,project_id,created_at DESC,id DESC);
