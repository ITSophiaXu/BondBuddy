import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));

// #6/#7/#8/#79 acceptance evidence on a deployed staging stack. Synthetic accounts and files only.
const base = process.env.BB_STAGING_URL ?? '';
const terms = process.env.BB_TERMS_VERSION ?? '';
const out = resolve(__dirname, process.env.BB_EVIDENCE_DIR ?? '../evidence/local');
const composeDir = resolve(__dirname, '..');
const envFile = process.env.BB_ENV_FILE ?? `${composeDir}/.env`;
const composeFiles = ['-f', `${composeDir}/compose.yaml`, ...(process.env.BB_PROFILE === 'prod' ? ['-f', `${composeDir}/compose.prod.yaml`] : [])];
const compose = (...args: string[]) => execFileSync('docker', ['compose', '--project-directory', composeDir, '--env-file', envFile, ...composeFiles, ...args], { encoding: 'utf8', env: { ...process.env } });
const forbidden = (process.env.BB_FORBIDDEN_STRINGS ?? '').split('\n').filter(s => s.length >= 8);
mkdirSync(out, { recursive: true });

type Item = { issue: string; item: string; result: 'pass' | 'fail' | 'partial' | 'not_provable'; evidence: string; detail?: unknown };
const results: Item[] = [];
const record = (i: Item) => { results.push(i); };
const shot = (page: Page, name: string) => page.screenshot({ path: `${out}/${name}.png` });
const newUser = () => ({ username: `stg_${randomUUID().replaceAll('-', '').slice(0, 20)}`, password: `Synthetic-${randomUUID()}` });

