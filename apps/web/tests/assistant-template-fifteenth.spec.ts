import { expect, test, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { M4Template, M4ViewState } from '@bondbuddy/contracts';
import { installFifteenthReference } from './upload-fifteenth-reference';
import { fixture, install, mount, mountQa, ids, now, templateFile, attachmentFile, hash, pin, pinKey, sourcePin, artifactPin, work, viewOf, writes, templatePosts, viewWrites, memberships, uploads, noBusiness, recovery, resume, select, records, cache, settle, pending, saved, refreshReadOnly, type State } from './assistant-template-fifteenth-fixtures';

const created = (state: State) => [...state.templateKeys.values()][0].template;
const savedStatus = (page: Page) => recovery(page).locator('[data-assistant-template-saved-status]');
function adopted(original: M4ViewState, template: M4Template, token: string): M4ViewState { return { ...structuredClone(original), assistant: { ...structuredClone(original.assistant!), template_key: template.template_id + '/' + template.template_version, draft_token: token } }; }
function oneTransport(state: State) { expect(uploads(state, 'create')).toHaveLength(1); expect(uploads(state, 'bytes')).toHaveLength(1); expect(memberships(state)).toHaveLength(1); expect(templatePosts(state)).toHaveLength(1); }
async function localView(page: Page) { return page.evaluate(() => { const c = (window as any).assistantComponent; return { ...structuredClone(c.workspace.view), unsent_content: c.text }; }); }
async function holdCreation(page: Page, state: State) { let release!: () => void; state.templateGate = () => new Promise<void>(resolve => { release = resolve; }); await select(page); await expect.poll(() => templatePosts(state).length).toBe(1); return () => { state.templateGate = undefined; release(); }; }
const declaration = () => ({ filename: templateFile.name, media_type: templateFile.mimeType, byte_size: templateFile.buffer.length, sha256: hash(templateFile.buffer), role: 'other' });

test('assistant template actual global card edit saves original-topic material, exact template and full view with one fixed task invalidation', async ({ page }) => {
  const state = await install(page), original = viewOf(work(state)), version = work(state).view.version, drafts = structuredClone(work(state).drafts); await mount(page);
  await expect(page.locator('[data-template-upload]')).toHaveAttribute('accept', '.docx'); await expect(page.locator('[data-template-upload]')).not.toHaveAttribute('multiple'); await expect(page.locator('[data-template]')).toHaveValue(original.assistant!.template_key!);
  await select(page); await saved(page, state); oneTransport(state); expect(uploads(state, 'create')[0].path).toBe('/projects/' + ids.scope + '/materials/uploads'); expect(uploads(state, 'create')[0].body).toEqual(declaration());
  const request = templatePosts(state)[0]; expect(request).toEqual({ creation_request_id: expect.any(String), name: templateFile.name, broker: original.assistant!.action!.fields.broker, document_type: 'init', market: 'sse', material: pin(ids.scope, [...state.uploads.values()][0].material!) });
  const token = work(state).view.assistant!.draft_token!; expect(token).not.toBe(original.assistant!.draft_token); expect(work(state).view).toEqual({ ...adopted(original, created(state), token), version: version + 1 }); expect(viewWrites(state)).toEqual([{ expected_version: version, view: adopted(original, created(state), token) }]);
  expect(work(state).drafts).toEqual(drafts); expect(work(state).view.assistant!.prepared_card_id).toBe(ids.card); await expect(page.locator('[data-a=execute]')).toHaveCount(0); await expect(page.locator('[data-template]')).toHaveValue(created(state).template_id + '/1'); expect(writes(state).filter(value => value.path.includes('/projects/' + ids.project + '/'))).toEqual([]); noBusiness(state);
});

test('assistant template global shortcut reaches the real initiation form before upload without task preparation', async ({ page }) => {
  const state = fixture(); work(state).view.assistant = { project_id: ids.project, action: null }; state.cards.set(ids.topic, []); await install(page, state); await mount(page, { form: false });
  await page.locator('[data-kind=generation]').click(); await page.locator('[data-field=document_type]').selectOption('init'); await page.locator('[data-field=market]').selectOption('sse'); await page.locator('[data-field=broker]').fill('快捷入口券商'); await page.clock.runFor(1000); await settle(page);
  const before = writes(state).length, original = viewOf(work(state)); await select(page); await saved(page, state); expect(writes(state).slice(before).every(value => !value.path.endsWith('/cards'))).toBe(true); expect(work(state).view.assistant!.action).toEqual(original.assistant!.action); expect(templatePosts(state)[0].broker).toBe('快捷入口券商'); noBusiness(state);
});

test('assistant template global host retains its original task while leaving the actual QA workspace', async ({ page }) => {
  const state = await install(page); await mountQa(page); const host = await page.locator('.bb-assistant').elementHandle();
  const release = await holdCreation(page, state); await page.evaluate(() => { (window as any).qaComponent.dispose(); }); await expect(page.locator('.bb-assistant')).toBeVisible(); release(); await saved(page, state);
  expect(await host!.evaluate(value => value.isConnected && value.parentElement === document.body)).toBe(true); expect(uploads(state, 'create')[0].path).toContain('/projects/' + ids.scope + '/'); expect(work(state).view.assistant!.project_id).toBe(ids.project); expect(work(state).view.assistant!.template_key).toBe(created(state).template_id + '/1'); noBusiness(state);
});

for (const field of ['broker', 'market', 'offering'] as const) test('assistant template invalid ' + field + ' blocks every prospective stage', async ({ page }) => {
  const state = fixture(); (work(state).view.assistant!.action!.fields as Record<string, string | undefined>)[field] = field === 'broker' ? '   ' : field === 'market' ? undefined : 'public'; await install(page, state); await mount(page); await select(page); await settle(page); await page.clock.runFor(1000); expect(writes(state)).toEqual([]); expect(await records(page)).toEqual([]); noBusiness(state);
});

for (const stage of ['bytes', 'complete'] as const) test('assistant template lost ' + stage + ' acknowledgement restores without writes and confirms only its original upload', async ({ page }) => {
  const state = await install(page); if (stage === 'bytes') state.dropPut = 'after'; else state.dropComplete = 'after'; await mount(page); await pending(page, state); const originalUpload = [...state.uploads.keys()][0], before = await refreshReadOnly(page, state);
  expect(templatePosts(state)).toEqual([]); expect(writes(state)).toHaveLength(before); await resume(page).click(); await saved(page, state); oneTransport(state); expect(uploads(state, 'complete').every(value => value.path.endsWith('/' + originalUpload + '/complete'))).toBe(true); expect(work(state).view.version).toBe(8);
});

for (const drop of ['before', 'after'] as const) test('assistant template membership loss ' + drop + ' acceptance retains exact original-topic relation', async ({ page }) => {
  const state = await install(page); state.dropMembership = drop; if (drop === 'after') state.afterMembership = () => { state.failWorkspaceReads = true; }; await mount(page); await pending(page, state); const first = structuredClone(memberships(state)[0].body); state.failWorkspaceReads = false; state.afterMembership = undefined; await refreshReadOnly(page, state); expect(templatePosts(state)).toEqual([]); await resume(page).click(); await saved(page, state);
  expect(memberships(state).map(value => value.body)).toEqual(drop === 'before' ? [first, first] : [first]); expect(state.work.get(ids.otherTopic)!.materials).not.toContainEqual(first.material); expect(uploads(state, 'create')).toHaveLength(1); expect(uploads(state, 'bytes')).toHaveLength(1); noBusiness(state);
});

for (const drop of ['before', 'after'] as const) test('assistant template unknown creation ' + drop + ' acceptance never infers a receipt from owner-list similarity', async ({ page }) => {
  const state = await install(page); state.dropTemplate = drop; await mount(page); await pending(page, state); const request = structuredClone(templatePosts(state)[0]);
  if (drop === 'before') { const value: M4Template = { ...state.templates[0], template_id: 'assistant-template-15-decoy', template_version: 1, material: request.material, sha256: request.material.sha256, name: request.name, broker: request.broker }; state.templates.push(value); state.templateKeys.set('assistant-template-15-decoy-key', { request: { ...request, creation_request_id: 'assistant-template-15-decoy-key' }, template: value }); }
  await refreshReadOnly(page, state); expect((await records(page))[0].value.items[0].templateReceipt).toBeUndefined(); expect(viewWrites(state)).toEqual([]); await resume(page).click(); await saved(page, state);
  expect(templatePosts(state)).toEqual([request, request]); expect(state.templateKeys.size).toBe(drop === 'before' ? 2 : 1); expect(uploads(state, 'create')).toHaveLength(1); expect(memberships(state)).toHaveLength(1); noBusiness(state);
});

for (const unavailable of ['retired', 'material-missing'] as const) test('assistant template original unknown receipt becomes known ' + unavailable + ' without adoption or replacement', async ({ page }) => {
  const state = await install(page); state.dropTemplate = 'after'; await mount(page); await pending(page, state); const request = structuredClone(templatePosts(state)[0]), template = created(state);
  if (unavailable === 'retired') { template.status = 'retired'; template.retired_at = now; } else state.materials.delete(pinKey(template.material));
  await refreshReadOnly(page, state); expect((await records(page))[0].value.items[0].templateReceipt).toBeUndefined(); await resume(page).click(); await expect(resume(page)).toBeEnabled(); const item = (await records(page))[0].value.items[0];
  expect(item.templateReceipt).toEqual(template); expect(item.templateAvailability).toBe('unavailable'); expect(templatePosts(state)).toEqual([request, request]); expect(state.templateKeys.size).toBe(1); expect(viewWrites(state)).toEqual([]); expect(work(state).view.version).toBe(7); expect(memberships(state)).toHaveLength(1); await expect(savedStatus(page)).toContainText('模板已保存'); await expect(savedStatus(page)).toContainText('不可'); await expect(page.locator('[data-template] option[value="' + template.template_id + '/1"]')).toHaveCount(0); noBusiness(state);
  if (unavailable === 'material-missing') expect(await page.evaluate(p => (window as any).assistantComponent.workspace.materials.some((value: any) => JSON.stringify(value) === JSON.stringify(p)), template.material)).toBe(false);
});

test('assistant template malformed receipt cannot change exact material identity or permit view adoption', async ({ page }) => {
  const state = await install(page); state.templateResponse = value => ({ ...value, sha256: hash('Incorrect returned template digest') }); await mount(page); await pending(page, state); const request = templatePosts(state)[0]; await refreshReadOnly(page, state); await resume(page).click(); await expect(resume(page)).toBeEnabled(); expect(templatePosts(state).every(value => JSON.stringify(value) === JSON.stringify(request))).toBe(true); expect(viewWrites(state)).toEqual([]); expect(state.templateKeys.size).toBe(1); noBusiness(state);
});

test('assistant template known receipt stays explicit after concurrent server full-view edit and read-only refresh', async ({ page }) => {
  const state = await install(page), original = viewOf(work(state)); state.afterTemplate = () => { work(state).view = { ...work(state).view, version: 8, unsent_content: '服务器另一页面的新讨论' }; }; await mount(page); await pending(page, state);
  expect((await records(page))[0].value.items[0].templateReceipt).toEqual(created(state)); await expect(savedStatus(page)).toContainText('模板已保存'); expect(viewWrites(state)).toEqual([]); await refreshReadOnly(page, state); await expect(savedStatus(page)).toContainText('模板已保存'); expect(work(state).view.assistant!.template_key).toBe(original.assistant!.template_key); noBusiness(state);
});

for (const drop of ['before', 'after'] as const) test('assistant template lost view receipt ' + drop + ' acceptance keeps one full CAS and fixed task token', async ({ page }) => {
  const state = await install(page), original = viewOf(work(state)); state.dropView = drop; if (drop === 'after') state.afterView = () => { state.failWorkspaceReads = true; }; await mount(page); await pending(page, state); const request = structuredClone(viewWrites(state)[0]), token = request.view.assistant!.draft_token!;
  expect(request).toEqual({ expected_version: 7, view: adopted(original, created(state), token) }); state.failWorkspaceReads = false; state.afterView = undefined; await refreshReadOnly(page, state); if (drop === 'before') { await expect(resume(page)).toBeEnabled(); await resume(page).click(); } await saved(page, state);
  expect(viewWrites(state)).toEqual(drop === 'before' ? [request, request] : [request]); expect(work(state).view).toEqual({ ...request.view, version: 8 }); oneTransport(state); expect(work(state).view.assistant!.prepared_card_id).toBe(ids.card);
});

test('assistant template full-view v0 reaches v1 without document-draft no-op or pending consumption', async ({ page }) => {
  const state = await install(page); work(state).view.version = 0; const requirement = '原文种另有待采用要求'; work(state).messages = [{ message_id: 'assistant-template-15-origin-message', role: 'assistant', content: requirement, version: 2, context: structuredClone(work(state).view.unsent_context), created_at: now, reply_status: 'completed', reply_to: null, run_id: null, reply: { content: requirement, citations: [], requirements: [requirement], fields: {}, intent: 'draft', document_type: 'legal', target_business: 'generation', retrieval: 'not_performed' }, error: null }]; work(state).pending_requirements = [{ requirement_id: 'assistant-template-15-pending', message_id: 'assistant-template-15-origin-message', message_version: 2, text: requirement }]; const drafts = structuredClone(work(state).drafts), pendingRequirements = structuredClone(work(state).pending_requirements), messages = structuredClone(work(state).messages); await mount(page); await select(page); await saved(page, state); expect(viewWrites(state)[0].expected_version).toBe(0); expect(work(state).view.version).toBe(1); expect(work(state).drafts).toEqual(drafts); expect(work(state).pending_requirements).toEqual(pendingRequirements); expect(work(state).messages).toEqual(messages); noBusiness(state);
});

test('assistant template higher version with identical full saved view cannot prove or rebase the original CAS', async ({ page }) => {
  const state = await install(page); state.dropView = 'after'; state.afterView = () => { work(state).view.version++; }; await mount(page); await pending(page, state); const request = structuredClone(viewWrites(state)[0]); await refreshReadOnly(page, state); await resume(page).click(); await expect(resume(page)).toBeEnabled();
  expect(viewWrites(state)).toEqual([request]); expect(work(state).view.version).toBe(9); expect((await records(page))[0].value.items[0].templateReceipt).toEqual(created(state)); noBusiness(state);
});

test('assistant template malformed view success does not establish exact full adoption proof', async ({ page }) => {
  const state = await install(page); state.viewResponse = value => ({ ...value, version: value.version + 2 }); state.failWorkspaceReads = false; state.afterView = () => { state.failWorkspaceReads = true; }; await mount(page); await pending(page, state); expect(viewWrites(state)).toHaveLength(1); expect((await records(page))[0].value.items[0].viewRequest).toEqual(viewWrites(state)[0]); expect((await records(page))[0].value.items[0].observedView).toBeUndefined(); noBusiness(state);
});

test('assistant template new full local input before adoption keeps its original version while template remains known', async ({ page }) => {
  const state = await install(page); await mount(page); const release = await holdCreation(page, state); await page.locator('[data-composer]').fill('模板请求期间本页新增且尚未发送的讨论'); release(); await expect(resume(page)).toBeEnabled(); await settle(page);
  expect(viewWrites(state)).toEqual([]); expect(work(state).view.version).toBe(7); await expect(page.locator('[data-composer]')).toHaveValue('模板请求期间本页新增且尚未发送的讨论'); const local = await cache(page); expect(local.snapshot.version).toBe(7); expect(local.snapshot.view.unsent_content).toBe('模板请求期间本页新增且尚未发送的讨论'); expect(local.snapshot.dirty).toBe(true); expect((await records(page))[0].value.items[0].templateReceipt).toEqual(created(state)); await refreshReadOnly(page, state); await expect(page.locator('[data-composer]')).toHaveValue('模板请求期间本页新增且尚未发送的讨论'); noBusiness(state);
});

test('assistant template actual editable action and requirements during creation restore as one complete original-version candidate', async ({ page }) => {
  const state = await install(page), original = viewOf(work(state)); await mount(page); const release = await holdCreation(page, state);
  await expect(page.locator('[data-field=broker]')).toBeEnabled(); await expect(page.locator('[data-requirements]')).toBeEnabled(); await page.locator('[data-field=broker]').fill('本页后来选择的另一券商'); await page.locator('[data-requirements]').fill('本页多字段D：只补充风险提示，保留所有数字和引用。'); await page.locator('[data-composer]').fill('与新任务字段一起保留的未发送讨论'); release(); await expect(resume(page)).toBeEnabled(); await settle(page);
  expect(viewWrites(state)).toEqual([]); expect(work(state).view).toEqual({ ...original, version: 7 }); const local = await cache(page), expected = structuredClone(original); expected.assistant!.action!.fields.broker = '本页后来选择的另一券商'; expected.assistant!.action!.requirements = '本页多字段D：只补充风险提示，保留所有数字和引用。'; expected.assistant!.draft_token = local.snapshot.view.assistant.draft_token; expected.unsent_content = '与新任务字段一起保留的未发送讨论'; expect(local.snapshot.view).toEqual(expected); expect(local.snapshot.version).toBe(7); expect(local.snapshot.dirty).toBe(true); expect((await records(page))[0].value.items[0].templateReceipt).toEqual(created(state));
  await refreshReadOnly(page, state); await expect(page.locator('[data-field=broker]')).toHaveValue('本页后来选择的另一券商'); await expect(page.locator('[data-requirements]')).toHaveValue('本页多字段D：只补充风险提示，保留所有数字和引用。'); await expect(page.locator('[data-composer]')).toHaveValue('与新任务字段一起保留的未发送讨论'); expect((await cache(page)).snapshot.view).toEqual(expected); expect((await cache(page)).snapshot.version).toBe(7); noBusiness(state);
});

for (const cacheFault of [false, true]) test('assistant template local typing during sent view retains exact server proof and separate input' + (cacheFault ? ' when cache fails' : ''), async ({ page }) => {
  const state = await install(page), original = viewOf(work(state)); await mount(page); let release!: () => void; state.viewGate = () => new Promise<void>(resolve => { release = resolve; }); await select(page); await expect.poll(() => viewWrites(state).length).toBe(1);
  if (cacheFault) await page.evaluate(() => { const set = Storage.prototype.setItem; Storage.prototype.setItem = function(key, value) { if (key.startsWith('bb-assistant-view-v1:')) throw new DOMException('Synthetic local view quota', 'QuotaExceededError'); return set.call(this, key, value); }; });
  await page.locator('[data-composer]').fill('发送完整view后新增的本页输入D'); state.viewGate = undefined; release(); await settle(page); await page.clock.runFor(1000); await settle(page);
  expect(work(state).view).toEqual({ ...viewWrites(state)[0].view, version: 8 }); expect(work(state).view.unsent_content).toBe(original.unsent_content); expect(viewWrites(state)).toHaveLength(1); await expect(page.locator('[data-composer]')).toHaveValue('发送完整view后新增的本页输入D');
  if (!cacheFault) { const local = await cache(page); expect(local.snapshot.version).toBe(7); expect(local.snapshot.view.unsent_content).toBe('发送完整view后新增的本页输入D'); expect(local.snapshot.conflict).toBe(true); const before = writes(state).length; await refreshReadOnly(page, state); expect(writes(state)).toHaveLength(before); await expect(page.locator('[data-composer]')).toHaveValue('发送完整view后新增的本页输入D'); }
  else { const pending = await records(page); expect(pending).toHaveLength(1); expect(pending[0].value.items[0].stage).toBe('cleanup_pending'); expect(pending[0].value.items[0].localCacheResult).toBe('preserved'); expect(pending[0].value.items[0].observedView).toEqual(work(state).view); expect(pending[0].value.items[0].viewRequest).toEqual(viewWrites(state)[0]); await expect(resume(page)).toBeEnabled(); }
  noBusiness(state);
});

test('assistant template stale workspace GET cannot roll back later exact template adoption or membership', async ({ page }) => {
  const state = await install(page); await mount(page); let release!: () => void, entered = false; const gate = new Promise<void>(resolve => { release = resolve; }); state.workspaceGate = async value => { if (!entered) { entered = true; expect(value.view.version).toBe(7); await gate; } };
  await page.evaluate(() => { void (window as any).assistantComponent.poll(); }); await expect.poll(() => entered).toBe(true); await select(page); await expect.poll(() => templatePosts(state).length).toBe(1); await expect.poll(async () => (await records(page)).length).toBe(0); const token = work(state).view.assistant!.draft_token, before = writes(state).length; state.workspaceGate = undefined; release(); await settle(page);
  await expect(page.locator('[data-template]')).toHaveValue(created(state).template_id + '/1'); expect((await localView(page)).assistant.draft_token).toBe(token); expect(await page.evaluate(p => (window as any).assistantComponent.workspace.materials.some((value: any) => JSON.stringify(value) === JSON.stringify(p)), created(state).material)).toBe(true); expect(writes(state)).toHaveLength(before); noBusiness(state);
});

test('assistant template old cache queue and real final apply preserve a newer complete local candidate', async ({ page }) => {
  const state = await install(page), original = viewOf(work(state)); await mount(page);
  await page.evaluate(() => { const w = window as any, c = w.assistantComponent, apply = c.applyAssistantTemplateUploadResult; w.templateQueueFault = { injected: false }; c.applyAssistantTemplateUploadResult = function(result: any) { if (result.applyToPage && !w.templateQueueFault.injected) { w.templateQueueFault.injected = true; let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); this.cacheQueue = this.cacheQueue.then(() => gate); this.cache(); const input = document.querySelector<HTMLTextAreaElement>('[data-composer]')!; input.value = '旧B缓存队列之后必须保留的新输入D'; input.dispatchEvent(new Event('input', { bubbles: true })); try { const applied = apply.call(this, result); w.templateQueueFault.applied = applied; return applied; } finally { release(); } } return apply.call(this, result); }; });
  await select(page); await expect.poll(() => page.evaluate(() => (window as any).templateQueueFault.injected)).toBe(true); await settle(page); await page.clock.runFor(1000); await settle(page);
  expect(await page.evaluate(() => (window as any).templateQueueFault.applied)).toBe(false); expect(work(state).view.unsent_content).toBe(original.unsent_content); const local = await cache(page); expect(local.snapshot.version).toBe(7); expect(local.snapshot.view.unsent_content).toBe('旧B缓存队列之后必须保留的新输入D'); expect(local.snapshot.conflict).toBe(true); expect(viewWrites(state)).toHaveLength(1); noBusiness(state);
});

