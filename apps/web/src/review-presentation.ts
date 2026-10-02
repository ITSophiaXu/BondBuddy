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

export function evidenceHtml(refs: ReviewEvidenceRef[], empty: string, names:Record<string,string>={}): string {
  return refs.length ? refs.map(ref => `<blockquote class="review-source"><p>${esc(ref.quote)}</p><footer title="${esc(ref.material_id)}">${esc(names[ref.material_id]??ref.material_id)} · V${ref.material_version}<br>${esc(sourceLocator(ref))}</footer>${ref.uncertainty.length ? `<p class="review-warning">${ref.uncertainty.map(esc).join('；')}</p>` : ''}</blockquote>`).join('') : `<p class="review-muted">${esc(empty)}</p>`;
}

export function rulesHtml(finding: ReviewFinding): string {
  return (finding.rule_refs ?? []).map(rule => {
    let url: URL | undefined;
    try { if (rule.url) { const parsed = new URL(rule.url); if (['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password) url = parsed; } } catch { /* Do not turn malformed model URLs into links. */ }
    const label = rule.authority === 'regulatory' ? '监管依据' : rule.authority === 'template' ? '模板要求' : '核对方法';
    return `<blockquote class="review-source"><span class="review-tag">${label}</span><p>${esc(rule.quote)}</p><footer>${esc(rule.rule_id)} · ${esc(rule.rule_version)} · ${esc(rule.locator)}<br>${rule.effective_from ? `生效 ${esc(rule.effective_from)}` : '生效日期待核'}${rule.effective_to ? `，至 ${esc(rule.effective_to)}` : ''}${url ? ` · <a href="${esc(url.href)}" target="_blank" rel="noopener noreferrer">查看来源 ↗</a>` : ''}</footer></blockquote>`;
  }).join('');
}

export function findingHtml(finding: ReviewFinding, selected: boolean, names:Record<string,string>={}): string {
  return `<details class="review-finding" data-finding-id="${esc(finding.finding_id)}"><summary><span class="review-severity ${finding.severity.toLowerCase()}">${esc(finding.severity)}</span><span class="review-finding-copy"><strong>${esc(finding.title)}</strong><small>${esc(finding.finding_id)} · ${dimensionLabels[finding.dimension]} · ${conclusionLabels[finding.conclusion]} · ${checkLabels[finding.check_status]}${finding.check_status === 'carried_forward' ? `（${esc(finding.origin_report_id)}）` : ''}</small></span><span aria-hidden="true">⌄</span></summary>
    <div class="review-finding-body"><p>${esc(finding.description)}</p><div class="review-evidence-grid"><section><h4>募集书原文</h4>${evidenceHtml(finding.target_refs, '原文定位暂不可用；此项保留在报告中。',names)}</section><section><h4>对照依据</h4>${evidenceHtml(finding.evidence_refs, '尚无可核实的材料证据。',names)}${rulesHtml(finding)}</section></div>
    ${finding.calculation ? `<p class="review-calculation"><strong>计算依据</strong> ${esc(finding.calculation.expression)}<br>原值 ${esc(finding.calculation.observed)} · 复算 ${esc(finding.calculation.expected)} ${esc(finding.calculation.unit)} · ${esc(finding.calculation.rounding)}</p>` : ''}
    ${finding.suggested_change ? `<p><strong>建议</strong> ${esc(finding.suggested_change)}</p>` : ''}${finding.limitations.length ? `<p class="review-warning">${finding.limitations.map(esc).join('；')}</p>` : ''}
    <div class="review-finding-actions"><button class="btn secondary small" data-review-action="explain">查看解释</button><button class="btn secondary small" data-review-action="evidence">补充材料</button>${finding.repairability.can_revise ? `<label class="review-selection"><input type="checkbox" data-review-select="${esc(finding.finding_id)}" ${selected ? 'checked' : ''}>加入修订</label>` : `<span class="review-muted">${esc(finding.repairability.reason)}</span>`}<button class="text-btn" data-review-action="discuss">继续讨论此项</button><button class="text-btn" data-review-action="dispute">提出异议</button></div></div></details>`;
}

export function reportSummary(report: ReviewReport): string {
  const urgent = report.findings.filter(f => f.severity === 'P1').length;
  const rechecked = report.coverage.filter(c => c.check_status === 'rechecked');
  const unverified = rechecked.filter(c => ['uncovered', 'manual', 'needs_evidence'].includes(c.outcome)).length;
  return `<section class="review-result-hero"><p class="review-kicker">REVIEW SUMMARY · ${esc(report.report_id)} · V${report.version}</p><h2>${report.scope.mode === 'differential_review' ? '差异复核结果' : '复核结果'}，${report.findings.length} 项发现。</h2><p class="review-muted">${urgent ? `${urgent} 项需优先关注。` : ''}发现问题与任务失败分别记录；未发现问题不代表保证合规。</p><div class="review-metrics">${[[report.findings.length,'复核发现'],[urgent,'高优先级'],[report.findings.filter(f=>f.repairability.can_revise).length,'可选择修订'],[unverified,'本轮待核／未覆盖']].map(([count,label])=>`<div><strong>${count}</strong><span>${label}</span></div>`).join('')}</div></section>
    <div class="review-coverage">${Object.entries(dimensionLabels).map(([key,label])=>{const checks=report.coverage.filter(c=>c.dimension===key);const current=checks.filter(c=>c.check_status==='rechecked');return `<button class="review-coverage-item" data-review-coverage="${key}"><strong>${label}</strong><span>${checks.length?`本轮 ${current.length} 项 · 沿用 ${checks.length-current.length} 项`:'尚无检查记录'}</span><small>${checks.length?`${current.filter(c=>['uncovered','manual','needs_evidence'].includes(c.outcome)).length} 项待核／未覆盖`:'不能据此认定已通过'}</small></button>`;}).join('')}</div>${report.limitations.length ? `<div class="review-notice">${report.limitations.map(esc).join('；')}</div>` : ''}`;
}
