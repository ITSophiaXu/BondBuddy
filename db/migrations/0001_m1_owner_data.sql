-- Append-only M1-04 migration. Identity is owned by #7; owner_user_id is an opaque trusted session subject.
CREATE TABLE bb_projects (
 id text PRIMARY KEY, owner_user_id text NOT NULL, name text NOT NULL CHECK (length(name)>0), kind text NOT NULL,
 issuer_name text, market text, offering text, draft_revision integer NOT NULL DEFAULT 1 CHECK (draft_revision>0),
 latest_input_revision integer, deleted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (owner_user_id,id)
);
CREATE INDEX bb_projects_owner_idx ON bb_projects(owner_user_id,updated_at DESC,id) WHERE deleted_at IS NULL;
CREATE TABLE bb_uploads (
 id text PRIMARY KEY, owner_user_id text NOT NULL, project_id text NOT NULL, filename text NOT NULL, declared_media_type text NOT NULL,
 byte_size bigint NOT NULL CHECK (byte_size>0 AND byte_size<=104857600), sha256 char(64) NOT NULL, role text NOT NULL,
 object_key text NOT NULL UNIQUE, expires_at timestamptz NOT NULL, state text NOT NULL DEFAULT 'uploading' CHECK (state IN ('uploading','received','completed')),
 received_sha256 char(64), received_bytes bigint, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_user_id,id), FOREIGN KEY(owner_user_id,project_id) REFERENCES bb_projects(owner_user_id,id)
);
CREATE TABLE bb_material_versions (
 id text NOT NULL, version integer NOT NULL CHECK (version>0), owner_user_id text NOT NULL, project_id text NOT NULL,
 upload_id text NOT NULL UNIQUE, role text NOT NULL, filename text NOT NULL, media_type text NOT NULL, byte_size bigint NOT NULL CHECK(byte_size>0),
 sha256 char(64) NOT NULL, object_key text NOT NULL UNIQUE, state text NOT NULL CHECK(state IN ('persisted','prechecking','ready','parsing','needs_confirmation','parsed','failed')),
 error text, deleted_at timestamptz, persisted_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(id,version),
 UNIQUE(owner_user_id,id,version), FOREIGN KEY(owner_user_id,project_id) REFERENCES bb_projects(owner_user_id,id),
 FOREIGN KEY(owner_user_id,upload_id) REFERENCES bb_uploads(owner_user_id,id)
);
CREATE INDEX bb_material_owner_project_idx ON bb_material_versions(owner_user_id,project_id) WHERE deleted_at IS NULL;
CREATE TABLE bb_input_revisions (
 project_id text NOT NULL, revision integer NOT NULL CHECK(revision>0), owner_user_id text NOT NULL, draft_revision integer NOT NULL,
 input_hash char(64) NOT NULL, manifest jsonb NOT NULL, material_versions jsonb NOT NULL, requirement_message_ids jsonb NOT NULL,
 rule_pack_version text, template_version text, reference_release text, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(project_id,revision), UNIQUE(owner_user_id,project_id,revision),
 FOREIGN KEY(owner_user_id,project_id) REFERENCES bb_projects(owner_user_id,id)
);
ALTER TABLE bb_projects ADD CONSTRAINT bb_project_latest_input_fk FOREIGN KEY(id,latest_input_revision) REFERENCES bb_input_revisions(project_id,revision) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE bb_runs (
 id text PRIMARY KEY, owner_user_id text NOT NULL, project_id text NOT NULL, input_revision integer NOT NULL, input_hash char(64) NOT NULL,
 execution_request_id text NOT NULL, task_kind text NOT NULL, request_hash char(64) NOT NULL,
 state text NOT NULL CHECK(state IN ('preparing','rejected','queued','running','awaiting_input','paused','validating','delivering','settlement_pending','succeeded','failed','cancelled')),
 stage text, event_cursor integer NOT NULL DEFAULT 0, artifact_id text, prompt_snapshot_ref text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_user_id,id), UNIQUE(owner_user_id,execution_request_id),
 FOREIGN KEY(owner_user_id,project_id,input_revision) REFERENCES bb_input_revisions(owner_user_id,project_id,revision),
 CHECK(state <> 'succeeded' OR artifact_id IS NOT NULL)
);
CREATE TABLE bb_run_events (
 id text PRIMARY KEY, owner_user_id text NOT NULL, run_id text NOT NULL, seq integer NOT NULL CHECK(seq>0), trace_id text NOT NULL,
 type text NOT NULL, state text NOT NULL, stage text, payload jsonb NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(run_id,seq), FOREIGN KEY(owner_user_id,run_id) REFERENCES bb_runs(owner_user_id,id)
);
CREATE TABLE bb_outbox (
 id text PRIMARY KEY, owner_user_id text NOT NULL, aggregate_type text NOT NULL, aggregate_id text NOT NULL, event_type text NOT NULL,
 payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), delivered_at timestamptz
);
CREATE INDEX bb_outbox_pending_idx ON bb_outbox(created_at,id) WHERE delivered_at IS NULL;
CREATE TABLE bb_artifact_versions (
 id text NOT NULL, version integer NOT NULL CHECK(version>0), owner_user_id text NOT NULL, run_id text NOT NULL, media_type text NOT NULL,
 sha256 char(64) NOT NULL, object_key text NOT NULL UNIQUE, quality_status text NOT NULL CHECK(quality_status IN ('pending','passed','failed')),
 delivery_status text NOT NULL CHECK(delivery_status IN ('pending','available','revoked')),
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(id,version), UNIQUE(owner_user_id,id,version),
 FOREIGN KEY(owner_user_id,run_id) REFERENCES bb_runs(owner_user_id,id),
 CHECK(delivery_status <> 'available' OR quality_status = 'passed')
);
-- Snapshot rows are append-only, including their owner and version references.
CREATE FUNCTION bb_reject_snapshot_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'immutable input revision' USING ERRCODE='23514'; END $$;
CREATE TRIGGER bb_input_revision_immutable BEFORE UPDATE OR DELETE ON bb_input_revisions FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();
ALTER TABLE bb_runs ADD COLUMN artifact_version integer;
ALTER TABLE bb_runs ADD CONSTRAINT bb_run_artifact_fk FOREIGN KEY(owner_user_id,artifact_id,artifact_version) REFERENCES bb_artifact_versions(owner_user_id,id,version) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE bb_runs ADD CONSTRAINT bb_success_artifact_version CHECK(state <> 'succeeded' OR artifact_version IS NOT NULL);
