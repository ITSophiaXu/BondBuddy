import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  buildSsePrivateApplicabilityCandidate,
  resolveSsePrivateFeatureEvidenceV2,
  SSE_PRIVATE_APPLICABILITY_DICTIONARY,
  SSE_PRIVATE_APPLICABILITY_DICTIONARY_V1,
  SSE_PRIVATE_APPLICABILITY_DICTIONARY_V2,
  SSE_PRIVATE_APPLICABILITY_FEATURE_MAPPING,
  SSE_PRIVATE_APPLICABILITY_FEATURE_EVIDENCE_VERSION,
  SSE_PRIVATE_FEATURE_DIMENSIONS,
  type ApplicabilityDimensionAssessment,
} from './sse-private-applicability-taxonomy.js';

const validEvidence = {
  materialId: 'material-1',
  materialVersion: 1,
  materialSha256: 'a'.repeat(64),
  parseSnapshotId: 'snapshot-1',
  sourceRecordId: 'record-1',
  recordSha256: 'b'.repeat(64),
  locator: 'document.xml//paragraph[1]',
};

function dimensions(overrides: Partial<Record<string, Partial<ApplicabilityDimensionAssessment>>> = {}) {
  return SSE_PRIVATE_FEATURE_DIMENSIONS.map((feature): ApplicabilityDimensionAssessment => ({
    code: feature.code,
    status: 'absent',
    evidence: [validEvidence],
    reason: '已按当前材料和定位核对该维度。',
    ...overrides[feature.code],
  }));
}

function build(input: {
  industry?: unknown;
  dimensions?: readonly ApplicabilityDimensionAssessment[] | null;
  dictionaryVersion?: string;
  dictionarySha256?: string;
} = {}) {
  return buildSsePrivateApplicabilityCandidate({
    dictionaryVersion: input.dictionaryVersion ?? SSE_PRIVATE_APPLICABILITY_DICTIONARY.version,
    dictionarySha256: input.dictionarySha256 ?? SSE_PRIVATE_APPLICABILITY_DICTIONARY.contentSha256,
    industry: Object.hasOwn(input, 'industry') ? input.industry as never : { status: 'unknown' },
    dimensions: input.dimensions === undefined ? dimensions() : input.dimensions,
  });
}

test('dictionary is immutable, versioned, and fingerprinted independently from #77 matching vocabulary', () => {
  assert.equal(SSE_PRIVATE_APPLICABILITY_DICTIONARY_V2.version, 'sse-private-applicability-v2');
  assert.equal(SSE_PRIVATE_APPLICABILITY_DICTIONARY_V2.contentSha256, '0d30e4c4d761b5bc4112c8428a1e4be83b158ff0aeeec53715dd3529a749cc24');
  assert.equal(Object.isFrozen(SSE_PRIVATE_APPLICABILITY_DICTIONARY), true);
  assert.equal(Object.isFrozen(SSE_PRIVATE_APPLICABILITY_DICTIONARY.featureDimensions), true);
  assert.equal(SSE_PRIVATE_APPLICABILITY_DICTIONARY.isolation.referenceMatchingDictionary, 'not-a-#77-business-matching-dictionary');
  assert.equal('mainBusinessRevenue' in SSE_PRIVATE_APPLICABILITY_DICTIONARY, false);
  const binding = SSE_PRIVATE_APPLICABILITY_DICTIONARY_V2.industry.standardBinding;
  assert.ok(binding);
  assert.equal(binding.standardId, 'capco-listed-company-industry');
  assert.equal(binding.standardVersion, '2023-05-01');
  assert.equal(binding.definitionSha256, 'c8c16f572f40a5028331d6914b6d32d45581d701d4fbab3f9b903fe68ba7fff7');
  assert.equal(binding.mappingVersion, 'sse-private-capco-division-candidate-v1');
  assert.equal(binding.selectorLevel, 'division');
  assert.equal(binding.codes.length, 91);
  assert.equal(Object.keys(binding.sourceCodeToSelectorCode).length, 547);
  assert.equal(Object.isFrozen(binding.sourceCodeToSelectorCode), true);
  assert.equal(Object.isFrozen(binding.unboundSourceCodes), true);
  assert.equal(binding.sourceCodeToSelectorCode['01'], '01');
  assert.equal(binding.sourceCodeToSelectorCode['91'], '91');
  assert.equal(binding.sourceCodeToSelectorCode['011'], '01');
  assert.equal(binding.sourceCodeToSelectorCode['278'], '27');
  assert.equal('999' in binding.sourceCodeToSelectorCode, false);
  assert.equal(SSE_PRIVATE_APPLICABILITY_DICTIONARY_V1.version, 'sse-private-applicability-v1');
  assert.equal(SSE_PRIVATE_APPLICABILITY_DICTIONARY_V1.industry.standardBinding, null);
  assert.equal(SSE_PRIVATE_APPLICABILITY_DICTIONARY_V1.contentSha256, '47c833b3311e918c8024844c4c4ca20694416431b12cd95f076c151bcf860f0e');
});

