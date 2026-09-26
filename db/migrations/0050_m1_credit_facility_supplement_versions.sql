-- #15 public structured user-supplement API: preserve the internal immutable
-- rows from 0015 and add an explicit, exact predecessor relation for revisions.
ALTER TABLE bb_credit_facility_supplements
  ADD COLUMN supplement_version integer NOT NULL DEFAULT 1,
  ADD COLUMN supersedes_supplement_id text,
  ADD COLUMN supersedes_version integer;

ALTER TABLE bb_credit_facility_supplements
  ADD CONSTRAINT bb_credit_facility_supplement_version_scope_unique
    UNIQUE (owner_user_id, project_id, id, supplement_version);

ALTER TABLE bb_credit_facility_supplements
  ADD CONSTRAINT bb_credit_facility_supplement_version_positive
    CHECK (supplement_version >= 1),
  ADD CONSTRAINT bb_credit_facility_supplement_predecessor_shape
    CHECK (
      (supplement_version = 1 AND supersedes_supplement_id IS NULL AND supersedes_version IS NULL)
      OR
      (supplement_version > 1 AND supersedes_supplement_id IS NOT NULL AND supersedes_version = supplement_version - 1)
    ),
  ADD CONSTRAINT bb_credit_facility_supplement_exact_predecessor_fk
    FOREIGN KEY (owner_user_id, project_id, supersedes_supplement_id, supersedes_version)
    REFERENCES bb_credit_facility_supplements(owner_user_id, project_id, id, supplement_version);

-- A predecessor can have only one child; callers must revise the current leaf.
CREATE UNIQUE INDEX bb_credit_facility_supplement_one_successor_idx
  ON bb_credit_facility_supplements(owner_user_id, project_id, supersedes_supplement_id, supersedes_version)
  WHERE supersedes_supplement_id IS NOT NULL;

CREATE INDEX bb_credit_facility_supplement_exact_read_idx
  ON bb_credit_facility_supplements(owner_user_id, project_id, id, supplement_version);
