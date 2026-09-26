import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSsePrivateApplicabilityCandidate,
  SSE_PRIVATE_APPLICABILITY_DICTIONARY,
  SSE_PRIVATE_FEATURE_DIMENSIONS,
  type ApplicabilityDimensionAssessment,
} from './sse-private-applicability-taxonomy.js';

const validEvidence = {
  materialId: 'material-1',
  materialVersion: 1,
  materialSha256: 'a'.repeat(64),
  parseSnapshotId: 'snapshot-1',
  sourceRecordId: 'record-1',
  sourceContentSha256: 'b'.repeat(64),
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
  assert.equal(SSE_PRIVATE_APPLICABILITY_DICTIONARY.version, 'sse-private-applicability-v1');
  assert.match(SSE_PRIVATE_APPLICABILITY_DICTIONARY.contentSha256, /^[a-f0-9]{64}$/);
  assert.equal(Object.isFrozen(SSE_PRIVATE_APPLICABILITY_DICTIONARY), true);
  assert.equal(Object.isFrozen(SSE_PRIVATE_APPLICABILITY_DICTIONARY.featureDimensions), true);
  assert.equal(SSE_PRIVATE_APPLICABILITY_DICTIONARY.isolation.referenceMatchingDictionary, 'not-a-#77-business-matching-dictionary');
  assert.equal('mainBusinessRevenue' in SSE_PRIVATE_APPLICABILITY_DICTIONARY, false);
  assert.equal(SSE_PRIVATE_APPLICABILITY_DICTIONARY.industry.standardBinding, null);
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
  } }), { accepted: false, reason: 'industry_standard_unbound' });
  assert.deepEqual(build({ industry: null }), { accepted: false, reason: 'invalid_industry_classification' });
  assert.deepEqual(build({ industry: { status: 'pending' } }), { accepted: false, reason: 'invalid_industry_classification' });
});
