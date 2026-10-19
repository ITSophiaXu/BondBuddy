import { esc, date } from '../ui';
import { prototypeIcon as ico } from '../prototype-design';
import { folderPath } from './catalog';
import { acceptConsistency, associatedFiles, CHECK_DURATION, consistencyStale, currentProspectus, pendingIssues, targetStale, type ConsistencyFile } from './consistency-model';
import type { DesignState, Job, Project, ProjectFile } from './model';

const url = (p: Project, job: Job, file?: string, filter = 'all') => `consistency?project=${p.id}&job=${job.id}${file ? '&file=' + file : ''}&filter=${filter}`;
const start = (p: Project, label = '重新检查') => `<button class="btn secondary" data-consistency-start data-project="${p.id}">${label}</button>`;
const status = (j: Job, f: ConsistencyFile) => f.status === 'conflict' ? pendingIssues(j, f).length ? 'conflict' : 'updated' : f.status;
const labels = { conflict: '需要更新', updated: '已更新', consistent: '一致', manual: '需人工确认' };
const selections = new Map<string, Set<string>>();
const omittedIssues = new Map<string, Set<string>>();
const selection = (job: Job) => { if (!selections.has(job.id)) selections.set(job.id,new Set()); return selections.get(job.id)!; };
const chosenIssues = (job: Job, item: ConsistencyFile) => pendingIssues(job,item).filter(i => !omittedIssues.get(job.id+item.file.id)?.has(i.id));
const chip = (j: Job, f: ConsistencyFile) => `<span class="pd-chip ${['conflict','manual'].includes(status(j,f)) ? 'amber' : ''}">${labels[status(j,f)]}</span>`;
function basis(p: Project, job: Job) {
  const s = job.consistency!.snapshot.source;
  return `<div class="pd-source-strip pd-consistency-basis">${ico('file')}<div class="pd-grow"><strong>${esc(s.name)}</strong><small>本次基准 · v${s.version}${s.type === 'review-clean' ? ' · 复核后的清洁版正文（含本轮手动修改）' : ''} · ${esc(p.name)}</small></div><span class="pd-chip">以募集书为准</span></div>`;
}
function heading(p: Project, checking: boolean) {
  return `<div class="page-head pd-page-head"><div><div class="eyebrow">FILE CONSISTENCY</div><h1>${checking ? '正在检查文件一致性' : '文件一致性检查'}</h1><p>以当前募集说明书为基准，核对项目关联文件，确认后同步更新。</p></div><a class="btn secondary" href="#/projects/${p.id}/files">返回项目文件</a></div>`;
}
export function consistencyView(p: Project, state: DesignState, query: URLSearchParams) {
  const jobs = state.jobs.filter(j => j.projectId === p.id && j.consistency), job = jobs.find(j => j.id === query.get('job'));
  if (!job?.consistency) return `${heading(p,false)}<section class="pd-panel pd-consistency-empty"><h2>${query.has('job') ? '检查记录不存在' : !currentProspectus(p) ? '请先添加募集说明书' : !associatedFiles(p).length ? '还没有可检查的关联文件' : '准备检查项目文件'}</h2><p>检查范围为本项目每份文件的最新版本；历史版本保留在项目文件中。</p><div class="pd-actions">${currentProspectus(p) && associatedFiles(p).length ? start(p,'开始检查') : `<a class="btn primary" href="#generate?project=${p.id}&step=source">${currentProspectus(p) ? '生成关联文件' : '添加募集说明书'}</a>`}<a class="btn secondary" href="#/projects/${p.id}/files">导入或查看项目文件</a>${jobs[0] ? `<a class="text-button" href="#${url(p,jobs[0])}">查看最近检查</a>` : ''}</div></section>`;
  const snapshot = job.consistency.snapshot;
  if (job.consistency.phase === 'checking') {
    const percent = Math.min(96, Math.max(4, Math.round((Date.now() - Date.parse(job.createdAt)) / CHECK_DURATION * 100))), phase = percent < 25 ? 0 : percent < 65 ? 1 : 2;
    return `${heading(p,true)}${basis(p,job)}<section class="pd-panel pd-check-progress"><div class="pd-scan-orbit">${ico('file')}<span></span></div><span class="pd-chip">本地演示进度</span><h2>${['读取本轮文件版本', '对比关联文件的披露内容', '整理冲突与更新建议'][phase]}</h2><p>本轮已固定 ${snapshot.files.length} 份关联文件，完成后可逐项确认更新。</p><div class="pd-progress-track" role="progressbar" aria-label="一致性检查演示进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"><span style="width:${percent}%"></span></div><div class="pd-progress-caption"><span>${['整理文件范围','检查关键字段、期间与口径','生成逐文件对比'][phase]}</span><strong>${percent}%</strong></div><ol class="pd-check-phases">${['固定募集书与文件版本','核对数据、发行安排和披露表述','整理需更新文件及冲突位置'].map((x,i) => `<li class="${i === phase ? 'current' : i < phase ? 'done' : ''}"><b>${i < phase ? '✓' : i + 1}</b>${x}</li>`).join('')}</ol><p class="pd-note">这是本地交互演示，未解析文件或调用模型；完成后展示合成对比结果。</p></section>`;
  }
  const counts = { conflict: 0, updated: 0, consistent: 0, manual: 0 };
  for (const f of snapshot.files) counts[status(job,f)]++;
  const filter = ['conflict','updated','consistent','manual'].includes(query.get('filter') ?? '') ? query.get('filter')! : 'all';
  const shown = snapshot.files.filter(f => filter === 'all' || status(job,f) === filter);
  const item = shown.find(f => f.file.id === query.get('file')) ?? shown.find(f => status(job,f) === 'conflict') ?? shown[0];
  const stale = consistencyStale(state,p,job);
  const available = shown.filter(f => pendingIssues(job,f).length && !stale && !targetStale(p,job,f));
  const selectedCount = available.filter(f => selection(job).has(f.file.id) && chosenIssues(job,f).length).length;
  return `${heading(p,false)}${basis(p,job)}
  <div class="pd-consistency-summary"><div><span>检查范围</span><strong>${snapshot.files.length}<small> 份文件</small></strong></div><div class="attention"><span>需要更新</span><strong>${counts.conflict}<small> 份</small></strong></div><div><span>已经一致</span><strong>${counts.consistent}<small> 份</small></strong></div><div><span>需人工确认</span><strong>${counts.manual}<small> 份</small></strong></div><div><span>接受更新</span><strong>${counts.updated}<small> 份</small></strong></div></div>
  <div class="pd-check-disclaimer"><span class="pd-chip amber">合成结果示例</span><p>以下原文、定位和冲突用于演示，未读取上传文件。“一致”不代表真实文件已经通过检查。</p><label>检查记录<select id="consistency-job">${jobs.map((j,i) => `<option value="${j.id}" ${j.id === job.id ? 'selected' : ''}>第 ${jobs.length-i} 轮 · ${esc(date(j.createdAt))}</option>`).join('')}</select></label></div>
  ${stale ? `<div class="pd-consistency-alert" role="status"><div><strong>募集书已有新版本或新的复核修改</strong><p>本页保留当时的对比。请按当前募集书重新检查，再接受更新。</p></div>${start(p)}</div>` : ''}
  <div class="pd-consistency-workspace"><aside class="pd-panel pd-check-files"><h2>文件检查结果</h2><label class="pd-field">筛选结果<select id="consistency-filter"><option value="all">全部文件（${snapshot.files.length}）</option>${Object.entries(labels).map(([key,label]) => `<option value="${key}" ${key === filter ? 'selected' : ''}>${label}（${counts[key as keyof typeof counts]}）</option>`).join('')}</select></label><div class="pd-check-select"><label><input type="checkbox" id="consistency-select-all" ${!available.length ? 'disabled' : selectedCount === available.length ? 'checked' : ''}> 选择可更新文件</label><small>当前筛选</small></div><nav aria-label="待对比文件">${shown.length ? shown.map(f => `<div class="pd-check-file ${f.file.id === item?.file.id ? 'active' : ''}"><input type="checkbox" data-consistency-file="${f.file.id}" aria-label="选择更新 ${esc(f.file.name)}" ${available.includes(f) ? selection(job).has(f.file.id) ? 'checked' : '' : 'disabled'}><a href="#${url(p,job,f.file.id,filter)}" ${f.file.id === item?.file.id ? 'aria-current="page"' : ''}><strong>${esc(f.file.name)}</strong><small>v${f.file.version} · ${esc(folderPath(f.file.folder))}</small><span>${chip(job,f)}<small>${targetStale(p,job,f) ? '已有新版本 · 需重查' : pendingIssues(job,f).length ? pendingIssues(job,f).length + ' 处待更新' : ''}</small></span></a></div>`).join('') : '<p class="pd-empty">此分类没有文件。</p>'}</nav></aside>
  <section class="pd-panel pd-check-comparison">${item ? comparison(p,state,job,item,stale) : '<div class="pd-empty">选择其他分类查看检查结果。</div>'}</section></div>
  <div class="pd-consistency-footer"><div><strong id="consistency-selection">已选择 ${selectedCount} 份文件</strong><small>只更新选中的内容 · 新版本归回原目录 · 旧版本保留</small></div><div class="pd-actions">${start(p)}<button class="btn primary" id="consistency-accept-batch" ${selectedCount ? '' : 'disabled'}>接受所选文件更新（${selectedCount}）</button></div></div>`;
}
function comparison(p: Project, state: DesignState, job: Job, item: ConsistencyFile, stale: boolean) {
  const pending = pendingIssues(job,item), accepted = job.consistencyUpdates?.[item.file.id], output = p.files.find(f => f.id === accepted?.fileId), blocked = stale || targetStale(p,job,item);
  return `<div class="pd-section-head"><div><span class="eyebrow">SIDE BY SIDE</span><h2>${esc(item.file.name)}</h2><p class="muted">检查时 v${item.file.version}${output ? ' → 已保存 v' + output.version : ''} · ${item.issues.length} 处差异</p></div>${chip(job,item)}</div>
  ${output ? `<div class="pd-feedback pd-check-saved" role="status"><div><strong>新版本 v${output.version} 已保存</strong><small>${esc(folderPath(output.folder))} · 原 v${item.file.version} 保留</small></div><button class="text-button" data-action="preview" data-id="${output.id}">查看更新文件</button></div>` : ''}
  ${blocked && pending.length ? `<p class="pd-alert">${stale ? '募集书已变化' : '关联文件已出现新版本'}，本次剩余建议不能直接应用，请重新检查。</p>` : ''}
  ${item.issues.length ? `<div class="pd-compare-headings"><span>${ico('file')} 募集说明书 · 基准 v${job.consistency!.snapshot.source.version}</span><span>${ico('file')} 关联文件 · 检查时 v${item.file.version}</span></div>${item.issues.map((i,n) => {
    const done = !pending.some(x => x.id === i.id);
    return `<article class="pd-conflict"><div class="pd-conflict-title"><label><input type="checkbox" data-consistency-issue="${i.id}" ${done || blocked ? 'disabled' : chosenIssues(job,item).some(x => x.id === i.id) ? 'checked' : ''}> ${n+1}. ${esc(i.title)}</label><span class="pd-chip ${done ? '' : 'amber'}">${done ? '已接受' : '待同步'}</span></div><div class="pd-side-by-side"><section><small>${esc(i.sourceLocation)}</small><p>${esc(i.sourceText)}</p><span class="pd-compare-caption">募集书基准原文 · 合成片段</span></section><section><small>${esc(i.location)}</small><p class="pd-conflict-old">${esc(i.original)}</p><div class="pd-suggested"><b>建议更新为</b><p>${esc(i.suggested)}</p></div></section></div><p class="pd-conflict-reason">${ico('review')} ${esc(i.reason)}</p></article>`;
  }).join('')}<div class="pd-compare-action"><span class="pd-note">可逐条勾选修改，接受后保留原文件历史版本。</span><button class="btn primary" id="consistency-accept-file" data-file="${item.file.id}" ${chosenIssues(job,item).length && !blocked ? '' : 'disabled'}>接受此文件所选修改</button></div>` : `<div class="pd-consistency-empty">${ico(item.status === 'consistent' ? 'check' : 'file')}<h3>${item.status === 'consistent' ? '示例中未发现冲突' : '需要人工确认依据'}</h3><p>${esc(item.reason)}</p>${item.status === 'manual' ? `<p class="pd-word-missing">请核对原件的期间、主体与统计口径；如涉及核查结论，还需提供原始证据及确认记录。</p><a class="btn secondary" href="#/projects/${p.id}/files?folder=${item.file.folder}">查看文件与补充材料</a>` : ''}</div>`}`;
}
export function bindConsistency(root: HTMLElement, p: Project, state: DesignState, query: URLSearchParams, hooks: {save: () => void; render: () => void; go: (hash:string) => void; error: (e:unknown) => void; notify: (s:string) => void}) {
  const job = state.jobs.find(j => j.id === query.get('job') && j.projectId === p.id);
  if (!job?.consistency || job.consistency.phase !== 'complete') return;
  root.querySelector('#consistency-job')?.addEventListener('change', e => hooks.go(`consistency?project=${p.id}&job=${(e.target as HTMLSelectElement).value}`));
  root.querySelector('#consistency-filter')?.addEventListener('change', e => hooks.go(url(p,job,undefined,(e.target as HTMLSelectElement).value)));
  const inputs = () => [...root.querySelectorAll<HTMLInputElement>('[data-consistency-file]:not(:disabled)')];
  const sync = () => {
    const count = inputs().filter(i => i.checked && chosenIssues(job,job.consistency!.snapshot.files.find(f=>f.file.id===i.dataset.consistencyFile)!).length).length, all = root.querySelector<HTMLInputElement>('#consistency-select-all')!;
    all.checked = !!count && count === inputs().length; all.indeterminate = !!count && count < inputs().length;
    root.querySelector('#consistency-selection')!.textContent = `已选择 ${count} 份文件`;
    const button = root.querySelector<HTMLButtonElement>('#consistency-accept-batch')!; button.disabled = !count; button.textContent = `接受所选文件更新（${count}）`;
  };
  inputs().forEach(i => i.addEventListener('change',() => { if(i.checked) selection(job).add(i.dataset.consistencyFile!); else selection(job).delete(i.dataset.consistencyFile!); sync(); }));
  root.querySelector<HTMLInputElement>('#consistency-select-all')?.addEventListener('change', e => { inputs().forEach(i => { i.checked = (e.target as HTMLInputElement).checked; if(i.checked) selection(job).add(i.dataset.consistencyFile!); else selection(job).delete(i.dataset.consistencyFile!); }); sync(); });
  const issues = () => [...root.querySelectorAll<HTMLInputElement>('[data-consistency-issue]:checked:not(:disabled)')];
  root.querySelectorAll<HTMLInputElement>('[data-consistency-issue]').forEach(i => i.addEventListener('change', () => { const button = root.querySelector<HTMLButtonElement>('#consistency-accept-file')!; button.disabled = !issues().length; const key = job.id+button.dataset.file!; if(!omittedIssues.has(key)) omittedIssues.set(key,new Set()); if(i.checked) omittedIssues.get(key)!.delete(i.dataset.consistencyIssue!); else omittedIssues.get(key)!.add(i.dataset.consistencyIssue!); if(!issues().length) { selection(job).delete(button.dataset.file!); const fileInput=inputs().find(x=>x.dataset.consistencyFile===button.dataset.file); if(fileInput)fileInput.checked=false; } sync(); }));
  const accept = (requests: {fileId:string;issueIds:string[]}[]) => {
    try { const files = acceptConsistency(state,p,job.id,requests); hooks.save(); hooks.notify(`已更新 ${files.length} 份文件并保存新版本，旧版本保留。`); hooks.render(); }
    catch(e) { hooks.error(e); }
  };
  root.querySelector<HTMLElement>('#consistency-accept-file')?.addEventListener('click', e => accept([{fileId:(e.currentTarget as HTMLElement).dataset.file!,issueIds:issues().map(i => i.dataset.consistencyIssue!)}]));
  root.querySelector('#consistency-accept-batch')?.addEventListener('click', () => accept(inputs().filter(i => i.checked).map(i => { const item = job.consistency!.snapshot.files.find(f => f.file.id === i.dataset.consistencyFile)!; return {fileId:item.file.id, issueIds:chosenIssues(job,item).map(x => x.id)}; })));
  sync();
}
export function consistencyDocument(file: ProjectFile) {
  const c = file.consistency!;
  return `<article class="pd-word-sheet"><div class="pd-word-watermark">一致性更新 · 合成片段</div><h2>${esc(file.name)} · v${file.version}</h2><p>依据：${esc(c.sourceName)} · v${c.sourceVersion}</p>${c.issues.map(i => `<section class="pd-word-section"><small>${esc(i.location)}</small><p><del>${esc(i.original)}</del><ins>${esc(i.suggested)}</ins></p><aside class="pd-word-comment"><strong>BondBuddy · 更新原因</strong><p>${esc(i.reason)}</p><small>${esc(i.sourceLocation)}</small></aside></section>`).join('')}<p class="pd-note">仅展示已接受修改的合成片段，未修改或下载实际上传的文件。</p></article>`;
}
