-- Preserve legacy phone identities without silently assigning them passwords.
ALTER TABLE bb_users ALTER COLUMN phone_e164 DROP NOT NULL;
ALTER TABLE bb_users ADD COLUMN username text UNIQUE;
ALTER TABLE bb_users ADD CONSTRAINT bb_username_format CHECK (username IS NULL OR username ~ '^[a-z][a-z0-9_]{2,31}$');
ALTER TABLE bb_users ADD CONSTRAINT bb_user_identity CHECK (phone_e164 IS NOT NULL OR username IS NOT NULL);
CREATE TABLE bb_password_credentials (
 user_id text PRIMARY KEY REFERENCES bb_users(id),
 password_hash text NOT NULL CHECK (password_hash LIKE '$argon2id$%'),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE bb_agreement_acceptances ALTER COLUMN challenge_id DROP NOT NULL;
ALTER TABLE bb_agreement_acceptances ADD COLUMN registration_event_id text REFERENCES bb_registration_events(event_id);
ALTER TABLE bb_agreement_acceptances ADD CONSTRAINT bb_agreement_source CHECK ((challenge_id IS NOT NULL) <> (registration_event_id IS NOT NULL));
-- Only digests of normalized username and username/source combination are stored.
CREATE TABLE bb_password_login_limits (
 scope text NOT NULL CHECK (scope IN ('account','account_source')),
 key_hash char(64) NOT NULL, window_started_at timestamptz NOT NULL DEFAULT now(),
 failures integer NOT NULL DEFAULT 0 CHECK (failures >= 0),
 PRIMARY KEY(scope,key_hash)
);
