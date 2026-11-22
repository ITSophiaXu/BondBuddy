// Explicit opt-in local integration harness. Real HTTP/auth/PostgreSQL; synthetic workload only.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {Pool} from 'pg';
import argon2 from 'argon2';
import {chromium} from '@playwright/test';
import {passwordOptions} from '../../api/dist/auth.js';
import {grantOperator} from '../../api/dist/log-ops.js';
import {withPerformanceTrace, withPerformanceSpan, flushPerformanceTraces} from '../../api/dist/performance-trace.js';

const connection = process.env.BB_PERFORMANCE_UI_DATABASE_URL;
if (!connection) throw Error('Set BB_PERFORMANCE_UI_DATABASE_URL to the dedicated local bb_perf_ui database.');
const target = new URL(connection);
assert.equal(target.hostname, '127.0.0.1'); assert.equal(target.port, '55415'); assert.equal(target.pathname, '/bb_perf_ui');
const origin = 'http://127.0.0.1:5175', pool = new Pool({connectionString: connection});
assert.equal((await pool.query('SELECT current_database() name')).rows[0].name, 'bb_perf_ui');
const operator = 'perf_ui_operator', viewer = 'perf_ui_viewer', password = 'PerfTest1415!Local';
const projectId = '14150000-0000-4000-8000-000000000001', runId = '14150000-0000-4000-8000-000000000002';
const evidence = resolve(process.env.BB_PERFORMANCE_UI_EVIDENCE_DIR ?? 'work/fine-step-timing-ui');
const action = process.argv[2];

