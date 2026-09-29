import { Ajv } from 'ajv';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isMarketOffering, M1_MATERIAL_PARTITIONS, M1_UPLOAD_MATERIAL_ROLES, M1_UPLOAD_MIME_TYPES, openApiDocument, platformProcessingCostSchemas, referenceLibrarySchemas, schemas, userReferenceParseReviewAccepted, validUserReferenceOutline, validTargetPeriodEvidenceDecision, targetPeriodCandidateSchemas, validTargetPeriodCandidateSnapshot, canonicalTargetPeriodCandidateSnapshotContent, projectMessageSetSchemas, validProjectMessageSetPin, validProjectMessageSetRef, canonicalProjectMessageSetContent, projectMessageSetRef, projectMessageSetRefMatches, validProductionReviewManifestContent, validProductionReviewAttestationBinding, validGenerationIssuerBindingApproval, type SchemaName, type TargetPeriodEvidenceDecisionRequest, type TargetPeriodCandidateSnapshot, type ProjectMessageSetPin, type ProjectMessageSetRef, type ProductionReviewManifest, type ProductionReviewAttestationRequest, type GenerationIssuerBindingResponse } from './index.js';

type Example = { name: string; schema: SchemaName; valid: boolean; http_status?: number; value: Record<string, unknown> };
const file = fileURLToPath(new URL('../examples/synthetic.json', import.meta.url));
const data = JSON.parse(readFileSync(file, 'utf8')) as { synthetic: boolean; cases: Example[] };
const updateExamples = JSON.parse(readFileSync(fileURLToPath(new URL('../examples/update-project.json', import.meta.url)), 'utf8')) as { synthetic: boolean; cases: Example[] };
assert.equal(updateExamples.synthetic, true);
data.cases.push(...updateExamples.cases);
const targetPeriodEvidenceExamples = JSON.parse(readFileSync(fileURLToPath(new URL('../examples/target-period-evidence.json', import.meta.url)), 'utf8')) as { synthetic:boolean;cases:Example[] };
assert.equal(targetPeriodEvidenceExamples.synthetic,true);
data.cases.push(...targetPeriodEvidenceExamples.cases);
const productionReviewManifestExamples = JSON.parse(readFileSync(fileURLToPath(new URL('../examples/production-review-manifest.json', import.meta.url)), 'utf8')) as { synthetic:boolean;cases:Example[] };
assert.equal(productionReviewManifestExamples.synthetic,true);
data.cases.push(...productionReviewManifestExamples.cases);
const productionReviewAttestationExamples = JSON.parse(readFileSync(fileURLToPath(new URL('../examples/production-review-attestation.json', import.meta.url)), 'utf8')) as { synthetic: boolean; cases: Example[] };
assert.equal(productionReviewAttestationExamples.synthetic, true);
data.cases.push(...productionReviewAttestationExamples.cases);
const adminExamples = JSON.parse(readFileSync(fileURLToPath(new URL('../examples/admin-logs.json', import.meta.url)), 'utf8')) as { synthetic: boolean; cases: Example[] };
assert.equal(adminExamples.synthetic, true);
data.cases.push(...adminExamples.cases);
// #17 worker runtime stream examples.
const runtimeExamples = JSON.parse(readFileSync(fileURLToPath(new URL('../examples/worker-runtime.json', import.meta.url)), 'utf8')) as { synthetic: boolean; cases: Example[] };
assert.equal(runtimeExamples.synthetic, true);
data.cases.push(...runtimeExamples.cases);
// #35 trial guard examples.
const trialExamples = JSON.parse(readFileSync(fileURLToPath(new URL('../examples/trial-guard.json', import.meta.url)), 'utf8')) as { synthetic: boolean; cases: Example[] };
assert.equal(trialExamples.synthetic, true);
data.cases.push(...trialExamples.cases);
// #7 registration agreement examples.
const agreementExamples = JSON.parse(readFileSync(fileURLToPath(new URL('../examples/agreement.json', import.meta.url)), 'utf8')) as { synthetic: boolean; cases: Example[] };
assert.equal(agreementExamples.synthetic, true);
data.cases.push(...agreementExamples.cases);
const projectExamples = JSON.parse(readFileSync(fileURLToPath(new URL('../examples/project-list.json', import.meta.url)), 'utf8')) as { synthetic: boolean; cases: Example[] };
assert.equal(projectExamples.synthetic, true);
data.cases.push(...projectExamples.cases);
const recoveryExamples = JSON.parse(readFileSync(fileURLToPath(new URL('../examples/account-recovery.json', import.meta.url)), 'utf8')) as { synthetic: boolean; cases: Example[] };
assert.equal(recoveryExamples.synthetic,true); data.cases.push(...recoveryExamples.cases);
const issuerReviewExamples = JSON.parse(readFileSync(fileURLToPath(new URL('../examples/issuer-identity-review.json', import.meta.url)), 'utf8')) as { synthetic: boolean; cases: Example[] };
assert.equal(issuerReviewExamples.synthetic,true); data.cases.push(...issuerReviewExamples.cases);
const issuerAnnualReviewExamples = JSON.parse(readFileSync(fileURLToPath(new URL('../examples/issuer-annual-profile-review.json', import.meta.url)), 'utf8')) as { synthetic: boolean; cases: Example[] };
assert.equal(issuerAnnualReviewExamples.synthetic,true); data.cases.push(...issuerAnnualReviewExamples.cases);
const factEvidenceContextExamples = JSON.parse(readFileSync(fileURLToPath(new URL('../examples/fact-evidence-context.json', import.meta.url)), 'utf8')) as { synthetic: boolean; cases: Example[] };
assert.equal(factEvidenceContextExamples.synthetic,true); data.cases.push(...factEvidenceContextExamples.cases);
const factEvidenceReviewerReadExamples = JSON.parse(readFileSync(fileURLToPath(new URL('../examples/fact-evidence-reviewer-read.json', import.meta.url)), 'utf8')) as { synthetic: boolean; cases: Example[] };
assert.equal(factEvidenceReviewerReadExamples.synthetic,true); data.cases.push(...factEvidenceReviewerReadExamples.cases);
const generationIssuerBindingExample = JSON.parse(readFileSync(fileURLToPath(new URL('../examples/generation-issuer-binding.json', import.meta.url)), 'utf8')) as { synthetic: boolean; binding: GenerationIssuerBindingResponse };
assert.equal(generationIssuerBindingExample.synthetic,true);
data.cases.push({ name: 'generation-issuer-binding-approved-synthetic', schema: 'GenerationIssuerBindingResponse', valid: true, value: generationIssuerBindingExample.binding as unknown as Record<string, unknown> });
assert.equal(validGenerationIssuerBindingApproval(generationIssuerBindingExample.binding, {
  owner_user_id: generationIssuerBindingExample.binding.owner_user_id,
  project_id: generationIssuerBindingExample.binding.project_id,
  input_revision: generationIssuerBindingExample.binding.input_revision,
  input_hash: generationIssuerBindingExample.binding.input_hash,
}, generationIssuerBindingExample.binding.selected_materials), true, 'complete synthetic binding: same issuer across consolidated/parent statements; subsidiary localized in notes');
assert.ok(!Object.keys(openApiDocument().paths).some(path => path.includes('generation-issuer-binding')), 'contract slice adds no production route');
const userReferenceReview = JSON.parse(readFileSync(fileURLToPath(new URL('../examples/user-reference-review.json', import.meta.url)), 'utf8')) as {
  synthetic: boolean; snapshot: Parameters<typeof userReferenceParseReviewAccepted>[0];
  review: { confirmed_warning_codes: string[]; outline: unknown; signed_outline_sha256: string };
};
assert.equal(userReferenceReview.synthetic,true);
assert.ok(validUserReferenceOutline(userReferenceReview.review.outline));
assert.match(userReferenceReview.review.signed_outline_sha256,/^[a-f0-9]{64}$/);
assert.equal(userReferenceParseReviewAccepted(userReferenceReview.snapshot,userReferenceReview.review.confirmed_warning_codes),true);
assert.equal(data.synthetic, true);
// #78 internal library query v1: validated here, and proven absent from the public OpenAPI document.
const libraryExamples = JSON.parse(readFileSync(fileURLToPath(new URL('../examples/reference-library.json', import.meta.url)), 'utf8')) as { synthetic: boolean; cases: Array<{ name: string; schema: keyof typeof referenceLibrarySchemas; valid: boolean; value: unknown }> };
assert.equal(libraryExamples.synthetic, true);
{
  const libraryAjv = new Ajv({ allErrors: true, strict: true });
  for (const example of libraryExamples.cases) {
    const validate = libraryAjv.compile(referenceLibrarySchemas[example.schema]);
    assert.equal(validate(example.value), example.valid, `${example.name}: ${libraryAjv.errorsText(validate.errors)}`);
  }
  const publicDocument = JSON.stringify(openApiDocument());
  for (const name of Object.keys(referenceLibrarySchemas)) assert.ok(!publicDocument.includes(name), `internal ${name} leaked into public OpenAPI`);
  assert.ok(!publicDocument.includes('/admin/library'), 'admin library routes are not public contract');
  assert.ok(!Object.keys(schemas).some(name => name.startsWith('Library')), 'library schemas are not public schemas');
}
const ajv = new Ajv({ allErrors: true, strict: true });
// Internal #76 platform-paid OCR/parse processing contract is validated separately and
// stays out of the public OpenAPI/schema namespace.
const processingCostExamples = JSON.parse(readFileSync(fileURLToPath(new URL('../examples/platform-processing-cost.json', import.meta.url)), 'utf8')) as { synthetic: boolean; cases: Example[] };
assert.equal(processingCostExamples.synthetic, true);
for (const example of processingCostExamples.cases) {
  const validate = ajv.compile(platformProcessingCostSchemas[example.schema as keyof typeof platformProcessingCostSchemas]);
  assert.equal(validate(example.value), example.valid, `${example.name}: ${ajv.errorsText(validate.errors)}`);
}
assert.ok(!JSON.stringify(openApiDocument()).includes('PlatformProcessingCost'), 'internal processing cost schemas are not public OpenAPI');
const targetPeriodCandidateExamples = JSON.parse(readFileSync(fileURLToPath(new URL('../examples/target-period-candidate-snapshot.json', import.meta.url)), 'utf8')) as {
  synthetic: boolean; cases: Array<{ name: string; valid: boolean; value: unknown }>;
};
assert.equal(targetPeriodCandidateExamples.synthetic, true);
const candidateAjv = new Ajv({ allErrors: true, strict: true });
const candidateBaseline = targetPeriodCandidateExamples.cases.find(example => example.name === 'target-period-candidate-snapshot-valid-synthetic');
assert.ok(candidateBaseline, 'synthetic candidate snapshot exists');
for (const example of targetPeriodCandidateExamples.cases) {
  const schemaValid = candidateAjv.validate(targetPeriodCandidateSchemas.TargetPeriodCandidateSnapshot, example.value);
  const semanticValid = schemaValid && validTargetPeriodCandidateSnapshot(example.value);
  assert.equal(semanticValid, example.valid, `${example.name}: ${candidateAjv.errorsText(candidateAjv.errors)}`);
}
const candidateManifest = candidateBaseline.value as TargetPeriodCandidateSnapshot;
assert.equal(candidateManifest.content_sha256,
  createHash('sha256').update(canonicalTargetPeriodCandidateSnapshotContent(candidateManifest), 'utf8').digest('hex'),
  'candidate fixture content hash matches the declared canonical content');
