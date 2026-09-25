import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, type Dto } from './api.js';
import { MaterialProcessing, materialProcessingKey } from './material-processing.js';

const material: Dto<'MaterialResponse'> = { material_id: 'material-a', material_version: 1, sha256: 'a'.repeat(64), role: 'historical', filename: 'synthetic.docx', upload_id: 'upload-a', media_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', byte_size: 1024, state: 'persisted', persisted_at: '2026-09-25T00:00:00Z', error: null };
const job: Dto<'MaterialParseJobResponse'> = { job_id: 'job-a', job_type: 'parse', subtype: 'material_parse', project_id: 'project-a', material_id: material.material_id, material_version: 1, material_sha256: material.sha256, parser_version: 'synthetic-v1', state: 'succeeded', stage: 'succeeded', completed_stages: ['parse_evidence', 'historical_profile'], attempts: 1, max_attempts: 3, error_code: null, outcome: 'parsed', parse_status: 'parsed', profile_version: 1, pending_capabilities: [], updated_at: material.persisted_at };
const provenance = { material_id: material.material_id, material_version: 1, method: 'native_text' as const, extractor_version: 'synthetic-v1', evidence_refs: ['evidence-a'] };
const field = <T>(value: T) => ({ value, raw_value: '合成原文 <script>neverRun()</script>', provenance, uncertainty: [], status: 'recognized' as const });
const profile: Dto<'RecognitionResponse'> = { material_id: material.material_id, material_version: 1, profile_version: 1, state: 'ready', source_market: field('nafmii'), source_offering: field('dfi'), latest_reporting_cutoff: field('2025-12-31'), reporting_periods: [{ start: '2025-01-01', end: '2025-12-31', period_kind: 'annual', scope: 'consolidated', raw_value: null, provenance, uncertainty: [], status: 'recognized' }] };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function setup(t: TestContext, overrides: Partial<ConstructorParameters<typeof MaterialProcessing>[0]> = {}) {
  const reader = { material: async () => material, materialParseJob: async () => job, sourceProfile: async () => profile, ...overrides };
  const controller = new MaterialProcessing(reader, 'project-a', () => {});
  t.after(() => controller.dispose());
  return controller;
}

test('renders persisted profile with source labels, periods and escaped evidence', async t => {
  const controller = setup(t); controller.sync([material]); await tick();
  const html = controller.render(material);
  for (const text of ['交易商协会', 'DFI · 储架发行', '2025-01-01 至 2025-12-31', '合并口径', '本次发行目标仍以项目表单为准', '&lt;script&gt;', '在线校正尚未开放']) assert.ok(html.includes(text), text);
  assert.ok(!html.includes('<script>'));
});

test('unknown source values and reporting periods stay unknown with raw evidence and uncertainty', async t => {
  const uncertain = { ...profile, state: 'needs_confirmation' as const, source_market: { ...profile.source_market, value: null, status: 'unknown' as const, uncertainty: ['原文涉及多个市场，需核对'] }, reporting_periods: [] };
  const controller = setup(t, { sourceProfile: async () => uncertain }); controller.sync([material]); await tick();
  const html = controller.render(material);
  assert.match(html, /源信息待确认/); assert.match(html, /原文涉及多个市场/); assert.match(html, /未识别到有依据的报告期/);
});

test('different material version/hash and foreign profile provenance cannot appear as current results', async t => {
  for (const invalid of [{ ...job, material_version: 2 }, { ...job, material_sha256: 'b'.repeat(64) }, { ...job, project_id: 'foreign' }]) {
    const controller = setup(t, { materialParseJob: async () => invalid }); controller.sync([material]); await tick();
    assert.match(controller.render(material), /处理状态暂不可用/); assert.doesNotMatch(controller.render(material), /源信息已识别/);
  }
  for (const invalid of [{ ...profile, material_version: 2 }, { ...profile, source_market: { ...profile.source_market, provenance: { ...provenance, material_id: 'foreign' } } }]) {
    const controller = setup(t, { sourceProfile: async () => invalid }); controller.sync([material]); await tick();
    assert.doesNotMatch(controller.render(material), /源信息已识别/); assert.match(controller.render(material), /历史稿信息：/);
  }
});

test('read errors clear prior profile, manual refresh recovers, and 404 distinguishes a legacy job from lost access', async t => {
  let mode = 'ok';
  const controller = setup(t, { materialParseJob: async () => { if (mode !== 'ok') throw new ApiError(mode === 'network' ? 503 : 404, 'DATA_UNAVAILABLE'); return job; }, material: async () => { if (mode === 'lost') throw new ApiError(404, 'NOT_FOUND'); return material; } });
  controller.sync([material]); await tick(); mode = 'network'; controller.refresh(); await tick();
  assert.match(controller.render(material), /文件保存不受影响/); assert.doesNotMatch(controller.render(material), /源信息已识别/);
  mode = 'legacy'; controller.refresh(); await tick(); assert.match(controller.render(material), /未找到当前版本的解析记录/);
  mode = 'lost'; controller.refresh(); await tick(); assert.match(controller.render(material), /不可访问/); assert.doesNotMatch(controller.render(material), /源信息已识别/);
  mode = 'ok'; controller.refresh(); await tick(); assert.match(controller.render(material), /源信息已识别/);
});

test('job success with unavailable profile never synthesizes history or invents correction controls', async t => {
  const controller = setup(t, { sourceProfile: async () => { throw new ApiError(409, 'CAPABILITY_NOT_READY'); } });
  controller.sync([material]); await tick();
  assert.match(controller.render(material), /识别结果暂不可用/); assert.doesNotMatch(controller.render(material), /源信息已识别|input|textarea/);
});

test('statuses are derived from durable jobs, not stale material.state', async t => {
  const scenarios: [Partial<typeof job>, string][] = [
    [{ state: 'queued', attempts: 0 }, '等待解析'], [{ state: 'queued', attempts: 1 }, '等待重新解析'],
    [{ state: 'running', stage: 'claimed', completed_stages: [] }, '正在解析内容'],
    [{ state: 'running', stage: 'historical_profile' }, '正在识别历史稿信息'],
    [{ state: 'running', stage: 'ocr_evidence', pending_capabilities: ['ocr'] }, '正在识别扫描内容（OCR）'],
    [{ state: 'paused', stage: 'awaiting_ocr', pending_capabilities: ['ocr'], outcome: 'pending_ocr' }, '等待文字识别（OCR）'],
    [{ state: 'failed', error_code: 'MATERIAL_UNREADABLE' }, '文件无法解析'], [{ state: 'cancelled' }, '解析已取消'],
    [{ state: 'succeeded', outcome: 'needs_confirmation' }, '有待确认项'],
  ];
  for (const [value, expected] of scenarios) {
    const controller = setup(t, { materialParseJob: async () => ({ ...job, ...value }) }); controller.sync([material]); await tick();
    assert.ok(controller.render(material).includes(expected), expected); assert.doesNotMatch(controller.render(material), /progress|100%/);
  }
});

test('deduplicates repeated sync/refresh, caps concurrent reads and abandons late responses on disposal', async t => {
  const pending: (() => void)[] = []; const signals: AbortSignal[] = [];
  const controller = setup(t, { materialParseJob: async (_p, id, signal) => {
    signals.push(signal!); await new Promise<void>(resolve => pending.push(resolve)); return { ...job, material_id: id };
  } });
  const materials = Array.from({ length: 6 }, (_, i) => ({ ...material, material_id: `m-${i}`, role: 'audit' as const }));
  controller.sync(materials); controller.sync(materials); controller.refresh();
  assert.equal(pending.length, 3);
  pending[0]!(); await tick(); assert.equal(pending.length, 4);
  controller.dispose(); assert.ok(signals.slice(1).every(signal => signal.aborted));
  pending.forEach(resolve => resolve()); await tick();
  assert.doesNotMatch(controller.render(materials[0]!), /解析完成/);
});

test('a removed version and disposed project cannot be restored by late profile responses', async t => {
  let release!: (value: typeof profile) => void;
  const controller = setup(t, { sourceProfile: () => new Promise(resolve => { release = resolve; }) });
  controller.sync([material]); await tick(); controller.sync([]); release(profile); await tick();
  assert.doesNotMatch(controller.render(material), /源信息已识别/);
  controller.sync([material]); await tick(); controller.dispose(); release(profile); await tick();
  assert.doesNotMatch(controller.render(material), /源信息已识别/);
});

test('hidden pages defer reads and resume only once; nonhistorical materials do not request source profiles', async t => {
  let reads = 0;
  const controller = setup(t, { materialParseJob: async () => { reads++; return job; }, sourceProfile: async () => { throw new Error('Must not be requested for audit'); } });
  controller.setVisible(false); const audit = { ...material, role: 'audit' as const }; controller.sync([audit]);
  assert.equal(reads, 0); controller.setVisible(true); await tick(); assert.equal(reads, 1);
  controller.refresh(materialProcessingKey(audit)); await tick(); assert.equal(reads, 2);
  assert.doesNotMatch(controller.render(audit), /历史稿信息：/);
});
