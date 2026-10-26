import assert from 'node:assert/strict';
import test from 'node:test';
import { Value } from '@sinclair/typebox/value';
import {
  emptyUpdateDetails, M4DocumentManifestSchema, ReviewExecutionOriginSchema, RunSupplementInputPreviewSchema,
  type ReviewMaterialPin, type RunSupplementMaterial, type SourceProspectus,
} from '@bondbuddy/contracts';
import { digest } from './data.js';
import { inputManifestHash } from './production-rule-pin.js';
import { compileRunSupplementInput } from './run-supplement-input.js';

const projectId = 'task-project';
const material = (id: string, role: RunSupplementMaterial['role'] = 'other', version = 1, source = projectId): RunSupplementMaterial => ({
  material_id: id, material_version: version, sha256: digest(`${id}-${version}`), source_project_id: source,
  filename: `${id}.pdf`, media_type: 'application/pdf', role, available: true,
});
const pin = (value: ReviewMaterialPin): ReviewMaterialPin => ({ material_id: value.material_id, material_version: value.material_version, sha256: value.sha256 });
const ordinaryPin = (value: RunSupplementMaterial) => ({ ...pin(value), role: value.role });
const scopedPin = (value: RunSupplementMaterial) => ({ ...pin(value), source_project_id: value.source_project_id });
const sourceDeclaration = (value: ReviewMaterialPin, overrides: Partial<SourceProspectus> = {}): SourceProspectus => ({
  ...pin(value), issuer_name: 'Declared source issuer', relation: 'same_issuer', market: 'sse', offering: 'private',
  reporting_periods: [{ start: '2024-01-01', end: '2024-12-31', period_kind: 'annual', scope: null,
    status: 'needs_confirmation', evidence_refs: [] }], status: 'user_asserted', ...overrides,
});
function unified(materials = [material('original')]) {
  return {
    draft_revision: 4, issuer_name: 'Frozen target issuer', market: 'sse', offering: 'private', goals: ['Frozen goal'], requirements: ['Frozen requirement'],
    rule_pack_version: 'rules-3', template_version: 'template-2', reference_release: 'release-1',
    update_details: { ...emptyUpdateDetails(), authoring_mode: 'unified_v1', target_reporting_periods: [{
      start: '2025-01-01', end: '2025-12-31', period_kind: 'annual', scope: null, status: 'user_asserted', evidence_refs: [],
    }] },
    materials: materials.map(ordinaryPin),
    authoring: { version: 'unified_v1', source_prospectuses: [], requirements: [{ message_id: 'message-a', message_version: 2,
      submission_id: 'submission-a', content_sha256: digest('Frozen original requirement') }],
    knowledge: [{ path: 'knowledge/frozen.md', markdown: 'Frozen knowledge', sha256: digest('Frozen knowledge') }],
    knowledge_status: 'authoring_reference_not_compliance_approval',
    previous_output: { artifact_id: 'previous', version: 2, sha256: digest('Frozen output'), run_id: 'previous-run', input_revision: 3 } },
  };
}
function m3(source = material('source', 'historical'), evidence = material('evidence', 'audit')) {
  const input = { source_material_ref: pin(source), material_versions: [pin(source), pin(evidence)], requirements: ['Frozen review requirement'], as_of: '2025-12-31' };
  const origin = { version: 'review-execution-origin-v1', entrypoint: 'quick_action', accepted_proposal: null, context_report_ref: null };
  const manifest = { issuer_name: 'Frozen issuer', materials: [ordinaryPin(source), ordinaryPin(evidence)],
    review: { version: 'review_v1', operation: 'full_review', report_id: 'report-new', version_number: 2,
      input, source_report_id: null, source_report_sha256: null, finding_ids: [], origin,
      file_delivery: { version: 'frozen-file-delivery', knowledge: ['Frozen review policy'] } } };
  return { manifest, reviewSnapshot: { input: structuredClone(input), origin: structuredClone(origin), finding_ids: [], plan: null } };
}
function m4() {
  const source = material('source', 'other', 1, 'source-project'), evidence = material('evidence', 'audit');
  const template = material('template', 'other', 1, 'template-project');
  const manifest = { version: 'm4-document-input-v1', kind: 'document', project_name: 'Frozen project', topic_id: 'topic-1',
    execution_scope_project_id: 'source-project', draft_version: 3,
    input: { document_type: 'private_summary', source_material: scopedPin(source), materials: [scopedPin(source), scopedPin(evidence), scopedPin(template)],
      template: { template_id: 'template-id', template_version: 2, sha256: template.sha256 },
      edit_base: { source_project_id: 'source-project', artifact_id: 'clean', artifact_version: 4, sha256: digest('Frozen clean') },
      scope: 'whole', fields: { issuer_name: 'Frozen target', broker: 'Frozen broker' }, supplemental_requirements: 'Frozen extra requirement',
      requirements: [{ requirement_id: 'requirement-a', text: 'Frozen requirement', message_id: 'message-a', message_version: 3 }] },
    template_material: scopedPin(template), market: 'sse', offering: 'private', billing_task: 'm4_G05',
    knowledge: { version: 'knowledge-1', document_type: 'private_summary', market: 'sse', offering: 'private', title: 'Frozen knowledge',
      sha256: digest('Frozen knowledge'), source_ids: ['frozen-source'], content: 'Frozen knowledge' } };
  assert.ok(Value.Check(M4DocumentManifestSchema, manifest));
  return { manifest, source, evidence, template };
}
function check(result: ReturnType<typeof compileRunSupplementInput>, status: string) {
  assert.equal(result.preview.status, status);
  assert.ok(Value.Check(RunSupplementInputPreviewSchema, result.preview), JSON.stringify(result.preview));
  if (result.candidate) assert.equal(result.preview.candidate_input_hash, inputManifestHash(result.candidate.manifest));
  else assert.equal(result.preview.candidate_input_hash, null);
}

