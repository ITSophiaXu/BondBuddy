import { FUNDING_PURPOSES, MARKET_LABELS, MARKET_OFFERINGS, MARKETS, MONEY_UNITS, OFFERING_LABELS, PROJECT_FIELD_LIMITS, type Money, type Offering, type TargetReportingPeriod, type UpdateDetails } from '@bondbuddy/contracts';
import { prototypeIcon as icon } from './prototype-design.js';
import { changeMarket, marketValue, materialHints, type ProjectCreate } from './form-model.js';

const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const option = (value: string, label: string, active: unknown) => `<option value="${esc(value)}"${value === active ? ' selected' : ''}>${esc(label)}</option>`;
const note = (name: string, label: string, value: unknown, placeholder: string) => `<div class="update-field full"><label for="${name}">${label}</label><textarea id="${name}" name="${name}" maxlength="${PROJECT_FIELD_LIMITS.notes}" placeholder="${esc(placeholder)}">${esc(value)}</textarea></div>`;
const money = (name: string, label: string, value: Money | null) => `<div class="update-field"><label for="${name}">${label}</label><div class="money-input"><input id="${name}" name="${name}" inputmode="decimal" maxlength="40" value="${esc(value?.value)}" placeholder="未确定可留空"><select name="${name}_unit" aria-label="${label}单位">${MONEY_UNITS.map(unit => option(unit.code, unit.label, value?.unit ?? 'hundred_million')).join('')}</select></div></div>`;
const TARGET_PERIOD_LIMIT = 30;