for (const namespace of ['bb-assistant-template-upload-v1:', 'bb-assistant-view-v1:']) test('assistant template declaration cannot write when durable ' + namespace + ' storage is unavailable', async ({ page }) => {
  const state = await install(page); await mount(page); await page.evaluate(prefix => { const set = Storage.prototype.setItem; Storage.prototype.setItem = function(key, value) { if (key.startsWith(prefix)) throw new DOMException('Synthetic quota', 'QuotaExceededError'); return set.call(this, key, value); }; }, namespace); await select(page); await settle(page); await page.clock.runFor(1000); expect(writes(state)).toEqual([]); noBusiness(state);
});

test('assistant template late transport acknowledgement after account disposal cannot reveal or continue original work', async ({ page }) => {
  const state = await install(page); let release!: () => void; state.completeGate = () => new Promise<void>(resolve => { release = resolve; }); await mount(page); await select(page); await expect.poll(() => uploads(state, 'complete').length).toBe(1); state.owner = ids.otherOwner; await mount(page, { owner: ids.otherOwner, navigation: 'same-page' }); state.completeGate = undefined; release(); await page.clock.runFor(1000);
  await expect(page.locator('body')).not.toContainText(templateFile.name); expect(memberships(state)).toEqual([]); expect(templatePosts(state)).toEqual([]); expect(viewWrites(state)).toEqual([]); expect((await records(page))[0].value.owner).toBe(ids.owner); noBusiness(state);
});

