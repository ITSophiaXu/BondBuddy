import { ProjectEntry } from './project-entry';
import {PROJECT_DOCUMENT_CATALOG,PROJECT_DOCUMENT_FOLDERS,MARKET_LABELS,OFFERING_LABELS,MARKET_OFFERINGS,M1_UPLOAD_MIME_TYPES,M1_UPLOAD_LIMITS,M4_DOCUMENT_FIXED_PRICE,
  type M4Workspace,type M4DocumentType,type M4Template,type M4MaterialPin,type ProjectFileSource,type ProjectFileVersion,type ProjectFileBatch} from '@bondbuddy/contracts';
import {ApiClient,ApiError,friendlyError,type Dto} from './api';
import {ArtifactDownloads} from './artifact-download';
import {M4Api} from './m4-api';
import {ProspectusPanel} from './prospectus-panel';
import {esc,date} from './ui';
import {prototypeIcon as ico} from './prototype-design';
import {runStateLabel} from './review-state';
import './file-workspace.css';

type Workspace=import('@bondbuddy/contracts').ProjectFileWorkspace;
export async function uploadFileMaterial(api:ApiClient,id:string,file:File,signal:AbortSignal,status:(s:string)=>void):Promise<M4MaterialPin>{
  const ext=file.name.split('.').at(-1)?.toLowerCase(),mime=ext==='docx'?M1_UPLOAD_MIME_TYPES[0]:ext==='pdf'?M1_UPLOAD_MIME_TYPES[1]:ext==='xlsx'?M1_UPLOAD_MIME_TYPES[2]:null;
  if(!mime||!file.size||file.size>M1_UPLOAD_LIMITS.fileBytes)throw new Error('请上传不超过 100 MB 的 DOCX、PDF 或 XLSX 文件。');
  const sha256=[...new Uint8Array(await crypto.subtle.digest('SHA-256',await file.arrayBuffer()))].map(x=>x.toString(16).padStart(2,'0')).join('');
  const upload=await api.createUpload(id,{filename:file.name,media_type:mime,role:'other',sha256,byte_size:file.size},signal);
  await api.uploadBytes(upload.upload_url,file,(n,total)=>status(`正在上传 ${Math.round(n/total*100)}%…`),signal);
  const m=await api.completeUpload(id,upload.upload_id,{sha256,byte_size:file.size},signal);
  return {source_project_id:id,material_id:m.material_id,material_version:m.material_version,sha256:m.sha256};
}

