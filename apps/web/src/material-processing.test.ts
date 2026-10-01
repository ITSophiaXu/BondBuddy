import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { ApiClient, ApiError, type Dto } from './api.js';
import { MaterialProcessing, materialProcessingKey } from './material-processing.js';

const material: Dto<'MaterialResponse'> = { material_id: 'material-a', material_version: 1, sha256: 'a'.repeat(64), role: 'historical', filename: 'synthetic.docx', upload_id: 'upload-a', media_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', byte_size: 1024, state: 'persisted', persisted_at: '2026-09-25T00:00:00Z', error: null };
const job: Dto<'MaterialParseJobResponse'> = { job_id: 'job-a', job_type: 'parse', subtype: 'material_parse', project_id: 'project-a', material_id: material.material_id, material_version: 1, material_sha256: material.sha256, parser_version: 'synthetic-v1', state: 'succeeded', stage: 'succeeded', completed_stages: ['parse_evidence', 'historical_profile'], attempts: 1, max_attempts: 3, error_code: null, outcome: 'parsed', parse_status: 'parsed', profile_version: 1, pending_capabilities: [], updated_at: material.persisted_at };
const provenance = { material_id: material.material_id, material_version: 1, method: 'native_text' as const, extractor_version: 'synthetic-v1', evidence_refs: ['evidence-a'] };
const field = <T>(value: T) => ({ value, raw_value: '合成原文 <script>neverRun()</script>', provenance, uncertainty: [], status: 'recognized' as const });
const profile: Dto<'RecognitionResponse'> = { material_id: material.material_id, material_version: 1, profile_version: 1, state: 'ready', source_market: field('nafmii'), source_offering: field('dfi'), latest_reporting_cutoff: field('2025-12-31'), reporting_periods: [{ start: '2025-01-01', end: '2025-12-31', period_kind: 'annual', scope: 'consolidated', raw_value: null, provenance, uncertainty: [], status: 'recognized' }] };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function setup(t: TestContext, overrides: Partial<ConstructorParameters<typeof MaterialProcessing>[0]> = {}) {
  const reader = { material: async () => material, materialParseJob: async () => job, ...overrides };
  const controller = new MaterialProcessing(reader, 'project-a', () => {});
  t.after(() => controller.dispose());
  return controller;
}

test('pending evidence remains unchanged and is neither requested nor rendered by the upload view', async t => {
  const uncertainJob = { ...job, outcome: 'needs_confirmation' as const, parse_status: 'needs_confirmation' as const };
  const before = structuredClone(uncertainJob);
  let profileReads = 0, corrections = 0;
  const reader = { material: async () => material, materialParseJob: async () => uncertainJob,
    sourceProfile: async () => { profileReads++; return profile; },
    correctSourceProfile: async () => { corrections++; return profile; } };
  const controller = new MaterialProcessing(reader, 'project-a', () => {});
  t.after(() => controller.dispose());
  controller.sync([material]); await tick();
  assert.match(controller.render(material), /处理完成/);
  assert.doesNotMatch(controller.render(material), /历史稿信息|证据|native_text|script|核对|校正|确认|source-profile|textarea|input/);
  controller.refresh(); await tick();
  assert.equal(profileReads, 0); assert.equal(corrections, 0);
  assert.deepEqual(uncertainJob, before);
});

test('wrong project, material, version or hash never presents another job as complete', async t => {
  for (const invalid of [{ ...job, material_version: 2 }, { ...job, material_sha256: 'b'.repeat(64) },
    { ...job, project_id: 'foreign' }, { ...job, material_id: 'foreign' }]) {
    const controller = setup(t, { materialParseJob: async () => invalid }); controller.sync([material]); await tick();
    assert.match(controller.render(material), /处理状态暂不可用/);
    assert.doesNotMatch(controller.render(material), /处理完成/);
  }
});

test('read errors clear prior success, refresh recovers and 404 distinguishes saved files from lost access', async t => {
  let mode = 'ok';
  const controller = setup(t, { materialParseJob: async () => { if (mode !== 'ok') throw new ApiError(mode === 'network' ? 503 : 404, 'DATA_UNAVAILABLE'); return job; },
    material: async () => { if (mode === 'lost') throw new ApiError(404, 'NOT_FOUND'); return material; } });
  controller.sync([material]); await tick(); mode = 'network'; controller.refresh(); await tick();
  assert.match(controller.render(material), /文件保存不受影响/); assert.doesNotMatch(controller.render(material), /处理完成/);
  mode = 'legacy'; controller.refresh(); await tick(); assert.match(controller.render(material), /暂未取得处理状态/);
  mode = 'lost'; controller.refresh(); await tick(); assert.match(controller.render(material), /不可访问/);
  mode = 'ok'; controller.refresh(); await tick(); assert.match(controller.render(material), /处理完成/);
});

test('durable processing states keep waiting and failures distinct from completion without technical details', async t => {
  const scenarios: [Partial<typeof job>, string][] = [
    [{ state: 'queued', attempts: 0 }, '等待处理'], [{ state: 'queued', attempts: 1 }, '等待重新处理'],
    [{ state: 'running', stage: 'claimed', completed_stages: [] }, '处理中'],
    [{ state: 'running', stage: 'historical_profile' }, '处理中'],
    [{ state: 'running', stage: 'ocr_evidence', pending_capabilities: ['ocr'] }, '处理中'],
    [{ state: 'paused', stage: 'awaiting_ocr', pending_capabilities: ['ocr'], outcome: 'pending_ocr' }, '处理暂缓'],
    [{ state: 'failed', error_code: 'MATERIAL_UNREADABLE' }, '暂时无法读取此文件'],
    [{ state: 'failed', error_code: 'MATERIAL_PARSE_TIMEOUT' }, '文件处理超时'],
    [{ state: 'cancelled' }, '处理已取消'],
    [{ state: 'succeeded', outcome: 'needs_confirmation' }, '处理完成'],
  ];
  for (const [value, expected] of scenarios) {
    const controller = setup(t, { materialParseJob: async () => ({ ...job, ...value }) }); controller.sync([material]); await tick();
    const html = controller.render(material);
    assert.ok(html.includes(expected), expected);
    assert.doesNotMatch(html, /progress|100%|OCR|evidence-|native_text|historical_profile|材料已核验|文件损坏/);
    if (value.state !== 'succeeded') assert.doesNotMatch(html, /处理完成/);
  }
});

test('deduplicates sync and refresh, bounds concurrency and abandons late responses after disposal', async t => {
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
  assert.doesNotMatch(controller.render(materials[0]!), /处理完成/);
});

test('a removed or replaced material cannot regain a stale completed state', async t => {
  let release!: (value: typeof job) => void;
  const controller = setup(t, { materialParseJob: () => new Promise(resolve => { release = resolve; }) });
  controller.sync([material]); await tick(); controller.sync([]); release(job); await tick();
  assert.doesNotMatch(controller.render(material), /处理完成/);
  controller.sync([material]); await tick(); const previousRelease = release;
  const next = { ...material, material_version: 2, sha256: 'b'.repeat(64) };
  controller.sync([next]); previousRelease(job); await tick();
  assert.doesNotMatch(controller.render(next), /处理完成/);
  controller.dispose(); release(job); await tick();
});

test('hidden pages defer reads and refresh the saved status once when visible again', async t => {
  let reads = 0;
  const controller = setup(t, { materialParseJob: async () => { reads++; return job; } });
  controller.setVisible(false); controller.sync([material]);
  assert.equal(reads, 0); controller.setVisible(true); await tick(); assert.equal(reads, 1);
  controller.refresh(materialProcessingKey(material)); await tick(); assert.equal(reads, 2);
});

test('PATCH sends the contract profile version as a decimal If-Match header', async t => {
  const previousFetch = globalThis.fetch;
  const previousDocument = globalThis.document;
  let request: { url: string; init: RequestInit } | undefined;
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { cookie: '' } });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    request = { url: String(input), init: init ?? {} };
    return new Response(JSON.stringify(profile), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
    if (previousDocument === undefined) Reflect.deleteProperty(globalThis, 'document');
    else Object.defineProperty(globalThis, 'document', { configurable: true, value: previousDocument });
  });
  const api = new ApiClient(() => {});
  await api.correctSourceProfile('project a', 'material/b', { profile_version: 12, source_market: 'szse', reason: 'synthetic', evidence_refs: ['evidence-a'] });
  assert.equal(request?.url, '/api/v1/projects/project%20a/materials/material%2Fb/source-profile');
  assert.equal(new Headers(request?.init.headers).get('If-Match'), '12');
  assert.equal(request?.init.method, 'PATCH');
});
