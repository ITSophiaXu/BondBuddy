import { esc, date } from '../ui';
import { prototypeIcon as ico } from '../prototype-design';
import { folderPath } from './catalog';
import { fileTime } from './file-management-view';
import { downloadProjectFile, fileDownloadButton } from './file-download';
import { acceptConsistency, associatedFiles, CHECK_DURATION, consistencyStale, currentProspectus, pendingIssues, targetStale, type ConsistencyFile } from './consistency-model';
import type { DesignState, Job, Project } from './model';

const url = (p: Project, job: Job, file?: string, filter = 'all') => `consistency?project=${p.id}&job=${job.id}${file ? '&file=' + file : ''}&filter=${filter}`;
const start = (p: Project, label = '重新检查') => `<button class="btn secondary" data-consistency-start data-project="${p.id}">${label}</button>`;
const status = (j: Job, f: ConsistencyFile) => f.status === 'conflict' ? pendingIssues(j, f).length ? 'conflict' : 'updated' : f.status;
const labels = { conflict: '待生成修订版', updated: '已生成修订版', consistent: '一致', manual: '需人工确认' };
const selections = new Map<string, Set<string>>();
const selection = (job: Job) => { if (!selections.has(job.id)) selections.set(job.id,new Set()); return selections.get(job.id)!; };
const chip = (j: Job, f: ConsistencyFile) => `<span class="pd-chip ${['conflict','manual'].includes(status(j,f)) ? 'amber' : ''}">${labels[status(j,f)]}</span>`;
function basis(p: Project, job: Job) {
  const s = job.consistency!.snapshot.source;
  return `<div class="pd-source-strip pd-consistency-basis">${ico('file')}<div class="pd-grow"><strong>${esc(s.name)}</strong><small>本次基准 · v${s.version}${s.type === 'review-clean' ? ' · 复核清洁版 · 已固定版本' : ''} · ${esc(p.name)}</small></div><span class="pd-chip">以募集书为准</span></div>`;
}
function heading(p: Project, checking: boolean) {
  return `<div class="page-head pd-page-head"><div><div class="eyebrow">FILE CONSISTENCY</div><h1>${checking ? '正在检查文件一致性' : '文件一致性检查'}</h1><p>以当前募集说明书为基准，核对项目关联文件，下载修订版，在 Word 中审阅修改。</p></div><a class="btn secondary" href="#/projects/${p.id}/files">返回项目文件</a></div>`;
}
export function consistencyView(p: Project, state: DesignState, query: URLSearchParams) {
  const jobs = state.jobs.filter(j => j.projectId === p.id && j.consistency), job = jobs.find(j => j.id === query.get('job'));
  if (!job?.consistency) return `${heading(p,false)}<section class="pd-panel pd-consistency-empty"><h2>${query.has('job') ? '检查记录不存在' : !currentProspectus(p) ? '请先添加募集说明书' : !associatedFiles(p).length ? '还没有可检查的关联文件' : '准备检查项目文件'}</h2><p>检查范围为本项目每份文件的最新版本；历史版本保留在项目文件中。</p><div class="pd-actions">${currentProspectus(p) && associatedFiles(p).length ? start(p,'开始检查') : `<a class="btn primary" href="#generate?project=${p.id}&step=source">${currentProspectus(p) ? '生成关联文件' : '添加募集说明书'}</a>`}<a class="btn secondary" href="#/projects/${p.id}/files">导入或查看项目文件</a>${jobs[0] ? `<a class="text-button" href="#${url(p,jobs[0])}">查看最近检查</a>` : ''}</div></section>`;
  const snapshot = job.consistency.snapshot;
  if (job.consistency.phase === 'checking') {
    const percent = Math.min(96, Math.max(4, Math.round((Date.now() - Date.parse(job.createdAt)) / CHECK_DURATION * 100))), phase = percent < 25 ? 0 : percent < 65 ? 1 : 2;
    return `${heading(p,true)}${basis(p,job)}<section class="pd-panel pd-check-progress"><div class="pd-scan-orbit">${ico('file')}<span></span></div><span class="pd-chip">本地演示进度</span><h2>${['读取本轮文件版本', '对比关联文件的披露内容', '整理冲突与更新建议'][phase]}</h2><p>本轮已固定 ${snapshot.files.length} 份关联文件，完成后可生成并下载修订版。</p><div class="pd-progress-track" role="progressbar" aria-label="一致性检查演示进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"><span style="width:${percent}%"></span></div><div class="pd-progress-caption"><span>${['整理文件范围','检查关键字段、期间与口径','整理各文件状态'][phase]}</span><strong>${percent}%</strong></div><ol class="pd-check-phases">${['固定募集书与文件版本','核对数据、发行安排和披露表述','整理需更新文件及冲突位置'].map((x,i) => `<li class="${i === phase ? 'current' : i < phase ? 'done' : ''}"><b>${i < phase ? '✓' : i + 1}</b>${x}</li>`).join('')}</ol><p class="pd-note">这是本地交互演示，未解析文件或调用模型；完成后展示合成检查结果。</p></section>`;
  }
  const counts = { conflict: 0, updated: 0, consistent: 0, manual: 0 };
  for (const f of snapshot.files) counts[status(job,f)]++;
  const filter = ['conflict','updated','consistent','manual'].includes(query.get('filter') ?? '') ? query.get('filter')! : 'all';
  const shown = snapshot.files.filter(f => filter === 'all' || status(job,f) === filter);
  const stale = consistencyStale(state,p,job);
  const available = shown.filter(f => pendingIssues(job,f).length && !stale && !targetStale(p,job,f));
  const selectedCount = available.filter(f => selection(job).has(f.file.id)).length;
  return `${heading(p,false)}${basis(p,job)}
  <div class="pd-consistency-summary"><div><span>检查范围</span><strong>${snapshot.files.length}<small> 份文件</small></strong></div><div class="attention"><span>待生成修订版</span><strong>${counts.conflict}<small> 份</small></strong></div><div><span>已经一致</span><strong>${counts.consistent}<small> 份</small></strong></div><div><span>需人工确认</span><strong>${counts.manual}<small> 份</small></strong></div><div><span>已生成修订版</span><strong>${counts.updated}<small> 份</small></strong></div></div>
  <div class="pd-check-disclaimer"><span class="pd-chip amber">合成结果示例</span><p>下载文件为合成 Word，包含修订痕迹和批注，未读取或修改上传原件。</p><label>检查记录<select id="consistency-job">${jobs.map((j,i) => `<option value="${j.id}" ${j.id === job.id ? 'selected' : ''}>第 ${jobs.length-i} 轮 · ${esc(date(j.createdAt))}</option>`).join('')}</select></label></div>
  ${stale ? `<div class="pd-consistency-alert" role="status"><div><strong>募集书已有新版本或新的复核修改</strong><p>历史修订版仍可下载；继续生成前，请按当前募集书重新检查。</p></div>${start(p)}</div>` : ''}
  <section class="pd-panel pd-consistency-delivery"><div class="pd-section-head"><div><h2>文件检查结果</h2><p class="muted">修订版归回原目录，原文件和历史版本保留。</p></div><label class="pd-result-filter">文件状态<select id="consistency-filter"><option value="all">全部文件（${snapshot.files.length}）</option>${Object.entries(labels).map(([key,label]) => `<option value="${key}" ${key === filter ? 'selected' : ''}>${label}（${counts[key as keyof typeof counts]}）</option>`).join('')}</select></label></div>
  ${available.length ? `<div class="pd-check-select"><label><input type="checkbox" id="consistency-select-all" ${!available.length ? 'disabled' : selectedCount === available.length ? 'checked' : ''}> 选择本页可生成的文件</label><small>共 ${shown.length} 份</small></div>` : ''}
  <div class="pd-consistency-file-list">${shown.length ? shown.map(f => fileResult(p,job,f,stale,available.includes(f),query.get('file') === f.file.id)).join('') : '<p class="pd-empty">此分类没有文件，请调整筛选条件。</p>'}</div></section>
  <div class="pd-consistency-footer"><div><strong id="consistency-selection">${available.length ? `已选择 ${selectedCount} 份文件` : '此筛选下没有待生成文件'}</strong><small>修订版可直接下载，在 Word 中审阅修改与批注</small></div><div class="pd-actions">${start(p)}${available.length ? `<button class="btn primary" id="consistency-generate-batch" ${selectedCount ? '' : 'disabled'}>生成所选修订版（${selectedCount}）</button>` : `<a class="btn primary" href="#/projects/${p.id}/files">项目文件</a>`}</div></div>`;
}
function fileResult(p: Project, job: Job, item: ConsistencyFile, stale: boolean, available: boolean, focused: boolean) {
  const pending = pendingIssues(job,item), accepted = job.consistencyUpdates?.[item.file.id], output = p.files.find(f => f.id === accepted?.fileId);
  const blocked = stale || targetStale(p,job,item);
  const description = output?.deletedAt ? '已生成的版本已删除，可到项目文件中恢复。'
    : blocked && pending.length ? '基准或关联文件版本已变化，请重新检查。'
    : pending.length ? `共 ${pending.length} 处待修订，修改说明将保存在 Word 批注中。`
    : item.status === 'manual' ? item.reason : output ? '修订版已保存，可下载审阅。' : '本轮示例未发现差异，无需生成修订版。';
  return `<article class="pd-check-delivery-row ${focused ? 'focused' : ''}"><input type="checkbox" data-consistency-file="${item.file.id}" aria-label="选择 ${esc(item.file.name)}" ${available ? selection(job).has(item.file.id) ? 'checked' : '' : 'disabled'}><span class="pd-file-icon">${ico('file')}</span><div class="pd-check-delivery-info"><h3>${esc(item.file.name)}</h3><small>${esc(folderPath(item.file.folder))} · 检查时 v${item.file.version}${output ? ` → 修订版 v${output.version}` : ''}</small><p>${esc(description)}</p>${output ? fileTime(output) : fileTime(item.file)}</div><div class="pd-check-delivery-actions">${chip(job,item)}${output ? fileDownloadButton(output, 'btn secondary') : ''}${pending.length ? `<button class="btn ${output ? 'secondary' : 'primary'}" data-consistency-generate="${item.file.id}" ${available ? '' : 'disabled'}>${output ? '生成剩余修订并下载' : '生成并下载修订版'}</button>` : ''}${item.status === 'manual' || output?.deletedAt ? `<a class="text-button" href="#/projects/${p.id}/files?folder=${item.file.folder}">${output?.deletedAt ? '前往恢复文件' : '补充项目材料'} →</a>` : ''}</div></article>`;
}