test('ordinary authoring supplements preserve every frozen context and return independent candidate bytes', () => {
  const old = material('original'), replacement = material('original', 'other', 2), added = material('added', 'audit');
  const manifest = unified(), original = structuredClone(manifest), resultMaterials = [replacement, added];
  const changes = [{ material: pin(replacement), replaces: pin(old) }, { material: pin(added), replaces: null }];
  const result = compileRunSupplementInput({ projectId, manifest, reviewSnapshot: null, resultMaterials, changes });
  check(result, 'prepared');
  assert.deepEqual(result.candidate?.manifest, { ...manifest, materials: resultMaterials.map(ordinaryPin) });
  assert.deepEqual(manifest, original);
  (result.candidate!.manifest.authoring as any).knowledge[0].markdown = 'Mutated returned candidate';
  (result.candidate!.manifest.update_details as any).target_reporting_periods[0].end = '2030-12-31';
  assert.deepEqual(manifest, original);
  assert.deepEqual(resultMaterials, [replacement, added]);
});

test('no changes do not produce an adoptable input; unavailable bytes do not produce a candidate hash', () => {
  check(compileRunSupplementInput({ projectId, manifest: unified(), reviewSnapshot: null, resultMaterials: [], changes: [] }), 'unchanged');
  const added = { ...material('added'), available: false };
  const result = compileRunSupplementInput({ projectId, manifest: unified(), reviewSnapshot: null,
    resultMaterials: [material('original'), added], changes: [{ material: pin(added), replaces: null }] });
  check(result, 'needs_information'); assert.equal(result.preview.issues[0].code, 'material_unavailable');
});

test('new historical/reference bytes never inherit a declaration from another version or current project data', () => {
  for (const role of ['historical', 'reference'] as const) {
    const old = material('source', role), replacement = material('source', role, 2), manifest: any = unified([old]);
    const source = { ...pin(old), issuer_name: null, relation: 'parent', market: 'sse', offering: 'private', reporting_periods: [], status: 'user_asserted' };
    manifest.authoring.source_prospectuses = [source]; manifest.update_details.source_prospectuses = [source];
    const before = structuredClone(manifest);
    const result = compileRunSupplementInput({ projectId, manifest, reviewSnapshot: null, resultMaterials: [replacement],
      changes: [{ material: pin(replacement), replaces: pin(old) }] });
    check(result, 'needs_information'); assert.equal(result.preview.issues[0].code, 'source_information_required');
    assert.deepEqual(manifest, before);
    const added = material('new-source', role);
    const addition = compileRunSupplementInput({ projectId, manifest, reviewSnapshot: null, resultMaterials: [old, added], changes: [{ material: pin(added), replaces: null }] });
    check(addition, 'needs_information'); assert.ok(addition.preview.issues.some(value => value.material_id === added.material_id));
  }
});

