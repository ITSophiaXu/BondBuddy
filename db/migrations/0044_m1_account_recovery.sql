-- #9 manual recovery. No operator is granted permission by this migration.
ALTER TABLE bb_operator_grants DROP CONSTRAINT bb_operator_grants_role_check;
ALTER TABLE bb_operator_grants ADD CONSTRAINT bb_operator_grants_role_check CHECK(role IN ('log_reader','log_operator','prompt_viewer','account_recovery'));
CREATE TABLE bb_recovery_channels (
 id text PRIMARY KEY, user_id text NOT NULL REFERENCES bb_users(id),
 kind text NOT NULL CHECK(kind IN ('email','support_chat')), contact text,
 state text NOT NULL CHECK(state IN ('pending','verified','revoked')),
 credential_digest char(64) NOT NULL,
 requested_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 verified_at timestamptz, code_hash char(64), code_expires_at timestamptz,
 CHECK(state='revoked' OR contact IS NOT NULL), CHECK(state<>'verified' OR verified_at IS NOT NULL)
);
CREATE UNIQUE INDEX bb_recovery_channel_pending ON bb_recovery_channels(user_id) WHERE state='pending';
CREATE UNIQUE INDEX bb_recovery_channel_verified ON bb_recovery_channels(user_id) WHERE state='verified';
CREATE TABLE bb_recovery_tickets (
 id text PRIMARY KEY, subject_hash char(64) NOT NULL, user_id text REFERENCES bb_users(id),
 binding_id text REFERENCES bb_recovery_channels(id), credential_digest char(64),
 state text NOT NULL CHECK(state IN ('open','issued','closed','completed')),
 requested_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 token_hash char(64), token_expires_at timestamptz, issued_by text REFERENCES bb_users(id),
 confirmed_at timestamptz, completed_at timestamptz
);
CREATE UNIQUE INDEX bb_recovery_ticket_open ON bb_recovery_tickets(subject_hash) WHERE state IN ('open','issued');
CREATE UNIQUE INDEX bb_recovery_token ON bb_recovery_tickets(token_hash) WHERE token_hash IS NOT NULL;
CREATE INDEX bb_recovery_ticket_user ON bb_recovery_tickets(user_id);
CREATE TABLE bb_recovery_limits (key_hash char(64) PRIMARY KEY, started_at timestamptz NOT NULL, attempts integer NOT NULL);
-- Password changes/closure invalidate unfinished recovery authorizations atomically, including
-- changes made by existing auth routes. Closed accounts also erase contact details.
CREATE FUNCTION bb_invalidate_account_recovery() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE bb_recovery_channels SET state='revoked',contact=NULL,code_hash=NULL,code_expires_at=NULL
   WHERE user_id=OLD.user_id AND (state='pending' OR TG_OP='DELETE');
 UPDATE bb_recovery_tickets SET state='closed',token_hash=NULL,token_expires_at=NULL
   WHERE user_id=OLD.user_id AND state IN ('open','issued');
 RETURN NULL;
END $$;
CREATE TRIGGER bb_password_recovery_invalidate AFTER UPDATE OR DELETE ON bb_password_credentials
 FOR EACH ROW EXECUTE FUNCTION bb_invalidate_account_recovery();