if (action === 'seed') {
  const hash = 'a'.repeat(64), passwordHash = await argon2.hash(password, passwordOptions);
  for (const user of [operator, viewer]) {
    await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$1) ON CONFLICT DO NOTHING', [user]);
    await pool.query('INSERT INTO bb_password_credentials(user_id,password_hash) VALUES($1,$2) ON CONFLICT DO NOTHING', [user, passwordHash]);
  }
  if (!(await pool.query("SELECT id FROM bb_operator_grants WHERE user_id=$1 AND role='log_reader' AND revoked_at IS NULL", [operator])).rowCount)
    await grantOperator(pool, {userId: operator, role: 'log_reader', grantedBy: operator, reasonCode: 'synthetic_performance'});
  const existing = (await pool.query('SELECT id FROM bb_runs WHERE id=$1', [runId])).rowCount;
  if (!existing) {
    await pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'合成性能集成验证（非真实业务）','update') ON CONFLICT DO NOTHING", [projectId, operator]);
    await pool.query("INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids) VALUES($1,1,$2,1,$3,'{}','[]','[]') ON CONFLICT DO NOTHING", [projectId, operator, hash]);
    const created = new Date(Date.now() - 3000).toISOString(), started = new Date().toISOString();
    await pool.query("INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state,created_at) VALUES($1,$2,$3,1,$4,$1,'update',$4,'failed',$5)", [runId, operator, projectId, hash, created]);
    await withPerformanceTrace(pool, {ownerUserId: operator, projectId, runId, serviceRole: 'synthetic', releaseSha: 'e277c27a'}, async root => {
      await withPerformanceSpan('stage.execute', {stage: 'model_generation', measurement_source: 'synthetic_fixture'}, async () => {
        await withPerformanceSpan('model.workspace.prepare', {bytes_read: 4096, file_count: 2, measurement_source: 'synthetic_fixture'}, () => delay(20));
        await withPerformanceSpan('model.exec', {model_provider: 'synthetic', model_id: 'synthetic_local_work', call_id: 'synthetic_call', measurement_source: 'synthetic_fixture'}, async () => {
          await Promise.all([withPerformanceSpan('model.tool', {tool_type: 'synthetic_read'}, () => delay(50)), withPerformanceSpan('model.tool', {tool_type: 'synthetic_write'}, () => delay(30))]);
        });
        for (let i = 0; i < 205; i++) await withPerformanceSpan('synthetic.item.inspect', {item_index: i, bytes_read: 512, cache_hit: true, cache_status: 'hit'}, () => i);
        await withPerformanceSpan('document.render', {page_count: 2, output_bytes: 2048}, () => delay(25));
        try { await withPerformanceSpan('synthetic.validation', {}, () => { throw Error('synthetic_fixture_failure'); }); } catch { /* The synthetic run includes a recovered failed step. */ }
        await withPerformanceSpan('model.attempt.result.replay', {cache_hit: true, cache_status: 'reused'}, span => span.end('reused'));
      });
      root.end('failed', {error_code: 'SYNTHETIC_FAILURE'});
    });
    await flushPerformanceTraces(pool, 5000);
    const ended = new Date().toISOString();
    for (const [seq, state, when] of [[1, 'queued', created], [2, 'running', started], [3, 'failed', ended]]) {
      await pool.query("INSERT INTO bb_run_events(id,owner_user_id,run_id,seq,trace_id,type,state,stage,payload,occurred_at) VALUES($1,$2,$3,$4,$3,'run.state_changed',$5,'model_generation','{}',$6)", [randomUUID(), operator, runId, seq, state, when]);
    }
    await pool.query('UPDATE bb_runs SET event_cursor=3,updated_at=$2 WHERE id=$1', [runId, ended]);
    await pool.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state,created_at)
      SELECT $1||'-old-'||i,$2,$3,1,$4,$1||'-old-'||i,'update',$4,'queued','2026-11-01'::timestamptz FROM generate_series(1,1001) i`, [runId, operator, projectId, hash]);
  }
  const counts = (await pool.query('SELECT (SELECT count(*) FROM bb_runs) runs,(SELECT count(*) FROM bb_performance_spans WHERE run_id=$1) spans', [runId])).rows[0];
  assert(Number(counts.runs) > 1000); assert(Number(counts.spans) > 200);
  console.log(JSON.stringify({source: 'synthetic fixtures in isolated PostgreSQL', database: 'bb_perf_ui', origin, operator, runId, ...counts}));
  await pool.end();
} else if (action === 'serve') {
  const {createProductionServer} = await import('../../api/dist/server.js');
  const app = createProductionServer({pool, allowedOrigin: origin, enableRunRuntime: false});
  await app.listen({host: '127.0.0.1', port: 4315});
  console.log('Isolated performance API listening on http://127.0.0.1:4315; database bb_perf_ui; no worker.');
  const close = () => { void app.close().then(() => pool.end()); };
  process.once('SIGINT', close); process.once('SIGTERM', close);
} else if (action === 'verify') {
  await mkdir(evidence, {recursive: true});
  const browser = await chromium.launch({headless: true, channel: process.env.BB_E2E_BROWSER_CHANNEL ?? 'msedge'});
  const context = await browser.newContext({viewport: {width: 1440, height: 1000}, ignoreHTTPSErrors: true});
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const metadata = [];
  try {
    await page.goto(origin + '/admin/'); await page.locator('[data-login]').waitFor();
    await page.locator('[data-login] [name="username"]').fill(operator); await page.locator('[data-login] [name="password"]').fill(password);
    await page.locator('[data-login] button').click(); await page.locator('.workspace').waitFor({timeout: 30000});
    assert.match(await page.locator('.source-line').innerText(), /1000 \/ 1002/);
    const summaryRead = page.waitForResponse(response => response.url().includes('/admin/performance/summary') && response.status() === 200);
    await page.locator('[data-perf-filters] button[type="submit"]').click(); const summaryResponse = await summaryRead, summary = await summaryResponse.json();
    assert.equal(summary.scope.full_filtered_scope, true); assert.equal(summary.coverage.run_count, 1002); assert(summary.items.every(row => typeof row.timed_count === 'number'));
    metadata.push({kind: 'summary', audit_id: summary.audit_id, captured_at: summary.captured_at, coverage: summary.coverage, groups: summary.items.length});
    await page.locator('.perf-summary-table').waitFor(); await page.locator('[data-performance-summary]').evaluate(element => element.scrollIntoView({block: 'start'})); await page.screenshot({path: resolve(evidence, 'live-summary-desktop.png')});
    await page.locator(`[data-detail="${runId}"]`).first().click();
    const firstRead = page.waitForResponse(response => response.url().includes('/admin/performance/runs/') && response.status() === 200);
    await page.locator('[data-tab="performance"]').click(); const first = await (await firstRead).json();
    assert.equal(first.items.length, 200); assert(first.next_cursor); metadata.push({kind: 'run_first_page', audit_id: first.audit_id, captured_at: first.captured_at, loaded: first.items.length, total: first.total});
    await page.locator('[data-perf-more]').waitFor(); await page.locator('.detail-body').evaluate(element => { element.scrollTop = 0; }); await page.screenshot({path: resolve(evidence, 'live-waterfall-partial.png')});
    const nextRead = page.waitForResponse(response => response.url().includes('cursor=') && response.status() === 200);
    await page.locator('[data-perf-more]').click(); const next = await (await nextRead).json();
    assert.equal(next.next_cursor, null); metadata.push({kind: 'run_next_page', audit_id: next.audit_id, captured_at: next.captured_at, loaded: next.items.length, total: next.total});
    await page.waitForFunction(total => document.querySelectorAll('[data-perf-span]').length === total, first.total);
    await page.locator('.detail-body').evaluate(element => { element.scrollTop = 0; }); await page.screenshot({path: resolve(evidence, 'live-waterfall-complete.png')});
    const lastRow = page.locator('[data-perf-span]').last(); await lastRow.scrollIntoViewIfNeeded(); const lastBox = await lastRow.boundingBox(); assert(lastBox && lastBox.y >= 0 && lastBox.y < 1000);
    await page.screenshot({path: resolve(evidence, 'live-waterfall-last-rows.png')});
    await page.locator('.detail-body').evaluate(element => { element.scrollTop = 0; });
    const downloadEvent = page.waitForEvent('download'); await page.locator('[data-perf-export="run-json"]').click();
    await (await downloadEvent).saveAs(resolve(evidence, 'live-run-export.json'));
    await page.setViewportSize({width: 390, height: 844}); await page.screenshot({path: resolve(evidence, 'live-mobile.png')});
    const sizes = await page.evaluate(() => ({viewport: innerWidth, page: document.documentElement.scrollWidth})); assert(sizes.page <= sizes.viewport);
    const ordinary = await browser.newContext({ignoreHTTPSErrors: true}), ordinaryPage = await ordinary.newPage();
    await ordinaryPage.goto(origin + '/admin/'); await ordinaryPage.locator('[data-login]').waitFor();
    await ordinaryPage.locator('[data-login] [name="username"]').fill(viewer); await ordinaryPage.locator('[data-login] [name="password"]').fill(password);
    const deniedRead = ordinaryPage.waitForResponse(response => response.url().endsWith('/admin/inspection/snapshot') && response.status() === 404);
    await ordinaryPage.locator('[data-login] button').click(); await deniedRead;
    // The browser's localhost Secure-cookie behavior differs from Playwright's APIRequestContext.
    // Exercise the same fetch/cookie path as the actual admin client.
    assert.equal(await ordinaryPage.evaluate(async () => (await fetch('/api/v1/admin/performance/summary', {credentials: 'same-origin'})).status), 404); await ordinary.close();
    const audits = (await pool.query('SELECT count(*)::int n FROM bb_log_access_audit WHERE id=ANY($1::text[])', [metadata.map(item => item.audit_id)])).rows[0].n;
    assert.equal(audits, metadata.length); assert.deepEqual(errors, []);
    await page.setViewportSize({width: 1440, height: 1000});
    await page.goto(pathToFileURL(resolve('product-prototype/public/admin/index.html')).href); await page.locator('[data-performance-summary]').evaluate(element => element.scrollIntoView({block: 'start'})); await page.screenshot({path: resolve(evidence, 'prototype-summary-desktop.png')});
    await page.locator('[data-prototype-state="full"]').click(); await page.locator('.detail-body').evaluate(element => { element.scrollTop = 0; }); await page.screenshot({path: resolve(evidence, 'prototype-waterfall-desktop.png')});
    await page.setViewportSize({width: 390, height: 844}); await page.screenshot({path: resolve(evidence, 'prototype-mobile.png')});
    await writeFile(resolve(evidence, 'verification.json'), JSON.stringify({source: 'real HTTP authentication, API, audit and isolated PostgreSQL; synthetic tasks and local work, no model/provider call', base_commit: 'e277c27a', database: 'bb_perf_ui', origin, runId, checks: metadata, audit_rows: audits, ordinary_user_status: 404, page_errors: errors, prototype: 'product-prototype/public/admin/index.html', screenshot_dimensions: {desktop: '1440x1000', mobile: '390x844'}, list_validation: {rendered_rows: first.total, last_row_visible_after_scroll: true, virtualization: false}, screenshot_note: 'Viewport screenshots capture the fixed drawer; full inner-element screenshots include areas clipped by the scroll container and are not used for comparison.', status: 'passed'}, null, 2));
    console.log(JSON.stringify({status: 'passed', evidence, checks: metadata.length, audit_rows: audits, runId}));
  } finally { await browser.close(); await pool.end(); }
} else { await pool.end(); throw Error('Use seed, serve or verify.'); }
