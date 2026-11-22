import type { TestCoverageGap } from '@bondbuddy/contracts';
import type { CandidateCoverageItem } from './sse-private-candidate-assets.js';

/** Pure projection of an already selected candidate. It grants no scope or execution authority. */
export function toTestCoverageGap(item: CandidateCoverageItem): TestCoverageGap {
  if (item.disposition !== 'uncovered') throw new Error('TEST_COVERAGE_ITEM_NOT_UNCOVERED');
  return {
    kind: 'coverage_gap',
    manifest_id: item.manifestId,
    manifest_version: item.manifestVersion,
    item_id: item.itemId,
    candidate_asset_sha256: item.candidateAssetSha256,
    disposition: 'uncovered',
    area: item.area,
    rationale: item.rationale,
    source_ref_ids: [...item.sourceRefIds],
    rule_ids: [...item.ruleIds],
    reason_code: 'coverage_uncovered',
    evidence_ref: null,
  };
}
