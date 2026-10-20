import { esc, date } from '../ui';
import { prototypeIcon as ico } from '../prototype-design';
import { REVIEW_SCOPE, reviewText } from './review-model';
import { fileTime } from './file-management-view';
import { fileDownloadButton } from './file-download';
import type { Project, Job } from './model';

export function reviewScopeDesign() {
  return `<section class="pd-review-scope"><h2>本次复核范围</h2><div class="pd-scope-grid">${REVIEW_SCOPE.map(([title, description], i) => `<article><span>0${i + 1}</span><h3>${title}</h3><p>${description}</p></article>`).join('')}</div><div class="pd-inline-note">${ico('review')}<p>有依据的修改写入修订版，保留增删痕迹和解释批注；不确定内容保留原文并标注待补材料。完成后下载 Word 审阅。</p></div></section>`;
}
export function reviewResultDesign(p: Project, job: Job, jobs: Job[]) {
  const snapshot = job.review!, decisions = job.reviewDecisions ?? {};
  const files = p.files.filter(f => job.fileIds.includes(f.id) && f.review);
  const source = files[0];
  const changes = snapshot.issues.filter(i => reviewText(i, decisions) !== i.original).length;
  const pending = snapshot.issues.filter(i => i.uncertain).length;
  return `<div class="pd-section-head"><div><h2>复核结果 <span class="pd-chip amber">设计示例</span></h2><p class="muted">${esc(source?.sourceName ?? '')} · 基准 v${source?.sourceVersion ?? '—'} · ${esc(date(job.createdAt))}</p></div><label>版本记录<select id="work-job">${jobs.map((j, i) => `<option value="${j.id}" ${j.id === job.id ? 'selected' : ''}>第 ${jobs.length - i} 轮 · ${esc(date(j.createdAt))}</option>`).join('')}</select></label></div>
  <div class="pd-delivery-hero">${ico('check')}<div><span class="eyebrow">READY TO DOWNLOAD</span><h2>复核完成，下载修订版审阅</h2><p>修改痕迹、解释批注和待确认事项均保存在 Word 中。</p></div><span class="pd-chip">已完成 · 示例</span></div>
  <div class="pd-review-summary"><div><b>${changes}</b><span>处原文修订</span></div><div><b>${snapshot.issues.length}</b><span>条解释批注</span></div><div><b>${pending}</b><span>项待人工确认</span></div><p>下载修订版，在 Word 中查看修改与批注；完成审阅后可上传新版本。</p></div>
  <div class="pd-delivery-cards">${files.map(f => `<article class="pd-delivery-card"><span class="pd-file-icon">${ico('file')}</span><div class="pd-grow"><h3>${f.type === 'review-clean' ? '清洁版' : '修订版'}</h3><strong>${esc(f.name)}</strong><p>${f.type === 'review-clean' ? '移除修订痕迹与批注，保留待补材料提示。' : '保留增删痕迹、修改原因和待确认批注。'}</p><span class="pd-chip">v${f.version}</span>${fileTime(f)}</div>${fileDownloadButton(f, f.type === 'review-clean' ? 'btn secondary' : 'btn primary')}</article>`).join('')}</div>
  <p class="pd-note">本轮为合成 Word 示例，未解析或修改上传文件。历史版本和此前保存的修改选择均保留。</p>
  <div class="pd-footer"><button class="btn secondary" data-consistency-start data-project="${p.id}" data-from-job="${job.id}">检查文件一致性</button><div class="pd-actions"><a class="btn secondary" href="#review?project=${p.id}&step=materials">准备下一轮</a><a class="btn primary" href="#/projects/${p.id}/files?folder=2">项目文件 ${ico('arrow')}</a></div></div>`;
}
