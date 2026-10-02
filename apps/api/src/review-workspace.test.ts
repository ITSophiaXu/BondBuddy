// Synthetic inputs on a real PostgreSQL 16 database. No model response is claimed here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { createServer } from './server.js';
import { isolatedTestDatabase } from './test-database.js';
import { digest, uid } from './data.js';
import { inputManifestHash } from './production-rule-pin.js';
import type { ReviewReport } from '@bondbuddy/contracts';

const connection = await isolatedTestDatabase(undefined, 'm3-workspace');
test('M3 ownership, independent drafts, idempotency, immutable input, mutex and failed version history', { skip: !connection }, async () => {
  const pool = new Pool({ connectionString: connection });
  let active = 'synthetic-m3-owner';
  const origin = 'http://bondbuddy.test';
  const app = createServer({ pool, principal: async () => ({ userId: active, csrfVerified: true }), allowedOrigin: origin });
  const send = (method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, headers: { origin }, payload: payload as any });
  const ok = (response: { statusCode: number; body: string }) => assert.ok(response.statusCode >= 200 && response.statusCode < 300, response.body);
  try {
    const created = await send('POST', '/api/v1/projects', { name: 'Synthetic M3', kind: 'review', issuer_name: null, market: null, offering: null }); ok(created);
    const id = created.json().project_id, base = `/api/v1/projects/${id}`, mat = uid(), upload = uid(), sha = digest('synthetic source');
    await pool.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
      VALUES($1,$2,$3,'synthetic.pdf','application/pdf',16,$4,'historical',$5,now()+interval '1 hour','completed')`, [upload, active, id, sha, `synthetic/${upload}`]);
    await pool.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
      VALUES($1,1,$2,$3,$4,'historical','synthetic.pdf','application/pdf',16,$5,$6,'persisted')`, [mat, active, id, upload, sha, `synthetic-material/${mat}`]);
    const pin = { material_id: mat, material_version: 1, sha256: sha };
    const input = { source_material_ref: pin, material_versions: [pin], requirements: ['原要求'], as_of: null, evidence_links: [] };
    const first = await send('PUT', `${base}/review-draft`, { kind: 'input', expected_version: 0, input }); ok(first);
    const context = { project_id: id, report_id: null, finding_ids: [], material_refs: [pin] };
    ok(await send('PUT', `${base}/review-draft`, { kind: 'message', expected_version: 0, context, content: '未发送文本' }));
    assert.equal((await send('GET', `${base}/review-workspace`)).json().draft.version, 1, 'unsent draft cannot change execution input version');
    const message = { submission_request_id: uid(), content: '请解释口径', context };
    const sent = await send('POST', `${base}/review-messages`, message); ok(sent);
    assert.equal((await send('POST', `${base}/review-messages`, message)).json().message.message_id, sent.json().message.message_id);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_runs WHERE project_id=$1', [id])).rows[0].n, 0, 'sending does not execute');
    assert.equal((await send('GET', `${base}/review-workspace`)).json().message_drafts[0].content, '未发送文本', 'sending never overwrites an unsent draft');
    const execute = { execution_request_id: uid(), operation: 'full_review', expected_input_version: 1, source_report_id: null, expected_plan_version: null, finding_ids: [] };
    const concurrent = await Promise.all([send('POST', `${base}/review-executions`, execute), send('POST', `${base}/review-executions`, execute)]);
    concurrent.forEach(ok); assert.equal(concurrent[0]!.json().run_id, concurrent[1]!.json().run_id);
    const run = concurrent[0]!.json();
    assert.equal((await send('POST', `${base}/review-executions`, { ...execute, execution_request_id: uid() })).statusCode, 409);
    const old = (await pool.query('SELECT manifest,input_hash FROM bb_input_revisions WHERE project_id=$1 AND revision=$2', [id, run.input_revision])).rows[0];
    ok(await send('PUT', `${base}/review-draft`, { kind: 'input', expected_version: 1, input: { ...input, requirements: ['下轮要求'] } }));
    const locked = (await pool.query('SELECT manifest,input_hash FROM bb_input_revisions WHERE project_id=$1 AND revision=$2', [id, run.input_revision])).rows[0];
    assert.deepEqual(locked, old); assert.equal(inputManifestHash(locked.manifest), locked.input_hash.trim());
    assert.deepEqual(locked.manifest.review.input.requirements, ['原要求']);
    assert.equal((await send('PUT', `${base}/review-draft`, { kind: 'input', expected_version: 1, input })).statusCode, 409);
    await pool.query("UPDATE bb_runs SET state='cancelled' WHERE id=$1", [run.run_id]);
    const second = await send('POST', `${base}/review-executions`, { ...execute, execution_request_id: uid(), expected_input_version: 2 }); ok(second);
    await pool.query("UPDATE bb_runs SET state='failed' WHERE id=$1", [second.json().run_id]);
    const history = (await send('GET', `${base}/review-history`)).json().items;
    assert.deepEqual(history.map((h: any) => [h.version, h.run.state]), [[2, 'failed'], [1, 'cancelled']]);
    assert.deepEqual(history[1].input.requirements, ['原要求']);
    const workspace = (await send('GET', `${base}/review-workspace`)).json();
    assert.equal(workspace.plan, null); assert.equal(workspace.messages.length, 1);
    assert.ok(!JSON.stringify(workspace).includes('recharge'));
    active = 'synthetic-other-owner';
    for (const route of ['review-workspace', 'review-history', 'review-draft']) assert.equal((await send('GET', `${base}/${route}`)).statusCode, 404);
    assert.equal((await send('POST', `${base}/review-executions`, execute)).statusCode, 404);
    active = 'synthetic-m3-owner';
    const report: ReviewReport = { report_id: uid(), project_id: id, run_id: run.run_id, input_revision: 1, version: 1, source_material: pin,
      scope: { mode: 'full_review', finding_ids: [] }, findings: [], coverage: [], limitations: ['synthetic empty report'], created_at: new Date().toISOString() };
    await pool.query('INSERT INTO bb_review_reports(id,owner_user_id,project_id,run_id,version,content_sha256,report) VALUES($1,$2,$3,$4,1,$5,$6)', [report.report_id, active, id, run.run_id, inputManifestHash(report), report]);
    assert.equal((await send('GET', `${base}/review-workspace`)).json().selected_report, null,
      'a persisted report from a cancelled/failed delivery is not the default completed result');
    assert.equal((await send('GET', `${base}/review-workspace?report_id=${report.report_id}`)).json().selected_report.report_id, report.report_id,
      'historical report snapshots remain explicitly addressable');
    const plan = await send('PUT', `${base}/revision-plan`, { expected_version: 0, source_report_id: report.report_id, finding_ids: [], excluded_findings: [], requirements: [] }); ok(plan);
    const emptyRevision = await send('POST', `${base}/review-executions`, { ...execute, execution_request_id: uid(), operation: 'revision', expected_input_version: 2, source_report_id: report.report_id, expected_plan_version: 1 });
    assert.equal(emptyRevision.statusCode, 422);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_runs WHERE project_id=$1', [id])).rows[0].n, 2);
    await assert.rejects(pool.query("UPDATE bb_review_reports SET report='{}' WHERE id=$1", [report.report_id]), /immutable/);
    await assert.rejects(pool.query("UPDATE bb_review_revision_plans SET plan='{}' WHERE id=$1", [plan.json().plan_id]), /immutable/);
  } finally { await app.close(); await pool.end(); }
});
