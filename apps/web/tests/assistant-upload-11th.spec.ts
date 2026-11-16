import { expect, test, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assistantFixture, mountAssistant, ids, file, hash, now, noBusiness, uploadCalls, writes } from './assistant-upload-11th-fixtures';
import { installEleventhReference } from './upload-eleventh-reference';

async function capture(page: Page, name: string) {
  const directory = process.env.BB_ASSISTANT_UPLOAD_11TH_EVIDENCE_DIR ?? process.env.BB_ELEVENTH_EVIDENCE_DIR ?? process.env.BB_UX_EVIDENCE_DIR; if (!directory) return;
  await mkdir(directory, { recursive: true }); const filename = `assistant-upload-11th-${name}.png`, bytes = await page.screenshot({ path: join(directory, filename), fullPage: false });
  const record = await page.evaluate(() => ({ viewport: { width: innerWidth, height: innerHeight }, overflow: document.documentElement.scrollWidth > innerWidth + 1, text: document.body.innerText }));
  const captured = { filename, screenshot_sha256: hash(bytes), kind: 'viewport', scope: 'Actual ProjectAssistant component with current global CSS and strict synthetic public HTTP; no full account page or approved new prototype.', ...record };
  expect(record.overflow).toBe(false); await writeFile(join(directory, filename.replace('.png', '.json')), JSON.stringify(captured, null, 2)); return captured;
}

