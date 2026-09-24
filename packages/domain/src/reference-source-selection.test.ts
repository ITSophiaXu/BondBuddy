import assert from 'node:assert/strict';
import test from 'node:test';
import type { Market, Offering } from '@bondbuddy/contracts';
import type { AnnualBusinessProfile, ReferenceCandidate, ReferenceMatchInput } from './reference-match.js';
import { selectReferenceSource, type ProjectReferenceMaterial } from './reference-source-selection.js';

const target = { market: 'sse' as Market, offering: 'private' as Offering, instrument: 'corporate_bond', documentStage: 'issuance' as const };
const scope = { ...target, ruleVersion: 'rules-v4' };
const proof = ['synthetic:annual-report:business-note'];

function profile(issuerId: string): AnnualBusinessProfile {
  return {
    issuerId, profileVersion: 'profile-v1', taxonomyVersion: 'bond-business-2026.1', fiscalYear: 2025,
    completeAnnualPeriod: true, latestCompleteAnnual: true, verificationStatus: 'verified',
    accountingScope: 'consolidated', revenueBasis: 'operating_revenue', currency: 'CNY', unit: 'CNY 10,000',
    allComparableBusinessLinesPresent: true, sourceEvidence: proof,
    lines: [
      { code: 'chemicals', label: 'Chemicals', originalLabel: 'Synthetic chemicals', revenue: '100', rank: 1, evidence: proof, classificationEvidence: proof },
      { code: 'logistics', label: 'Logistics', originalLabel: 'Synthetic logistics', revenue: '60', rank: 2, evidence: proof, classificationEvidence: proof },
      { code: 'equipment', label: 'Equipment', originalLabel: 'Synthetic equipment', revenue: '40', rank: 3, evidence: proof, classificationEvidence: proof },
      { code: 'services', label: 'Services', originalLabel: 'Synthetic services', revenue: '10', rank: 4, evidence: proof, classificationEvidence: proof },
    ],
  };
}

function libraryCandidate(referenceId = 'library-ref'): ReferenceCandidate {
  return {
    referenceId, documentVersion: 'doc-v1', profile: profile(`synthetic-${referenceId}`), ...target,
    availability: 'published', readable: true, useAuthorized: true, sourceValidity: 'valid', reviewQuality: 3,
    disclosedAt: '2025-06-01', applicableScopes: [scope], chapterMappings: [],
  };
}

function matchInput(overrides: Partial<ReferenceMatchInput> = {}): ReferenceMatchInput {
  return {
    targetProfile: profile('synthetic-target-issuer'),
    target: { ...target, ruleVersion: 'rules-v4' }, ruleVersion: 'rules-v4',
    referenceIndexVersion: 'index-v11', libraryAvailable: true, candidates: [libraryCandidate()],
    ...overrides,
  };
}

function material(overrides: Partial<ProjectReferenceMaterial> = {}): ProjectReferenceMaterial {
  return {
    materialId: 'material-a', materialVersion: 'v3', contentHash: 'a'.repeat(64), role: 'reference',
    ownerId: 'user-a', projectId: 'project-a', deleted: false, parseStatus: 'parsed', readable: true,
    mediaType: 'application/pdf', useAuthorized: true, ...target,
    applicableScopes: [scope], chapterMappings: [],
    ...overrides,
  };
}

const project = { ownerId: 'user-a', projectId: 'project-a' };

test('a usable project reference wins over the library and is marked structure only', () => {
  const result = selectReferenceSource({ project, userReferences: [material()], preferredUserReference: { materialId: 'material-a', materialVersion: 'v3' }, automaticMatch: matchInput() });
  assert.equal(result.status, 'selected_user_reference');
  assert.equal(result.selected?.source, 'user_material');
  assert.equal(result.selected?.use, 'structure_only');
  assert.equal(result.selected?.materialVersion, 'v3');
  assert.equal(result.selected?.contentHash, 'a'.repeat(64));
  assert.equal(result.deliverableStatus, 'not_determined');
  assert.equal(result.libraryDecision, null);
  assert.equal(JSON.stringify(result).includes('Synthetic chemicals'), false);
  assert.equal(JSON.stringify(result).includes('reference body'), false);
});

