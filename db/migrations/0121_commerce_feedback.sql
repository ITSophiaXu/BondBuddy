-- Adoption is separate from task delivery and cash top-ups. No synthetic grants count as paid adoption.
CREATE TABLE bb_commerce_feedback (
  id text PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES bb_users(id),
  request_id text NOT NULL,
  request_hash char(64) NOT NULL,
  run_id text NOT NULL REFERENCES bb_runs(id),
  outcome text NOT NULL CHECK(outcome IN ('adopted','needs_changes','not_used')),
  reason text NOT NULL DEFAULT '' CHECK(length(reason)<=1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_user_id,request_id)
);
CREATE INDEX bb_commerce_feedback_run ON bb_commerce_feedback(owner_user_id,run_id,created_at);
