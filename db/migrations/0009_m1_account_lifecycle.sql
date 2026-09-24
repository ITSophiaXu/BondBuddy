-- #9 account settings, session management and closure. Closed accounts keep their row so the username stays reserved.
ALTER TABLE bb_users DROP CONSTRAINT bb_users_status_check;
ALTER TABLE bb_users ADD CONSTRAINT bb_users_status_check CHECK (status IN ('active','disabled','closed'));
ALTER TABLE bb_users ADD COLUMN closed_at timestamptz;
ALTER TABLE bb_users ADD CONSTRAINT bb_user_closed_at CHECK ((status='closed') = (closed_at IS NOT NULL));

ALTER TABLE bb_auth_sessions ADD COLUMN last_refreshed_at timestamptz;
ALTER TABLE bb_auth_sessions ADD COLUMN revoked_reason text
  CHECK (revoked_reason IS NULL OR revoked_reason IN ('logout','user_revoked','password_changed','account_closed'));
ALTER TABLE bb_auth_sessions ADD CONSTRAINT bb_session_revoked_reason CHECK (revoked_reason IS NULL OR revoked_at IS NOT NULL);

-- One closure record per account. balance_status is the M2 hook: wallet/refund settlement must add its own states.
CREATE TABLE bb_account_closures (
 id text PRIMARY KEY, user_id text NOT NULL UNIQUE REFERENCES bb_users(id),
 closed_at timestamptz NOT NULL DEFAULT now(),
 projects_deleted integer NOT NULL CHECK (projects_deleted >= 0),
 material_versions_deleted integer NOT NULL CHECK (material_versions_deleted >= 0),
 artifacts_revoked integer NOT NULL CHECK (artifacts_revoked >= 0),
 sessions_revoked integer NOT NULL CHECK (sessions_revoked >= 0),
 balance_status text NOT NULL CHECK (balance_status IN ('not_applicable_m1'))
);

-- A write authorized just before closure must not create live owner data afterwards. Closure holds the user row
-- FOR UPDATE, so this KEY SHARE lock waits for it and then observes the committed status.
CREATE FUNCTION bb_reject_closed_owner_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_status text;
BEGIN
 SELECT status INTO owner_status FROM bb_users WHERE id=NEW.owner_user_id FOR KEY SHARE;
 IF owner_status='closed' THEN
   RAISE EXCEPTION 'account is closed' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bb_projects_owner_open BEFORE INSERT ON bb_projects
  FOR EACH ROW EXECUTE FUNCTION bb_reject_closed_owner_write();
CREATE TRIGGER bb_uploads_owner_open BEFORE INSERT ON bb_uploads
  FOR EACH ROW EXECUTE FUNCTION bb_reject_closed_owner_write();
CREATE TRIGGER bb_material_versions_owner_open BEFORE INSERT ON bb_material_versions
  FOR EACH ROW EXECUTE FUNCTION bb_reject_closed_owner_write();
CREATE TRIGGER bb_input_revisions_owner_open BEFORE INSERT ON bb_input_revisions
  FOR EACH ROW EXECUTE FUNCTION bb_reject_closed_owner_write();
CREATE TRIGGER bb_runs_owner_open BEFORE INSERT ON bb_runs
  FOR EACH ROW EXECUTE FUNCTION bb_reject_closed_owner_write();
