import { expect, test as base, type Page } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyUpdateDetails, reportingWindow } from '@bondbuddy/contracts';

const repo = fileURLToPath(new URL('../../..', import.meta.url));
export const prelaunchOrigin = 'http://localhost:18087';
export const targetCutoff = '2026-09-30';
export interface PrelaunchConfig { instanceId: string; database: string; projectName: string; origin: string; terms: string; root: string; }
function normalizedLocalPath(value: string) { return value.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive: string) => `/mnt/${drive.toLowerCase()}`).replace(/\/$/, ''); }
export function prelaunchConfig(): PrelaunchConfig {
  const value = JSON.parse(readFileSync(process.env.BB_PRELAUNCH_CONFIG ?? join(repo, '.local/local-prelaunch/config.json'), 'utf8'));
  if (value.origin !== prelaunchOrigin || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.instanceId) || !value.terms ||
      typeof value.root !== 'string' || normalizedLocalPath(value.root) !== normalizedLocalPath(repo))
    throw new Error('The dedicated local prelaunch configuration is required; production is never inferred.');
  const suffix = createHash('sha256').update(value.instanceId).digest('hex').slice(0, 16);
  if (value.database !== `bb_billing_functional_${suffix}` || value.projectName !== `bb-prelaunch-${suffix.slice(0, 12)}`)
    throw new Error('The database and Compose project must match this local instance identity.');
  if (process.env.BB_E2E_BASE_URL !== value.origin) throw new Error('BB_E2E_BASE_URL must equal the dedicated prelaunch origin.');
  return value;
}

