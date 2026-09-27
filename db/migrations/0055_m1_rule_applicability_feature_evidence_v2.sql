-- V2 stores the versioned per-parent/per-selector assessment envelope as a JSON object.
-- Preserve the v1 array shape and every existing ledger row/replay hash.
ALTER TABLE bb_rule_applicability_overall_reviews
  DROP CONSTRAINT bb_rule_applicability_overall_reviews_feature_evidence_check,
  DROP CONSTRAINT bb_rule_applicability_overall_reviews_check;

ALTER TABLE bb_rule_applicability_overall_reviews
  ADD CONSTRAINT bb_rule_applicability_overall_reviews_feature_evidence_v2_check
    CHECK (jsonb_typeof(feature_evidence) IN ('array', 'object')),
  ADD CONSTRAINT bb_rule_applicability_overall_reviews_approval_v2_check
    CHECK (action <> 'approve' OR (applicability_values IS NOT NULL AND jsonb_typeof(applicability_values)='object'
      AND taxonomy_version IS NOT NULL AND length(btrim(taxonomy_version))>0
      AND jsonb_typeof(value_evidence)='object' AND jsonb_typeof(feature_evidence) IN ('array', 'object')));
