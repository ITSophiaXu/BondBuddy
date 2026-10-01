import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Value } from '@sinclair/typebox/value';
import {
  generationIssuerBindingSchemas,
  nextGenerationIssuerBindingStatus,
  validGenerationIssuerBindingApproval,
  type GenerationIssuerBindingResponse,
} from './generation-issuer-binding.js';

const fixture = JSON.parse(readFileSync(new URL('../examples/generation-issuer-binding.json', import.meta.url), 'utf8')) as {
  synthetic: boolean;
  binding: GenerationIssuerBindingResponse;
};
assert.equal(fixture.synthetic, true);
const base = fixture.binding;
const clone = (): GenerationIssuerBindingResponse => structuredClone(base);
const expectedInput = { owner_user_id: base.owner_user_id, project_id: base.project_id, input_revision: base.input_revision, input_hash: base.input_hash };
const approves = (value: GenerationIssuerBindingResponse, expectedMaterials = base.selected_materials) =>
  validGenerationIssuerBindingApproval(value, expectedInput, expectedMaterials);

test('same legal issuer may compile consolidated and parent statements; accounting scopes remain separate', () => {
  assert.equal(approves(base), true);
  const compilerScopes = base.material_decisions.flatMap(item => item.observations)
    .filter(item => item.subject_relation === 'issuer_compiler')
    .map(item => item.accounting_scope);
  assert.deepEqual(compilerScopes, ['consolidated', 'parent', 'not_applicable']);
});

test('subsidiaries cited in issuer notes are localized and excluded without an issuer verification review', () => {
  const subsidiary = base.material_decisions[2]!.observations[1]!;
  assert.equal(subsidiary.subject_relation, 'component_subsidiary');
  assert.equal(subsidiary.source_identity_review_id, null);
  assert.equal(subsidiary.verified_entity_id, null);
  assert.equal(approves(base), true);
});

test('a subsidiary-only report cannot determine the legal issuer', () => {
  const candidate = clone();
  for (const decision of candidate.material_decisions) {
    for (const item of decision.observations) {
      if (item.subject_relation === 'issuer_compiler') {
        item.subject_relation = 'component_subsidiary';
        item.source_identity_review_id = null;
        item.source_identity_review_sha256 = null;
        item.source_identity_review_decision = null;
        item.verified_entity_id = null;
      }
    }
  }
  candidate.issuer_entity_id = null;
  assert.equal(approves(candidate), false);
});

test('same display name with distinct verified legal entity IDs is a conflict, never majority-resolved', () => {
  const candidate = clone();
  const parent = candidate.material_decisions[1]!.observations[0]!;
  parent.verified_entity_id = 'uscc:91110000MA0000001Y';
  assert.equal(parent.observed_subject_label, '甲发行人有限公司');
  assert.equal(approves(candidate), false);
});

test('every selected issuer-role material needs exactly one explicit disposition', () => {
  const candidate = clone();
  candidate.material_decisions.pop();
  assert.equal(approves(candidate), false);
  const duplicate = clone();
  duplicate.material_decisions.push(structuredClone(duplicate.material_decisions[0]!));
  assert.equal(approves(duplicate), false);
});

test('missing subject or unresolved OCR/parser doubt stays pending', () => {
  const candidate = clone();
  candidate.material_decisions[0]!.disposition = 'pending';
  candidate.material_decisions[0]!.observations = [];
  candidate.status = 'pending';
  candidate.issuer_entity_id = null;
  candidate.review_events = [];
  assert.equal(approves(candidate), false);

  const uncertain = clone();
  uncertain.selected_materials[2]!.identity_coverage = 'incomplete';
  uncertain.selected_materials[2]!.identity_uncertainties = [
    { code: 'OCR_SUBJECT_UNCERTAIN', source_record_id: 'record-notes-issuer', source_record_sha256: '7777777777777777777777777777777777777777777777777777777777777777', locator: { type: 'page', value: { page: 86 } }, reason: 'OCR可能改变主体名称。' },
    { code: 'EXTERNAL_LINK_UNRESOLVED', source_record_id: 'record-notes-issuer', source_record_sha256: '7777777777777777777777777777777777777777777777777777777777777777', locator: { type: 'paragraph', value: { paragraph: 86 } }, reason: '外链内容可能改变主体描述。' },
  ];
  assert.equal(approves(uncertain), false);

  const amountWarning = clone();
  amountWarning.selected_materials[0]!.parse_warning_codes = ['FORMULA_CACHE_MISSING'];
  amountWarning.selected_materials[0]!.parse_coverage = 'incomplete';
  assert.equal(approves(amountWarning, amountWarning.selected_materials), true, 'unrelated amount/formula warnings remain visible but do not block identity binding');
});

