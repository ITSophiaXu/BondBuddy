import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Route } from '@playwright/test';
import { asUploadFile, createLocalPrelaunchBasicFixtures } from './local-prelaunch-fixtures';
import { test, expect, browserApi, createSyntheticProject, downloadedHash, fillSourceInformation, localSql,
  lockCurrentInput, openProject, prelaunchConfig, savedMaterials, uploadFromPicker } from './local-prelaunch-helpers';

test.skip(process.env.BB_E2E_LOCAL_PRELAUNCH !== '1', 'Requires the explicitly owned local public API/PostgreSQL/Blob instance.');
test.use({ viewport: { width: 1440, height: 1000 } });
test.setTimeout(120000);

const marker = () => randomUUID().slice(0, 8);
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const pin = (material: any) => ({ material_id: material.material_id, material_version: material.material_version });

/** Record only nonsecret runtime identity; inspecting containers never changes their state. */
function runtimeIdentity() {
  const config = prelaunchConfig(), repo = fileURLToPath(new URL('../../..', import.meta.url));
  const args = ['inspect', '--format', '{{json .Name}}|{{json .Config.Image}}|{{json .Image}}|{{json .Id}}|{{json .State.StartedAt}}',
    ...['api', 'web', 'worker'].map(service => `${config.projectName}-${service}-1`)];
  const output = process.platform === 'win32'
    ? execFileSync('wsl.exe', ['-d', process.env.BB_PRELAUNCH_WSL_DISTRO ?? 'BondBuddyM3', '--', 'docker', ...args], { encoding: 'utf8', windowsHide: true, timeout: 30000 })
    : execFileSync('docker', args, { encoding: 'utf8', timeout: 30000 });
  return {
    sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8', windowsHide: true }).trim(),
    containers: output.trim().split(/\r?\n/).map(line => {
      const [name, tag, image, container, startedAt] = line.split('|').map(value => JSON.parse(value));
      return { name, tag, image, container, startedAt };
    }),
  };
}

test('same-account two-tab simultaneous equal-byte uploads deduplicate and both tabs recover one saved material', async ({ page, audit }) => {
  const runtime = runtimeIdentity(); audit.record('runtime-before', runtime);
  const project = await createSyntheticProject(page, marker()), file = createLocalPrelaunchBasicFixtures({ marker: marker() }).normalDocx;
  await openProject(page, project.project_id);
  const second = await page.context().newPage(), errors: string[] = [];
  second.on('pageerror', error => errors.push(error.message));
  second.on('response', response => {
    const path = new URL(response.url()).pathname;
    if (path.startsWith('/api/v1/') && !path.startsWith('/api/v1/auth/'))
      audit.requests.push({ method: response.request().method(), path, status: response.status() });
  });
  const pattern = `**/api/v1/projects/${project.project_id}/materials/uploads/*/complete`;
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  const arrivals: { uploadId: string; at: string }[] = [];
  const synchronize = async (route: Route) => {
    arrivals.push({ uploadId: new URL(route.request().url()).pathname.split('/').at(-2)!, at: new Date().toISOString() });
    if (arrivals.length === 2) { audit.record('both-real-complete-requests-ready', arrivals); release(); }
    await ready;
    // Timing barrier only: both original browser requests continue to the real API.
    await route.continue();
  };
  try {
    await openProject(second, project.project_id);
    const before = audit.checkpoint('before-two-tab-upload', { projectId: project.project_id, fixture: file.id, sha256: file.sha256, bytes: file.buffer.length });
    await page.route(pattern, synchronize); await second.route(pattern, synchronize);
    const [first, other] = await Promise.all([
      uploadFromPicker(page, project.project_id, asUploadFile(file)),
      uploadFromPicker(second, project.project_id, asUploadFile(file)),
    ]);
    expect(arrivals).toHaveLength(2); expect(new Set(arrivals.map(value => value.uploadId)).size).toBe(2);
    expect(pin(other)).toEqual(pin(first)); expect(first.role).toBe('audit'); expect(other.role).toBe('audit');
    const completed = audit.checkpoint('two-real-completions-one-material', { first, second: other, arrivals });
    expect(completed.materials).toBe(before.materials + 1); expect(completed.uploads).toBe(before.uploads + 2);
    expect(completed.inputs).toBe(before.inputs);
    const persisted = localSql<any>(`SELECT json_build_object(
      'materials',COALESCE((SELECT json_agg(json_build_object('id',id,'version',version,'role',role,'sha256',btrim(sha256),'uploadId',upload_id)) FROM bb_material_versions WHERE owner_user_id=${literal(audit.owner)} AND project_id=${literal(project.project_id)} AND deleted_at IS NULL),'[]'::json),
      'uploads',COALESCE((SELECT json_agg(json_build_object('id',id,'state',state,'receivedBytes',received_bytes)) FROM bb_uploads WHERE owner_user_id=${literal(audit.owner)} AND project_id=${literal(project.project_id)}),'[]'::json),
      'reuseReceipts',COALESCE((SELECT json_agg(json_build_object('uploadId',upload_id,'materialId',material_id,'materialVersion',material_version)) FROM bb_upload_reuse_receipts WHERE owner_user_id=${literal(audit.owner)} AND project_id=${literal(project.project_id)}),'[]'::json));`);
    audit.record('two-tab-persisted-material-upload-and-reuse-rows', persisted);
    expect(persisted.materials).toHaveLength(1); expect(persisted.uploads).toHaveLength(2); expect(persisted.reuseReceipts).toHaveLength(1);
    expect(persisted.reuseReceipts[0]).toMatchObject({ materialId: first.material_id, materialVersion: first.material_version });
    await page.unroute(pattern, synchronize); await second.unroute(pattern, synchronize);
    for (const tab of [page, second]) {
      await tab.reload();
      const materials = await savedMaterials(tab, project.project_id);
      expect(materials).toHaveLength(1); expect(pin(materials[0])).toEqual(pin(first));
      const row = tab.locator('.material-file-row').filter({ hasText: file.name });
      await expect(row).toHaveCount(1); await expect(row).toContainText('服务器已确认保存');
      const downloaded = await downloadedHash(tab, project.project_id, first.material_id);
      expect(downloaded).toEqual({ status: 200, bytes: file.buffer.length, sha256: file.sha256 });
      audit.record(tab === page ? 'first-tab-recovered-exact-original' : 'second-tab-recovered-exact-original', { materials, downloaded });
    }
    await second.screenshot({ path: join(audit.directory, 'second-tab-recovered.png'), fullPage: true });
    expect(errors).toEqual([]);
    audit.noTaskOrDebit('two-tab-recovery-no-task-model-or-credit-write');
    expect(audit.checkpoint('two-tab-recovery-no-input-write').inputs).toBe(before.inputs);
    const afterRuntime = runtimeIdentity(); audit.record('runtime-after', afterRuntime); expect(afterRuntime).toEqual(runtime);
  } finally {
    release();
    await page.unroute(pattern, synchronize); await second.unroute(pattern, synchronize);
    await second.close();
  }
});