test('a user reference remains eligible while the library is unavailable or has no index version', () => {
  const result = selectReferenceSource({
    project, userReferences: [material()],
    preferredUserReference: { materialId: 'material-a', materialVersion: 'v3' },
    automaticMatch: matchInput({ libraryAvailable: false, referenceIndexVersion: '' }),
  });
  assert.equal(result.status, 'selected_user_reference');
  assert.equal(result.selected?.source, 'user_material');
  assert.equal(result.selected?.use, 'structure_only');
});

test('only the explicitly selected material version is inspected; a missing choice falls back', () => {
  const selected = material({ materialId: 'material-b', materialVersion: 'v7' });
  const other = material({ materialId: 'material-a', materialVersion: 'v1', ownerId: 'wrong-owner' });
  const result = selectReferenceSource({ project, userReferences: [other, selected],
    preferredUserReference: { materialId: 'material-b', materialVersion: 'v7' }, automaticMatch: matchInput() });
  assert.equal(result.status, 'selected_user_reference');
  assert.equal(result.selected?.materialId, 'material-b');
  assert.equal(result.userReferenceDecisions.length, 1);
  assert.equal(result.userReferenceDecisions[0]?.materialId, 'material-b');

  const missing = selectReferenceSource({ project, userReferences: [material()],
    preferredUserReference: { materialId: 'missing', materialVersion: 'v99' }, automaticMatch: matchInput() });
  assert.equal(missing.status, 'selected_library_reference');
  assert.equal(missing.userReferenceDecisions.at(-1)?.reason, 'specified_reference_not_found_in_project');
});

test('wrong owner, project, role, deletion, parse/readability, format, authorization, and bad hash all fall back', () => {
  const cases: readonly [string, Partial<ProjectReferenceMaterial>, string][] = [
    ['other owner', { ownerId: 'user-b' }, 'owner_mismatch'],
    ['other project', { projectId: 'project-b' }, 'project_mismatch'],
    ['historical role', { role: 'historical' }, 'role_not_reference'],
    ['deleted', { deleted: true }, 'material_deleted'],
    ['damaged parse', { parseStatus: 'failed' }, 'material_failed'],
    ['unreadable', { readable: false }, 'material_not_readable'],
    ['unsupported format', { mediaType: 'text/plain' }, 'unsupported_material_format'],
    ['unauthorized', { useAuthorized: false }, 'material_use_not_authorized'],
    ['missing hash', { contentHash: 'not-a-sha256' }, 'material_identity_version_or_hash_missing'],
  ];
  for (const [label, overrides, reason] of cases) {
    const result = selectReferenceSource({ project, userReferences: [material(overrides)], preferredUserReference: { materialId: 'material-a', materialVersion: 'v3' }, automaticMatch: matchInput() });
    assert.equal(result.status, 'selected_library_reference', label);
    assert.equal(result.selected?.source, 'business_library', label);
    assert.equal(result.userReferenceDecisions[0]?.reason, reason, label);
    assert.equal(result.libraryDecision?.status, 'exact', label);
    if (label === 'other owner') assert.equal(result.userReferenceDecisions[0]?.contentHash, '', label);
  }
});

test('rule inapplicability and an unreviewed cross-market or offering mapping fall back', () => {
  const noTargetRule = material({ applicableScopes: [{ ...scope, ruleVersion: 'rules-v3' }] });
  const noTargetResult = selectReferenceSource({ project, userReferences: [noTargetRule], preferredUserReference: { materialId: 'material-a', materialVersion: 'v3' }, automaticMatch: matchInput() });
  assert.equal(noTargetResult.userReferenceDecisions[0]?.reason, 'target_rule_scope_not_applicable');
  assert.equal(noTargetResult.status, 'selected_library_reference');

  const cross = material({ market: 'szse', applicableScopes: [scope] });
  const crossResult = selectReferenceSource({ project, userReferences: [cross], preferredUserReference: { materialId: 'material-a', materialVersion: 'v3' }, automaticMatch: matchInput() });
  assert.equal(crossResult.userReferenceDecisions[0]?.reason, 'cross_market_or_offering_mapping_not_accepted');
  assert.equal(crossResult.status, 'selected_library_reference');

  const wrongOffering = material({ offering: 'public', applicableScopes: [scope] });
  const offeringResult = selectReferenceSource({ project, userReferences: [wrongOffering], preferredUserReference: { materialId: 'material-a', materialVersion: 'v3' }, automaticMatch: matchInput() });
  assert.equal(offeringResult.userReferenceDecisions[0]?.reason, 'cross_market_or_offering_mapping_not_accepted');
  assert.equal(offeringResult.status, 'selected_library_reference');
});

