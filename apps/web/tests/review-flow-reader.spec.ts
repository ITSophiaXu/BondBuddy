import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { artifactId, assertFixture, downloadBytes, fixture, immutable, open, runId, writes, type State } from './review-flow-reader-fixtures';
import { installReaderFlowReference } from './review-flow-reader-reference';

test.afterEach(async ({ page }) => assertFixture(page));
const footer = (page: Page) => page.locator('[data-readable-footer]');
const body = (page: Page) => page.locator('.readable-body');
const directory = (page: Page) => page.getByRole('navigation', { name: '三个复核维度', exact: true });
async function atTail(page: Page) {
  await footer(page).scrollIntoViewIfNeeded(); await expect(footer(page)).toBeInViewport();
}
async function download(page: Page, button: Locator, state: State, id: string) {
  const event = page.waitForEvent('download'); await button.click(); const file = await event;
  expect(file.suggestedFilename()).toBe(state.metadata.get(id)!.filename);
  expect(await downloadBytes(file)).toEqual(state.bytes.get(id)); expect(state.byteReads.at(-1)).toBe(id);
}
async function expectRun(page: Page, version: number) {
  expect(await page.evaluate(() => new URLSearchParams(location.hash.split('?')[1]).get('run'))).toBe(runId(version));
}

test('reader flow: a real long historical page advances once to each dimension and lands at the new content start', async ({ page }) => {
  const state = await open(page), before = immutable(state);
  await page.getByRole('button', { name: '展开全部事项', exact: true }).click();
  await expect(body(page).locator('.readable-item[open]')).toHaveCount(7);
  await atTail(page); expect((await body(page).boundingBox())!.y).toBeLessThan(-1500);
  await expect(footer(page).getByRole('button', { name: '继续阅读：合规与披露 →', exact: true })).toBeVisible();
  await footer(page).locator('[data-readable-next]').click();
  await expect(body(page).getByRole('heading', { name: '合规与披露', exact: true })).toBeVisible();
  const bounds = await body(page).boundingBox(); expect(bounds!.y).toBeGreaterThanOrEqual(-1); expect(bounds!.y).toBeLessThan(60);
  await expect(body(page)).toBeFocused(); await expect(body(page).locator('.readable-item[open]')).toHaveCount(7);
  await expect(directory(page).locator('[aria-current="true"]')).toContainText('合规与披露');
  await atTail(page); await footer(page).locator('[data-readable-next]').click();
  await expect(body(page)).toContainText('公开信息核验未执行，不能据此判断无风险。');
  await expect(footer(page).locator('[data-readable-next]')).toHaveText('继续阅读：其他需确认事项 →');
  await footer(page).locator('[data-readable-next]').click(); await expect(body(page)).toContainText('名称需要确认');
  await expect(footer(page).locator('[data-readable-next]')).toHaveCount(0);
  await expectRun(page, 1); expect(new Set(state.readableReads)).toEqual(new Set([runId(1)]));
  expect(state.byteReads).toEqual([]); expect(immutable(state)).toEqual(before);
});

test('reader flow: returning to the directory preserves expanded items, cross-dimension search and no-match state', async ({ page }) => {
  const state = await open(page, fixture({ other: false })), before = immutable(state);
  await body(page).locator('.readable-item summary').first().click();
  const original = await body(page).innerHTML(), reads = state.readableReads.length;
  await atTail(page); await footer(page).getByRole('button', { name: '返回复核目录', exact: true }).click();
  await expect(directory(page)).toBeInViewport(); await expect(directory(page).locator('[data-readable-section="financial"]')).toBeFocused();
  expect(await body(page).innerHTML()).toBe(original); await expect(body(page).locator('.readable-item[open]')).toHaveCount(1);
  const search = page.getByRole('searchbox'); await search.fill('V1 合规披露事项7');
  await expect(body(page)).toContainText('V1 合规披露事项7'); await expect(body(page)).not.toContainText('V1 财务核对事项1');
  await expect(footer(page).locator('[data-readable-next]')).toHaveCount(0);
  const found = await body(page).innerHTML(); await atTail(page); await footer(page).locator('[data-readable-directory]').click();
  await expect(search).toBeFocused(); await expect(search).toHaveValue('V1 合规披露事项7'); expect(await body(page).innerHTML()).toBe(found);
  await search.fill('绝无匹配的合成关键词'); await expect(body(page)).toContainText('没有找到匹配内容');
  await footer(page).locator('[data-readable-directory]').click(); await expect(search).toHaveValue('绝无匹配的合成关键词'); await expect(search).toBeFocused();
  await expect(body(page)).toContainText('没有找到匹配内容'); expect(state.readableReads).toHaveLength(reads);
  await directory(page).locator('[data-readable-section="public"]').click(); await expect(search).toHaveValue('');
  await expect(footer(page).locator('[data-readable-next]')).toHaveCount(0); await expect(directory(page).locator('[data-readable-section]')).toHaveCount(3);
  expect(immutable(state)).toEqual(before); expect(state.byteReads).toEqual([]);
});

