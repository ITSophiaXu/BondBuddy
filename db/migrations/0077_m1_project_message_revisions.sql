-- Preserve exact edit ancestry separately from the project-wide preceding submission.
-- Historical rows remain immutable; readers resolve legacy ancestry by message/version.
ALTER TABLE bb_user_submission_versions
  ADD COLUMN revises_submission_id text REFERENCES bb_user_submission_versions(id);

CREATE INDEX bb_project_message_history_idx
  ON bb_user_submission_versions(owner_user_id,project_id,version)
  WHERE submission_kind='project_message';

CREATE INDEX bb_project_message_edit_idx
  ON bb_user_submission_versions(owner_user_id,project_id,message_id,message_version)
  WHERE submission_kind='project_message';
