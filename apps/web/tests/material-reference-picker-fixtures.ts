import {fixtureBody} from './billing-fixture-wire';
import { expect, type Page } from '@playwright/test';
import { schemas, type M4DocumentType, type M4DraftInput, type M4MaterialPin } from '@bondbuddy/contracts';
import type { Dto } from './billing-fixture-wire';
import {
  fixture as baseFixture, install as installBase, mount as mountBase, addMaterial, materialOf, check,
  ids, now, mime, hash, inputOf, pinKey, draftWrites, libraryWrites, writes, noBusiness, choose,
} from './m4-upload-thirteenth-fixtures';

export { ids, now, mime, hash, inputOf, pinKey, draftWrites, libraryWrites, writes, noBusiness, choose };
export type Purpose = 'source' | 'material';
export const labels = { source: '用作募集书依据', material: '添加为补充资料' } as const;
export function fixture() {
  const state = baseFixture();
  state.workspace.topic.name = '合成已有项目材料选择'; state.workspace.project.name = state.workspace.topic.name;
  for (const draft of Object.values(state.workspace.drafts)) draft.fields.source_mode = 'project';
  const projects: Dto<'ProjectListResponse'>['items'] = Array.from({ length: 56 }, (_, index) => ({
    project_id: index === 0 ? ids.sourceProject : `picker-project-${index + 1}`,
    name: index === 0 ? '合成原募集书项目' : index === 55 ? '合成第56个项目·海河年度材料' : `合成材料项目 ${index + 1}`,
    draft_revision: 1, updated_at: now, kind: 'update',
  }));
  const projectMaterials = new Map<string, M4MaterialPin[]>();
  const register = (project: string, kind: 'pdf' | 'docx' | 'xlsx', suffix = '', version = 1) => {
    const name = kind === 'docx' ? '合成募集说明书_九月口径与发行安排完整长文件名.docx'
      : kind === 'xlsx' ? '合成财务数据.xlsx' : '合成财务报告.pdf';
    const media = kind === 'docx' ? mime : kind === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/pdf';
    const bytes = Buffer.from(`Synthetic picker ${project} ${kind} ${suffix} V${version}`);
    const material = { ...materialOf({ name, mimeType: media, buffer: bytes }, `picker-${kind}${suffix}-${project}`), material_version: version };
    const selected = addMaterial(state, material, project); state.materialBytes.set(pinKey(selected), bytes);
    projectMaterials.set(project, [...(projectMaterials.get(project) ?? []), selected]); return selected;
  };
  const pdf = register(ids.sourceProject, 'pdf', '-old', 2), duplicatePdf = register(ids.sourceProject, 'pdf', '-new', 3);
  const docx = register(ids.sourceProject, 'docx', '', 4), xlsx = register(ids.sourceProject, 'xlsx', '', 5);
  const distantProject = projects[55].project_id, distantPdf = register(distantProject, 'pdf', '-distant', 7);
  const alternateProject = projects[1].project_id, alternateDocx = register(alternateProject, 'docx', '-alternate', 8);
  return Object.assign(state, { projects, projectMaterials, pdf, duplicatePdf, docx, xlsx, distantProject, distantPdf, alternateProject, alternateDocx,
    failProjectList: false, failEventsFor: '', projectGate: undefined as (() => Promise<void>) | undefined,
    eventsGate: undefined as ((project: string) => Promise<void>) | undefined });
}
export type State = ReturnType<typeof fixture>;

