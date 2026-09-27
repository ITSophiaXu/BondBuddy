import assert from 'node:assert/strict';
import test from 'node:test';
import type { Money, ReportingPeriod } from '@bondbuddy/contracts';
import { updateContentHash } from './historical-update.js';
import { reviewIssuanceArrangement, type ArrangementProposal, type ArrangementTextClaim, type ArrangementAmountClaim } from './issuance-arrangement.js';
import type { UpdateDifficultyEstimateInput } from './update-difficulty.js';

// Synthetic semantic proposals, not supplier extraction or user approval.
const unknown = (): ArrangementTextClaim & ArrangementAmountClaim => ({ value: null, evidence: [], uncertainty: [] });
function fixture() {
  const proposal: ArrangementProposal = {
    context: { ownerUserId: 'owner', projectId: 'project', inputRevision: 3, inputHash: 'a'.repeat(64) },
    sources: [], document: { sourcePurpose: 'issuance', targetPurpose: 'issuance', sourceActualOffering: 'private', targetActualOffering: 'private', coveredOfferings: [] },
    registrationAmount: unknown(), issuanceAmount: unknown(), commonTerms: {}, tranches: [], institutions: [], callbacks: [],
  };
  function evidence(quote: string) {
    const text = `用户原输入：${quote}。`, sourceId = `s${proposal.sources.length + 1}`, start = text.indexOf(quote);
    const source: ArrangementProposal['sources'][number] = { sourceId, version: 1, ...{ ownerUserId: 'owner', projectId: 'project' }, kind: 'project_field', text, textHash: updateContentHash(text) };
    proposal.sources.push(source);
    return [{ sourceId, version: 1, textHash: source.textHash, start, end: start + quote.length, quote }];
  }
  const text = (value: string): ArrangementTextClaim => ({ value, evidence: evidence(value), uncertainty: [] });
  const money = (value: string, qualifier: 'exact' | 'ceiling' = 'exact', unit: Money['unit'] = 'hundred_million'): ArrangementAmountClaim => ({
    value: { amount: { value, unit }, qualifier }, evidence: evidence(`${qualifier === 'ceiling' ? '不超过' : ''}${value}${unit === 'yuan' ? '元' : unit === 'ten_thousand' ? '万元' : '亿元'}`), uncertainty: [],
  });
  proposal.registrationAmount = money('20'); proposal.issuanceAmount = money('10');
  proposal.tranches = [
    { trancheId: 'a', name: text('品种甲'), amount: money('6'), terms: { tenor: text('3年期'), put: text('第2年末回售') } },
    { trancheId: 'b', name: text('品种乙'), amount: money('4'), terms: { tenor: text('5年期') } },
  ];
  proposal.commonTerms.interestType = { claim: text('固定利率'), scope: 'all' };
  proposal.institutions = [{ institutionId: 'u1', name: text('甲证券'), section: 'underwriting', roles: [], scope: 'all' }];
  const period: ReportingPeriod = { start: '2024-01-01', end: '2024-12-31', period_kind: 'annual', scope: 'consolidated', raw_value: '2024年度',
    status: 'recognized', uncertainty: [], provenance: { material_id: 'synthetic', material_version: 1, method: 'native_text', extractor_version: 'synthetic-v1', evidence_refs: ['synthetic-period'] } };
  const financial: { -readonly [K in keyof UpdateDifficultyEstimateInput]: UpdateDifficultyEstimateInput[K] } = { profileVersion: 2, targetRevision: 3,
    source: { market: 'sse', offering: 'private', reportingPeriods: [period] }, target: { market: 'sse', offering: 'private', reportingPeriods: [period] }, replacements: [], restatements: [] };
  const run = () => reviewIssuanceArrangement(proposal, financial);
  return { proposal, financial, text, money, run };
}
const codes = (result: ReturnType<typeof reviewIssuanceArrangement>) => result.issues.map(i => i.code);

