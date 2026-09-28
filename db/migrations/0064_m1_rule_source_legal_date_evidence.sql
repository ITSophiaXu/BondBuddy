-- #19: preserve source-date semantics instead of fabricating a legal effective date.
-- This migration adds storage for the source-date evidence contract; it does not
-- create reviewer attestations or authorize any existing production release.

ALTER TABLE bb_rule_pack_production_source_checks
  ALTER COLUMN effective_from DROP NOT NULL,
  ADD COLUMN document_revision_date date,
  ADD COLUMN signed_date date,
  ADD COLUMN official_publication_date date,
  ADD COLUMN acquired_date date,
  ADD COLUMN legal_effective_date_basis text
    CHECK (legal_effective_date_basis IS NULL OR legal_effective_date_basis IN ('explicit_text','publication_commencement','unknown','not_legal_effectivity')),
  ADD COLUMN effective_date_derivation_evidence jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(effective_date_derivation_evidence) = 'array'),
  ADD COLUMN transition_from_date date,
  ADD COLUMN transition_until_date date,
  ADD COLUMN transition_evidence jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(transition_evidence) = 'array'),
  ADD COLUMN applicability_basis jsonb,
  ADD COLUMN approved_method_window jsonb;

ALTER TABLE bb_rule_pack_production_source_checks
  ADD CONSTRAINT bb_rule_pack_source_legal_date_basis_guard CHECK (
    (effective_from IS NOT NULL AND (legal_effective_date_basis IS NULL OR legal_effective_date_basis IN ('explicit_text','publication_commencement')))
    OR (effective_from IS NULL AND (legal_effective_date_basis IS NULL OR legal_effective_date_basis IN ('unknown','not_legal_effectivity')))
  ),
  ADD CONSTRAINT bb_rule_pack_source_legal_date_evidence_guard CHECK (
    legal_effective_date_basis NOT IN ('explicit_text','publication_commencement')
    OR (effective_from IS NOT NULL AND jsonb_array_length(effective_date_derivation_evidence) > 0)
  ),
  ADD CONSTRAINT bb_rule_pack_source_publication_derivation_guard CHECK (
    legal_effective_date_basis <> 'publication_commencement'
    OR (official_publication_date IS NOT NULL AND effective_from=official_publication_date)
  ),
  ADD CONSTRAINT bb_rule_pack_source_transition_range_guard CHECK (
    transition_from_date IS NULL OR transition_until_date IS NULL OR transition_until_date >= transition_from_date
  ),
  ADD CONSTRAINT bb_rule_pack_source_transition_evidence_guard CHECK (
    (transition_from_date IS NULL AND transition_until_date IS NULL) OR jsonb_array_length(transition_evidence) > 0
  ),
  ADD CONSTRAINT bb_rule_pack_source_applicability_basis_guard CHECK (
    (applicability_basis IS NULL OR (
      jsonb_typeof(applicability_basis) = 'object'
      AND jsonb_typeof(applicability_basis->'basis_id') = 'string'
      AND length(btrim(applicability_basis->>'basis_id', E' \t\n\r')) > 0
      AND jsonb_typeof(applicability_basis->'basis_version') = 'number'
      AND CASE WHEN (applicability_basis->>'basis_version') ~ '^[1-9][0-9]{0,9}$'
        THEN (applicability_basis->>'basis_version')::numeric <= 2147483647 ELSE false END
      AND jsonb_typeof(applicability_basis->'basis_sha256') = 'string'
      AND (applicability_basis->>'basis_sha256') ~ '^[a-f0-9]{64}$'
      AND jsonb_typeof(applicability_basis->'source_document_sha256') = 'string'
      AND (applicability_basis->>'source_document_sha256') ~ '^[a-f0-9]{64}$'
      AND jsonb_typeof(applicability_basis->'applicability_scope') = 'object'
      AND jsonb_typeof(applicability_basis->'time_basis') = 'string'
      AND length(btrim(applicability_basis->>'time_basis', E' \t\n\r')) > 0
      AND jsonb_typeof(applicability_basis->'locator') = 'object'
    )) IS TRUE
  ),
  ADD CONSTRAINT bb_rule_pack_source_method_window_guard CHECK (
    (approved_method_window IS NULL OR (
      jsonb_typeof(approved_method_window) = 'object'
      AND jsonb_typeof(approved_method_window->'enabled_from') = 'string'
      AND CASE WHEN jsonb_typeof(approved_method_window->'enabled_from') = 'string'
        THEN (approved_method_window->>'enabled_from')::date IS NOT NULL ELSE false END
      AND approved_method_window ? 'enabled_until'
      AND CASE jsonb_typeof(approved_method_window->'enabled_until')
        WHEN 'null' THEN true
        WHEN 'string' THEN (approved_method_window->>'enabled_until')::date >= (approved_method_window->>'enabled_from')::date
        ELSE false END
      AND jsonb_typeof(approved_method_window->'approval_evidence_id') = 'string'
      AND length(btrim(approved_method_window->>'approval_evidence_id', E' \t\n\r')) > 0
      AND jsonb_typeof(approved_method_window->'approval_evidence_sha256') = 'string'
      AND (approved_method_window->>'approval_evidence_sha256') ~ '^[a-f0-9]{64}$'
    )) IS TRUE
  ),
  ADD CONSTRAINT bb_rule_pack_source_no_method_legal_date CHECK (
    legal_effective_date_basis <> 'not_legal_effectivity' OR effective_from IS NULL
  );

COMMENT ON COLUMN bb_rule_pack_production_source_checks.effective_from IS
  'Legal effective date only; nullable when the source has no explicit legal effective date. Unknown dates do not imply current or perpetual applicability.';
COMMENT ON COLUMN bb_rule_pack_production_source_checks.legal_effective_date_basis IS
  'Semantics for effective_from. Publication-based derivation requires source text and official publication evidence; dates from web metadata/acquisition are not substitutes.';
COMMENT ON COLUMN bb_rule_pack_production_source_checks.applicability_basis IS
  'Versioned source/scope/time applicability evidence in the #367 contract shape. It is a reference, not a reviewer attestation; nullable legal dates remain selector-blocked until a verifiable signed approval path exists.';
COMMENT ON COLUMN bb_rule_pack_production_source_checks.approved_method_window IS
  'Separate business-approved internal method enablement interval; never a legal effective date.';
