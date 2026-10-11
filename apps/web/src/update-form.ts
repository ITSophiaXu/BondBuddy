import { reportingWindow, FUNDING_PURPOSES, MARKET_LABELS, MARKET_OFFERINGS, MARKETS, MONEY_UNITS, OFFERING_LABELS, PROJECT_FIELD_LIMITS, type Money, type Offering, type UpdateDetails } from '@bondbuddy/contracts';
import { prototypeIcon as icon } from './prototype-design.js';
import { QUARTER_ENDS, cutoffSelection, quarterCutoff } from './reporting-cutoff.js';
import { changeMarket, generatedProjectName, marketValue, materialHints, projectKind, type ProjectCreate } from './form-model.js';

const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const option = (value: string, label: string, active: unknown) => `<option value="${esc(value)}"${value === active ? ' selected' : ''}>${esc(label)}</option>`;
const fieldNote = (name: string, text: string) => `<p id="${name}-note" class="field-note">${esc(text)}</p>`;
const note = (name: string, label: string, value: unknown, guidance: string) => `<div class="update-field full"><label for="${name}">${label}</label><textarea id="${name}" name="${name}" maxlength="${PROJECT_FIELD_LIMITS.notes}" aria-describedby="${name}-note">${esc(value)}</textarea>${fieldNote(name, guidance)}</div>`;
const money = (name: string, label: string, value: Money | null) => `<div class="update-field"><label for="${name}">${label}</label><div class="money-input"><input id="${name}" name="${name}" inputmode="decimal" maxlength="40" value="${esc(value?.value)}" aria-describedby="${name}-note"><select name="${name}_unit" aria-label="${label}单位" aria-describedby="${name}-note">${MONEY_UNITS.map(unit => option(unit.code, unit.label, value?.unit ?? 'hundred_million')).join('')}</select></div>${fieldNote(name, '未确定可留空，若空白则沿用历史募集说明书内容')}</div>`;
const originalTarget = new WeakMap<HTMLFormElement, string>();
const targetKey = (value: ProjectCreate) => JSON.stringify([value.market, value.offering, value.update_details?.reporting_cutoff]);
const retainedDetails = new WeakMap<HTMLFormElement, UpdateDetails>();

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
  return `<section class="update-section"><h2>项目基本信息 <span class="required">必填</span></h2><p class="field-hint">${autoName ? '填写发行人全称即可自动生成项目名称，其他尚未确定的信息可留空保存。' : '填写本次更新的目标。尚未确定的信息可留空保存。'}</p><div class="update-grid">
    <div class="update-field"><label for="issuer">发行人全称</label><input id="issuer" name="issuer"${autoName ? ' required' : ''} maxlength="${PROJECT_FIELD_LIMITS.issuer}" value="${esc(value.issuer_name)}" aria-describedby="issuer-note">${fieldNote('issuer', '填写发行人法定全称')}</div>
    ${autoName ? `<div class="update-field"><label for="generated-project-name">项目名称 <span class="optional">自动生成</span></label><output id="generated-project-name" for="issuer market offering" aria-live="polite" aria-describedby="name-note">${esc(generatedProjectName(value.issuer_name ?? null, value.market ?? null, value.offering ?? null)) || '填写发行人后自动生成'}</output>${fieldNote('name', '根据发行人、发行市场和发行方式自动生成，无需填写。')}</div>` : `<div class="update-field"><label for="name">项目名称</label><input id="name" name="name" required maxlength="${PROJECT_FIELD_LIMITS.name}" value="${esc(value.name)}" aria-describedby="name-note">${fieldNote('name', '已保存的项目名称，可按需修改。')}</div>`}
    <div class="update-field"><label for="market">发行市场</label><select id="market" name="market"><option value="">请选择</option>${MARKETS.map(m => option(m, MARKET_LABELS[m], value.market)).join('')}</select></div>
    <div class="update-field"><label for="offering">发行方式</label><select id="offering" name="offering"${!value.market ? ' disabled' : ''}>${offeringOptions(value)}</select></div>
    <div class="update-field full"><label for="reporting-year">最新报告期</label><div class="period-row"><select id="reporting-year" name="reporting_year" aria-label="最新报告期年份">${selected.years.map(y => option(y, `${y} 年`, selected.year)).join('')}</select><div class="quarter-grid">${QUARTER_ENDS.map(([q, label]) => `<label class="quarter"><input type="radio" name="reporting_quarter" value="${q}"${selected.quarter === q ? ' checked' : ''}>${label}</label>`).join('')}</div></div>${selected.legacy ? `<p id="legacy-cutoff" class="field-hint">已保存报告期：${esc(d.reporting_cutoff)}；选择期末后更新。</p>` : ''}<p class="field-hint" id="reporting-window" role="status"></p></div>
    </div><p id="market-notice" class="field-hint" role="status"></p></section>
  <section class="update-section"><h2>发行规模与债券安排 <span class="optional">选填</span></h2><p class="field-hint">不同品种的期限、含权条款和用途会影响募集书多个章节。如有多个品种，请分别说明。</p><div class="update-grid">${money('registration_amount', '申报 / 注册总额', d.registration_amount)}${money('issuance_amount', '本期发行规模', d.issuance_amount)}${note('bond_terms', '债券安排', d.bond_terms, '例如：本期拟发行不超过10亿元，3年期。如有两个品种，请分别说明品种一和品种二的金额、期限、利率方式、还本付息、回售 / 赎回 / 调息、增信和用途差异及回拨安排。若空白，则沿用历史募集说明书内容')}</div></section>
  <section class="update-section"><h2>参与机构 <span class="optional">选填</span></h2><p class="field-hint">仅一家主承销商时填名称即可；多家参与时再说明牵头、联席及其他分工，未定角色可留空。</p>${note('underwriting', '承销安排', d.underwriting, '例如：XX证券担任主承销商。或：XX证券牵头、YY银行联席，XX证券兼任簿记管理人、受托管理人、存续期管理人。')}${note('other_agencies', '其他参与机构与分工', d.other_agencies, '如律师事务所等。')}</section>
  <section class="update-section"><h2>评级与增信 <span class="optional">选填</span></h2><p class="field-hint">分清主体、债项、保证人评级；未确定可留空，后续提供评级或担保资料。</p>${note('rating_enhancement', '评级与增信安排', d.rating_enhancement, '可填写评级对象、等级、评级机构、保证人、担保方式或抵质押物等已知信息。如：主体评级AA+/AAA，由XXX公司提供担保。')}</section>
  <section class="update-section"><h2>募集资金用途 <span class="optional">选填</span></h2><p class="field-hint">可添加多种用途，分别填写金额和具体安排；用途未定也能保存。</p><div id="funding-rows">${fundingRows(d)}</div><button type="button" id="add-purpose" class="button secondary">＋ 添加资金用途</button></section>
  <section class="update-section"><h2>其他项目信息 <span class="optional">选填</span></h2>${note('other_information', '其他已知信息', d.other_information, '例如：银行授信额度及使用情况；相关材料可后续补充。')}</section>`;
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
    changed(value);
  };
  // Show the saved/derived range without triggering an autosave on mount.
  const periods = readUpdateForm(form).update_details?.target_reporting_periods ?? [];
  form.querySelector('#reporting-window')!.textContent = periods.length ? `报告期：${periods.map(p => p.period_kind === 'annual' ? `${p.end?.slice(0,4)}年` : `${p.end?.slice(0,4)}年1—${Number(p.end?.slice(5,7))}月`).join('、')}` : '';
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
