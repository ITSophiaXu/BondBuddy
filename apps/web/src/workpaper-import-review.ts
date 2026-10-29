import type {WorkpaperCataloguePreview,WorkpaperColumnMapping} from '@bondbuddy/contracts';
import {esc} from './ui';

/** Editing changes a proposal only. The caller must preview it again before accepting it. */
export class WorkpaperImportReview {
  private mapping:WorkpaperColumnMapping[];private dirty=false;
  constructor(private preview:WorkpaperCataloguePreview,private scope:'due_diligence'|'all',
    private recalculate:(mapping:WorkpaperColumnMapping[]|undefined,scope:'due_diligence'|'all')=>void,
    private accept:(mapping:WorkpaperColumnMapping[],scope:'due_diligence'|'all')=>void){this.mapping=structuredClone(preview.mapping);}
  render(node:HTMLElement,busy:boolean){
    const p=this.preview,options=(s:typeof p.sheets[number],value:number|undefined,optional=false)=>
      `${optional?`<option value="" ${value===undefined?'selected':''}>无</option>`:''}${s.columns.map(c=>`<option value="${c.index}" ${value===c.index?'selected':''}>${esc(c.label)} · ${esc(c.sample||'空列')}</option>`).join('')}`;
    node.innerHTML=`<section class="wp-import-review" aria-label="核对目录识别"><h3>核对目录识别</h3><p><strong>${esc(p.filename)}</strong> 已保存。请核对名称、编号和条目范围；可以直接在这里调整。</p>
      <label class="wp-inline"><input id="wp-all-sheets" type="checkbox" ${this.scope==='all'?'checked':''}>查看全部工作表（默认优先“1 尽职调查文件”）</label>
      ${p.sheets.map(s=>`<details class="wp-review-sheet" open><summary>${esc(s.name)}</summary><details><summary>原表样例（前 ${s.sample_rows.length} 个非空行）</summary><div class="wp-table-wrap"><table class="wp-table"><thead><tr><th>行</th>${s.columns.map(c=>`<th>${esc(c.label)}</th>`).join('')}</tr></thead><tbody>${s.sample_rows.map(r=>`<tr><th>${r.row}</th>${s.columns.map(c=>`<td>${esc(r.cells[c.index]??'')}</td>`).join('')}</tr>`).join('')}</tbody></table></div></details>
      ${this.mapping.map((m,i)=>m.sheet!==s.name?'':`<fieldset data-wp-map="${i}"><legend>目录区域 ${i+1}</legend><div class="wp-mapping-fields"><label>名称所在列<select data-field="title_column">${options(s,m.title_column)}</select></label><label>编号所在列<select data-field="code_column">${options(s,m.code_column,true)}</select></label><label>从第几行开始<input data-field="first_row" type="number" min="1" max="10000" value="${m.first_row}"></label><label>到第几行结束<input data-field="last_row" type="number" min="1" max="10000" value="${m.last_row}"></label></div>
      <details><summary>分类、编制要求与编号设置</summary><label class="wp-inline"><input data-field="split_code" type="checkbox" ${m.split_code?'checked':''}>编号与名称合在一格时拆分</label><label>条目类型所在列<select data-field="kind_column">${options(s,m.kind_column,true)}</select></label><p class="muted">仅“类型”明确写为目录或文件夹时作为分组；其他有名称的行保留为文件。</p>
      ${(['folder_columns','instruction_columns'] as const).map(key=>`<fieldset><legend>${key==='folder_columns'?'分类列（按列顺序组成路径）':'编制要求列（保留各列文字）'}</legend><div class="wp-column-checks">${s.columns.map(c=>`<label class="wp-inline"><input data-list="${key}" value="${c.index}" type="checkbox" ${m[key].includes(c.index)?'checked':''}>${esc(c.label)} · ${esc(c.sample||'空列')}</label>`).join('')}</div></fieldset>`).join('')}</details><button class="text-button" data-wp-remove-map="${i}">不纳入这个区域</button></fieldset>`).join('')}
      <button class="text-button" data-wp-add-map="${esc(s.name)}">添加这个工作表的目录区域</button></details>`).join('')}
      <p id="wp-review-dirty" role="status">${this.dirty?'识别范围已调整，请先更新预览。':`已识别 ${p.entries.filter(e=>e.kind==='file').length} 份文件。`}</p>
      ${p.warnings.length?`<details open><summary>请核对（${p.warnings.length}）</summary>${p.warnings.map(w=>`<p>${esc(w)}</p>`).join('')}</details>`:''}
      ${p.unrecognized_count?`<details><summary>未纳入的原表行：${p.unrecognized_count} 行（最多显示 100 行）</summary><ul>${p.unrecognized_rows.map(r=>`<li>${esc(r.sheet)} · 第 ${r.row} 行：${esc(r.cells.filter(Boolean).join(' / '))}</li>`).join('')}</ul></details>`:''}
      <details><summary>查看识别结果（${p.entries.length} 项）</summary><ul class="wp-preview-entries">${p.entries.map(e=>`<li>${esc(e.code)} ${esc(e.title)}<small>${esc(e.sheet)} · 第 ${e.row} 行${e.folder?' · '+esc(e.folder):''}</small>${e.instructions?`<p>${esc(e.instructions)}</p>`:''}</li>`).join('')}</ul></details>
      <div class="wp-actions"><button class="btn secondary" id="wp-preview-again">更新识别预览</button><button class="btn primary" id="wp-accept-mapping" ${this.dirty||!p.entries.some(e=>e.kind==='file')?'disabled':''}>确认目录，选择生成文件</button></div><small>这里只保存目录；下一步确认生成时才会创建任务。</small></section>`;
    const changed=()=>{this.dirty=true;node.querySelector<HTMLButtonElement>('#wp-accept-mapping')!.disabled=true;node.querySelector('#wp-review-dirty')!.textContent='识别范围已调整，请先更新预览。';};
    node.querySelectorAll<HTMLElement>('[data-wp-map]').forEach(field=>{
      const m=this.mapping[Number(field.dataset.wpMap)]!;
      field.querySelectorAll<HTMLInputElement|HTMLSelectElement>('[data-field]').forEach(input=>input.onchange=()=>{
        const key=input.dataset.field!;
        if(key==='split_code')m.split_code=(input as HTMLInputElement).checked;
        else if(key==='code_column'||key==='kind_column'){if(input.value==='')delete m[key];else m[key]=Number(input.value);}
        else if(key==='title_column'||key==='first_row'||key==='last_row')m[key]=Number(input.value);
        changed();
      });
      field.querySelectorAll<HTMLInputElement>('[data-list]').forEach(input=>input.onchange=()=>{
        const key=input.dataset.list as 'folder_columns'|'instruction_columns';
        m[key]=[...field.querySelectorAll<HTMLInputElement>(`[data-list=${key}]:checked`)].map(i=>Number(i.value));changed();
      });
    });
    node.querySelectorAll<HTMLButtonElement>('[data-wp-remove-map]').forEach(b=>b.onclick=()=>{this.mapping.splice(Number(b.dataset.wpRemoveMap),1);this.dirty=true;this.render(node,false);});
    node.querySelectorAll<HTMLButtonElement>('[data-wp-add-map]').forEach(b=>b.onclick=()=>{
      const sheet=p.sheets.find(s=>s.name===b.dataset.wpAddMap)!;this.mapping.push({sheet:sheet.name,first_row:1,last_row:sheet.last_row,title_column:0,split_code:true,folder_columns:[],instruction_columns:[]});this.dirty=true;this.render(node,false);
    });
    node.querySelector<HTMLInputElement>('#wp-all-sheets')!.onchange=e=>this.recalculate(undefined,(e.target as HTMLInputElement).checked?'all':'due_diligence');
    node.querySelector<HTMLButtonElement>('#wp-preview-again')!.onclick=()=>this.recalculate(structuredClone(this.mapping),this.scope);
    node.querySelector<HTMLButtonElement>('#wp-accept-mapping')!.onclick=()=>{if(!this.dirty)this.accept(structuredClone(this.mapping),this.scope);};
    if(busy)node.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLButtonElement>('input,select,button').forEach(e=>e.disabled=true);
  }
}