export function bindConsistency(root: HTMLElement, p: Project, state: DesignState, query: URLSearchParams, hooks: {save: () => void; render: () => void; go: (hash:string) => void; error: (e:unknown) => void; notify: (s:string) => void}) {
  const job = state.jobs.find(j => j.id === query.get('job') && j.projectId === p.id);
  if (!job?.consistency || job.consistency.phase !== 'complete') return;
  root.querySelector('#consistency-job')?.addEventListener('change', e => hooks.go(`consistency?project=${p.id}&job=${(e.target as HTMLSelectElement).value}`));
  root.querySelector('#consistency-filter')?.addEventListener('change', e => hooks.go(url(p,job,undefined,(e.target as HTMLSelectElement).value)));
  const inputs = () => [...root.querySelectorAll<HTMLInputElement>('[data-consistency-file]:not(:disabled)')];
  const sync = () => {
    const count = inputs().filter(i => i.checked).length, all = root.querySelector<HTMLInputElement>('#consistency-select-all');
    if (!all) return;
    all.checked = !!count && count === inputs().length; all.indeterminate = !!count && count < inputs().length;
    root.querySelector('#consistency-selection')!.textContent = `已选择 ${count} 份文件`;
    const button = root.querySelector<HTMLButtonElement>('#consistency-generate-batch')!; button.disabled = !count; button.textContent = `生成所选修订版（${count}）`;
  };
  inputs().forEach(i => i.addEventListener('change',() => { if(i.checked) selection(job).add(i.dataset.consistencyFile!); else selection(job).delete(i.dataset.consistencyFile!); sync(); }));
  root.querySelector<HTMLInputElement>('#consistency-select-all')?.addEventListener('change', e => { inputs().forEach(i => { i.checked = (e.target as HTMLInputElement).checked; if(i.checked) selection(job).add(i.dataset.consistencyFile!); else selection(job).delete(i.dataset.consistencyFile!); }); sync(); });
  const generate = (ids: string[], download = false) => {
    try {
      const requests = ids.map(fileId => { const item = job.consistency!.snapshot.files.find(f => f.file.id === fileId); if(!item)throw new Error('文件不属于本次检查。'); return {fileId,issueIds:pendingIssues(job,item).map(i=>i.id)}; });
      const files = acceptConsistency(state,p,job.id,requests);
      hooks.save(); ids.forEach(id=>selection(job).delete(id));
      if(download && files[0])downloadProjectFile(state,p,files[0]);
      hooks.notify(`已生成 ${files.length} 份修订版，原版本保留。${download ? '已发起下载，可在 Word 中审阅。' : '请在对应文件行下载。'}`);
      hooks.render();
    } catch(e) { hooks.error(e); }
  };
  root.querySelectorAll<HTMLElement>('[data-consistency-generate]').forEach(b => b.addEventListener('click', () => generate([b.dataset.consistencyGenerate!],true)));
  root.querySelector('#consistency-generate-batch')?.addEventListener('click', () => generate(inputs().filter(i=>i.checked).map(i=>i.dataset.consistencyFile!)));
  sync();
}