export class FileWorkspace {
  private downloads=new ArtifactDownloads();private controller=new AbortController();private m4:M4Api;private panel?:ProspectusPanel;private dialog?:HTMLDialogElement;
  private state?:Workspace;private project?:Dto<'ProjectResponse'>;private selected=new Set<M4DocumentType>();private busy=false;
  private timer?:ReturnType<typeof setTimeout>;private pendingBatch?:{request_id:string;source_version_id:string;expected_selection_revision:number;documents:{document_type:M4DocumentType;draft_version:number}[]};
  private entry?:ProjectEntry;
  constructor(private api:ApiClient,private shell:(html:string,section:string)=>void,private current:()=>boolean,private id?:string){this.m4=new M4Api(api,this.controller.signal);}
  private live(){return this.current()&&!this.controller.signal.aborted;}
  get hasUnconfirmed(){
    const field=document.querySelector<HTMLTextAreaElement>('#pf-requirements');
    return this.busy||!!this.panel?.busy||!!(field&&this.state&&Object.values(this.state.workspace.drafts).some(d=>d.supplemental_requirements!==field.value.trim()));
  }
  async beforeLeave(){
    if(this.busy||this.panel?.busy)return false;
    const requirements=document.querySelector<HTMLTextAreaElement>('#pf-requirements');
    if(requirements&&this.state){
      try{await this.saveRequirements(requirements.value.trim());}
      catch(e){this.status('生成要求尚未保存。'+friendlyError(e));return false;}
    }
    return true;
  }
  dispose(){this.entry?.dispose();this.controller.abort();this.downloads.dispose();clearTimeout(this.timer);this.panel?.dispose();this.dialog?.remove();}
  private request<T>(method:'GET'|'POST',suffix:string,body?:unknown){return this.api.request<T>(method,`/projects/${encodeURIComponent(this.id!)}/project-files${suffix}`,body,{},this.controller.signal);}
  async render(){
    this.shell('<p role="status">正在读取文件生成…</p>','generate');
    if(!this.id){await this.chooseProject();return;}
    try{this.project=await this.api.project(this.id,this.controller.signal);this.state=await this.request<Workspace>('POST','/workspace',{request_id:crypto.randomUUID()});if(this.live()){this.selected=new Set(PROJECT_DOCUMENT_CATALOG.filter(d=>this.state!.workspace.drafts[d.id].template).map(d=>d.id));await this.paint();}}
    catch(e){if(this.live())this.shell(`<div class="collection-empty"><h1>文件生成暂时无法打开</h1><p role="alert">${esc(friendlyError(e))}</p><a class="btn secondary" href="#generate">重新选择项目</a></div>`,'generate');}
  }
  private status(s:string){const node=document.querySelector('#pf-status');if(node)node.textContent=s;}
  private async act(fn:()=>Promise<void>){if(this.busy||this.panel?.busy)return;this.busy=true;this.status('正在保存…');try{await fn();}catch(e){if(this.live())this.status(e instanceof ApiError?friendlyError(e):e instanceof Error?e.message:'操作未完成，请重试。');}finally{this.busy=false;if(this.live()&&document.querySelector('#pf-template-list'))this.paintTemplates();}}
  private header(step:string){return `<a class="back-link" href="#tasks">← 返回全部项目</a><div class="page-head"><div><div class="eyebrow">FILE GENERATION</div><h1>${step==='documents'?'选择要生成的关联文件':'文件生成'}</h1><p>按项目目录选择文件，基于募集说明书与已保存模板生成，完成后统一归入项目。</p></div></div>
    ${this.id?`<nav class="pf-steps" aria-label="文件生成步骤"><a href="#generate">1 选择项目</a><a ${step==='source'?'aria-current="step"':''} href="#generate?project=${this.id}&step=source">2 选择募集说明书</a><a ${['documents','results'].includes(step)?'aria-current="step"':''} href="#generate?project=${this.id}&step=documents">3 生成关联文件</a></nav><div class="pf-source-strip pf-project-strip">${ico('folder')}<div><strong>${esc(this.project!.name)}</strong><small>${esc(this.project!.issuer_name??'发行人待填写')} · ${MARKET_LABELS[this.project!.market as keyof typeof MARKET_LABELS]??''} · ${OFFERING_LABELS[this.project!.offering as keyof typeof OFFERING_LABELS]??''}</small></div><a class="text-button" href="#generate">更换项目</a><a class="text-button" href="#/projects/${this.id}/files">项目文件 →</a></div>`:''}`;}
  private async chooseProject(){
    this.entry=new ProjectEntry(this.api,this.shell,()=>this.live(),{section:'generate',title:'文件生成',eyebrow:'FILE GENERATION',
      description:'先选择项目，基于募集说明书与已保存模板生成关联文件，完成后统一归入项目。',
      steps:['选择项目','选择募集说明书','生成关联文件'],next:'下一步：选择募集说明书',onNew:()=>this.newProject(),
      open:async(id)=>{if(this.live())location.hash='generate?project='+encodeURIComponent(id)+'&step=source';}});
    await this.entry.render();
  }
  private modal(title:string,body:string){this.dialog?.remove();const d=document.createElement('dialog');d.className='pf-modal';d.innerHTML=`<header><h2>${esc(title)}</h2><button class="icon-btn" data-close aria-label="关闭">${ico('close')}</button></header>${body}<p id="pf-modal-status" role="status"></p>`;document.body.append(d);d.showModal();d.querySelector('[data-close]')!.addEventListener('click',()=>{if(!this.busy)d.close();});d.addEventListener('cancel',e=>{if(this.busy)e.preventDefault();});d.addEventListener('close',()=>d.remove());this.dialog=d;return d;}
  private newProject(){
    const d=this.modal('新建项目',`<form id="pf-new-form"><label>项目名称<input name="name" required maxlength="200"/></label><label>发行人全称<input name="issuer_name" required maxlength="200"/></label><label>市场<select name="market">${Object.entries(MARKET_LABELS).map(([k,v])=>`<option value="${k}">${v}</option>`).join('')}</select></label><label>品种<select name="offering"></select></label><button class="btn primary">创建项目并添加募集说明书</button></form>`);
    const market=d.querySelector<HTMLSelectElement>('[name=market]')!,offering=d.querySelector<HTMLSelectElement>('[name=offering]')!;
    const sync=()=>{offering.innerHTML=MARKET_OFFERINGS[market.value as keyof typeof MARKET_OFFERINGS].map(v=>`<option value="${v}">${OFFERING_LABELS[v]}</option>`).join('');};market.addEventListener('change',sync);sync();
    const key=crypto.randomUUID();d.querySelector('form')!.addEventListener('submit',e=>{e.preventDefault();if(this.busy)return;this.busy=true;const data=new FormData(e.target as HTMLFormElement);
      void this.api.request<Dto<'ProjectResponse'>>('POST','/projects',{creation_request_id:key,kind:'generation',name:data.get('name'),issuer_name:data.get('issuer_name'),market:market.value,offering:offering.value}, {},this.controller.signal)
        .then(p=>{if(this.live()){d.close();location.hash=`generate?project=${p.project_id}&step=source`;}}).catch(e=>{d.querySelector('#pf-modal-status')!.textContent=friendlyError(e);}).finally(()=>{this.busy=false;});});
  }
  private async paint(){
    if(!this.state||!this.live())return;this.panel?.dispose();this.panel=undefined;
    const step=new URLSearchParams(location.hash.split('?')[1]).get('step')??'source';
    if(step==='source'){
      this.shell(`${this.header(step)}<section class="pf-source-intro"><h2>选择本次生成依据的募集说明书</h2><p>上传新稿或使用项目当前版本；文件生成会固定本次采用的版本。</p></section><div id="pf-prospectus"></div><p id="pf-status" role="status"></p><footer class="pf-footer"><a class="btn secondary" href="#generate">重新选择项目</a><button class="btn primary" id="pf-source-next" ${this.state.source?'':'disabled'}>使用当前募集书，选择文件 →</button></footer>`,'generate');
      const sourceProject=this.state.source?.project_id??this.id!;
      this.panel=new ProspectusPanel(this.api,sourceProject,document.querySelector('#pf-prospectus')!,async()=>!this.busy,async()=>{this.state=await this.request<Workspace>('GET','/workspace');await this.paint();},()=>{},'generation');await this.panel.refresh();
      document.querySelector('#pf-source-next')!.addEventListener('click',()=>void this.act(async()=>{
        const s=this.state!.source!;this.state=await this.request<Workspace>('POST','/source',{source_version_id:s.version_id,expected_selection_revision:s.selection_revision});location.hash=`generate?project=${this.id}&step=documents`;
      }));return;
    }
    if(step==='results'){this.paintResults();return;}
    if(!this.state.source){location.hash=`generate?project=${this.id}&step=source`;return;}
    const w=this.state.workspace;
    if(!Object.values(w.drafts).some(d=>d.project_file?.source_version_id===this.state!.source!.version_id&&d.project_file.source_selection_revision===this.state!.source!.selection_revision)){location.hash=`generate?project=${this.id}&step=source`;return;}
    const current=this.state.source;
    this.shell(`${this.header('documents')}<div class="pf-source-strip">${ico('file')}<div><strong>${esc(current.filename)}</strong><small>本次基准 · V${current.sequence} · ${esc(this.project!.name)}</small></div><a class="text-button" href="#generate?project=${this.id}&step=source">更换募集书</a></div>
      <div class="pf-generation-grid"><section class="panel"><div class="pf-section-head"><h2>关联文件 <small>12</small></h2><div><button class="text-button" id="pf-select-all">全选</button> <button class="text-button" id="pf-select-none">清空</button></div></div>${['1','2.2','3','4.1'].map(folder=>`<div class="pf-category"><h3>${folder[0]} ${PROJECT_DOCUMENT_FOLDERS.find(f=>f.id===folder[0])!.name}</h3>${PROJECT_DOCUMENT_CATALOG.filter(d=>d.folder===folder).map(d=>`<label class="pf-document-option"><input type="checkbox" data-pf-type="${d.id}" ${this.selected.has(d.id)?'checked':''}/><span><strong>${d.name}</strong><small>${d.hint}</small></span></label>`).join('')}</div>`).join('')}<p class="muted pf-integrity-note">诚信核查底稿通过独立核查流程准备。<a href="#integrity?project=${encodeURIComponent(this.id!)}">前往诚信核查 →</a></p></section>
      <aside class="panel pf-package"><h2>本次文件包</h2><strong class="pf-count" id="pf-count">${this.selected.size}<small> 份文件</small></strong><p>生成后归入项目对应目录，旧版保留。</p><label>文件生成要求与说明<textarea id="pf-requirements" rows="6" maxlength="12000" placeholder="选填，例如统一本期发行方案、保留待补充标记">${esc(Object.values(w.drafts).find(d=>d.supplemental_requirements)?.supplemental_requirements??'')}</textarea></label><label>补充编制依据<input id="pf-support" type="file" multiple accept=".docx,.pdf,.xlsx"/></label><p class="muted">财务报告、核查依据和履职材料等。</p><div id="pf-support-list"></div></aside></div>
      <section class="panel pf-template-preparation"><div class="pf-section-head"><div><div class="eyebrow">历史文件 / 模板</div><h2>为所选文件准备模板</h2><p>首次添加后保存到项目，下次默认复用；更换模板时保留旧版。</p></div><span id="pf-prepared"></span></div><div id="pf-template-list"></div></section>
      <p id="pf-status" role="status"></p><footer class="pf-footer"><a class="btn secondary" href="#generate?project=${this.id}&step=source">上一步</a><div><span id="pf-price"></span><button class="btn primary" id="pf-generate" disabled>开始生成</button></div></footer>`,'generate');
    document.querySelectorAll<HTMLInputElement>('[data-pf-type]').forEach(c=>c.addEventListener('change',()=>{const type=c.dataset.pfType as M4DocumentType;if(c.checked)this.selected.add(type);else this.selected.delete(type);this.paintTemplates();}));
    document.querySelector('#pf-select-all')!.addEventListener('click',()=>{this.selected=new Set(PROJECT_DOCUMENT_CATALOG.map(d=>d.id));document.querySelectorAll<HTMLInputElement>('[data-pf-type]').forEach(c=>c.checked=true);this.paintTemplates();});
    document.querySelector('#pf-select-none')!.addEventListener('click',()=>{this.selected.clear();document.querySelectorAll<HTMLInputElement>('[data-pf-type]').forEach(c=>c.checked=false);this.paintTemplates();});
    document.querySelector('#pf-support')!.addEventListener('change',e=>void this.addSupport([...((e.target as HTMLInputElement).files??[])]));
    document.querySelector('#pf-generate')!.addEventListener('click',()=>void this.generate());this.paintTemplates();this.paintSupport();
  }
  private template(type:M4DocumentType){const pin=this.state!.workspace.drafts[type].template;return this.state!.workspace.templates.find(t=>t.template_id===pin?.template_id&&t.template_version===pin.template_version&&t.sha256===pin.sha256);}
  private paintTemplates(){
    const selected=PROJECT_DOCUMENT_CATALOG.filter(d=>this.selected.has(d.id)),ready=selected.filter(d=>this.template(d.id));
    document.querySelector('#pf-count')!.innerHTML=this.selected.size+'<small> 份文件</small>';document.querySelector('#pf-prepared')!.textContent=`${ready.length} / ${selected.length} 已准备`;
    document.querySelector('#pf-template-list')!.innerHTML=selected.map(d=>{const t=this.template(d.id);return `<div class="pf-template-row"><div><strong>${d.name}</strong><small>${t?esc(t.name)+' · V'+t.template_version+' · 已保存，下次复用':'首次生成需要添加对应历史文件或模板'}</small></div><span class="pf-chip ${t?'':'attention'}">${t?'可复用':'待添加'}</span><button class="btn ${t?'secondary':'primary'}" data-pf-template="${d.id}">${t?'管理 / 更换':'添加历史文件 / 模板'}</button></div>`;}).join('')||'<p class="muted">选择上方文件后，在这里添加对应模板。</p>';
    document.querySelector('#pf-price')!.textContent=selected.length?`${selected.length} 份，共 ${(selected.length*M4_DOCUMENT_FIXED_PRICE.points).toLocaleString()} 积分`:'请选择需要生成的文件';
    document.querySelector<HTMLButtonElement>('#pf-generate')!.disabled=!selected.length||ready.length!==selected.length||this.busy;
    document.querySelectorAll<HTMLButtonElement>('[data-pf-template]').forEach(b=>b.addEventListener('click',()=>this.templateModal(b.dataset.pfTemplate as M4DocumentType)));
  }
  private templateModal(type:M4DocumentType){
    const d=this.state!.workspace.drafts[type],selected=this.template(type),candidates=this.state!.workspace.templates.filter(t=>t.document_type===type&&t.market===d.fields.market&&t.offering===d.fields.offering&&t.status==='active');
    const dialog=this.modal(PROJECT_DOCUMENT_CATALOG.find(d=>d.id===type)!.name+' · 历史文件 / 模板',`<p>添加一次，后续生成自动复用。新版本不会删除旧模板。</p><form id="pf-template-form"><label>上传历史文件 / 模板<input type="file" name="file" accept=".docx" required/></label>${type==='init'?`<label>立项券商全称<input name="broker" value="${esc(d.fields.broker??'')}" required maxlength="200"/></label>`:''}<p class="muted">Word（DOCX）· 单份不超过 100 MB</p><button class="btn primary">保存并用于本次生成</button></form><h3>从已保存模板库选用</h3>${candidates.map(t=>`<div class="pf-template-row"><div><strong>${esc(t.name)}</strong><small>V${t.template_version} · ${esc(date(t.created_at))}</small></div><button class="btn secondary" data-use-template="${esc(t.template_id)}" data-version="${t.template_version}" ${selected?.template_id===t.template_id&&selected.template_version===t.template_version?'disabled':''}>选用</button></div>`).join('')||'<p class="muted">尚无此类型和市场品种的模板。</p>'}`);
    const apply=async(t:M4Template)=>{const {version,sha256:_sha,updated_at:_at,...input}=this.state!.workspace.drafts[type];input.template={template_id:t.template_id,template_version:t.template_version,sha256:t.sha256};input.fields.broker=t.broker;
      const saved=await this.m4.draft(this.state!.workspace.topic.topic_id,{expected_version:version,input});this.state!.workspace.drafts[type]=saved.draft;if(!this.state!.workspace.templates.some(x=>x.template_id===t.template_id&&x.template_version===t.template_version))this.state!.workspace.templates.push(t);dialog.close();this.paintTemplates();};
    const execute=async(fn:()=>Promise<void>)=>{if(this.busy)return;this.busy=true;const status=dialog.querySelector('#pf-modal-status')!;status.textContent='正在保存…';try{await fn();}catch(e){if(this.live())status.textContent=e instanceof Error&&!(e instanceof ApiError)?e.message:friendlyError(e);}finally{this.busy=false;if(this.live())this.paintTemplates();}};
    let pending:{file:File;request:string;pin?:M4MaterialPin}|undefined;
    dialog.querySelector('form')!.addEventListener('submit',e=>{e.preventDefault();void execute(async()=>{
      const file=dialog.querySelector<HTMLInputElement>('[name=file]')!.files![0];if(!file||!file.name.toLowerCase().endsWith('.docx'))throw new Error('历史文件 / 模板请选择 DOCX。');
      if(pending?.file!==file)pending={file,request:crypto.randomUUID()};pending.pin??=await uploadFileMaterial(this.api,this.id!,file,this.controller.signal,s=>dialog.querySelector('#pf-modal-status')!.textContent=s);
      const {template}=await this.m4.template({creation_request_id:pending.request,name:file.name,broker:dialog.querySelector<HTMLInputElement>('[name=broker]')?.value.trim()??'',document_type:type,material:pending.pin,
        market:d.fields.market as M4Template['market'],offering:d.fields.offering as M4Template['offering'],...(selected?{replaces_template_id:selected.template_id}:{})});await apply(template);
    });});
    dialog.querySelectorAll<HTMLButtonElement>('[data-use-template]').forEach(b=>b.addEventListener('click',()=>void execute(()=>apply(candidates.find(t=>t.template_id===b.dataset.useTemplate&&t.template_version===Number(b.dataset.version))!))));
  }
  private paintSupport(){const materials=[...new Map(Object.values(this.state!.workspace.drafts).flatMap(d=>d.materials).map(m=>[m.material_id,m])).values()];document.querySelector('#pf-support-list')!.textContent=materials.length?`项目已保存 ${materials.length} 份补充资料`:'尚未添加补充资料';}
  private async addSupport(files:File[]){await this.act(async()=>{for(const file of files){const pin=await uploadFileMaterial(this.api,this.id!,file,this.controller.signal,s=>this.status(s));
    await this.m4.material(this.state!.workspace.topic.topic_id,pin);
    for(const type of PROJECT_DOCUMENT_CATALOG.map(d=>d.id)){const {version,sha256:_sha,updated_at:_at,...input}=this.state!.workspace.drafts[type];if(input.materials.some(m=>m.material_id===pin.material_id&&m.material_version===pin.material_version))continue;
      input.materials.push(pin);this.state!.workspace.drafts[type]=(await this.m4.draft(this.state!.workspace.topic.topic_id,{expected_version:version,input})).draft;}
  }this.paintSupport();this.status('补充资料已保存，将随本次文件包固定采用。');});}
  private async generate(){await this.act(async()=>{
    if(!this.pendingBatch){const requirements=document.querySelector<HTMLTextAreaElement>('#pf-requirements')!.value.trim();
      await this.saveRequirements(requirements);
      const s=this.state!.source!;this.pendingBatch={request_id:crypto.randomUUID(),source_version_id:s.version_id,expected_selection_revision:s.selection_revision,documents:[...this.selected].map(document_type=>({document_type,draft_version:this.state!.workspace.drafts[document_type].version}))};
    }
    try{await this.request('POST','/batches',this.pendingBatch);}
    catch(e){if(e instanceof ApiError&&e.status>=400&&e.status<500)this.pendingBatch=undefined;throw e;}
    this.pendingBatch=undefined;location.hash=`generate?project=${this.id}&step=results`;
  });}
  private async saveRequirements(requirements:string){
    for(const type of PROJECT_DOCUMENT_CATALOG.map(d=>d.id)){
      const {version,sha256:_sha,updated_at:_at,...input}=this.state!.workspace.drafts[type];
      if(input.supplemental_requirements===requirements)continue;
      input.supplemental_requirements=requirements;
      this.state!.workspace.drafts[type]=(await this.m4.draft(this.state!.workspace.topic.topic_id,{expected_version:version,input})).draft;
    }
  }
  private paintResults(){
    const s=this.state!,w=s.workspace;
    this.shell(`${this.header('results')}<section class="panel pf-results"><div class="pf-section-head"><div><h2>文件生成任务</h2><p>任务在后台继续处理，完成后归入项目文件，旧版本保留。</p></div><a class="btn secondary" href="#generate?project=${this.id}&step=documents">准备下一轮文件</a></div>${s.batches.map(b=>`<div class="pf-batch"><strong>${{queued:'等待处理',running:'正在生成',paused:'需要处理',complete:'已完成',cancelled:'已结束'}[b.state]}</strong>${b.state==='paused'?'<button class="text-button" data-batch-retry="'+b.batch_id+'">重试未完成文件</button>':''}${['queued','running','paused'].includes(b.state)?'<button class="text-button" data-batch-cancel="'+b.batch_id+'">停止后续生成</button>':''}${b.items.map(i=>`<div class="pf-template-row"><div><strong>${PROJECT_DOCUMENT_CATALOG.find(d=>d.id===i.document_type)?.name??''}</strong><small>${esc(i.error??runStateLabel[i.state as keyof typeof runStateLabel]??i.state)}</small></div>${w.tasks.find(t=>t.run.run_id===i.run_id&&t.run.state==='succeeded')?.artifacts.filter(a=>['document','preparation_note'].includes(a.kind)).map(a=>`<button class="btn secondary" data-pf-download="${a.artifact_id}">${a.kind==='document'?'下载文件':'编制说明'}</button>`).join('')??''}${i.run_id?`<a class="btn secondary" href="#generate?topic=${w.topic.topic_id}&run=${i.run_id}">查看任务</a>`:'<span class="muted">等待前一份文件完成</span>'}</div>`).join('')}</div>`).join('')||'<p>暂无文件生成任务。</p>'}</section><footer class="pf-footer"><p id="pf-status" role="status"></p><div><a class="btn secondary" href="#/projects/${this.id}/files">查看项目文件</a><a class="btn primary" href="#consistency?project=${this.id}">检查文件一致性</a></div></footer>`,'generate');
    document.querySelectorAll<HTMLButtonElement>('[data-batch-retry],[data-batch-cancel]').forEach(b=>b.addEventListener('click',()=>void this.act(async()=>{
      if(b.dataset.batchRetry&&!window.confirm('重试会重新开始未完成的文件，沿用每份 4,500 积分的计费规则。是否继续？'))return;
      this.state=await this.request<Workspace>('POST','/batches/'+(b.dataset.batchRetry??b.dataset.batchCancel)+'/actions',{action:b.dataset.batchRetry?'retry':'cancel'});this.paintResults();
    })));
    document.querySelectorAll<HTMLButtonElement>('[data-pf-download]').forEach(b=>b.addEventListener('click',()=>void this.act(async()=>{
      const expected=w.tasks.flatMap(t=>t.artifacts).find(a=>a.artifact_id===b.dataset.pfDownload)!;
      const meta=await this.api.artifact(expected.artifact_id,this.controller.signal);if(meta.sha256!==expected.sha256||meta.version!==expected.artifact_version)throw new Error('文件版本已变化，请刷新后下载。');
      this.downloads.save(await this.api.artifactBytes(meta,this.controller.signal),expected.filename);this.status('文件已交给浏览器下载。');
    })));
    this.scheduleResults();
  }
  private scheduleResults(){
    clearTimeout(this.timer);if(!this.live()||!this.state?.batches.some(b=>['queued','running'].includes(b.state)))return;
    this.timer=setTimeout(()=>{void this.request<Workspace>('GET','/workspace').then(state=>{if(this.live()){this.state=state;this.paintResults();}}).catch(e=>{if(this.live()){this.status('刷新未成功，将自动重试。'+friendlyError(e));this.scheduleResults();}});},3000);
  }
}