function featureEvidenceV2(overrides: Record<string, {
  outcome?: 'present' | 'absent' | 'not_applicable';
  children?: Array<{ featureCode: string; outcome: 'present' | 'absent' | 'not_applicable' | 'unknown'; reason?: string; evidenceRefs?: unknown[] }>;
}> = {}) {
  return {
    contractVersion: SSE_PRIVATE_APPLICABILITY_FEATURE_EVIDENCE_VERSION,
    dictionaryVersion: SSE_PRIVATE_APPLICABILITY_DICTIONARY.version,
    dictionarySha256: SSE_PRIVATE_APPLICABILITY_DICTIONARY.contentSha256,
    dimensions: SSE_PRIVATE_APPLICABILITY_FEATURE_MAPPING.map(({ dimension, selectorCodes }) => {
      const change = overrides[dimension];
      return {
        dimension, outcome: change?.outcome ?? 'absent', reason: `父维度 ${dimension} 已检查。`,
        evidenceRefs: [validReviewEvidence, validReviewEvidence2],
        childAssessments: change?.children?.map((child) => ({ reason: `子码 ${child.featureCode} 已独立检查。`, ...child })) ?? selectorCodes.map((featureCode) => ({ featureCode, outcome: 'absent' as const,
          reason: `子码 ${featureCode} 已独立检查。`, evidenceRefs: [validReviewEvidence] })),
      };
    }),
  };
}

const validReviewEvidence = {
  materialId: 'material-1', materialVersion: 1, materialSha256: 'a'.repeat(64),
  parseSnapshotId: 'snapshot-1', recordId: 'record-1', recordSha256: 'b'.repeat(64),
};
const validReviewEvidence2 = {
  materialId: 'material-2', materialVersion: 1, materialSha256: 'c'.repeat(64),
  parseSnapshotId: 'snapshot-2', recordId: 'record-2', recordSha256: 'd'.repeat(64),
};

