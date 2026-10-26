import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { extractRunFileReferences, validateRunFileReference, RunFileReferenceError, type RunFileReferenceScope } from './run-file-reference.js';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const common = { owner: 'user-184e0856', projectId: 'a6f9f2ed-54e3-46c5-a576-6a35904e345d', runId: '6b17e374-9fb4-4224-920d-0427c2b97c64', inputHash: sha('fixed input') };
const provider = { ...common, source: 'provider', attemptId: 'd124ad6d-64df-4016-b752-265e160638d2' } satisfies RunFileReferenceScope;
const correction = { ...common, source: 'local_correction' } satisfies RunFileReferenceScope;
const project = { ...common, source: 'local_project_file' } satisfies RunFileReferenceScope;
type RawRef = { key: string; sha256: string; byte_size: number };
type Envelope = { version: string; input_hash: string; files: Record<string, RawRef>; [key: string]: any };
const base = `owners/${common.owner}/projects/${common.projectId}/runs/${common.runId}/`;
const folders: Record<string, string> = { 'codex-file-word-v1': 'file-authoring', 'codex-m4-document-v1': 'm4-documents', 'codex-review-file-v1': 'review-files', 'review-revision-cli-v1': 'review-revision-cli', 'project-file-output-v1': 'project-files' };
function ref(schema: string, name: string, scope: RunFileReferenceScope = provider): RawRef {
  const sha256 = sha(name), part = scope.source === 'provider' ? `${scope.attemptId}/` : scope.source === 'local_correction' ? 'correction/' : '';
  return { key: `${base}${folders[schema]}/${part}${sha256}/${name}`, sha256, byte_size: Buffer.byteLength(name) };
}
const handling = {
  version: 'review-revision-handling-v1',
  source_report: { report_id: 'report-1', run_id: 'previous-run', version: 1, input_revision: 1, sha256: sha('report') },
  accepted_plan: { plan_id: 'plan-1', version: 1, sha256: sha('plan'), accepted_at: '2026-10-26T00:00:00Z' },
  source_material: { material_id: 'material-1', material_version: 1, sha256: sha('material') },
  items: [{ finding_id: 'finding-1', report_id: 'report-1', status: 'needs_evidence', reason: 'Await the exact source', locations: [], evidence_refs: [], review_passed: false }],
  limitations: [], review_passed: false,
};
function envelope(schema: string, names: string[], scope: RunFileReferenceScope = provider): Envelope {
  const value: Envelope = { version: schema, input_hash: scope.inputHash, files: Object.fromEntries(names.map(name => [name, ref(schema, name, scope)])) };
  if (schema === 'codex-file-word-v1') value.summary = { baseline_kind: 'uploaded_source', source_sha256: sha('source'), effective_baseline_sha256: value.files['baseline.docx']?.sha256 ?? null, authoring_summary: [], source_issuer: null };
  if (schema === 'codex-m4-document-v1') Object.assign(value, { skill_sha256: sha('skill'), method_hash: sha('method'), project_file_links: { links: [], source_sha256: sha('source'), target_sha256: sha('document'), warnings: ['No verified links'] } });
  if (schema === 'review-revision-cli-v1') Object.assign(value, { revision_pin_sha256: sha('revision pin'), skill_sha256: sha('skill'), summary: { method: schema, input_hash: scope.inputHash, authoring_summary: ['Work completed'], review_passed: false }, handling: structuredClone(handling) });
  return value;
}
const extract = (value: unknown, scope: RunFileReferenceScope = provider, schema = (value as Envelope)?.version) => extractRunFileReferences({ scope, resultSchemaVersion: schema, value });
const rejects = (work: () => unknown, label?: string) => assert.throws(work, RunFileReferenceError, label);