test('two evidenced tranches preserve differences, common scope, original text and user-asserted status', () => {
  const s = fixture(), before = structuredClone(s.proposal), result = s.run();
  assert.deepEqual(s.proposal, before);
  assert.equal(result.status, 'ready_for_review'); assert.equal(result.sourceStatus, 'user_asserted'); assert.equal(result.eligibleForManuscript, false);
  assert.equal(result.tranches[0]!.terms.tenor!.claim.value, '3年期'); assert.equal(result.tranches[1]!.terms.tenor!.claim.value, '5年期');
  assert.equal(result.tranches[1]!.terms.put, undefined);
  assert.ok(result.tranches.every(t => t.terms.interestType?.inherited));
  assert.deepEqual(result.sources, before.sources); assert.deepEqual(result.proposal, before);
  assert.equal(result.chapterChecks.length, 8); assert.ok(result.chapterChecks.every(c => c.trancheIds.join() === 'a,b'));
  assert.deepEqual(result.institutions[0]!.roles.map(r => r.value), ['主承销商']);
  assert.equal(result.institutions[0]!.roleDerivation, 'single_underwriter');
  assert.equal(result.difficulty.estimatedN, 0); assert.deepEqual(s.run(), result);
});

test('same-period cross-market/private-to-public changes require structure work but N remains zero', () => {
  const s = fixture(); s.financial.target = { ...s.financial.target, market: 'szse', offering: 'public_all' };
  s.proposal.document.targetActualOffering = 'public_all';
  const result = s.run();
  assert.equal(result.difficulty.estimatedN, 0); assert.equal(result.difficulty.structureAdaptationRequired, true);
  assert.ok(result.structureReasons.includes('market_changed')); assert.ok(result.structureReasons.includes('offering_changed'));
  assert.equal(result.chapterChecks.length, 8);
});

test('a new financial cutoff is counted once regardless of two tranches and parent/consolidated duplication', () => {
  const s = fixture(); const p = s.financial.source.reportingPeriods[0]!;
  s.financial.target = { ...s.financial.target, reportingPeriods: [...s.financial.target.reportingPeriods,
    { ...p, start: '2025-01-01', end: '2025-09-30', period_kind: 'interim' },
    { ...p, start: '2025-01-01', end: '2025-09-30', period_kind: 'interim', scope: 'parent' }] };
  assert.equal(s.run().difficulty.estimatedN, 1);
});

test('unknown or user-asserted financial periods remain N=null, not zero', () => {
  const s = fixture(); s.financial.target = { ...s.financial.target, reportingPeriods: [{ start: '2025-01-01', end: '2025-09-30', period_kind: 'interim', scope: 'consolidated', status: 'user_asserted', evidence_refs: [] }] };
  const result = s.run(); assert.equal(result.difficulty.estimatedN, null);
  assert.ok(codes(result).includes('ARRANGEMENT_FINANCIAL_DIFFICULTY_PENDING'));
});

test('exact amounts normalize units without floating-point drift; mismatches never auto-balance', () => {
  const s = fixture(); s.proposal.issuanceAmount = s.money('0.3', 'exact', 'yuan');
  s.proposal.tranches[0]!.amount = s.money('0.1', 'exact', 'yuan'); s.proposal.tranches[1]!.amount = s.money('0.00002', 'exact', 'ten_thousand');
  assert.ok(!codes(s.run()).includes('ARRANGEMENT_AMOUNT_CONFLICT'));
  s.proposal.tranches[1]!.amount = s.money('0.3', 'exact', 'yuan');
  const before = structuredClone(s.proposal.tranches), result = s.run();
  assert.ok(codes(result).includes('ARRANGEMENT_AMOUNT_CONFLICT')); assert.deepEqual(s.proposal.tranches, before);
});

test('individual ceilings exceeding an overall ceiling are undetermined allocations, not an automatic sum conflict', () => {
  const s = fixture(); s.proposal.issuanceAmount = s.money('10', 'ceiling');
  s.proposal.tranches.forEach(t => { t.amount = s.money('8', 'ceiling'); });
  const result = s.run(); assert.ok(!codes(result).includes('ARRANGEMENT_AMOUNT_CONFLICT'));
  assert.ok(codes(result).includes('ARRANGEMENT_ALLOCATION_UNDETERMINED'));
});

test('known exact amounts over the total are a conflict even if another tranche is unknown', () => {
  const s = fixture(); s.proposal.tranches[0]!.amount = s.money('11'); s.proposal.tranches[1]!.amount = unknown();
  const result = s.run(); assert.ok(codes(result).includes('ARRANGEMENT_AMOUNT_CONFLICT'));
  assert.equal(result.tranches[1]!.amount.value, null);
});