export function offeringOptions(draft: ProjectCreate) {
  return `<option value="">${draft.market ? '请选择' : '请先选择发行市场'}</option>${(draft.market ? MARKET_OFFERINGS[draft.market] : []).map(o => option(o, OFFERING_LABELS[o], draft.offering)).join('')}`;
}
export function fundingRows(details: UpdateDetails) {
  return details.funding_uses.map((use, i) => `<section class="funding-row" aria-label="资金用途 ${i + 1}"><h3>资金用途 ${i + 1}</h3><div class="update-grid"><div class="update-field"><label for="purpose_${i}">用途</label><select id="purpose_${i}" name="purpose_${i}" data-purpose="${i}"><option value="">请选择</option>${FUNDING_PURPOSES.map(p => option(p.code, p.label, use.purpose)).join('')}</select></div>${money(`use_amount_${i}`, '拟使用金额', use.amount)}${note(`use_target_${i}`, '涉及项目 / 投资标的 / 基金', use.target, '可填写名称、主体或尚待确定的安排')}${note(`use_details_${i}`, '具体安排', use.details, '分别说明拟使用金额、计划和相关依据。')}</div><p class="field-hint" data-purpose-hint="${i}">${esc(purposeHint(use.purpose))}</p><button type="button" class="text-button" data-remove-purpose="${i}">删除此用途</button></section>`).join('');
}
export function targetReportingRows(periods: TargetReportingPeriod[] = []) {
  return periods.map((period, i) => `<section class="target-period-row" aria-label="本次目标报告期 ${i + 1}"><h3>目标报告期 ${i + 1}</h3><div class="update-grid">
    <div class="update-field"><label for="target_period_start_${i}">起始日</label><input type="date" id="target_period_start_${i}" name="target_period_start_${i}" value="${esc(period.start)}"></div>
    <div class="update-field"><label for="target_period_end_${i}">截止日</label><input type="date" id="target_period_end_${i}" name="target_period_end_${i}" value="${esc(period.end)}"></div>
    <div class="update-field"><label for="target_period_kind_${i}">期间类型</label><select id="target_period_kind_${i}" name="target_period_kind_${i}"><option value="">请选择</option>${option('annual', '年度', period.period_kind)}${option('interim', '中期', period.period_kind)}</select></div>
    <div class="update-field"><label for="target_period_scope_${i}">报表口径</label><select id="target_period_scope_${i}" name="target_period_scope_${i}"><option value="">请选择</option>${option('consolidated', '合并口径', period.scope)}${option('parent', '母公司口径', period.scope)}</select></div>
    <div class="update-field full"><label for="target_period_status_${i}">填写状态</label><select id="target_period_status_${i}" name="target_period_status_${i}" data-target-period-status="${i}"><option value="user_asserted"${period.status === 'user_asserted' && period.start && period.end && period.period_kind && period.scope ? ' selected' : ''}>我填写，待来源核对</option><option value="needs_confirmation"${!period.start || !period.end || !period.period_kind || !period.scope || period.status !== 'user_asserted' ? ' selected' : ''}>仍需人工确认</option></select><small>“我填写，待来源核对”仅表示用户陈述；两种状态都不是审计事实或已核验期间。</small></div>
  </div><button type="button" class="text-button" data-remove-target-period="${i}">删除此目标报告期</button></section>`).join('');
}
function purposeHint(purpose: UpdateDetails['funding_uses'][number]['purpose']) { return FUNDING_PURPOSES.find(p => p.code === purpose)?.materials ?? '用途未定可留空，已确定的安排可以先填写。'; }
export function updateFormFields(value: ProjectCreate) {
  const d = value.update_details!;
  return `<section class="update-section"><h2>是否有本发行人的历史募集书？</h2><div class="history-answer">${[['yes', '有', true], ['no', '没有', false]].map(([key, label, state]) => `<label class="history-choice"><input type="radio" name="has_historical" value="${key}"${d.has_historical === state ? ' checked' : ''}>${label}</label>`).join('')}</div></section>
  <section class="update-section"><h2>项目基本信息</h2><p class="field-hint">填写本次拟更新的目标；历史稿信息将在提供材料后单独核对。尚未确定的信息可留空保存。</p><div class="update-grid">
    <div class="update-field"><label for="name">项目名称 <span class="required">必填</span></label><input id="name" name="name" required maxlength="${PROJECT_FIELD_LIMITS.name}" value="${esc(value.name)}" placeholder="例如：发行人 2026 年募集书更新"></div>
    <div class="update-field"><label for="issuer">发行人全称</label><input id="issuer" name="issuer" maxlength="${PROJECT_FIELD_LIMITS.issuer}" value="${esc(value.issuer_name)}" placeholder="填写发行人法定全称"></div>
    <div class="update-field"><label for="market">发行市场</label><select id="market" name="market"><option value="">请选择</option>${MARKETS.map(m => option(m, MARKET_LABELS[m], value.market)).join('')}</select></div>
    <div class="update-field"><label for="offering">发行方式</label><select id="offering" name="offering"${!value.market ? ' disabled' : ''}>${offeringOptions(value)}</select></div>
    <div class="update-field"><label for="reporting_cutoff">本次财务截止日</label><input type="date" id="reporting_cutoff" name="reporting_cutoff" value="${esc(d.reporting_cutoff)}"><small>填写本次拟更新到的时点；需覆盖的完整期间在下方逐项填写。</small></div></div><p id="market-notice" class="field-hint" role="status"></p></section>
  <section class="update-section target-periods-section"><h2>本次目标报告期间 <span class="optional">选填，可添加多期</span></h2><p class="field-hint">这里填写本次更新目标，与历史募集书识别出的原稿期间分开保存。用户填写不代表来源已核对，也不代表审计确认；不确定的日期、类型或口径请保留“仍需人工确认”。</p><div id="target-reporting-period-rows">${targetReportingRows(d.target_reporting_periods ?? [])}</div><button type="button" id="add-target-reporting-period" class="button secondary"${(d.target_reporting_periods?.length ?? 0) >= TARGET_PERIOD_LIMIT ? ' disabled' : ''}>＋ 添加目标报告期间</button><small class="period-limit-note">最多 ${TARGET_PERIOD_LIMIT} 项；完整、部分填写和待确认期间都会保留。</small></section>
  <section class="update-section"><h2>发行规模与债券安排 <span class="optional">选填</span></h2><p class="field-hint">不同品种的期限、含权条款和用途会影响募集书多个章节。如有多个品种，请分别说明。</p><div class="update-grid">${money('registration_amount', '申报 / 注册总额', d.registration_amount)}${money('issuance_amount', '本期发行规模', d.issuance_amount)}${note('bond_terms', '债券安排', d.bond_terms, '例如：本期拟发行不超过10亿元，3年期。如有多个品种，请分别说明金额、期限、利率方式、还本付息、回售 / 赎回 / 调息、增信和用途差异及回拨安排。未确定的内容可注明待定。')}</div></section>
  <section class="update-section"><h2>参与机构 <span class="optional">选填</span></h2><p class="field-hint">仅一家主承销商时填名称即可；多家参与时再说明牵头、联席及其他分工，未定角色可留空。</p>${note('underwriting', '承销安排', d.underwriting, '例如：XX证券担任主承销商。或：XX证券牵头、YY银行联席，XX证券兼任簿记管理人。')}${note('other_agencies', '其他参与机构与分工', d.other_agencies, '如受托管理人、会计师事务所、律师事务所等。')}</section>
  <section class="update-section"><h2>评级与增信 <span class="optional">选填</span></h2><p class="field-hint">分清主体、债项、保证人评级；未确定可留空，后续提供评级或担保资料。</p>${note('rating_enhancement', '评级与增信安排', d.rating_enhancement, '可填写评级对象、等级、评级机构、保证人、担保方式或抵质押物等已知信息。')}</section>
  <section class="update-section"><h2>募集资金用途 <span class="optional">选填</span></h2><p class="field-hint">可添加多种用途，分别填写金额和具体安排；用途未定也能保存。</p><div id="funding-rows">${fundingRows(d)}</div><button type="button" id="add-purpose" class="button secondary">＋ 添加资金用途</button></section>
  <section class="update-section"><h2>其他项目信息 <span class="optional">选填</span></h2>${note('other_information', '其他已知信息', d.other_information, '例如：公司名称变更、银行授信额度及使用情况；相关材料可后续补充。')}</section>`;
}
export function supplementaryPanel(value: ProjectCreate, formId?: string) {
  return `<aside class="panel project-cowork supplement-panel" aria-label="项目协作"><div class="cowork-heading">${icon('chat')}<div><h2>一起完成这个项目</h2><p>额外信息和修改要求，可以在这里补充。</p></div></div>
    <div class="cowork-context"><span id="cowork-issuer">${esc(value.issuer_name || '待填写发行人')}</span><strong id="cowork-scope">${value.market ? esc(MARKET_LABELS[value.market]) : '发行市场待选择'} · ${value.offering ? esc(OFFERING_LABELS[value.offering]) : '发行方式待选择'}</strong><small>补充与材料保存在同一项目</small></div>
    <div class="cowork-messages"><p class="cowork-assistant">我们会结合材料更新整份募集书。表单之外的授信情况、业务变化或具体修改要求，可以在这里补充。</p></div>
    <div class="cowork-prompts">${['授信情况','修改要求','补充信息'].map(label => `<button type="button" data-note-example="${label}">${label}</button>`).join('')}</div><div class="cowork-composer"><label for="supplementary_notes">补充说明与写作要求</label><textarea id="supplementary_notes" name="supplementary_notes" ${formId ? `form="${formId}"` : ''} maxlength="${PROJECT_FIELD_LIMITS.notes}" placeholder="例如：补充授信额度的截至日、使用情况或本次需要关注的业务变化。">${esc(value.update_details!.supplementary_notes)}</textarea>${formId ? `<button class="btn primary cowork-save" type="submit" form="${formId}">保存补充说明 ${icon('send')}</button>` : ''}
    <p class="cowork-footnote">${formId ? '内容随项目自动保存；运行中的任务保持原版本，新修改用于下一轮。' : '创建项目时一并保存。'}当前可保存说明，助手多轮回复尚未接通。</p></div>
    <details class="cowork-materials"><summary>可提前准备的材料</summary><ul id="material-hints">${materialHints(value.update_details!).map(h => `<li>${esc(h)}</li>`).join('')}</ul><p id="dfi-material-hint" class="field-hint"${value.offering === 'dfi' ? '' : ' hidden'}>如已取得，可提供注册通知、注册申报文件、分期发行计划及承销商团安排；未取得的文件可后续补充。</p></details></aside>`;
}