test('reader flow: footer downloads the exact old V1 pair, refresh keeps it, and selecting V2 replaces reading state and download actions', async ({ page }) => {
  const state = await open(page), before = immutable(state); await atTail(page);
  await download(page, footer(page).getByRole('button', { name: '下载本版原文批注版', exact: true }), state, artifactId(1, 'comments'));
  await download(page, footer(page).getByRole('button', { name: '下载本版复核报告（Word）', exact: true }), state, artifactId(1, 'report'));
  await page.reload(); await expect(body(page)).toContainText('V1 财务核对事项1'); await expectRun(page, 1);
  await expect(footer(page).locator('[data-review-action="download"]')).toHaveCount(2);
  await body(page).locator('.readable-item summary').first().click(); await page.getByRole('searchbox').fill('V1 财务核对事项1');
  await page.locator('[data-review-latest-result]').click(); await expect(body(page)).toContainText('V2 财务核对事项1'); await expectRun(page, 2);
  await expect(page.getByRole('searchbox')).toHaveValue(''); await expect(body(page).locator('.readable-item[open]')).toHaveCount(0);
  await expect(footer(page)).toHaveCount(1); await expect(footer(page).locator('[data-artifact-id="' + artifactId(1, 'report') + '"]')).toHaveCount(0);
  await atTail(page); await download(page, footer(page).getByRole('button', { name: '下载本版复核报告（Word）', exact: true }), state, artifactId(2, 'report'));
  expect(state.byteReads).toEqual([artifactId(1, 'comments'), artifactId(1, 'report'), artifactId(2, 'report')]); expect(immutable(state)).toEqual(before);
});

test('reader flow: footer uses the existing run check and rejects wrong-run metadata before reading bytes', async ({ page }) => {
  const state = await open(page); state.metadata.get(artifactId(1, 'report'))!.run_id = runId(2);
  const downloads: string[] = []; page.on('download', file => downloads.push(file.suggestedFilename()));
  await atTail(page); await footer(page).getByRole('button', { name: '下载本版复核报告（Word）', exact: true }).click();
  await expect(page.locator('#review-status')).toContainText('成果文件暂时无法读取或校验未通过');
  expect(state.metadataReads).toEqual([artifactId(1, 'report')]); expect(state.byteReads).toEqual([]); expect(downloads).toEqual([]); await expectRun(page, 1);
});

test('reader flow: failed body reads leave original Word downloads available and explicit retry restores footer actions', async ({ page }) => {
  const state = fixture(); state.failReadable = true;
  // open() waits for available prose; this case deliberately begins with failure.
  const { install, projectId } = await import('./review-flow-reader-fixtures'); await page.setViewportSize({ width: 1440, height: 1000 }); await install(page, state);
  await page.goto(`/#/projects/${projectId}/review?tab=results&run=${runId(1)}`);
  await expect(page.getByText('页面正文暂时无法读取，已生成的 Word 仍可下载。')).toBeVisible(); await expect(footer(page)).toHaveCount(0);
  await download(page, page.getByRole('button', { name: '下载复核报告（Word）', exact: true }), state, artifactId(1, 'report'));
  await page.getByRole('button', { name: '重新读取', exact: true }).click(); await expect(page.getByText('页面正文暂时无法读取，已生成的 Word 仍可下载。')).toBeVisible();
  state.failReadable = false; await page.getByRole('button', { name: '重新读取', exact: true }).click();
  await expect(body(page)).toContainText('V1 财务核对事项1'); await expect(footer(page).locator('[data-review-action="download"]')).toHaveCount(2); await expectRun(page, 1);
  expect(new Set(state.readableReads)).toEqual(new Set([runId(1)]));
});

