import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { assertFixture, calls, fixture, install, latestUpload, now, pdf, writes } from './upload-session-recovery-fixtures';

// Exact reconstructed ninth-slice TS modules; current surrounding helpers/styles.
// This is a local component comparison, not an approved recovery prototype.
const root = resolve(process.cwd(), '../..');
const directory = join(root, 'ux-evidence/upload-reference-r9-source');
const files = ['main.ts', 'file-workspace.ts', 'project-files.ts', 'prospectus-panel.ts'];
test.skip(!process.env.BB_UX_EVIDENCE_DIR || files.some(file => !existsSync(join(directory, 'apps/web/src', file))),
  'Exact reconstructed ninth-slice modules and an evidence directory are required.');
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
function browserScript(source: string) {
  return ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
    .replace(/from ['"]@bondbuddy\/contracts['"]/g,
      `from "/@fs/${root.replaceAll('\\', '/')}/packages/contracts/dist/index.js"`)
    .replace(/from ['"]@sinclair\/typebox\/value['"]/g, 'from "/node_modules/.vite/deps/@sinclair_typebox_value.js"')
    .replace(/(['"])\.\/([^'"]+)\1/g, (_match, quote, name: string) => {
      const filename = name.endsWith('.css') || name.endsWith('.ts') ? name : name.replace(/\.js$/, '') + '.ts';
      return quote + '/src/' + filename + quote;
    }).replace(/(['"])(\.\.\/[^'"]+)\1/g, (_match, quote, name: string) =>
      quote + '/@fs/' + resolve(root, 'apps/web/src', name).replaceAll('\\', '/') + quote);
}
test.afterEach(({ page }) => assertFixture(page));

for (const width of [1440, 390]) {
  test(`ninth-slice upload component before and after refresh at ${width}`, async ({ page }) => {
    const evidence = process.env.BB_UX_EVIDENCE_DIR!;
    const provenance = JSON.parse(await readFile(join(directory, 'provenance.json'), 'utf8'));
    const originals = new Map<string, string>(), loads = new Map<string, number>();
    for (const file of files) {
      const source = await readFile(join(directory, 'apps/web/src', file), 'utf8');
      const expected = provenance.sources.find((item: { path: string }) => item.path === `apps/web/src/${file}`);
      expect(sha256(source)).toBe(expected.sha256);
      originals.set(file, source); loads.set(file, 0);
      await page.route(`**/src/${file}*`, route => {
        loads.set(file, loads.get(file)! + 1);
        return route.fulfill({ contentType: 'text/javascript', body: browserScript(source) });
      });
    }
    await page.clock.install({ time: new Date(now) });
    const viewport = { width, height: 960 }; await page.setViewportSize(viewport);
    const state = fixture(); state.dropPutReplies = 1; state.completeUnavailable = true;
    await install(page, state); await page.goto('/#/projects/upload-recovery-project-a');
    const picker = page.locator('[data-upload-role="audit"]'); await expect(picker).toBeEnabled();
    const file = pdf('待确认的原审计报告与财务报表附注-长文件名.pdf'); await picker.setInputFiles(file);
    await expect.poll(() => latestUpload(state)?.state).toBe('received');
    const row = page.locator('.material-file-row').filter({ hasText: file.name });
    await expect(row).toHaveAttribute('data-upload-phase', 'uncertain'); await row.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('bondbuddy:upload-recovery:')))).toEqual([]);
    await mkdir(evidence, { recursive: true });
    const records: unknown[] = [];
    for (const view of ['pending', 'refreshed'] as const) {
      if (view === 'refreshed') {
        const before = writes(state).length;
        await page.reload(); await expect(picker).toBeEnabled();
        await expect(page.locator('.material-file-row')).toHaveCount(0);
        await expect(page.locator('[data-upload-action="retry"]')).toHaveCount(0);
        expect(writes(state)).toHaveLength(before);
        await page.locator('[data-material-role="audit"]').scrollIntoViewIfNeeded();
      }
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
      expect(overflow).toBe(false);
      const filename = `upload-recovery-reference-${view}-${width}.png`;
      await page.screenshot({ path: join(evidence, filename), fullPage: false });
      records.push({ filename, view, viewport, overflow });
    }
    expect(calls(state, 'create')).toHaveLength(1); expect(calls(state, 'put')).toHaveLength(1);
    expect(state.materials.size).toBe(0);
    const sources = [];
    for (const file of files) {
      const before = originals.get(file)!, after = await readFile(join(directory, 'apps/web/src', file), 'utf8');
      expect(after).toBe(before); expect(loads.get(file)).toBeGreaterThan(0);
      sources.push({ path: `apps/web/src/${file}`, sha256: sha256(before), sha256_after: sha256(after), loads: loads.get(file), immutable: true });
    }
    assertFixture(page);
    await writeFile(join(evidence, `upload-recovery-reference-capture-${width}.json`), JSON.stringify({
      baseline_sha: provenance.baseline_sha, ninth_patch_sha256: provenance.ninth_patch_sha256,
      scope: 'Four exact local ninth-slice TS modules; current surrounding helpers/styles and strict synthetic public HTTP fixture.',
      approval: 'Old-component comparison only; no approved new upload-recovery prototype or human acceptance.',
      sources, records, upload_create_count: calls(state, 'create').length, upload_put_count: calls(state, 'put').length,
      complete_count: calls(state, 'complete').length, material_count: state.materials.size,
      recovery_records_after_refresh: 0, recovery_controls_after_refresh: 0,
      writes_after_refresh: 0, errors: state.errors, unexpected_requests: state.unexpected,
    }, null, 2));
  });
}
