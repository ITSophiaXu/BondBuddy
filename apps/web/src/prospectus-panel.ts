import { M1_UPLOAD_LIMITS, M1_UPLOAD_MIME_TYPES, type ProspectusVersions } from '@bondbuddy/contracts';
import { ApiClient, friendlyError, ApiError } from './api';
import { ArtifactDownloads } from './artifact-download';
import { esc, date } from './ui';
import './update-entry.css';

export class ProspectusPanel {
  state?:ProspectusVersions;
  busy=false;
  private controller=new AbortController();
  private downloads=new ArtifactDownloads();
  private pendingUpload?:{
    file:File;expected:number;requestId:string;sha256:string;
    upload?:Awaited<ReturnType<ApiClient['createUpload']>>;
    sent?:boolean;material?:Awaited<ReturnType<ApiClient['completeUpload']>>;
  };
  constructor(private api:ApiClient,private id:string,private host:HTMLElement,private beforeChange:()=>Promise<boolean>,private changed:()=>Promise<void>,private busyChanged:()=>void=()=>{}){}
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
    this.host.innerHTML=`<section class="panel prospectus-panel"><header><div><h2>项目募集说明书</h2><p>${current?`当前版本：V${current.sequence} · ${esc(current.filename)}`:'可上传历史募集书开始更新，也可以直接保存募集书新版本。'}</p></div></header>
      <details><summary>版本历史（${this.state.versions.length}）</summary>${this.state.versions.map(v=>`<div class="prospectus-version"><div><strong>V${v.sequence} · ${esc(v.filename)}</strong><small>${v.origin==='upload'?'用户上传':'BondBuddy 更新'} · ${esc(date(v.created_at))}</small></div><div class="prospectus-version-actions">${v.version_id===current?.version_id?'<span class="prospectus-current">当前版本</span>':`<button type="button" class="text-button" data-use-version="${esc(v.version_id)}">设为当前版本</button>`}<button type="button" class="text-button" data-download-version="${esc(v.version_id)}">${v.origin==='generated'?'下载清洁版':'下载原文件'}</button>${v.revision_artifact_id?`<button type="button" class="text-button" data-download-revision="${esc(v.version_id)}">下载修订版</button>`:''}</div></div>`).join('')||'<p>尚无版本记录。</p>'}</details>
      <details><summary>直接上传募集书新版本</summary><p>保存为当前募集书并保留旧版。此操作不会启动 AI 更新或扣费，需要时再点击“开始更新”。</p><div class="prospectus-upload"><input id="prospectus-version-file" aria-label="募集书新版本文件" type="file" accept=".docx,.pdf"/><button type="button" class="btn secondary" id="save-prospectus-version">保存为当前版本</button></div></details>
      <p id="prospectus-status" role="status"></p></section>`;
    this.host.querySelector('#save-prospectus-version')!.addEventListener('click',()=>{void this.upload();});
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
  private status(s:string){const status=this.host.querySelector('#prospectus-status');if(status)status.textContent=s;}
  private async action(fn:()=>Promise<void>){
    if(this.busy)return;this.busy=true;this.busyChanged();
    this.host.querySelectorAll<HTMLButtonElement|HTMLInputElement>('button,input').forEach(b=>b.disabled=true);
    this.status('正在处理…');
    try{await fn();}catch(e){if(!this.controller.signal.aborted)this.status(e instanceof ApiError?friendlyError(e):e instanceof Error?e.message:'操作未完成，请重试。');}
    finally{this.busy=false;if(!this.controller.signal.aborted){this.busyChanged();this.host.querySelectorAll<HTMLButtonElement|HTMLInputElement>('button,input').forEach(b=>b.disabled=false);}}
  }
  private async upload(){
    const file=this.host.querySelector<HTMLInputElement>('#prospectus-version-file')!.files?.[0];
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
