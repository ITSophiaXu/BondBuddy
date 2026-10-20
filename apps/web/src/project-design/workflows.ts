import { TASK_KINDS, dashboardItems } from './dashboard-state';
import { reviewScopeDesign, reviewResultDesign, bindReviewResult } from './review-view';
import { updateDelivery, updateParagraphs } from './update-result';
import { downloadWord } from './word-export';
import { MARKET_OFFERINGS, OFFERING_LABELS, sourceProspectusMissingFields, type Market } from '@bondbuddy/contracts';
import { dashboardFrame } from '../dashboard-view';
import { dashboardGroups } from '../dashboard-model';
import { updateFormFields, bindUpdateForm, readUpdateForm } from '../update-form';
import { reviewProjectFields, bindReviewProjectFields } from '../review-project-fields';
import { reviewRuleScope } from '../review-scope';
import { updateMaterialPartitions, reviewMaterialGroups } from '../workspace-material-groups';
import { renderFinancialUploadGuidance } from '../financial-upload-guidance';
import { sourceFields, readSourceFields } from '../source-prospectus';
import { validateDraft } from '../form-model';
import { prototypeIcon as icon } from '../prototype-design';
import { esc, date } from '../ui';
import { workFor, saveDetails, touchWork, selectWorkSource, addWorkFiles, runWorkPreview } from './work-model';
import type { DesignState, Project, ProjectFile, WorkKind, Job } from './model';

export const FLOWS = {
  dashboard: { title: '工作台', eyebrow: 'WORKBENCH', labels: ['选择项目', '项目工作台'], step: 'overview' },
  update: { title: '更新募集书', eyebrow: 'PROSPECTUS WORKSPACE', labels: ['选择项目', '项目信息', '材料与要求'], step: 'details' },
  review: { title: '复核募集书', eyebrow: 'PROSPECTUS REVIEW', labels: ['选择项目', '材料与要求', '复核结果'], step: 'materials' },
  generate: { title: '文件生成', eyebrow: 'FILE GENERATION', labels: ['选择项目', '选择募集说明书', '生成关联文件'], step: 'source' },
  qa: { title: '项目问答', eyebrow: 'BONDBUDDY AGENT', labels: ['选择项目', 'Word 问题清单', '回答与待补材料'], step: 'workspace' },
  integrity: { title: '诚信核查', eyebrow: 'INTEGRITY CHECK', labels: ['选择项目', '名单与网站范围', '核查结果与底稿'], step: 'subjects' },
} as const;
export type FlowMode = keyof typeof FLOWS;
const href = (kind: string, p: Project, step = 'materials') => `#${kind}?project=${encodeURIComponent(p.id)}&step=${step}`;
const action = (label: string, name: string, primary = false, attrs = '') => `<button type="button" class="btn ${primary ? 'primary' : 'secondary'}" data-work-action="${name}" ${attrs}>${label}</button>`;
const sourceMaterial = (f: ProjectFile) => ({ material_id: f.id, material_version: f.version, sha256: 'local-design-metadata', role: 'historical' as const });
const workSteps = (kind: WorkKind, active: number) => `<nav class="stepper" aria-label="${kind === 'update' ? '更新流程' : '复核流程'}">${(kind === 'update' ? ['选择项目', '项目信息', '材料与要求'] : ['选择项目', '材料与要求', '复核结果']).map((label, i) => `${i ? '<span class="step-line"></span>' : ''}<span class="step ${active === i ? 'current' : ''}" ${active === i ? 'aria-current="step"' : ''}><b>${i < active ? '✓' : i + 1}</b>${label}</span>`).join('')}</nav>`;

