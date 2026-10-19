import { esc } from '../ui';
import { INTEGRITY_SITES, integrityDraft, type IntegritySnapshot, type IntegrityRecord } from './integrity';
import type { Project } from './model';

const portalLinks = (site: IntegritySnapshot['sites'][number]) => site.links.map(l => `<a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(l.label)} ↗</a>`).join(' · ');
export function websiteScope(p: Project) {
  const draft = integrityDraft(p);
  return `<section class="pd-panel pd-site-panel"><div class="pd-section-head"><div><h2>查询网站范围 <span class="pd-count" id="site-count">${draft.siteIds.length} / ${INTEGRITY_SITES.length}</span></h2><p class="muted">按下列网站准备本轮查询与取证，网站范围随核查批次保留。</p></div><div class="pd-actions"><button class="btn secondary" data-action="sites-all">全选网站</button><button class="btn secondary" data-action="sites-none">清空网站</button></div></div>
  ${[...new Set(INTEGRITY_SITES.map(s => s.group))].map(group => `<div class="pd-site-group"><h3>${group}</h3><div class="pd-site-grid">${INTEGRITY_SITES.filter(s => s.group === group).map(s => `<article class="pd-site-card"><label><input type="checkbox" name="integrity-site" value="${s.id}" ${draft.siteIds.includes(s.id) ? 'checked' : ''}><strong>${s.name}</strong></label><p>${s.topic}</p><div class="pd-site-meta"><span>${s.companyOnly ? '企业' : '企业 / 人员 · 按查询条件'}</span>${portalLinks(s)}</div></article>`).join('')}</div></div>`).join('')}
  <p class="pd-note">人员查询需核对同名信息；企业登记网站不用于人员查询。实际查询遇到登录、验证码或访问失败时，保留待核实状态并提示处理。</p></section>`;
}
export function integrityTotals(p: Project) {
  return `${p.draft.subjects.filter(s => s.kind === 'company').length} 家企业 · ${p.draft.subjects.filter(s => s.kind === 'person').length} 名人员 · ${integrityDraft(p).siteIds.length} 个网站`;
}
export function queryRecords(snapshot: IntegritySnapshot, jobId?: string) {
  return `<div class="pd-query-summary"><strong>${snapshot.subjects.length} 个对象 · ${snapshot.sites.length} 个网站</strong><span class="pd-chip amber">${snapshot.records.filter(r => r.status === 'pending').length} 项待核实</span><small>名单、查询条件、网站与说明均为本批次快照。后续编辑不改变本轮记录。</small></div>${snapshot.subjects.map((subject, index) => `<details class="pd-query-subject" ${index === 0 ? 'open' : ''}><summary><span><strong>${esc(subject.name)}</strong><small>${esc(subject.role)} · ${subject.kind === 'company' ? '企业' : '人员'}</small></span><span class="pd-chip amber">未执行检索</span></summary><div class="pd-table-wrap"><table class="pd-table pd-integrity-table"><thead><tr><th>核查网站 / 查询条件</th><th>查询状态</th><th>取证记录</th></tr></thead><tbody>${snapshot.records.filter(r => r.subjectId === subject.id).map(r => {
    const site = snapshot.sites.find(s => s.id === r.siteId)!;
    return `<tr><td><strong>${esc(site.name)}</strong><small>${esc(r.condition)}</small></td><td><span class="pd-chip ${r.status === 'pending' ? 'amber' : ''}">${r.status === 'pending' ? '未执行 · 待核实' : '不适用'}</span><small>${esc(r.note)}</small></td><td>${jobId ? `<button class="text-button" data-action="evidence" data-job="${esc(jobId)}" data-record="${snapshot.records.indexOf(r)}">查看取证记录</button>` : `<small>查询时间：未执行<br>截图：${r.status === 'pending' ? '待采集' : '不适用'}</small>`}</td></tr>`;
  }).join('')}</tbody></table></div></details>`).join('')}`;
}
export function evidenceContent(snapshot: IntegritySnapshot, record: IntegrityRecord) {
  const site = snapshot.sites.find(s => s.id === record.siteId)!;
  return `<p class="pd-note">取证结构预览 · 本轮没有访问外部查询网站。</p><dl class="pd-evidence-facts"><dt>查询网站</dt><dd>${esc(site.name)}<br>${portalLinks(site)}</dd><dt>查询条件</dt><dd>${esc(record.condition)}</dd><dt>查询时间</dt><dd>未执行检索</dd><dt>结果及说明</dt><dd>${record.status === 'pending' ? '待核实' : '不适用'} · ${esc(record.note)}</dd></dl><div class="pd-evidence-placeholder"><strong>原始查询页面截图</strong><p>${record.status === 'pending' ? '待采集 · 尚无证据附件' : '本对象不适用该查询入口'}</p><small>正式底稿将在此附查询网址、时间、条件和原始截图。</small></div>`;
}
export function integrityDocument(snapshot: IntegritySnapshot) {
  return `<h3>一、核查范围及汇总清单</h3>${queryRecords(snapshot)}<h3>二、查询网站及取证索引</h3><ol class="pd-evidence-index">${snapshot.sites.map(s => `<li><strong>${esc(s.name)}</strong> · ${portalLinks(s)}<small>实际查询网址、查询时间及原始截图：未采集</small></li>`).join('')}</ol><h3>三、核查说明与待办</h3><p>${esc(snapshot.notes || '未补充本轮说明。')}</p><p>本轮未执行真实网站检索，不能据此判断核查对象是否存在失信记录。需完成身份匹配、网站查询、截图取证和人工复核后形成结论。</p><h3>四、签字页</h3><p>项目组成员：____________　复核人：____________<br>日期：____________</p>`;
}
