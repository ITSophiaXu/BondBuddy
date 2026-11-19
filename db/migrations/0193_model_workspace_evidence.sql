-- Private evidence survives cancellation/lease loss; it cannot change task state,
-- supplier usage, credits, or authorize a new call. Published only after readback.
CREATE TABLE bb_model_workspace_evidence (
 attempt_id text NOT NULL REFERENCES bb_model_call_attempts(id),
 event text NOT NULL CHECK(event IN ('exit','collection_failure','capture_failure')),
 owner_user_id text NOT NULL REFERENCES bb_users(id),
 run_id text NOT NULL REFERENCES bb_runs(id),
 input_hash char(64) NOT NULL,
 payload jsonb NOT NULL,
 payload_sha256 char(64) NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(attempt_id,event)
);
CREATE FUNCTION bb_workspace_evidence_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Workspace evidence is immutable'; END $$;
CREATE TRIGGER bb_workspace_evidence_immutable BEFORE UPDATE OR DELETE ON bb_model_workspace_evidence
 FOR EACH ROW EXECUTE FUNCTION bb_workspace_evidence_immutable();
CREATE INDEX bb_workspace_evidence_run ON bb_model_workspace_evidence(owner_user_id,run_id);
