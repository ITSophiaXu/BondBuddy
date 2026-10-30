-- Actual, attributable cost evidence. These records never price or charge a customer.
CREATE TABLE bb_commerce_expense_evidence (
 id text PRIMARY KEY,
 owner_user_id text NOT NULL,
 run_id text NOT NULL,
 event_key text NOT NULL CHECK(length(event_key) BETWEEN 1 AND 128),
 category text NOT NULL CHECK(category IN ('parsing_ocr','extra_compute_storage','payment_fee','original_scope_rework','support_extra','presale_quote')),
 amount_fen bigint NOT NULL CHECK(amount_fen BETWEEN 0 AND 1000000000),
 within_fixed_budget boolean NOT NULL,
 incurred_at timestamptz NOT NULL,
 source_ref text NOT NULL CHECK(length(source_ref) BETWEEN 1 AND 512),
 evidence_sha256 char(64) NOT NULL CHECK(evidence_sha256 ~ '^[a-f0-9]{64}$'),
 actor text NOT NULL CHECK(length(actor) BETWEEN 1 AND 200),
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),
 request_hash char(64) NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_user_id,run_id,event_key),
 FOREIGN KEY(owner_user_id,run_id) REFERENCES bb_runs(owner_user_id,id)
);
CREATE TRIGGER bb_commerce_expense_immutable BEFORE UPDATE OR DELETE ON bb_commerce_expense_evidence
 FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();

CREATE TABLE bb_commerce_cost_reviews (
 id text PRIMARY KEY,
 owner_user_id text NOT NULL,
 run_id text NOT NULL,
 snapshot_hash char(64) NOT NULL CHECK(snapshot_hash ~ '^[a-f0-9]{64}$'),
 model_required boolean NOT NULL,
 actor text NOT NULL CHECK(length(actor) BETWEEN 1 AND 200),
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),
 source_ref text NOT NULL CHECK(length(source_ref) BETWEEN 1 AND 512),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_user_id,run_id,snapshot_hash),
 FOREIGN KEY(owner_user_id,run_id) REFERENCES bb_runs(owner_user_id,id)
);
CREATE TRIGGER bb_commerce_cost_review_immutable BEFORE UPDATE OR DELETE ON bb_commerce_cost_reviews
 FOR EACH ROW EXECUTE FUNCTION bb_reject_snapshot_change();
