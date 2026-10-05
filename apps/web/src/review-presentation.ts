import type { ReviewEvidenceRef, ReviewFinding, ReviewReport } from '@bondbuddy/contracts';
import { esc } from './ui.js';

export const dimensionLabels: Record<ReviewFinding['dimension'], string> = {
  financial: '财务数据', compliance: '合规与格式', public: '公开信息',
};
export const conclusionLabels: Record<ReviewFinding['conclusion'], string> = {
  error: '明确错误', conflict: '来源冲突', needs_evidence: '待补证', manual: '待人工判断', uncovered: '未覆盖',
};
export const checkLabels: Record<ReviewFinding['check_status'], string> = { rechecked: '本轮核验', carried_forward: '沿用先前结果' };

export function sourceLocator(ref: Pick<ReviewEvidenceRef, 'locator'>): string {
  const labels:Record<string,string>={page:'页码',page_number:'页码',paragraph:'段落',paragraph_index:'段落序号',block_index:'内容序号',table:'表格',table_index:'表格序号',row:'行',column:'列',sheet:'工作表',cell:'单元格',line:'行号',bbox:'页内位置',heading:'章节'};
  return Object.entries(ref.locator).map(([key, value]) => `${labels[key]??key}：${typeof value === 'object' ? JSON.stringify(value) : String(value)}`).join(' · ');
}

export function evidenceHtml(refs: ReviewEvidenceRef[], empty: string, names:Record<string,string>={}, interactive=false): string {
  return refs.length ? refs.map(ref => `<blockquote class="review-source"><p>${esc(ref.quote)}</p><footer title="${esc(ref.material_id)}">${interactive?`<button class="review-source-link" data-review-action="source" data-material-id="${esc(ref.material_id)}" data-material-version="${ref.material_version}" data-material-sha="${esc(ref.material_sha256)}">${esc(names[ref.material_id]??'引用材料')} · V${ref.material_version} · 查看原文 ↗</button>`:`${esc(names[ref.material_id]??ref.material_id)} · V${ref.material_version}`}<br>${esc(sourceLocator(ref))}</footer>${ref.uncertainty.length ? `<p class="review-warning">${ref.uncertainty.map(esc).join('；')}</p>` : ''}</blockquote>`).join('') : `<p class="review-muted">${esc(empty)}</p>`;
}