test('assistant template switching conversations never retargets original recovery to another topic or associated project', async ({ page }) => {
  const state = await install(page); state.dropTemplate = 'after'; await mount(page); await pending(page, state); const original = structuredClone(templatePosts(state)[0]), before = writes(state).length;
  await page.locator('[data-a=history]').click(); await page.locator('[data-a=select][data-id="' + ids.otherTopic + '"]').click(); await settle(page); await page.clock.runFor(1000); expect(writes(state)).toHaveLength(before); expect(state.work.get(ids.otherTopic)!.view.assistant!.template_key).toBeUndefined(); expect(state.work.get(ids.otherTopic)!.materials).toEqual([]); expect(templatePosts(state)).toEqual([original]); expect((await records(page))[0].value.topicId).toBe(ids.topic); noBusiness(state);
});

test('assistant template actual business-write instrumentation blocks preparation during pending action and retains its uncertain outcome', async ({ page }) => {
  const state = await install(page); await mount(page);
  // Exercise the real instrumentation with a held/failing callback, without submitting an actual paid task.
  await page.evaluate(topic => { const w = window as any, c = w.assistantComponent; void c.businessWrite(topic, () => new Promise((_resolve, reject) => { w.rejectRuntimeAction = reject; })).catch((e: Error) => { w.runtimeActionError = e.message; }); }, ids.topic);
  await expect.poll(() => page.evaluate(() => (window as any).assistantComponent.actionPending)).toBe(1); await select(page); expect(writes(state)).toEqual([]);
  await page.evaluate(() => { (window as any).rejectRuntimeAction(new Error('Synthetic business acknowledgement lost')); }); await expect.poll(() => page.evaluate(() => (window as any).assistantComponent.actionUncertain)).toBe(true); await settle(page);
  const local = await cache(page); expect(local.snapshot.runtime.pending).toBe(false); expect(local.snapshot.runtime.uncertain).toBe(true); expect(await records(page)).toEqual([]); expect(writes(state)).toEqual([]); noBusiness(state);
});

