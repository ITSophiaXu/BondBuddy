import { M1_UPLOAD_LIMITS, M1_UPLOAD_MIME_TYPES, type ProspectusVersions } from '@bondbuddy/contracts';
import { ApiClient, friendlyError, ApiError } from './api';
import { ArtifactDownloads } from './artifact-download';
import { esc, date } from './ui';
import { prototypeIcon as icon } from './prototype-design';
import '../../../product-prototype/public/prospectus-panel.css';

export class ProspectusPanel {
  state?:ProspectusVersions;
  busy=false;
  private controller=new AbortController();
  private downloads=new ArtifactDownloads();
  private selectedFile?:File;
  private historyOpen=false;
  private pendingUpload?:{
    file:File;expected:number;requestId:string;sha256:string;
    upload?:Awaited<ReturnType<ApiClient['createUpload']>>;
    sent?:boolean;material?:Awaited<ReturnType<ApiClient['completeUpload']>>;
  };
  constructor(private api:ApiClient,private id:string,private host:HTMLElement,private beforeChange:()=>Promise<boolean>,private changed:()=>Promise<void>,private busyChanged:()=>void=()=>{},private purpose:'update'|'generation'|'consistency'='update'){}
  dispose(){this.controller.abort();this.downloads.dispose();}
  get inactive(){return new Set(this.state?.inactive_material_ids??[]);}
  async refresh(){
    if(this.busy)return;
    const state=await this.api.prospectusVersions(this.id,this.controller.signal);
    if(this.controller.signal.aborted||this.state&&(state.selection_revision<this.state.selection_revision||state.versions.length<this.state.versions.length))return;
    this.state=state;this.render();
  }
  private render(){
    if(!this.state)return;
    const current=this.state.versions.find(v=>v.version_id===this.state!.current_version_id);
    const downloadButtons=(v:ProspectusVersions['versions'][number])=>`<button type="button" class="text-button" data-download-version="${esc(v.version_id)}">${icon('download')}${v.origin==='generated'?'下载清洁版':'下载原文件'}</button>${v.revision_artifact_id?`<button type="button" class="text-button" data-download-revision="${esc(v.version_id)}">下载修订版</button>`:''}`;
    this.host.innerHTML=`<section class="panel prospectus-panel" aria-label="项目募集说明书">
      <header class="prospectus-panel-heading"><h2>项目募集说明书</h2><button type="button" class="btn secondary" id="choose-prospectus-version">${icon('upload')}${current?'上传新版本':'上传募集说明书'}</button></header>
      <input id="prospectus-version-file" aria-label="募集书新版本文件" type="file" accept=".docx,.pdf" hidden/>
      ${current?`<div class="prospectus-current-file"><span class="prospectus-file-icon">${icon('file')}</span><div class="prospectus-file-info"><span class="prospectus-current">当前版本 · V${current.sequence}</span><h3>${esc(current.filename)}</h3><p>${current.origin==='upload'?'用户上传':'BondBuddy 更新'} · ${esc(date(current.created_at))}</p></div><div class="prospectus-version-actions">${downloadButtons(current)}</div></div>`:
        `<div class="prospectus-empty"><span class="prospectus-file-icon">${icon('file')}</span><div><h3>${this.state.versions.length?'尚未选择当前版本':'尚未保存募集说明书'}</h3><p>${this.state.versions.length?'从版本历史中选择一份，或上传新版本。':this.purpose==='consistency'?'上传并保存为当前版本，作为关联文件的一致性检查依据。':this.purpose==='generation'?'上传募集说明书后，即可选择需要生成的文件。':'可上传已有稿件；没有稿件，也可在下方提供材料后开始更新。'}</p></div></div>`}
      ${this.selectedFile?`<div class="prospectus-upload"><div class="prospectus-selected-file"><span class="prospectus-file-icon">${icon('file')}</span><div class="prospectus-file-info"><span class="prospectus-upload-label">待保存</span><strong>${esc(this.selectedFile.name)}</strong><small>${this.fileSize(this.selectedFile.size)} · 保存后设为当前版本，已有版本保留</small></div></div><div class="prospectus-upload-actions"><button type="button" class="btn primary" id="save-prospectus-version">保存为当前版本</button><button type="button" class="text-button" id="cancel-prospectus-version">取消</button><button type="button" class="text-button" id="replace-prospectus-version">重新选择</button></div></div>`:''}
      <p class="prospectus-upload-hint">支持 Word（.docx）和 PDF，单份不超过 100 MB。上传仅保存文件，不启动${this.purpose==='consistency'?'检查':this.purpose==='generation'?'生成':'更新'}或扣费。</p>
      ${this.state.versions.length?`<details class="prospectus-history" ${this.historyOpen?'open':''}><summary>${icon('clock')}<span>版本历史</span><span class="prospectus-history-count">${this.state.versions.length}</span>${icon('down')}</summary><div class="prospectus-history-list">${[...this.state.versions].sort((a,b)=>b.sequence-a.sequence).map(v=>`<div class="prospectus-version"><div class="prospectus-file-info"><strong>V${v.sequence} · ${esc(v.filename)}</strong><small>${v.origin==='upload'?'用户上传':'BondBuddy 更新'} · ${esc(date(v.created_at))}</small></div><div class="prospectus-version-actions">${v.version_id===current?.version_id?'<span class="prospectus-current">当前版本</span>':`<button type="button" class="text-button" data-use-version="${esc(v.version_id)}">设为当前版本</button>`}${downloadButtons(v)}</div></div>`).join('')}</div></details>`:''}
      <p id="prospectus-status" role="status" aria-live="polite"></p></section>`;
    const input=this.host.querySelector<HTMLInputElement>('#prospectus-version-file')!;
    const choose=()=>input.click();
    this.host.querySelector('#choose-prospectus-version')!.addEventListener('click',choose);
    this.host.querySelector('#replace-prospectus-version')?.addEventListener('click',choose);
    input.addEventListener('change',()=>{
      const file=input.files?.[0];if(!file)return;
      this.selectedFile=file;this.pendingUpload=undefined;this.render();
      this.host.querySelector<HTMLButtonElement>(this.fileError()?'#replace-prospectus-version':'#save-prospectus-version')?.focus();
    });
    this.host.querySelector('#cancel-prospectus-version')?.addEventListener('click',()=>{
      this.selectedFile=undefined;this.pendingUpload=undefined;this.render();
      this.host.querySelector<HTMLButtonElement>('#choose-prospectus-version')?.focus();
    });
    this.host.querySelector('#save-prospectus-version')?.addEventListener('click',()=>{void this.upload();});
    const history=this.host.querySelector<HTMLDetailsElement>('.prospectus-history');
    history?.addEventListener('toggle',()=>{this.historyOpen=history.open;});
    this.syncControls();
    if(this.fileError())this.status(this.fileError(),true);
    this.host.querySelectorAll<HTMLButtonElement>('[data-use-version]').forEach(b=>b.addEventListener('click',()=>{void this.action(async()=>{
      if(!await this.beforeChange())throw new Error('请先保存项目信息。');
      await this.api.selectProspectus(this.id,{request_id:crypto.randomUUID(),expected_selection_revision:this.state!.selection_revision,version_id:b.dataset.useVersion!},this.controller.signal);
      await this.changed();
    });}));
    this.host.querySelectorAll<HTMLButtonElement>('[data-download-version],[data-download-revision]').forEach(b=>b.addEventListener('click',()=>{void this.action(async()=>{
      const v=this.state!.versions.find(v=>v.version_id===(b.dataset.downloadVersion||b.dataset.downloadRevision))!;
      const artifactId=b.dataset.downloadRevision?v.revision_artifact_id:v.artifact_id;
      if(artifactId){
        const artifact=await this.api.artifact(artifactId,this.controller.signal);
        if(!b.dataset.downloadRevision&&(artifact.version!==v.artifact_version||artifact.sha256!==v.sha256))throw new ApiError(409,'INPUT_REVISION_CONFLICT');
        this.downloads.save(await this.api.artifactBytes(artifact,this.controller.signal),`募集说明书_V${v.sequence}_${b.dataset.downloadRevision?'修订版':'清洁版'}.docx`);
      }else{
        const m=await this.api.material(this.id,v.material_id!,this.controller.signal);
        if(m.material_version!==v.material_version||m.sha256!==v.sha256)throw new ApiError(409,'INPUT_REVISION_CONFLICT');
        this.downloads.save(await this.api.materialBytes(this.id,m,this.controller.signal),v.filename);
      }
      this.status('文件已交给浏览器下载。');
    });}));
  }
  private fileSize(bytes:number){return bytes>=1024*1024?`${(bytes/1024/1024).toFixed(1)} MB`:`${Math.max(1,Math.ceil(bytes/1024))} KB`;}
  private fileError(){const file=this.selectedFile;return file&&(!/\.(docx|pdf)$/i.test(file.name)||!file.size||file.size>M1_UPLOAD_LIMITS.fileBytes)?'请上传不超过 100 MB 的 DOCX 或 PDF 文件。':'';}
  private syncControls(){
    this.host.querySelector('.prospectus-panel')?.setAttribute('aria-busy',String(this.busy));
    this.host.querySelectorAll<HTMLButtonElement|HTMLInputElement>('button,input').forEach(b=>b.disabled=this.busy||(b.id==='save-prospectus-version'&&(!this.selectedFile||!!this.fileError())));
  }
  private status(s:string,error=false){const status=this.host.querySelector<HTMLElement>('#prospectus-status');if(status){status.textContent=s;status.dataset.tone=error?'error':'info';status.setAttribute('role',error?'alert':'status');}}
  private async action(fn:()=>Promise<void>){
    if(this.busy)return;this.busy=true;this.busyChanged();
    this.syncControls();
    this.status('正在处理…');
    try{await fn();}catch(e){if(!this.controller.signal.aborted)this.status(e instanceof ApiError?friendlyError(e):e instanceof Error?e.message:'操作未完成，请重试。',true);}
    finally{this.busy=false;if(!this.controller.signal.aborted){this.busyChanged();this.syncControls();}}
  }
  private async upload(){
    const file=this.selectedFile;
    if(!file){this.status('请先选择 DOCX 或 PDF 文件。');return;}
    await this.action(async()=>{
      const ext=file.name.split('.').at(-1)?.toLowerCase();
      if(!['docx','pdf'].includes(ext??'')||!file.size||file.size>M1_UPLOAD_LIMITS.fileBytes)throw new Error('请上传不超过 100 MB 的 DOCX 或 PDF 文件。');
      if(!await this.beforeChange())throw new Error('请先保存项目信息。');
      if(this.pendingUpload?.file!==file)this.pendingUpload={file,expected:this.state!.selection_revision,requestId:crypto.randomUUID(),
        sha256:[...new Uint8Array(await crypto.subtle.digest('SHA-256',await file.arrayBuffer()))].map(n=>n.toString(16).padStart(2,'0')).join('')};
      const pending=this.pendingUpload,{sha256}=pending;
      const input={byte_size:file.size,sha256};
      // A lost PUT/completion response must be reconciled before retransmitting bytes.
      if(pending.upload&&!pending.material){
        try{pending.material=await this.api.completeUpload(this.id,pending.upload.upload_id,input,this.controller.signal);}
        catch(e){
          if(!(e instanceof ApiError)||![404,422].includes(e.status)||e.status!==404&&e.code!=='MATERIAL_UNREADABLE')throw e;
          if(e.status===404||Date.parse(pending.upload.expires_at)<=Date.now())pending.upload=undefined;
          pending.sent=false;
        }
      }
      pending.upload??=await this.api.createUpload(this.id,{...input,filename:file.name,media_type:ext==='docx'?M1_UPLOAD_MIME_TYPES[0]:M1_UPLOAD_MIME_TYPES[1],role:'historical'},this.controller.signal);
      if(!pending.material&&!pending.sent){
        await this.api.uploadBytes(pending.upload.upload_url,file,(bytes,total)=>this.status(`正在上传 ${Math.floor(bytes/total*100)}%…`),this.controller.signal);
        pending.sent=true;
      }
      pending.material??=await this.api.completeUpload(this.id,pending.upload.upload_id,input,this.controller.signal);
      const material=pending.material;
      this.status('文件已保存，正在设置当前版本…');
      try{
        await this.api.saveProspectus(this.id,{request_id:pending.requestId,expected_selection_revision:pending.expected,material_id:material.material_id,material_version:material.material_version,sha256},this.controller.signal);
      }catch(e){
        if(e instanceof ApiError&&e.status===409)throw new Error('文件已保留，但当前版本已在其他页面变化。请刷新已保存材料，在版本历史中确认后设为当前版本。');
        throw e;
      }
      await this.changed();
    });
  }
}
