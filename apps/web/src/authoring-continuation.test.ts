import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyUpdateDetails, type ProspectusVersion } from '@bondbuddy/contracts';
import type { Dto } from './api.js';
import type { DraftFields } from './draft.js';
import { renderContinuationSummary, resolveContinuationBasis } from './authoring-continuation.js';

const projectId = 'continuation-project', sha = 'a'.repeat(64), otherSha = 'b'.repeat(64), at = '2026-10-25T00:00:00Z';
const run = (patch: Partial<Dto<'RunResponse'>> = {}): Dto<'RunResponse'> => ({
  run_id: 'old-run', execution_request_id: 'old-request', project_id: projectId, input_revision: 2, input_hash: sha,
  state: 'succeeded', stage: 'completed', event_cursor: 3, channel: 'production', test_grant_id: null,
  uncovered_items: [], billing_mode: 'platform_trial', reservation_id: null, artifact_id: 'old-revision',
  prompt_snapshot_ref: null, updated_at: at, ...patch,
});
const generated = (patch: Partial<ProspectusVersion> = {}): ProspectusVersion => ({
  version_id: 'old-version', sequence: 2, origin: 'generated', filename: '旧轮清洁稿.docx', sha256: sha, created_at: at,
  material_id: null, material_version: null, artifact_id: 'old-clean', artifact_version: 7,
  revision_artifact_id: 'old-revision', run_id: 'old-run', ...patch,
});
const uploaded = (patch: Partial<ProspectusVersion> = {}): ProspectusVersion => ({
  version_id: 'upload-version', sequence: 1, origin: 'upload', filename: '上传原稿.pdf', sha256: otherSha, created_at: at,
  material_id: 'uploaded-material', material_version: 3, artifact_id: null, artifact_version: null,
  revision_artifact_id: null, run_id: null, ...patch,
});
const versions = (patch: Partial<Dto<'ProspectusVersionsResponse'>> = {}): Dto<'ProspectusVersionsResponse'> => ({
  project_id: projectId, current_version_id: 'new-version', selection_revision: 9, inactive_material_ids: [],
  versions: [generated({ version_id: 'new-version', sequence: 4, artifact_id: 'new-clean', artifact_version: 1,
    revision_artifact_id: 'new-revision', run_id: 'new-run', sha256: otherSha, filename: '当前清洁稿.docx' }), generated(), uploaded()], ...patch,
});
const fields = (): DraftFields => ({ name: '项目', issuer_name: '目标发行人', market: 'sse', offering: 'private',
  update_details: { ...emptyUpdateDetails(), authoring_mode: 'unified_v1', reporting_cutoff: '2025-12-31',
    target_reporting_periods: [{ start: '2024-03-15', end: '2024-11-20', period_kind: 'interim', scope: 'parent', status: 'needs_confirmation', evidence_refs: [] }] } });
const material = (patch: Partial<Dto<'MaterialResponse'>> = {}): Dto<'MaterialResponse'> => ({
  material_id: 'audit-material', material_version: 3, upload_id: 'upload', role: 'audit', filename: '财务材料.pdf',
  media_type: 'application/pdf', byte_size: 100, sha256: sha, state: 'persisted', persisted_at: at, error: null, ...patch,
});

test('a historical result pins its own clean artifact, independently of the newer current version', () => {
  const source = versions(), historical = resolveContinuationBasis(source, projectId, run(), 'result');
  const current = resolveContinuationBasis(source, projectId, run(), 'current');
  assert.deepEqual(historical.editBase, { artifact_id: 'old-clean', artifact_version: 7, sha256: sha });
  assert.notEqual(historical.editBase?.artifact_id, run().artifact_id);
  assert.equal(historical.version?.run_id, 'old-run');
  assert.equal(historical.selectionRevision, 9);
  assert.deepEqual(current.editBase, { artifact_id: 'new-clean', artifact_version: 1, sha256: otherSha });
  assert.equal(current.version?.version_id, source.current_version_id);
  assert.notEqual(current.key, historical.key);
  source.versions[1].sha256 = otherSha;
  assert.equal(historical.version?.sha256, sha);
  assert.equal(historical.editBase?.sha256, sha);
});

test('result choice never promotes failed, active or internal test runs into a formal baseline', () => {
  for (const candidate of [run({ state: 'failed' }), run({ state: 'running' }),
    run({ state: 'test_completed', channel: 'non_production_test' }), run({ channel: 'non_production_test' })]) {
    assert.throws(() => resolveContinuationBasis(versions(), projectId, candidate, 'result'), /正式清洁版/);
  }
  assert.equal(resolveContinuationBasis(versions(), projectId, run({ state: 'failed' }), 'current').version?.version_id, 'new-version');
});