export function workView(p: Project, kind: WorkKind, query: URLSearchParams, state: DesignState) {
  const details = workFor(p).details, edit = query.get('step') === 'details';
  const results = query.get('step') === 'result', title = kind === 'update' ? '更新募集说明书' : '复核募集说明书';
  const header = `<div class="page-head"><div><div class="eyebrow">${FLOWS[kind].eyebrow}</div><h1>${title}</h1><p>${kind === 'update' ? '提供项目材料和要求，在同一个工作区完成募集书更新。' : '提供复核材料和要求，复核数据一致性、勾稽、政策要求及格式标点，直接在原文留下修订与批注。'}</p></div><span class="save-badge" data-work-save role="status">已保存到本地</span></div>`;
  if (edit) return `<div class="pd-live-work ${kind === 'review' ? 'review-workspace' : ''}">${header}${workSteps(kind, 1)}<form id="pd-work-form" class="${kind === 'update' ? 'update-form' : 'review-panel review-create'}">${kind === 'update' ? `<section class="panel form-card">${updateFormFields(details)}</section>` : `<h2>复核项目信息</h2>${reviewProjectFields(details)}${reviewScopeDesign()}`}<p class="form-message" id="pd-work-form-error" role="alert" hidden></p><div class="form-footer"><a class="text-button" href="${href('dashboard', p, 'overview')}">返回项目工作台</a><button type="submit" class="btn primary">保存并继续 ${icon('arrow')}</button></div></form></div>`;
  const tabs = `<nav class="review-tabs" role="tablist" aria-label="${kind === 'update' ? '更新内容' : '复核内容'}"><a role="tab" id="work-tab-materials" aria-controls="work-panel" aria-selected="${!results}" tabindex="${results ? '-1' : '0'}" href="${href(kind, p)}">材料与要求</a><a role="tab" id="work-tab-result" aria-controls="work-panel" aria-selected="${results}" tabindex="${results ? '0' : '-1'}" href="${href(kind, p, 'result')}">${kind === 'update' ? '更新成果' : '复核结果'}</a></nav>`;
  return `<div class="pd-live-work review-workspace">${header}${workSteps(kind, kind === 'update' ? 2 : results ? 2 : 1)}<div class="review-grid review-single-column"><section class="review-panel">${tabs}<div class="review-tab-panel" id="work-panel" role="tabpanel" aria-labelledby="work-tab-${results ? 'result' : 'materials'}">${results ? workResult(p, kind, query, state) : workMaterials(p, kind)}</div></section></div></div>`;
}
function sourcePicker(p: Project, kind: WorkKind) {
  const draft = workFor(p)[kind], sources = p.files.filter(f => !f.deletedAt && f.type === 'prospectus').sort((a, b) => b.version - a.version);
  const selected = sources.find(f => f.id === draft.sourceId);
  return `<div class="pd-existing-source"><label for="work-source">${kind === 'update' ? '本次更新依据' : '本次待复核稿'} · 选用项目已有募集书</label><select id="work-source"><option value="">请选择募集说明书版本</option>${sources.map(f => `<option value="${f.id}" ${f.id === draft.sourceId ? 'selected' : ''}>v${f.version} · ${esc(f.name)}</option>`).join('')}</select><p class="muted">${sources.length ? '准确版本用于本轮任务，其他流程的选稿保持各自保存。' : '当前项目还没有募集书，请在下方选择本地文件。'}</p>${selected ? `<div class="pd-source-strip">${icon('file')}<div class="pd-grow"><strong>${esc(selected.name)}</strong><small>选用项目文件 · v${selected.version}</small></div>${action('查看', 'preview', false, `data-file="${selected.id}"`)}</div>${kind === 'update' ? sourceFields(sourceMaterial(selected), draft.sources).replace('用于选择知识和计算积分', '用于确认本次更新依据') : ''}` : ''}</div>`;
}
function workMaterials(p: Project, kind: WorkKind) {
  const work = workFor(p), details = work.details, draft = work[kind];
  const reviewGroups = reviewMaterialGroups().map(g => ({ label: g.title, roles: g.roles.map(code => ({ code, label: ({ historical: '待复核募集书', reference: '参考募集书', audit: '审计报告', financial: '年度财务报表', interimFinancial: '最近一期报表', notes: '财务附注', other: '其他核验材料' } as Record<string,string>)[code] })), primary: [g.primary], optional: false }));
  const groups = kind === 'update' ? updateMaterialPartitions().map((g, i) => i === 0 ? { ...g, label: '本次更新依据 · 历史／参考募集书' } : g) : reviewGroups;
  const row = (role: {code: string; label: string}) => {
    const primarySource = role.code === 'historical';
    const chosen = draft.attachments.filter(a => a.role === role.code).flatMap(a => p.files.find(f => f.id === a.fileId) ?? []);
    const reusable = p.files.filter(f => !f.deletedAt && f.folder === 'sources');
    return `<li class="material-role" data-work-drop="${role.code}"><div class="material-role-heading"><div><strong>${esc(role.label)}</strong><span>${primarySource ? '选用项目内募集书，或上传 Word / PDF' : '添加本地文件，或复用项目已有材料'}</span></div><label class="button secondary material-picker" for="work-upload-${role.code}">${icon('upload')}<span>点击或拖入文件</span><input id="work-upload-${role.code}" type="file" ${primarySource ? '' : 'multiple'} accept="${primarySource ? '.docx,.pdf' : '.docx,.pdf,.xlsx,.csv,.txt,.png,.jpg,.jpeg'}" aria-label="为${esc(role.label)}选择文件" data-work-upload="${role.code}"></label></div>${primarySource ? sourcePicker(p, kind) : ''}${role.code === 'audit' ? renderFinancialUploadGuidance(details.market, details.offering, details.update_details?.reporting_cutoff ?? null) : ''}<ul class="material-file-list">${chosen.map(f => `<li class="material-file-row"><div class="material-file-main"><strong>${esc(f.name)}</strong><span>项目文件 · v${f.version}</span><p class="material-file-status">已选用 · 本地设计</p></div><div class="material-file-actions"><button type="button" class="text-button" data-work-action="remove-material" data-file="${f.id}" data-role="${role.code}">从本轮移除</button></div></li>`).join('')}</ul>${!primarySource && reusable.length ? `<details class="pd-details"><summary>选用项目已有材料（${reusable.length}）</summary>${reusable.map(f => `<label class="pd-reuse-choice"><input type="checkbox" data-work-reuse="${f.id}" data-role="${role.code}" ${chosen.some(c => c.id === f.id) ? 'checked' : ''}><span>${esc(f.name)}</span></label>`).join('')}</details>` : ''}</li>`;
  };
  const groupHtml = groups.map(g => `<section class="material-partition ${g.optional ? 'optional-material-partition' : ''}"><h3>${esc(g.label)}</h3><ul class="material-role-list">${g.roles.filter(r => (g.primary as readonly string[]).includes(r.code)).map(row).join('')}</ul>${g.roles.some(r => !(g.primary as readonly string[]).includes(r.code)) ? `<details class="material-subtypes"><summary>按细分类别补充材料（选填）</summary><ul class="material-role-list">${g.roles.filter(r => !(g.primary as readonly string[]).includes(r.code)).map(row).join('')}</ul></details>` : ''}</section>`).join('');
  return `<div class="project-strip"><span>${icon('file')}${kind === 'update' ? '全文更新' : '全文复核与修订'}</span><a class="text-btn" href="${href(kind, p, 'details')}">编辑项目信息</a><span>${esc(details.update_details?.reporting_cutoff ?? '报告期待补充')} · ${draft.attachments.length + (draft.sourceId ? 1 : 0)} 份已选材料</span></div>${kind === 'review' ? reviewScopeDesign() : ''}<div class="panel-heading materials-heading"><div><h2>${kind === 'update' ? '提供项目材料' : '提供复核材料'}</h2><p class="muted">按分区添加材料，单份不超过 100 MB。本地设计仅保存文件名和选择记录。</p></div></div>${groupHtml}<section class="review-optional-requirements"><label for="work-requirements">${kind === 'update' ? '补充更新要求与说明（选填）' : '补充复核要求（选填）'}</label><p class="review-muted">填写重点关注的内容、统计口径或特殊情况。要求自动保存，开始时一并采用。</p><textarea id="work-requirements" class="review-source-select" rows="4" maxlength="12000" placeholder="${kind === 'update' ? '例如：更新至最新报告期，沿用原稿结构，并标注缺失依据。' : '例如：重点核对法定代表人信息、财务数据及各处披露是否一致。'}">${esc(draft.requirements)}</textarea><div class="review-requirements-save"><span data-work-save class="review-muted" role="status">已保存到本地</span>${action('保存要求', 'save')}</div></section><div class="review-footer-actions review-materials-footer"><div class="review-footer-copy"><strong>准备好了，就可以开始。</strong><p class="review-muted">演示流程，不调用模型、不扣费；结果保存至本项目文件。</p></div><div class="review-footer-buttons">${action(kind === 'update' ? '开始更新' : '开始复核', 'run', true)}</div></div>`;
}
function workResult(p: Project, kind: WorkKind, query: URLSearchParams, state: DesignState) {
  const jobs = state.jobs.filter(j => j.projectId === p.id && j.kind === kind), id = query.get('job');
  const job = id ? jobs.find(j => j.id === id) : jobs[0];
  if (!job) return `<div class="review-empty"><h2>${id ? '本轮任务不存在' : kind === 'review' ? '暂无复核结果' : '暂无更新成果'}</h2><p>选好本项目的募集书并补充要求后，即可演示完整流程。</p><a class="btn primary" href="${href(kind, p)}">返回材料与要求</a></div>`;
  if (kind === 'review' && job.review) return reviewResultDesign(p, job, jobs);
  const files = p.files.filter(f => job.fileIds.includes(f.id));
  return `<div class="pd-section-head"><div><h2>${kind === 'review' ? '复核结果' : '更新成果'} <span class="pd-chip amber">设计示例</span></h2><p class="muted">${esc(date(job.createdAt))} · 未执行真实${kind === 'review' ? '复核' : '编制'}</p></div><label>版本记录<select id="work-job">${jobs.map((j, i) => `<option value="${j.id}" ${j.id === job.id ? 'selected' : ''}>第 ${jobs.length - i} 轮 · ${esc(date(j.createdAt))}</option>`).join('')}</select></label></div><div class="pd-inline-note">${icon('file')}<div>本轮依据：${esc(files[0]?.sourceName ?? '')} · v${files[0]?.sourceVersion}<p>要求：${esc(job.input?.draft.requirements || '未补充特殊要求')}</p><small>材料、要求和项目信息已固定为本轮快照。</small></div></div>${kind === 'review' ? `<div class="pd-review-dimensions">${['财务数据核对', '合规与披露', '公开信息核验'].map((name, i) => `<article><span>0${i + 1}</span><h3>${name}</h3><b class="pd-chip amber">未执行 · 待核实</b><p>接入真实复核后展示问题、原文位置和核验依据。本轮没有真实核查结论。</p></article>`).join('')}</div>` : ''}${kind === 'update' ? updateDelivery(p,job) : `<div class="pd-actions"><button class="btn secondary" data-consistency-start data-project="${p.id}" data-from-job="${job.id}">检查文件一致性</button></div>`}<div class="pd-result-list">${files.map(f => `<div class="pd-result-row">${icon('file')}<div class="pd-grow"><strong>${esc(f.name)}</strong><small>v${f.version} · ${kind === 'update' ? '2 申报、发行备案文件' : '4 底稿文件 / 4.2 核查记录'}</small></div>${action('查看设计说明', 'preview', false, `data-file="${f.id}"`)}</div>`).join('')}</div><div class="pd-footer"><a class="btn secondary" href="${href('dashboard', p, 'overview')}">返回项目工作台</a><div class="pd-actions"><a class="btn secondary" href="${href(kind, p)}">准备下一轮</a><a class="btn primary" href="#/projects/${p.id}/files?folder=${kind === 'update' ? '2' : '4.2'}">查看项目文件 ${icon('arrow')}</a></div></div>`;
}

