import {defaultWorkpaperIds,WORKPAPER_PRICE,WORKPAPER_LIMITS,WorkpaperStartSchema,type WorkpaperStart,type WorkpaperWorkspace,type WorkpaperCatalogue,type WorkpaperBatch,type ProjectFileSource} from '@bondbuddy/contracts';
import {Value} from '@sinclair/typebox/value';
import {ApiClient,ApiError,friendlyError} from './api';
import {UserFacingError} from './user-facing-error';
import {ArtifactDownloads} from './artifact-download';
import {uploadFileMaterial,type UploadFileMaterialState} from './file-workspace';
import {UploadRecovery} from './upload-recovery';
import {esc,date} from './ui';
import {prototypeIcon as ico} from './prototype-design';
import {withProjectContext} from './project-navigation';
import {runStateLabel} from './review-state';
import './workpaper-panel.css';

const stateNames:Record<string,string>={queued:'等待生成',running:'正在生成',paused:'已暂停',partial:'部分完成',complete:'已完成',cancelled:'已结束排队'};
export class WorkpaperPanel {
  private controller=new AbortController();private downloads=new ArtifactDownloads();private timer?:ReturnType<typeof setTimeout>;
  private data:WorkpaperWorkspace={catalogues:[],batches:[],assessments:[]};private selected=new Set<string>();private catalogue?:WorkpaperCatalogue;
  private progressBatch?:string;private expandedBatches=new Map<string,boolean>();
  private pending?:WorkpaperStart;private busy=false;private status='';private requirements='';private filter='';private upload:UploadFileMaterialState={};private storageError=false;
  private view:'prepare'|'confirm'|'results'='prepare';
  private expandedFolders=new Set<string>();
  constructor(private api:ApiClient,private host:HTMLElement,private project:string,private owner:string,private source:ProjectFileSource|null,private current:()=>boolean,private stepChanged:(step:number)=>void=()=>{}){}
  private get key(){return `bb-workpapers-v1:${this.owner}:${this.project}`;}
  get hasUnconfirmed(){return this.busy||!!this.pending||this.storageError;}
  async beforeLeave(){return !this.busy&&!this.storageError;}
  dispose(){this.controller.abort();clearTimeout(this.timer);this.downloads.dispose();}
  private live(){return !this.controller.signal.aborted&&this.current()&&this.host.isConnected;}
  private request<T>(method:string,path='',body?:unknown){return this.api.request<T>(method,`/projects/${encodeURIComponent(this.project)}/workpapers${path}`,body,{},this.controller.signal);}
  private async readWorkspace(){
    const data=await this.request<WorkpaperWorkspace>('GET');
    // The workspace contains only recent batches. Resolve the requested batch on every
    // refresh so a historical link never falls back to a newer batch or disappears.
    if(this.progressBatch&&!data.batches.some(b=>b.batch_id===this.progressBatch)){
      const batch=await this.request<WorkpaperBatch>('GET','/batches/'+encodeURIComponent(this.progressBatch));
      data.batches.unshift(batch);
    }
    return data;
  }
  private save(){try{localStorage.setItem(this.key,JSON.stringify({catalogue:this.catalogue?.catalogue_id,selected:[...this.selected],requirements:this.requirements,pending:this.pending}));this.storageError=false;return true;}catch{this.storageError=true;this.status='本浏览器无法保存待提交请求，请恢复存储后重试；尚未提交生成任务。';return false;}}
  async render(){
    this.host.innerHTML='<p role="status">正在读取底稿目录与生成进度…</p>';
    try{
      const query=new URLSearchParams(location.hash.split('?')[1]);
      this.view=query.get('view')==='results'?'results':'prepare';
      this.progressBatch=query.get('view')==='results'?query.get('batch')??undefined:undefined;
      this.data=await this.readWorkspace();if(!this.live())return;
      const saved=JSON.parse(localStorage.getItem(this.key)??'null');
      if(saved?.pending){if(!Value.Check(WorkpaperStartSchema,saved.pending))throw Error('invalid pending');this.pending=saved.pending;}
      const restoredCatalogue=this.pending?.catalogue_id??saved?.catalogue;
      if(restoredCatalogue&&!this.data.catalogues.some(c=>c.catalogue_id===restoredCatalogue)){
        const catalogue=await this.request<WorkpaperCatalogue>('GET','/catalogues/'+encodeURIComponent(restoredCatalogue));
        this.data.catalogues.push(catalogue);
      }
      this.catalogue=this.data.catalogues.find(c=>c.catalogue_id===(this.pending?.catalogue_id??saved?.catalogue))??this.data.catalogues[0];
      this.selected=new Set(this.pending?.item_ids??(saved&&this.catalogue&&saved.catalogue===this.catalogue.catalogue_id?saved.selected:undefined)??defaultWorkpaperIds(this.catalogue?.entries??[])??[]);
      const affectedId=new URLSearchParams(location.hash.split('?')[1]).get('workpaper_batch');
      if(affectedId&&!this.pending){
        const batch=this.data.batches.find(b=>b.batch_id===affectedId)??await this.request<WorkpaperBatch>('GET','/batches/'+encodeURIComponent(affectedId));
        this.catalogue=this.data.catalogues.find(c=>c.catalogue_id===batch.catalogue_id)??await this.request<WorkpaperCatalogue>('GET','/catalogues/'+encodeURIComponent(batch.catalogue_id));
        if(!this.data.catalogues.some(c=>c.catalogue_id===this.catalogue!.catalogue_id))this.data.catalogues.push(this.catalogue);
        const checks=await this.request<{checks:import('@bondbuddy/contracts').WorkpaperCheck[]}>('GET','/checks');
        const check=checks.checks.find(c=>c.batch_id===affectedId&&!c.stale&&c.result);
        this.selected=new Set(check?check.result!.items.filter(i=>i.status!=='current').map(i=>i.item_id):[]);
        this.status=check?'已选择受影响及需核对的底稿，可按当前募集书直接重新编制。':'请先用当前募集书完成本批检查，再选择需重新编制的底稿。';
      }
      this.requirements=this.pending?.requirements??saved?.requirements??'';this.paint();this.poll();
      if(new URLSearchParams(location.hash.split('?')[1]).get('view')==='results'){
        const results=this.progressBatch?[...this.host.querySelectorAll<HTMLElement>('[data-wp-batch-id]')].find(el=>el.dataset.wpBatchId===this.progressBatch):this.host.querySelector<HTMLElement>('#wp-batches');
        if(results){results.tabIndex=-1;results.focus({preventScroll:true});results.scrollIntoView({block:'start'});}
      }
    }catch(e){if(this.live()){this.host.innerHTML='<p role="status">底稿记录暂时无法读取。原记录已保留，请刷新重试。</p>';}}
  }
  private paint(){
    if(!this.live())return;
    this.stepChanged(this.view==='prepare'?2:this.view==='confirm'?3:4);
    const sourceHref='#generate?'+withProjectContext(new URLSearchParams({project:this.project,step:'source',mode:'workpapers'}));
    this.host.innerHTML=`<div class="wp-source-context ${this.source?'':'wp-source-missing'}" ${this.view!=='prepare'?'hidden':''}><span class="wp-source-icon">${ico('file')}</span><div class="wp-source-info"><small>生成依据 · 募集说明书</small><div class="wp-source-file"><strong>${this.source?esc(this.source.filename):'请先上传并采用募集说明书'}</strong>${this.source?`<span class="wp-source-version">V${this.source.sequence}</span>`:''}</div></div><a class="text-button" href="${esc(sourceHref)}">更换</a></div>
      <section class="panel wp-prepare" aria-label="按底稿目录批量生成" ${this.view!=='prepare'?'hidden':''}><h2>选择要生成的文件</h2>${this.catalogue?`<div class="wp-directory-current">${ico('folder')}<div><strong>${esc(this.catalogue.filename)}</strong><small>${this.catalogue.entries.filter(e=>e.kind==='file').length} 份文件已识别</small></div><button class="text-button" id="wp-change-directory" ${this.pending||this.busy?'disabled':''}>更换目录</button></div><div id="wp-directory-editor" hidden><label>选择项目已有目录<select id="wp-catalogue" ${this.pending||this.busy?'disabled':''}>${this.data.catalogues.map(c=>`<option value="${esc(c.catalogue_id)}" ${this.catalogue?.catalogue_id===c.catalogue_id?'selected':''}>${esc(c.filename)}</option>`).join('')}</select></label><label>上传新目录<input id="wp-upload" type="file" accept=".xlsx" aria-label="上传底稿目录（XLSX，10 MB 以内）" ${this.pending||this.busy?'disabled':''}></label><p class="muted">XLSX · 10 MB 以内</p></div>`:`<div class="wp-upload-zone"><span class="wp-upload-icon">${ico('upload')}</span><h2>添加底稿目录</h2><p>默认生成“1 尽职调查文件”；可以在清单中调整范围。</p><label class="wp-upload-picker"><span class="btn primary">${ico('plus')}选择 Excel 底稿目录</span><input id="wp-upload" type="file" accept=".xlsx" aria-label="上传底稿目录（XLSX，10 MB 以内）" aria-describedby="wp-upload-help" ${this.pending||this.busy?'disabled':''}></label><small id="wp-upload-help">XLSX · 10 MB 以内 · 最多 ${WORKPAPER_LIMITS.items.toLocaleString()} 份文件</small></div><details class="wp-format-help"><summary>Excel 目录怎么准备？</summary><p>至少包含“底稿名称”或“文件名称”列；可提供“编号、目录路径、类型、编制要求”。文件夹在“类型”列填写“目录”。旧版 XLS 请另存为 XLSX。</p></details>`}
      <div id="wp-upload-recovery"></div><p id="wp-status" role="status">${esc(this.status)}</p>
      ${this.catalogue?`<details ${this.catalogue.warnings.length?'open':''}><summary>目录识别提示（${this.catalogue.warnings.length}）</summary>${this.catalogue.warnings.map(w=>`<p>${esc(w)}</p>`).join('')}</details>
      <div class="wp-controls"><label>查找底稿<span class="wp-search-field">${ico('search')}<input id="wp-filter" type="search" value="${esc(this.filter)}" placeholder="搜索编号或名称"></span></label><div class="wp-selection-actions" role="group" aria-label="底稿选择操作"><button class="btn secondary" id="wp-all" ${this.pending||this.busy?'disabled':''}>选择全部文件</button><button class="btn secondary" id="wp-none" ${this.pending||this.busy?'disabled':''}>清空选择</button></div></div><div id="wp-entries"></div>
      <div class="wp-requirements-block"><label for="wp-requirements">本批编制要求 <span>选填</span></label><p id="wp-requirements-help">统一应用于本批底稿，可补充编制口径、格式或重点关注事项。</p><textarea id="wp-requirements" rows="3" maxlength="12000" placeholder="例如：金额统一使用万元，资料缺失处保留待核实标记。" aria-describedby="wp-requirements-help" ${this.pending||this.busy?'disabled':''}>${esc(this.requirements)}</textarea></div>
      <div id="wp-confirm"></div>`:''}<p class="wp-explanation-note">不生成项将逐份附说明；资料不足或缺少原始证据时标注“暂无法生成”，不直接认定为业务不适用。</p></section><section id="wp-confirmation-page" ${this.view==='confirm'?'':'hidden'}></section><section class="wp-batches" id="wp-batches" aria-label="底稿生成任务" ${this.view==='results'?'':'hidden'}></section><footer class="pf-footer" ${this.view==='confirm'?'hidden':''}><a class="text-button" href="${esc(sourceHref)}">上一步：选择募集说明书</a>${this.view==='results'?'<button class="btn secondary" id="wp-prepare-again">准备下一批</button>':''}</footer>`;
    this.host.querySelector('#wp-change-directory')?.addEventListener('click',()=>{const editor=this.host.querySelector<HTMLElement>('#wp-directory-editor')!;editor.hidden=!editor.hidden;if(!editor.hidden)editor.querySelector('select')?.focus();});
    this.host.querySelector('#wp-prepare-again')?.addEventListener('click',()=>{this.view='prepare';const query=new URLSearchParams(location.hash.split('?')[1]);query.delete('view');query.delete('batch');history.replaceState(history.state,'','#generate?'+query);this.paint();});
    this.host.querySelector('#wp-upload')?.addEventListener('change',e=>{const file=(e.target as HTMLInputElement).files?.[0];if(file)void this.importFile(file);});
    this.host.querySelector('#wp-catalogue')?.addEventListener('change',e=>{this.catalogue=this.data.catalogues.find(c=>c.catalogue_id===(e.target as HTMLSelectElement).value);this.selected=new Set(defaultWorkpaperIds(this.catalogue?.entries??[]));this.save();this.paint();});
    this.host.querySelector('#wp-filter')?.addEventListener('input',e=>{this.filter=(e.target as HTMLInputElement).value;this.paintEntries();});
    this.host.querySelector('#wp-all')?.addEventListener('click',()=>{this.selected=new Set(this.catalogue!.entries.filter(e=>e.kind==='file').map(e=>e.id));this.save();this.paintEntries();});
    this.host.querySelector('#wp-none')?.addEventListener('click',()=>{this.selected.clear();this.save();this.paintEntries();});
    this.host.querySelector('#wp-requirements')?.addEventListener('input',e=>{this.requirements=(e.target as HTMLTextAreaElement).value;this.save();this.paintConfirm();});
    this.paintEntries();this.paintBatches();this.paintRecovery();if(this.view==='confirm')this.paintConfirmationPage();
  }
  private paintEntries(){
    const node=this.host.querySelector('#wp-entries');if(!node||!this.catalogue)return;
    node.querySelectorAll<HTMLDetailsElement>('[data-wp-folder]').forEach(d=>{if(d.open)this.expandedFolders.add(d.dataset.wpFolder!);else this.expandedFolders.delete(d.dataset.wpFolder!);});
    const all=this.catalogue.entries.filter(e=>e.kind==='file'),entries=all.filter(e=>!this.filter||`${e.code} ${e.title} ${e.folder}`.includes(this.filter));
    const folders=[...new Set(entries.map(e=>e.folder||'根目录'))];
    node.innerHTML=entries.length?`<div class="wp-file-tree">${folders.map((folder,index)=>{const files=entries.filter(e=>(e.folder||'根目录')===folder),group=all.filter(e=>(e.folder||'根目录')===folder),selected=group.filter(e=>this.selected.has(e.id)).length;return `<details class="wp-file-group" data-wp-folder="${esc(folder)}" ${this.filter||this.expandedFolders.has(folder)||!this.expandedFolders.size&&index===0?'open':''}><summary><input type="checkbox" data-wp-group="${esc(folder)}" aria-label="选择目录 ${esc(folder)}" ${selected===group.length?'checked':''} data-partial="${selected>0&&selected<group.length}" ${this.pending||this.busy?'disabled':''}><span>${esc(folder)}</span><small>${selected} / ${group.length}</small></summary>${files.map(e=>`<div class="wp-file-row"><input id="wp-file-${esc(e.id)}" type="checkbox" aria-label="选择 ${esc(e.title)}" data-wp-item="${esc(e.id)}" ${this.selected.has(e.id)?'checked':''} ${this.pending||this.busy?'disabled':''}><label for="wp-file-${esc(e.id)}">${esc(e.code)} ${esc(e.title)}${e.instructions?`<small>${esc(e.instructions)}</small>`:''}</label></div>`).join('')}</details>`;}).join('')}</div>`:'<p class="muted">没有匹配的文件，请换一个编号或名称。</p>';
    node.querySelectorAll<HTMLInputElement>('[data-partial=true]').forEach(c=>c.indeterminate=true);
    node.querySelectorAll<HTMLInputElement>('[data-wp-group]').forEach(c=>{c.addEventListener('click',e=>e.stopPropagation());c.addEventListener('change',()=>{for(const entry of all.filter(e=>(e.folder||'根目录')===c.dataset.wpGroup))c.checked?this.selected.add(entry.id):this.selected.delete(entry.id);this.save();this.paintEntries();});});
    node.querySelectorAll<HTMLInputElement>('[data-wp-item]').forEach(c=>c.addEventListener('change',()=>{c.checked?this.selected.add(c.dataset.wpItem!):this.selected.delete(c.dataset.wpItem!);this.save();const folder=c.closest<HTMLDetailsElement>('[data-wp-folder]')!,group=all.filter(e=>(e.folder||'根目录')===folder.dataset.wpFolder),selected=group.filter(e=>this.selected.has(e.id)).length,checkbox=folder.querySelector<HTMLInputElement>('[data-wp-group]')!;checkbox.checked=selected===group.length;checkbox.indeterminate=selected>0&&selected<group.length;folder.querySelector('summary small')!.textContent=`${selected} / ${group.length}`;this.paintConfirm();}));this.paintConfirm();
  }
  private paintConfirm(){
    const node=this.host.querySelector('#wp-confirm');if(!node)return;
    if(this.pending){
      node.innerHTML='<p>上次已提交 '+this.pending.item_ids.length+' 项，费用上限 '+this.pending.expected_points.toLocaleString()+' 积分。请先确认上次提交结果，仍使用原请求。</p><button class="btn primary" id="wp-start" '+(this.busy||this.storageError?'disabled':'')+'>继续确认上次提交</button>';
      node.querySelector('#wp-start')?.addEventListener('click',()=>void this.start());return;
    }
    const count=this.selected.size,active=this.data.batches.some(b=>['queued','running','paused'].includes(b.state));
    const disabled=!count||!this.source||this.busy||this.storageError||active;
    const hint=this.storageError?'浏览器未能保存请求，请恢复存储后重试。'
      :active?'已有底稿文件包正在处理，请在下方查看进度或继续原文件包。'
      :!this.source?'请先上传并采用募集说明书，再开始批量生成。'
      :!count?'请先在目录中勾选需要生成的底稿。'
      :this.busy?'正在提交，请稍候。'
      :'先核对生成范围和费用，确认后开始逐份编制。';
    const focusId=node.contains(document.activeElement)?document.activeElement?.id:undefined;
    node.innerHTML=`<div class="wp-confirm-heading"><div><h3>批量生成底稿</h3><p>按所选目录逐份编制，资料不足或不适用的条目附具体说明。</p></div><span class="wp-selection-count">已选 <strong>${count}</strong> 份底稿</span></div>
      <p class="wp-confirm-source">本批依据：${this.source?`${esc(this.source.filename)} · V${this.source.sequence}`:'请先选择募集说明书'}</p>
      <div class="wp-confirm-actions"><div class="wp-fee-summary"><span>本批费用上限 <strong>${(count*WORKPAPER_PRICE.points).toLocaleString()}</strong> 积分</span><small>每份底稿 ${WORKPAPER_PRICE.points.toLocaleString()} 积分</small></div><div class="wp-action-area"><p id="wp-action-hint">${hint}</p><div class="wp-action-buttons">${active?'<a class="btn secondary" id="wp-view-progress" href="#wp-batches">查看生成进度</a>':''}<button class="btn primary" id="wp-start" aria-describedby="wp-action-hint wp-fee-note" ${disabled?'disabled':''}>下一步：确认生成</button></div></div></div>
      <p class="wp-fee-note" id="wp-fee-note">生成底稿按处理进度逐份计费；仅形成说明的条目不收取生成积分，已扣部分自动退回。</p>`;
    if(focusId)node.querySelector<HTMLElement>('#'+focusId)?.focus({preventScroll:true});
    node.querySelector('#wp-start')?.addEventListener('click',()=>{if(!disabled){this.view='confirm';this.paint();this.host.querySelector<HTMLElement>('#wp-confirm-start')?.focus();}});
    node.querySelector('#wp-view-progress')?.addEventListener('click',e=>{e.preventDefault();this.view='results';this.paint();this.host.querySelector('#wp-batches')?.scrollIntoView({block:'start'});});
  }
  private paintConfirmationPage(){
    const node=this.host.querySelector<HTMLElement>('#wp-confirmation-page');if(!node||this.view!=='confirm')return;
    const count=this.pending?.item_ids.length??this.selected.size,total=this.pending?.expected_points??count*WORKPAPER_PRICE.points;
    const confirmedSource=this.pending&&this.source?.version_id!==this.pending.source_version_id?null:this.source;
    node.innerHTML=`<section class="panel pf-flow-confirm"><h2>确认本次生成</h2><p>核对募集说明书、生成范围及预计积分。</p><div class="pf-confirm-section"><h3>募集说明书</h3><p>${esc(confirmedSource?.filename??'原提交已固定的募集说明书（保留原版本）')} ${confirmedSource?'· V'+confirmedSource.sequence:''}</p></div><div class="pf-confirm-section"><h3>生成内容</h3><p>${esc(this.catalogue?.filename??'')} · ${count} 份文件</p><details><summary>查看所选文件</summary><ul>${this.catalogue?.entries.filter(e=>(this.pending?.item_ids??[...this.selected]).includes(e.id)).map(e=>`<li>${esc(e.code)} ${esc(e.title)}</li>`).join('')??''}</ul></details>${this.requirements?`<p>本批编制要求：${esc(this.requirements)}</p>`:''}</div><p>可编制的条目形成文件；业务不适用或资料不足的条目分别写明情况。成果按“可生成文件”和“不适用说明”两个文件夹打包。</p><div class="pf-confirm-total">本批费用上限 <strong>${total.toLocaleString()}</strong> 积分</div><p class="muted">仅形成说明的条目不收取生成积分，已扣部分自动退回。</p><p id="wp-confirm-status" role="status">${esc(this.status)}</p><footer class="pf-footer"><button class="btn secondary" id="wp-confirm-back" ${this.busy?'disabled':''}>上一步：调整范围</button><button class="btn primary" id="wp-confirm-start" ${this.busy||this.storageError?'disabled':''}>${this.pending?'继续确认上次提交':'确认并开始生成'}</button></footer></section>`;
    node.querySelector('#wp-confirm-back')!.addEventListener('click',()=>{this.view='prepare';this.paint();});
    node.querySelector('#wp-confirm-start')!.addEventListener('click',()=>void this.start());
  }
  private paintRecovery(){
    const node=this.host.querySelector('#wp-upload-recovery');if(!node)return;
    try{const records=new UploadRecovery(this.api,this.owner,this.project,'workpaper-catalogue',()=>this.live()).list();
      node.innerHTML=records.map(r=>`<p>待确认上传：${esc(r.declaration.filename)} <button class="btn secondary" data-wp-upload="${esc(r.id)}">继续确认</button> <label>重新选择原文件<input type="file" accept=".xlsx" data-wp-reselect="${esc(r.id)}"></label></p>`).join('');
      node.querySelectorAll<HTMLElement>('[data-wp-upload]').forEach(b=>b.onclick=()=>void this.importFile(undefined,b.dataset.wpUpload));
      node.querySelectorAll<HTMLInputElement>('[data-wp-reselect]').forEach(b=>b.onchange=()=>void this.importFile(b.files?.[0],b.dataset.wpReselect));
    }catch{node.textContent='原上传记录无法读取，请恢复浏览器存储后刷新。';}
  }
  private async act(fn:()=>Promise<void>){if(this.busy)return;this.busy=true;this.paintConfirm();this.paintConfirmationPage();try{await fn();}catch(e){this.status=friendlyError(e,'submit');}finally{this.busy=false;if(this.live()){this.host.querySelectorAll('#wp-status,#wp-results-status').forEach(node=>node.textContent=this.status);this.paintConfirm();this.paintConfirmationPage();this.paintRecovery();}}}
  private async importFile(file?:File,operation?:string){
    if(this.pending||this.busy)return;
    await this.act(async()=>{
      if(file&&(!/\.xlsx$/i.test(file.name)||file.size>WORKPAPER_LIMITS.fileBytes))throw new UserFacingError('请上传 10 MB 以内的 XLSX。');
      if(operation)this.upload={operationId:operation,projectId:this.project};else if(file)this.upload={};
      const pin=await uploadFileMaterial(this.api,this.project,file,this.controller.signal,s=>{this.status=s;const n=this.host.querySelector('#wp-status');if(n)n.textContent=s;},this.upload,this.owner,'workpaper-catalogue',undefined,()=>this.live());
      const cat=await this.request<WorkpaperCatalogue>('POST','/catalogues',{request_id:this.upload.operationId,material:pin});
      await this.upload.recovery?.forget(this.upload.operationId!);this.upload={};this.catalogue=cat;
      this.data.catalogues=[cat,...this.data.catalogues.filter(c=>c.catalogue_id!==cat.catalogue_id)];this.selected=new Set(defaultWorkpaperIds(cat.entries));this.status='目录已保存，选好文件后即可开始批量生成。';this.save();this.paint();
    });
  }
  private async start(){await this.act(async()=>{
    if(!this.pending){if(!this.catalogue||!this.source||!this.selected.size)return;
      this.pending={start_mode:'direct',request_id:crypto.randomUUID(),catalogue_id:this.catalogue.catalogue_id,catalogue_sha256:this.catalogue.sha256,item_ids:[...this.selected],source_version_id:this.source.version_id,source_selection_revision:this.source.selection_revision,requirements:this.requirements,price_version:WORKPAPER_PRICE.version,expected_points:this.selected.size*WORKPAPER_PRICE.points};
      if(!this.save())return;this.paint();}
    let batch:WorkpaperBatch;
    try{batch=await this.request<WorkpaperBatch>('POST','/batches',this.pending);}catch(e){
      if(e instanceof ApiError&&e.code==='PROJECT_FILE_BATCH_INPUT_EXPIRED'){this.pending=undefined;this.save();this.source=null;this.view='prepare';this.paint();throw new UserFacingError('原底稿文件包未提交。募集书依据已变化，请刷新页面后重新核对并提交。');}throw e;
    }
    this.pending=undefined;this.save();this.data.batches=[batch,...this.data.batches.filter(b=>b.batch_id!==batch.batch_id)];this.status='底稿文件包已提交，关闭页面后仍会继续。';this.view='results';this.progressBatch=batch.batch_id;this.expandedBatches.set(batch.batch_id,false);const query=new URLSearchParams(location.hash.split('?')[1]);query.set('view','results');query.set('batch',batch.batch_id);history.replaceState(history.state,'','#generate?'+query);this.paint();this.poll();
  });}
  private paintBatches(){
    const node=this.host.querySelector('#wp-batches');if(!node)return;
    node.querySelectorAll<HTMLDetailsElement>('details[data-batch]').forEach(e=>this.expandedBatches.set(e.dataset.batch!,e.open));
    node.innerHTML=`<h2>底稿生成进度</h2><p id="wp-results-status" role="status">${esc(this.status)}</p>${!this.data.batches.length?'<p class="muted">尚未提交底稿文件包。</p>':''}${this.data.batches.map(b=>{
      const done=b.items.filter(i=>i.state==='succeeded').length,failed=b.items.filter(i=>['failed','rejected','cancelled'].includes(i.state)&&i.run_id).length;
      return `<article class="panel wp-batch" data-wp-batch-id="${esc(b.batch_id)}"><div class="wp-batch-heading"><h3>底稿文件包 <span class="wp-batch-state" data-state="${esc(b.state)}">${esc(stateNames[b.state])}</span></h3><span class="wp-batch-count"><strong>${done}</strong> / ${b.items.length} 份完成${failed?` · ${failed} 份未完成`:''}</span></div><progress max="${b.items.length}" value="${done}" aria-label="底稿完成进度"></progress><dl class="wp-batch-meta"><div><dt>生成依据</dt><dd>${esc(b.source.filename)} · V${b.source.sequence}</dd></div><div><dt>提交时间</dt><dd>${date(b.created_at)}</dd></div><div><dt>已扣积分</dt><dd>${b.charged_points.toLocaleString()} 积分</dd></div></dl>${b.error?`<p role="status">${esc(b.error)}</p>`:''}
      <div class="wp-actions">${done?`<button class="btn primary" data-wp-zip="${esc(b.batch_id)}">下载已完成文件（ZIP）</button>`:''}${(['queued','running'].includes(b.state)?['pause','cancel']:b.state==='paused'?['resume','cancel']:b.state==='partial'||b.state==='cancelled'?['retry_failed']:[]).map(action=>`<button class="btn secondary" data-wp-action="${action}" data-batch="${esc(b.batch_id)}">${({pause:'当前文件后暂停',resume:'继续文件包',cancel:'结束后续排队',retry_failed:'重试未完成项'} as Record<string,string>)[action]}</button>`).join('')}</div>
      <details data-batch="${esc(b.batch_id)}" ${(this.expandedBatches.get(b.batch_id)??b.batch_id===this.progressBatch)?'open':''}><summary>查看逐份状态与下载</summary><ul class="wp-items">${b.items.map(i=>`<li><div><strong>${esc(i.entry.code)} ${esc(i.entry.title)}</strong><small>${esc(runStateLabel[i.state as keyof typeof runStateLabel]??stateNames[i.state]??i.state)}${i.explanation?' · 已生成不适用说明':''}${i.error?' · '+esc(i.error):''}</small></div><div class="wp-actions">${i.explanation?'<button class="text-button" data-wp-explanation="'+esc(i.entry.id)+'" data-batch="'+esc(b.batch_id)+'">下载不适用说明</button>':''}${i.artifacts.filter(a=>a.kind==='document').map(a=>`<button class="text-button" data-wp-art="${esc(a.pin.artifact_id)}" data-wp-batch="${esc(b.batch_id)}">${a.kind==='document'?'下载底稿':'编制说明'}</button>`).join('')}${i.run_id?`<a href="#generate?topic=${encodeURIComponent(b.topic_id)}&run=${encodeURIComponent(i.run_id)}&return_project=${encodeURIComponent(this.project)}">任务详情</a>`:''}</div></li>`).join('')}</ul></details></article>`;}).join('')}`;
    node.querySelectorAll<HTMLDetailsElement>('details[data-batch]').forEach(el=>el.addEventListener('toggle',()=>{if(el.isConnected)this.expandedBatches.set(el.dataset.batch!,el.open);}));
    node.querySelectorAll<HTMLElement>('[data-wp-action]').forEach(el=>el.onclick=()=>void this.act(async()=>{const b=this.data.batches.find(b=>b.batch_id===el.dataset.batch)!;const changed=await this.request<WorkpaperBatch>('POST',`/batches/${encodeURIComponent(b.batch_id)}/actions`,{action:el.dataset.wpAction,expected_revision:b.revision});this.data.batches=this.data.batches.map(b=>b.batch_id===changed.batch_id?changed:b);this.paintBatches();this.poll();}));
    node.querySelectorAll<HTMLElement>('[data-wp-zip]').forEach(el=>el.onclick=()=>void this.act(async()=>{const bytes=await this.api.workpaperZip(this.project,el.dataset.wpZip!,this.controller.signal);if(this.live())this.downloads.save(bytes,'底稿文件包.zip');}));
    node.querySelectorAll<HTMLElement>('[data-wp-explanation]').forEach(el=>el.onclick=()=>void this.act(async()=>{
      const batch=this.data.batches.find(b=>b.batch_id===el.dataset.batch)!,item=batch.items.find(i=>i.entry.id===el.dataset.wpExplanation)!;
      const bytes=await this.api.workpaperExplanation(this.project,batch.batch_id,item.entry.id,this.controller.signal);
      if(this.live())this.downloads.save(bytes,item.explanation!.filename);
    }));
    node.querySelectorAll<HTMLElement>('[data-wp-art]').forEach(el=>el.onclick=()=>void this.act(async()=>{const batch=this.data.batches.find(b=>b.batch_id===el.dataset.wpBatch)!,artifact=batch.items.flatMap(i=>i.artifacts).find(a=>a.pin.artifact_id===el.dataset.wpArt)!;const metadata=await this.api.request<import('./api').Dto<'ArtifactResponse'>>('GET',`/artifacts/${encodeURIComponent(artifact.pin.artifact_id)}?version=${artifact.pin.artifact_version}`,undefined,{},this.controller.signal);const bytes=await this.api.artifactBytes(metadata,this.controller.signal);if(this.live())this.downloads.save(bytes,artifact.filename);}));
  }
  private poll(){clearTimeout(this.timer);if(!this.live())return;this.timer=setTimeout(()=>void(async()=>{
    try{if(!this.busy){const data=await this.readWorkspace();if(this.live()){
      // Keep the submit control stable while batch availability is unchanged.
      const confirmationState=()=>this.data.batches.some(b=>['queued','running','paused'].includes(b.state));
      const previous=confirmationState();this.data=data;this.paintBatches();if(previous!==confirmationState())this.paintConfirm();
    }}}catch{this.host.querySelectorAll('#wp-status,#wp-results-status').forEach(node=>node.textContent='进度暂时无法读取，后台任务继续；稍后自动重试。');}finally{this.poll();}
  })(),5000);}
}
