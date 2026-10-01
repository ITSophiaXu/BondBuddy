-- #15 user-supplied credit facility totals are immutable assertions. They are
-- project scoped, retain per-amount source/date identity, and are never verified
-- or manuscript-ready by this storage seam.
CREATE TABLE bb_credit_facility_supplements (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL,
  project_id text NOT NULL,
  request_id text NOT NULL CHECK (length(btrim(request_id)) > 0),
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK (status IN ('user_asserted','needs_confirmation','conflicted')),
  total_source_id text NOT NULL,
  total_statement_date date,
  used_source_id text NOT NULL,
  used_statement_date date,
  unused_source_id text NOT NULL,
  unused_statement_date date,
  supplement jsonb NOT NULL CHECK (jsonb_typeof(supplement) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, project_id, request_id),
  UNIQUE (owner_user_id, project_id, id),
  FOREIGN KEY (owner_user_id, project_id) REFERENCES bb_projects(owner_user_id, id),
  CHECK (supplement->>'eligibleForManuscript' IS NOT DISTINCT FROM 'false'),
  CHECK (supplement->>'status' IS NOT DISTINCT FROM status),
  CHECK (supplement->'amounts'->'total'->>'sourceId' IS NOT DISTINCT FROM total_source_id),
  CHECK (total_statement_date IS NULL OR supplement->'amounts'->'total'->>'statementDate' = total_statement_date::text),
  CHECK (supplement->'amounts'->'used'->>'sourceId' IS NOT DISTINCT FROM used_source_id),
  CHECK (used_statement_date IS NULL OR supplement->'amounts'->'used'->>'statementDate' = used_statement_date::text),
  CHECK (supplement->'amounts'->'unused'->>'sourceId' IS NOT DISTINCT FROM unused_source_id),
  CHECK (unused_statement_date IS NULL OR supplement->'amounts'->'unused'->>'statementDate' = unused_statement_date::text)
);

CREATE INDEX bb_credit_facility_supplements_owner_project_idx
  ON bb_credit_facility_supplements(owner_user_id, project_id, created_at DESC);

CREATE FUNCTION bb_reject_credit_facility_supplement_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'credit facility supplements are immutable assertions' USING ERRCODE='23514'; END $$;
CREATE TRIGGER bb_credit_facility_supplement_immutable
  BEFORE UPDATE OR DELETE ON bb_credit_facility_supplements
  FOR EACH ROW EXECUTE FUNCTION bb_reject_credit_facility_supplement_change();