test('assistant template local runtime-uncertainty fault during sent view preserves server proof without adopting a different task context', async ({ page }) => {
  const state = await install(page); await mount(page); let release!: () => void; state.viewGate = () => new Promise<void>(resolve => { release = resolve; }); await select(page); await expect.poll(() => viewWrites(state).length).toBe(1);
  await page.evaluate(async () => { const c = (window as any).assistantComponent; c.actionUncertain = true; c.runtimeGeneration++; c.cache(); await c.cacheQueue; }); state.viewGate = undefined; release(); await settle(page); await page.clock.runFor(1000);
  expect(viewWrites(state)).toHaveLength(1); const local = await cache(page); expect(local.snapshot.version).toBe(7); expect(local.snapshot.runtime.uncertain).toBe(true); expect((await localView(page)).assistant.template_key).not.toBe(created(state).template_id + '/1'); noBusiness(state);
});

for (const contender of ['material', 'template'] as const) test('assistant template and ' + contender + ' preparation in two pages admit one durable original-topic operation', async ({ page, context }) => {
  const state = await install(page); await mount(page); const other = await context.newPage(); await install(other, state); await mount(other); const before = writes(state).length;
  const results = await Promise.all([page.evaluate(async value => { try { await (window as any).assistantComponent.assistantTemplateUploads.prepare(value); return 'prepared'; } catch { return 'blocked'; } }, declaration()),
    other.evaluate(async ({ contender, value, project, topic }) => { const c = (window as any).assistantComponent; try { if (contender === 'template') await c.assistantTemplateUploads.prepare(value); else await c.materialUploads.begin(new File(['ordinary'], '并发普通材料.pdf', { type: 'application/pdf' }), 'other', project, topic, 'attachment', crypto.randomUUID()); return 'prepared'; } catch { return 'blocked'; } }, { contender, value: declaration(), project: ids.project, topic: ids.topic })]);
  expect(results.sort()).toEqual(['blocked', 'prepared']); expect(writes(state)).toHaveLength(before);
  const countPending = () => page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('bb-assistant-template-upload-v1:') || key.startsWith('bondbuddy:upload-recovery:v1:') && key.includes(':assistant-material:')).length);
  expect(await countPending()).toBe(1); await other.close(); expect(await countPending()).toBe(1); noBusiness(state);
});