test('an exact total above all stated capacities is a conflict; callbacks do not manufacture amounts', () => {
  const s = fixture(); s.proposal.tranches.forEach(t => { t.amount = s.money('4', 'ceiling'); });
  s.proposal.callbacks = [{ from: 'a', to: 'b', terms: s.text('两个品种之间可回拨') }];
  assert.ok(codes(s.run()).includes('ARRANGEMENT_AMOUNT_CONFLICT'));
  assert.equal(s.run().tranches[0]!.amount.value!.amount.value, '4');
});

test('only a single unspecified tranche can inherit current amount; registration amount is never inherited', () => {
  const s = fixture(); s.proposal.tranches = [s.proposal.tranches[0]!]; s.proposal.tranches[0]!.amount = unknown();
  assert.deepEqual(s.run().tranches[0]!.amount, s.proposal.issuanceAmount);
  s.proposal.issuanceAmount = unknown();
  assert.equal(s.run().tranches[0]!.amount.value, null);
  assert.ok(codes(s.run()).includes('ARRANGEMENT_ISSUANCE_AMOUNT_MISSING'));
});

test('single-only common terms do not spread across multiple tranches; explicit unknown overrides common terms', () => {
  const s = fixture(); delete s.proposal.tranches[1]!.terms.tenor;
  s.proposal.commonTerms.tenor = { claim: s.text('3年期'), scope: 'single_only' };
  assert.equal(s.run().tranches[1]!.terms.tenor, undefined);
  s.proposal.commonTerms.tenor.scope = 'all';
  assert.equal(s.run().tranches[1]!.terms.tenor!.claim.value, '3年期');
  s.proposal.tranches[1]!.terms.tenor = unknown();
  assert.equal(s.run().tranches[1]!.terms.tenor!.claim.value, null);
  assert.ok(codes(s.run()).includes('ARRANGEMENT_TENOR_MISSING'));
});

test('missing both tranche amounts does not divide the total or create default terms', () => {
  const s = fixture(); s.proposal.tranches.forEach(t => { t.amount = unknown(); t.terms = {}; });
  const result = s.run(); assert.ok(result.tranches.every(t => t.amount.value === null && !t.terms.tenor));
});

test('multiple underwriters require roles and scopes; a sole other agency never becomes lead underwriter', () => {
  const s = fixture(); s.proposal.institutions.push({ institutionId: 'u2', name: s.text('乙证券'), section: 'underwriting', roles: [], scope: 'single_only' });
  let result = s.run(); assert.ok(result.institutions.every(i => i.roles.length === 0));
  assert.ok(codes(result).includes('ARRANGEMENT_INSTITUTION_ROLE_MISSING')); assert.ok(codes(result).includes('ARRANGEMENT_INSTITUTION_SCOPE_MISSING'));
  s.proposal.institutions = [{ institutionId: 'law', name: s.text('甲律所'), section: 'other_agencies', roles: [], scope: 'all' }];
  result = s.run(); assert.equal(result.institutions[0]!.roleDerivation, 'unresolved');
});

test('explicit institution role and tranche scope stay local, no implicit co-lead/trustee/bookrunner', () => {
  const s = fixture(); s.proposal.institutions[0]!.roles = [s.text('主承销商')]; s.proposal.institutions[0]!.scope = ['a'];
  const result = s.run(); assert.deepEqual(result.institutions[0]!.trancheIds, ['a']);
  assert.deepEqual(result.institutions[0]!.roles.map(r => r.value), ['主承销商']);
});

test('DFI registration coverage never creates issued tranches or forces unknown future coupon/tenor', () => {
  const s = fixture(); s.financial.source = { ...s.financial.source, market: 'nafmii', offering: 'dfi' }; s.financial.target = { ...s.financial.target, market: 'nafmii', offering: 'dfi' };
  s.proposal.document = { sourcePurpose: 'registration', targetPurpose: 'registration', sourceActualOffering: null, targetActualOffering: null, coveredOfferings: ['mtn', 'cp', 'scp'] };
  s.proposal.tranches = []; s.proposal.institutions = []; s.proposal.issuanceAmount = unknown();
  const result = s.run(); assert.equal(result.status, 'ready_for_review'); assert.deepEqual(result.tranches, []); assert.equal(result.difficulty.estimatedN, 0);
});