test('explicit source declarations synchronize candidate contexts and remove a declined old output only from the candidate', () => {
  for (const role of ['historical', 'reference'] as const) {
    const old = material('source', role), replacement = material('source', role, 2), unchanged = material('unchanged-source', 'reference');
    const manifest: any = unified([old, unchanged]), oldDeclaration = sourceDeclaration(old), keptDeclaration = sourceDeclaration(unchanged, { relation: 'parent' });
    manifest.authoring.source_prospectuses = [oldDeclaration, keptDeclaration];
    manifest.update_details.source_prospectuses = structuredClone(manifest.authoring.source_prospectuses);
    manifest.authoring.edit_baseline = { market: 'sse', offering: 'private', reporting_periods: oldDeclaration.reporting_periods };
    const before = structuredClone(manifest), declaration = sourceDeclaration(replacement, { relation: 'subsidiary', issuer_name: 'New explicitly declared issuer' });
    const result = compileRunSupplementInput({ projectId, manifest, reviewSnapshot: null, resultMaterials: [replacement, unchanged],
      changes: [{ material: pin(replacement), replaces: pin(old), source_prospectus: declaration, discard_previous_output: true }] });
    check(result, 'prepared');
    const candidate = result.candidate!.manifest as any;
    const byId = (a: SourceProspectus, b: SourceProspectus) => a.material_id.localeCompare(b.material_id);
    assert.deepEqual([...candidate.authoring.source_prospectuses].sort(byId), [declaration, keptDeclaration].sort(byId));
    assert.deepEqual(candidate.update_details.source_prospectuses, candidate.authoring.source_prospectuses);
    assert.deepEqual(candidate.materials, [replacement, unchanged].map(ordinaryPin));
    assert.equal(Object.hasOwn(candidate.authoring, 'previous_output'), false);
    assert.equal(Object.hasOwn(candidate.authoring, 'edit_baseline'), false);
    assert.deepEqual(candidate.update_details.target_reporting_periods, before.update_details.target_reporting_periods);
    assert.deepEqual(manifest, before, 'the original source declarations and generated result stay immutable');
    candidate.authoring.source_prospectuses[0].reporting_periods[0].end = '2030-12-31';
    assert.deepEqual(manifest, before);
  }
});

test('complete source information still requires an explicit choice for every changed source bound to an old output', () => {
  const old = material('source', 'historical'), replacement = material('source', 'historical', 2), added = material('new-source', 'reference');
  const manifest: any = unified([old]); manifest.authoring.source_prospectuses = [sourceDeclaration(old)];
  manifest.update_details.source_prospectuses = structuredClone(manifest.authoring.source_prospectuses);
  const before = structuredClone(manifest);
  const replacementChange = { material: pin(replacement), replaces: pin(old), source_prospectus: sourceDeclaration(replacement) };
  const addedChange = { material: pin(added), replaces: null, source_prospectus: sourceDeclaration(added) };
  for (const changes of [[replacementChange], [{ ...replacementChange, discard_previous_output: true as const }, addedChange]]) {
    const result = compileRunSupplementInput({ projectId, manifest, reviewSnapshot: null,
      resultMaterials: changes.length === 1 ? [replacement] : [replacement, added], changes });
    check(result, 'needs_information');
    assert.ok(result.preview.issues.some(value => value.code === 'source_baseline_choice_required'));
    assert.equal(result.candidate, null); assert.deepEqual(manifest, before);
  }
});