function text(data: FormData, name: string) { return String(data.get(name) ?? '').trim() || null; }
function readMoney(data: FormData, name: string): Money | null {
  const value = text(data, name);
  return value === null ? null : { value, unit: data.get(`${name}_unit`) as Money['unit'] };
}
export function readTargetReportingPeriods(data: Pick<FormData, 'get'>, rowCount: number): TargetReportingPeriod[] {
  return Array.from({ length: rowCount }, (_, i) => {
    const start = String(data.get(`target_period_start_${i}`) ?? '').trim() || null;
    const end = String(data.get(`target_period_end_${i}`) ?? '').trim() || null;
    const period_kind = (String(data.get(`target_period_kind_${i}`) ?? '') || null) as TargetReportingPeriod['period_kind'];
    const scope = (String(data.get(`target_period_scope_${i}`) ?? '') || null) as TargetReportingPeriod['scope'];
    const complete = Boolean(start && end && period_kind && scope);
    const selectedStatus = data.get(`target_period_status_${i}`) === 'user_asserted' ? 'user_asserted' : 'needs_confirmation';
    return { start, end, period_kind, scope, status: complete ? selectedStatus : 'needs_confirmation', evidence_refs: [] };
  });
}
export function readUpdateForm(form: HTMLFormElement): ProjectCreate {
  const data = new FormData(form);
  const targetRows = form.querySelectorAll('[data-remove-target-period]');
  return { kind: 'update', name: String(data.get('name') ?? ''), issuer_name: text(data, 'issuer'), market: marketValue(String(data.get('market') ?? '')), offering: text(data, 'offering') as Offering | null,
    update_details: {
      has_historical: data.get('has_historical') === 'yes' ? true : data.get('has_historical') === 'no' ? false : null,
      reporting_cutoff: text(data, 'reporting_cutoff'), target_reporting_periods: readTargetReportingPeriods(data, targetRows.length), registration_amount: readMoney(data, 'registration_amount'), issuance_amount: readMoney(data, 'issuance_amount'),
      bond_terms: text(data, 'bond_terms'), underwriting: text(data, 'underwriting'), other_agencies: text(data, 'other_agencies'), rating_enhancement: text(data, 'rating_enhancement'),
      funding_uses: [...form.querySelectorAll('[data-purpose]')].map((_, i) => ({ purpose: text(data, `purpose_${i}`) as UpdateDetails['funding_uses'][number]['purpose'], amount: readMoney(data, `use_amount_${i}`), details: text(data, `use_details_${i}`), target: text(data, `use_target_${i}`) })),
      other_information: text(data, 'other_information'), supplementary_notes: text(data, 'supplementary_notes')
    }
  };
}
export function bindUpdateForm(form: HTMLFormElement, changed: (value: ProjectCreate) => void) {
  const emit = () => {
    const value = readUpdateForm(form);
    const issuer = document.querySelector('#cowork-issuer'); if (issuer) issuer.textContent = value.issuer_name || '待填写发行人';
    const scope = document.querySelector('#cowork-scope'); if (scope) scope.textContent = `${value.market ? MARKET_LABELS[value.market] : '发行市场待选择'} · ${value.offering ? OFFERING_LABELS[value.offering] : '发行方式待选择'}`;
    changed(value);
  };
  document.querySelectorAll<HTMLButtonElement>('[data-note-example]').forEach(button => button.addEventListener('click', () => {
    const textarea = document.querySelector<HTMLTextAreaElement>('#supplementary_notes')!;
    const hints: Record<string,string> = { '授信情况':'请补充授信截至日、总额度、已使用和未使用额度，以及金额单位与依据。', '修改要求':'请说明希望调整的内容、原因和可参考的材料。', '补充信息':'可补充本次项目的业务变化、机构安排或其他已知情况。' };
    textarea.placeholder = hints[button.dataset.noteExample!]; textarea.focus();
  }));
  const supplement = document.querySelector<HTMLTextAreaElement>(`textarea[form="${form.id}"]`);
  supplement?.addEventListener('input', event => { if (!(event as InputEvent).isComposing) emit(); });
  supplement?.addEventListener('compositionend', emit);
  const enforceIncompletePeriods = () => {
    const details = readUpdateForm(form).update_details!;
    details.target_reporting_periods?.forEach((period, i) => {
      if (!period.start || !period.end || !period.period_kind || !period.scope) {
        const status = form.querySelector<HTMLSelectElement>(`[data-target-period-status="${i}"]`);
        if (status) status.value = 'needs_confirmation';
      }
    });
  };
  form.addEventListener('input', event => { if (!(event as InputEvent).isComposing) { enforceIncompletePeriods(); emit(); } });
  form.addEventListener('compositionend', () => { enforceIncompletePeriods(); emit(); });
  form.addEventListener('change', event => {
    const target = event.target as HTMLInputElement;
    if (target.name === 'market') {
      const result = changeMarket(readUpdateForm(form), marketValue(target.value));
      const select = form.querySelector<HTMLSelectElement>('#offering')!;
      select.innerHTML = offeringOptions(result.draft); select.disabled = !result.draft.market;
      form.querySelector('#market-notice')!.textContent = result.cleared ? '发行市场已更改，请重新选择适用的发行方式；其他填写内容已保留。' : '发行市场已更改，其他填写内容已保留。';
    }
    enforceIncompletePeriods();
    const value = readUpdateForm(form);
    document.querySelector('#material-hints')!.innerHTML = materialHints(value.update_details!).map(h => `<li>${esc(h)}</li>`).join('');
    document.querySelector<HTMLElement>('#dfi-material-hint')!.hidden = value.offering !== 'dfi';
    if (target.hasAttribute('data-purpose')) form.querySelector(`[data-purpose-hint="${target.dataset.purpose}"]`)!.textContent = purposeHint(target.value as UpdateDetails['funding_uses'][number]['purpose']);
    emit();
  });
  form.addEventListener('click', event => {
    const target = (event.target as HTMLElement).closest<HTMLButtonElement>('#add-purpose, [data-remove-purpose], #add-target-reporting-period, [data-remove-target-period]');
    if (!target) return;
    const details = readUpdateForm(form).update_details!;
    if (target.id === 'add-target-reporting-period') {
      const periods = details.target_reporting_periods ?? [];
      if (periods.length >= TARGET_PERIOD_LIMIT) return;
      periods.push({ start: null, end: null, period_kind: null, scope: null, status: 'needs_confirmation', evidence_refs: [] });
      details.target_reporting_periods = periods;
      form.querySelector('#target-reporting-period-rows')!.innerHTML = targetReportingRows(periods);
      form.querySelector<HTMLButtonElement>('#add-target-reporting-period')!.disabled = periods.length >= TARGET_PERIOD_LIMIT;
    }
    else if (target.hasAttribute('data-remove-target-period')) {
      if (!window.confirm('确定删除这一项目标报告期间及已填写的信息吗？')) return;
      details.target_reporting_periods?.splice(Number(target.dataset.removeTargetPeriod), 1);
      form.querySelector('#target-reporting-period-rows')!.innerHTML = targetReportingRows(details.target_reporting_periods);
      form.querySelector<HTMLButtonElement>('#add-target-reporting-period')!.disabled = (details.target_reporting_periods?.length ?? 0) >= TARGET_PERIOD_LIMIT;
    }
    else if (target.id === 'add-purpose') { if (details.funding_uses.length >= PROJECT_FIELD_LIMITS.fundingUses) return; details.funding_uses.push({ purpose: null, amount: null, details: null, target: null }); }
    else if (target.hasAttribute('data-remove-purpose')) {
      if (!window.confirm('确定删除这一项资金用途及已填写的信息吗？')) return;
      details.funding_uses.splice(Number(target.dataset.removePurpose), 1);
    } else return;
    if (target.id !== 'add-target-reporting-period') {
      if (target.id === 'add-purpose' || target.hasAttribute('data-remove-purpose')) {
        form.querySelector('#funding-rows')!.innerHTML = fundingRows(details);
        form.querySelector<HTMLButtonElement>('#add-purpose')!.disabled = details.funding_uses.length >= PROJECT_FIELD_LIMITS.fundingUses;
      }
    }
    emit();
  });
}