/** SQL is passed on stdin to the owned container; neither SQL nor identifiers are shell interpolated. */
function dockerOutput(args: string[], input?: string): string {
  const result = process.platform === 'win32'
    ? execFileSync('wsl.exe', ['-d', process.env.BB_PRELAUNCH_WSL_DISTRO ?? 'BondBuddyM3', '--cd', normalizedLocalPath(repo), '--', 'docker', ...args], { input, encoding: 'utf8', windowsHide: true, timeout: 30000 })
    : execFileSync('docker', args, { input, encoding: 'utf8', timeout: 30000 });
  return result.trim();
}
export function localSql<T = unknown>(sql: string): T {
  const config = prelaunchConfig();
  const result = dockerOutput(['exec', '-i', `${config.projectName}-postgres-1`, 'psql', '-U', 'bondbuddy', '-d', config.database, '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1'], sql);
  return JSON.parse(result.trim());
}
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
export function uploadBlobObservation(owner: string, uploadId: string) {
  const config = prelaunchConfig();
  const row = localSql<{ objectKey: string; state: string; receivedBytes: number | null }>(`SELECT json_build_object('objectKey',object_key,'state',state,'receivedBytes',received_bytes) FROM bb_uploads WHERE owner_user_id=${literal(owner)} AND id=${literal(uploadId)};`);
  const code = "import {BlobServiceClient} from '@azure/storage-blob';import {createHash} from 'node:crypto';const blob=BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING).getContainerClient('bondbuddy-private').getBlobClient(process.argv[1]);const exists=await blob.exists();const bytes=exists?await blob.downloadToBuffer():null;process.stdout.write(JSON.stringify({exists,bytes:bytes?.length??null,sha256:bytes?createHash('sha256').update(bytes).digest('hex'):null}));";
  const blob = JSON.parse(dockerOutput(['exec', `${config.projectName}-api-1`, 'node', '--input-type=module', '-e', code, row.objectKey]));
  return { ...row, blob };
}
export function parseEvidenceObservation(owner: string, materialId: string) {
  return localSql<{ snapshots: unknown[]; nonEmptyQuotes: number }>(`SELECT json_build_object(
    'snapshots',COALESCE((SELECT json_agg(json_build_object('status',response_status,'recordCount',record_count,'error',response_meta->'error','sha256',content_sha256)) FROM bb_parse_snapshots WHERE owner_user_id=${literal(owner)} AND material_id=${literal(materialId)}),'[]'::json),
    'nonEmptyQuotes',(SELECT count(*) FROM bb_parse_evidence WHERE owner_user_id=${literal(owner)} AND material_id=${literal(materialId)} AND length(btrim(literal_quote))>0));`);
}
export interface DatabaseSnapshot { runs: number; creditEvents: number; reservations: number; modelCalls: number; materials: number; uploads: number; projects: number; inputs: number; parseJobs: number; remaining: string; frozen: string; }
export function databaseSnapshot(owner: string): DatabaseSnapshot {
  const user = literal(owner);
  return localSql<DatabaseSnapshot>(`SELECT json_build_object(
    'runs',(SELECT count(*) FROM bb_runs WHERE owner_user_id=${user}),
    'creditEvents',(SELECT count(*) FROM bb_credit_events WHERE owner_user_id=${user}),
    'reservations',(SELECT count(*) FROM bb_credit_reservations WHERE owner_user_id=${user}),
    'modelCalls',(SELECT count(*) FROM bb_model_call_attempts WHERE owner_user_id=${user}),
    'materials',(SELECT count(*) FROM bb_material_versions WHERE owner_user_id=${user} AND deleted_at IS NULL AND NOT internal_template),
    'uploads',(SELECT count(*) FROM bb_uploads WHERE owner_user_id=${user}),
    'projects',(SELECT count(*) FROM bb_projects WHERE owner_user_id=${user} AND deleted_at IS NULL),
    'inputs',(SELECT count(*) FROM bb_input_revisions WHERE owner_user_id=${user}),
    'parseJobs',(SELECT count(*) FROM bb_jobs WHERE owner_user_id=${user} AND job_type='parse'),
    'remaining',(SELECT COALESCE(sum(remaining),0)::text FROM bb_credit_lots WHERE owner_user_id=${user}),
    'frozen',(SELECT COALESCE(sum(frozen),0)::text FROM bb_credit_lots WHERE owner_user_id=${user}));`);
}
export interface HttpResult { status: number; body: any; }
/** The page owns the real authenticated cookie session. No principal or HTTP response fixture is supplied. */
export async function browserApi(page: Page, method: string, path: string, body?: unknown, bytes?: Buffer): Promise<HttpResult> {
  if (!path.startsWith('/api/v1/')) throw new Error('Only the local public API is allowed.');
  return page.evaluate(async ({ method, path, body, bytes }) => {
    const csrf = document.cookie.split('; ').find(c => c.startsWith('bb_csrf='))?.slice(8) ?? '';
    const response = await fetch(path, { method, credentials: 'same-origin', headers: {
      ...(method === 'GET' ? {} : { 'X-BB-CSRF': decodeURIComponent(csrf) }),
      ...(bytes ? { 'Content-Type': 'application/octet-stream' } : body === undefined ? {} : { 'Content-Type': 'application/json' }),
    }, body: bytes ? new Uint8Array(bytes) : body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    let value: unknown = text; try { value = text ? JSON.parse(text) : null; } catch {}
    return { status: response.status, body: value };
  }, { method, path, body, bytes: bytes ? [...bytes] : undefined });
}
export async function downloadedHash(page: Page, projectId: string, materialId: string) {
  return page.evaluate(async path => {
    const response = await fetch(path, { credentials: 'same-origin' });
    const bytes = await response.arrayBuffer();
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
    return { status: response.status, bytes: bytes.byteLength, sha256: hash };
  }, `/api/v1/projects/${projectId}/materials/${materialId}/download`);
}

export interface Audit {
  owner: string; username: string; directory: string; before: DatabaseSnapshot;
  requests: { method: string; path: string; status?: number }[];
  record(label: string, value?: unknown): void;
  checkpoint(label: string, value?: unknown): DatabaseSnapshot;
  noTaskOrDebit(label: string): void;
}
const invocation = (process.env.BB_PRELAUNCH_EVIDENCE_RUN ? safeName(process.env.BB_PRELAUNCH_EVIDENCE_RUN).slice(0, 24) + '-' : '') + new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
const sourceHashes = Object.fromEntries(readdirSync(join(repo,'apps/web/tests')).filter(name=>name.startsWith('local-prelaunch-')&&name.endsWith('.ts')).map(name => [name, createHash('sha256').update(readFileSync(join(repo, 'apps/web/tests', name))).digest('hex')]));
function safeName(value: string) { return value.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 72); }
export async function registerSynthetic(page: Page, config: PrelaunchConfig) {
  const username = `prelaunch_${randomUUID().replaceAll('-', '').slice(0, 16)}`, password = `Synthetic-${randomUUID()}!`;
  await page.goto('/');
  // This agreement belongs only to the isolated synthetic account and terms version.
  await page.getByRole('link', { name: '注册', exact: true }).click();
  await expect(page.locator('#terms-version')).toHaveText(config.terms);
  await page.getByLabel('用户名', { exact: true }).fill(username);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByLabel('确认密码', { exact: true }).fill(password);
  await page.locator('#reg-agree').check();
  const response = page.waitForResponse(r => r.url().endsWith('/api/v1/auth/register') && r.request().method() === 'POST');
  await page.getByRole('button', { name: '注册并进入工作区', exact: true }).click();
  expect((await response).status()).toBe(201);
  const me = await browserApi(page, 'GET', '/api/v1/me'); expect(me.status).toBe(200);
  expect(typeof me.body.user_id).toBe('string');
  return { username, owner: me.body.user_id as string };
}

export const test = base.extend<{ audit: Audit }>({
  audit: async ({ page }, use, info) => {
    const config = prelaunchConfig();
    const directory = join(process.env.BB_PRELAUNCH_EVIDENCE ?? join(repo, '.local/local-prelaunch/bad-cases'), invocation, safeName(info.title));
    mkdirSync(directory, { recursive: true });
    const timeline: unknown[] = [], requests: Audit['requests'] = [], pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('response', response => {
      const path = new URL(response.url()).pathname;
      if (path.startsWith('/api/v1/') && !path.startsWith('/api/v1/auth/')) requests.push({ method: response.request().method(), path, status: response.status() });
    });
    let account: { owner: string; username: string } | undefined;
    let before: DatabaseSnapshot | undefined;
    const save = () => writeFileSync(join(directory, 'evidence.json'), JSON.stringify({
      schema: 'local-prelaunch-bad-case-v1', synthetic: true, apiMocked: false, instanceId: config.instanceId, database: config.database,
      origin: config.origin, sourceHashes, test: info.title, status: info.status, expectedStatus: info.expectedStatus,
      owner: account?.owner, username: account?.username, before, requests, timeline, pageErrors,
      errors: info.errors.map(e => ({ message: e.message, stack: e.stack })),
    }, null, 2));
    try {
      account = await registerSynthetic(page, config); before = databaseSnapshot(account.owner); save();
      const audit: Audit = {
        ...account, directory, before, requests,
        record(label, value) { timeline.push({ at: new Date().toISOString(), label, value }); save(); },
        checkpoint(label, value) { const database = databaseSnapshot(account!.owner); timeline.push({ at: new Date().toISOString(), label, database, value }); save(); return database; },
        noTaskOrDebit(label) {
          const current = this.checkpoint(label);
          for (const key of ['runs', 'creditEvents', 'reservations', 'modelCalls', 'remaining', 'frozen'] as const)
            expect(current[key], `${label}: ${key} changed`).toBe(before![key]);
        },
      };
      await use(audit);
      if (info.status === 'passed') expect(pageErrors, 'Unexpected uncaught browser errors').toEqual([]);
    } finally {
      if (account) { try { timeline.push({ label: 'final-database', database: databaseSnapshot(account.owner) }); } catch (error) { timeline.push({ label: 'final-database-error', error: String(error) }); } }
      if (!page.isClosed()) { try { await page.screenshot({ path: join(directory, info.status === 'passed' ? 'final.png' : 'red.png'), fullPage: true }); } catch {} }
      save();
      await info.attach('real-api-and-database-evidence', { path: join(directory, 'evidence.json'), contentType: 'application/json' });
    }
  },
});
export { expect };

export async function createSyntheticProject(page: Page, marker: string, unified = true) {
  const response = await browserApi(page, 'POST', '/api/v1/projects', { name: `合成桌面验收 ${marker}`, kind: 'update',
    issuer_name: `合成测试发行人 ${marker} 有限公司`, market: 'sse', offering: 'private', creation_request_id: randomUUID(),
    update_details: { ...emptyUpdateDetails(), ...(unified ? { authoring_mode: 'unified_v1' } : {}), reporting_cutoff: targetCutoff,
      target_reporting_periods: reportingWindow('sse', 'private', targetCutoff), source_prospectuses: [] } });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body;
}
export async function openProject(page: Page, projectId: string) {
  await page.goto(`/#/projects/${projectId}?step=materials`);
  await expect(page.locator('#project-heading')).toBeVisible();
  // A fieldset itself is not an actionable control. Wait for the real picker;
  // setInputFiles can otherwise dispatch during execution restoration while
  // the UI deliberately disables all material controls.
  await expect(page.locator('input[data-upload-role="audit"]')).toBeEnabled();
}
export async function uploadFromPicker(page: Page, projectId: string, file: { name: string; mimeType: string; buffer: Buffer }, source = false) {
  const picker = page.getByLabel(source ? '募集书新版本文件' : '为审计报告（可含报表及附注）选择文件', { exact: true });
  await expect(picker).toBeEnabled();
  const saved = page.waitForResponse(r => new URL(r.url()).pathname.startsWith(`/api/v1/projects/${projectId}/materials/uploads/`) && r.url().endsWith('/complete') && r.request().method() === 'POST');
  await picker.setInputFiles({ name: file.name, mimeType: file.mimeType, buffer: file.buffer });
  const response = await saved; expect(response.status(), await response.text()).toBe(200);
  return response.json();
}
/** Reconstruct saved materials through the same public event/material APIs as the UI. */
export async function savedMaterials(page: Page, projectId: string) {
  const ids = new Set<string>(), cursors = new Set<number>();
  let cursor = 0;
  while (true) {
    expect(cursors.has(cursor), 'Material event cursor must advance').toBe(false); cursors.add(cursor);
    const response = await browserApi(page, 'GET', `/api/v1/projects/${projectId}/events?after=${cursor}`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(Array.isArray(response.body.items)).toBe(true);
    for (const event of response.body.items) {
      if (event.type === 'material.upload_progress' && event.payload.material_id) ids.add(event.payload.material_id);
    }
    if (response.body.next_cursor === null) break;
    expect(response.body.next_cursor).toBeGreaterThan(cursor); cursor = response.body.next_cursor;
  }
  return Promise.all([...ids].map(async id => {
    const response = await browserApi(page, 'GET', `/api/v1/projects/${projectId}/materials/${id}`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return response.body;
  }));
}
export async function fillSourceInformation(page: Page, materialId: string) {
  const source = page.locator(`[data-source-material="${materialId}"]`);
  await expect(source).toBeVisible();
  await source.locator('[data-source-field="relation"]').selectOption('same_issuer');
  await source.locator('[data-source-field="market"]').selectOption('sse');
  await source.locator('[data-source-field="offering"]').selectOption('private');
  await source.locator('[data-source-field="year"]').selectOption('2025');
  await source.locator('[data-source-field="quarter"][value="12-31"]').check();
  await expect(source.locator('[data-source-required-message]')).toHaveText('原稿信息已填写完整。');
  await expect(page.locator('#save-state')).toHaveText('已保存');
}
export async function lockCurrentInput(page: Page, projectId: string, pins: { material_id: string; material_version: number }[]) {
  const project = await browserApi(page, 'GET', `/api/v1/projects/${projectId}`); expect(project.status).toBe(200);
  const versions = await browserApi(page, 'GET', `/api/v1/projects/${projectId}/prospectus-versions`); expect(versions.status).toBe(200);
  return browserApi(page, 'POST', `/api/v1/projects/${projectId}/input-revisions`, { draft_revision: project.body.draft_revision,
    prospectus_selection_revision: versions.body.selection_revision, material_versions: pins, requirement_message_ids: [] });
}
export const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
