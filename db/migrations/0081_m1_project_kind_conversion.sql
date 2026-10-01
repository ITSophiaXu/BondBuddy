-- An immutable decision receipt; project and outbox changes commit with it.
CREATE TABLE bb_project_kind_conversions (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL,
  project_id text NOT NULL,
  request_id text NOT NULL,
  request_hash char(64) NOT NULL,
  from_kind text NOT NULL CHECK (from_kind = 'update'),
  to_kind text NOT NULL CHECK (to_kind = 'generation'),
  old_draft_revision integer NOT NULL,
  new_draft_revision integer NOT NULL,
  latest_input_revision integer,
  latest_input_hash char(64),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, request_id),
  UNIQUE (owner_user_id, project_id),
  FOREIGN KEY (owner_user_id, project_id) REFERENCES bb_projects(owner_user_id, id),
  CHECK (new_draft_revision = old_draft_revision + 1),
  CHECK ((latest_input_revision IS NULL) = (latest_input_hash IS NULL))
);
CREATE TRIGGER bb_project_kind_conversions_append_only
  BEFORE UPDATE OR DELETE ON bb_project_kind_conversions
  FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();
