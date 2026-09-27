import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { RulePack } from './index.js';
import { evaluateSsePrivateDraftChecks as evaluate, type CheckEvidence, type SsePrivateCheckInput } from './sse-private-checks.js';

const pack = JSON.parse(readFileSync(new URL('../../../knowledge/exchange-bonds/drafts/sse-private/rule-pack.json', import.meta.url), 'utf8')) as RulePack;
const evidence = <T>(value: T): CheckEvidence<T> => ({ value, status: 'verified', anchors: ['synthetic:material-v2:paragraph-4'] });
function input(): SsePrivateCheckInput {
  return { market: 'sse', offering: 'private', asOf: evidence('2026-09-26'),
    investors: { professionalOnly: evidence(true), publicSolicitation: evidence(false), issuanceCount: evidence(200),
      transferPlanned: evidence(true), transferProfessionalOnly: evidence(true), holdersAfterTransfer: evidence(200) },
    financialValidity: { cutoff: evidence('2026-03-26'), newApplication: evidence(false) },
    useChange: { proposed: evidence(true), restrictedDebtUse: evidence(false), changesToNonRestrictedUse: evidence(true),
      procedureAgreed: evidence(true), materialImpact: evidence(false), agreedProcedureFollowed: evidence(true) },
    temporaryUse: { planned: evidence(true), principleRestrictionPresent: evidence(false), termsExplicit: evidence(true),
      recoveryMechanism: evidence(true), decisionProcedure: evidence(true), internalApproval: evidence(true),
      start: evidence('2026-01-01'), repayment: evidence('2026-09-01'), paymentNodes: evidence(['2026-10-01']) },
    continuingDisclosure: { financialYearEnd: evidence('2025-12-31'), halfYearEnd: evidence('2026-06-30'),
      promisedAnnualBy: evidence('2026-04-30'), promisedInterimBy: evidence('2026-08-30'), annualAudited: evidence(true) } };
}
const check = (data: SsePrivateCheckInput, code: string) => {
  const found = evaluate(pack, data).findings.find(row => row.code === code);
  assert.ok(found, code); return found;
};

test('#20 research checks bind the pack version, sources and exact evidence, never publish', () => {
  const result = evaluate(pack, input());
  assert.equal(result.mode, 'research_only'); assert.equal(result.productionEligible, false);
  assert.equal(result.uncoveredRuleIds.length, 20);
  assert.ok(result.findings.every(row => row.sourceRefIds.length > 0));
  assert.ok(result.findings.filter(row => row.outcome === 'pass').every(row => row.evidenceAnchors.length > 0));
  assert.ok(!result.findings.some(row => row.outcome === 'issue'));
  assert.equal(pack.status, 'draft'); assert.equal(pack.release, null);
  assert.ok(pack.rules.every(row => !row.enabled && row.enforcement === 'research_only'));
  const drift = structuredClone(pack); drift.rules[4]!.checker.checker_version = 'unknown';
  assert.throws(() => evaluate(drift, input()), /CHECKER_VERSION_MISMATCH/);
});

test('#20 200/201 investors: issuance and post-transfer holders are separate populations', () => {
  const data = input(); assert.equal(check(data, 'issuance_count').outcome, 'pass');
  assert.equal(check(data, 'holders_after_transfer').outcome, 'pass');
  data.investors!.holdersAfterTransfer = evidence(201);
  assert.equal(check(data, 'holders_after_transfer').outcome, 'issue');
  data.investors!.issuanceCount = evidence(201); assert.equal(check(data, 'issuance_count').outcome, 'issue');
  data.investors!.professionalOnly = evidence(false); assert.equal(check(data, 'professional_only').outcome, 'issue');
  data.investors!.publicSolicitation = evidence(true); assert.equal(check(data, 'public_solicitation').outcome, 'issue');
});

test('#20 unknown, asserted, conflicting, invalid and unanchored values cannot pass', () => {
  for (const item of [ { ...evidence(200), status: 'user_asserted' as const }, { ...evidence(200), status: 'conflicted' as const },
    { ...evidence(200), anchors: [] }, evidence(-1), evidence(1.5), evidence(Number.NaN), { ...evidence(200), value: null } ]) {
    const data = input(); data.investors!.issuanceCount = item;
    assert.equal(check(data, 'evidence:issuance_count').outcome, 'needs_evidence');
    assert.ok(!evaluate(pack, data).findings.some(row => row.code === 'issuance_count' && row.outcome === 'pass'));
  }
  const empty: SsePrivateCheckInput = { market: 'sse', offering: 'private', asOf: evidence('2026-09-26') };
  assert.ok(evaluate(pack, empty).findings.every(row => ['needs_evidence', 'needs_judgement'].includes(row.outcome)));
});

