-- Preparation receipts belong to the original business run. They do not adopt
-- an input, schedule work, reserve credits, or pin draft-only uploaded bytes.
CREATE TABLE bb_run_supplement_drafts (
  owner_user_id text NOT NULL,
  project_id text NOT NULL,
  run_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  base_input_revision integer NOT NULL CHECK (base_input_revision > 0),
  base_input_hash char(64) NOT NULL CHECK (base_input_hash ~ '^[a-f0-9]{64}$'),
  changes jsonb NOT NULL CHECK (jsonb_typeof(changes) = 'array' AND jsonb_array_length(changes) <= 60),
  saved_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, revision),
  UNIQUE (owner_user_id, run_id, request_id),
  FOREIGN KEY (owner_user_id, project_id, run_id) REFERENCES bb_runs(owner_user_id, project_id, id),
  FOREIGN KEY (owner_user_id, project_id, base_input_revision) REFERENCES bb_input_revisions(owner_user_id, project_id, revision)
);

CREATE FUNCTION bb_check_run_supplement_origin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM bb_runs r
    WHERE r.owner_user_id=NEW.owner_user_id AND r.project_id=NEW.project_id AND r.id=NEW.run_id
      AND r.input_revision=NEW.base_input_revision AND r.input_hash=NEW.base_input_hash
  ) THEN
    RAISE EXCEPTION 'supplement draft must retain its business run origin'
      USING ERRCODE='23514', CONSTRAINT='bb_run_supplement_origin';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER bb_run_supplement_origin BEFORE INSERT ON bb_run_supplement_drafts
  FOR EACH ROW EXECUTE FUNCTION bb_check_run_supplement_origin();
CREATE TRIGGER bb_run_supplement_receipt_immutable BEFORE UPDATE OR DELETE ON bb_run_supplement_drafts
  FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();

COMMENT ON TABLE bb_run_supplement_drafts IS
  'Unadopted preparation intent and idempotent receipts. Deliberately excluded from material retention pins.';