test('nonexistent material version rejects input without writes, then corrected pins lock and quote', async ({ page, audit }) => {
  const runtime = runtimeIdentity(); audit.record('runtime-before', runtime);
  const project = await createSyntheticProject(page, marker()), files = createLocalPrelaunchBasicFixtures({ marker: marker() });
  await openProject(page, project.project_id);
  const source = await uploadFromPicker(page, project.project_id, asUploadFile(files.normalDocx), true);
  await fillSourceInformation(page, source.material_id);
  const financial = await uploadFromPicker(page, project.project_id, asUploadFile(files.normalPdf));
  const nonexistent = { material_id: financial.material_id, material_version: financial.material_version + 1 };
  const actualVersions = localSql<number[]>(`SELECT COALESCE(json_agg(version ORDER BY version),'[]'::json) FROM bb_material_versions WHERE owner_user_id=${literal(audit.owner)} AND project_id=${literal(project.project_id)} AND id=${literal(financial.material_id)};`);
  expect(actualVersions).toEqual([financial.material_version]); expect(actualVersions).not.toContain(nonexistent.material_version);
  const before = audit.checkpoint('before-nonexistent-material-version', { projectId: project.project_id, actualVersions, submittedPins: [pin(source), nonexistent] });
  const rejected = await lockCurrentInput(page, project.project_id, [pin(source), nonexistent]);
  const after = audit.checkpoint('nonexistent-material-version-rejected', rejected);
  expect(rejected.status, JSON.stringify(rejected.body)).toBe(404);
  expect(after).toEqual(before);
  audit.noTaskOrDebit('nonexistent-version-no-input-task-model-or-credit-write');
  await page.reload(); await expect(page.locator('#execute-input')).toBeEnabled();
  const corrected = await lockCurrentInput(page, project.project_id, [pin(source), pin(financial)]);
  const locked = audit.checkpoint('corrected-material-version-input-locked', corrected);
  expect(corrected.status, JSON.stringify(corrected.body)).toBe(201); expect(locked.inputs).toBe(before.inputs + 1);
  expect(corrected.body.material_versions).toEqual(expect.arrayContaining([pin(source), pin(financial)]));
  expect(corrected.body.material_versions).toHaveLength(2);
  const quote = await browserApi(page, 'POST', `/api/v1/projects/${project.project_id}/credit-quote`, { input_revision: corrected.body.input_revision, input_hash: corrected.body.input_hash });
  audit.checkpoint('corrected-material-version-real-quote', quote); expect(quote.status, JSON.stringify(quote.body)).toBe(200);
  for (const [material, fixture] of [[source, files.normalDocx], [financial, files.normalPdf]] as const) {
    const downloaded = await downloadedHash(page, project.project_id, material.material_id);
    expect(downloaded).toEqual({ status: 200, bytes: fixture.buffer.length, sha256: fixture.sha256 });
    audit.record('corrected-pin-original-still-downloadable', { material: pin(material), downloaded });
  }
  audit.noTaskOrDebit('corrected-lock-and-quote-no-task-model-or-credit-write');
  expect(audit.checkpoint('quote-does-not-create-another-input').inputs).toBe(before.inputs + 1);
  const afterRuntime = runtimeIdentity(); audit.record('runtime-after', afterRuntime); expect(afterRuntime).toEqual(runtime);
});
