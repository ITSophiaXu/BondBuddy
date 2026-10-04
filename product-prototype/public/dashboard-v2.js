/* Read-only companion workbench for the M3 interaction prototype. */
import { STORAGE, findings, readDemoState, demoRecordText } from '/review-demo-data.js';

const iconPaths = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  'file-edit': '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M8 16l6-6 2 2-6 6H8Z"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M8 13h8M8 17h5"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z"/><path d="m8 12 3 3 5-6"/>',
  sparkles: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5ZM20 2v4M18 4h4"/>',
  message: '<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2V11.5a9.5 9.5 0 0 1 19 0Z"/><path d="M7 9h9M7 13h6"/>',
  folder: '<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  'chevron-right': '<path d="m9 5 7 7-7 7"/>',
  'chevron-down': '<path d="m6 9 6 6 6-6"/>',
  'arrow-up-right': '<path d="M7 17 17 7M7 7h10v10"/>',
  'arrow-right': '<path d="M4 12h16m-7-7 7 7-7 7"/>',
  history: '<path d="M3 11a9 9 0 1 1 2 7M3 4v7h7M12 7v6l4 2"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  layers: '<path d="m12 3 10 5-10 5L2 8Zm-9 9 9 5 9-5M3 16l9 5 9-5"/>',
};
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconPaths[name] || iconPaths.file}</svg>`;
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const $ = selector => document.querySelector(selector);
let state;
let stateSignature = '';
let historyOpen = true;
let toastTimer;
let selectedRunId = null;
const runStatus = run => run.status === 'complete' ? '已完成 · 示例' : run.status === 'cancelled' ? '已停止' : '演示进行中';
const isReview = run => run.kind !== 'revision';
const findRun = id => state.activeRun?.id === id ? { ...state.activeRun, status: 'running' } : state.runs.find(run => run.id === id);
const count = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const noteContext = note => `${note.reference ? `关联问题 ${note.reference}` : '项目级说明'} · ${note.report ? `来源报告 ${note.report}` : '来源报告未记录'}`;
const button = (label, action, id, style = 'secondary small', symbol = '') => `<button type="button" class="button ${style}" data-action="${action}" data-value="${esc(id)}">${symbol ? icon(symbol) : ''}${esc(label)}</button>`;

function renderEntry(run) {
  const reportLabel = isReview(run) && run.status === 'complete' ? `报告 ${run.report || run.id}` : `依据报告 ${run.sourceReport || run.report || 'R1'}`;
  return `<article class="history-entry ${run.status === 'cancelled' ? 'cancelled' : ''}">
    <div class="history-entry-header"><h4><span>${esc(run.id)}</span>${esc(run.title || (isReview(run) ? '复核演示' : '修订演示'))}</h4><span class="badge ${run.status === 'complete' ? 'success' : 'neutral'}">${runStatus(run)}</span></div>
    <p class="history-entry-meta">输入 ${esc(run.input)} · ${esc(reportLabel)} · ${count(run.files)} 份材料 · ${count(run.notes)} 项说明</p>
    <p class="history-entry-scope">${esc(run.scope)}</p>
    <div class="history-entry-footer">${button('查看快照', 'snapshot', run.id, 'secondary small', 'layers')}${button('下载记录 TXT', 'download', run.id, 'text-button', 'download')}<time>${esc(run.created)}</time></div>
  </article>`;
}

function render() {
  const active = state.activeRun;
  const nextNotes = state.notes.filter(note => note.target === 'next');
  const current = state.runs.find(run => run.id === state.report);
  const revision = state.latestRevision;
  const status = active ? '演示进行中' : revision ? '有修订示例' : '复核结果待处理';
  const contextTitle = active ? `${active.id} · ${isReview(active) ? '复核' : '修订'}演示进行中` : revision ? `${revision} 修订示例已生成` : `${state.report} 复核报告已准备好`;
  const contextText = active
    ? `本次锁定输入 ${active.input}。${nextNotes.length ? `另有 ${nextNotes.length} 项新说明留待下一版。` : '继续项目可查看当前进度、补充下一版要求。'}`
    : revision ? '继续查看修改内容与保留项，按需要发起后续复核。'
      : current?.scope?.includes('受影响') ? '本轮只核验所选问题，其余发现保留原报告结论。继续查看本轮范围与结果。'
        : '从复核发现继续处理：确认依据、补充材料，或选择需要修订的内容。';
  $('#dashboard-content').innerHTML = `<div class="dashboard-layout"><section aria-labelledby="recent-projects"><div class="dashboard-section-title"><h2 id="recent-projects">最近项目</h2><span>1 个示例项目</span></div>
    <article class="project-card"><div class="project-card-top"><div class="project-card-title"><span class="project-symbol">澄</span><div><h3>澄川科技</h3><p>募集说明书复核 · 示例项目 001</p></div><span class="badge ${active ? 'warning' : 'success'}">${status}</span></div>
      <div class="project-detail-line"><span>上交所 · 普通私募公司债</span><span>报告期 2025 年末</span><span>源稿 V1</span></div>
      <div class="project-context">${icon(active ? 'clock' : revision ? 'file-edit' : 'shield')}<div><strong>${esc(contextTitle)}</strong><p>${esc(contextText)}</p></div></div>
      <div class="project-actions"><span>报告 ${esc(state.report)} · ${state.files.length} 份材料信息${nextNotes.length ? ` · ${nextNotes.length} 项新说明` : ''}</span><a class="button primary" href="/review-v2.html${!active && revision ? '#revision' : ''}">继续处理${icon('arrow-right')}</a></div>
    </div>
    <details class="history-section" id="version-history" ${historyOpen ? 'open' : ''}><summary><span class="history-label">${icon('history')}版本记录<small>${state.runs.length}</small></span>${icon('chevron-down')}</summary><div class="history-content"><p class="history-intro">每次复核、修订与停止的任务独立保留，材料和说明以启动时的快照为准。</p><div class="history-timeline">${[...state.runs].reverse().map(renderEntry).join('')}</div>${!state.runs.length ? '<p class="history-intro">还没有完成或停止的任务。</p>' : ''}</div></details></article>
  </section><aside class="dashboard-aside" aria-label="示例项目概况"><div><div class="dashboard-section-title"><h2>项目概况</h2><span>${esc(state.nextInput)}</span></div><section class="project-info-card"><h3>当前材料 <small>${state.files.length} 份</small></h3>${state.files.slice(0, 4).map(file => `<div class="dashboard-material">${icon('file')}<div><strong>${esc(file.name)}</strong><small>${esc(file.kind)} · ${file.sample ? '示例材料' : '仅文件名信息'}</small></div></div>`).join('')}${state.files.length > 4 ? `<p class="dashboard-small-note">另有 ${state.files.length - 4} 份补充材料信息</p>` : ''}<a class="text-button" href="/review-v2.html#materials">查看材料与要求${icon('arrow-right')}</a></section></div>
    <section class="project-info-card"><h3>已保存说明 <small>${state.notes.length} 项</small></h3>${state.notes.slice(-3).map(note => `<div class="dashboard-note">${icon('check')}<p>${esc(note.text)}</p></div>`).join('')}${state.notes.length > 3 ? `<p class="dashboard-small-note">显示最近 3 项，共 ${state.notes.length} 项</p>` : ''}<p class="dashboard-small-note">${nextNotes.length ? `${nextNotes.length} 项尚未用于新任务；继续项目后可明确执行。` : '历史任务使用的说明可在对应版本快照中回看。'}</p></section>
  </aside></div>`;
  $('#version-history').addEventListener('toggle', event => { historyOpen = event.target.open; });
}

function snapshotBody(run) {
  const files = Array.isArray(run.fileSnapshot) ? run.fileSnapshot : null;
  const notes = Array.isArray(run.noteSnapshot) ? run.noteSnapshot : null;
  const snapshotList = (list, field) => list ? `<ul class="snapshot-file-list">${list.map(item => `<li>${esc(item[field])}${field === 'text' ? `<br><small class="muted">${esc(noteContext(item))}</small>` : ''}</li>`).join('')}</ul>` : '<p class="muted">此早期示例未保存完整快照，不能用当前项目内容替代。</p>';
  const ids = Array.isArray(run.findingIds) ? run.findingIds : [];
  return `<dl class="snapshot-grid"><dt>任务</dt><dd>${esc(run.title || (isReview(run) ? '复核演示' : '修订演示'))} · ${esc(run.id)}</dd><dt>输入版本</dt><dd>${esc(run.input)}</dd><dt>${isReview(run) && run.status === 'complete' ? '输出报告' : '依据报告'}</dt><dd>${esc(isReview(run) && run.status === 'complete' ? run.report || run.id : run.sourceReport || run.report || 'R1')}</dd><dt>执行范围</dt><dd>${esc(run.scope)}</dd><dt>状态</dt><dd>${runStatus(run)}</dd><dt>启动信息</dt><dd>${count(run.files)} 份材料 · ${count(run.notes)} 项说明</dd></dl>
    <h3>本次材料快照</h3>${snapshotList(files, 'name')}
    <h3>本次说明快照</h3>${snapshotList(notes, 'text')}
    ${ids.length ? `<h3>${isReview(run) ? '本轮关联问题' : '本轮修订范围'}</h3><ul class="snapshot-file-list">${ids.map(id => `<li>${esc(id)} · ${esc(findings.find(finding => finding.id === id)?.title || '历史问题')}</li>`).join('')}</ul>` : ''}
    <p class="snapshot-disclaimer">${run.status === 'cancelled' ? '本次演示已停止，未生成新成果。' : '这是交互原型中的示例记录。'}启动后新增的材料与说明不改写这份快照；TXT 仅供查看记录，不是正式复核报告或 Word 成果。</p>`;
}

function showSnapshot(id) {
  const run = findRun(id);
  if (!run) return;
  selectedRunId = id;
  $('#history-modal-content').innerHTML = `<header class="modal-header"><h2 id="history-modal-title">${esc(run.id)} · 版本快照</h2><button class="icon-button" data-action="close-modal" aria-label="关闭版本快照">${icon('close')}</button></header><div class="modal-body">${snapshotBody(run)}</div><footer class="modal-footer">${button('下载记录 TXT', 'download', run.id, 'secondary', 'download')}${button('关闭', 'close-modal', '', 'primary')}</footer>`;
  if (!$('#history-modal').open) $('#history-modal').showModal();
}

function downloadRecord(id) {
  const run = findRun(id);
  if (!run) return;
  const content = [demoRecordText(run), '', `报告：${run.report || run.sourceReport || 'R1'}`, `时间：${run.created}`, '', `本次材料：${count(run.files)} 份`, ...(Array.isArray(run.fileSnapshot) ? run.fileSnapshot.map(file => `• ${file.name}`) : ['此早期示例未保存完整材料快照。']), '', `本次说明：${count(run.notes)} 项`, ...(Array.isArray(run.noteSnapshot) ? run.noteSnapshot.map(note => `• ${note.text}\n  ${noteContext(note)}`) : ['此早期示例未保存完整说明快照。'])].join('\n');
  const url = URL.createObjectURL(new Blob(['\uFEFF' + content], { type: 'text/plain;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `BondBuddy_示例版本记录_${run.id}.txt`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  clearTimeout(toastTimer);
  $('#toast').textContent = '已下载 TXT 示例记录。';
  $('#toast').classList.add('visible');
  toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 3000);
}

function refresh() {
  const loaded = readDemoState();
  const nextSignature = JSON.stringify(loaded);
  if (nextSignature === stateSignature) return;
  stateSignature = nextSignature;
  state = loaded.state;
  $('#storage-notice').hidden = loaded.storageOK;
  $('#storage-notice').textContent = '浏览器存储暂不可用，当前显示初始示例。';
  render();
  if ($('#history-modal').open && selectedRunId) {
    if (findRun(selectedRunId)) showSnapshot(selectedRunId);
    else $('#history-modal').close();
  }
}

document.querySelectorAll('[data-icon]').forEach(node => { node.innerHTML = icon(node.dataset.icon); });
document.addEventListener('click', event => {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  if (target.dataset.action === 'snapshot') showSnapshot(target.dataset.value);
  if (target.dataset.action === 'download') downloadRecord(target.dataset.value);
  if (target.dataset.action === 'close-modal') $('#history-modal').close();
  if (target.dataset.action === 'toggle-nav') {
    const isOpen = $('.sidebar').classList.toggle('nav-open');
    target.setAttribute('aria-expanded', String(isOpen));
    target.setAttribute('aria-label', isOpen ? '收起导航菜单' : '展开导航菜单');
  }
});
window.addEventListener('storage', event => { if (event.key === STORAGE || event.key === null) refresh(); });
window.addEventListener('focus', refresh);
window.addEventListener('pageshow', refresh);
refresh();