const allKinds = TASK_KINDS;
export function projectDashboard(p?: Project) {
  return dashboardFrame({ description: p ? '继续当前项目的任务，查看生成结果。' : '继续手上的任务，查看所有项目的任务状态与成果。', starts: [['update', 'update', '更新募集书'], ['review', 'review', '复核募集书'], ['generate', 'spark', '文件生成'], ['integrity', 'shield', '诚信核查'], ['qa', 'chat', '项目问答']].map(([route, ico, label]) => [p ? `${route}?project=${p.id}&step=${FLOWS[route as FlowMode].step}` : route, ico, label]), kinds: allKinds, footnote: '本地设计仅演示任务与检查进度；不会启动后台任务或调用模型。' });
}
type Hooks = { save: () => void; render: () => void; go: (hash: string) => void; error: (error: unknown) => void; preview: (p: Project, f: ProjectFile) => void };
export function bindWork(root: HTMLElement, p: Project, kind: WorkKind, state: DesignState, hooks: Hooks) {
  if (kind === 'review') bindReviewResult(root, p, state, hooks);
  if (kind === 'update') root.querySelectorAll<HTMLElement>('[data-update-download]').forEach(button => button.addEventListener('click', () => {
    const id = new URLSearchParams(location.hash.split('?')[1]).get('job');
    const job = state.jobs.find(j => j.projectId === p.id && j.kind === 'update' && (!id || j.id === id));
    if (job) downloadWord(`${job.input?.details.issuer_name ?? p.issuer}_更新${button.dataset.updateDownload === 'tracked' ? '修订版' : '清洁版'}`, updateParagraphs(job), button.dataset.updateDownload === 'tracked');
  }));
  const work = workFor(p), draft = work[kind];
  const saved = () => { hooks.save(); root.querySelectorAll('[data-work-save]').forEach(el => el.textContent = '已保存到本地'); };
  const form = root.querySelector<HTMLFormElement>('#pd-work-form');
  if (form) {
    if (kind === 'update') bindUpdateForm(form, value => { saveDetails(p, kind, value); saved(); }, work.details.update_details);
    const read = kind === 'review' ? bindReviewProjectFields(form, value => { saveDetails(p, kind, { ...value, kind: 'update' }); saved(); const scope = form.querySelector('[data-review-rule-scope]'); if (scope) scope.innerHTML = reviewRuleScope(value.market, value.offering); }, work.details) : () => readUpdateForm(form);
    form.addEventListener('submit', e => {
      e.preventDefault(); const value = read(), errors = validateDraft(value); if (!value.issuer_name?.trim()) errors.unshift('请填写发行人全称。');
      const error = form.querySelector<HTMLElement>('#pd-work-form-error')!; error.hidden = !errors.length; error.textContent = errors.join(' ');
      if (!errors.length) { saveDetails(p, kind, value); saved(); hooks.go(href(kind, p).slice(1)); } else error.scrollIntoView({ block: 'center' });
    });
  }
  root.querySelector('#work-source')?.addEventListener('change', e => { selectWorkSource(p, kind, (e.target as HTMLSelectElement).value); saved(); hooks.render(); });
  root.querySelector('#work-requirements')?.addEventListener('input', e => { draft.requirements = (e.target as HTMLTextAreaElement).value; touchWork(p, kind); saved(); });
  root.querySelector('#work-job')?.addEventListener('change', e => hooks.go(`${href(kind, p, 'result').slice(1)}&job=${(e.target as HTMLSelectElement).value}`));
  root.querySelectorAll<HTMLInputElement>('[data-work-reuse]').forEach(input => input.addEventListener('change', () => { const fileId = input.dataset.workReuse!, role = input.dataset.role!;
    draft.attachments = draft.attachments.filter(a => !(a.fileId === fileId && a.role === role));
    if (input.checked) draft.attachments.push({ fileId, role });
    touchWork(p, kind); saved(); hooks.render();
    const replacement = root.querySelector<HTMLInputElement>(`[data-work-reuse="${CSS.escape(fileId)}"][data-role="${CSS.escape(role)}"]`);
    if (replacement) { replacement.closest('details')!.open = true; replacement.focus({ preventScroll: true }); } }));
  const add = (role: string, files: FileList | null | undefined) => { if (!files?.length) return; try { addWorkFiles(p, kind, role, [...files]); saved(); hooks.render(); } catch (e) { hooks.error(e); } };
  root.querySelectorAll<HTMLInputElement>('[data-work-upload]').forEach(input => input.addEventListener('change', () => add(input.dataset.workUpload!, input.files)));
  root.querySelectorAll<HTMLElement>('[data-work-drop]').forEach(zone => { zone.addEventListener('dragover', e => e.preventDefault()); zone.addEventListener('drop', e => { e.preventDefault(); add(zone.dataset.workDrop!, e.dataTransfer?.files); }); });
  root.querySelectorAll<HTMLElement>('[data-work-action]').forEach(button => button.addEventListener('click', () => {
    try {
      const action = button.dataset.workAction;
      if (action === 'save') saved();
      if (action === 'preview') { const f = p.files.find(f => f.id === button.dataset.file); if (f) hooks.preview(p, f); }
      if (action === 'remove-material') { draft.attachments = draft.attachments.filter(a => !(a.fileId === button.dataset.file && a.role === button.dataset.role)); touchWork(p, kind); saved(); hooks.render(); }
      if (action === 'run') { const errors = validateDraft(work.details); if (errors.length) throw new Error(errors.join(' ')); if (kind === 'update' && draft.sourceId) { const missing = sourceProspectusMissingFields(draft.sources.find(s => s.material_id === draft.sourceId)); if (missing.length) throw new Error('请补齐原稿信息：' + missing.join('、')); } const job = runWorkPreview(state, p, kind); saved(); hooks.go(`${href(kind, p, 'result').slice(1)}&job=${job.id}`); }
    } catch (e) { hooks.error(e); }
  }));
  root.querySelectorAll<HTMLAnchorElement>('[role=tab]').forEach(tab => tab.addEventListener('keydown', e => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return; e.preventDefault(); const tabs = [...root.querySelectorAll<HTMLAnchorElement>('[role=tab]')]; const next = e.key === 'Home' ? tabs[0] : e.key === 'End' ? tabs.at(-1)! : tabs.find(t => t !== tab)!; next.click(); }));
  const source = p.files.find(f => f.id === draft.sourceId);
  const fields = root.querySelector<HTMLElement>('[data-source-material]');
  if (source && fields) fields.addEventListener('change', e => {
    const input = e.target as HTMLInputElement, name = input.dataset.sourceField;
    if (!name) return;
    if (name === 'market') { const select = fields.querySelector<HTMLSelectElement>('[data-source-field=offering]')!; select.innerHTML = '<option value="">请选择</option>' + (MARKET_OFFERINGS[input.value as Market] ?? []).map(value => `<option value="${value}">${OFFERING_LABELS[value]}</option>`).join(''); }
    const material = sourceMaterial(source), previous = draft.sources.find(s => s.material_id === source.id);
    const value = readSourceFields(fields, material, previous, name); draft.sources = [...draft.sources.filter(s => s.material_id !== source.id), value]; touchWork(p, kind); saved();
    // Preserve focus and keep the native select connected while editing.
    const template = document.createElement('template'); template.innerHTML = sourceFields(material, draft.sources);
    for (const selector of ['[data-source-required-message]', '[data-source-period-summary]']) fields.querySelector(selector)!.textContent = template.content.querySelector(selector)!.textContent;
  });
}