test('same-content different source revisions require their own exact declaration and incomplete fields remain saveable information gaps', () => {
  const old = material('source', 'historical'), replacement = { ...material('source', 'historical', 2), sha256: old.sha256 };
  const manifest: any = unified([old]); manifest.authoring.source_prospectuses = [sourceDeclaration(old)];
  manifest.update_details.source_prospectuses = structuredClone(manifest.authoring.source_prospectuses);
  const before = structuredClone(manifest);
  for (const declaration of [undefined, sourceDeclaration(replacement, { relation: null, reporting_periods: [] })]) {
    const result = compileRunSupplementInput({ projectId, manifest, reviewSnapshot: null, resultMaterials: [replacement],
      changes: [{ material: pin(replacement), replaces: pin(old), ...(declaration ? { source_prospectus: declaration } : {}), discard_previous_output: true }] });
    check(result, 'needs_information'); assert.equal(result.preview.issues[0].code, 'source_information_required');
    assert.deepEqual(manifest, before);
  }
  const staleDeclaration = compileRunSupplementInput({ projectId, manifest, reviewSnapshot: null, resultMaterials: [replacement],
    changes: [{ material: pin(replacement), replaces: pin(old), source_prospectus: sourceDeclaration(old), discard_previous_output: true }] });
  check(staleDeclaration, 'unsupported');
  assert.deepEqual(manifest, before);
});

test('new source declarations without an old output prepare normally and do not accept a meaningless discard flag', () => {
  const old = material('original'), added = material('added-source', 'reference'), manifest: any = unified([old]);
  delete manifest.authoring.previous_output;
  const before = structuredClone(manifest), declaration = sourceDeclaration(added);
  const change = { material: pin(added), replaces: null, source_prospectus: declaration };
  const result = compileRunSupplementInput({ projectId, manifest, reviewSnapshot: null, resultMaterials: [old, added], changes: [change] });
  check(result, 'prepared');
  assert.deepEqual((result.candidate!.manifest.authoring as any).source_prospectuses, [declaration]);
  assert.deepEqual((result.candidate!.manifest.update_details as any).source_prospectuses, [declaration]);
  check(compileRunSupplementInput({ projectId, manifest, reviewSnapshot: null, resultMaterials: [old, added],
    changes: [{ ...change, discard_previous_output: true }] }), 'unsupported');
  assert.deepEqual(manifest, before);
});

test('source metadata rejects wrong exact pins, ordinary evidence roles and non-M1 contexts without changing input', () => {
  const source = material('new-source', 'historical'), manifest: any = unified(), before = structuredClone(manifest);
  for (const wrong of [sourceDeclaration(source, { material_id: 'foreign-source' }), sourceDeclaration(source, { material_version: 2 }),
    sourceDeclaration(source, { sha256: digest('other bytes') }), sourceDeclaration(source, { market: 'sse', offering: 'mtn' })]) {
    check(compileRunSupplementInput({ projectId, manifest, reviewSnapshot: null, resultMaterials: [material('original'), source],
      changes: [{ material: pin(source), replaces: null, source_prospectus: wrong, discard_previous_output: true }] }), 'unsupported');
  }
  const ordinary = material('ordinary-evidence', 'audit');
  check(compileRunSupplementInput({ projectId, manifest, reviewSnapshot: null, resultMaterials: [material('original'), ordinary],
    changes: [{ material: pin(ordinary), replaces: null, source_prospectus: sourceDeclaration(ordinary) }] }), 'unsupported');
  const review = m3(), m4Fixture = m4();
  check(compileRunSupplementInput({ projectId, ...review, resultMaterials: [material('source', 'historical'), material('evidence', 'audit'), source],
    changes: [{ material: pin(source), replaces: null, source_prospectus: sourceDeclaration(source) }] }), 'unsupported');
  check(compileRunSupplementInput({ projectId, manifest: m4Fixture.manifest, reviewSnapshot: null,
    resultMaterials: [m4Fixture.source, m4Fixture.evidence, m4Fixture.template, source],
    changes: [{ material: pin(source), replaces: null, source_prospectus: sourceDeclaration(source) }] }), 'unsupported');
  assert.deepEqual(manifest, before);
});