test('assistant template unresolved recovery blocks ordinary attachment, autosave and all task writes while preserving local editing', async ({ page }) => {
  const state = await install(page); state.dropTemplate = 'after'; await mount(page); await pending(page, state); const before = writes(state).length;
  await page.locator('[data-composer]').fill('模板待确认时仍可写的本页讨论'); await page.evaluate(async () => { const c = (window as any).assistantComponent; try { await c.flush(); } catch {} try { await c.send(); } catch {} try { await c.prepare(); } catch {} const card = c.cards[0]; if (card) try { await c.execute(card); } catch {} }); await page.clock.runFor(13000); await settle(page);
  expect(writes(state)).toHaveLength(before); await expect(page.locator('[data-composer]')).toHaveValue('模板待确认时仍可写的本页讨论'); noBusiness(state);
});

test('assistant template original reselect rejects changed bytes without new declaration and accepts renamed equal content', async ({ page }) => {
  const state = await install(page); state.dropPut = 'before'; await mount(page); await pending(page, state); await refreshReadOnly(page, state); await resume(page).click(); const picker = recovery(page).locator('[data-assistant-template-recovery-reselect]'); await expect(picker).toBeAttached(); const before = writes(state).length, original = structuredClone((await records(page))[0].value.items[0].declaration);
  await picker.setInputFiles({ ...templateFile, buffer: Buffer.from('x'.repeat(templateFile.buffer.length)) }); await resume(page).click(); await expect(resume(page)).toBeEnabled(); expect(uploads(state, 'create')).toHaveLength(1); expect(uploads(state, 'bytes')).toHaveLength(1); expect(templatePosts(state)).toEqual([]); expect(writes(state).slice(before).every(value => value.path.endsWith('/complete'))).toBe(true); expect((await records(page))[0].value.items[0].declaration).toEqual(original);
  await picker.setInputFiles({ ...templateFile, name: '重新命名但字节相同的模板.docx' }); await resume(page).click(); await saved(page, state); expect(uploads(state, 'create').every(value => JSON.stringify(value.body) === JSON.stringify(original))).toBe(true); expect(templatePosts(state)[0].name).toBe(templateFile.name); noBusiness(state);
});