test('DFI issuance requires actual tool rather than selecting from coverage', () => {
  const s = fixture(); s.financial.target = { ...s.financial.target, market: 'nafmii', offering: 'dfi' }; s.proposal.document.targetActualOffering = null; s.proposal.document.coveredOfferings = ['mtn', 'cp'];
  assert.ok(codes(s.run()).includes('ARRANGEMENT_DFI_ACTUAL_OFFERING_MISSING'));
  s.proposal.document.targetActualOffering = 'mtn';
  assert.ok(!codes(s.run()).includes('ARRANGEMENT_DFI_ACTUAL_OFFERING_MISSING'));
  assert.equal(s.run().proposal.document.targetActualOffering, 'mtn');
});

test('an MTN document with DFI/CP/SCP background stays MTN, independent of raw keyword count', () => {
  const s = fixture(); s.financial.source = { ...s.financial.source, market: 'nafmii', offering: 'mtn' }; s.financial.target = { ...s.financial.target, market: 'nafmii', offering: 'mtn' };
  s.proposal.document.sourceActualOffering = 'mtn'; s.proposal.document.targetActualOffering = 'mtn'; s.proposal.document.coveredOfferings = ['mtn', 'cp', 'scp'];
  s.text('DFI统一注册背景，覆盖CP、SCP，DFI不是本期工具。');
  assert.deepEqual(s.run().structureReasons, []); assert.equal(s.run().difficulty.targetReportingPeriods.length, 1);
});

test('same-period registration-to-issuance is structural work without an extra period', () => {
  const s = fixture(); s.proposal.document.sourcePurpose = 'registration';
  const result = s.run(); assert.ok(result.structureReasons.includes('document_purpose_changed')); assert.equal(result.difficulty.estimatedN, 0);
});

test('unknown source purpose is not classified as a confirmed purpose change', () => {
  const s = fixture(); s.proposal.document.sourcePurpose = null;
  const result = s.run(); assert.ok(codes(result).includes('ARRANGEMENT_SOURCE_PURPOSE_MISSING')); assert.ok(!result.structureReasons.includes('document_purpose_changed'));
});

test('wrong actual tool, registration coverage, scope and callback endpoints remain explicit issues', () => {
  const s = fixture(); s.proposal.document.targetActualOffering = 'mtn'; s.proposal.document.coveredOfferings = ['dfi'];
  s.proposal.commonTerms.tenor = { claim: s.text('3年期'), scope: ['absent'] };
  s.proposal.callbacks = [{ from: 'a', to: 'a', terms: unknown() }];
  const result = s.run();
  for (const code of ['ARRANGEMENT_ACTUAL_OFFERING_CONFLICT', 'ARRANGEMENT_COVERED_OFFERING_INVALID', 'ARRANGEMENT_SCOPE_UNKNOWN', 'ARRANGEMENT_CALLBACK_SCOPE_INVALID', 'ARRANGEMENT_CALLBACK_TERMS_MISSING']) assert.ok(codes(result).includes(code), code);
});

test('unanchored amount/qualifier, changed term and uncertain extraction are withheld or flagged', () => {
  const s = fixture(); s.proposal.tranches[0]!.amount.value!.qualifier = 'ceiling';
  s.proposal.tranches[1]!.terms.tenor!.value = '30年期'; s.proposal.commonTerms.interestType!.claim.uncertainty = ['scope_ambiguous'];
  const result = s.run(); assert.equal(result.tranches[0]!.amount.value, null);
  assert.ok(codes(result).includes('ARRANGEMENT_AMOUNT_NOT_ANCHORED')); assert.ok(codes(result).includes('ARRANGEMENT_TEXT_NOT_ANCHORED'));
  assert.equal(result.tranches[1]!.terms.tenor!.claim.value, null);
  assert.equal(result.proposal.tranches[1]!.terms.tenor!.value, '30年期', 'the rejected proposal is preserved for review');
  assert.ok(result.tranches.every(t => t.terms.interestType === undefined));
});

