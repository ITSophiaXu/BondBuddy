/** Submission diagnostics are distinct from the gates rechecked by the run worker. */
const testSubmissionAdvisories = new Set([
  'rule_pack:rule_applicability_reference_missing',
  'rule_pack:issuer_identity_not_bound',
  'rule_pack:rule_applicability_overall_review_required',
  'rule_pack:rule_applicability_taxonomy_not_published',
  'rule_pack:production_rule_pack_registry_empty',
  'rule_pack:rule_pack_pin_missing',
  'issuer_identity_not_bound:issuer_identity_source_missing_unreviewed_or_conflicting',
  'update_difficulty_pending:target_confirmation_required',
]);

export function classifyPreflightReadiness(missingInputs: readonly string[], uncertainty: readonly string[],
  testChannel: boolean) {
  // Preserve the original arrays in the response. Only a current, exact test grant
  // makes selected review gaps advisory for submission; runtime gates stay independent.
  const advisoryInputs = testChannel ? missingInputs.filter(reason => testSubmissionAdvisories.has(reason)) : [];
  const blockingInputs = missingInputs.filter(reason => !advisoryInputs.includes(reason));
  const status = blockingInputs.length ? 'blocked' as const : advisoryInputs.length || uncertainty.length
    ? 'needs_confirmation' as const : 'ready' as const;
  return { status, blockingInputs, advisoryInputs };
}