test('feature evidence v2 binds all nine parent dimensions to the exact twelve dictionary selector codes', () => {
  assert.equal(SSE_PRIVATE_APPLICABILITY_DICTIONARY.version, 'sse-private-applicability-v3');
  assert.equal(SSE_PRIVATE_APPLICABILITY_DICTIONARY_V2.version, 'sse-private-applicability-v2');
  assert.equal(SSE_PRIVATE_APPLICABILITY_DICTIONARY_V2.contentSha256, '0d30e4c4d761b5bc4112c8428a1e4be83b158ff0aeeec53715dd3529a749cc24');
  assert.equal(SSE_PRIVATE_APPLICABILITY_DICTIONARY.featureEvidenceMapping?.parentDimensions.length, 9);
  assert.equal(SSE_PRIVATE_APPLICABILITY_DICTIONARY.featureEvidenceMapping?.selectorCodesByDimension.flatMap((item) => item.selectorCodes).length, 12);
  const mapped = resolveSsePrivateFeatureEvidenceV2(featureEvidenceV2({
    embedded_or_perpetual: { outcome: 'present', children: [
      { featureCode: 'convertible-structure', outcome: 'present', evidenceRefs: [validReviewEvidence] },
      { featureCode: 'exchangeable-structure', outcome: 'present', evidenceRefs: [validReviewEvidence2] },
      { featureCode: 'perpetual-structure', outcome: 'absent', evidenceRefs: [validReviewEvidence] },
    ] },
    optimized_review: { outcome: 'present', children: [
      { featureCode: 'optimized-review', outcome: 'present', evidenceRefs: [validReviewEvidence] },
      { featureCode: 'simplified-disclosure', outcome: 'absent', evidenceRefs: [validReviewEvidence2] },
    ] },
  }));
  assert.deepEqual(mapped, { accepted: true, specialFeatures: [
    'convertible-structure', 'exchangeable-structure', 'optimized-review',
  ] });
});

test('feature evidence v2 leaves unrefined, incomplete, contradictory and unknown child states in needs_review', () => {
  const base = featureEvidenceV2();
  const withDimension = (dimension: string, patch: Record<string, unknown>) => ({
    ...base, dimensions: base.dimensions.map((item) => item.dimension === dimension ? { ...item, ...patch } : item),
  });
  assert.deepEqual(resolveSsePrivateFeatureEvidenceV2(withDimension('embedded_or_perpetual', {
    outcome: 'present', childAssessments: [],
  })), { accepted: false, reason: 'feature_evidence_needs_review' });
  assert.deepEqual(resolveSsePrivateFeatureEvidenceV2(withDimension('embedded_or_perpetual', {
    outcome: 'present', childAssessments: [{ featureCode: 'perpetual-structure', outcome: 'present', reason: 'only one was checked', evidenceRefs: [validReviewEvidence] }],
  })), { accepted: false, reason: 'feature_evidence_needs_review' });
  assert.deepEqual(resolveSsePrivateFeatureEvidenceV2(withDimension('embedded_or_perpetual', {
    outcome: 'absent', childAssessments: [
      { featureCode: 'convertible-structure', outcome: 'present', reason: 'conflict', evidenceRefs: [validReviewEvidence] },
      { featureCode: 'exchangeable-structure', outcome: 'absent', reason: 'checked', evidenceRefs: [validReviewEvidence] },
      { featureCode: 'perpetual-structure', outcome: 'absent', reason: 'checked', evidenceRefs: [validReviewEvidence] },
    ],
  })), { accepted: false, reason: 'feature_evidence_mapping_mismatch' });
  assert.deepEqual(resolveSsePrivateFeatureEvidenceV2(withDimension('embedded_or_perpetual', {
    outcome: 'absent', childAssessments: [
      { featureCode: 'convertible-structure', outcome: 'not_applicable', reason: 'range not established', evidenceRefs: [validReviewEvidence] },
      { featureCode: 'exchangeable-structure', outcome: 'absent', reason: 'checked', evidenceRefs: [validReviewEvidence] },
      { featureCode: 'perpetual-structure', outcome: 'absent', reason: 'checked', evidenceRefs: [validReviewEvidence] },
    ],
  })), { accepted: false, reason: 'feature_evidence_needs_review' });
  assert.deepEqual(resolveSsePrivateFeatureEvidenceV2(withDimension('embedded_or_perpetual', {
    outcome: 'present', childAssessments: [
      { featureCode: 'convertible-structure', outcome: 'absent', reason: 'checked', evidenceRefs: [validReviewEvidence] },
      { featureCode: 'exchangeable-structure', outcome: 'absent', reason: 'checked', evidenceRefs: [validReviewEvidence] },
      { featureCode: 'perpetual-structure', outcome: 'absent', reason: 'checked', evidenceRefs: [validReviewEvidence] },
    ],
  })), { accepted: false, reason: 'feature_evidence_needs_review' });
  for (const outcome of ['present', 'absent'] as const) {
    assert.deepEqual(resolveSsePrivateFeatureEvidenceV2(withDimension('embedded_or_perpetual', {
      outcome: 'not_applicable', childAssessments: [
        { featureCode: 'convertible-structure', outcome, reason: 'range check', evidenceRefs: [validReviewEvidence] },
        { featureCode: 'exchangeable-structure', outcome: 'not_applicable', reason: 'range check', evidenceRefs: [validReviewEvidence] },
        { featureCode: 'perpetual-structure', outcome: 'not_applicable', reason: 'range check', evidenceRefs: [validReviewEvidence] },
      ],
    })), { accepted: false, reason: 'feature_evidence_needs_review' });
  }
  assert.deepEqual(resolveSsePrivateFeatureEvidenceV2(withDimension('optimized_review', {
    outcome: 'present', childAssessments: [
      { featureCode: 'optimized-review', outcome: 'present', reason: 'scheme evidence', evidenceRefs: [validReviewEvidence] },
      { featureCode: 'simplified-disclosure', outcome: 'unknown', reason: 'not checked', evidenceRefs: [] },
    ],
  })), { accepted: false, reason: 'feature_evidence_needs_review' });
  assert.deepEqual(resolveSsePrivateFeatureEvidenceV2(withDimension('optimized_review', {
    outcome: 'absent', childAssessments: [
      { featureCode: 'optimized-review', outcome: 'absent', reason: 'x'.repeat(1025), evidenceRefs: [validReviewEvidence] },
      { featureCode: 'simplified-disclosure', outcome: 'absent', reason: 'checked', evidenceRefs: [validReviewEvidence] },
    ],
  })), { accepted: false, reason: 'feature_evidence_invalid' });
  assert.deepEqual(resolveSsePrivateFeatureEvidenceV2(withDimension('optimized_review', {
    outcome: 'absent', childAssessments: [
      { featureCode: 'optimized-review', outcome: 'absent', reason: 'checked', evidenceRefs: [] },
      { featureCode: 'simplified-disclosure', outcome: 'absent', reason: 'checked', evidenceRefs: [validReviewEvidence] },
    ],
  })), { accepted: false, reason: 'feature_evidence_invalid' });
  assert.deepEqual(resolveSsePrivateFeatureEvidenceV2(withDimension('optimized_review', {
    outcome: 'absent', childAssessments: [
      { featureCode: 'optimized-review', outcome: 'absent', reason: 'checked', evidenceRefs: [validReviewEvidence] },
      { featureCode: 'simplified-disclosure', outcome: 'absent', reason: 'checked', evidenceRefs: [validReviewEvidence] },
    ],
  })), { accepted: true, specialFeatures: [] });
});

