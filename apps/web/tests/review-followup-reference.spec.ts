import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { assertFixture, fixture, install, projectId, runId, title } from './review-followup-fixtures';

// Only the editor/reader components and their styles come from unchanged develop.
// The surrounding workspace and public HTTP fixture are shared with the new UI.
// These comparison captures are not a verified or approved followup prototype.
const root = resolve(process.cwd(), '../..');
const baseline = resolve(root, '../remote-review-20261025-ffd637f/BondBuddy-develop');
const baselineSha = 'ffd637fac6c1fdf1581112e728f21ec29a94c67c';
test.skip(!process.env.BB_UX_EVIDENCE_DIR || !existsSync(baseline), 'Local immutable baseline and evidence directory are required for comparison capture.');
const files = ['review-editor.ts', 'review-editor.css', 'review-readable.ts', 'review-readable.css', 'review-business-view.ts'] as const;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

function browserScript(source: string) {
  let script = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  script = script.replace(/from ['"]@bondbuddy\/contracts['"]/g,
    `from "/@fs/${root.replaceAll('\\', '/')}/packages/contracts/dist/index.js"`);
  script = script.replace(/from ['"]@sinclair\/typebox\/value['"]/g,
    'from "/node_modules/.vite/deps/@sinclair_typebox_value.js"');
  return script.replace(/(['"])\.\/([^'"]+)\1/g, (_match, quote, name: string) => {
    const filename = name.endsWith('.css') || name.endsWith('.ts') ? name : name.replace(/\.js$/, '') + '.ts';
    return quote + '/src/' + filename + quote;
  });
}

test.afterEach(({ page }) => assertFixture(page));

for (const mode of ['editor', 'readable'] as const) for (const width of [1440, 390]) {
  test(`unchanged develop ${mode} component reference at ${width}`, async ({ page }) => {
    const evidence = process.env.BB_UX_EVIDENCE_DIR;
    if (!evidence) throw Error('BB_UX_EVIDENCE_DIR is required for reference capture');
    const originals = new Map<string, string>();
    const loads = new Map<string, number>();
    for (const file of files) {
      const source = await readFile(join(baseline, 'apps/web/src', file), 'utf8');
      originals.set(file, source); loads.set(file, 0);
      const body = file.endsWith('.css')
        ? `const style=document.createElement('style');style.textContent=${JSON.stringify(source)};document.head.append(style);export default '';`
        : browserScript(source);
      await page.route(`**/src/${file}*`, route => {
        loads.set(file, loads.get(file)! + 1);
        return route.fulfill({ contentType: 'text/javascript', body });
      });
    }

    const state = fixture(mode);
    expect(state.history.map(entry => entry.run.run_id)).toEqual([runId(2), runId(1)]);
    await install(page, state);
    const blockedWrites: string[] = [];
    await page.route('**/api/v1/**', route => {
      if (route.request().method() === 'GET') return route.fallback();
      blockedWrites.push(`${route.request().method()} ${route.request().url()}`);
      return route.abort('blockedbyclient');
    });
    const viewport = { width, height: width === 390 ? 844 : 960 };
    await page.setViewportSize(viewport);
    await page.goto(`/#/projects/${projectId}/review?tab=results&run=${runId(1)}`);
    const host = page.locator('#review-results-panel');
    if (mode === 'editor') {
      await expect(host.locator('[data-editor-history]')).toHaveValue(runId(1));
      await expect(host.locator('.review-issue-detail h3')).toHaveText(title(1));
      await expect(host.locator('[data-editor-document]')).toContainText('合成成果 V1');
    } else {
      const item = host.locator('[data-readable-item]').filter({ hasText: title(1) });
      await expect(item).toBeVisible();
      await item.locator('summary').click();
      await expect(item).toHaveAttribute('open', '');
      await expect(item).toContainText('合成成果 V1');
    }
    await expect(host).not.toContainText(title(2));
    await expect(host.locator('[data-editor-followup], [data-readable-followup]')).toHaveCount(0);
    await expect(page.getByRole('dialog', { name: '准备下一轮复核', exact: true })).toHaveCount(0);
    await page.evaluate(async () => {
      (document.activeElement as HTMLElement | null)?.blur();
      window.scrollTo(0, 0);
      await new Promise<void>(done => requestAnimationFrame(() => done()));
    });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    await mkdir(evidence, { recursive: true });
    const filename = `review-followup-reference-${mode}-${width}.png`;
    await page.screenshot({ path: join(evidence, filename), fullPage: true });

    const sources = [];
    for (const file of files) {
      expect(loads.get(file), `${file} must load from the immutable component baseline`).toBeGreaterThan(0);
      const before = originals.get(file)!;
      const after = await readFile(join(baseline, 'apps/web/src', file), 'utf8');
      expect(after, `${file} baseline remains byte-for-byte unchanged`).toBe(before);
      sources.push({ path: `apps/web/src/${file}`, sha256: sha256(before), sha256_after: sha256(after), loads: loads.get(file), immutable: true });
    }
    expect(blockedWrites).toEqual([]);
    expect(state.calls.filter(call => call.method !== 'GET')).toEqual([]);
    expect(state.drafts).toEqual([]); expect(state.sources).toEqual([]);
    expect(state.quotes).toEqual([]); expect(state.executions).toEqual([]); expect(state.exports).toEqual([]);
    assertFixture(page);
    await writeFile(join(evidence, `review-followup-reference-capture-${mode}-${width}.json`), JSON.stringify({
      baseline_sha: baselineSha,
      scope: 'Unchanged develop editor/reader components only; surrounding workspace and public HTTP fixture are shared with the changed UI.',
      approval: 'Comparison reference only; this is not an approved followup prototype or new-UI acceptance.',
      mode, selected_run_id: runId(1), selected_execution_version: 1, latest_run_id: runId(2), latest_execution_version: 2,
      fixture: 'review-followup-fixtures.fixture(mode), unchanged synthetic V1/V2 public HTTP data',
      sources, record: { filename, viewport, overflow }, write_requests: 0, blocked_write_requests: blockedWrites,
      followup_controls: 0, errors: state.errors, unexpected_requests: state.unexpected,
    }, null, 2));
  });
}