test('reader flow: a retained revision reads its source V1 report with navigation only and keeps revision Word on run V4', async ({ page }) => {
  const state = await open(page, fixture({ revision: true })), before = immutable(state);
  await expect(footer(page).locator('[data-review-action="download"]')).toHaveCount(2);
  await page.locator('[data-review-latest-result]').click(); await expect(page.getByRole('heading', { name: '更新后的募集书已生成', exact: true })).toBeVisible();
  await expect(body(page)).toContainText('V1 财务核对事项1'); await expectRun(page, 4); await expect(footer(page)).toHaveCount(1);
  await expect(footer(page).locator('[data-readable-next]')).toHaveCount(1); await expect(footer(page).locator('[data-review-action="download"]')).toHaveCount(0);
  await download(page, page.getByRole('button', { name: '下载清洁版 Word', exact: true }), state, artifactId(4, 'clean'));
  await page.reload(); await expect(body(page)).toContainText('V1 财务核对事项1'); await expect(footer(page).locator('[data-review-action="download"]')).toHaveCount(0);
  await expect(page.getByText('根据复核结果更新募集书', { exact: true })).toHaveCount(0);
  expect(new Set(state.readableReads)).toEqual(new Set([runId(1)])); expect(state.byteReads).toEqual([artifactId(4, 'clean')]); expect(immutable(state)).toEqual(before);
});

test('reader flow desktop component comparison shows the same long historical report tail against exact R26', async ({ page }) => {
  const reference = process.env.BB_REVIEW_FLOW_REFERENCE === '1', verify = reference ? await installReaderFlowReference(page) : undefined;
  const evidence = process.env.BB_REVIEW_FLOW_EVIDENCE_DIR ?? test.info().outputPath('component-capture');
  const state = await open(page), before = immutable(state);
  await page.getByRole('button', { name: '展开全部事项', exact: true }).click(); await expect(body(page).locator('.readable-item[open]')).toHaveCount(7);
  await body(page).getByText('建议处理顺序', { exact: true }).click();
  if (reference) await expect(footer(page)).toHaveCount(0); else { await expect(footer(page)).toHaveCount(1); await expect(footer(page).locator('[data-review-action="download"]')).toHaveCount(2); }
  await body(page).evaluate(element => element.lastElementChild?.scrollIntoView({ block: 'end' }));
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const record = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, hash: location.hash,
    bodyTop: document.querySelector('.readable-body')!.getBoundingClientRect().top,
    footer: document.querySelector<HTMLElement>('[data-readable-footer]')?.innerText ?? null,
    tailText: document.querySelector('.readable-body')!.textContent!.slice(-900),
    reportRun: new URLSearchParams(location.hash.split('?')[1]).get('run') }));
  expect(record.bodyTop).toBeLessThan(-1500); expect(record.scrollWidth).toBeLessThanOrEqual(1441); expect(record.reportRun).toBe(runId(1));
  await mkdir(evidence!, { recursive: true }); const mode = reference ? 'r26' : 'current';
  await page.screenshot({ path: join(evidence!, `reader-flow-tail-${mode}-1440.png`) });
  await writeFile(join(evidence!, `reader-flow-tail-${mode}-1440.json`), JSON.stringify({ ...record, reference, audit: verify ? await verify() : null,
    scope: 'Same synthetic long V1 reader, newer V2 and active V3; viewport at its actual tail. No model/worker/ledger/Word acceptance.',
    writes: writes(state), readableReads: state.readableReads, byteReads: state.byteReads }, null, 2));
  expect(state.byteReads).toEqual([]); expect(immutable(state)).toEqual(before);
});
