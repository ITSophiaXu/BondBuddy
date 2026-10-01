import { FUNDING_PURPOSES, MARKET_LABELS, MARKET_OFFERINGS, MARKETS, MONEY_UNITS, OFFERING_LABELS, PROJECT_FIELD_LIMITS, type Money, type Offering, type UpdateDetails } from '@bondbuddy/contracts';
import { prototypeIcon as icon } from './prototype-design.js';
import { annualYears, interimEnd, enteredPeriods } from './source-prospectus.js';
import { changeMarket, marketValue, materialHints, projectKind, type ProjectCreate } from './form-model.js';

const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const option = (value: string, label: string, active: unknown) => `<option value="${esc(value)}"${value === active ? ' selected' : ''}>${esc(label)}</option>`;
const note = (name: string, label: string, value: unknown, placeholder: string) => `<div class="update-field full"><label for="${name}">${label}</label><textarea id="${name}" name="${name}" maxlength="${PROJECT_FIELD_LIMITS.notes}" placeholder="${esc(placeholder)}">${esc(value)}</textarea></div>`;
const money = (name: string, label: string, value: Money | null) => `<div class="update-field"><label for="${name}">${label}</label><div class="money-input"><input id="${name}" name="${name}" inputmode="decimal" maxlength="40" value="${esc(value?.value)}" placeholder="未确定可留空"><select name="${name}_unit" aria-label="${label}单位">${MONEY_UNITS.map(unit => option(unit.code, unit.label, value?.unit ?? 'hundred_million')).join('')}</select></div></div>`;
const retainedDetails = new WeakMap<HTMLFormElement, UpdateDetails>();

