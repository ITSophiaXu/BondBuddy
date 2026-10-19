import { esc } from '../ui';
import { GENERATABLE } from './catalog';
import { templateFor, missingTemplates, saveTemplate } from './templates';
import type { Project, DesignState } from './model';
export function templatePreparation(p: Project) {
  const selected = GENERATABLE.filter(d => p.draft.selected.includes(d.id)), missing = missingTemplates(p);
  return `<section class="pd-panel pd-template-preparation"><div class="pd-section-head"><div><div class="eyebrow">历史文件 / 模板</div><h2>为所选文件准备模板</h2><p class="muted">首次添加后保存在项目中，下次自动复用。生成时固定所用版本，可随时更换。</p></div><span class="pd-chip ${missing.length ? 'amber' : ''}">${selected.length - missing.length} / ${selected.length} 已准备</span></div>${selected.length ? selected.map(d => {
    const t = templateFor(p, d.id);
    return `<div class="pd-template-row"><div><strong>${d.name}</strong><small>${t ? esc(t.name) + ' · v' + t.version + (t.origin === 'sample' ? ' · 合成示例' : ' · 已保存，下次复用') : '首次生成需要添加对应历史文件或模板'}</small></div><span class="pd-chip ${t ? '' : 'amber'}">${t ? '可复用' : '待添加'}</span><button class="btn ${t ? 'secondary' : 'primary'}" data-template-type="${d.id}">${t ? '管理 / 更换' : '添加历史文件 / 模板'}</button></div>`;
  }).join('') : '<p class="pd-empty">先在上方选择需要生成的文件。</p>'}<p class="pd-note">每种文件独立准备模板，不能用募集说明书替代。可从已保存模板库选用；本地设计仅保存名称与版本。</p></section>`;
}
export function templateLibrary(p: Project) {
  return (p.templates?.length ?? 0) ? `<section class="pd-panel pd-template-preparation"><h2>已保存的历史文件 / 模板</h2><p class="muted">${p.templates!.length} 个版本 · 作为文件生成依据，单独保留。</p>${GENERATABLE.filter(d => p.templates!.some(t => t.type === d.id)).map(d => `<div class="pd-template-row"><div><strong>${d.name}</strong><small>${esc(templateFor(p,d.id)?.name ?? '未选择')} · v${templateFor(p,d.id)?.version ?? ''}</small></div><button class="btn secondary" data-template-type="${d.id}">管理 / 更换</button></div>`).join('')}</section>` : '';
}
export function openTemplate(p: Project, type: string, state: DesignState, hooks: {modal: (title: string, content: string) => HTMLDialogElement; save: () => void; render: () => void}) {
  const document = GENERATABLE.find(d => d.id === type); if (!document) return;
  const current = templateFor(p,type), options = state.projects.flatMap(project => (project.templates ?? []).filter(t => t.type === type).map(t => ({project,t})));
  const dialog=hooks.modal(document.name + ' · 历史文件 / 模板', `<p>添加一次，后续生成默认复用。更换模板会保留旧版本。</p>${current ? `<p class="pd-feedback">本次选用：${esc(current.name)} · v${current.version}</p>` : ''}<form id="template-form"><label class="pd-field">上传对应历史文件 / 模板<input type="file" name="template" id="template-file" accept=".doc,.docx" required></label><p class="pd-note">Word · 单份不超过 100 MB；设计稿只记录文件名。</p><p id="template-error" class="pd-alert" role="alert" hidden></p><button class="btn primary" type="submit">保存并用于本次生成</button></form><h3 class="pd-notes-heading">从已保存模板库选用</h3>${options.length ? options.map(({project,t}) => `<div class="pd-template-row"><div><strong>${esc(t.name)}</strong><small>${esc(project.name)} · v${t.version}${t.origin==='sample'?' · 合成示例':''}</small></div><button class="btn secondary" data-use-template="${t.id}" data-template-project="${project.id}" ${current?.id===t.id?'disabled':''}>${current?.id===t.id?'已选用':'选用此版本'}</button></div>`).join('') : '<p class="pd-note">尚无此类型的已保存模板。</p>'}<details class="pd-details"><summary>仅体验设计流程</summary><p class="pd-note">可添加一个合成模板名称，不读取真实模板正文。</p><button class="btn secondary" id="template-sample">添加合成模板示例</button></details>`);
  const done=()=>{hooks.save();dialog.close();hooks.render();};
  dialog.querySelector('form')!.addEventListener('submit',e=>{e.preventDefault();try{const file=dialog.querySelector<HTMLInputElement>('#template-file')!.files?.[0];if(!file)throw new Error('请选择模板文件。');saveTemplate(p,type,file);done();}catch(e){const error=dialog.querySelector<HTMLElement>('#template-error')!;error.hidden=false;error.textContent=(e as Error).message;}});
  dialog.querySelector('#template-sample')!.addEventListener('click',()=>{saveTemplate(p,type,{name:document.name.replace(/[\\/:*?"<>|]/g,'_')+'_历史模板（合成示例）.docx',size:1024},'sample');done();});
  dialog.querySelectorAll<HTMLElement>('[data-use-template]').forEach(b=>b.addEventListener('click',()=>{const from=state.projects.find(x=>x.id===b.dataset.templateProject),t=from?.templates?.find(t=>t.id===b.dataset.useTemplate);if(!t)return;if(from?.id===p.id)(p.draft.templateIds??={})[type]=t.id;else saveTemplate(p,type,t,t.origin==='sample'?'sample':'reuse',t.id);p.updatedAt=new Date().toISOString();done();}));
}