export function rulesHtml(finding: ReviewFinding): string {
  return (finding.rule_refs ?? []).map(rule => {
    let url: URL | undefined;
    try { if (rule.url) { const parsed = new URL(rule.url); if (['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password) url = parsed; } } catch { /* Do not turn malformed model URLs into links. */ }
    const label = rule.authority === 'regulatory' ? '监管依据' : rule.authority === 'template' ? '模板要求' : '核对方法';
    return `<blockquote class="review-source"><span class="review-tag">${label}</span><p>${esc(rule.quote)}</p><footer>${esc(rule.rule_id)} · ${esc(rule.rule_version)} · ${esc(rule.locator)}<br>${rule.effective_from ? `生效 ${esc(rule.effective_from)}` : '生效日期待核'}${rule.effective_to ? `，至 ${esc(rule.effective_to)}` : ''}${url ? ` · <a href="${esc(url.href)}" target="_blank" rel="noopener noreferrer">查看来源 ↗</a>` : ''}</footer></blockquote>`;
  }).join('');
}

export function findingHtml(finding: ReviewFinding, selected: boolean, names:Record<string,string>={}, running=false, originLabel='原报告'): string {
  return `<details class="review-finding ${running?'rechecking':''}" data-finding-id="${esc(finding.finding_id)}"><summary><span class="review-severity ${finding.severity.toLowerCase()}">${{P1:'高优先级',P2:'需关注',P3:'一般'}[finding.severity]}</span><span class="review-finding-copy"><strong>${esc(finding.title)}</strong><small>${esc(finding.finding_id)} · ${dimensionLabels[finding.dimension]} · ${conclusionLabels[finding.conclusion]} · ${running?'正在重新核验 · 原结论保留':checkLabels[finding.check_status]}${finding.check_status === 'carried_forward' ? `（沿用 ${esc(originLabel)}）` : ''}</small></span><span aria-hidden="true">⌄</span></summary>
    <div class="review-finding-body"><p>${esc(finding.description)}</p><div class="review-evidence-grid"><section><h4>募集书原文</h4>${evidenceHtml(finding.target_refs, '原文定位暂不可用；此项保留在报告中。',names,true)}</section><section><h4>对照依据</h4>${evidenceHtml(finding.evidence_refs, '尚无可核实的材料证据。',names,true)}${rulesHtml(finding)}</section></div>
    ${finding.calculation ? `<p class="review-calculation"><strong>计算依据</strong> ${esc(finding.calculation.expression)}<br>原值 ${esc(finding.calculation.observed)} · 复算 ${esc(finding.calculation.expected)} ${esc(finding.calculation.unit)} · ${esc(finding.calculation.rounding)}</p>` : ''}
    ${finding.suggested_change ? `<p><strong>建议</strong> ${esc(finding.suggested_change)}</p>` : ''}${finding.limitations.length ? `<p class="review-warning">${finding.limitations.map(esc).join('；')}</p>` : ''}
    <div class="review-finding-actions"><button class="btn secondary small" data-review-action="explain">查看解释</button>${finding.repairability.can_revise ? `<label class="review-selection"><input type="checkbox" data-review-select="${esc(finding.finding_id)}" ${selected ? 'checked' : ''}><span aria-hidden="true">${selected?'✓':'＋'}</span>加入修订</label>` : ''}<button class="btn secondary small" data-review-action="evidence">补充材料</button>${finding.dimension==='financial'&&['manual','needs_evidence','conflict'].includes(finding.conclusion)?'<button class="text-btn" data-review-action="discuss">说明口径</button>':''}<button class="text-btn" data-review-action="discuss">补充复核要求</button><button class="text-btn" data-review-action="recheck">重新核验此项</button><button class="text-btn" data-review-action="dispute">提出异议</button>${!finding.repairability.can_revise?`<span class="review-muted review-repair-reason">${esc(finding.repairability.reason)}</span>`:''}</div></div></details>`;
}

export function followUpHtml(report:ReviewReport, reportNames:Record<string,string>={}):string {
  if(report.scope.mode!=='differential_review')return '';
  const follow=report.follow_up;
  if(!follow)return '<p class="review-warning">此历史差异报告未记录逐项来源关联；不能因旧问题未出现就认定已解决。</p>';
  const statusLabels={rechecked:'本轮已重新核验',carried_forward:'沿用原报告',uncompleted:'本轮未完成／未覆盖'};
  const outcomeLabels:Record<string,string>={issue:'仍有问题',resolved:'已核验解决',needs_evidence:'待补证',manual:'待人工判断',uncovered:'未覆盖',carried_forward:'保留原结论'};
  return `<section class="review-follow-up"><h3>本轮结果与沿用范围</h3><p class="review-muted">差异复核仅统计本轮实际检查；沿用项不是本轮通过。</p>${(['rechecked','uncompleted','carried_forward'] as const).map(status=>{const items=follow.findings.filter(item=>item.status===status);return items.length?`<details ${status!=='carried_forward'?'open':''} class="review-follow-up-group ${status}"><summary>${statusLabels[status]} · ${items.length} 项</summary>${items.map(item=>`<div class="review-follow-up-item" data-source-finding="${esc(item.source_finding_id)}"><strong>${outcomeLabels[item.outcome]}</strong><button class="text-btn" data-review-action="report" data-report-id="${esc(follow.source_report_id)}" data-finding-id="${esc(item.source_finding_id)}">${esc(item.source_finding_id)} · 来源 ${esc(reportNames[follow.source_report_id]??'原报告')}</button><p>${esc(item.reason)}</p>${item.current_finding_ids.map(id=>`<button class="text-btn" data-review-action="report" data-report-id="${esc(report.report_id)}" data-finding-id="${esc(id)}">查看本轮 ${esc(id)}</button>`).join('')}</div>`).join('')}</details>`:'';}).join('')}</section>`;
}

export function reportSummary(report: ReviewReport): string {
  const urgent = report.findings.filter(f => ['P1','P2'].includes(f.severity)).length;
  const rechecked = report.coverage.filter(c => c.check_status === 'rechecked');
  const unverified = rechecked.filter(c => ['uncovered', 'manual', 'needs_evidence'].includes(c.outcome)).length;
  return `<section class="review-result-hero"><p class="review-kicker" title="${esc(report.report_id)}">REVIEW SUMMARY · R${report.version}</p><h2>${report.scope.mode === 'differential_review' ? '差异复核完成' : '复核完成'}，${urgent?`${urgent} 项需要优先关注。`:`${report.findings.length} 项复核发现。`}</h2><p class="review-muted">先查看问题与依据，再决定补充材料或安排修订。${unverified?`本轮仍有 ${unverified} 项检查待核／未覆盖。`:'请结合检查范围阅读结论。'}</p><div class="review-metrics">${[[report.findings.length,'复核发现'],[urgent,'优先关注'],[report.findings.filter(f=>f.repairability.can_revise).length,'具备修订依据'],[report.findings.filter(f=>['conflict','needs_evidence','manual','uncovered'].includes(f.conclusion)).length,'待确认／补证']].map(([count,label])=>`<div><strong>${count}<small>项</small></strong><span>${label}</span></div>`).join('')}</div></section>
    <div class="review-coverage">${Object.entries(dimensionLabels).map(([key,label])=>{const checks=report.coverage.filter(c=>c.dimension===key);const current=checks.filter(c=>c.check_status==='rechecked');const pending=current.filter(c=>['uncovered','manual','needs_evidence'].includes(c.outcome)).length;return `<button class="review-coverage-item" data-review-coverage="${key}"><strong>${label}</strong><span>${checks.length?`本轮 ${current.length} · 沿用 ${checks.length-current.length}`:'暂无记录'}</span><small>${checks.length?`${pending?`${pending} 项待核／未覆盖`:'查看检查范围'} · ${report.findings.filter(f=>f.dimension===key).length} 项发现`:'尚无检查记录，不能认定已通过'}</small></button>`;}).join('')}</div>${report.limitations.length ? `<details class="review-report-limitations"><summary>范围与限制 <span>${report.limitations.length} 项</span></summary><ul>${report.limitations.map(item=>`<li>${esc(item)}</li>`).join('')}</ul></details>` : ''}`;
}