test('M3 ordinary evidence and source replacements synchronize only material paths and the candidate snapshot', () => {
  const source = material('source', 'historical'), evidence = material('evidence', 'audit'), replacement = material('source', 'historical', 2), added = material('new-evidence');
  const fixture = m3(source, evidence), before = structuredClone(fixture);
  const result = compileRunSupplementInput({ projectId, ...fixture, resultMaterials: [replacement, evidence, added],
    changes: [{ material: pin(replacement), replaces: pin(source) }, { material: pin(added), replaces: null }] });
  check(result, 'prepared');
  const expected = structuredClone(before);
  expected.manifest.materials = [replacement, evidence, added].map(ordinaryPin);
  expected.manifest.review.input.material_versions = [replacement, evidence, added].map(pin);
  expected.manifest.review.input.source_material_ref = pin(replacement);
  expected.reviewSnapshot.input = structuredClone(expected.manifest.review.input);
  assert.deepEqual(result.candidate, expected);
  assert.deepEqual(fixture, before);
  (result.candidate!.reviewSnapshot as any).input.requirements.push('Returned candidate edit');
  assert.deepEqual(fixture, before);
});

test('M3 unchanged evidence links preserve the exact original report, finding and material identity', () => {
  const source = material('source', 'historical'), evidence = material('evidence', 'audit'), replacement = material('source', 'historical', 2);
  const fixture: any = m3(source, evidence);
  const links = [{ report_id: 'original-report', finding_id: 'original-finding', material_ref: pin(evidence) }];
  fixture.manifest.review.input.evidence_links = links;
  fixture.reviewSnapshot.input.evidence_links = structuredClone(links);
  const before = structuredClone(fixture);
  const result = compileRunSupplementInput({ projectId, ...fixture, resultMaterials: [replacement, evidence],
    changes: [{ material: pin(replacement), replaces: pin(source) }] });
  check(result, 'prepared');
  assert.deepEqual((result.candidate!.manifest.review as any).input.evidence_links, links);
  assert.deepEqual((result.candidate!.reviewSnapshot as any).input.evidence_links, links);
  (result.candidate!.manifest.review as any).input.evidence_links[0].material_ref.sha256 = digest('Mutated returned link');
  assert.deepEqual(fixture, before);
});

test('M3 replacing linked source or evidence requires explicit new evidence mapping without rewriting old links', () => {
  const source = material('source', 'historical'), evidence = material('evidence', 'audit');
  for (const linked of [source, evidence]) {
    const replacement = material(linked.material_id, linked.role, 2), fixture: any = m3(source, evidence);
    const links = [{ report_id: 'original-report', finding_id: 'original-finding', material_ref: pin(linked) }];
    fixture.manifest.review.input.evidence_links = links;
    fixture.reviewSnapshot.input.evidence_links = structuredClone(links);
    const before = structuredClone(fixture);
    const result = compileRunSupplementInput({ projectId, ...fixture,
      resultMaterials: [source, evidence].map(value => value === linked ? replacement : value),
      changes: [{ material: pin(replacement), replaces: pin(linked) }] });
    check(result, 'needs_information');
    assert.deepEqual(result.preview.issues.map(value => [value.code, value.material_id]), [['review_scope_bound', linked.material_id]]);
    assert.deepEqual(fixture, before);
  }
});

test('M3 source replacements preserve the DOCX/PDF boundary while ordinary text evidence stays usable', () => {
  const source = material('source', 'other'), evidence = material('evidence', 'audit'), fixture = m3(source, evidence);
  const textSource = { ...material('source', 'other', 2), media_type: 'text/plain', filename: 'source.txt' }, before = structuredClone(fixture);
  const rejected = compileRunSupplementInput({ projectId, ...fixture, resultMaterials: [textSource, evidence],
    changes: [{ material: pin(textSource), replaces: pin(source) }] });
  check(rejected, 'needs_information'); assert.equal(rejected.preview.issues[0].code, 'review_scope_bound');
  assert.equal(rejected.preview.issues[0].material_id, source.material_id); assert.deepEqual(fixture, before);
  const textEvidence = { ...material('text-evidence'), media_type: 'text/plain', filename: 'evidence.txt' };
  const prepared = compileRunSupplementInput({ projectId, ...fixture, resultMaterials: [source, evidence, textEvidence],
    changes: [{ material: pin(textEvidence), replaces: null }] });
  check(prepared, 'prepared');
  assert.deepEqual((prepared.candidate!.manifest.review as any).input.source_material_ref, pin(source));
  assert.deepEqual(fixture, before);
});