test('a correctly accepted cross-market and cross-offering mapping permits structure-only use', () => {
  const cross = material({
    market: 'szse', offering: 'public', applicableScopes: [scope],
    chapterMappings: [{ status: 'accepted', version: 'chapter-map-v2', sourceMarket: 'szse', targetMarket: 'sse', sourceOffering: 'public', targetOffering: 'private', instrument: target.instrument, documentStage: target.documentStage, ruleVersion: 'rules-v4' }],
  });
  const result = selectReferenceSource({ project, userReferences: [cross], preferredUserReference: { materialId: 'material-a', materialVersion: 'v3' }, automaticMatch: matchInput() });
  assert.equal(result.status, 'selected_user_reference');
  assert.equal(result.selected?.chapterMappingVersion, 'chapter-map-v2');
});

test('without an uploaded user reference, matching runs automatically without requiring an upload', () => {
  const result = selectReferenceSource({ project, userReferences: [], preferredUserReference: null, automaticMatch: matchInput() });
  assert.equal(result.status, 'selected_library_reference');
  assert.equal(result.selected?.use, 'structure_only');
  assert.equal(result.guidance, 'none');
  assert.deepEqual(result.userReferenceDecisions, []);
  assert.equal(result.libraryDecision?.status, 'exact');
  assert.equal('targetBusinessProfile' in (result.libraryDecision ?? {}), false);
});

test('no library match is an internal capability gap, never a successful selection or forced upload', () => {
  const result = selectReferenceSource({ project, userReferences: [], preferredUserReference: null, automaticMatch: matchInput({ candidates: [] }) });
  assert.equal(result.status, 'no_match');
  assert.equal(result.selected, null);
  assert.equal(result.deliverableStatus, 'not_determined');
  assert.equal(result.guidance, 'internal_reference_capability_insufficient');
  assert.equal(result.libraryDecision?.status, 'no_match');
});

test('missing issuer business evidence stays a needs-evidence outcome', () => {
  const result = selectReferenceSource({
    project, userReferences: [], preferredUserReference: null,
    automaticMatch: matchInput({ targetProfile: { ...profile('synthetic-target-issuer'), sourceEvidence: [] } }),
  });
  assert.equal(result.status, 'needs_evidence');
  assert.equal(result.issuerEvidenceStatus, 'needs_evidence');
  assert.equal(result.selected, null);
  assert.equal(result.guidance, 'issuer_evidence_missing');
  assert.equal(result.libraryDecision?.status, 'needs_evidence');
});

test('user structure reference does not hide missing issuer business evidence', () => {
  const incompleteMatch = matchInput({ targetProfile: { ...profile('synthetic-target-issuer'), sourceEvidence: [] } });
  const result = selectReferenceSource({ project, userReferences: [material()],
    preferredUserReference: { materialId: 'material-a', materialVersion: 'v3' }, automaticMatch: incompleteMatch });
  assert.equal(result.status, 'needs_evidence');
  assert.equal(result.selected, null);
  assert.equal(result.userReferenceDecisions[0]?.reason, 'issuer_profile_needs_evidence');
  assert.equal(result.issuerEvidenceStatus, 'needs_evidence');
  assert.equal(result.deliverableStatus, 'not_determined');
  assert.equal(result.guidance, 'issuer_evidence_missing');
});

test('invalid target market and rule version prevent user reference selection', () => {
  const invalidTarget = matchInput({ target: { ...target, ruleVersion: 'rules-v3' } });
  const result = selectReferenceSource({ project, userReferences: [material()],
    preferredUserReference: { materialId: 'material-a', materialVersion: 'v3' }, automaticMatch: invalidTarget });
  assert.equal(result.status, 'needs_review');
  assert.equal(result.selected, null);
  assert.equal(result.userReferenceDecisions[0]?.reason, 'target_rule_or_scope_version_invalid');
});