for (const entrypoint of ['attachment', 'business'] as const) for (const width of [1440, 390]) test(`${entrypoint} confirms the original upload after refresh without automatic writes or a second PUT at ${width}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 960 }); const state = await assistantFixture(page); if (entrypoint === 'attachment') state.dropPut = true; else state.dropComplete = true;
  await mountAssistant(page); if (entrypoint === 'business') await page.locator('[data-kind=update]').click();
  const picker = page.locator(entrypoint === 'attachment' ? '.ba-composer [data-file]' : '.ba-form [data-file=audit]'); await expect(picker).toHaveCount(1); await expect(picker).toBeAttached(); await expect(picker).toBeEnabled();
  const viewVersion = state.work.get(ids.topic)!.view.version;
  const viewSaved = page.waitForResponse(response => response.request().method() === 'PUT' && new URL(response.url()).pathname === `/api/v1/m4/topics/${ids.topic}/view` && response.request().postDataJSON().expected_version === viewVersion);
  await picker.setInputFiles(file);
  await expect(page.locator('[data-uploads] [data-a=retry-upload]')).toBeEnabled(); expect(uploadCalls(state, 'create')).toHaveLength(1); expect(uploadCalls(state, 'put')).toHaveLength(1);
  expect(uploadCalls(state, 'create')[0].path).toContain(`/projects/${ids.project}/`); expect(uploadCalls(state, 'create')[0].body).toMatchObject({ role: entrypoint === 'business' ? 'audit' : 'other' });
  // Settle the 500ms view autosave caused by selecting this file before measuring refresh-only writes.
  const savedViewResponse = await viewSaved; expect(savedViewResponse.status()).toBe(200); await savedViewResponse.finished();
  expect(state.work.get(ids.topic)!.view.version).toBe(viewVersion + 1);
  const original = [...state.uploads.keys()][0], before = writes(state).length;
  await mountAssistant(page, { navigation: 'reload' }); await expect(page.locator('[data-uploads]')).toContainText(file.name);
  // Exercise post-refresh timers beyond that autosave delay; every HTTP write still counts.
  await page.clock.runFor(1_000); expect(writes(state)).toHaveLength(before); noBusiness(state);
  await capture(page, `${entrypoint}-pending-${width}`); await page.locator('[data-uploads] [data-a=retry-upload]').click();
  await expect(page.locator('[data-uploads] [data-associated=true]')).toContainText('已保存并加入原对话'); expect(uploadCalls(state, 'create')).toHaveLength(1); expect(uploadCalls(state, 'put')).toHaveLength(1);
  expect(uploadCalls(state, 'complete').every(call => call.path.includes('/' + original + '/complete'))).toBe(true);
  expect(state.work.get(ids.topic)!.materials).toHaveLength(1); expect(state.work.get(ids.topic)!.materials[0].source_project_id).toBe(ids.project); expect(state.work.get(ids.otherTopic)!.materials).toHaveLength(0);
  expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.includes(':assistant-material:')))).toEqual([]); await capture(page, `${entrypoint}-saved-${width}`); noBusiness(state);
});

test('unknown association is read back only in its original topic and does not replay after refresh or drift to another topic', async ({ page }) => {
  const state = await assistantFixture(page); state.dropAssociation = true; await mountAssistant(page); const viewVersion = state.work.get(ids.topic)!.view.version;
  const viewSaved = page.waitForResponse(response => response.request().method() === 'PUT' && new URL(response.url()).pathname === `/api/v1/m4/topics/${ids.topic}/view` && response.request().postDataJSON().expected_version === viewVersion); await page.locator('.ba-composer [data-file]').setInputFiles(file);
  await expect(page.locator('[data-uploads] [data-a=retry-upload]')).toBeEnabled(); expect(state.work.get(ids.topic)!.materials).toHaveLength(1);
  // Isolate unknown membership recovery from the separate unsaved full-input restoration scenario.
  const savedViewResponse = await viewSaved; expect(savedViewResponse.status()).toBe(200); await savedViewResponse.finished(); expect(state.work.get(ids.topic)!.view.version).toBe(viewVersion + 1); await page.evaluate(async () => { const c = (window as any).assistantComponent; await c.saving; await c.cacheQueue; });
  const associations = () => state.calls.filter(call => call.method === 'POST' && call.path.endsWith('/materials') && call.path.startsWith('/m4/'));
  expect(associations()).toHaveLength(1); const original = associations()[0].body, before = writes(state).length; await mountAssistant(page, { navigation: 'reload' }); expect(writes(state)).toHaveLength(before);
  await page.getByRole('button', { name: '最近对话', exact: true }).click(); await page.locator(`[data-a=select][data-id="${ids.otherTopic}"]`).click(); await expect(page.locator('[data-uploads] [data-assistant-upload]')).toHaveCount(0);
  await page.getByRole('button', { name: '最近对话', exact: true }).click(); await page.locator(`[data-a=select][data-id="${ids.topic}"]`).click();
  await page.locator('[data-uploads] [data-a=retry-upload]').click(); await expect(page.locator('[data-uploads] [data-associated=true]')).toBeVisible();
  expect(associations()).toHaveLength(1); expect(associations()[0].body).toEqual(original); expect(state.work.get(ids.otherTopic)!.materials).toHaveLength(0); expect(uploadCalls(state, 'put')).toHaveLength(1); noBusiness(state);
});

test('disposing the old owner while complete is pending prevents any later topic association or new-owner adoption', async ({ page }) => {
  const state = await assistantFixture(page); let release!: () => void; state.gate = () => new Promise<void>(resolve => { release = resolve; }); await mountAssistant(page);
  await page.locator('.ba-composer [data-file]').setInputFiles(file); await expect.poll(() => uploadCalls(state, 'complete').length).toBe(1);
  await page.evaluate(() => (window as unknown as { assistantComponent: { dispose(): void } }).assistantComponent.dispose()); state.owner = ids.otherOwner;
  await mountAssistant(page, { owner: ids.otherOwner, navigation: 'same-page' }); release(); state.gate = undefined;
  await expect(page.locator('[data-uploads] [data-assistant-upload]')).toHaveCount(0); expect(state.work.get(ids.topic)!.materials).toHaveLength(0);
  expect(state.calls.filter(call => call.method === 'POST' && call.path.startsWith('/m4/') && call.path.endsWith('/materials'))).toEqual([]); noBusiness(state);
});

test('legal older-upload deduplication is associated and permits the user to continue to the normal message quote', async ({ page }) => {
  const state = await assistantFixture(page), saved = { material_id: 'assistant-upload-11th-dedup', material_version: 2, upload_id: 'older-real-upload', filename: '旧文件名.pdf', media_type: 'application/pdf' as const, byte_size: file.buffer.length, sha256: hash(file.buffer), role: 'other' as const, state: 'persisted' as const, persisted_at: now, error: null };
  state.materials.set(saved.material_id, { project: ids.project, material: saved }); await mountAssistant(page); await page.locator('.ba-composer [data-file]').setInputFiles(file);
  await expect(page.locator('[data-uploads] .duplicate-upload-notice')).toContainText('重复文件'); await expect(page.locator('[data-uploads] [data-associated=true]')).toBeVisible(); noBusiness(state);
  await page.locator('[data-composer]').fill('请说明这份材料的重点'); await page.locator('[data-a=send]').click(); await expect(page.locator('[data-qa-price]')).toContainText('60 积分');
  expect(state.calls.filter(call => call.method === 'POST' && call.path.endsWith('/quote'))).toHaveLength(1); expect(state.calls.filter(call => call.method === 'POST' && /\/(?:messages|execute)$/.test(call.path))).toEqual([]); expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test('template creation failure cannot become template success through the ordinary upload retry or permit a task', async ({ page }) => {
  const state = await assistantFixture(page); state.templateFailure = true; await mountAssistant(page); await page.locator('[data-kind=generation]').click(); await page.locator('[data-field=document_type]').selectOption('init');
  await page.locator('[data-field=market]').selectOption('sse'); await page.locator('[data-field=broker]').fill('原券商'); await page.clock.runFor(1000);
  await expect.poll(() => state.work.get(ids.topic)!.view.assistant?.action?.fields.broker).toBe('原券商'); await page.evaluate(async () => { const c = (window as any).assistantComponent; await c.saving; await c.cacheQueue; });
  await page.locator('[data-template-upload]').setInputFiles({ name: '原券商模板.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from('Synthetic template bytes') });
  const row = page.locator('[data-assistant-template-recovery-id]'); await expect(row.locator('[data-assistant-template-recovery-action=resume]')).toBeEnabled(); await expect(row).toContainText('创建结果'); await expect(row.locator('[data-a=retry-upload]')).toHaveCount(0); await expect(row.locator('[data-assistant-template-saved-status]')).toHaveCount(0);
  const before = writes(state).length; await page.locator('[data-a=prepare]').click(); await expect(page.locator('[data-status]')).toContainText('原券商模板保存'); expect(writes(state)).toHaveLength(before);
  await mountAssistant(page, { navigation: 'reload' }); await page.clock.runFor(13000); await expect(row.locator('[data-assistant-template-recovery-action=resume]')).toBeEnabled(); await expect(row.locator('[data-a=retry-upload]')).toHaveCount(0); await expect(row.locator('[data-assistant-template-saved-status]')).toHaveCount(0); expect(writes(state)).toHaveLength(before);
  const record = await page.evaluate(() => { const key = Object.keys(localStorage).find(value => value.startsWith('bb-assistant-template-upload-v1:'))!; return JSON.parse(localStorage.getItem(key)!); }); expect(record.items[0].stage).toBe('template_create_unknown'); expect(record.items[0].templateReceipt).toBeUndefined(); noBusiness(state); expect(state.calls.filter(call => call.method === 'POST' && call.path === '/m4/templates')).toHaveLength(1);
});

test('a restored pending attachment retains its changed full input and blocks the old prepared card before any execute request', async ({ page }) => {
  const state = await assistantFixture(page), work = state.work.get(ids.topic)!; state.dropPut = true;
  await page.clock.pauseAt(new Date(Date.parse(now) + 60_000));
  work.view.assistant = { ...work.view.assistant!, draft_token: 'old-ready-token', prepared_card_id: 'old-ready-card' };
  state.cards.push({ card_id: 'old-ready-card', execution_request_id: 'original-explicit-execution', operation: 'generation', project_id: ids.scope, document_type: 'private_summary', expected_draft_version: 1, quote_id: 'original-ready-quote',
    draft_token: 'old-ready-token', target: { issuer_name: '合成发行人', market: 'sse', offering: 'private', reporting_cutoff: '2026-09-30' }, created_at: now, project_name: '已有待开始的合成任务', requirements: '保持原要求', material_names: ['此前已保存材料.pdf'], baseline: null, quote: null, balance: { available: 10000, frozen: 0 }, run: null });
  await mountAssistant(page); await expect(page.locator('[data-a=execute]')).toBeEnabled(); await page.locator('.ba-composer [data-file]').setInputFiles(file);
  await expect(page.locator('[data-uploads] [data-a=retry-upload]')).toBeEnabled();
  // The clock is paused: the added file's draft-token autosave has not fired.
  expect(state.work.get(ids.topic)!.view.assistant!.draft_token).toBe('old-ready-token'); const candidate = await page.evaluate(async ({ owner, scope, topic }) => { const c = (window as any).assistantComponent; await c.cacheQueue; const key = 'bb-assistant-view-v1:' + [owner, scope, topic].map(encodeURIComponent).join(':'); return { page: c.viewSnapshot(), cache: JSON.parse(localStorage.getItem(key)!) }; }, ids); expect(candidate.page.view.assistant.draft_token).not.toBe('old-ready-token'); expect(candidate.page.view.assistant.prepared_card_id).toBe('old-ready-card'); expect(candidate.cache.snapshot.view).toEqual(candidate.page.view); expect(candidate.cache.snapshot.version).toBe(candidate.page.version); const before = writes(state).length;
  await mountAssistant(page, { navigation: 'reload' }); await expect(page.locator('[data-uploads] [data-a=retry-upload]')).toBeEnabled(); const restored = await page.evaluate(() => (window as any).assistantComponent.viewSnapshot()); expect(restored.view).toEqual(candidate.page.view); expect(restored.version).toBe(candidate.page.version); expect(restored.conflict).toBe(true); await expect(page.locator('[data-card="old-ready-card"]')).toContainText('输入已变化，请重新核对任务'); await expect(page.locator('[data-a=execute]')).toHaveCount(0); expect(writes(state)).toHaveLength(before);
  const guard = await page.evaluate(async () => { const c = (window as any).assistantComponent, card = c.cards.find((value: any) => value.card_id === 'old-ready-card'); if (!card) throw new Error('Original prepared card missing'); try { await c.execute(card); return null; } catch (error) { return error instanceof Error ? error.message : String(error); } }); expect(guard).toContain('完整会话'); await expect(page.locator('[data-status]')).toContainText('完整会话'); await page.clock.runFor(1000);
  expect(writes(state)).toHaveLength(before); expect(state.calls.filter(call => call.method === 'POST' && /\/execute$/.test(call.path))).toEqual([]); noBusiness(state);
});

for (const width of [1440, 390]) test(`assistant upload component comparison before and after refresh at ${width}`, async ({ page }) => {
  const directory = process.env.BB_ASSISTANT_UPLOAD_11TH_EVIDENCE_DIR ?? process.env.BB_ELEVENTH_EVIDENCE_DIR ?? process.env.BB_UX_EVIDENCE_DIR;
  test.skip(!directory, 'Explicit evidence directory is required for component comparison');
  const reference = process.env.BB_ELEVENTH_REFERENCE === '1', finish = reference ? await installEleventhReference(page, ['project-assistant']) : undefined;
  await page.setViewportSize({ width, height: 960 }); const state = await assistantFixture(page); await page.clock.pauseAt(new Date(Date.parse(now) + 60_000)); state.dropPut = true; await mountAssistant(page);
  await page.locator('.ba-composer [data-file]').setInputFiles(file); await expect(page.locator('[data-uploads]')).toContainText(file.name); await expect(page.locator('[data-uploads] button').first()).toBeEnabled();
  const flavor = reference ? 'reference' : 'implementation', records = [await capture(page, `${flavor}-pending-${width}`)], before = writes(state).length;
  await mountAssistant(page, { navigation: 'reload' }); expect(writes(state)).toHaveLength(before);
  if (reference) { await expect(page.locator('[data-uploads]')).toBeEmpty(); expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.includes(':assistant-material:')))).toEqual([]); }
  else await expect(page.locator('[data-uploads] [data-a=retry-upload]')).toBeEnabled();
  records.push(await capture(page, `${flavor}-refreshed-${width}`)); noBusiness(state);
  const sources = finish ? await finish() : undefined;
  await writeFile(join(directory!, `assistant-upload-11th-${flavor}-comparison-${width}.json`), JSON.stringify({ reference, source: sources ?? { scope: 'Current implementation; no approved new recovery prototype.' }, records, writes_after_refresh: 0, original_upload_creates: uploadCalls(state, 'create').length, original_puts: uploadCalls(state, 'put').length, errors: state.errors, unexpected_requests: state.unexpected }, null, 2));
});