test('real collector envelopes extract exact provider, local correction and project-file references', () => {
  const samples: [Envelope, RunFileReferenceScope][] = [
    [envelope('codex-file-word-v1', ['tracked.docx', 'clean.docx', 'baseline.docx', 'delivery.md']), provider],
    [envelope('codex-m4-document-v1', ['document.docx', 'preparation-note.docx']), provider],
    [envelope('codex-review-file-v1', ['report.docx', 'report.md', 'final-response.md', 'comments.pdf', 'annotations.json']), provider],
    [envelope('review-revision-cli-v1', ['tracked.docx', 'clean.docx', 'baseline.docx', 'handling.json', 'summary.json', 'proposal.json']), provider],
    [envelope('codex-review-file-v1', ['revision.docx', 'clean.docx', 'baseline.docx', 'report.docx', 'report.md', 'editor.json'], correction), correction],
    [envelope('project-file-output-v1', ['report.docx'], project), project],
    [envelope('project-file-output-v1', ['revision.docx', 'clean.docx', 'baseline.docx'], project), project],
  ];
  for (const [value, scope] of samples) {
    const before = structuredClone(value), files = extract(value, scope);
    assert.equal(files.length, Object.keys(value.files).length);
    assert.deepEqual(files.map(file => file.key), Object.values(value.files).map(file => file.key));
    assert.deepEqual(files.map(file => file.byteSize), Object.values(value.files).map(file => file.byte_size));
    assert.deepEqual(value, before, 'extracting references never rewrites durable output');
    for (const file of files) assert.equal(file.mediaType, file.name.endsWith('.docx') ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : file.name.endsWith('.pdf') ? 'application/pdf' : file.name.endsWith('.json') ? 'application/json' : 'text/markdown');
  }
});

test('explicit review correction provider output can mix its exact attempt and local correction files', () => {
  const value = envelope('codex-review-file-v1', ['revision.docx', 'clean.docx', 'baseline.docx', 'report.docx', 'report.md', 'editor.json'], correction);
  value.files['final-response.md'] = ref(value.version, 'final-response.md');
  value.files['model-report.docx'] = ref(value.version, 'model-report.docx');
  assert.equal(extract(value, { ...provider, reviewCorrection: true }).length, 8);
  rejects(() => extract(value), 'ordinary provider cannot use the correction namespace');
  rejects(() => extract(value, correction), 'local correction cannot borrow provider files');
  const foreign = structuredClone(value); foreign.files['final-response.md'].key = foreign.files['final-response.md'].key.replace(provider.attemptId, 'another-attempt');
  rejects(() => extract(foreign, { ...provider, reviewCorrection: true }));
});