test('project identity is checked for both result and current choices', () => {
  for (const choice of ['result', 'current'] as const) {
    assert.throws(() => resolveContinuationBasis(versions({ project_id: 'foreign' }), projectId, run(), choice), /项目.*不一致/);
    assert.throws(() => resolveContinuationBasis(versions(), projectId, run({ project_id: 'foreign' }), choice), /项目.*不一致/);
  }
});

test('result choice refuses missing, ambiguous and colliding records instead of guessing the newest result', () => {
  assert.throws(() => resolveContinuationBasis(versions({ versions: [versions().versions[0]] }), projectId, run(), 'result'), /未找到本轮/);
  assert.throws(() => resolveContinuationBasis(versions({ versions: [generated(), generated({ version_id: 'duplicate-run-version' })] }), projectId, run(), 'result'), /不唯一/);
  assert.throws(() => resolveContinuationBasis(versions({ versions: [generated(), uploaded({ version_id: 'old-version' })] }), projectId, run(), 'result'), /不唯一/);
  assert.throws(() => resolveContinuationBasis(versions({ versions: [generated({ run_id: 'different-run' })] }), projectId, run(), 'result'), /未找到本轮/);
});

test('current choice requires one exact current id, and explicitly emits null for upload or no current', () => {
  const none = resolveContinuationBasis(versions({ current_version_id: null }), projectId, run(), 'current');
  assert.equal(none.version, null); assert.equal(none.editBase, null);
  assert.equal(Object.hasOwn(none, 'editBase'), true);
  const upload = resolveContinuationBasis(versions({ current_version_id: 'upload-version' }), projectId, run(), 'current');
  assert.equal(upload.version?.material_id, 'uploaded-material'); assert.equal(upload.editBase, null);
  assert.throws(() => resolveContinuationBasis(versions({ current_version_id: 'absent' }), projectId, run(), 'current'), /未找到项目当前稿/);
  assert.throws(() => resolveContinuationBasis(versions({ current_version_id: 'upload-version', versions: [uploaded(), uploaded()] }), projectId, run(), 'current'), /不唯一/);
});

test('invalid clean pins and revision-as-clean records cannot reach an input request', () => {
  const invalid: Partial<ProspectusVersion>[] = [{ artifact_id: null }, { artifact_id: '' }, { artifact_id: ' '.repeat(2) },
    { artifact_id: 'x'.repeat(129) }, { artifact_version: null }, { artifact_version: 0 }, { artifact_version: 1.5 },
    { sha256: 'A'.repeat(64) }, { sha256: 'short' }, { artifact_id: 'old-revision' }, { sequence: 0 }, { version_id: '' }];
  for (const patch of invalid) {
    const value = generated(patch), source = versions({ current_version_id: value.version_id, versions: [value] });
    for (const choice of ['result', 'current'] as const) {
      assert.throws(() => resolveContinuationBasis(source, projectId, run(), choice), /请重新读取/);
    }
  }
});

test('invalid uploaded material pins are refused even though their edit base would be null', () => {
  for (const patch of [{ material_id: null }, { material_id: '' }, { material_version: null }, { material_version: -1 },
    { material_version: 2.5 }, { sha256: 'z'.repeat(64) }] satisfies Partial<ProspectusVersion>[]) {
    assert.throws(() => resolveContinuationBasis(versions({ current_version_id: 'upload-version', versions: [uploaded(patch)] }), projectId, run(), 'current'), /请重新读取/);
  }
});

test('a generated current version must retain its run and revision identities', () => {
  for (const patch of [{ run_id: null }, { run_id: '' }, { run_id: ' '.repeat(2) }, { run_id: 'x'.repeat(129) },
    { revision_artifact_id: null }, { revision_artifact_id: '' }, { revision_artifact_id: ' '.repeat(2) },
    { revision_artifact_id: 'x'.repeat(129) }] satisfies Partial<ProspectusVersion>[]) {
    const value = generated(patch);
    assert.throws(() => resolveContinuationBasis(versions({ current_version_id: value.version_id, versions: [value] }), projectId, run(), 'current'), /准确版本.*请重新读取/);
  }
});

test('matching the result run id cannot conceal a revision-artifact mismatch', () => {
  const mismatched = generated({ revision_artifact_id: 'another-run-revision' });
  assert.throws(() => resolveContinuationBasis(versions({ versions: [mismatched] }), projectId, run(), 'result'), /本轮成果.*版本记录不一致/);
  // The current version can belong to another run; it is not bound to the viewed result.
  const current = resolveContinuationBasis(versions(), projectId, run(), 'current');
  assert.equal(current.version?.run_id, 'new-run');
  assert.equal(current.version?.revision_artifact_id, 'new-revision');
});

