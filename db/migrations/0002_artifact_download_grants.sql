CREATE TABLE bb_artifact_download_grants (
 token_hash char(64) PRIMARY KEY, owner_user_id text NOT NULL, artifact_id text NOT NULL, artifact_version integer NOT NULL,
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(owner_user_id,artifact_id,artifact_version) REFERENCES bb_artifact_versions(owner_user_id,id,version)
);
CREATE INDEX bb_artifact_download_grants_expiry_idx ON bb_artifact_download_grants(expires_at);
