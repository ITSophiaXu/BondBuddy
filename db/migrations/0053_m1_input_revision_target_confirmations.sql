-- One immutable, owner-scoped declaration per input revision. The manifest carries the same
-- server-derived value in its input hash; this row provides a direct revision lookup.
CREATE TABLE bb_input_revision_target_confirmations (
  owner_user_id text NOT NULL,
  project_id text NOT NULL,
  input_revision integer NOT NULL,
  market text NOT NULL,
  offering text NOT NULL,
  document_purpose text,
  as_of date,
  target_reporting_periods jsonb NOT NULL,
  confirmed_by text NOT NULL,
  confirmed_at timestamptz NOT NULL,
  PRIMARY KEY (owner_user_id, project_id, input_revision),
  FOREIGN KEY (owner_user_id, project_id, input_revision)
    REFERENCES bb_input_revisions(owner_user_id, project_id, revision),
  CHECK (document_purpose IS NULL OR document_purpose IN ('registration', 'issuance')),
  CHECK (jsonb_typeof(target_reporting_periods) = 'array')
);
CREATE TRIGGER bb_input_revision_target_confirmation_immutable
  BEFORE UPDATE OR DELETE ON bb_input_revision_target_confirmations
  FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();
