import { reportingWindow, schemas, updateDetailsErrors, FUNDING_PURPOSES, MARKET_LABELS, MARKET_OFFERINGS, MARKETS, MONEY_UNITS, OFFERING_LABELS, PROJECT_FIELD_LIMITS, type Money, type Offering, type UpdateDetails } from './billing-types.js';
import { Value } from '@sinclair/typebox/value';
import { prototypeIcon as icon } from './prototype-design.js';
import { QUARTER_ENDS, cutoffSelection, quarterCutoff } from './reporting-cutoff.js';
import { changeMarket, generatedProjectName, marketValue, materialHints, projectKind, type ProjectCreate } from './form-model.js';

const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const option = (value: string, label: string, active: unknown) => `<option value="${esc(value)}"${value === active ? ' selected' : ''}>${esc(label)}</option>`;
const fieldNote = (name: string, text: string) => `<p id="${name}-note" class="field-note">${esc(text)}</p>`;
const note = (name: string, label: string, value: unknown, guidance: string) => `<div class="update-field full"><label for="${name}">${label}</label><textarea id="${name}" name="${name}" maxlength="${PROJECT_FIELD_LIMITS.notes}" aria-describedby="${name}-note">${esc(value)}</textarea>${fieldNote(name, guidance)}</div>`;
const money = (name: string, label: string, value: Money | null) => `<div class="update-field"><label for="${name}">${label}</label><div class="money-input"><input id="${name}" name="${name}" inputmode="decimal" maxlength="40" value="${esc(value?.value)}" aria-describedby="${name}-note"><select name="${name}_unit" aria-label="${label}单位" aria-describedby="${name}-note">${MONEY_UNITS.map(unit => option(unit.code, unit.label, value?.unit ?? 'hundred_million')).join('')}</select></div>${fieldNote(name, '未确定可留空。有原稿时可参考原稿安排；无原稿时留待确认。')}</div>`;
const originalTarget = new WeakMap<HTMLFormElement, string>();
const targetKey = (value: ProjectCreate) => JSON.stringify([value.market, value.offering, value.update_details?.reporting_cutoff]);
const retainedDetails = new WeakMap<HTMLFormElement, UpdateDetails>();
type OptionalGroup = 'issuance' | 'agencies' | 'rating' | 'funding' | 'other';
const filled = (value: unknown) => typeof value === 'string' ? Boolean(value.trim()) : value !== null && value !== undefined;
function optionalSummary(details: UpdateDetails, group: OptionalGroup) {
  const fields = {
    issuance: [details.registration_amount, details.issuance_amount, details.bond_terms],
    agencies: [details.underwriting, details.other_agencies], rating: [details.rating_enhancement],
    funding: details.funding_uses.filter(use => [use.purpose, use.amount, use.target, use.details].some(filled)),
    other: [details.other_information]
  }[group];
  const count = fields.filter(filled).length;
  return count ? `已填写 ${count} 项${group === 'funding' ? '用途' : ''}` : '未填写';
}
const optionalSection = (group: OptionalGroup, title: string, details: UpdateDetails, content: string) => `<details class="update-section update-optional-section" data-update-group="${group}"><summary><span class="update-group-title">${title} <span class="optional">选填</span></span><span class="update-group-state" data-update-summary>${optionalSummary(details, group)}</span><span class="update-group-error" data-update-group-error hidden>有待核对项</span></summary><div class="update-optional-content">${content}</div></details>`;
function updateOptionalSummaries(form: HTMLFormElement, details: UpdateDetails) {
  form.querySelectorAll<HTMLDetailsElement>('details[data-update-group]').forEach(section => {
    section.querySelector('[data-update-summary]')!.textContent = optionalSummary(details, section.dataset.updateGroup as OptionalGroup);
  });
}