test('feature evidence v2 rejects syntactically valid but non-dictionary selector codes and mismatched pins', () => {
  const wrongCode = featureEvidenceV2({ urban_construction: { outcome: 'present', children: [
    { featureCode: 'valid-looking-code', outcome: 'present', evidenceRefs: [validReviewEvidence] },
  ] } });
  assert.deepEqual(resolveSsePrivateFeatureEvidenceV2(wrongCode), { accepted: false, reason: 'feature_evidence_mapping_mismatch' });
  const wrongDictionary = { ...featureEvidenceV2(), dictionarySha256: '0'.repeat(64) };
  assert.deepEqual(resolveSsePrivateFeatureEvidenceV2(wrongDictionary), { accepted: false, reason: 'feature_evidence_mapping_mismatch' });
});

test('CAPCO division codes remain exact and verified groups map only to their listed parent division', () => {
  const buildIndustry = (code: string, standardId = 'capco-listed-company-industry') => build({ industry: {
    status: 'classified', standardId, standardVersion: '2023-05-01',
    definitionSha256: 'c8c16f572f40a5028331d6914b6d32d45581d701d4fbab3f9b903fe68ba7fff7', code,
  } });
  const exact = buildIndustry('01');
  assert.equal(exact.accepted, true);
  if (exact.accepted) assert.equal(exact.candidate.industry, '01');
  const group = buildIndustry('278');
  assert.equal(group.accepted, true);
  if (group.accepted) assert.equal(group.candidate.industry, '27');
  for (const code of ['C', 'CA']) assert.deepEqual(buildIndustry(code), { accepted: false, reason: 'industry_code_needs_review' });
  for (const code of ['999', '01x']) assert.deepEqual(buildIndustry(code), { accepted: false, reason: 'invalid_industry_binding' });
  assert.deepEqual(buildIndustry('01', 'csrc-listed-company-industry'), { accepted: false, reason: 'invalid_industry_binding' });
});