const emptyCandidateSet = structuredClone(candidateManifest);
emptyCandidateSet.content.candidates = [];
emptyCandidateSet.content.pending_reasons = ['no_evidenced_reporting_period_candidates'];
emptyCandidateSet.content_sha256 = createHash('sha256').update(canonicalTargetPeriodCandidateSnapshotContent(emptyCandidateSet), 'utf8').digest('hex');
assert.equal(validTargetPeriodCandidateSnapshot(emptyCandidateSet), true, 'an empty candidate set is explicit and pending, never inferred from cutoff');
const staleMaterialCandidate = structuredClone(candidateManifest);
staleMaterialCandidate.content.source_snapshots[0]!.material_sha256 = '0'.repeat(64);
assert.equal(validTargetPeriodCandidateSnapshot(staleMaterialCandidate), false, 'source parse pin must match exact locked material bytes');
const nonFinancialMaterialRole = structuredClone(candidateManifest);
nonFinancialMaterialRole.content.financial_materials[0]!.role = 'historical' as any;
assert.equal(candidateAjv.validate(targetPeriodCandidateSchemas.TargetPeriodCandidateSnapshot, nonFinancialMaterialRole), false, 'candidate snapshot accepts only canonical financial material roles');
const wrongCutoffRelation = structuredClone(candidateManifest);
wrongCutoffRelation.content.candidates[0]!.cutoff_relation = 'after';
assert.equal(validTargetPeriodCandidateSnapshot(wrongCutoffRelation), false, 'known period end cutoff relation must be computed from end and reporting cutoff');
const unknownEndCandidate = structuredClone(candidateManifest);
unknownEndCandidate.content.candidates[0]!.end = null;
unknownEndCandidate.content.candidates[0]!.cutoff_relation = 'unknown';
unknownEndCandidate.content.candidates[0]!.anchors = unknownEndCandidate.content.candidates[0]!.anchors.filter(anchor => anchor.kind !== 'period_end');
assert.equal(validTargetPeriodCandidateSnapshot(unknownEndCandidate), true, 'an unknown period end has unknown cutoff relation');
unknownEndCandidate.content.candidates[0]!.cutoff_relation = 'on_or_before';
assert.equal(validTargetPeriodCandidateSnapshot(unknownEndCandidate), false, 'an unknown period end cannot claim a computed cutoff relation');
const wrongQuarterAnchor = structuredClone(candidateManifest);
wrongQuarterAnchor.content.evidence_records[0]!.quote = '2024年一季度';
assert.equal(validTargetPeriodCandidateSnapshot(wrongQuarterAnchor), false, 'same-year wrong-quarter text cannot anchor the proposed period end');
const borrowedPeriodTokenAnchor = structuredClone(candidateManifest);
borrowedPeriodTokenAnchor.content.candidates[0]!.raw_value = '2024年度；2025年一季度';
borrowedPeriodTokenAnchor.content.candidates[0]!.anchors.find(anchor => anchor.kind === 'period_end')!.raw_period_token = '2025年一季度';
assert.equal(validTargetPeriodCandidateSnapshot(borrowedPeriodTokenAnchor), false, 'period-end token must occur in the exact record cited by that anchor, not merely in merged candidate tokens');
const recognizedCandidate = structuredClone(candidateManifest) as any;
recognizedCandidate.content.candidates[0].status = 'recognized';
assert.equal(candidateAjv.validate(targetPeriodCandidateSchemas.TargetPeriodCandidateSnapshot, recognizedCandidate), false, 'candidate contract has no recognized/confirmed status');
const pollutedTargetIntent = structuredClone(candidateManifest) as any;
pollutedTargetIntent.content.target_reporting_periods = [];
assert.equal(candidateAjv.validate(targetPeriodCandidateSchemas.TargetPeriodCandidateSnapshot, pollutedTargetIntent), false, 'candidate snapshot cannot replace user target intent');
assert.ok(!JSON.stringify(openApiDocument()).includes('TargetPeriodCandidateSnapshot'), 'pre-lock candidate handoff is not an HTTP endpoint contract yet');
// #76 active project-message set pin: additive public contract, no HTTP DTO.
const messageSetExamples = JSON.parse(readFileSync(fileURLToPath(new URL('../examples/project-message-set-pin.json', import.meta.url)), 'utf8')) as {
  synthetic: boolean;
  cases: Array<{ name: string; schema: keyof typeof projectMessageSetSchemas; valid: boolean; value: unknown }>;
  matches: Array<{ name: string; expected: ProjectMessageSetPin; ref: ProjectMessageSetRef; match: boolean }>;
};
assert.equal(messageSetExamples.synthetic, true);
{
  const messageSetAjv = new Ajv({ allErrors: true, strict: true });
  for (const example of messageSetExamples.cases) {
    const schemaValid = messageSetAjv.validate(projectMessageSetSchemas[example.schema], example.value);
    const semanticValid = example.schema === 'ProjectMessageSetPin'
      ? schemaValid && validProjectMessageSetPin(example.value)
      : schemaValid && validProjectMessageSetRef(example.value);
    assert.equal(semanticValid, example.valid, `${example.name}: ${messageSetAjv.errorsText(messageSetAjv.errors)}`);
  }
  const pinBaseline = messageSetExamples.cases.find(example => example.name === 'project-message-set-pin-conversation-order-valid');
  assert.ok(pinBaseline, 'synthetic message-set pin baseline exists');
  const pin = pinBaseline.value as ProjectMessageSetPin;
  assert.equal(pin.content_sha256, createHash('sha256').update(canonicalProjectMessageSetContent(pin), 'utf8').digest('hex'),
    'pin fixture content hash matches the declared domain-separated canonical members');
  const emptyPin = messageSetExamples.cases.find(example => example.name === 'project-message-set-pin-empty-valid')!.value as ProjectMessageSetPin;
  assert.equal(emptyPin.content_sha256, createHash('sha256').update(canonicalProjectMessageSetContent(emptyPin), 'utf8').digest('hex'),
    'an empty active set still has an explicit deterministic hash');
  assert.notEqual(emptyPin.content_sha256, pin.content_sha256, 'empty and nonempty set identities stay distinct');
  const reordered = structuredClone(pin);
  reordered.members = [...reordered.members].reverse();
  assert.notEqual(canonicalProjectMessageSetContent(reordered), canonicalProjectMessageSetContent(pin),
    'conversation order is part of the hash; lexicographic message-id order is not');
  const edited = structuredClone(pin);
  edited.members[0]!.message_version = 3;
  edited.members[0]!.content_sha256 = 'e'.repeat(64);
  assert.notEqual(createHash('sha256').update(canonicalProjectMessageSetContent(edited), 'utf8').digest('hex'), pin.content_sha256,
    'a saved edit produces a different set hash');
  assert.equal(edited.version, pin.version, 'a saved edit keeps the first-submission set version');
  assert.deepEqual(projectMessageSetRef(pin), { version: pin.version, content_sha256: pin.content_sha256, message_ids: ['message-a', 'message-b'] },
    'the aggregate ref projects strictly sorted message IDs');
  const bareVersion = { version: pin.version } as unknown as ProjectMessageSetRef;
  assert.equal(projectMessageSetRefMatches(pin, bareVersion), false, 'a bare version is never a set identity');
  for (const entry of messageSetExamples.matches) {
    assert.equal(projectMessageSetRefMatches(entry.expected, entry.ref), entry.match, entry.name);
  }
  const publicDocument = JSON.stringify(openApiDocument());
  for (const name of Object.keys(projectMessageSetSchemas)) {
    assert.ok(!publicDocument.includes(name), `internal ${name} leaked into public OpenAPI`);
    assert.ok(!Object.keys(schemas).some(key => key.startsWith('ProjectMessageSet')), `${name} is not a public HTTP schema`);
  }
}
const byName = new Map<string, Example>();
for (const example of data.cases) {
  assert.ok(!byName.has(example.name), `duplicate example ${example.name}`);
  byName.set(example.name, example);
  assert.ok(Object.hasOwn(schemas, example.schema), `unknown schema ${example.schema}`);
  const validate = ajv.compile(schemas[example.schema]);
  const schemaValid = validate(example.value);
  const result=example.schema==='TargetPeriodEvidenceDecisionRequest'&&schemaValid
    ?validTargetPeriodEvidenceDecision(example.value as unknown as TargetPeriodEvidenceDecisionRequest)
    :example.schema==='ProductionReviewManifest'&&schemaValid
      ?validProductionReviewManifestContent(example.value as unknown as ProductionReviewManifest):schemaValid;
  assert.equal(result, example.valid, `${example.name}: ${ajv.errorsText(validate.errors)}`);
}
const manifestBaseline = byName.get('production-review-manifest-content-only-valid-synthetic');
assert.ok(manifestBaseline, 'synthetic production manifest baseline exists');
const unsortedManifest = structuredClone(manifestBaseline.value) as unknown as ProductionReviewManifest;
unsortedManifest.content.source_date_evidence.reverse();
assert.equal(ajv.validate(schemas.ProductionReviewManifest, unsortedManifest), true, 'schema accepts source row order');
assert.equal(validProductionReviewManifestContent(unsortedManifest), false, 'hash input rejects noncanonical source row order');
const duplicatedManifest = structuredClone(manifestBaseline.value) as unknown as ProductionReviewManifest;
const duplicateCodes = duplicatedManifest.content.applicability_scope.industry_codes;
if (duplicateCodes.mode === 'explicit_codes') duplicateCodes.codes.push(duplicateCodes.codes[0]!);
assert.equal(validProductionReviewManifestContent(duplicatedManifest), false, 'hash input rejects duplicate set-like references');
const undatedBindingRule = structuredClone(manifestBaseline.value) as unknown as ProductionReviewManifest;
undatedBindingRule.content.source_date_evidence[0]!.legal_effective_date = null;
undatedBindingRule.content.source_date_evidence[0]!.legal_effective_date_basis = 'unknown';
undatedBindingRule.content.source_date_evidence[0]!.effective_date_derivation_evidence = [];
assert.equal(validProductionReviewManifestContent(undatedBindingRule), false, 'reviewed applicability basis cannot make an undated binding rule approvable');
const undatedGuidance = structuredClone(undatedBindingRule);
undatedGuidance.content.source_date_evidence[0]!.source_kind = 'interpretive_guidance';
assert.equal(validProductionReviewManifestContent(undatedGuidance), true, 'undated guidance may carry a reviewed applicability basis without inventing legal effectivity');
const noDateNoBasis = structuredClone(undatedBindingRule) as any;
delete noDateNoBasis.content.source_date_evidence[0].applicability_basis;
assert.equal(validProductionReviewManifestContent(noDateNoBasis), false, 'undated source without an applicability basis is rejected');
const scopeBasisDrift = structuredClone(manifestBaseline.value) as unknown as ProductionReviewManifest;
scopeBasisDrift.content.source_date_evidence[0]!.applicability_basis.applicability_scope.instruments = ['scp'];
assert.equal(validProductionReviewManifestContent(scopeBasisDrift), false, 'source basis must pin the exact manifest scope');
const emptyUnknownDimension = structuredClone(manifestBaseline.value) as any;
emptyUnknownDimension.content.applicability_scope.industry_codes = { mode: 'explicit_codes', codes: [], dictionary_version: 'industry-v1' };
assert.equal(ajv.validate(schemas.ProductionReviewManifest, emptyUnknownDimension), false, 'empty explicit codes cannot encode unknown or unrestricted');
const inventedAllCode = structuredClone(manifestBaseline.value) as unknown as ProductionReviewManifest;
inventedAllCode.content.applicability_scope.industry_codes = { mode: 'explicit_codes', codes: ['all'], dictionary_version: 'industry-v1' };
assert.equal(validProductionReviewManifestContent(inventedAllCode), false, 'invented all code cannot encode reviewed unrestricted');
const genericFeatureRule = (manifestBaseline.value as unknown as ProductionReviewManifest).content.applicability_scope.special_feature_scope;
assert.equal(genericFeatureRule.mode, 'reviewed_unrestricted', 'generic rule-level feature scope is an explicit no-extra-restriction review');
assert.equal(Object.hasOwn(genericFeatureRule, 'project_verified_absence'), false, 'rule scope does not assert project feature absence');
// Current withdrawal is a selector/runtime gate; a content-only helper cannot prove it.
const technicalSubmission = byName.get('production-attestation-technical-self-submission-valid-synthetic');
assert.ok(technicalSubmission, 'synthetic technical self-submission exists');
const spoofedRoleSubmission = { ...structuredClone(technicalSubmission.value), reviewer_role: 'industry' };
assert.equal(ajv.validate(schemas.ProductionTechnicalAttestationRequest, spoofedRoleSubmission), false, 'request cannot assert its reviewer role');
assert.equal(ajv.validate(schemas.ProductionReviewAttestationRequest, spoofedRoleSubmission), false, 'generic request cannot assert its reviewer role');
const industrySubmission = byName.get('production-attestation-industry-self-submission-valid-synthetic');
assert.ok(industrySubmission, 'synthetic industry self-submission exists');
const pinnedManifest = manifestBaseline.value as unknown as ProductionReviewManifest;
const industryRequest = industrySubmission.value as unknown as ProductionReviewAttestationRequest;
assert.equal(validProductionReviewAttestationBinding(industryRequest, emptyUnknownDimension), false, 'industry approve cannot bind a manifest with unknown applicability');
const pendingDimensionManifest = structuredClone(pinnedManifest);
pendingDimensionManifest.content.applicability_scope.industry_codes = {
  mode: 'needs_review', reason_code: 'industry_mapping_pending', reason: 'Synthetic pending evidence review.',
};
for (const source of pendingDimensionManifest.content.source_date_evidence) {
  source.applicability_basis.applicability_scope = structuredClone(pendingDimensionManifest.content.applicability_scope);
}
assert.equal(ajv.validate(schemas.ProductionReviewManifest, pendingDimensionManifest), true, 'pending dimension is representable in a content snapshot');
assert.equal(validProductionReviewManifestContent(pendingDimensionManifest), true, 'needs_review is a valid pending state, not an unrestricted state');
const pendingDimensionRequest = structuredClone(industryRequest);
pendingDimensionRequest.decision = 'request_more_evidence';
assert.equal(validProductionReviewAttestationBinding(pendingDimensionRequest, pendingDimensionManifest), true, 'pending dimension may be retained while requesting more evidence');
assert.equal(validProductionReviewAttestationBinding(industryRequest, pendingDimensionManifest), false, 'industry approve is forbidden while any applicability dimension needs review');
assert.equal(ajv.validate(schemas.ProductionIndustryAttestationRequest, industryRequest), true, 'semantic baseline is schema-valid');
assert.equal(validProductionReviewAttestationBinding(industryRequest, pinnedManifest), true, 'industry approval binds complete synthetic manifest');
const pendingMethodManifest = structuredClone(pinnedManifest);
const internalMethod = pendingMethodManifest.content.source_date_evidence.find(source => source.source_kind === 'internal_method');
assert.ok(internalMethod, 'synthetic baseline includes an internal method with an approved window');
internalMethod.approved_method_window = null;
assert.equal(validProductionReviewManifestContent(pendingMethodManifest), true, 'unapproved method may remain in a pending manifest');
const pendingMethodRequest = structuredClone(industryRequest);
pendingMethodRequest.decision = 'request_more_evidence';
assert.equal(validProductionReviewAttestationBinding(pendingMethodRequest, pendingMethodManifest), true, 'missing method approval may request more evidence');
assert.equal(validProductionReviewAttestationBinding(industryRequest, pendingMethodManifest), false, 'industry approval rejects a missing internal-method approval window');
const missingPolarityManifest = structuredClone(pinnedManifest);
missingPolarityManifest.content.authorized_real_sample_evidence = missingPolarityManifest.content.authorized_real_sample_evidence
  .filter(sample => sample.polarity === 'positive');
