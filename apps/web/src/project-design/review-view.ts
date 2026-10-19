import { esc, date } from '../ui';
import { prototypeIcon as ico } from '../prototype-design';
import { REVIEW_SCOPE, reviewText, reviewParagraphs, type ReviewSnapshot, type ReviewDecisions } from './review-model';
import { downloadWord } from './word-export';
import type { Project, Job, DesignState } from './model';
export function reviewScopeDesign() {
  return `<section class="pd-review-scope"><h2>本次复核范围</h2><div class="pd-scope-grid">${REVIEW_SCOPE.map(([title, description], i) => `<article><span>0${i + 1}</span><h3>${title}</h3><p>${description}</p></article>`).join('')}</div><div class="pd-inline-note">${ico('review')}<p>有依据的修改直接写回原文并保留修订痕迹；批注说明为什么修改。不确定的内容保留原文并添加待补材料批注。可下载修订版及清洁版。</p></div></section>`;
}
export function reviewDocument(snapshot: ReviewSnapshot, decisions: ReviewDecisions = {}, view = 'tracked') {
  return `<article class="pd-word-sheet"><div class="pd-word-watermark">募集说明书 · 合成片段预览</div><h2>${view === 'original' ? '原文' : view === 'clean' ? '清洁版' : '修订版'} · 示例节选</h2>${snapshot.issues.map((i, n) => {
    const text = reviewText(i, decisions), changed = text !== i.original;
    return `<section id="review-paragraph-${i.id}" class="pd-word-section"><small>${esc(i.location)}</small><p>${view === 'original' ? esc(i.original) : view === 'tracked' && changed ? `<del>${esc(i.original)}</del><ins>${esc(text)}</ins>` : esc(text)}</p>${view !== 'original' && i.uncertain ? `<p class="pd-word-missing">【待人工确认】需补充：${esc(i.missing ?? '')}</p>` : ''}${view === 'tracked' ? `<aside class="pd-word-comment"><b>批注 ${n + 1} · BondBuddy${i.uncertain ? ' · 待确认' : ''}</b><p>${esc(i.reason)}</p><small>依据：${esc(i.evidence)}</small>${decisions[i.id]?.mode === 'manual' ? '<small>用户已手动修改此段，依据仍需复核。</small>' : decisions[i.id]?.mode === 'original' ? '<small>用户选择保留原文，本条建议未采用。</small>' : ''}</aside>` : ''}</section>`;
  }).join('')}<p class="pd-note">设计示例，不是上传募集说明书的实际复核结果。清洁版移除修改痕迹与批注，仍保留未解决事项的材料提示。</p></article>`;
}
export function reviewResultDesign(p: Project, job: Job, jobs: Job[]) {
  const snapshot = job.review!, decisions = job.reviewDecisions ?? {}, source = p.files.find(f => job.fileIds.includes(f.id));
  const changes = snapshot.issues.filter(i => reviewText(i, decisions) !== i.original).length, pending = snapshot.issues.filter(i => i.uncertain).length;
  return `<div class="pd-section-head"><div><h2>复核与原文修订 <span class="pd-chip amber">设计示例</span></h2><p class="muted">${esc(source?.sourceName ?? '')} · v${source?.sourceVersion ?? ''} · ${esc(date(job.createdAt))}</p></div><label>版本记录<select id="work-job">${jobs.map((j, i) => `<option value="${j.id}" ${j.id === job.id ? 'selected' : ''}>第 ${jobs.length - i} 轮</option>`).join('')}</select></label></div>
  <div class="pd-review-summary"><div><b>${changes}</b><span>处原文修订</span></div><div><b>${snapshot.issues.length}</b><span>条解释批注</span></div><div><b>${pending}</b><span>项待人工确认</span></div><p>本轮展示合成示例。政策条款按市场适用，未经核实的判断保留批注。</p></div>
  <div class="pd-review-delivery"><div><strong>直接下载复核后的募集说明书</strong><small>修订版包含增删痕迹及解释批注；清洁版保留待补提示。</small></div><div class="pd-actions"><button class="btn primary" data-review-download="tracked">${ico('download')}下载修订版</button><button class="btn secondary" data-review-download="clean">下载清洁版</button><button class="btn secondary" data-consistency-start data-project="${p.id}" data-from-job="${job.id}">检查文件一致性</button></div></div>
  <div class="pd-review-editor"><aside class="pd-review-issues"><h3>修改与重点提示</h3>${snapshot.issues.map((i, n) => `<details class="pd-issue-card" ${i.uncertain || n === 0 || decisions[i.id] ? 'open' : ''}><summary><span class="pd-chip ${i.uncertain ? 'amber' : ''}">${i.uncertain ? '待确认' : i.group}</span><strong>${n + 1}. ${esc(i.title)}</strong></summary><p>${esc(i.reason)}</p><small>${esc(i.evidence)}</small>${i.missing ? `<p class="pd-word-missing">缺少：${esc(i.missing)}</p>` : ''}<label class="pd-field">原文处理方式<select data-review-choice="${i.id}"><option value="suggested" ${!decisions[i.id] || decisions[i.id].mode === 'suggested' ? 'selected' : ''}>${i.uncertain ? '保留原文，添加待确认批注' : '采用建议，保留修订痕迹'}</option><option value="original" ${decisions[i.id]?.mode === 'original' ? 'selected' : ''}>保留原文</option><option value="manual" ${decisions[i.id]?.mode === 'manual' ? 'selected' : ''}>我来手动修改</option></select></label>${decisions[i.id]?.mode === 'manual' ? `<label class="pd-field">手动修改正文<textarea rows="4" maxlength="5000" data-review-text="${i.id}">${esc(reviewText(i, decisions))}</textarea></label>` : ''}</details>`).join('')}</aside>
  <section class="pd-document-stage"><div class="pd-view-switch" aria-label="文档视图">${[['original','原文'],['tracked','修订与批注'],['clean','清洁版']].map(([value,label]) => `<button class="btn secondary" data-review-view="${value}" aria-pressed="${value === 'tracked'}">${label}</button>`).join('')}</div><div id="review-document">${reviewDocument(snapshot, decisions)}</div></section></div>
  <div class="pd-footer"><a class="btn secondary" href="#review?project=${p.id}&step=materials">准备下一轮</a><a class="btn primary" href="#/projects/${p.id}/files?folder=2">查看项目文件 ${ico('arrow')}</a></div>`;
}
export function bindReviewResult(root: HTMLElement, p: Project, state: DesignState, hooks: {save: () => void; render: () => void}) {
  const query = new URLSearchParams(location.hash.split('?')[1]);
  const jobs = state.jobs.filter(j => j.projectId === p.id && j.kind === 'review');
  const job = query.get('job') ? jobs.find(j => j.id === query.get('job')) : jobs[0];
  if (!job?.review || !root.querySelector('#review-document')) return;
  let view = 'tracked'; const snapshot = job.review, decisions = job.reviewDecisions ??= {};
  const paint = () => { root.querySelector('#review-document')!.innerHTML = reviewDocument(snapshot, decisions, view); };
  root.querySelectorAll<HTMLElement>('[data-review-view]').forEach(b => b.addEventListener('click', () => { view = b.dataset.reviewView!; root.querySelectorAll<HTMLElement>('[data-review-view]').forEach(x => x.setAttribute('aria-pressed', String(x === b))); paint(); }));
  root.querySelectorAll<HTMLSelectElement>('[data-review-choice]').forEach(s => s.addEventListener('change', () => { const issue = snapshot.issues.find(i => i.id === s.dataset.reviewChoice)!; decisions[issue.id] = { mode: s.value as 'suggested' | 'original' | 'manual', ...(s.value === 'manual' ? { text: reviewText(issue, decisions) } : {}) }; hooks.save(); hooks.render(); }));
  root.querySelectorAll<HTMLTextAreaElement>('[data-review-text]').forEach(t => t.addEventListener('input', () => { decisions[t.dataset.reviewText!] = { mode: 'manual', text: t.value }; hooks.save(); paint(); }));
  root.querySelectorAll<HTMLElement>('[data-review-download]').forEach(b => b.addEventListener('click', () => downloadWord(`${p.issuer}_复核${b.dataset.reviewDownload === 'tracked' ? '修订版' : '清洁版'}`, reviewParagraphs(snapshot, decisions), b.dataset.reviewDownload === 'tracked')));
}