test('a succeeded production run without a valid primary artifact cannot claim a result baseline', () => {
  for (const artifact_id of [null, '', ' '.repeat(2), 'x'.repeat(129)]) {
    assert.throws(() => resolveContinuationBasis(versions(), projectId, run({ artifact_id }), 'result'), /正式清洁版/);
  }
});

test('selection identity and the entire selected pin participate in stale-choice detection', () => {
  const source = versions(), key = resolveContinuationBasis(source, projectId, run(), 'result').key;
  assert.equal(resolveContinuationBasis({ ...source, versions: [...source.versions].reverse() }, projectId, run(), 'result').key, key);
  for (const patch of [{ selection_revision: 10 }, { current_version_id: 'upload-version' },
    { versions: source.versions.map(v => v.run_id === 'old-run' ? { ...v, artifact_version: 8 } : v) },
    { versions: source.versions.map(v => v.run_id === 'old-run' ? { ...v, sha256: otherSha } : v) },
    { versions: source.versions.map(v => v.run_id === 'old-run' ? { ...v, artifact_id: 'another-clean' } : v) }]) {
    assert.notEqual(resolveContinuationBasis(versions(patch), projectId, run(), 'result').key, key);
  }
  for (const revision of [-1, 1.5, Number.NaN]) {
    assert.throws(() => resolveContinuationBasis(versions({ selection_revision: revision }), projectId, run(), 'current'), /当前稿状态/);
  }
  const uploadSource = versions({ current_version_id: 'upload-version', versions: [uploaded()] });
  const uploadKey = resolveContinuationBasis(uploadSource, projectId, run(), 'current').key;
  for (const patch of [{ material_id: 'other-material' }, { material_version: 4 }, { sha256: sha }]) {
    assert.notEqual(resolveContinuationBasis({ ...uploadSource, versions: [uploaded(patch)] }, projectId, run(), 'current').key, uploadKey);
  }
});

test('summary uses actual irregular periods, scope and pending status without replacing them with standard years', () => {
  const html = renderContinuationSummary(resolveContinuationBasis(versions(), projectId, run(), 'result'), fields(), [material()]);
  assert.match(html, /V2 · 旧轮清洁稿.docx · 清洁版/);
  assert.match(html, /2024-03-15 至 2024-11-20 · 一期 · 母公司口径 · 待确认/);
  assert.doesNotMatch(html, /2025-01-01|2024-01-01|已覆盖|已审计|已核验/);
  assert.match(html, /上交所 · 普通私募公司债/);
  assert.match(html, /已保存材料<\/dt><dd>1 份/);
  assert.match(html, /<details><summary>查看已保存材料（1 份）<\/summary>/);
  assert.match(html, /财务材料.pdf · 材料版本 3/);
});

test('summary preserves each entered period and distinguishes user-filled from pending values', () => {
  const draft = fields();
  draft.update_details.target_reporting_periods!.push({ start: null, end: '2025-06-30', period_kind: 'interim', scope: null, status: 'user_asserted', evidence_refs: [] });
  const html = renderContinuationSummary(resolveContinuationBasis(versions(), projectId, run(), 'current'), draft, []);
  assert.match(html, /2024-03-15 至 2024-11-20/);
  assert.match(html, /起始日待填写 至 2025-06-30 · 一期 · 口径待填写 · 用户填写/);
  assert.match(html, /尚无已保存材料/);
});

test('without a current draft the summary says issuer-material authoring and does not derive a report window', () => {
  const draft = fields(); draft.update_details.target_reporting_periods = [];
  const html = renderContinuationSummary(resolveContinuationBasis(versions({ current_version_id: null }), projectId, run(), 'current'), draft, []);
  assert.match(html, /项目尚未采用募集书，本轮按发行人材料编制/);
  assert.match(html, /尚未填写目标报告期。财务截止日：2025-12-31/);
  assert.doesNotMatch(html, /2025-01-01|2024-01-01|2023-01-01/);
  const upload = renderContinuationSummary(resolveContinuationBasis(versions({ current_version_id: 'upload-version' }), projectId, run(), 'current'), draft, []);
  assert.match(upload, /V1 · 上传原稿.pdf · 原文件/);
});

test('all externally supplied summary text is escaped including original dates, names and filenames', () => {
  const attack = '<img src=x onerror="alert(1)"> & \'quoted\'', draft = fields();
  draft.issuer_name = attack;
  draft.update_details.target_reporting_periods![0].start = attack;
  const selected = generated({ filename: attack }), basis = resolveContinuationBasis(versions({ versions: [selected], current_version_id: selected.version_id }), projectId, run(), 'result');
  const html = renderContinuationSummary(basis, draft, [material({ filename: attack })]);
  assert.doesNotMatch(html, /<img|onerror="|<script/);
  assert.equal(html.split('&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &#39;quoted&#39;').length - 1, 4);
});