test('assistant template cleanup failure retries local cleanup without repeating known server stages', async ({ page }) => {
  const state = await install(page); await mount(page); await page.evaluate(() => { const w = window as any; w.failTemplateCleanup = true; const remove = Storage.prototype.removeItem; Storage.prototype.removeItem = function(key) { if (w.failTemplateCleanup && key.startsWith('bondbuddy:upload-recovery:v1:') && key.includes(':assistant-template-upload:')) throw new DOMException('Synthetic cleanup'); return remove.call(this, key); }; }); await pending(page, state); expect(work(state).view.version).toBe(8); await expect(savedStatus(page)).toContainText('已保存'); const before = writes(state).length; await page.evaluate(() => { (window as any).failTemplateCleanup = false; }); await resume(page).click(); await saved(page, state); expect(writes(state)).toHaveLength(before); oneTransport(state);
});

test('assistant template stopping known but unadopted work removes only local tracking and keeps saved template/material/server view', async ({ page }) => {
  const state = await install(page); state.afterTemplate = () => { work(state).view.version++; }; await mount(page); await pending(page, state); const template = structuredClone(created(state)), server = structuredClone(work(state).view), material = structuredClone([...state.uploads.values()][0].material!), before = writes(state).length;
  await recovery(page).locator('[data-assistant-template-recovery-remove]').click(); await expect.poll(async () => (await records(page)).length).toBe(0); expect(writes(state)).toHaveLength(before); expect(created(state)).toEqual(template); expect(work(state).view).toEqual(server); expect(state.materials.get(pinKey(pin(ids.scope, material)))!.material).toEqual(material); noBusiness(state);
});