export function offeringOptions(draft: ProjectCreate) {
  return `<option value="">${draft.market ? '请选择' : '请先选择发行市场'}</option>${(draft.market ? MARKET_OFFERINGS[draft.market] : []).map(o => option(o, OFFERING_LABELS[o], draft.offering)).join('')}`;
}
export function fundingRows(details: UpdateDetails) {
  return details.funding_uses.map((use, i) => `<section class="funding-row" aria-label="资金用途 ${i + 1}"><h3>资金用途 ${i + 1}</h3><div class="update-grid"><div class="update-field"><label for="purpose_${i}">用途</label><select id="purpose_${i}" name="purpose_${i}" data-purpose="${i}" aria-describedby="purpose_${i}-note"><option value="">请选择</option>${FUNDING_PURPOSES.map(p => option(p.code, p.label, use.purpose)).join('')}</select></div>${money(`use_amount_${i}`, '拟使用金额', use.amount)}${note(`use_target_${i}`, '涉及项目 / 投资标的 / 基金', use.target, '可填写名称、主体或尚待确定的安排')}${note(`use_details_${i}`, '具体安排', use.details, '分别说明拟使用金额、计划和相关依据。')}</div><p id="purpose_${i}-note" class="field-hint" data-purpose-hint="${i}" aria-live="polite">${esc(purposeHint(use.purpose))}</p><button type="button" class="text-button" data-remove-purpose="${i}">删除此用途</button></section>`).join('');
}
function purposeHint(purpose: UpdateDetails['funding_uses'][number]['purpose']) { return FUNDING_PURPOSES.find(p => p.code === purpose)?.materials ?? '用途未定可留空，已确定的安排可以先填写。'; }
export function updateFormFields(value: ProjectCreate, autoName = false) {
  const d = value.update_details!;
  const selected = cutoffSelection(d.reporting_cutoff);
  return `<section class="update-section"><h2>项目基本信息 <span class="required">必填</span></h2><p class="field-hint">${autoName ? '创建项目只需填写发行人全称，项目名称自动生成；其他信息可稍后补充。' : '创建时仅发行人全称必填，其他信息可稍后补充；已保存的项目名称可按需修改。'}</p><div class="update-grid">
    <div class="update-field"><label for="issuer">发行人全称</label><input id="issuer" name="issuer"${autoName ? ' required' : ''} maxlength="${PROJECT_FIELD_LIMITS.issuer}" value="${esc(value.issuer_name)}" aria-describedby="issuer-note">${fieldNote('issuer', '填写发行人法定全称')}</div>
    ${autoName ? `<div class="update-field"><label for="generated-project-name">项目名称 <span class="optional">自动生成</span></label><output id="generated-project-name" for="issuer market offering" aria-live="polite" aria-describedby="name-note">${esc(generatedProjectName(value.issuer_name ?? null, value.market ?? null, value.offering ?? null)) || '填写发行人后自动生成'}</output>${fieldNote('name', '根据发行人、发行市场和发行方式自动生成，无需填写。')}</div>` : `<div class="update-field"><label for="name">项目名称</label><input id="name" name="name" required maxlength="${PROJECT_FIELD_LIMITS.name}" value="${esc(value.name)}" aria-describedby="name-note">${fieldNote('name', '已保存的项目名称，可按需修改。')}</div>`}
    <div class="update-field"><label for="market">发行市场</label><select id="market" name="market"><option value="">请选择</option>${MARKETS.map(m => option(m, MARKET_LABELS[m], value.market)).join('')}</select></div>
    <div class="update-field"><label for="offering">发行方式</label><select id="offering" name="offering"${!value.market ? ' disabled' : ''}>${offeringOptions(value)}</select></div>
    <div class="update-field full"><label for="reporting-year">最新报告期</label><div class="period-row"><select id="reporting-year" name="reporting_year" aria-label="最新报告期年份">${selected.years.map(y => option(y, `${y} 年`, selected.year)).join('')}</select><div class="quarter-grid">${QUARTER_ENDS.map(([q, label]) => `<label class="quarter"><input type="radio" name="reporting_quarter" value="${q}"${selected.quarter === q ? ' checked' : ''}>${label}</label>`).join('')}</div></div>${selected.legacy ? `<p id="legacy-cutoff" class="field-hint">已保存报告期：${esc(d.reporting_cutoff)}；选择期末后更新。</p>` : ''}<p class="field-hint" id="reporting-window" role="status"></p></div>
    </div><p id="market-notice" class="field-hint" role="status"></p></section>
  ${optionalSection('issuance', '发行规模与债券安排', d, `<p class="field-hint">不同品种的期限、含权条款和用途会影响募集书多个章节。如有多个品种，请分别说明。</p><div class="update-grid">${money('registration_amount', '申报 / 注册总额', d.registration_amount)}${money('issuance_amount', '本期发行规模', d.issuance_amount)}${note('bond_terms', '债券安排', d.bond_terms, '例如：本期拟发行不超过10亿元，3年期。如有两个品种，请分别说明品种一和品种二的金额、期限、利率方式、还本付息、回售 / 赎回 / 调息、增信和用途差异及回拨安排。未确定可留空；有原稿时参考原稿，无原稿时留待确认。')}</div>`)}
  ${optionalSection('agencies', '参与机构', d, `<p class="field-hint">仅一家主承销商时填名称即可；多家参与时再说明牵头、联席及其他分工，未定角色可留空。</p>${note('underwriting', '承销安排', d.underwriting, '例如：XX证券担任主承销商。或：XX证券牵头、YY银行联席，XX证券兼任簿记管理人、受托管理人、存续期管理人。')}${note('other_agencies', '其他参与机构与分工', d.other_agencies, '如律师事务所等。')}`)}
  ${optionalSection('rating', '评级与增信', d, `<p class="field-hint">分清主体、债项、保证人评级；未确定可留空，后续提供评级或担保资料。</p>${note('rating_enhancement', '评级与增信安排', d.rating_enhancement, '可填写评级对象、等级、评级机构、保证人、担保方式或抵质押物等已知信息。如：主体评级AA+/AAA，由XXX公司提供担保。')}`)}
  ${optionalSection('funding', '募集资金用途', d, `<p class="field-hint">可添加多种用途，分别填写金额和具体安排；用途未定也能保存。</p><div id="funding-rows">${fundingRows(d)}</div><button type="button" id="add-purpose" class="button secondary">＋ 添加资金用途</button>`)}
  ${optionalSection('other', '其他项目信息', d, note('other_information', '其他已知信息', d.other_information, '例如：银行授信额度及使用情况；相关材料可后续补充。'))}`;
}
function text(data: FormData, name: string) { return String(data.get(name) ?? '').trim() || null; }
function readMoney(data: FormData, name: string): Money | null {
  const value = text(data, name);
  return value === null ? null : { value, unit: data.get(`${name}_unit`) as Money['unit'] };
}
export function readUpdateForm(form: HTMLFormElement): ProjectCreate {
  const data = new FormData(form);
  const hasHistorical = null;
  const previous = retainedDetails.get(form);
  const cutoff = quarterCutoff(String(data.get('reporting_year') ?? ''), String(data.get('reporting_quarter') ?? ''))
    ?? (previous?.reporting_cutoff?.startsWith(`${data.get('reporting_year')}-`) ? previous.reporting_cutoff : null);
  const market = marketValue(String(data.get('market') ?? '')), offering = text(data, 'offering') as Offering | null;
  const sameTarget = originalTarget.get(form) === JSON.stringify([market, offering, cutoff]);
  const periods = sameTarget && previous?.target_reporting_periods?.length
    ? structuredClone(previous.target_reporting_periods) : reportingWindow(market, offering, cutoff);

  const issuer = text(data, 'issuer');
  const name = form.querySelector('#generated-project-name') ? generatedProjectName(issuer, market, offering) : String(data.get('name') ?? '');
  return { kind: projectKind(hasHistorical), name, issuer_name: issuer, market, offering,
    update_details: {
      ...structuredClone(retainedDetails.get(form) ?? {}),
      authoring_mode: 'unified_v1',
      target_reporting_periods: periods,
      has_historical: hasHistorical,
      reporting_cutoff: cutoff, registration_amount: readMoney(data, 'registration_amount'), issuance_amount: readMoney(data, 'issuance_amount'),
      bond_terms: text(data, 'bond_terms'), underwriting: text(data, 'underwriting'), other_agencies: text(data, 'other_agencies'), rating_enhancement: text(data, 'rating_enhancement'),
      funding_uses: [...form.querySelectorAll('[data-purpose]')].map((_, i) => ({ purpose: text(data, `purpose_${i}`) as UpdateDetails['funding_uses'][number]['purpose'], amount: readMoney(data, `use_amount_${i}`), details: text(data, `use_details_${i}`), target: text(data, `use_target_${i}`) })),
      other_information: text(data, 'other_information'), supplementary_notes: data.has('supplementary_notes') ? text(data, 'supplementary_notes') : retainedDetails.get(form)?.supplementary_notes ?? null
    }
  };
}
type UpdateFormIssue = { field: string; message: string; control?: HTMLElement };
type UpdateErrorMark = { control: HTMLElement; previousInvalid: string | null; hint: HTMLElement };
const validationRequested = new WeakSet<HTMLFormElement>();
const errorMarks = new WeakMap<HTMLFormElement, UpdateErrorMark[]>();
let errorSequence = 0;
function errorField(path: string) { return path.replace(/^\//, '').split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~')).join('.'); }
function schemaErrorMessage(field: string) {
  if (/(registration_amount|issuance_amount|funding_uses\.\d+\.amount)/.test(field)) return '请核对金额和单位：金额须为非负数，最多六位小数；未确定可留空。';
  if (field === 'name') return '请填写有效的项目名称。';
  if (field === 'issuer_name') return '请核对发行人全称及文字长度。';
  if (field === 'market' || field === 'offering') return '请重新选择适用的发行市场和发行方式。';
  if (field.includes('source_prospectuses')) return '已保存的原稿信息格式有待核对，请在材料区检查对应原稿信息。';
  if (/reporting_cutoff|target_reporting_periods/.test(field)) return '已保存的报告期格式有待核对，请检查报告期信息。';
  if (field.startsWith('update_details.funding_uses')) return '请核对资金用途的选项、文字长度和填写数量。';
  return '请核对已填写的信息、文字长度和选项格式。';
}
function errorControl(form: HTMLFormElement, field: string): HTMLElement | null {
  const name = field.replace(/^update_details\./, '');
  if (name.startsWith('source_prospectuses')) return null;
  if (/^(reporting_cutoff|target_reporting_periods)(\.|$)/.test(name)) return form.querySelector('#reporting-year');
  const basic: Record<string, string> = { name: form.querySelector('#name') ? 'name' : 'issuer', issuer_name: 'issuer', market: 'market', offering: 'offering' };
  if (Object.hasOwn(basic, name)) return form.querySelector(`#${basic[name]}`);
  const amount = /^(registration_amount|issuance_amount)(?:\.(value|unit))?$/.exec(name);
  if (amount) return form.querySelector(`[name="${amount[1]}${amount[2] === 'unit' ? '_unit' : ''}"]`);
  const use = /^funding_uses\.(\d+)(?:\.(purpose|amount|target|details)(?:\.(value|unit))?)?$/.exec(name);
  if (use) {
    const prefix: Record<string, string> = { purpose: 'purpose', amount: 'use_amount', target: 'use_target', details: 'use_details' };
    return form.querySelector(`[name="${prefix[use[2] ?? 'purpose']}_${use[1]}${use[2] === 'amount' && use[3] === 'unit' ? '_unit' : ''}"]`)
      ?? form.querySelector('#add-purpose');
  }
  if (name === 'funding_uses') return form.querySelector('#add-purpose');
  if (['bond_terms', 'underwriting', 'other_agencies', 'rating_enhancement', 'other_information', 'supplementary_notes'].includes(name)) return form.querySelector(`[name="${name}"]`);
  return null;
}
function clearUpdateErrors(form: HTMLFormElement) {
  for (const mark of errorMarks.get(form) ?? []) {
    if (mark.previousInvalid === null) mark.control.removeAttribute('aria-invalid');
    else mark.control.setAttribute('aria-invalid', mark.previousInvalid);
    const describedBy = (mark.control.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(id => id && id !== mark.hint.id);
    if (describedBy.length) mark.control.setAttribute('aria-describedby', describedBy.join(' '));
    else mark.control.removeAttribute('aria-describedby');
    mark.control.removeAttribute('data-update-invalid'); mark.hint.remove();
  }
  errorMarks.delete(form);
  form.querySelector('[data-update-validation-summary]')?.remove();
  form.querySelectorAll<HTMLDetailsElement>('details[data-update-group]').forEach(section => {
    delete section.dataset.updateInvalid;
    section.querySelector<HTMLElement>('[data-update-group-error]')!.hidden = true;
  });
}
function revealErrorGroup(control: HTMLElement) {
  const section = control.closest<HTMLDetailsElement>('details.update-optional-section');
  if (section) {
    section.open = true; section.dataset.updateInvalid = 'true';
    section.querySelector<HTMLElement>('[data-update-group-error]')!.hidden = false;
  }
}
/** Return current validation messages, reveal affected groups, and optionally focus the first error. */
export function revealUpdateFormErrors(form: HTMLFormElement, value: ProjectCreate, focus = true): string[] {
  validationRequested.add(form); clearUpdateErrors(form);
  const schemaErrors = [...Value.Errors(schemas.ProjectCreateRequest, value)];
  const issues: UpdateFormIssue[] = schemaErrors.map(error => {
    const field = errorField(error.path);
    return { field, message: field === 'name' && form.querySelector('#generated-project-name') ? '请填写发行人全称以生成项目名称。' : schemaErrorMessage(field) };
  });
  // Business validation expects schema-valid amounts before converting them to bigint.
  if (!schemaErrors.length) {
    if (value.offering && (!value.market || !(MARKET_OFFERINGS[value.market] as readonly string[]).includes(value.offering))) issues.push({ field: 'offering', message: '发行方式与发行市场不匹配，请重新选择。' });
    else if (value.update_details) issues.push(...updateDetailsErrors(value.update_details));
  }
  form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input,select,textarea').forEach(control => {
    if (control.willValidate && !control.validity.valid) issues.push({ field: control.name, message: control.validationMessage || '请核对此项填写内容。', control });
  });
  const byControl = new Map<HTMLElement, Set<string>>(), unlocated = new Set<string>();
  for (const issue of issues) {
    const control = issue.control ?? errorControl(form, issue.field);
    if (!control) { unlocated.add(issue.message); continue; }
    const messages = byControl.get(control) ?? new Set<string>(); messages.add(issue.message); byControl.set(control, messages);
  }
  const marks: UpdateErrorMark[] = [];
  for (const [control, messages] of byControl) {
    revealErrorGroup(control);
    const hint = document.createElement('p'); hint.id = `update-field-error-${++errorSequence}`; hint.className = 'update-field-error'; hint.textContent = [...messages].join(' ');
    const previousInvalid = control.getAttribute('aria-invalid'); control.setAttribute('aria-invalid', 'true'); control.setAttribute('data-update-invalid', '');
    control.setAttribute('aria-describedby', [control.getAttribute('aria-describedby'), hint.id].filter(Boolean).join(' '));
    (control.closest('.update-field') ?? control.parentElement ?? form).append(hint);
    marks.push({ control, previousInvalid, hint });
  }
  errorMarks.set(form, marks);
  let summary: HTMLElement | undefined;
  if (unlocated.size) {
    // Retained source/period metadata has no editable control here; keep its error visible.
    form.querySelectorAll<HTMLDetailsElement>('details.update-optional-section').forEach(section => { section.open = true; });
    summary = document.createElement('p'); summary.dataset.updateValidationSummary = ''; summary.className = 'update-validation-summary'; summary.setAttribute('role', 'alert'); summary.tabIndex = -1; summary.textContent = [...unlocated].join(' ');
    (form.querySelector('.form-panel') ?? form).prepend(summary);
  }
  if (focus && issues.length) {
    const first = summary ?? form.querySelector<HTMLElement>('input[data-update-invalid],select[data-update-invalid],textarea[data-update-invalid],button[data-update-invalid]');
    first?.focus({ preventScroll: true }); first?.scrollIntoView({ block: 'center' });
  }
  return [...new Set(issues.map(issue => issue.message))];
}
export function bindUpdateForm(form: HTMLFormElement, changed: (value: ProjectCreate) => void, initialDetails?: UpdateDetails) {
  if (initialDetails) retainedDetails.set(form, structuredClone(initialDetails));
  originalTarget.set(form, targetKey(readUpdateForm(form)));
  const emit = () => {
    const value = readUpdateForm(form);
    const preview = form.querySelector<HTMLOutputElement>('#generated-project-name');
    if (preview) preview.value = value.name || '填写发行人后自动生成';
    const periods = value.update_details?.target_reporting_periods ?? [];
    form.querySelector('#reporting-window')!.textContent = periods.length
      ? `报告期：${periods.map(p => p.period_kind === 'annual' ? `${p.end?.slice(0,4)}年` : `${p.end?.slice(0,4)}年1—${Number(p.end?.slice(5,7))}月`).join('、')}` : '';
    updateOptionalSummaries(form, value.update_details!);
    if (validationRequested.has(form)) revealUpdateFormErrors(form, value, false);
    changed(value);
  };
  // Show the saved/derived range without triggering an autosave on mount.
  const periods = readUpdateForm(form).update_details?.target_reporting_periods ?? [];
  form.querySelector('#reporting-window')!.textContent = periods.length ? `报告期：${periods.map(p => p.period_kind === 'annual' ? `${p.end?.slice(0,4)}年` : `${p.end?.slice(0,4)}年1—${Number(p.end?.slice(5,7))}月`).join('、')}` : '';
  updateOptionalSummaries(form, readUpdateForm(form).update_details!);
  form.addEventListener('invalid', event => {
    if (event.target instanceof HTMLElement) revealErrorGroup(event.target);
    revealUpdateFormErrors(form, readUpdateForm(form), false);
  }, true);
  form.addEventListener('input', event => { if (!(event as InputEvent).isComposing) emit(); });
  form.addEventListener('compositionend', emit);
  form.addEventListener('change', event => {
    const target = event.target as HTMLInputElement;
    if (target.name === 'market') {
      const result = changeMarket(readUpdateForm(form), marketValue(target.value));
      const select = form.querySelector<HTMLSelectElement>('#offering')!;
      select.innerHTML = offeringOptions(result.draft); select.disabled = !result.draft.market;
      form.querySelector('#market-notice')!.textContent = result.cleared ? '发行市场已更改，请重新选择适用的发行方式；其他填写内容已保留。' : '发行市场已更改，其他填写内容已保留。';
    }
    const value = readUpdateForm(form);
    if (target.hasAttribute('data-purpose')) form.querySelector(`[data-purpose-hint="${target.dataset.purpose}"]`)!.textContent = purposeHint(target.value as UpdateDetails['funding_uses'][number]['purpose']);
    emit();
  });
  form.addEventListener('click', event => {
    const target = (event.target as HTMLElement).closest<HTMLButtonElement>('#add-purpose, [data-remove-purpose]');
    if (!target) return;
    const details = readUpdateForm(form).update_details!;
    if (target.id === 'add-purpose') { if (details.funding_uses.length >= PROJECT_FIELD_LIMITS.fundingUses) return; details.funding_uses.push({ purpose: null, amount: null, details: null, target: null }); }
    else if (target.hasAttribute('data-remove-purpose')) {
      if (!window.confirm('确定删除这一项资金用途及已填写的信息吗？')) return;
      details.funding_uses.splice(Number(target.dataset.removePurpose), 1);
    } else return;
    form.querySelector('#funding-rows')!.innerHTML = fundingRows(details);
    form.querySelector<HTMLButtonElement>('#add-purpose')!.disabled = details.funding_uses.length >= PROJECT_FIELD_LIMITS.fundingUses;
    emit();
  });
}
export function retainUpdateDetails(form: HTMLFormElement, details: UpdateDetails) { retainedDetails.set(form, structuredClone(details)); }
