import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { artifactId, assertFixture, fixture, ids, install, runId } from './parallel-projects-fixtures';

// This captures the unchanged develop ProjectBrowser component and stylesheet.
// Main, shared helpers, and the strict synthetic public HTTP fixture are current.
// It is an old-component comparison, not an approved new synchronization design.
const root = resolve(process.cwd(), '../..');
const baseline = resolve(root, '../remote-review-20261025-ffd637f/BondBuddy-develop');
const baselineSha = 'ffd637fac6c1fdf1581112e728f21ec29a94c67c';
const files = ['project-browser.ts', 'project-browser.css'] as const;
test.skip(!process.env.BB_UX_EVIDENCE_DIR || files.some(file => !existsSync(join(baseline, 'apps/web/src', file))),
  'Local immutable baseline source/style files and evidence directory are required for comparison capture.');
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

function browserScript(source: string) {
  const script = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText.replace(/from ['"]@bondbuddy\/contracts['"]/g,
    `from "/@fs/${root.replaceAll('\\', '/')}/packages/contracts/dist/index.js"`);
  return script.replace(/(['"])\.\/([^'"]+)\1/g, (_match, quote, name: string) => {
    const filename = name.endsWith('.css') || name.endsWith('.ts') ? name : name.replace(/\.js$/, '') + '.ts';
    return quote + '/src/' + filename + quote;
  });
}

test.afterEach(({ page }) => assertFixture(page));

for (const view of ['loaded', 'expanded'] as const) for (const width of [1440, 390]) {
  test(`unchanged develop parallel-projects ${view} reference at ${width}`, async ({ page }) => {
    const evidence = process.env.BB_UX_EVIDENCE_DIR;
    if (!evidence) throw Error('BB_UX_EVIDENCE_DIR is required for reference capture');
    const originals = new Map<string, string>(), loads = new Map<string, number>();
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
    const state = fixture();
    await install(page, state);
    const blockedWrites: string[] = [], projectReads: string[] = [];
    await page.route('**/api/v1/**', route => {
      const request = route.request(), url = new URL(request.url());
      if (request.method() === 'GET') {
        if (url.pathname === '/api/v1/projects') projectReads.push(url.search);
        return route.fallback();
      }
      blockedWrites.push(`${request.method()} ${url.pathname}${url.search}`);
      return route.abort('blockedbyclient');
    });
    const viewport = { width, height: width === 390 ? 844 : 960 };
    await page.setViewportSize(viewport);
    await page.goto('/#tasks');
    await expect(page.locator('main h1')).toHaveText('全部项目');
    await expect(page.locator('#project-list')).toHaveAttribute('aria-busy', 'false');
    const toggle = page.locator(`[data-tasks="${ids.a}"]`);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator(`[data-tasks="${ids.b}"]`)).toBeVisible();
    await expect(page.locator('#collection-sync')).toHaveCount(0);
    await expect(page.locator('#list-count')).toContainText('状态自动同步');
    const initialProjectReadCount = projectReads.length;
    expect(initialProjectReadCount).toBeGreaterThan(0);

    let loadedTaskIds: string[] = [];
    if (view === 'expanded') {
      await toggle.click();
      const panel = page.locator(`[data-task-panel="${ids.a}"]`);
      await expect(panel.locator('[data-run-id]')).toHaveCount(20);
      await page.locator(`[data-task-more="${ids.a}"]`).click();
      await expect(panel.locator('[data-run-id]')).toHaveCount(40);
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      await expect(panel.locator(`[data-run-id="${runId('a', 7)}"] a`)).toHaveAttribute('href', `#/artifacts/${artifactId('a', 7)}`);
      await expect(panel.locator(`[data-run-id="${runId('a', 8)}"] a`)).toHaveAttribute('href',
        `#/projects/${ids.aReview}/review?from=projects&run=${runId('a', 8)}&tab=results&report_id=parallel-exact-review-report-8`);
      loadedTaskIds = await panel.locator('[data-run-id]').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.runId!));
      expect(new Set(loadedTaskIds).size).toBe(40);
    } else {
      await expect(page.locator('.collection-task-row:not([hidden])')).toHaveCount(0);
    }

    // Capture before any refresh or fixture mutation. The baseline's old range
    // behavior is not acceptance evidence for the new refresh-preservation flow.
    expect(projectReads).toHaveLength(initialProjectReadCount);
    await page.evaluate(async () => {
      (document.activeElement as HTMLElement | null)?.blur(); window.scrollTo(0, 0);
      await new Promise<void>(done => requestAnimationFrame(() => done()));
    });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    expect(overflow).toBe(false);
    await mkdir(evidence, { recursive: true });
    const filename = `parallel-projects-reference-${view}-${width}.png`;
    await page.screenshot({ path: join(evidence, filename), fullPage: true });

    const sources = [];
    for (const file of files) {
      expect(loads.get(file), `${file} must load from unchanged develop`).toBeGreaterThan(0);
      const before = originals.get(file)!, after = await readFile(join(baseline, 'apps/web/src', file), 'utf8');
      expect(after, `${file} baseline remains unchanged`).toBe(before);
      sources.push({ path: `apps/web/src/${file}`, sha256: sha256(before), sha256_after: sha256(after), loads: loads.get(file), immutable: true });
    }
    expect(blockedWrites).toEqual([]); expect(projectReads).toHaveLength(initialProjectReadCount);
    assertFixture(page);
    await writeFile(join(evidence, `parallel-projects-reference-capture-${view}-${width}.json`), JSON.stringify({
      baseline_sha: baselineSha, view,
      scope: 'Unchanged develop ProjectBrowser TS/CSS only; current main, helpers, and identical strict synthetic public HTTP fixture.',
      approval: 'Old-component comparison only; not an approved new synchronization prototype or new-UI acceptance.',
      fixture: 'parallel-projects-fixtures.fixture(), unchanged initial state; no refresh or new-task insertion before capture',
      sources, record: { filename, viewport, overflow }, loaded_task_ids: loadedTaskIds,
      initial_project_page_reads: projectReads, task_page_reads: state.taskReads, refreshes_after_initial_load: 0,
      sync_controls: 0, write_requests: 0, blocked_write_requests: blockedWrites,
      errors: state.errors, unexpected_requests: state.unexpected,
    }, null, 2));
  });
}
