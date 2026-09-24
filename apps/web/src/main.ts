import './styles.css';
import { FUNDING_PURPOSES, MARKET_LABELS, MARKET_OFFERINGS, MARKETS, MONEY_UNITS, OFFERING_LABELS, PROJECT_FIELD_LIMITS, type Money, type Offering, type Project, type UpdateDetails } from '@bondbuddy/contracts';
import { ApiClient, ApiError, errorMessage, type ProjectCreate, type ProjectList, type Session } from './api.js';
import { blankDraft, changeMarket, draftFromProject, marketValue, materialHints, validateDraft } from './form-model.js';

const root = document.querySelector<HTMLDivElement>('#app')!;
const api = new ApiClient();
let session: Session | null = null;
let retainedOwner: string | null = null;
let current: Project | null = null;
let draft = blankDraft();
let dirty = false;
let busy = false;
let projects: ProjectList['items'] = [];
let cursor: string | null = null;
let latest: Project | null = null;
let message = '';
let failed = false;
let route = location.hash;

const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
const selected = (value: unknown, expected: unknown) => value === expected ? ' selected' : '';
const optional = '<span class="optional-label">选填</span>';
const option = (value: string, label: string, active: unknown) => `<option value="${escape(value)}"${selected(value, active)}>${escape(label)}</option>`;
const textField = (name: string, label: string, value: unknown, placeholder = '', limit: number = PROJECT_FIELD_LIMITS.notes, multiline = true) => `<div class="field${multiline ? ' full' : ''}"><label for="${name}">${label}</label>${multiline ? `<textarea id="${name}" name="${name}" maxlength="${limit}" placeholder="${escape(placeholder)}">${escape(value)}</textarea>` : `<input id="${name}" name="${name}" maxlength="${limit}" value="${escape(value)}" placeholder="${escape(placeholder)}">`}</div>`;
const moneyField = (name: string, label: string, value: Money | null) => `<div class="field"><label for="${name}">${label}</label><div class="money-input"><input id="${name}" name="${name}" inputmode="decimal" maxlength="40" value="${escape(value?.value)}" placeholder="未确定可留空"><select name="${name}_unit" aria-label="${label}单位">${MONEY_UNITS.map(unit => option(unit.code, unit.label, value?.unit ?? 'hundred_million')).join('')}</select></div></div>`;
const status = () => `<p id="status" class="status-message${failed ? ' error' : ''}" role="status">${escape(message)}</p>`;