// This pure contract check deliberately does not recompute the changed content hash;
// the registry hash check is a separate mandatory writer precondition.
assert.equal(validProductionReviewManifestContent(missingPolarityManifest), true, 'an incomplete polarity set may be stored as a pending review manifest');
const pendingSampleRequest = structuredClone(industryRequest);
pendingSampleRequest.decision = 'request_more_evidence';
pendingSampleRequest.content_sha256 = missingPolarityManifest.content_sha256;
const pendingSampleEvidence = pendingSampleRequest.evidence as { sample_conclusions: Array<{ sample_evidence_id: string }> };
pendingSampleEvidence.sample_conclusions = pendingSampleEvidence.sample_conclusions
  .filter(sample => sample.sample_evidence_id === missingPolarityManifest.content.authorized_real_sample_evidence[0]!.sample_evidence_id);
assert.equal(validProductionReviewAttestationBinding(pendingSampleRequest, missingPolarityManifest), true, 'incomplete sample polarities remain requestable, not approvable');
assert.equal(validProductionReviewAttestationBinding({ ...pendingSampleRequest, decision: 'approve' }, missingPolarityManifest), false, 'industry approve requires positive, negative and boundary sample evidence');
const duplicateSampleCase = structuredClone(pinnedManifest);
duplicateSampleCase.content.authorized_real_sample_evidence[1]!.sample_case_id = duplicateSampleCase.content.authorized_real_sample_evidence[0]!.sample_case_id;
assert.equal(validProductionReviewManifestContent(duplicateSampleCase), false, 'manifest sample case IDs must be unique');
const polarityDrift = structuredClone(pinnedManifest);
polarityDrift.content.authorized_real_sample_evidence[0]!.polarity = 'positive';
assert.equal(validProductionReviewAttestationBinding(industryRequest, polarityDrift), false, 'changing boundary to positive leaves the required category absent');
assert.equal(validProductionReviewAttestationBinding({ ...industryRequest, content_sha256: polarityDrift.content_sha256 }, polarityDrift), false, 'repinning cannot approve a manifest without a boundary sample');
const withIndustry = (change: (value: any) => void, decision = 'approve') => {
  const changed = structuredClone(industryRequest) as any;
  changed.decision = decision;
  change(changed);
  return changed as ProductionReviewAttestationRequest;
};
const assertBindingFalse = (name: string, request: ProductionReviewAttestationRequest) => {
  assert.equal(validProductionReviewAttestationBinding(request, pinnedManifest), false, name);
};
assertBindingFalse('manifest content hash pin drift rejected', { ...industryRequest, content_sha256: '0'.repeat(64) });
assertBindingFalse('manifest ID pin drift rejected', { ...industryRequest, manifest_id: 'other-manifest' });
assertBindingFalse('missing pinned source blocks approval', withIndustry(value => value.evidence.source_effectivity_applicability.pop()));
assertBindingFalse('invented source reference rejected', withIndustry(value => { value.evidence.source_effectivity_applicability[0].source_evidence_id = 'invented-source'; }));
assertBindingFalse('source check hash drift rejected', withIndustry(value => { value.evidence.source_effectivity_applicability[0].source_check_sha256 = '0'.repeat(64); }));
assertBindingFalse('duplicate source reference rejected', withIndustry(value => value.evidence.source_effectivity_applicability.push(structuredClone(value.evidence.source_effectivity_applicability[0]))));
assertBindingFalse('invented uncovered code rejected', withIndustry(value => { value.evidence.exceptions_and_uncovered[0].item_code = 'invented-item'; }));
assertBindingFalse('missing pinned uncovered item blocks approval', withIndustry(value => value.evidence.exceptions_and_uncovered.pop()));
assertBindingFalse('duplicate uncovered reference rejected', withIndustry(value => value.evidence.exceptions_and_uncovered.push(structuredClone(value.evidence.exceptions_and_uncovered[0]))));
assertBindingFalse('needs-evidence source cannot be approved', withIndustry(value => { value.evidence.source_effectivity_applicability[0].conclusion = 'needs_evidence'; }));
assertBindingFalse('not-applicable pinned source cannot be approved', withIndustry(value => { value.evidence.source_effectivity_applicability[0].conclusion = 'not_applicable'; }));
assertBindingFalse('needs-evidence item cannot be approved', withIndustry(value => { value.evidence.exceptions_and_uncovered[0].disposition = 'needs_evidence'; }));
assertBindingFalse('rejected sample cannot be approved', withIndustry(value => { value.evidence.sample_conclusions[0].conclusion = 'reject'; }));
assertBindingFalse('sample needing more evidence cannot be approved', withIndustry(value => { value.evidence.sample_conclusions[0].conclusion = 'request_more_evidence'; }));
assertBindingFalse('sample case drift rejected', withIndustry(value => { value.evidence.sample_conclusions[0].sample_case_id = 'invented-case'; }));
assertBindingFalse('sample evidence drift rejected', withIndustry(value => { value.evidence.sample_conclusions[0].sample_evidence_id = 'invented-sample'; }));
assertBindingFalse('duplicate sample reference rejected', withIndustry(value => value.evidence.sample_conclusions.push(structuredClone(value.evidence.sample_conclusions[0]))));
const collidingItemManifest = structuredClone(pinnedManifest);
collidingItemManifest.content.applicability_scope.exceptions.push({ code: 'special-products', description: 'Synthetic different-kind collision', evidence_ids: ['a-source-synthetic'] });
assert.equal(validProductionReviewAttestationBinding(industryRequest, collidingItemManifest), false, 'exception and uncovered sharing a code are still two required decisions');
const partialIndustry = withIndustry(value => value.evidence.source_effectivity_applicability.pop(), 'request_more_evidence');
assert.equal(ajv.validate(schemas.ProductionIndustryAttestationRequest, partialIndustry), true, 'partial follow-up remains schema-valid');
assert.equal(validProductionReviewAttestationBinding(partialIndustry, pinnedManifest), true, 'request-more-evidence may review a genuine subset');
const technicalRequest = byName.get('production-attestation-technical-self-submission-valid-synthetic')!.value as unknown as ProductionReviewAttestationRequest;
assert.equal(validProductionReviewAttestationBinding(technicalRequest, pinnedManifest), true, 'technical follow-up binds exact template and coverage hashes');
const driftedTechnical = structuredClone(technicalRequest) as any;
driftedTechnical.evidence.template_coverage_consistency.chapter_template_sha256 = '0'.repeat(64);
assertBindingFalse('template hash drift rejected', driftedTechnical);
const approvedTechnical = structuredClone(technicalRequest) as any;
approvedTechnical.decision = 'approve';
assertBindingFalse('technical approval requires consistent template/coverage', approvedTechnical);
const noExceptionSubmission = structuredClone(industrySubmission.value) as { evidence: { exceptions_and_uncovered: unknown[] } };
noExceptionSubmission.evidence.exceptions_and_uncovered = [];
assert.equal(ajv.validate(schemas.ProductionIndustryAttestationRequest, noExceptionSubmission), true, 'no exceptions or uncovered items needs no invented attestation row');
const value = (name: string) => {
  const example = byName.get(name);
  assert.ok(example, name);
  return example.value;
};
const valuePinnedContext = structuredClone(value('fact-evidence-context-value-pinned')) as Record<string, unknown>;
const valuePinnedManifest = valuePinnedContext.manifest as Record<string, unknown>;
const candidateValuePin = valuePinnedManifest.candidate_value as Record<string, unknown>;
assert.equal(candidateValuePin.value_decimal, '1200.5');
assert.equal(candidateValuePin.value_text, null);
delete valuePinnedManifest.candidate_value;
const validateFactEvidenceContext = ajv.compile(schemas.FactEvidenceContextResponse);
assert.equal(validateFactEvidenceContext(valuePinnedContext), false, 'legacy evidence contexts without a candidate value pin are invalid DTOs');
const before = value('run-before-tab-close');
const after = value('run-after-relogin');
assert.equal(before.run_id, after.run_id, 'new session must find same run');
assert.equal(before.execution_request_id, after.execution_request_id, 'relogin must not create another execution');
assert.equal(before.input_hash, after.input_hash, 'immutable snapshot survives browser close');
assert.equal(after.state, 'running', 'browser close does not cancel server work');
const events = value('run-recovery-events');
assert.deepEqual((events.items as Array<Record<string, unknown>>).map(event => event.seq), [2, 3]);
assert.equal(events.next_cursor, after.event_cursor);
assert.equal(byName.get('owner-safe-404')?.http_status, 404);
assert.equal(byName.get('revision-conflict-409')?.http_status, 409);
assert.equal(byName.get('idempotency-conflict-409')?.http_status, 409);
const unknown = value('model-attempt-unknown-usage');
assert.equal(unknown.usage_status, 'pending');
assert.equal(unknown.input_tokens, null);
assert.equal(unknown.output_tokens, null);
assert.equal(unknown.prompt_snapshot_ref, before.prompt_snapshot_ref);
const upload = value('upload-session');
const complete = value('upload-complete-request');
const material = value('material-persisted');
assert.equal(upload.upload_id, material.upload_id);
assert.equal(material.sha256, complete.sha256);
assert.equal(material.byte_size, complete.byte_size);
assert.equal(upload.state, 'uploading');
assert.equal(material.state, 'persisted');
const projectEvent = value('project-upload-progress-event');
assert.equal(projectEvent.project_id, value('project-revision-7').project_id);
assert.equal((projectEvent.payload as Record<string, unknown>).uploaded_bytes, complete.byte_size);
assert.equal(Object.hasOwn(projectEvent, 'run_id'), false, 'upload precedes run creation');
const lockRequest = value('lock-input-revision-request');
const locked = value('locked-input-revision');
assert.deepEqual(lockRequest.material_versions, locked.material_versions);
assert.equal(locked.input_hash, before.input_hash);
assert.equal(lockRequest.draft_revision, locked.input_revision);
const recognition = value('recognition-needs-confirmation');
assert.equal(recognition.material_id, material.material_id);
const sourceMarket = recognition.source_market as Record<string, unknown>;
assert.equal(sourceMarket.value, null);
assert.ok((sourceMarket.uncertainty as string[]).length > 0);
assert.deepEqual((sourceMarket.provenance as Record<string, unknown>).evidence_refs, ['page-1-region-2']);
const periods = recognition.reporting_periods as Array<Record<string, unknown>>;
assert.equal(periods[0]?.end, '2024-12-31');
assert.equal(periods[0]?.scope, 'consolidated');
assert.equal(periods[1]?.end, null, 'ambiguous OCR date must stay unknown');
assert.equal((recognition.latest_reporting_cutoff as Record<string, unknown>).value, null);
const private404 = value('owner-safe-404');
assert.equal(private404.code, 'NOT_FOUND');
assert.equal(JSON.stringify(private404).includes('victim'), false);
assert.equal(value('artifact-ready-after-quality-check').run_id, before.run_id);
assert.equal(isMarketOffering('nafmii', 'dfi'), true);
assert.equal(isMarketOffering('sse', 'dfi'), false);
assert.equal(value('upload-spreadsheet-request').media_type, M1_UPLOAD_MIME_TYPES[2]);
assert.equal(value('upload-image-request').media_type, 'image/jpeg');
assert.equal(value('upload-create').role, material.role);
for (const name of ['unsupported-legacy-or-macro-format-415', 'encrypted-material-422', 'content-mismatch-422']) {
  assert.ok(byName.get(name)?.http_status === 415 || byName.get(name)?.http_status === 422);
}
const internalEvent = value('internal-model-attempt-event-unknown-usage');
assert.equal(internalEvent.run_id, before.run_id);
assert.equal(internalEvent.call_id, unknown.call_id);
assert.equal(internalEvent.prompt_snapshot_ref, unknown.prompt_snapshot_ref);
assert.equal((internalEvent.usage as Record<string, unknown>).input_tokens, null);
assert.equal((value('internal-error-event').error as Record<string, unknown>).category, 'model_provider');
const prototype = await import(new URL('../../../product-prototype/public/project-fields.js', import.meta.url).href) as { MATERIAL_GROUPS: Array<{ label: string; items: Array<[string, string]> }>; SUPPORT_ROLES: string[] };
const expectedRoles = ['historical', 'reference', ...prototype.SUPPORT_ROLES];
assert.deepEqual([...M1_UPLOAD_MATERIAL_ROLES].sort(), expectedRoles.sort(), 'M1 upload roles must follow current prototype partitions');
for (const partition of M1_MATERIAL_PARTITIONS) {
  const source = prototype.MATERIAL_GROUPS.find(group => group.label === partition.label);
  assert.ok(source, `missing prototype partition ${partition.label}`);
  for (const role of partition.roles) assert.equal(source.items.find(item => item[0] === role.code)?.[1], role.label);
}
console.log(`validated ${data.cases.length} synthetic examples + ${libraryExamples.cases.length} internal library examples and recovery/conflict/usage invariants`);
// #79: retries and final success are both kept; cached/reasoning are subsets of the totals.
const timeline = value('admin-job-timeline-retry-then-success') as { attempts: Array<{ status: string; usage: Record<string, number> }>; consumption: Record<string, Record<string, number>> };
const sumOf = (rows: typeof timeline.attempts, field: string) => rows.reduce((n, row) => n + row.usage[field], 0);
assert.equal(timeline.consumption.all_attempts.input_tokens, sumOf(timeline.attempts, 'input_tokens'));
assert.equal(timeline.consumption.completed_attempts.input_tokens, sumOf(timeline.attempts.filter(a => a.status === 'completed'), 'input_tokens'));
assert.ok(timeline.consumption.all_attempts.cached_input_tokens <= timeline.consumption.all_attempts.input_tokens);
