import { esc } from '../ui';
import { prototypeIcon as ico } from '../prototype-design';
import { FOLDERS, folderPath } from './catalog';
import { ORIGINAL_CATALOG } from './original-catalog';
import { latestFiles, fileFamily, type Project, type ProjectFile } from './model';
import { importProjectFile, deleteProjectFile, restoreProjectFile, modifiedTime } from './project-files';

type Hooks = { modal: (title: string, content: string) => HTMLDialogElement; save: () => void; render: () => void; notify: (text: string) => void; go: (hash: string) => void; deleted: (file: ProjectFile) => void };
export const preciseTime = (time: string) => new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(time));
export function fileTime(file: ProjectFile) {
  const time = modifiedTime(file);
  return `<div class="pd-file-time">${time ? `<time datetime="${esc(time)}" title="北京时间 · ${file.origin === 'upload' ? '本地文件的最后修改时间' : '此版本生成时间'}">${preciseTime(time)}</time>` : '<span class="muted">修改时间未知</span>'}<small>${file.origin === 'upload' ? '添加 ' + preciseTime(file.createdAt) : '此版本生成时间'}</small></div>`;
}
export function openFileImport(p: Project, requested: string, catalogId: string | undefined, hooks: Hooks) {
  const slot = ORIGINAL_CATALOG.find(d => d.id === catalogId);
  const folder = slot ? '4.2' : FOLDERS.some(f => f.id === requested) ? requested : 'sources';
  const dialog = hooks.modal('上传 / 添加文件', `<form id="import-project-form"><div class="pd-upload-project">${ico('folder')}<div><strong>${esc(p.name)}</strong><small>文件将保存到下方选定的目录</small></div></div><label class="pd-field">添加到目录<select id="import-folder">${FOLDERS.map(f => `<option value="${f.id}" ${f.id === folder ? 'selected' : ''}>${esc(folderPath(f.id))}</option>`).join('')}</select></label><label class="pd-field" id="import-catalog-field">关联历史底稿项（选填）<select id="import-catalog"><option value="">独立文件</option>${ORIGINAL_CATALOG.map(d=>`<option value="${d.id}" ${d.id === catalogId ? 'selected' : ''}>${esc(d.code)} ${esc(d.name)}</option>`).join('')}</select></label><label class="pd-upload pd-file-drop" id="file-drop">${ico('upload')}<strong>点击选择文件，或将文件拖到这里</strong><span>支持多选 · 文档、表格、图片 · 单份不超过 100 MB</span><input id="project-file-upload" type="file" multiple aria-label="选择要添加的文件" accept=".docx,.pdf,.xlsx,.csv,.txt,.png,.jpg,.jpeg"></label><div id="upload-queue" aria-live="polite"></div><label class="pd-field">遇到同目录的同名文件<select id="duplicate-mode"><option value="version">保存为新版本，保留旧版本</option><option value="separate">作为独立文件添加</option></select></label><p class="pd-note">按文件修改时间区分版本，时间统一显示为北京时间。设计稿仅记录文件名、时间与版本，文件内容不上传。</p><p class="pd-alert" id="import-error" role="alert" hidden></p><div class="pd-footer"><button type="button" class="btn secondary" id="cancel-upload">取消</button><button type="submit" id="submit-upload" class="btn primary" disabled>添加到此目录</button></div></form>`);
  dialog.classList.add('pd-manage-dialog');
  let queue: File[] = [];
  const select = dialog.querySelector<HTMLSelectElement>('#import-folder')!;
  const catalog = dialog.querySelector<HTMLSelectElement>('#import-catalog')!;
  const mode = dialog.querySelector<HTMLSelectElement>('#duplicate-mode')!;
  const error = (text: string) => { const el = dialog.querySelector<HTMLElement>('#import-error')!; el.hidden = !text; el.textContent = text; };
  const sync = () => {
    dialog.querySelector<HTMLElement>('#import-catalog-field')!.hidden = select.value !== '4.2';
    const submit = dialog.querySelector<HTMLButtonElement>('#submit-upload')!; submit.disabled = queue.length === 0; submit.textContent = queue.length ? `添加 ${queue.length} 个文件` : '添加到此目录';
    dialog.querySelector('#upload-queue')!.innerHTML = queue.map((f,i) => {
      const exists = latestFiles(p).some(x => x.folder === select.value && x.name.toLocaleLowerCase() === f.name.toLocaleLowerCase());
      return `<div class="pd-upload-queued">${ico('file')}<div class="pd-grow"><strong>${esc(f.name)}</strong><small>${(f.size/1024).toFixed(1)} KB · 修改于 ${preciseTime(new Date(f.lastModified).toISOString())}</small>${exists ? '<span class="pd-chip amber">已有同名文件 · ' + (mode.value === 'version' ? '将保存新版本' : '将独立保存') + '</span>' : ''}</div><button type="button" class="icon-btn" data-remove-queued="${i}" aria-label="移除待添加的 ${esc(f.name)}">${ico('close')}</button></div>`;
    }).join('');
  };
  const add = (files: FileList | null | undefined) => { queue.push(...Array.from(files ?? [])); error(''); sync(); };
  dialog.querySelector<HTMLInputElement>('#project-file-upload')!.addEventListener('change',e=>{add((e.target as HTMLInputElement).files);(e.target as HTMLInputElement).value='';});
  for (const el of [select,catalog,mode]) el.addEventListener('change',sync);
  dialog.addEventListener('click',e=>{const button=(e.target as HTMLElement).closest<HTMLElement>('[data-remove-queued]');if(button){queue.splice(Number(button.dataset.removeQueued),1);sync();}});
  const drop = dialog.querySelector<HTMLElement>('#file-drop')!;
  drop.addEventListener('dragover',e=>{e.preventDefault();drop.classList.add('dragging');});
  drop.addEventListener('dragleave',()=>drop.classList.remove('dragging'));
  drop.addEventListener('drop',e=>{e.preventDefault();drop.classList.remove('dragging');add(e.dataTransfer?.files);});
  dialog.querySelector('#cancel-upload')!.addEventListener('click',()=>dialog.close());
  dialog.querySelector('form')!.addEventListener('submit',e=>{
    e.preventDefault();
    try {
      if (!queue.length) throw new Error('请先选择文件。');
      const catalogId = select.value === '4.2' ? catalog.value || undefined : undefined;
      if (catalogId && queue.length > 1) throw new Error('一个历史底稿项每次添加一个版本；多文件请选“独立文件”。');
      const staged = structuredClone(p);
      for (const f of queue) importProjectFile(staged,f,select.value,catalogId,mode.value === 'separate' && !catalogId);
      p.files = staged.files; p.updatedAt = staged.updatedAt; hooks.save(); dialog.close();
      hooks.notify(`已添加 ${queue.length} 个文件到“${folderPath(select.value)}”。`); hooks.go(`/projects/${p.id}/files?folder=${select.value}`);
    } catch(e) { error((e as Error).message); }
  }); sync();
}
export function openFileDelete(p: Project, file: ProjectFile, hooks: Hooks) {
  const previous = p.files.filter(f => !f.deletedAt && f.id !== file.id && fileFamily(f) === fileFamily(file)).sort((a,b)=>b.version-a.version)[0];
  const isCurrent = latestFiles(p).some(f=>f.id===file.id);
  const dialog = hooks.modal('删除这个文件版本？', `<div class="pd-delete-file">${ico('file')}<div><strong>${esc(file.name)}</strong><small>v${file.version} · ${esc(folderPath(file.folder))}</small>${fileTime(file)}</div></div><p>仅将 <strong>v${file.version}</strong> 移到“已删除文件”，随时可以恢复。历史任务记录保留。</p>${isCurrent && previous ? `<p class="pd-inline-note">删除后，v${previous.version} 将显示为当前版本。</p>` : ''}<p class="pd-note">正在准备的任务会取消对此版本的选择；再次使用时需重新选择文件。</p><div class="pd-footer"><button class="btn secondary" id="cancel-delete">取消</button><button class="btn pd-danger-button" id="confirm-delete">删除此版本</button></div>`);
  dialog.classList.add('pd-manage-dialog');
  dialog.querySelector('#cancel-delete')!.addEventListener('click',()=>dialog.close());
  dialog.querySelector('#confirm-delete')!.addEventListener('click',()=>{deleteProjectFile(p,file.id);hooks.deleted(file);hooks.save();dialog.close();hooks.notify(`已删除“${file.name}”的 v${file.version}，可撤销或从已删除文件恢复。`);hooks.render();});
  dialog.querySelector<HTMLButtonElement>('#cancel-delete')!.focus();
}
export function openDeletedFiles(p: Project, hooks: Hooks) {
  const deleted = p.files.filter(f=>f.deletedAt).sort((a,b)=>b.deletedAt!.localeCompare(a.deletedAt!));
  const dialog = hooks.modal('已删除文件', `<p class="muted">${esc(p.name)} · 恢复后回到原目录，原版本号与修改时间保留。</p>${deleted.length ? deleted.map(f=>`<div class="pd-result-row"><div class="pd-grow"><strong>${esc(f.name)} · v${f.version}</strong><small>${esc(folderPath(f.folder))}</small><small>删除于 ${preciseTime(f.deletedAt!)}</small></div><button class="btn secondary" data-restore-file="${f.id}">恢复</button></div>`).join('') : '<div class="pd-empty">没有已删除的文件。</div>'}`);
  dialog.querySelectorAll<HTMLElement>('[data-restore-file]').forEach(b=>b.addEventListener('click',()=>{restoreProjectFile(p,b.dataset.restoreFile!);hooks.save();dialog.close();hooks.notify('文件已恢复到原目录，版本与修改时间保持不变。');hooks.render();}));
}