test('a new material or parse pin cannot reuse observations from an old snapshot', () => {
  const changedMaterial = clone();
  changedMaterial.selected_materials[0]!.material_sha256 = 'abababababababababababababababababababababababababababababababab';
  assert.equal(approves(changedMaterial), false);

  const reparsed = clone();
  reparsed.selected_materials[0]!.parse_snapshot_id = 'parse-audit-replaced';
  assert.equal(approves(reparsed), false);
});

test('withdrawal blocks reuse and cannot be reversed on the same binding version', () => {
  const withdrawn = clone();
  withdrawn.status = 'withdrawn';
  withdrawn.review_events.push({
    review_id: 'binding-withdrawal-1', action: 'withdraw', reason: '材料撤回后需重新审核。',
    reviewer_user_id: 'reviewer-synthetic', reviewer_grant_id: 'grant-synthetic', authority: 'issuer_identity_reviewer',
    binding_version: withdrawn.version, binding_content_sha256: withdrawn.content_sha256, reviewed_at: '2026-09-28T03:00:00Z',
  });
  assert.equal(approves(withdrawn), false);
  assert.equal(nextGenerationIssuerBindingStatus('approved', 'withdraw'), 'withdrawn');
  assert.equal(nextGenerationIssuerBindingStatus('withdrawn', 'approve'), null);
  assert.equal(nextGenerationIssuerBindingStatus('pending', 'request_more_evidence'), 'pending');

  const requestedEvidence = clone();
  requestedEvidence.review_events.push({
    review_id: 'binding-more-evidence-1', action: 'request_more_evidence', reason: '主体锚点需人工复核。',
    reviewer_user_id: 'reviewer-synthetic', reviewer_grant_id: 'grant-synthetic', authority: 'issuer_identity_reviewer',
    binding_version: requestedEvidence.version, binding_content_sha256: requestedEvidence.content_sha256, reviewed_at: '2026-09-28T03:00:00Z',
  });
  assert.equal(approves(requestedEvidence), false);
});

test('approval checks the whole same-version review history, not only its last event', () => {
  const withdrawThenApprove = clone();
  withdrawThenApprove.review_events.push({
    ...structuredClone(base.review_events[0]!), review_id: 'withdraw-synthetic', action: 'withdraw',
    reviewed_at: '2026-09-28T03:00:00Z',
  });
  withdrawThenApprove.review_events.push({
    ...structuredClone(base.review_events[0]!), review_id: 'reapprove-synthetic',
    reviewed_at: '2026-09-28T04:00:00Z',
  });
  assert.equal(Value.Check(generationIssuerBindingSchemas.GenerationIssuerBindingResponse, withdrawThenApprove), true);
  assert.equal(approves(withdrawThenApprove), false, 'withdrawn is terminal for this binding version');

  const duplicateApproval = clone();
  duplicateApproval.review_events.push({
    ...structuredClone(base.review_events[0]!), review_id: 'duplicate-approve-synthetic',
    reviewed_at: '2026-09-28T03:00:00Z',
  });
  assert.equal(Value.Check(generationIssuerBindingSchemas.GenerationIssuerBindingResponse, duplicateApproval), true);
  assert.equal(approves(duplicateApproval), false);

  const requestedThenApproved = clone();
  requestedThenApproved.review_events = [
    { ...structuredClone(base.review_events[0]!), review_id: 'request-more-synthetic', action: 'request_more_evidence', reviewed_at: '2026-09-28T01:00:00Z' },
    structuredClone(base.review_events[0]!),
  ];
  assert.equal(Value.Check(generationIssuerBindingSchemas.GenerationIssuerBindingResponse, requestedThenApproved), true);
  assert.equal(approves(requestedThenApproved), true, 'pending may request evidence before approval');
});

test('the authoritative selected input manifest detects omitted materials even if the snapshot omits them too', () => {
  const omittedFromSnapshot = clone();
  omittedFromSnapshot.selected_materials.pop();
  omittedFromSnapshot.material_decisions.pop();
  assert.equal(approves(omittedFromSnapshot), false);

  const inputGrew = clone();
  const extra = structuredClone(inputGrew.selected_materials[0]!);
  extra.material_id = 'selected-financial-not-in-binding';
  inputGrew.selected_materials.push(extra);
  assert.equal(approves(inputGrew, inputGrew.selected_materials), false);
  assert.equal(approves(clone(), [...base.selected_materials, extra]), false);
});

test('owner/project/input revision/hash must match the authoritative server input ref', () => {
  const changedInput = clone();
  changedInput.input_hash = 'abababababababababababababababababababababababababababababababab';
  assert.equal(approves(changedInput), false);
  changedInput.input_hash = base.input_hash;
  changedInput.project_id = 'another-project';
  assert.equal(approves(changedInput), false);
});
