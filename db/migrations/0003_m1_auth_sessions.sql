-- M1-02 identity and revocable browser sessions. All token/code values are hashes.
CREATE TABLE bb_users (
 id text PRIMARY KEY, phone_e164 text NOT NULL UNIQUE CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
 status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE bb_auth_challenges (
 id text PRIMARY KEY, phone_e164 text NOT NULL, code_hash char(64) NOT NULL,
 issued_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
 consumed_at timestamptz, invalidated_at timestamptz
);
CREATE INDEX bb_auth_challenges_phone_idx ON bb_auth_challenges(phone_e164,issued_at DESC);
CREATE TABLE bb_agreement_acceptances (
 user_id text NOT NULL REFERENCES bb_users(id), terms_version text NOT NULL,
 accepted_at timestamptz NOT NULL DEFAULT now(), challenge_id text NOT NULL REFERENCES bb_auth_challenges(id),
 PRIMARY KEY(user_id,terms_version)
);
CREATE TABLE bb_auth_sessions (
 id text PRIMARY KEY, user_id text NOT NULL REFERENCES bb_users(id),
 access_hash char(64) NOT NULL UNIQUE, refresh_hash char(64) NOT NULL UNIQUE,
 csrf_hash char(64) NOT NULL, access_expires_at timestamptz NOT NULL,
 refresh_expires_at timestamptz NOT NULL, revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bb_auth_sessions_user_idx ON bb_auth_sessions(user_id) WHERE revoked_at IS NULL;
CREATE TABLE bb_registration_events (
 user_id text PRIMARY KEY REFERENCES bb_users(id), event_id text NOT NULL UNIQUE,
 created_at timestamptz NOT NULL DEFAULT now()
);
