import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { installEleventhReference } from './upload-eleventh-reference';
import { assertQaUpload11th, installQaUpload11th, qaTransportWrites, qaUploadFile, qaUploadFixture, qaUploadUrl } from './qa-upload-11th-fixtures';

const reference = process.env.BB_ELEVENTH_REFERENCE === '1';
test.skip(!process.env.BB_ELEVENTH_EVIDENCE_DIR, 'Explicit component comparison evidence run only.');
for (const kind of ['supplement', 'source'] as const) for (const width of [1440, 390]) {
  test(`QA ${kind} refreshed upload component comparison at ${width}`, async ({ page }) => {
    const finalize = reference ? await installEleventhReference(page, ['project-qa-workspace']) : undefined;
    const directory = process.env.BB_ELEVENTH_EVIDENCE_DIR!;
    await page.setViewportSize({ width, height: 960 });
    page.on('dialog', dialog => void dialog.accept());
    const state = qaUploadFixture(); await installQaUpload11th(page, state); await page.goto(qaUploadUrl);
    const picker = page.locator(kind === 'source' ? '#qa-upload' : '#qa-supplement');
    await expect(picker).toBeEnabled();
    await picker.setInputFiles(qaUploadFile(kind === 'source' ? '合成原问题清单.doc' : '合成原补充材料.pdf'));
    await expect.poll(() => state.calls.filter(call => call.method === 'PUT').length).toBe(1);
    if (reference) await expect(page.locator('#project-qa-status')).not.toBeEmpty();
    else await expect(page.locator('[data-qa-upload-action="resume"]')).toBeVisible();
    const before = qaTransportWrites(state).length;
    await page.reload(); await expect(picker).toBeAttached();
    if (reference) await expect(page.locator('[data-qa-upload-id]')).toHaveCount(0);
    else await expect(page.locator('[data-qa-upload-action="resume"]')).toBeVisible();
    expect(qaTransportWrites(state)).toHaveLength(before);
    expect(state.qa.prepares).toEqual([]);
    const region = page.locator(kind === 'source' ? '.qa-upload' : '.qa-materials'); await region.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    const name = `qa-upload-eleventh-${reference ? 'reference-r10' : 'implementation'}-${kind}-refreshed-${width}`;
    await mkdir(directory, { recursive: true }); const png = await page.screenshot({ path: join(directory, name + '.png') });
    await assertQaUpload11th(page, state);
    await writeFile(join(directory, name + '.json'), JSON.stringify({ viewport: { width, height: 960 },
      screenshot: name + '.png', screenshot_sha256: createHash('sha256').update(png).digest('hex'),
      view: kind + '-refreshed', overflow: false, writes_after_refresh: qaTransportWrites(state).length - before,
      source_prepares: state.qa.prepares.length, errors: state.qa.errors, unexpected_requests: state.unexpected,
      ...(finalize ? { reference: await finalize() } : {}) }, null, 2));
  });
}