test('M3 correction exports retain the original editor decisions and cannot be converted into new material processing', () => {
  const fixture: any = m3(), added = material('added');
  fixture.manifest.review.file_delivery = { version: 'review-correction-v2', knowledge: [],
    export: { source_run_id: 'review-source-run', editor_sha256: digest('Original correction editor'),
      decisions: [{ change_id: 'original-change', decision: 'accept' }] } };
  fixture.reviewSnapshot.export_only = true;
  const before = structuredClone(fixture);
  const result = compileRunSupplementInput({ projectId, ...fixture, resultMaterials: [material('source', 'historical'), material('evidence', 'audit'), added],
    changes: [{ material: pin(added), replaces: null }] });
  check(result, 'needs_information'); assert.equal(result.preview.issues[0].code, 'review_scope_bound');
  assert.deepEqual(fixture, before);
});

test('accepted M3 origin, finding revisions and report follow-ups retain their original authority and cannot be rewritten', () => {
  const added = material('added');
  for (const kind of ['accepted', 'revision', 'review_result', 'review_revision'] as const) {
    const fixture: any = m3();
    if (kind === 'accepted') {
      const proposal = { version: 'review-proposal-v2', proposal_id: 'proposal-original', project_id: projectId, operation: 'full_review',
        source_report_id: null, source_report_sha256: null, context_report_ref: null, input_version: 2,
        input_sha256: inputManifestHash(fixture.manifest.review.input), source_material_ref: fixture.manifest.review.input.source_material_ref,
        material_versions: fixture.manifest.review.input.material_versions, finding_ids: [], related_finding_ids: [], excluded_findings: [],
        requirements: ['Frozen review requirement'], explanation: 'Original accepted proposal' };
      fixture.manifest.review.origin = { ...fixture.manifest.review.origin, entrypoint: 'assistant_proposal',
        accepted_proposal: { acceptance_id: 'accepted-original', input_sha256: inputManifestHash(fixture.manifest.review.input), proposal,
          proposal_sha256: inputManifestHash(proposal), adoption: 'as_proposed', accepted_at: '2026-10-01T01:00:00Z',
          input_version: 2, report_catalog_version: 0, finding_ids: [], excluded_findings: [], requirements: proposal.requirements } };
      assert.ok(Value.Check(ReviewExecutionOriginSchema, fixture.manifest.review.origin));
      fixture.reviewSnapshot.origin = structuredClone(fixture.manifest.review.origin);
    }
    else if (kind === 'revision') fixture.manifest.review.operation = 'revision';
    else fixture.manifest.authoring = { version: 'unified_v1', [kind]: { run_id: 'original-report-run', sha256: digest('Original report'), source_material: pin(material('source', 'historical')) } };
    const before = structuredClone(fixture);
    const result = compileRunSupplementInput({ projectId, ...fixture, resultMaterials: [material('source', 'historical'), material('evidence', 'audit'), added],
      changes: [{ material: pin(added), replaces: null }] });
    check(result, 'needs_information'); assert.equal(result.preview.issues[0].code, 'review_scope_bound');
    assert.deepEqual(fixture, before);
  }
});

test('M4 preserves cross-project source, duplicated source/template pins, edit base and all business context', () => {
  const fixture = m4(), added = material('added'), before = structuredClone(fixture.manifest);
  const result = compileRunSupplementInput({ projectId, manifest: fixture.manifest, reviewSnapshot: null,
    resultMaterials: [fixture.source, fixture.evidence, fixture.template, added], changes: [{ material: pin(added), replaces: null }] });
  check(result, 'prepared');
  const expected = structuredClone(before); expected.input.materials.push(scopedPin(added));
  assert.deepEqual(result.candidate?.manifest, expected); assert.deepEqual(fixture.manifest, before);
  for (const [target, code] of [[fixture.source, 'm4_source_bound'], [fixture.template, 'm4_template_bound']] as const) {
    const replacement = material(target.material_id, 'other', 2);
    const blocked = compileRunSupplementInput({ projectId, manifest: fixture.manifest, reviewSnapshot: null,
      resultMaterials: [fixture.source, fixture.evidence, fixture.template].map(value => value === target ? replacement : value),
      changes: [{ material: pin(replacement), replaces: pin(target) }] });
    check(blocked, 'needs_information'); assert.equal(blocked.preview.issues[0].code, code);
    assert.deepEqual(fixture.manifest, before);
  }
});