for (const mutation of ['owner', 'project', 'version', 'hash', 'quote', 'offset', 'source_duplicate', 'tranche_duplicate', 'revision', 'extra_field', 'unsafe_amount', 'blank_term'] as const) {
  test(`malformed or stale proposal cannot pass ${mutation}`, () => {
    const s = fixture(), source = s.proposal.sources[0]!, evidence = s.proposal.registrationAmount.evidence[0]!;
    if (mutation === 'owner') source.ownerUserId = 'another';
    if (mutation === 'project') source.projectId = 'another';
    if (mutation === 'version') source.version++;
    if (mutation === 'hash') source.textHash = 'b'.repeat(64);
    if (mutation === 'quote') evidence.quote = 'invented';
    if (mutation === 'offset') evidence.end++;
    if (mutation === 'source_duplicate') s.proposal.sources.push(source);
    if (mutation === 'tranche_duplicate') s.proposal.tranches.push(s.proposal.tranches[0]!);
    if (mutation === 'revision') s.proposal.context.inputRevision++;
    if (mutation === 'extra_field') Object.assign(s.proposal, { verified: true });
    if (mutation === 'unsafe_amount') s.proposal.issuanceAmount.value!.amount.value = '-1';
    if (mutation === 'blank_term') s.proposal.tranches[0]!.terms.tenor!.value = '   ';
    assert.throws(s.run, /ARRANGEMENT_/);
  });
}

test('editing a source or arrangement changes the bound review hash; returned state is isolated from caller mutation', () => {
  const s = fixture(), first = s.run(); s.proposal.tranches[1]!.terms.tenor = s.text('7年期');
  const next = s.run(); assert.notEqual(first.reviewHash, next.reviewHash); assert.notEqual(first.proposalHash, next.proposalHash);
  assert.equal(first.tranches[1]!.terms.tenor!.claim.value, '5年期');
  assert.equal(first.context.inputHash, 'a'.repeat(64));
});

test('a quote cannot omit an adjacent ceiling qualifier and turn its amount into an exact allocation', () => {
  const s = fixture(); const c = s.proposal.tranches[0]!.amount, e = c.evidence[0]!;
  const source = s.proposal.sources.find(source => source.sourceId === e.sourceId)!;
  source.text = '不超过6亿元'; source.textHash = updateContentHash(source.text);
  Object.assign(e, { quote: '6亿元', start: 3, end: source.text.length, textHash: source.textHash });
  const result = s.run(); assert.ok(codes(result).includes('ARRANGEMENT_AMOUNT_NOT_ANCHORED'));
  assert.equal(result.tranches[0]!.amount.value, null);
});

test('evidence cannot split a UTF-16 surrogate pair', () => {
  const s = fixture(); const c = s.text('😀'), e = c.evidence[0]!;
  e.end--; e.quote = e.quote.slice(0, 1); c.value = e.quote;
  s.proposal.tranches[0]!.terms.tenor = c;
  assert.throws(s.run, /ARRANGEMENT_EVIDENCE_MISMATCH/);
});

test('amount evidence cannot be a suffix of a larger, decimal, signed or grouped number', () => {
  for (const raw of ['16亿元', '1.6亿元', '-6亿元', '+6亿元', '1,006亿元', '1,6亿元']) {
    const s = fixture(), c = s.proposal.tranches[0]!.amount, e = c.evidence[0]!;
    const source = s.proposal.sources.find(source => source.sourceId === e.sourceId)!;
    source.text = raw; source.textHash = updateContentHash(raw);
    Object.assign(e, { quote: '6亿元', start: raw.indexOf('6亿元'), end: raw.length, textHash: source.textHash });
    const result = s.run();
    assert.equal(result.tranches[0]!.amount.value, null, raw);
    assert.ok(codes(result).includes('ARRANGEMENT_AMOUNT_NOT_ANCHORED'), raw);
  }
});

test('financial period arrays are snapshotted rather than aliased into an existing review', () => {
  const s = fixture(), first = s.run();
  Object.assign(s.financial.source.reportingPeriods[0]!, { end: '2025-12-31' });
  assert.equal(first.difficulty.sourceReportingPeriods[0]!.end, '2024-12-31');
  const { reviewHash, ...content } = first; assert.equal(reviewHash, updateContentHash(content));
});