export async function install(page: Page, state = fixture()) {
  await installBase(page, state);
  await page.route('**/api/v1/projects**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname.slice('/api/v1'.length);
    if (request.method() !== 'GET') return route.fallback();
    if (path === '/projects') {
      state.calls.push({ method: 'GET', path, search: url.search });
      if (state.projectGate) await state.projectGate();
      if (state.failProjectList) return route.fulfill({ status: 503, json: fixtureBody(route,{ code: 'DATA_UNAVAILABLE', message: 'Synthetic project list failure', retryable: true, correlation_id: 'picker-project-read', field_errors: [] }) });
      check(schemas.ProjectListQuery, Object.fromEntries(url.searchParams));
      const q = url.searchParams.get('q') ?? '', selected = state.projects.filter(project => project.name.includes(q));
      const cursor = url.searchParams.get('cursor'), offset = cursor ? Number(cursor.replace('picker-offset-', '')) : 0;
      expect(Number.isSafeInteger(offset) && offset >= 0).toBe(true);
      const limit = Number(url.searchParams.get('limit') ?? 50), items = selected.slice(offset, offset + limit), hasMore = offset + items.length < selected.length;
      const response: Dto<'ProjectListResponse'> = { items, page: { next_cursor: hasMore ? `picker-offset-${offset + items.length}` : null, has_more: hasMore } };
      check(schemas.ProjectListResponse, response); return route.fulfill({ json: fixtureBody(route,response) });
    }
    const events = path.match(/^\/projects\/([^/]+)\/events$/);
    if (events) {
      state.calls.push({ method: 'GET', path, search: url.search });
      if (state.eventsGate) await state.eventsGate(events[1]);
      if (state.failEventsFor === events[1]) return route.fulfill({ status: 503, json: fixtureBody(route,{ code: 'DATA_UNAVAILABLE', message: 'Synthetic material event failure', retryable: true, correlation_id: 'picker-material-read', field_errors: [] }) });
      const after = Number(url.searchParams.get('after') ?? 0), all = state.projectMaterials.get(events[1]) ?? [], page = all.slice(after, after + 2);
      const response: Dto<'ProjectEventsResponse'> = { items: page.map((selected, index) => ({ event_id: `picker-event-${events[1]}-${after + index + 1}`, schema_version: 1,
        trace_id: 'picker-synthetic-trace', project_id: events[1], seq: after + index + 1, occurred_at: now, type: 'material.upload_progress', payload: { material_id: selected.material_id } })),
        next_cursor: after + page.length < all.length ? after + page.length : null };
      check(schemas.ProjectEventsResponse, response); return route.fulfill({ json: fixtureBody(route,response) });
    }
    const project = path.match(/^\/projects\/([^/]+)$/), selected = project && state.projects.find(item => item.project_id === project[1]);
    if (selected && project![1] !== ids.sourceProject && project![1] !== ids.project) {
      state.calls.push({ method: 'GET', path, search: url.search });
      const response: Dto<'ProjectResponse'> = { ...state.workspace.project, project_id: selected.project_id, name: selected.name, kind: 'update' };
      check(schemas.ProjectResponse, response); return route.fulfill({ json: fixtureBody(route,response) });
    }
    return route.fallback();
  });
  return state;
}
export const mount = (page: Page, options: Parameters<typeof mountBase>[1] = {}) => mountBase(page, options);
export const picker = (page: Page) => page.locator('dialog[data-material-reference-picker][open]');
export const entry = (page: Page, purpose: Purpose) => page.locator(`[data-m4-action="project-picker"][data-picker-purpose="${purpose}"]`);
export const adopt = (page: Page, selected: M4MaterialPin) => picker(page).locator(`[data-adopt-pin="${pinKey(selected)}"]`);
export const currentInput = (state: State, type: M4DocumentType = 'private_summary') => inputOf(state.workspace.drafts[type]);
export const expectedInput = (original: M4DraftInput, purpose: Purpose, selected: M4MaterialPin): M4DraftInput => purpose === 'source'
  ? { ...structuredClone(original), source_material: structuredClone(selected) }
  : { ...structuredClone(original), materials: [...structuredClone(original.materials), structuredClone(selected)] };
export async function openPicker(page: Page, purpose: Purpose, selectedProject = ids.sourceProject) {
  await entry(page, purpose).click(); await expect(picker(page)).toBeVisible(); await expect(picker(page)).toHaveAttribute('data-picker-purpose', purpose);
  await expect(picker(page).locator('#m4-picker-project')).toHaveValue(selectedProject);
}
export async function open(page: Page, state = fixture()) { await install(page, state); await mount(page); return state; }
export async function settle(page: Page) {
  await page.clock.runFor(800);
  await page.evaluate(async () => { const component = (window as unknown as { m4Component?: { cacheQueue?: Promise<void> } }).m4Component; await component?.cacheQueue; });
}
export async function observe(page: Page) {
  return page.evaluate(() => {
    const component = (window as unknown as { m4Component: { selected: string; drafts: Map<string, { version: number; input: M4DraftInput; dirty: boolean; conflict: boolean }>; pendingExecution?: unknown; pendingMessage?: unknown } }).m4Component;
    return { selected: component.selected, drafts: Object.fromEntries([...component.drafts].map(([key, value]) => [key, structuredClone(value)])), pendingExecution: component.pendingExecution, pendingMessage: component.pendingMessage };
  });
}
export async function holdLibrary(state: State) {
  let entered = false, release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; }); state.libraryGate = async () => { entered = true; await waiting; };
  return { entered: () => entered, release: () => { state.libraryGate = undefined; release(); } };
}
export async function beginHeldAdoption(page: Page, state: State, purpose: Purpose = 'material', selected = state.pdf) {
  await openPicker(page, purpose); await expect(adopt(page, selected)).toBeEnabled(); const hold = await holdLibrary(state);
  const response = page.waitForResponse(value => value.request().method() === 'POST' && new URL(value.url()).pathname.endsWith(`/m4/topics/${ids.topic}/materials`));
  await adopt(page, selected).click(); await expect.poll(hold.entered).toBe(true); return { ...hold, response };
}
export async function finishHeld(page: Page, state: State, hold: Awaited<ReturnType<typeof beginHeldAdoption>>, selected = state.pdf) {
  hold.release(); await (await hold.response).finished(); await expect.poll(() => state.workspace.materials.some(value => pinKey(value) === pinKey(selected))).toBe(true); await settle(page);
}
export async function closePicker(page: Page) { await picker(page).locator('[data-close-picker]').first().click(); await expect(picker(page)).toHaveCount(0); }
export const baselineSourceEntry = (page: Page) => page.locator('[data-m4-action="project-picker"]').first();