for (const missing of ['core', 'business'] as const) test('assistant template removed ' + missing + ' record cannot be recreated from stale component memory', async ({ page }) => {
  const state = await install(page); let release!: () => void; state.completeGate = () => new Promise<void>(resolve => { release = resolve; }); await mount(page); await select(page); await expect.poll(() => uploads(state, 'complete').length).toBe(1);
  await page.evaluate(kind => { for (const key of Object.keys(localStorage)) if (kind === 'business' ? key.startsWith('bb-assistant-template-upload-v1:') : key.startsWith('bondbuddy:upload-recovery:v1:') && key.includes(':assistant-template-upload:')) { localStorage.removeItem(key); dispatchEvent(new StorageEvent('storage', { key, newValue: null })); } }, missing); state.completeGate = undefined; release(); await settle(page);
  expect(memberships(state)).toEqual([]); expect(templatePosts(state)).toEqual([]); expect(viewWrites(state)).toEqual([]); if (missing === 'business') expect(await records(page)).toEqual([]); noBusiness(state);
});

test('assistant template orphan removal durably preserves full conflict before local cleanup and blocks its old prepared card', async ({ page }) => {
  const state = await install(page), original = viewOf(work(state)); await mount(page); let release!: () => void; state.dropView = 'after'; state.viewGate = () => new Promise<void>(resolve => { release = resolve; }); await select(page); await expect.poll(() => viewWrites(state).length).toBe(1); const request = structuredClone(viewWrites(state)[0]);
  await page.evaluate(() => { for (const key of Object.keys(localStorage)) if (key.startsWith('bb-assistant-template-upload-v1:')) { localStorage.removeItem(key); dispatchEvent(new StorageEvent('storage', { key, newValue: null })); } }); state.viewGate = undefined; release(); await settle(page);
  expect(work(state).view).toEqual({ ...request.view, version: 8 }); expect(await records(page)).toEqual([]); const remove = recovery(page).locator('[data-a=template-orphan-remove]'); await expect(remove).toBeVisible(); await expect(page.locator('[data-a=execute][data-id="' + ids.card + '"]')).toBeEnabled();
  // Observe the actual cache at each core removal, without changing the cleanup result or its ordering.
  await page.evaluate(({ owner, scope, topic }) => { const w = window as any, removeItem = Storage.prototype.removeItem, cacheKey = 'bb-assistant-view-v1:' + [owner, scope, topic].map(encodeURIComponent).join(':'); w.orphanRemovalCaches = []; Storage.prototype.removeItem = function(key) { if (key.startsWith('bondbuddy:upload-recovery:v1:') && key.includes(':assistant-template-upload:')) w.orphanRemovalCaches.push(JSON.parse(localStorage.getItem(cacheKey) ?? 'null')); return removeItem.call(this, key); }; }, ids);
  const before = writes(state).length, callStart = state.calls.length; await remove.click(); await expect(page.locator('[data-a=template-orphan-remove]')).toHaveCount(0); await settle(page); const observed = await page.evaluate(() => (window as any).orphanRemovalCaches); expect(observed.length).toBeGreaterThan(0); for (const value of observed) { expect(value.snapshot.version).toBe(7); expect(value.snapshot.view).toEqual(original); expect(value.snapshot.conflict).toBe(true); }
  const local = await cache(page); expect(local.snapshot.version).toBe(7); expect(local.snapshot.view).toEqual(original); expect(local.snapshot.conflict).toBe(true); expect((await localView(page)).assistant.prepared_card_id).toBe(ids.card); await expect(page.locator('.ba-view-conflict')).toBeVisible(); expect(state.calls.slice(callStart).length).toBeGreaterThan(0); expect(state.calls.slice(callStart).every(value => value.method === 'GET')).toBe(true); expect(writes(state)).toHaveLength(before);
  await page.locator('[data-a=execute][data-id="' + ids.card + '"]').click(); await expect(page.locator('[data-status]')).toContainText('完整会话'); await page.clock.runFor(1000); await settle(page); expect(writes(state)).toHaveLength(before); expect(work(state).view).toEqual({ ...request.view, version: 8 }); expect(viewWrites(state)).toEqual([request]); oneTransport(state); noBusiness(state);
});