test('material limits and malformed shared-schema inputs fail without partially changing any input', () => {
  const originals = Array.from({ length: 60 }, (_, index) => material(`evidence-${index}`)), added = material('extra');
  const result = compileRunSupplementInput({ projectId, manifest: unified(originals), reviewSnapshot: null,
    resultMaterials: [...originals, added], changes: [{ material: pin(added), replaces: null }] });
  check(result, 'needs_information'); assert.equal(result.preview.issues[0].code, 'material_limit');
  for (const manifest of [{ materials: [ordinaryPin(material('original'))] }, { ...unified(), update_details: {} },
    { ...unified(), authoring: { ...unified().authoring, requirements: [{ message_id: 'unversioned' }] } }]) {
    check(compileRunSupplementInput({ projectId, manifest, reviewSnapshot: null, resultMaterials: [material('original'), added], changes: [{ material: pin(added), replaces: null }] }), 'unsupported');
  }
  const malformed = m4(); (malformed.manifest.input as any).scope = 'partial';
  check(compileRunSupplementInput({ projectId, manifest: malformed.manifest, reviewSnapshot: null,
    resultMaterials: [malformed.source, malformed.evidence, malformed.template, added], changes: [{ material: pin(added), replaces: null }] }), 'unsupported');
  const review = m3(); (review.reviewSnapshot.input as any).requirements = ['Other review'];
  check(compileRunSupplementInput({ projectId, ...review, resultMaterials: [material('source', 'historical'), material('evidence', 'audit'), added], changes: [{ material: pin(added), replaces: null }] }), 'unsupported');
});

test('M4 source/template-only pins remain outside evidence, while its evidence limit is enforced independently', () => {
  const fixture = m4(), added = material('added');
  fixture.manifest.input.materials = [scopedPin(fixture.evidence)];
  const result = compileRunSupplementInput({ projectId, manifest: fixture.manifest, reviewSnapshot: null,
    resultMaterials: [fixture.evidence, fixture.source, fixture.template, added], changes: [{ material: pin(added), replaces: null }] });
  check(result, 'prepared');
  assert.deepEqual((result.candidate!.manifest.input as any).materials, [scopedPin(fixture.evidence), scopedPin(added)]);
  assert.deepEqual((result.candidate!.manifest.input as any).source_material, scopedPin(fixture.source));
  assert.deepEqual(result.candidate!.manifest.template_material, scopedPin(fixture.template));
  const evidence = Array.from({ length: 60 }, (_, index) => material(`m4-evidence-${index}`));
  fixture.manifest.input.materials = evidence.map(scopedPin);
  const limited = compileRunSupplementInput({ projectId, manifest: fixture.manifest, reviewSnapshot: null,
    resultMaterials: [...evidence, fixture.source, fixture.template, added], changes: [{ material: pin(added), replaces: null }] });
  check(limited, 'needs_information'); assert.equal(limited.preview.issues[0].code, 'material_limit');
});

test('legacy M3 origin may remain absent and malformed or mismatched review snapshots cannot be guessed', () => {
  const fixture: any = m3(), added = material('added');
  delete fixture.manifest.review.origin; delete fixture.reviewSnapshot.origin;
  const resultMaterials = [material('source', 'historical'), material('evidence', 'audit'), added];
  const changes = [{ material: pin(added), replaces: null }];
  check(compileRunSupplementInput({ projectId, ...fixture, resultMaterials, changes }), 'prepared');
  for (const reviewSnapshot of [null, {}, { input: fixture.manifest.review.input, origin: { entrypoint: 'invented' } }])
    check(compileRunSupplementInput({ projectId, manifest: fixture.manifest, reviewSnapshot, resultMaterials, changes }), 'unsupported');
});

test('a result material list cannot silently inject, omit or retarget materials outside the saved changes', () => {
  const original = material('original'), added = material('added'), changes = [{ material: pin(added), replaces: null }];
  for (const resultMaterials of [[added], [original, added, material('injected')], [original, { ...added, source_project_id: 'foreign-project' }]]) {
    check(compileRunSupplementInput({ projectId, manifest: unified(), reviewSnapshot: null, resultMaterials, changes }), 'unsupported');
  }
});