async function api(page: Page, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return page.evaluate(async ({ method, path, body, headers }) => {
    const csrf = document.cookie.split('; ').find(v => v.startsWith('bb_csrf='))?.slice(8) ?? '';
    const h: Record<string, string> = { ...headers };
    if (method !== 'GET') h['X-BB-CSRF'] = csrf;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const r = await fetch(path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
    const text = await r.text();
    let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, json, headers: Object.fromEntries(r.headers.entries()) };
  }, { method, path, body, headers });
}
async function register(page: Page, user: { username: string; password: string }) {
  await page.goto('/');
  return api(page, 'POST', '/api/v1/auth/register', { username: user.username, password: user.password, accepted_terms_version: terms });
}
async function uiLogin(page: Page, user: { username: string; password: string }) {
  await page.goto('/');
  await page.getByLabel('用户名', { exact: true }).fill(user.username);
  await page.getByLabel('密码', { exact: true }).fill(user.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '我的项目', exact: true })).toBeVisible();
}
async function uiCreateProject(page: Page, name: string) {
  await page.goto('/#/new');
  await page.getByLabel('项目名称 必填', { exact: true }).fill(name);
  await page.getByRole('button', { name: '创建并保存项目' }).click();
  await expect(page).toHaveURL(/#\/projects\//);
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  return decodeURIComponent(new URL(page.url()).hash.split('/').at(-1)!);
}
async function uiUpload(page: Page, projectId: string, file: { name: string; mimeType: string; buffer: Buffer }) {
  const completed = page.waitForResponse(r => r.url().includes(`/projects/${projectId}/materials/uploads/`) && r.url().endsWith('/complete') && r.request().method() === 'POST');
  await page.getByLabel('为审计报告（可含报表及附注）选择文件').setInputFiles(file);
  const response = await completed;
  return { status: response.status(), json: await response.json() };
}
async function freshContext(browser: Browser) { return browser.newContext({ baseURL: base }); }

let browserRef: Browser;
let a = newUser(), b = newUser();
let ctxA: BrowserContext, pageA: Page;
const ids: Record<string, string> = {};
let docx: Buffer; let DOCX = '';

test.describe.configure({ mode: 'serial' });
test.beforeAll(async ({ browser }) => {
  if (!base.startsWith('https://') || !terms) throw new Error('BB_STAGING_URL (https) and BB_TERMS_VERSION are required');
  browserRef = browser;
  const samples = await import(resolve(__dirname, '../../../apps/api/dist/upload-safety.samples.js'));
  docx = await samples.docxSample(); DOCX = samples.DOCX;
});
test.afterAll(async () => {
  writeFileSync(`${out}/results.json`, `${JSON.stringify({ base_url: base, generated_at: new Date().toISOString(), synthetic: true, results }, null, 1)}\n`);
});

test('#7 register, login, cookie flags over TLS', async () => {
  ctxA = await freshContext(browserRef); pageA = await ctxA.newPage();
  const reg = await register(pageA, a);
  const dup = await api(pageA, 'POST', '/api/v1/auth/register', { username: a.username.toUpperCase(), password: a.password, accepted_terms_version: terms });
  await api(pageA, 'POST', '/api/v1/auth/logout', {});
  await ctxA.clearCookies();
  await uiLogin(pageA, a);
  await shot(pageA, '07-login-projects');
  const cookies = (await ctxA.cookies()).filter(c => c.name.startsWith('bb_')).map(c => ({ name: c.name, secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite, path: c.path }));
  const session = cookies.filter(c => c.name !== 'bb_csrf');
  const ok = reg.status === 201 && session.length >= 1 && session.every(c => c.secure && c.httpOnly && c.sameSite === 'Strict')
    && cookies.every(c => c.secure && c.sameSite === 'Strict');
  record({ issue: '#7', item: 'username/password register + UI login over HTTPS; Secure/HttpOnly/SameSite=Strict session cookies', result: ok ? 'pass' : 'fail', evidence: '07-login-projects.png, results.json', detail: { register_status: reg.status, cookies, csrf_cookie_note: 'bb_csrf is intentionally readable by JS (double-submit), still Secure+Strict' } });
  record({ issue: '#7', item: 'duplicate username (case-normalised) is rejected with a stable code', result: dup.status === 409 && dup.json?.code === 'IDEMPOTENCY_CONFLICT' ? 'pass' : 'fail', evidence: 'results.json', detail: { status: dup.status, code: dup.json?.code } });
  expect(ok).toBe(true);
});

test('#6 upload DOCX, close browser, job keeps going server-side, reopen shows persisted state', async () => {
  ids.projectA = await uiCreateProject(pageA, `Staging synthetic A ${a.username}`);
  compose('stop', 'worker'); // make the queued state observable before the browser goes away
  let parseBefore: any, parseAfter: any;
  try {
    const up = await uiUpload(pageA, ids.projectA, { name: 'synthetic-audit.docx', mimeType: DOCX, buffer: docx });
    expect(up.status).toBe(200);
    ids.materialA = up.json.material_id; ids.materialVersionA = String(up.json.material_version);
    await expect(pageA.locator('.material-file-row').filter({ hasText: 'synthetic-audit.docx' })).toContainText('服务器已确认保存');
    await shot(pageA, '06-upload-saved');
    parseBefore = (await api(pageA, 'GET', `/api/v1/projects/${ids.projectA}/materials/${ids.materialA}/parse-job`)).json;
    await ctxA.close();                      // user closes the browser while the job is queued
  } finally { compose('start', 'worker'); }
  const deadline = Date.now() + 90_000;
  ctxA = await freshContext(browserRef); pageA = await ctxA.newPage();
  await uiLogin(pageA, a);
  do {
    parseAfter = (await api(pageA, 'GET', `/api/v1/projects/${ids.projectA}/materials/${ids.materialA}/parse-job`)).json;
    if (parseAfter && !['queued', 'running'].includes(parseAfter.state)) break;
    await pageA.waitForTimeout(3000);
  } while (Date.now() < deadline);
  await pageA.goto(`/#/projects/${encodeURIComponent(ids.projectA)}`);
  await expect(pageA.locator('.persisted-material')).toContainText('synthetic-audit.docx');
  await shot(pageA, '06-reopened-recovered');
  const progressed = parseBefore?.state === 'queued' && parseAfter && parseAfter.state !== 'queued';
  record({ issue: '#6', item: 'closing the tab does not cancel the server-side job; re-login shows progressed, persisted state', result: progressed ? 'pass' : 'fail', evidence: '06-upload-saved.png, 06-reopened-recovered.png, results.json', detail: { before_close: pick(parseBefore), after_reopen: pick(parseAfter), note: 'worker paused during upload so the queued state is observable; job resumed after the browser context was closed' } });
  expect(progressed).toBe(true);
});
const pick = (j: any) => j && { state: j.state, stage: j.stage, attempts: j.attempts, error_code: j.error_code ?? j.error?.code ?? null, updated_at: j.updated_at };

test('#6 no provider key or server secret in served assets; no Node/CLI in the browser', async () => {
  const page = pageA;
  const seen: { url: string; body: string }[] = [];
  page.on('response', async r => { try { if (r.url().startsWith(base)) seen.push({ url: r.url(), body: await r.text() }); } catch { /* redirects/binaries */ } });
  await page.goto('/'); await page.goto(`/#/projects/${encodeURIComponent(ids.projectA)}`);
  await expect(page.locator('.persisted-material')).toContainText('synthetic-audit.docx');
  await page.goto('/#/account'); await page.waitForTimeout(1000);
  const html = await (await page.request.get('/')).text();
  const assets = [...new Set(html.match(/\/assets\/[^"']+/g) ?? [])];
  const bundles = await Promise.all(assets.map(async p => ({ url: p, body: await (await page.request.get(p)).text() })));
  const patterns = [/sk-[A-Za-z0-9]{16,}/, /DEEPSEEK_API_KEY/, /AccountKey=/, /BB_CODEX_/, /POSTGRES_PASSWORD/, /postgresql:\/\//];
  const hits: string[] = [];
  for (const doc of [...bundles, ...seen, { url: '/', body: html }]) {
    for (const p of patterns) if (p.test(doc.body)) hits.push(`${doc.url}: ${p}`);
    for (const s of forbidden) if (doc.body.includes(s)) hits.push(`${doc.url}: <configured secret value>`);
  }
  const runtime = await page.evaluate(() => ({ process: typeof (globalThis as any).process, require: typeof (globalThis as any).require, Buffer: typeof (globalThis as any).Buffer }));
  record({ issue: '#6', item: 'web works with only a browser (no Node/Python/CLI); no provider key/secret in bundle or API responses', result: hits.length === 0 && runtime.process === 'undefined' && runtime.require === 'undefined' ? 'pass' : 'fail', evidence: 'results.json', detail: { assets_scanned: bundles.length, responses_scanned: seen.length, configured_secret_values_checked: forbidden.length, hits, browser_globals: runtime } });
  expect(hits).toEqual([]);
});

test('#6 product copy on upload scope, cloud processing, storage and deletion', async () => {
  const page = pageA;
  await page.goto(`/#/projects/${encodeURIComponent(ids.projectA)}`);
  await expect(page.locator('.persisted-material')).toBeVisible();
  const projectText = await page.locator('body').innerText();
  await page.goto('/#/account'); await page.waitForTimeout(800);
  const accountText = await page.locator('body').innerText();
  await shot(page, '06-account-policy-copy');
  const find = (text: string, words: string[]) => text.split('\n').filter(l => words.some(w => l.includes(w))).slice(0, 8);
  const upload = find(projectText, ['格式', 'MB', '上传', '服务器']);
  const storage = find(projectText + '\n' + accountText, ['云', '服务器', '存储', '保存期限', '保留']);
  const deletion = find(projectText + '\n' + accountText, ['删除', '注销', '清理']);
  const localOnlyClaim = /只(保存|存储|存在)(在)?本(机|地)/.test(projectText + accountText);
  const hasAll = upload.length > 0 && storage.length > 0 && deletion.length > 0 && !localOnlyClaim;
  record({ issue: '#6', item: 'explicit product copy for upload scope, cloud processing, retention and deletion; no "originals stay on this machine" claim', result: hasAll ? 'partial' : 'fail', evidence: '06-account-policy-copy.png, results.json', detail: { upload_copy: upload, storage_copy: storage, deletion_copy: deletion, local_only_claim: localOnlyClaim, note: 'Upload limits, the server-side account-isolated copy and deletion/closure effects are stated. Retention periods, deletion deadlines and backup purge are explicitly marked as not yet published, because #8 retention values are unset. Partial until those values are decided.' } });
});

test('#8 isolation: B guessing A project/material/artifact/run IDs gets 404', async () => {
  const ctxB = await freshContext(browserRef); const pageB = await ctxB.newPage();
  expect((await register(pageB, b)).status).toBe(201);
  const probes: Record<string, number> = {};
  for (const [k, p] of Object.entries({
    project: `/api/v1/projects/${ids.projectA}`,
    material: `/api/v1/projects/${ids.projectA}/materials/${ids.materialA}`,
    material_download: `/api/v1/projects/${ids.projectA}/materials/${ids.materialA}/download`,
    parse_job: `/api/v1/projects/${ids.projectA}/materials/${ids.materialA}/parse-job`,
    events: `/api/v1/projects/${ids.projectA}/events`,
    artifact_guess: `/api/v1/artifacts/${randomUUID()}`,
    artifact_download_guess: `/api/v1/artifacts/${randomUUID()}/download?grant=${randomUUID()}`,
    run_guess: `/api/v1/runs/${randomUUID()}`,
  })) probes[k] = (await api(pageB, 'GET', p)).status;
  probes.patch_project = (await api(pageB, 'PATCH', `/api/v1/projects/${ids.projectA}`, { name: 'x' }, { 'If-Match': '1' })).status;
  probes.delete_material = (await api(pageB, 'DELETE', `/api/v1/projects/${ids.projectA}/materials/${ids.materialA}`)).status;
  await pageB.goto(`/#/projects/${encodeURIComponent(ids.projectA)}`); await pageB.waitForTimeout(1500);
  await shot(pageB, '08-b-cannot-open-a-project');
  const listB = (await api(pageB, 'GET', '/api/v1/projects')).json;
  const all404 = Object.values(probes).every(s => s === 404);
  record({ issue: '#8', item: "guessing another account's project/material/artifact IDs cannot enumerate or download (404)", result: all404 ? 'pass' : 'fail', evidence: '08-b-cannot-open-a-project.png, results.json', detail: { probes, b_project_count: listB?.items?.length ?? listB?.projects?.length ?? null, note: 'A has no artifact (model disabled in staging), so artifact probes use guessed IDs; owner-scoped artifact reads are covered by API tests.' } });
  await ctxB.close();
  expect(all404).toBe(true);
});

test('#8 snapshot immutability, duplicate upload reuse, edit conflict code', async () => {
  const page = pageA;
  const p0 = (await api(page, 'GET', `/api/v1/projects/${ids.projectA}`)).json;
  const snap = await api(page, 'POST', `/api/v1/projects/${ids.projectA}/input-revisions`, { draft_revision: p0.draft_revision, material_versions: [{ material_id: ids.materialA, material_version: Number(ids.materialVersionA) }], requirement_message_ids: [] });
  const rev = snap.json?.input_revision ?? snap.json?.revision;
  const edit = await api(page, 'PATCH', `/api/v1/projects/${ids.projectA}`, { name: `Edited after snapshot ${a.username}` }, { 'If-Match': String(p0.draft_revision) });
  const stale = await api(page, 'PATCH', `/api/v1/projects/${ids.projectA}`, { name: 'stale edit' }, { 'If-Match': String(p0.draft_revision) });
  const again = await api(page, 'GET', `/api/v1/projects/${ids.projectA}/input-revisions/${rev}`);
  const p1 = (await api(page, 'GET', `/api/v1/projects/${ids.projectA}`)).json;
  const unchanged = snap.status === 201 && again.status === 200 && again.json?.input_hash === snap.json?.input_hash
    && JSON.stringify(again.json) === JSON.stringify(snap.json) && p1?.name?.startsWith('Edited after snapshot') && p1.draft_revision === p0.draft_revision + 1;
  record({ issue: '#8', item: 'editing the draft after a run snapshot does not change the snapshot', result: unchanged && edit.status === 200 ? 'pass' : 'fail', evidence: 'results.json', detail: { snapshot_status: snap.status, revision: rev, input_hash_before: snap.json?.input_hash, input_hash_after_edit: again.json?.input_hash, edit_status: edit.status, draft_revision_before: p0.draft_revision, draft_revision_after: p1?.draft_revision, snapshot_draft_revision: again.json?.draft_revision, snapshot_response_identical: JSON.stringify(again.json) === JSON.stringify(snap.json) } });
  record({ issue: '#8', item: 'edit conflict returns a stable error code', result: stale.status === 409 && stale.json?.code === 'INPUT_REVISION_CONFLICT' ? 'pass' : 'fail', evidence: 'results.json', detail: { status: stale.status, code: stale.json?.code } });
  // duplicate create: upload identical bytes again through the UI -> same material/version
  await page.goto(`/#/projects/${encodeURIComponent(ids.projectA)}`);
  const dup = await uiUpload(page, ids.projectA, { name: 'synthetic-audit-renamed.docx', mimeType: DOCX, buffer: docx });
  await shot(page, '08-duplicate-upload-reused');
  const same = dup.status === 200 && dup.json.material_id === ids.materialA && String(dup.json.material_version) === ids.materialVersionA;
  // execute: model disabled -> explicit not-ready, never success
  const exec = await api(page, 'POST', '/api/v1/runs/execute', { execution_request_id: randomUUID(), project_id: ids.projectA, input_revision: rev, input_hash: snap.json?.input_hash, task_kind: p0.kind, input_manifest_ref: randomUUID(), storage_origin: 'cloud', workspace_id: randomUUID() });
  record({ issue: '#8', item: 'duplicate create (same bytes re-uploaded) returns the same resource', result: same ? 'pass' : 'fail', evidence: '08-duplicate-upload-reused.png, results.json', detail: { first: { material_id: ids.materialA, version: ids.materialVersionA }, duplicate: { material_id: dup.json.material_id, version: dup.json.material_version } } });
  record({ issue: '#6/#17', item: 'run submission with model disabled shows explicit not-ready (no fake success)', result: exec.status >= 500 && exec.json?.code === 'CAPABILITY_NOT_READY' ? 'pass' : 'fail', evidence: 'results.json', detail: { status: exec.status, code: exec.json?.code } });
  ids.snapshotRevision = String(rev); ids.snapshotHash = snap.json?.input_hash;
  writeFileSync(`${out}/raw/ids.json`, JSON.stringify({ ...ids, a: a.username }));
});

test('#7 logout revokes the session; revoked cookies cannot read materials', async () => {
  const cookies = await ctxA.cookies();
  const before = (await api(pageA, 'GET', `/api/v1/projects/${ids.projectA}/materials/${ids.materialA}`)).status;
  await pageA.goto('/'); await pageA.getByRole('button', { name: '退出' }).click();
  await expect(pageA.getByRole('button', { name: '登录', exact: true })).toBeVisible();
  await shot(pageA, '07-logged-out');
  const replay = await freshContext(browserRef); await replay.addCookies(cookies);
  const rp = await replay.newPage(); await rp.goto('/');
  const after = await api(rp, 'GET', `/api/v1/projects/${ids.projectA}/materials/${ids.materialA}`);
  const dl = await api(rp, 'GET', `/api/v1/projects/${ids.projectA}/materials/${ids.materialA}/download`);
  const refresh = await api(rp, 'POST', '/api/v1/auth/refresh', {});
  await replay.close();
  const ok = before === 200 && after.status === 401 && dl.status === 401 && refresh.status === 401;
  record({ issue: '#7', item: 'logout revokes the session; replaying the old cookies cannot read or download materials', result: ok ? 'pass' : 'fail', evidence: '07-logged-out.png, results.json', detail: { before_logout: before, replayed_read: after.status, replayed_download: dl.status, replayed_refresh: refresh.status } });
  expect(ok).toBe(true);
});

test('#8 backup -> destructive change -> restore drill preserves data (PostgreSQL + Blob)', async () => {
  const ctx = await freshContext(browserRef); const page = await ctx.newPage();
  await uiLogin(page, a);
  const sha = () => page.evaluate(async path => { const r = await fetch(path); if (!r.ok) return `status:${r.status}`; const d = await crypto.subtle.digest('SHA-256', await r.arrayBuffer()); return [...new Uint8Array(d)].map(x => x.toString(16).padStart(2, '0')).join(''); }, `/api/v1/projects/${ids.projectA}/materials/${ids.materialA}/download`);
  const original = await sha();
  const backupDir = execFileSync(resolve(composeDir, 'scripts/backup.sh'), ['acceptance-drill'], { encoding: 'utf8' }).trim().split('\n').at(-1)!;
  const del = await api(page, 'DELETE', `/api/v1/projects/${ids.projectA}/materials/${ids.materialA}`);
  const gone = (await api(page, 'GET', `/api/v1/projects/${ids.projectA}/materials/${ids.materialA}`)).status;
  await ctx.close();
  execFileSync(resolve(composeDir, 'scripts/restore.sh'), [backupDir], { encoding: 'utf8' });
  const ctx2 = await freshContext(browserRef); const p2 = await ctx2.newPage();
  await uiLogin(p2, a);
  const restored = (await api(p2, 'GET', `/api/v1/projects/${ids.projectA}/materials/${ids.materialA}`)).status;
  const restoredSha = await p2.evaluate(async path => { const r = await fetch(path); if (!r.ok) return `status:${r.status}`; const d = await crypto.subtle.digest('SHA-256', await r.arrayBuffer()); return [...new Uint8Array(d)].map(x => x.toString(16).padStart(2, '0')).join(''); }, `/api/v1/projects/${ids.projectA}/materials/${ids.materialA}/download`);
  const snap = await api(p2, 'GET', `/api/v1/projects/${ids.projectA}/input-revisions/${ids.snapshotRevision}`);
  await p2.goto(`/#/projects/${encodeURIComponent(ids.projectA)}`);
  await expect(p2.locator('.persisted-material')).toContainText('synthetic-audit.docx');
  await shot(p2, '08-restored-material');
  const ok = del.status === 204 && gone === 404 && restored === 200 && restoredSha === original && snap.json?.input_hash === ids.snapshotHash;
  record({ issue: '#8', item: 'backup -> restore drill preserves project, material bytes (sha256) and the locked snapshot', result: ok ? 'pass' : 'fail', evidence: '08-restored-material.png, results.json', detail: { deleted_status: del.status, read_after_delete: gone, read_after_restore: restored, sha256_before: original, sha256_after_restore: restoredSha, snapshot_hash_preserved: snap.json?.input_hash === ids.snapshotHash, backup: backupDir.split('/').at(-1) } });
  await ctx2.close();
  expect(ok).toBe(true);
});

test('#7 login rate limit response is generic (no account enumeration)', async () => {
  const ctx = await freshContext(browserRef); const page = await ctx.newPage();
  const c = newUser(); expect((await register(page, c)).status).toBe(201);
  await api(page, 'POST', '/api/v1/auth/logout', {}); await ctx.clearCookies(); await page.goto('/');
  const ghost = `ghost_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const tries = async (name: string) => { const r = []; for (let i = 0; i < 7; i++) { const x = await api(page, 'POST', '/api/v1/auth/login', { username: name, password: 'Wrong-password-000000' }); r.push({ status: x.status, code: x.json?.code, message: x.json?.message ?? x.json?.detail ?? x.json?.title }); } return r; };
  const real = await tries(c.username), missing = await tries(ghost);
  await page.getByLabel('用户名', { exact: true }).fill(c.username);
  await page.getByLabel('密码', { exact: true }).fill(c.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.waitForTimeout(1500); await shot(page, '07-rate-limited-ui');
  const shape = (r: any[]) => r.map(x => `${x.status}:${x.code}:${x.message}`);
  const same = JSON.stringify(shape(real)) === JSON.stringify(shape(missing));
  const limited = real.some(x => x.status === 429 && x.code === 'RATE_LIMITED');
  record({ issue: '#7', item: 'failed logins and the rate-limit response are identical for existing and unknown usernames', result: same && limited ? 'pass' : 'fail', evidence: '07-rate-limited-ui.png, results.json', detail: { existing_account: real, unknown_account: missing, note: 'Staging traffic arrives through one tunnel, so all clients share a source address; per-account limits still apply.' } });
  await ctx.close();
  expect(same && limited).toBe(true);
});

test('#79 admin log routes require an operator grant', async () => {
  const ctx = await freshContext(browserRef); const page = await ctx.newPage();
  const op = newUser(); expect((await register(page, op)).status).toBe(201);
  const routes = ['/api/v1/admin/logs/events', '/api/v1/admin/metrics', '/api/v1/admin/alerts', '/api/v1/admin/evidence-gate'];
  const probe = async () => Object.fromEntries(await Promise.all(routes.map(async r => [r, (await api(page, 'GET', r)).status] as const)));
  const anon = await (async () => { const x = await freshContext(browserRef); const p = await x.newPage(); await p.goto('/'); const s = (await api(p, 'GET', routes[0])).status; await x.close(); return s; })();
  const without = await probe();
  execFileSync(resolve(composeDir, 'scripts/grant-operator.sh'), [op.username, 'log_reader', 'staging_acceptance'], { encoding: 'utf8' });
  const withGrant = await probe();
  const prompt = (await api(page, 'GET', `/api/v1/admin/prompts/${randomUUID()}`)).status;
  const resume = (await api(page, 'POST', '/api/v1/admin/evidence-gate/resume', { reason_code: 'staging_acceptance' })).status;
  const ok = anon === 401 && Object.values(without).every(s => s === 404) && Object.values(withGrant).every(s => s === 200) && prompt === 404 && resume === 404;
  record({ issue: '#79', item: 'admin log routes reachable only with a grant (no grant -> 404; log_reader -> 200; prompt/operator routes still 404 without their own grants)', result: ok ? 'pass' : 'fail', evidence: 'results.json', detail: { anonymous: anon, without_grant: without, with_log_reader: withGrant, prompt_view_without_prompt_viewer: prompt, gate_resume_without_log_operator: resume } });
  await ctx.close();
  expect(ok).toBe(true);
});