test('single-reference validator supports storing before an output envelope exists', () => {
  const value = ref('codex-file-word-v1', 'tracked.docx');
  assert.deepEqual(validateRunFileReference({ scope: provider, resultSchemaVersion: 'codex-file-word-v1', name: 'tracked.docx', value }), {
    name: 'tracked.docx', key: value.key, sha256: value.sha256, byteSize: value.byte_size, mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
  rejects(() => validateRunFileReference({ scope: { ...provider, attemptId: 'other-attempt' }, resultSchemaVersion: 'codex-file-word-v1', name: 'tracked.docx', value }));
});

test('a review provider attempt named correction cannot collide with the local correction namespace', () => {
  const reservedAttempt = { ...provider, attemptId: 'correction' };
  const value = envelope('codex-review-file-v1', ['report.docx'], reservedAttempt);
  assert.equal(value.files['report.docx'].key, ref(value.version, 'report.docx', correction).key, 'the otherwise-valid attempt path is the reserved local path');
  for (const scope of [reservedAttempt, { ...reservedAttempt, reviewCorrection: true }]) {
    rejects(() => extract(value, scope));
    rejects(() => validateRunFileReference({ scope, resultSchemaVersion: value.version, name: 'report.docx', value: value.files['report.docx'] }));
  }
  const otherFamily = envelope('codex-file-word-v1', ['tracked.docx', 'clean.docx'], reservedAttempt);
  assert.equal(extract(otherFamily, reservedAttempt).length, 2, 'the reservation is specific to review-files');
  const local = envelope('codex-review-file-v1', ['revision.docx', 'clean.docx', 'baseline.docx', 'report.docx', 'report.md', 'editor.json'], correction);
  assert.equal(extract(local, correction).length, 6);
});

test('foreign scope, different attempt and path mutations are rejected by complete key equality', () => {
  const value = envelope('codex-file-word-v1', ['tracked.docx', 'clean.docx']);
  for (const scope of [{ ...provider, owner: 'foreign' }, { ...provider, projectId: 'foreign' }, { ...provider, runId: 'foreign' }, { ...provider, attemptId: 'foreign' }]) rejects(() => extract(value, scope));
  const mutations = [
    (key: string) => key.replace('/file-authoring/', '/m4-documents/'),
    (key: string) => key.replace(`/${provider.attemptId}/`, `/${provider.attemptId}/nested/`),
    (key: string) => key.replace(`/${provider.attemptId}/`, '/correction/'),
    (key: string) => key.replace('/tracked.docx', '/clean.docx'),
    (key: string) => key.replace(`/${sha('tracked.docx')}/`, `/${sha('other')}/`),
    (key: string) => key.replace('/file-authoring/', '/file-authoring/../file-authoring/'),
    (key: string) => key.replace('/file-authoring/', '/file-authoring/%2e%2e/'),
    (key: string) => key.replaceAll('/', '\\'), (key: string) => key + '/tail', (key: string) => 'https://example.invalid/' + key,
  ];
  for (const mutate of mutations) { const changed = structuredClone(value); changed.files['tracked.docx'].key = mutate(changed.files['tracked.docx'].key); rejects(() => extract(changed)); }
});

test('all schemas reject unknown files, extra ref/envelope fields and invalid ref structures', () => {
  const samples = [envelope('codex-file-word-v1', ['tracked.docx', 'clean.docx']), envelope('codex-m4-document-v1', ['document.docx', 'preparation-note.docx']), envelope('codex-review-file-v1', ['report.docx']), envelope('review-revision-cli-v1', ['tracked.docx', 'clean.docx', 'baseline.docx', 'handling.json', 'summary.json', 'proposal.json'])];
  for (const sample of samples) {
    const first = Object.keys(sample.files)[0];
    const extraName = structuredClone(sample); extraName.files['undeclared.bin'] = ref(sample.version, 'undeclared.bin'); rejects(() => extract(extraName));
    const extraRef = structuredClone(sample); (extraRef.files[first] as RawRef & { extra: boolean }).extra = true; rejects(() => extract(extraRef));
    const extraTop = structuredClone(sample); extraTop.hidden_files = {}; rejects(() => extract(extraTop));
    for (const bad of [null, [], 'key', {}, { key: sample.files[first].key, sha256: sample.files[first].sha256 }]) { const changed = structuredClone(sample); changed.files[first] = bad as RawRef; rejects(() => extract(changed)); }
  }
  for (const files of [null, [], 'files']) { const value = envelope('codex-review-file-v1', ['report.docx']); value.files = files as unknown as Envelope['files']; rejects(() => extract(value)); }
});

test('input binding, schema, provenance and hash validation fail closed even for empty error results', () => {
  const value = envelope('codex-file-word-v1', []); value.error = 'WORD_QUALITY_REJECTED';
  assert.deepEqual(extract(value), []);
  rejects(() => extract(value, { ...provider, inputHash: sha('another input') }));
  rejects(() => extract(value, provider, 'unrecognized-schema-v1'));
  const wrongVersion = { ...value, version: 'codex-review-file-v1' }; rejects(() => extract(wrongVersion, provider, 'codex-file-word-v1'));
  for (const badScope of [{ ...provider, attemptId: undefined }, { ...provider, attemptId: 'nested/attempt' }, { ...provider, owner: '../owner' }, { ...provider, inputHash: 'invalid' }, { ...provider, source: 'unknown' }, { ...correction, attemptId: provider.attemptId }, { ...provider, reviewCorrection: true }]) rejects(() => extract(value, badScope as RunFileReferenceScope));
  for (const badHash of ['A'.repeat(64), 'a'.repeat(63), '../hash', null, 12]) { const changed = envelope('codex-file-word-v1', ['tracked.docx', 'clean.docx']); changed.files['tracked.docx'].sha256 = badHash as string; rejects(() => extract(changed)); }
  const wrongSource = envelope('project-file-output-v1', ['report.docx'], project); rejects(() => extract(wrongSource));
});

test('file-specific size limits accept boundaries and reject nonpositive, fractional and oversized bytes', () => {
  const cases: [string, string, number, RunFileReferenceScope][] = [
    ['codex-file-word-v1', 'tracked.docx', 100 * 1024 * 1024, provider], ['codex-file-word-v1', 'delivery.md', 256 * 1024, provider],
    ['codex-m4-document-v1', 'document.docx', 100 * 1024 * 1024, provider], ['codex-review-file-v1', 'comments.pdf', 100 * 1024 * 1024, provider],
    ['codex-review-file-v1', 'report.md', 4 * 1024 * 1024, provider], ['codex-review-file-v1', 'editor.json', 4 * 1024 * 1024, correction],
    ['review-revision-cli-v1', 'proposal.json', 32 * 1024 * 1024, provider], ['project-file-output-v1', 'report.docx', 100 * 1024 * 1024, project],
  ];
  for (const [schema, name, max, scope] of cases) {
    const file = ref(schema, name, scope);
    assert.equal(validateRunFileReference({ scope, resultSchemaVersion: schema, name, value: { ...file, byte_size: max } }).byteSize, max);
    for (const size of [0, -1, 1.5, max + 1, Number.MAX_SAFE_INTEGER + 1, '12', null]) rejects(() => validateRunFileReference({ scope, resultSchemaVersion: schema, name, value: { ...file, byte_size: size } }));
  }
});

test('partial errors inventory every valid retained file and never excuse malformed optional files', () => {
  for (const [schema, name, error] of [['codex-file-word-v1', 'delivery.md', 'WORD_QUALITY_REJECTED'], ['codex-m4-document-v1', 'document.docx', 'WORD_DELIVERY_UNAVAILABLE'], ['codex-review-file-v1', 'final-response.md', 'WORD_DELIVERY_UNAVAILABLE']]) {
    const value = envelope(schema, [name]); value.error = error;
    assert.equal(extract(value).length, 1);
    const invalid = structuredClone(value); invalid.files[name].key += '/unexpected'; rejects(() => extract(invalid));
    const wrongError = structuredClone(value); wrongError.error = 'UNRECOGNIZED'; rejects(() => extract(wrongError));
    const success = structuredClone(value); delete success.error; rejects(() => extract(success));
  }
  const rejected = envelope('review-revision-cli-v1', []); rejected.error = 'WORD_QUALITY_REJECTED'; rejected.summary = { validation_error: 'WORD_REVISION_SCOPE_OR_ARTIFACT_INVALID' }; delete rejected.handling;
  assert.deepEqual(extract(rejected), []);
  const unsafe = structuredClone(rejected); unsafe.files['proposal.json'] = ref(unsafe.version, 'proposal.json'); rejects(() => extract(unsafe));
  const wrongReason = structuredClone(rejected); wrongReason.summary.validation_error = 'other'; rejects(() => extract(wrongReason));
});

test('revision no-change JSON output and completion metadata remain strict', () => {
  const value = envelope('review-revision-cli-v1', ['handling.json', 'summary.json', 'proposal.json']); value.summary.no_changes = true;
  assert.equal(extract(value).length, 3);
  const badHandling = structuredClone(value); badHandling.handling.extra = true; rejects(() => extract(badHandling));
  const badSkill = structuredClone(value); badSkill.skill_sha256 = 'bad'; rejects(() => extract(badSkill));
  const missing = structuredClone(value); delete missing.files['proposal.json']; rejects(() => extract(missing));
  const m4 = envelope('codex-m4-document-v1', ['document.docx', 'preparation-note.docx']); m4.project_file_links.unexpected = true; rejects(() => extract(m4));
  const same = envelope('codex-m4-document-v1', ['document.docx', 'preparation-note.docx']); same.files['preparation-note.docx'] = { ...same.files['document.docx'], key: same.files['document.docx'].key.replace('document.docx', 'preparation-note.docx') }; rejects(() => extract(same));
});