function setRoute(id?: string) {
  route = id ? `#update/${encodeURIComponent(id)}` : '#update';
  history.replaceState(null, '', route);
}
function clearDraft() { current = null; draft = blankDraft(); dirty = false; latest = null; }
function allowDiscard() { return !dirty || window.confirm('当前修改尚未保存，确定放弃这些修改吗？'); }
function report(text: string, error = false) { message = text; failed = error; }
function fieldValue(data: FormData, name: string) { return String(data.get(name) ?? '').trim() || null; }
function readMoney(data: FormData, name: string): Money | null {
  const value = fieldValue(data, name);
  return value === null ? null : { value, unit: data.get(`${name}_unit`) as Money['unit'] };
}
function collect() {
  const form = document.querySelector<HTMLFormElement>('#project-form');
  if (!form || busy) return;
  const data = new FormData(form);
  const previous = draft.update_details!;
  draft = { name: fieldValue(data, 'name') ?? '', kind: 'update', issuer_name: fieldValue(data, 'issuer_name'),
    market: marketValue(String(data.get('market') ?? '')), offering: fieldValue(data, 'offering') as Offering | null,
    update_details: {
      has_historical: data.get('has_historical') === 'yes' ? true : data.get('has_historical') === 'no' ? false : null,
      reporting_cutoff: fieldValue(data, 'reporting_cutoff'), registration_amount: readMoney(data, 'registration_amount'), issuance_amount: readMoney(data, 'issuance_amount'),
      bond_terms: fieldValue(data, 'bond_terms'), underwriting: fieldValue(data, 'underwriting'), other_agencies: fieldValue(data, 'other_agencies'),
      rating_enhancement: fieldValue(data, 'rating_enhancement'), other_information: fieldValue(data, 'other_information'), supplementary_notes: fieldValue(data, 'supplementary_notes'),
      funding_uses: previous.funding_uses.map((_, i) => ({ purpose: fieldValue(data, `purpose_${i}`) as UpdateDetails['funding_uses'][number]['purpose'], amount: readMoney(data, `use_amount_${i}`), details: fieldValue(data, `use_details_${i}`), target: fieldValue(data, `use_target_${i}`) }))
    }
  };
}
function fundingRow(use: UpdateDetails['funding_uses'][number], i: number) {
  const hint = FUNDING_PURPOSES.find(purpose => purpose.code === use.purpose)?.materials ?? '用途未定可留空，已确定的安排可以先填写。';
  return `<section class="funding-row" aria-label="资金用途 ${i + 1}"><h3>资金用途 ${i + 1}</h3><div class="field-grid"><div class="field"><label for="purpose_${i}">用途</label><select id="purpose_${i}" name="purpose_${i}" data-purpose><option value="">请选择</option>${FUNDING_PURPOSES.map(p => option(p.code, p.label, use.purpose)).join('')}</select></div>${moneyField(`use_amount_${i}`, '拟使用金额', use.amount)}${textField(`use_target_${i}`, '涉及项目 / 投资标的 / 基金', use.target, '可填写名称、主体或尚待确定的安排')}${textField(`use_details_${i}`, '具体安排', use.details, '如有多种用途，请分别说明金额、使用计划和相关依据。')}</div><p class="field-help">${escape(hint)}</p><button class="text-btn" type="button" data-remove="${i}">删除此用途</button></section>`;
}
function summary(project: ProjectCreate): Array<[string, string]> {
  const d = project.update_details!;
  const amount = (m: Money | null) => m ? `${m.value} ${MONEY_UNITS.find(u => u.code === m.unit)?.label}` : '未填写';
  return [
    ['项目名称', project.name || '未填写'], ['发行人', project.issuer_name ?? '未填写'],
    ['市场 / 发行方式', `${project.market ? MARKET_LABELS[project.market] : '未填写'} / ${project.offering ? OFFERING_LABELS[project.offering] : '未填写'}`],
    ['历史募集书', d.has_historical === null ? '未填写' : d.has_historical ? '有' : '没有'], ['报告截止日', d.reporting_cutoff ?? '未填写'],
    ['申报 / 注册总额', amount(d.registration_amount)], ['本期发行规模', amount(d.issuance_amount)],
    ['债券安排', d.bond_terms ?? '未填写'], ['承销安排', d.underwriting ?? '未填写'], ['其他机构', d.other_agencies ?? '未填写'],
    ['评级与增信', d.rating_enhancement ?? '未填写'],
    ['资金用途', d.funding_uses.map(u => [FUNDING_PURPOSES.find(p => p.code === u.purpose)?.label ?? '用途未定', amount(u.amount), u.target, u.details].filter(Boolean).join('；')).join('\n') || '未填写'],
    ['其他信息', d.other_information ?? '未填写'], ['补充说明', d.supplementary_notes ?? '未填写']
  ];
}
function conflictView() {
  if (!latest) return '';
  const saved = summary(draftFromProject(latest));
  return `<section class="notice" aria-labelledby="conflict-heading"><h2 id="conflict-heading">发现其他页面的修改</h2><p>本页填写内容保留在下方。请核对差异，再选择保留哪一份。</p><div class="comparison-scroll"><table id="saved-comparison"><thead><tr><th>项目字段</th><th>本页填写</th><th>最新已保存</th></tr></thead><tbody>${summary(draft).map(([label, value], i) => `<tr><th>${escape(label)}</th><td>${escape(value)}</td><td>${escape(saved[i][1])}</td></tr>`).join('')}</tbody></table></div><div class="conflict-actions"><button type="button" class="btn" id="load-latest">放弃本页修改，载入已保存版本</button><button type="button" class="btn" id="keep-local">核对后用本页内容覆盖</button></div></section>`;
}
function renderWorkspace() {
  document.body.className = 'bb-form-app';
  const d = draft.update_details!;
  const offerings = draft.market ? MARKET_OFFERINGS[draft.market] : [];
  root.innerHTML = `<header class="bb-header"><span class="brand">Bond<span>Buddy</span></span><span>更新募集书</span><button id="logout" type="button" class="text-btn">退出登录</button></header><main class="bb-main"><div class="page-heading"><div><span class="eyebrow">项目工作区</span><h1>更新募集书</h1><p>先整理项目信息。尚未确定的内容可留空，随时保存后继续补充。</p></div><span class="save-status" id="save-status">${dirty ? '有尚未保存的修改' : current ? '已保存到账号' : '新项目 · 尚未保存'}</span></div><nav class="project-picker" aria-label="项目切换"><label for="project-picker">已保存项目</label><select id="project-picker"><option value="">选择项目</option>${projects.map(p => option(p.project_id, p.name, current?.project_id)).join('')}</select>${cursor ? '<button type="button" id="more-projects" class="text-btn">加载更多</button>' : ''}<button type="button" id="new-project" class="btn">新建项目</button><button type="button" id="refresh-projects" class="text-btn">刷新列表</button></nav>${status()}${conflictView()}<form id="project-form" class="workspace-layout"><div class="card form-card">
    <section class="form-section"><h2>是否有本发行人的历史募集书？</h2><div class="history-answer">${[['yes', '有', true], ['no', '没有', false]].map(([value, label, state]) => `<label class="choice"><input type="radio" name="has_historical" value="${value}"${d.has_historical === state ? ' checked' : ''}>${label}</label>`).join('')}</div></section>
    <section class="form-section"><h2>项目基本信息</h2><p>填写本次拟更新的目标；历史稿的信息将在提供材料后单独核对。</p><div class="field-grid">${textField('name', '项目名称', draft.name, '例如：某公司 2026 年公司债项目', PROJECT_FIELD_LIMITS.name, false)}${textField('issuer_name', '发行人全称', draft.issuer_name, '填写发行人法定全称', PROJECT_FIELD_LIMITS.issuer, false)}<div class="field"><label for="market">发行市场</label><select id="market" name="market"><option value="">请选择</option>${MARKETS.map(m => option(m, MARKET_LABELS[m], draft.market)).join('')}</select></div><div class="field"><label for="offering">发行方式</label><select id="offering" name="offering"${!draft.market ? ' disabled' : ''}><option value="">${draft.market ? '请选择' : '请先选择发行市场'}</option>${offerings.map(o => option(o, OFFERING_LABELS[o], draft.offering)).join('')}</select></div><div class="field"><label for="reporting_cutoff">目标最新报告截止日</label><input type="date" id="reporting_cutoff" name="reporting_cutoff" value="${escape(d.reporting_cutoff)}"><small>请填写本次拟使用的最新财务报表截止日。</small></div></div></section>
    <section class="form-section"><h2>发行规模与债券安排${optional}</h2><p>不同品种的期限、含权条款和用途会影响募集书多个章节。按实际安排描述；如有多个品种，请分别说明。</p><div class="field-grid">${moneyField('registration_amount', '申报 / 注册总额', d.registration_amount)}${moneyField('issuance_amount', '本期发行规模', d.issuance_amount)}${textField('bond_terms', '债券安排', d.bond_terms, '例如：本期拟发行不超过10亿元，3年期。如有多个品种，请分别说明金额、期限、利率方式、还本付息、回售 / 赎回 / 调息、用途差异及回拨安排。未确定的内容可注明待定。')}</div></section>
    <section class="form-section"><h2>参与机构${optional}</h2><p>仅一家主承销商时填名称即可；多家参与时再说明牵头、联席及其他分工，未定角色可留空。</p><div class="field-grid">${textField('underwriting', '承销安排', d.underwriting, '例如：XX证券担任主承销商。或：XX证券牵头、YY银行联席，XX证券兼任簿记管理人。')}${textField('other_agencies', '其他参与机构与分工', d.other_agencies, '如受托管理人、会计师事务所、律师事务所等。')}</div></section>
    <section class="form-section"><h2>评级与增信${optional}</h2><p>分别说明主体、债项、保证人评级及增信安排；未确定可留空，也可后续提供评级或担保资料。</p>${textField('rating_enhancement', '评级与增信安排', d.rating_enhancement, '可填写评级对象、等级、机构，以及担保人、担保方式或抵质押物等已知信息。')}</section>
    <section class="form-section"><h2>募集资金用途${optional}</h2><p>可添加多种用途，分别填写金额和具体安排；用途未定也能保存。</p>${d.funding_uses.map(fundingRow).join('')}<button type="button" class="btn" id="add-purpose"${d.funding_uses.length >= PROJECT_FIELD_LIMITS.fundingUses ? ' disabled' : ''}>＋ 添加资金用途</button></section>
    <section class="form-section"><h2>其他项目信息${optional}</h2>${textField('other_information', '其他已知信息', d.other_information, '例如：公司名称变更、银行授信额度及使用情况；相关材料可在后续补充。')}</section>
    <div class="form-footer"><span>保存不会开始更新。材料上传和更新执行尚未开放。</span><button type="submit" class="btn primary" id="save"${latest ? ' disabled' : ''}>保存项目</button></div></div>
    <aside class="card project-cowork"><div class="cowork-heading"><div><h2>补充说明与写作要求</h2><p>这里的内容随项目一起保存。</p></div></div><div class="cowork-context"><span>可以补充</span><strong>额外项目信息、修改要求和需要关注的事项</strong><small>按你的习惯描述即可，无需指定更新范围。</small></div>${textField('supplementary_notes', '补充说明', d.supplementary_notes, '例如：公司取得新的银行授信，总额度50亿元，其中未使用30亿元；请结合后续提供的证明材料更新相关说明。')}<p class="cowork-footnote">当前可保存补充说明，多轮对话将在后续开放。</p><h3>可提前准备的材料</h3><ul class="material-hints">${materialHints(d).map(h => `<li>${escape(h)}</li>`).join('')}</ul>${draft.offering === 'dfi' ? '<p class="field-help">如已取得，可准备注册通知、注册申报文件、分期发行计划及承销商团安排；尚未取得的文件可后续补充。</p>' : ''}</aside></form></main>`;
  bindWorkspace();
}
function disableForRequest() { busy = true; root.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement>('input, button, select, textarea').forEach(control => { control.disabled = true; }); }
async function handleError(error: unknown) {
  report(errorMessage(error), true);
  if (error instanceof ApiError && error.status === 401) {
    retainedOwner = session?.user_id ?? retainedOwner;
    session = null;
  }
}
async function loadProjects(more = false) {
  const result = await api.list(more ? cursor ?? undefined : undefined);
  projects = more ? [...projects, ...result.items.filter(p => !projects.some(old => old.project_id === p.project_id))] : result.items;
  cursor = result.page.next_cursor;
}
async function openProject(id: string) {
  const project = await api.project(id);
  if (project.kind !== 'update') throw new Error('This entry supports update projects only.');
  current = project; draft = draftFromProject(project); dirty = false; latest = null; setRoute(id);
}
async function save() {
  if (busy || latest) return;
  collect();
  if (!draft.name) draft.name = '未命名更新项目';
  const errors = validateDraft(draft);
  if (errors.length) { report(errors.join(' '), true); renderWorkspace(); return; }
  disableForRequest();
  try {
    const identity = await api.me();
    if (identity.user_id !== session?.user_id) {
      clearDraft(); projects = []; cursor = null; session = identity; retainedOwner = identity.user_id; setRoute();
      report('账号已在其他页面切换。为保护原账号信息，已清空本页内容，请重新打开当前账号的项目。', true);
      return;
    }
    const saved = await api.save(draft, current);
    current = saved; draft = draftFromProject(saved); dirty = false; setRoute(saved.project_id);
    projects = [{ project_id: saved.project_id, name: saved.name, draft_revision: saved.draft_revision, updated_at: saved.updated_at }, ...projects.filter(p => p.project_id !== saved.project_id)];
    report('项目已保存。可以从已保存项目中重新打开继续填写。');
  } catch (error) {
    await handleError(error);
    if (error instanceof ApiError && error.code === 'INPUT_REVISION_CONFLICT' && current) {
      try { latest = await api.project(current.project_id); } catch (readError) { await handleError(readError); }
    }
  } finally { busy = false; render(); }
}
function bindWorkspace() {
  const form = document.querySelector<HTMLFormElement>('#project-form')!;
  form.addEventListener('input', () => {
    dirty = true; collect(); document.querySelector('#save-status')!.textContent = '有尚未保存的修改';
    if (latest) document.querySelectorAll('#saved-comparison tbody tr').forEach((row, i) => { row.children[1].textContent = summary(draft)[i][1]; });
  });
  form.addEventListener('change', event => {
    const target = event.target as HTMLInputElement;
    collect(); dirty = true;
    if (target.name === 'market') {
      const changed = changeMarket(draft, marketValue(target.value)); draft = changed.draft;
      report(changed.cleared ? '发行市场已更改，请重新选择适用的发行方式；其他填写内容已保留。' : '发行市场已更改，其他填写内容已保留。');
    }
    if (target.name === 'market' || target.name === 'offering' || target.name === 'has_historical' || target.hasAttribute('data-purpose')) renderWorkspace();
  });
  form.addEventListener('submit', event => { event.preventDefault(); void save(); });
  document.querySelector('#add-purpose')!.addEventListener('click', () => { collect(); draft.update_details!.funding_uses.push({ purpose: null, amount: null, details: null, target: null }); dirty = true; renderWorkspace(); });
  document.querySelectorAll<HTMLButtonElement>('[data-remove]').forEach(button => button.addEventListener('click', () => {
    collect();
    if (window.confirm('确定删除这一项资金用途及已填写的信息吗？')) { draft.update_details!.funding_uses.splice(Number(button.dataset.remove), 1); dirty = true; renderWorkspace(); }
  }));
  document.querySelector('#new-project')!.addEventListener('click', () => { collect(); if (allowDiscard()) { clearDraft(); setRoute(); report(''); renderWorkspace(); } });
  document.querySelector<HTMLSelectElement>('#project-picker')!.addEventListener('change', event => { const id = (event.target as HTMLSelectElement).value; if (id) void navigate(id); });
  document.querySelector('#refresh-projects')!.addEventListener('click', () => void listAction());
  document.querySelector('#more-projects')?.addEventListener('click', () => void listAction(true));
  document.querySelector('#load-latest')?.addEventListener('click', () => { if (allowDiscard() && latest) { current = latest; draft = draftFromProject(latest); latest = null; dirty = false; report('已载入最新保存的项目。'); renderWorkspace(); } });
  document.querySelector('#keep-local')?.addEventListener('click', () => { collect(); if (latest && window.confirm('已核对差异？此操作将用本页全部填写内容替换刚才看到的已保存版本。')) { current = latest; latest = null; void save(); } });
  document.querySelector('#logout')!.addEventListener('click', () => void logout());
}
async function listAction(more = false) {
  collect(); disableForRequest();
  try { await loadProjects(more); report('项目列表已更新。'); } catch (error) { await handleError(error); }
  finally { busy = false; render(); }
}
async function navigate(id: string) {
  collect();
  if (!allowDiscard()) { setRoute(current?.project_id); renderWorkspace(); return; }
  disableForRequest();
  try { await openProject(id); report('已打开保存的项目。'); }
  catch (error) { setRoute(current?.project_id); await handleError(error); }
  finally { busy = false; render(); }
}
async function logout() {
  collect(); if (!allowDiscard()) return;
  disableForRequest();
  try { await api.logout(); session = null; retainedOwner = null; clearDraft(); projects = []; cursor = null; setRoute(); report('已退出登录。'); }
  catch (error) { await handleError(error); }
  finally { busy = false; render(); }
}
function renderLogin() {
  document.body.className = 'bb-form-app';
  root.innerHTML = `<main class="bb-login card"><div class="brand">Bond<span>Buddy</span></div><h1>登录项目工作区</h1><p>使用已有账号，继续填写和保存募集书项目。</p>${status()}<form id="login-form"><div class="field"><label for="username">用户名</label><input id="username" name="username" autocomplete="username" required maxlength="32"></div><div class="field"><label for="password">密码</label><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="128"></div><button class="btn primary" type="submit">登录</button></form></main>`;
  document.querySelector<HTMLFormElement>('#login-form')!.addEventListener('submit', async event => {
    event.preventDefault(); if (busy) return;
    const data = new FormData(event.currentTarget as HTMLFormElement);
    disableForRequest();
    try {
      const loggedIn = await api.login(String(data.get('username')).trim(), String(data.get('password')));
      if (retainedOwner && retainedOwner !== loggedIn.user_id) { clearDraft(); projects = []; cursor = null; setRoute(); }
      session = loggedIn; retainedOwner = loggedIn.user_id;
      await loadProjects();
      if (!dirty) await restoreRoute();
      report(dirty ? '已重新登录，本页未保存内容已保留，请核对后保存。' : '已登录，可以创建或打开项目。');
    } catch (error) {
      await handleError(error);
      if (!session && error instanceof ApiError) {
        if (error.status === 401) report('用户名或密码不正确，请重试。', true);
        if (error.status === 422) report('请检查用户名格式：以字母开头，3–32 位字母、数字或下划线。', true);
      }
    }
    finally { busy = false; render(); }
  });
}
function render() { if (session) renderWorkspace(); else renderLogin(); }
async function restoreRoute() {
  const match = /^#update\/([A-Za-z0-9_-]{1,128})$/.exec(location.hash);
  if (match) await openProject(match[1]); else setRoute(current?.project_id);
}
window.addEventListener('beforeunload', event => { if (dirty || busy) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('hashchange', () => {
  if (location.hash === route) return;
  if (busy || !session) { history.replaceState(null, '', route); return; }
  const id = /^#update\/([A-Za-z0-9_-]{1,128})$/.exec(location.hash)?.[1];
  if (id) void navigate(id);
  else { collect(); if (allowDiscard()) { clearDraft(); setRoute(); report(''); renderWorkspace(); } else setRoute(current?.project_id); }
});
root.innerHTML = '<main class="bb-login"><p role="status">正在加载项目工作区…</p></main>';
try { session = await api.me(); retainedOwner = session.user_id; await loadProjects(); await restoreRoute(); }
catch (error) { if (!(error instanceof ApiError && error.status === 401)) await handleError(error); }
render();