test('runtime binding is an exact projection of all 576 #310 source mapping entries', () => {
  const source = JSON.parse(readFileSync(new URL('../../../knowledge/exchange-bonds/verification/2026-09-27-industry/selector-mapping.json', import.meta.url), 'utf8')) as {
    standard_id: string;
    standard_version: string;
    definition_sha256: string;
    mapping_version: string;
    entries: Array<{ source_code: string; source_level: string; selector_code: string | null; reason: string }>;
  };
  const binding = SSE_PRIVATE_APPLICABILITY_DICTIONARY.industry.standardBinding;
  assert.ok(binding);
  assert.equal(source.entries.length, 576);
  assert.equal(source.entries.filter((entry) => entry.source_level === 'division').length, 91);
  assert.equal(source.entries.filter((entry) => entry.source_level === 'group').length, 456);
  assert.equal(source.entries.filter((entry) => entry.selector_code === null).length, 29);
  assert.equal(source.standard_id, binding.standardId);
  assert.equal(source.standard_version, binding.standardVersion);
  assert.equal(source.definition_sha256, binding.definitionSha256);
  assert.equal(source.mapping_version, binding.mappingVersion);
  const expectedBoundEntries = Object.fromEntries(source.entries
    .filter((entry) => entry.selector_code !== null)
    .map((entry) => [entry.source_code, entry.selector_code]));
  assert.deepEqual(binding.sourceCodeToSelectorCode, expectedBoundEntries);
  const expectedUnboundCodes = source.entries.filter((entry) => entry.selector_code === null).map(({ source_code: code }) => code).sort();
  assert.deepEqual(binding.unboundSourceCodes, expectedUnboundCodes);
  assert.deepEqual(expectedUnboundCodes,
    ['A', 'B', 'C', 'CA', 'CB', 'CC', 'CD', 'CE', 'CF', 'CG', 'CH', 'CI', 'CJ', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S']);
});

test('historical v1 hash stays addressable and preserves its unbound industry meaning', () => {
  const historical = build({
    dictionaryVersion: SSE_PRIVATE_APPLICABILITY_DICTIONARY_V1.version,
    dictionarySha256: SSE_PRIVATE_APPLICABILITY_DICTIONARY_V1.contentSha256,
    industry: { status: 'unknown' },
  });
  assert.equal(historical.accepted, true);
  if (historical.accepted) {
    assert.equal(historical.candidate.dictionaryVersion, 'sse-private-applicability-v1');
    assert.equal(historical.candidate.dictionarySha256, SSE_PRIVATE_APPLICABILITY_DICTIONARY_V1.contentSha256);
    assert.equal(historical.candidate.industry, null);
  }
  assert.deepEqual(build({
    dictionaryVersion: SSE_PRIVATE_APPLICABILITY_DICTIONARY_V1.version,
    dictionarySha256: SSE_PRIVATE_APPLICABILITY_DICTIONARY_V1.contentSha256,
    industry: { status: 'classified', standardId: 'capco-listed-company-industry', standardVersion: '2023-05-01',
      definitionSha256: 'c8c16f572f40a5028331d6914b6d32d45581d701d4fbab3f9b903fe68ba7fff7', code: '01' },
  }), { accepted: false, reason: 'industry_standard_unbound' });
});

test('city-construction and group-operated overlays coexist as distinct selector features', () => {
  const result = build({ dimensions: dimensions({
    'city-infrastructure': { status: 'present', reason: '证据支持城市建设审核重点。' },
    'group-operated': { status: 'present', reason: '合并范围证据支持集团型经营审核重点。' },
  }) });
  assert.equal(result.accepted, true);
  if (!result.accepted) return;
  assert.deepEqual(result.candidate.specialFeatures, ['city-infrastructure', 'group-operated']);
  assert.equal(result.candidate.industry, null);
  assert.equal(result.candidate.status, 'candidate_only');
  assert.equal(result.candidate.productionEligible, false);
  assert.equal(result.candidate.reviewAuthorization, 'not_established');
});

test('unknown and null dimensions stay unknown rather than becoming an empty feature set', () => {
  const unknown = build({ dimensions: dimensions({ 'real-estate': { status: 'unknown', evidence: [], reason: null } }) });
  assert.equal(unknown.accepted, true);
  if (unknown.accepted) assert.equal(unknown.candidate.specialFeatures, null);

  const omitted = build({ dimensions: null });
  assert.equal(omitted.accepted, true);
  if (omitted.accepted) assert.equal(omitted.candidate.specialFeatures, null);
});

test('complete, evidence-backed negatives produce only a candidate, never production approval', () => {
  const result = build({ dimensions: dimensions() });
  assert.equal(result.accepted, true);
  if (!result.accepted) return;
  assert.deepEqual(result.candidate.specialFeatures, []);
  assert.equal(result.candidate.status, 'candidate_only');
  assert.equal(result.candidate.reviewAuthorization, 'not_established');
  assert.equal(result.candidate.productionEligible, false);
});

test('invalid codes, incomplete evidence, dictionary versions and unbound industry values fail closed', () => {
  const badCode = dimensions();
  (badCode[0] as { code: string }).code = 'urban-construction';
  assert.deepEqual(build({ dimensions: badCode }), { accepted: false, reason: 'invalid_feature_code' });

  const noNegativeEvidence = dimensions({ 'real-estate': { evidence: [] } });
  assert.deepEqual(build({ dimensions: noNegativeEvidence }), { accepted: false, reason: 'evidence_required' });
  assert.deepEqual(build({ dimensions: dimensions({ 'real-estate': { evidence: [{
    ...validEvidence, materialVersion: 0,
  }] } }) }), { accepted: false, reason: 'evidence_invalid' });
  assert.deepEqual(build({ dimensions: dimensions({ 'real-estate': { evidence: [{
    ...validEvidence, materialVersion: '1' as never,
  }] } }) }), { accepted: false, reason: 'evidence_invalid' });
  assert.deepEqual(build({ dimensions: dimensions({ 'real-estate': { evidence: [{
    ...validEvidence, locator: '   ',
  }] } }) }), { accepted: false, reason: 'evidence_invalid' });
  assert.deepEqual(build({ dimensions: dimensions({ 'real-estate': { evidence: [{
    ...validEvidence, parseSnapshotId: '',
  }] } }) }), { accepted: false, reason: 'evidence_invalid' });
  assert.deepEqual(build({ dictionaryVersion: 'sse-private-applicability-v0' }), { accepted: false, reason: 'dictionary_version_mismatch' });
  assert.deepEqual(build({ dictionarySha256: '0'.repeat(64) }), { accepted: false, reason: 'invalid_dictionary_hash' });
  assert.deepEqual(build({ industry: {
    status: 'classified', standardId: 'guessed-standard', standardVersion: '1',
    definitionSha256: 'c'.repeat(64), code: 'guessed-industry-code',
  } }), { accepted: false, reason: 'invalid_industry_binding' });
  assert.deepEqual(build({ industry: null }), { accepted: false, reason: 'invalid_industry_classification' });
  assert.deepEqual(build({ industry: { status: 'pending' } }), { accepted: false, reason: 'invalid_industry_classification' });
});