export function offeringOptions(draft: ProjectCreate) {
  return `<option value="">${draft.market ? '请选择' : '请先选择发行市场'}</option>${(draft.market ? MARKET_OFFERINGS[draft.market] : []).map(o => option(o, OFFERING_LABELS[o], draft.offering)).join('')}`;
}
export function fundingRows(details: UpdateDetails) {
  return details.funding_uses.map((use, i) => `<section class="funding-row" aria-label="资金用途 ${i + 1}"><h3>资金用途 ${i + 1}</h3><div class="update-grid"><div class="update-field"><label for="purpose_${i}">用途</label><select id="purpose_${i}" name="purpose_${i}" data-purpose="${i}"><option value="">请选择</option>${FUNDING_PURPOSES.map(p => option(p.code, p.label, use.purpose)).join('')}</select></div>${money(`use_amount_${i}`, '拟使用金额', use.amount)}${note(`use_target_${i}`, '涉及项目 / 投资标的 / 基金', use.target, '可填写名称、主体或尚待确定的安排')}${note(`use_details_${i}`, '具体安排', use.details, '分别说明拟使用金额、计划和相关依据。')}</div><p class="field-hint" data-purpose-hint="${i}">${esc(purposeHint(use.purpose))}</p><button type="button" class="text-button" data-remove-purpose="${i}">删除此用途</button></section>`).join('');
}
function purposeHint(purpose: UpdateDetails['funding_uses'][number]['purpose']) { return FUNDING_PURPOSES.find(p => p.code === purpose)?.materials ?? '用途未定可留空，已确定的安排可以先填写。'; }
export function updateFormFields(value: ProjectCreate) {
  const d = value.update_details!;
  return `<section class="update-section"><h2>本次募集书目标</h2><p class="field-hint">原募集书选填。可上传本企业、母公司、子公司或相似业务企业的稿件，也可直接提供发行人材料编制新稿。</p><div class="update-grid"><label>目标报告年度<input name="target_years" value="${esc(annualYears(d.target_reporting_periods))}" placeholder="例如：2023、2024、2025"></label><label>目标一期截止日（无则留空）<input name="target_interim" type="date" value="${esc(interimEnd(d.target_reporting_periods))}"></label></div></section>
  <section class="update-section"><h2>项目基本信息</h2><p class="field-hint">填写本次拟更新的目标。尚未确定的信息可留空保存。</p><div class="update-grid">
    <div class="update-field"><label for="name">项目名称 <span class="required">必填</span></label><input id="name" name="name" required maxlength="${PROJECT_FIELD_LIMITS.name}" value="${esc(value.name)}" placeholder="例如：发行人 2026 年募集书更新"></div>
    <div class="update-field"><label for="issuer">发行人全称</label><input id="issuer" name="issuer" maxlength="${PROJECT_FIELD_LIMITS.issuer}" value="${esc(value.issuer_name)}" placeholder="填写发行人法定全称"></div>
    <div class="update-field"><label for="market">发行市场</label><select id="market" name="market"><option value="">请选择</option>${MARKETS.map(m => option(m, MARKET_LABELS[m], value.market)).join('')}</select></div>
    <div class="update-field"><label for="offering">发行方式</label><select id="offering" name="offering"${!value.market ? ' disabled' : ''}>${offeringOptions(value)}</select></div>
    </div><p id="market-notice" class="field-hint" role="status"></p></section>
  <section class="update-section"><h2>发行规模与债券安排 <span class="optional">选填</span></h2><p class="field-hint">不同品种的期限、含权条款和用途会影响募集书多个章节。如有多个品种，请分别说明。</p><div class="update-grid">${money('registration_amount', '申报 / 注册总额', d.registration_amount)}${money('issuance_amount', '本期发行规模', d.issuance_amount)}${note('bond_terms', '债券安排', d.bond_terms, '例如：本期拟发行不超过10亿元，3年期。如有多个品种，请分别说明金额、期限、利率方式、还本付息、回售 / 赎回 / 调息、增信和用途差异及回拨安排。未确定的内容可注明待定。')}</div></section>
  <section class="update-section"><h2>参与机构 <span class="optional">选填</span></h2><p class="field-hint">仅一家主承销商时填名称即可；多家参与时再说明牵头、联席及其他分工，未定角色可留空。</p>${note('underwriting', '承销安排', d.underwriting, '例如：XX证券担任主承销商。或：XX证券牵头、YY银行联席，XX证券兼任簿记管理人。')}${note('other_agencies', '其他参与机构与分工', d.other_agencies, '如受托管理人、会计师事务所、律师事务所等。')}</section>
  <section class="update-section"><h2>评级与增信 <span class="optional">选填</span></h2><p class="field-hint">分清主体、债项、保证人评级；未确定可留空，后续提供评级或担保资料。</p>${note('rating_enhancement', '评级与增信安排', d.rating_enhancement, '可填写评级对象、等级、评级机构、保证人、担保方式或抵质押物等已知信息。')}</section>
  <section class="update-section"><h2>募集资金用途 <span class="optional">选填</span></h2><p class="field-hint">可添加多种用途，分别填写金额和具体安排；用途未定也能保存。</p><div id="funding-rows">${fundingRows(d)}</div><button type="button" id="add-purpose" class="button secondary">＋ 添加资金用途</button></section>
  <section class="update-section"><h2>其他项目信息 <span class="optional">选填</span></h2>${note('other_information', '其他已知信息', d.other_information, '例如：公司名称变更、银行授信额度及使用情况；相关材料可后续补充。')}${d.supplementary_notes ? `<p class="field-hint">旧版补充仍随项目草稿保存，未作为独立消息发送；修改它不会编辑已发送的消息。</p>${note('supplementary_notes', '旧版补充说明', d.supplementary_notes, '旧版草稿说明')}` : ''}</section>`;
}
function text(data: FormData, name: string) { return String(data.get(name) ?? '').trim() || null; }
function readMoney(data: FormData, name: string): Money | null {
  const value = text(data, name);
  return value === null ? null : { value, unit: data.get(`${name}_unit`) as Money['unit'] };
}
export function readUpdateForm(form: HTMLFormElement): ProjectCreate {
  const data = new FormData(form);
  const hasHistorical = null;
  const periods = enteredPeriods(String(data.get('target_years') ?? ''), String(data.get('target_interim') ?? ''));

  return { kind: projectKind(hasHistorical), name: String(data.get('name') ?? ''), issuer_name: text(data, 'issuer'), market: marketValue(String(data.get('market') ?? '')), offering: text(data, 'offering') as Offering | null,
    update_details: {
      ...structuredClone(retainedDetails.get(form) ?? {}),
      authoring_mode: 'unified_v1',
      target_reporting_periods: periods,
      has_historical: hasHistorical,
      reporting_cutoff: periods.map(p => p.end).filter((d): d is string => !!d).sort().at(-1) ?? null, registration_amount: readMoney(data, 'registration_amount'), issuance_amount: readMoney(data, 'issuance_amount'),
      bond_terms: text(data, 'bond_terms'), underwriting: text(data, 'underwriting'), other_agencies: text(data, 'other_agencies'), rating_enhancement: text(data, 'rating_enhancement'),
      funding_uses: [...form.querySelectorAll('[data-purpose]')].map((_, i) => ({ purpose: text(data, `purpose_${i}`) as UpdateDetails['funding_uses'][number]['purpose'], amount: readMoney(data, `use_amount_${i}`), details: text(data, `use_details_${i}`), target: text(data, `use_target_${i}`) })),
      other_information: text(data, 'other_information'), supplementary_notes: data.has('supplementary_notes') ? text(data, 'supplementary_notes') : retainedDetails.get(form)?.supplementary_notes ?? null
    }
  };
}
export function bindUpdateForm(form: HTMLFormElement, changed: (value: ProjectCreate) => void, initialDetails?: UpdateDetails) {
  if (initialDetails) retainedDetails.set(form, structuredClone(initialDetails));
  const emit = () => {
    const value = readUpdateForm(form);
    const issuer = document.querySelector('#cowork-issuer'); if (issuer) issuer.textContent = value.issuer_name || '待填写发行人';
    const scope = document.querySelector('#cowork-scope'); if (scope) scope.textContent = `${value.market ? MARKET_LABELS[value.market] : '发行市场待选择'} · ${value.offering ? OFFERING_LABELS[value.offering] : '发行方式待选择'}`;
    changed(value);
  };
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