export function bindProjectDashboard(root: HTMLElement, p: Project | undefined, state: DesignState) {
  const query = new URLSearchParams(location.hash.split('?')[1]);
  let kind = query.get('kind') ?? 'all', group = query.get('status') ?? 'all', limit = 8;
  if (!(kind in allKinds)) kind = 'all'; if (!(group in dashboardGroups)) group = 'all';
  const items = dashboardItems(state, p);
  const paint = () => {
    root.querySelectorAll<HTMLElement>('[data-dashboard-group]').forEach(b => { const g = b.dataset.dashboardGroup!; b.setAttribute('aria-pressed', String(g === group)); b.querySelector('[data-dashboard-count]')!.textContent = String(items.filter(i => i.group === g).length); b.querySelector('[data-dashboard-sub]')!.textContent = g === 'done' ? '设计示例可查看' : g === 'active' ? '本地检查演示进度' : '已保存的准备内容'; });
    root.querySelectorAll<HTMLElement>('[data-dashboard-kind]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.dashboardKind === kind)));
    root.querySelector<HTMLSelectElement>('#dashboard-status')!.value = group;
    const filtered = items.filter(i => (kind === 'all' || i.kind === kind) && (group === 'all' || i.group === group)), shown = filtered.slice(0, limit);
    root.querySelector('#dashboard-list-title')!.textContent = `最近任务 · ${filtered.length}`;
    root.querySelector('#dashboard-projects')!.innerHTML = shown.length ? `<div class="dashboard-table-head"><span>任务 / 项目</span><span>当前状态</span><span>操作</span></div>${shown.map(i => `<article class="dashboard-task"><div class="dashboard-task-info"><a class="dashboard-task-title" href="${i.url}">${esc(i.title)}</a><div class="dashboard-task-meta"><span>${esc(i.project)}</span><time>${esc(date(i.time))}</time></div></div><div class="dashboard-task-status"><span class="badge dashboard-state ${i.group === 'done' ? 'neutral' : 'warning'}">${esc(i.label)}</span><span class="dashboard-task-stage">${esc(i.detail)}</span></div><div class="dashboard-task-actions"><a href="${i.url}" class="text-btn dashboard-primary-action">${esc(i.action)}${icon('chevron')}</a></div></article>`).join('')}` : `<div class="empty"><h3>${items.length ? '没有符合筛选的任务' : '这个项目的第一份成果，从这里开始'}</h3><p>选择上方任务入口，或切换任务类型与状态。</p></div>`;
    root.querySelector('#dashboard-list-note')!.textContent = `显示 ${shown.length} / ${filtered.length} 项 · ${p ? '当前项目' : '全部项目'} · 按最近更新排序`;
    root.querySelector<HTMLButtonElement>('#dashboard-more')!.hidden = shown.length >= filtered.length;
    if (p) query.set('project', p.id); else query.delete('project'); query.set('kind', kind); query.set('status', group); history.replaceState(null, '', `${location.pathname}${location.search}#dashboard?${query}`);
  };
  root.querySelectorAll<HTMLElement>('[data-dashboard-kind]').forEach(b => b.addEventListener('click', () => { kind = b.dataset.dashboardKind!; limit = 8; paint(); }));
  root.querySelectorAll<HTMLElement>('[data-dashboard-group]').forEach(b => b.addEventListener('click', () => { group = group === b.dataset.dashboardGroup ? 'all' : b.dataset.dashboardGroup!; kind = 'all'; limit = 8; paint(); }));
  root.querySelector('#dashboard-status')!.addEventListener('change', e => { group = (e.target as HTMLSelectElement).value; limit = 8; paint(); });
  root.querySelector('#dashboard-more')!.addEventListener('click', () => { limit += 8; paint(); });
  root.querySelector('#dashboard-refresh')!.addEventListener('click', paint); paint();
}