test('#20 six calendar months, actual extension approval, new applications and future cutoff', () => {
  const data = input(); assert.equal(check(data, 'financial_validity').outcome, 'pass');
  data.financialValidity!.cutoff = evidence('2026-03-25');
  assert.equal(check(data, 'evidence:approved_extension_until').outcome, 'needs_evidence');
  data.financialValidity!.approvedExtensionUntil = { ...evidence('2026-10-25'), status: 'user_asserted' };
  assert.equal(check(data, 'evidence:approved_extension_until').outcome, 'needs_evidence');
  data.financialValidity!.approvedExtensionUntil = evidence('2026-10-25');
  assert.equal(check(data, 'approved_extension').outcome, 'pass');
  data.financialValidity!.approvedExtensionUntil = evidence('2026-10-26');
  assert.equal(check(data, 'approved_extension').outcome, 'issue');
  data.financialValidity!.newApplication = evidence(true);
  assert.equal(check(data, 'new_application_expired').outcome, 'needs_judgement');
  data.financialValidity!.cutoff = evidence('2026-12-31'); assert.equal(check(data, 'future_cutoff').outcome, 'issue');
  data.financialValidity!.cutoff = evidence('2026-06-31'); assert.equal(check(data, 'evidence:financial_cutoff').outcome, 'needs_evidence');
});

test('#20 restricted debt cannot be waived by a meeting; private category change is not public category change', () => {
  const data = input();
  assert.ok(!evaluate(pack, data).findings.some(row => row.code === 'evidence:holder_resolution'));
  data.useChange!.restrictedDebtUse = evidence(true); data.useChange!.holderResolution = evidence(true);
  assert.equal(check(data, 'restricted_debt_use').outcome, 'issue');
  data.useChange!.procedureAgreed = evidence(false); data.useChange!.holderResolution = evidence(false);
  assert.equal(check(data, 'holder_resolution').outcome, 'issue');
  data.useChange!.procedureAgreed = evidence(true); data.useChange!.materialImpact = evidence(true);
  assert.equal(check(data, 'holder_resolution').outcome, 'issue');
});

test('#20 temporary liquidity uses earliest node, preserves unknown nodes, and does not silently approve exceptions', () => {
  const data = input(); assert.equal(check(data, 'temporary_repayment_deadline').outcome, 'pass');
  data.temporaryUse!.paymentNodes = evidence(['2026-08-01', '2026-10-01']);
  assert.equal(check(data, 'temporary_repayment_deadline').outcome, 'issue');
  data.temporaryUse!.repayment = evidence('2026-08-01'); assert.equal(check(data, 'temporary_repayment_deadline').outcome, 'needs_judgement');
  data.temporaryUse!.paymentNodes = { ...evidence([]), value: null };
  assert.equal(check(data, 'evidence:original_payment_nodes').outcome, 'needs_evidence');
  data.temporaryUse!.paymentNodes = evidence([]); data.temporaryUse!.start = evidence('2024-02-29');
  data.temporaryUse!.repayment = evidence('2025-03-01'); assert.equal(check(data, 'temporary_repayment_deadline').outcome, 'issue');
  data.temporaryUse!.principleRestrictionPresent = evidence(true);
  assert.equal(check(data, 'principle_restriction').outcome, 'needs_judgement');
  data.temporaryUse!.termsExplicit = evidence(false); assert.equal(check(data, 'temporary_terms_explicit').outcome, 'issue');
});

test('#20 annual four-month and half-year two-month promises do not imply completed disclosure', () => {
  const data = input(); assert.equal(check(data, 'annual_disclosure').outcome, 'pass');
  data.continuingDisclosure!.promisedInterimBy = evidence('2026-08-31'); assert.equal(check(data, 'interim_disclosure').outcome, 'pass');
  data.continuingDisclosure!.promisedAnnualBy = evidence('2026-05-01'); assert.equal(check(data, 'annual_disclosure').outcome, 'issue');
  data.continuingDisclosure!.promisedInterimBy = evidence('2026-09-01'); assert.equal(check(data, 'interim_disclosure').outcome, 'issue');
  data.continuingDisclosure!.annualAudited = evidence(false); assert.equal(check(data, 'annual_audited').outcome, 'issue');
});

test('#20 other scopes and dates cannot borrow this research baseline', () => {
  for (const [market, offering] of [['sse', 'public'], ['szse', 'private'], ['nafmii', 'dfi']]) {
    assert.ok(evaluate(pack, { ...input(), market: market!, offering: offering! }).findings.every(row => row.outcome === 'not_applicable'));
  }
  assert.ok(evaluate(pack, { ...input(), asOf: evidence('2025-09-26') }).findings.every(row => row.outcome === 'needs_judgement'));
  assert.ok(evaluate(pack, { ...input(), asOf: evidence('2026-02-30') }).findings.every(row => row.outcome === 'needs_evidence'));
});