async function region(page: Page) { const box = page.locator('.ba-form').filter({ has: page.locator('[data-template-upload]') }); await expect(box).toHaveCount(1); await page.locator('[data-template-upload]').evaluate(value => value.closest('label')!.scrollIntoView({ block: 'center' })); }
async function capture(page: Page, state: State, directory: string, flavor: string, label: string, width: number) {
  const filename = 'assistant-template-fifteenth-' + flavor + '-' + label + '-' + width + '.png', bytes = await page.screenshot({ path: join(directory, filename), fullPage: false });
  const geometry = await page.evaluate(() => ({ viewport: { width: innerWidth, height: innerHeight }, overflow: document.documentElement.scrollWidth > innerWidth + 1, text: document.body.innerText, template_saved_status: [...document.querySelectorAll('[data-assistant-template-saved-status]')].map(value => value.textContent), template_recovery_feedback: [...document.querySelectorAll('[data-assistant-template-recovery-id]')].map(value => value.textContent), page_status: document.querySelector('[data-status]')?.textContent ?? '', regions: [...document.querySelectorAll('.ba-panel,.ba-form,[data-assistant-template-recovery-id]')].map(value => { const b = value.getBoundingClientRect(); return { selector: value.getAttribute('data-assistant-template-recovery-id') ?? value.className, x: b.x, y: b.y, width: b.width, height: b.height }; }) }));
  expect(geometry.overflow).toBe(false); const value = { filename, screenshot_sha256: hash(bytes), kind: 'viewport', state: label, scope: 'Actual global ProjectAssistant, strict synthetic public HTTP and current CSS; no production object store, document quality or human signoff.', ...geometry, total_http_writes: writes(state).length, template_posts: templatePosts(state).length, templates_created: state.templateKeys.size };
  await writeFile(join(directory, filename.replace('.png', '.json')), JSON.stringify(value, null, 2)); return value;
}
for (const width of [1440, 390]) test('assistant template component comparison at ' + width, async ({ page }) => {
  const directory = process.env.BB_ASSISTANT_TEMPLATE_FIFTEENTH_EVIDENCE_DIR ?? process.env.BB_FIFTEENTH_EVIDENCE_DIR; test.skip(!directory, 'Explicit fifteenth evidence directory required'); await mkdir(directory!, { recursive: true });
  const reference = process.env.BB_FIFTEENTH_REFERENCE === '1', finish = reference ? await installFifteenthReference(page) : undefined, flavor = reference ? 'reference' : 'implementation', state = await install(page); await page.setViewportSize({ width, height: 960 }); await mount(page); const captured = [];
  await region(page); captured.push(await capture(page, state, directory!, flavor, 'ready', width)); state.dropTemplate = 'after'; await select(page);
  if (reference) await expect(page.locator('[data-upload-kind=template]')).toContainText('模板创建或采用尚未确认'); else await expect(resume(page)).toBeEnabled(); expect(templatePosts(state)).toHaveLength(1); expect(state.templateKeys.size).toBe(1); await region(page); captured.push(await capture(page, state, directory!, flavor, 'pending', width));
  const beforeRefresh = writes(state).length; await refreshReadOnly(page, state); const afterRefresh = writes(state).length; if (reference) await expect(page.locator('[data-upload-kind=template]')).toHaveCount(0); else { await expect(resume(page)).toBeEnabled(); expect((await records(page))[0].value.items[0].templateReceipt).toBeUndefined(); } await region(page); captured.push(await capture(page, state, directory!, flavor, 'refreshed', width));
  // A fresh explicit operation after stopping local tracking; never pretend the reference can recover the lost original key.
  if (!reference) { await recovery(page).locator('[data-assistant-template-recovery-remove]').click(); await expect.poll(async () => (await records(page)).length).toBe(0); const comparison = page.locator('.ba-view-conflict'); await comparison.locator('summary').click(); await comparison.locator('[data-a=recover-view]').click(); await expect(comparison).toHaveCount(0); await settle(page); }
  state.dedupMaterial = [...state.uploads.values()][0].material; state.afterTemplate = () => { work(state).view = { ...work(state).view, version: work(state).view.version + 1, unsent_content: '服务器另一页面已保存的新讨论' }; }; await select(page);
  if (reference) { await expect.poll(() => state.templateKeys.size).toBe(2); await settle(page); await expect(page.locator('[data-status]')).toContainText('其他页面'); } else { await expect(resume(page)).toBeEnabled(); await expect(savedStatus(page)).toContainText('模板已保存'); expect((await records(page))[0].value.items[0].templateReceipt.template_id).toBe([...state.templateKeys.values()][1].template.template_id); }
  expect(templatePosts(state)).toHaveLength(2); expect(state.templateKeys.size).toBe(2); expect(work(state).view.assistant!.template_key).not.toBe([...state.templateKeys.values()][1].template.template_id + '/1'); await region(page); captured.push(await capture(page, state, directory!, flavor, 'template-known-not-adopted', width));
  await writeFile(join(directory!, 'assistant-template-fifteenth-' + flavor + '-comparison-' + width + '.json'), JSON.stringify({ reference, source: finish ? await finish() : { scope: 'Current R15 implementation; no approved prototype or human signoff.' }, records: captured, refresh_write_window: { before: beforeRefresh, after: afterRefresh, added: afterRefresh - beforeRefresh }, template_posts: templatePosts(state).length, templates_created: state.templateKeys.size, original_upload_creates: uploads(state, 'create').length, original_puts: uploads(state, 'bytes').length, membership_posts: memberships(state).length, view_puts: viewWrites(state).length, total_http_writes: writes(state).length, errors: state.errors, unexpected_requests: state.unexpected }, null, 2)); noBusiness(state);
});
