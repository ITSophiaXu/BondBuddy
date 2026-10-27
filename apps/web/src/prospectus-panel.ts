import { M1_UPLOAD_LIMITS, M1_UPLOAD_MIME_TYPES, type ProspectusVersions } from '@bondbuddy/contracts';
import { ApiClient, friendlyError, ApiError } from './api';
import { UserFacingError } from './user-facing-error';
import { ArtifactDownloads, artifactFilename } from './artifact-download';
import { esc, date } from './ui';
import { prototypeIcon as icon } from './prototype-design';
import '../../../product-prototype/public/prospectus-panel.css';
import {UploadRecovery,type UploadRecoveryRecord} from './upload-recovery';
import './update-entry.css';
import './prospectus-saved-reentry.css';
import '../../../product-prototype/public/file-generation-ux.css';

export class ProspectusPanel {
  state?:ProspectusVersions;
  busy=false;
  private controller=new AbortController();
  private downloads=new ArtifactDownloads();
  private message='';
  private savedVersionId?:string;
  private dialog?:HTMLDialogElement;
  private pendingSelection?:{
    request:Parameters<ApiClient['selectProspectus']>[1];
    version:ProspectusVersions['versions'][number];
    attempted:boolean;
  };
  private pendingUpload?:{id:string;file?:File;uncertain?:boolean};
  private recovery?:UploadRecovery;
  constructor(private api:ApiClient,private id:string,private host:HTMLElement,private beforeChange:()=>Promise<boolean>,private changed:()=>Promise<void>,private busyChanged:()=>void=()=>{},private purpose:'update'|'generation'|'consistency'='update',private owner?:string){}
  private uploads(){if(!this.owner)throw new UserFacingError('当前账号身份尚未确认，不能建立可恢复的上传记录。');return this.recovery??=new UploadRecovery(this.api,this.owner,this.id,'prospectus-version',()=>!this.controller.signal.aborted&&this.host.isConnected);}
  private uploadRows():UploadRecoveryRecord[]{try{return this.owner?this.uploads().list():[];}catch(e){this.message=friendlyError(e,'read');return [];}}
  dispose(){this.controller.abort();this.closeDialog();this.downloads.dispose();}
  get hasUnconfirmed(){return !this.controller.signal.aborted&&(this.busy||!!this.pendingSelection?.attempted||!!this.pendingUpload?.uncertain);}
  async beforeLeave(){
    if(!this.hasUnconfirmed)return true;
    this.status(this.busy?'募集书正在上传或保存，请等待本次操作确认后再离开。':'本次上传或采用结果尚未确认，请先重试确认，避免重复操作。');
    return false;
  }
  get inactive(){return new Set(this.state?.inactive_material_ids??[]);}
  async refresh(){
    if(this.busy||this.controller.signal.aborted)return;
    const state=await this.api.prospectusVersions(this.id,this.controller.signal);
    if(this.busy||this.controller.signal.aborted||this.state&&(state.selection_revision<this.state.selection_revision||state.versions.length<this.state.versions.length))return;
    if(this.state&&state.selection_revision!==this.state.selection_revision&&!this.pendingSelection?.attempted)
      this.message='项目当前稿已更新，请查看当前版本；已保存的文件仍保留。';
    this.state=state;this.render();
  }
  private versionKey(v:ProspectusVersions['versions'][number]){
    return JSON.stringify([this.id,this.state?.project_id,v.version_id,v.sequence,v.origin,v.filename,v.sha256,v.created_at,v.material_id,v.material_version,v.artifact_id,v.artifact_version,v.revision_artifact_id,v.run_id]);
  }
  private verifiedVersions(){
    const state=this.state;
    if(!state||state.project_id!==this.id||!Number.isSafeInteger(state.selection_revision)||state.selection_revision<0)return false;
    const ids=new Set<string>(),sequences=new Set<number>();
    for(const v of state.versions){
      if(!v.version_id||ids.has(v.version_id)||!Number.isSafeInteger(v.sequence)||v.sequence<1||sequences.has(v.sequence)||!/^[a-f0-9]{64}$/.test(v.sha256))return false;
      const material=!!v.material_id&&Number.isSafeInteger(v.material_version)&&(v.material_version??0)>0;
      const artifact=!!v.artifact_id&&Number.isSafeInteger(v.artifact_version)&&(v.artifact_version??0)>0;
      if(v.origin==='upload'?!material||v.artifact_id!==null||v.artifact_version!==null:!artifact||v.material_id!==null||v.material_version!==null)return false;
      ids.add(v.version_id);sequences.add(v.sequence);
    }
    return state.current_version_id===null||ids.has(state.current_version_id);
  }
  private versionReference(v:ProspectusVersions['versions'][number]){
    const rows=[['记录所属项目',this.state?.project_id??this.id],['版本记录',v.version_id],['版本序号',`V${v.sequence}`],['保存时间',v.created_at],['文件校验值 SHA-256',v.sha256],
      ...(v.material_id?[['材料编号',v.material_id],['材料版本',String(v.material_version)]]:[]),
      ...(v.artifact_id?[['成果编号',v.artifact_id],['成果版本',String(v.artifact_version)]]:[]),
      ...(v.revision_artifact_id?[['修订版成果编号',v.revision_artifact_id]]:[]),...(v.run_id?[['来源任务',v.run_id]]:[])];
    return `<details data-prospectus-ref data-prospectus-key="${esc(this.versionKey(v))}"><summary>文件版本详情</summary><dl>${rows.map(([label,value])=>`<div><dt>${esc(label!)}</dt><dd>${esc(value!)}</dd></div>`).join('')}</dl></details>`;
  }
  private render(preserveUpload=true){
    if(!this.state||this.controller.signal.aborted)return;
    const selected=preserveUpload?this.host.querySelector<HTMLInputElement>('#prospectus-version-file'):null;
    const selectedFile=selected?.files?.length?selected:null;
    const uploadOpen=selectedFile?.closest('details')?.open;
    const history=this.host.querySelector<HTMLDetailsElement>('[data-prospectus-history]');
    const historyOpen=history?.open;
    const newlySaved=!!this.savedVersionId&&history?.dataset.prospectusSavedId!==this.savedVersionId;
    const openRefs=new Set([...this.host.querySelectorAll<HTMLDetailsElement>('[data-prospectus-ref][open]')].map(d=>d.dataset.prospectusKey));
    const active=this.host.contains(document.activeElement)?document.activeElement as HTMLElement:null;
    const activeRef=active?.closest<HTMLElement>('[data-prospectus-key]')?.dataset.prospectusKey;
    const activeHistory=active?.hasAttribute('data-prospectus-history-summary');
    const activeReview=active?.hasAttribute('data-prospectus-saved-review');
    const verified=this.verifiedVersions();
    const current=verified?this.state.versions.find(v=>v.version_id===this.state!.current_version_id):undefined;
    const otherSaved=verified&&!this.pendingSelection?.attempted?this.state.versions.filter(v=>v.version_id!==current?.version_id&&(!current||v.sequence>current.sequence)):[];
    const recoveryRows=this.uploadRows(),generation=this.purpose==='generation';
    const downloadButtons=(v:ProspectusVersions['versions'][number])=>`<button type="button" class="text-button" data-download-version="${esc(v.version_id)}">${icon('download')}${v.origin==='generated'?'下载清洁版':'下载原文件'}</button>${v.revision_artifact_id?`<button type="button" class="text-button" data-download-revision="${esc(v.version_id)}">下载修订版</button>`:''}`;
    this.host.innerHTML=`<section class="panel prospectus-panel ${generation?'pf-generation-prospectus':''}" aria-label="项目募集说明书"><header class="prospectus-panel-heading"><div><h2 tabindex="-1" data-prospectus-heading>项目募集说明书</h2><p>${!verified?'版本记录尚待核对，请重新读取项目后查看当前稿。':current&&generation?(this.pendingSelection?.attempted?'当前稿状态待确认，请先重试确认采用结果。':'关联文件将依据此版本编制；已提交任务保留原依据。'):current?`${this.pendingSelection?.attempted?'上次读取的项目当前稿':'项目当前稿'}：V${current.sequence} · ${esc(current.filename)}`:this.purpose==='consistency'?'上传并保存募集书，再明确采用为当前稿，作为关联文件的一致性检查依据。':this.purpose==='generation'?'上传募集书作为文件编制依据，或选择项目已保存版本。':'历史／参考募集书选填；没有原稿，也可先提供财务等发行人材料编制首稿。已有募集书可保存后再选择是否采用。'}</p></div>${generation&&!current?'':`<button type="button" class="btn secondary" id="choose-prospectus-version">${icon('upload')}${current?'上传新版本':'上传募集说明书'}</button>`}</header>
      ${current?`<div class="prospectus-current-file"><span class="prospectus-file-icon">${icon('file')}</span><div class="prospectus-file-info"><span class="prospectus-current">${this.pendingSelection?.attempted?'上次读取的当前版本':'当前版本'} · V${current.sequence}</span><h3>${esc(current.filename)}</h3><p>${current.origin==='upload'?'用户上传':'BondBuddy 更新'} · ${esc(date(current.created_at))}</p></div><div class="prospectus-version-actions">${downloadButtons(current)}</div></div>`:generation?`<button type="button" class="pf-prospectus-dropzone" id="choose-prospectus-version" aria-label="上传募集说明书" ${selectedFile?'hidden':''}><span class="prospectus-file-icon">${icon('upload')}</span><strong>上传募集说明书</strong><span>点击选择文件，或拖放到此处</span><small>Word（.docx）/ PDF · 单份不超过 100 MB</small></button>`:verified?`<div class="prospectus-empty"><span class="prospectus-file-icon">${icon('file')}</span><div><h3>${this.state.versions.length?'尚未选择当前版本':'尚未保存募集说明书'}</h3><p>${this.state.versions.length?'从版本历史中选择一份，或上传新版本。':this.purpose==='generation'?'上传募集说明书后，即可选择需要生成的文件。':'先保存文件，再确认是否采用；旧版和原任务依据保留。'}</p></div></div>`:''}
      <p class="prospectus-upload-hint">${generation?'上传仅保存文件，不启动生成或扣费。':`支持 Word（.docx）和 PDF，单份不超过 100 MB。上传仅保存文件，不启动${this.purpose==='consistency'?'检查':'更新'}或扣费。`}</p>
      ${otherSaved.length?`<aside class="prospectus-saved-notice" data-prospectus-saved-notice><div><strong>${current?'还有其他已保存版本可核对':'募集书已保存，尚未设置项目当前稿'}</strong><p>${current?`当前仍选用 V${current.sequence}，另有 ${otherSaved.length} 个之后保存的版本，可按需要查看或继续使用当前稿。`:`已有 ${otherSaved.length} 个已保存版本，可查看后选择项目当前稿。`}查看不会切换当前稿或启动任务。</p></div><button type="button" class="btn secondary" data-prospectus-saved-review>查看已保存版本</button></aside>`:''}
      <details class="${generation?'prospectus-history':''}" ${generation&&!this.state.versions.length?'hidden':''} data-prospectus-history data-prospectus-saved-id="${esc(this.savedVersionId??'')}" ${historyOpen||newlySaved||this.pendingSelection?.attempted?'open':''}><summary tabindex="0" data-prospectus-history-summary>${generation?icon('clock'):''}版本历史（${this.state.versions.length}）${generation?icon('down'):''}</summary><p>“项目当前稿”是项目的默认选择；本轮复核稿和已提交任务各自保留其依据。版本序号表示保存顺序。</p>${this.state.versions.map(v=>`<div class="prospectus-version" data-prospectus-version="${esc(v.version_id)}"><div class="prospectus-version-info"><strong>V${v.sequence} · ${esc(v.filename)}</strong><small>${v.origin==='upload'?'用户上传':'BondBuddy 更新'} · ${esc(date(v.created_at))}</small><small data-prospectus-selection-state>${!verified?'当前稿状态待核对':v.version_id===current?.version_id?this.pendingSelection?.attempted?'上次读取的项目当前稿':'项目当前稿':this.pendingSelection?.attempted?'已保存；项目当前稿状态待确认':'已保存，未设为项目当前稿'}</small>${verified?this.versionReference(v):''}</div><div class="prospectus-version-actions">${verified&&v.version_id===current?.version_id?`<span class="prospectus-current">${this.pendingSelection?.attempted?'上次读取的项目当前稿':'项目当前稿'}</span>`:`<button type="button" class="text-button" data-use-version="${esc(v.version_id)}">采用此版</button>`}<button type="button" class="text-button" data-download-version="${esc(v.version_id)}">${v.origin==='generated'?'下载清洁版':'下载原文件'}</button>${v.revision_artifact_id?`<button type="button" class="text-button" data-download-revision="${esc(v.version_id)}">下载修订版</button>`:''}</div></div>`).join('')||'<p>尚无版本记录。</p>'}</details>
      <${generation?'section':'details'} class="prospectus-upload-editor" ${generation?selectedFile||recoveryRows.length||this.pendingUpload?'':'hidden':recoveryRows.length?'open':''}>${generation?'':'<summary>上传募集书新版本</summary>'}<p>先保存文件，再选择是否采用为当前稿；旧版保留。保存和采用不会启动付费更新。原稿信息仍需按文件填写。</p><div class="prospectus-upload"><input id="prospectus-version-file" aria-label="募集书新版本文件" type="file" accept=".docx,.pdf" ${generation?'hidden':''}/><button type="button" class="btn secondary" id="save-prospectus-version">上传并保存</button></div>${recoveryRows.map(r=>`<div class="prospectus-version"><div><strong>${esc(r.declaration.filename)}</strong><small>${r.stage==='saved'?'文件已保存，版本记录待确认':'原上传待确认'}；确认不会采用为当前稿。若需字节，请在上方重选原文件。</small></div><button type="button" class="text-button" data-resume-prospectus="${esc(r.id)}">确认原上传</button></div>`).join('')}</${generation?'section':'details'}>
      <p id="prospectus-status" role="status">${esc(this.message)}</p>${this.pendingSelection?.attempted?'<button type="button" class="text-button" id="retry-prospectus-selection">重试确认采用结果</button>':''}</section>`;
    if(selectedFile){
      this.host.querySelector('#prospectus-version-file')!.replaceWith(selectedFile);
      const details=selectedFile.closest('details');if(details&&uploadOpen)details.open=true;
    }
    const input=this.host.querySelector<HTMLInputElement>('#prospectus-version-file')!;
    const choose=()=>{const details=input.closest('details');if(details)details.open=true;input.click();};
    this.host.querySelector('#choose-prospectus-version')!.addEventListener('click',choose);
    const dropzone=this.host.querySelector<HTMLElement>('.pf-prospectus-dropzone');
    dropzone?.addEventListener('dragover',e=>{e.preventDefault();if(!this.busy)dropzone.classList.add('is-dragging');});
    dropzone?.addEventListener('dragleave',()=>dropzone.classList.remove('is-dragging'));
    dropzone?.addEventListener('drop',e=>{e.preventDefault();dropzone.classList.remove('is-dragging');if(this.busy||this.pendingUpload)return;
      const files=e.dataTransfer?.files;if(!files?.length)return;
      if(files.length!==1){this.status('每次请选择一份募集说明书。',true);return;}
      input.files=files;input.dispatchEvent(new Event('change',{bubbles:true}));
    });
    if(input.files?.[0]){
      const file=input.files[0],preview=document.createElement('div');
      preview.className='prospectus-selected-file';
      preview.innerHTML=`<span class="prospectus-file-icon">${icon('file')}</span><div class="prospectus-file-info"><span class="prospectus-upload-label">待确认保存</span><strong>${esc(file.name)}</strong><small>${this.fileSize(file.size)} · 保存后可明确采用，已有版本保留</small></div><button type="button" class="text-button" id="cancel-prospectus-version">取消</button><button type="button" class="text-button" id="replace-prospectus-version">重新选择</button>`;
      input.before(preview);
      preview.querySelector('#replace-prospectus-version')!.addEventListener('click',choose);
      preview.querySelector('#cancel-prospectus-version')!.addEventListener('click',()=>{if(this.busy||this.pendingUpload)return;input.value='';this.render();this.host.querySelector<HTMLElement>('#choose-prospectus-version')?.focus();});
    }
    input.onchange=()=>{this.render();const button=this.host.querySelector<HTMLElement>(this.fileError()?'#replace-prospectus-version':'#save-prospectus-version');button?.focus();if(this.fileError())this.status(this.fileError(),true);};
    const newHistory=this.host.querySelector<HTMLDetailsElement>('[data-prospectus-history]')!;
    const historySummary=this.host.querySelector<HTMLElement>('[data-prospectus-history-summary]')!;
    for(const ref of this.host.querySelectorAll<HTMLDetailsElement>('[data-prospectus-ref]'))if(verified&&openRefs.has(ref.dataset.prospectusKey))ref.open=true;
    this.host.querySelector('[data-prospectus-saved-review]')?.addEventListener('click',()=>{newHistory.open=true;historySummary.focus();historySummary.scrollIntoView({block:'nearest'});});
    if(active===selectedFile&&selectedFile)selectedFile.focus({preventScroll:true});
    else if(activeRef){
      const exact=verified?[...this.host.querySelectorAll<HTMLDetailsElement>('[data-prospectus-ref]')].find(d=>d.dataset.prospectusKey===activeRef):undefined;
      (exact?.querySelector<HTMLElement>('summary')??this.host.querySelector<HTMLElement>('[data-prospectus-heading]'))?.focus({preventScroll:true});
    }else if(activeHistory)historySummary.focus({preventScroll:true});
    else if(activeReview)(this.host.querySelector<HTMLElement>('[data-prospectus-saved-review]')??this.host.querySelector<HTMLElement>('[data-prospectus-heading]'))?.focus({preventScroll:true});
    this.host.querySelector('#save-prospectus-version')!.addEventListener('click',()=>{void this.upload();});
    this.host.querySelectorAll<HTMLButtonElement>('[data-resume-prospectus]').forEach(b=>b.addEventListener('click',()=>void this.upload(b.dataset.resumeProspectus)));
    this.host.querySelectorAll<HTMLButtonElement>('[data-use-version]').forEach(b=>b.addEventListener('click',()=>this.confirmSelection(b.dataset.useVersion!)));
    this.host.querySelector('#retry-prospectus-selection')?.addEventListener('click',()=>this.confirmSelection(this.pendingSelection!.request.version_id));
    this.host.querySelectorAll<HTMLButtonElement>('[data-download-version],[data-download-revision]').forEach(b=>b.addEventListener('click',()=>{void this.action(async()=>{
      const v=this.state!.versions.find(v=>v.version_id===(b.dataset.downloadVersion||b.dataset.downloadRevision))!;
      const artifactId=b.dataset.downloadRevision?v.revision_artifact_id:v.artifact_id;
      if(artifactId){
        const artifact=await this.api.artifact(artifactId,this.controller.signal);
        if(!b.dataset.downloadRevision&&(artifact.version!==v.artifact_version||artifact.sha256!==v.sha256))throw new ApiError(409,'INPUT_REVISION_CONFLICT');
        const bytes=await this.api.artifactBytes(artifact,this.controller.signal);this.controller.signal.throwIfAborted();
        this.downloads.save(bytes,artifactFilename(artifact));
      }else{
        const m=await this.api.material(this.id,v.material_id!,this.controller.signal);
        if(m.material_version!==v.material_version||m.sha256!==v.sha256)throw new ApiError(409,'INPUT_REVISION_CONFLICT');
        const bytes=await this.api.materialBytes(this.id,m,this.controller.signal);this.controller.signal.throwIfAborted();
        this.downloads.save(bytes,v.filename);
      }
      this.controller.signal.throwIfAborted();
      this.status('文件已交给浏览器下载。');
    },'download');}));
    this.disableControls();
  }
  private fileSize(bytes:number){return bytes>=1024*1024?`${(bytes/1024/1024).toFixed(1)} MB`:`${Math.max(1,Math.ceil(bytes/1024))} KB`;}
  private fileError(){const file=this.host.querySelector<HTMLInputElement>('#prospectus-version-file')?.files?.[0];return file&&(!/\.(docx|pdf)$/i.test(file.name)||!file.size||file.size>M1_UPLOAD_LIMITS.fileBytes)?'请上传不超过 100 MB 的 DOCX 或 PDF 文件。':'';}
  private status(s:string,error=false){
    if(this.controller.signal.aborted)return;
    this.message=s;
    const panelStatus=this.host.querySelector<HTMLElement>('#prospectus-status');if(panelStatus){panelStatus.textContent=s;panelStatus.dataset.tone=error?'error':'info';panelStatus.setAttribute('role',error?'alert':'status');}
    for(const root of [this.host,this.dialog]){const status=root?.querySelector('[role="status"]');if(status)status.textContent=s;}
  }
  private disableControls(){
    for(const root of [this.host,this.dialog])root?.querySelectorAll<HTMLButtonElement|HTMLInputElement>('button,input').forEach(b=>b.disabled=this.busy);
    const save=this.host.querySelector<HTMLButtonElement>('#save-prospectus-version');if(save&&((this.purpose==='generation'&&!this.host.querySelector<HTMLInputElement>('#prospectus-version-file')?.files?.length&&!this.pendingUpload)||this.fileError())){save.disabled=true;if(this.fileError())this.status(this.fileError(),true);}
    this.host.querySelector('.prospectus-panel')?.setAttribute('aria-busy',String(this.busy));
  }
  private closeDialog(){this.dialog?.close();this.dialog?.remove();this.dialog=undefined;}
  private confirmSelection(versionId:string){
    if(this.busy||this.controller.signal.aborted||!this.state)return;
    if(this.pendingSelection?.attempted&&this.pendingSelection.request.version_id!==versionId){
      this.status('上次采用结果尚未确认，请先重试确认；已保存的文件仍保留。');
    }else if(this.pendingSelection?.request.version_id!==versionId){
      const version=this.state.versions.find(v=>v.version_id===versionId);if(!version)return;
      this.pendingSelection={request:{request_id:crypto.randomUUID(),expected_selection_revision:this.state.selection_revision,version_id:versionId},version,attempted:false};
    }
    const selection=this.pendingSelection;if(!selection)return;
    this.closeDialog();
    const current=this.state.versions.find(v=>v.version_id===this.state!.current_version_id),v=selection.version;
    const dialog=document.createElement('dialog');this.dialog=dialog;
    dialog.className='collection-file-dialog';dialog.setAttribute('aria-labelledby','prospectus-selection-heading');
    dialog.innerHTML=`<h2 id="prospectus-selection-heading">采用这版募集书？</h2><p><strong>V${v.sequence} · ${esc(v.filename)}</strong></p><p>${current?`当前采用 V${current.sequence} · ${esc(current.filename)}。采用后旧版仍保留。`:'项目尚未采用募集书，确认后将以此版为当前稿。'}</p><p>此后新任务以当前稿为依据，已有任务保留原依据；关联文件需要按新版重新核对。此操作不启动付费更新。</p><p role="status">${selection.attempted?esc(this.message):''}</p><footer class="prospectus-version-actions"><button type="button" class="btn secondary" id="cancel-prospectus-selection">暂不采用</button><button type="button" class="btn primary" id="confirm-prospectus-selection">${selection.attempted?'重试确认':'确认采用'}</button></footer>`;
    const dismiss=()=>{if(this.busy)return;if(!this.pendingSelection?.attempted)this.pendingSelection=undefined;this.closeDialog();this.render();};
    dialog.querySelector('#cancel-prospectus-selection')!.addEventListener('click',dismiss);
    dialog.querySelector('#confirm-prospectus-selection')!.addEventListener('click',()=>{void this.adopt();});
    dialog.addEventListener('cancel',e=>{e.preventDefault();dismiss();});
    document.body.append(dialog);dialog.showModal();
  }
  private async adopt(){
    const selection=this.pendingSelection;if(!selection)return;
    await this.action(async()=>{
      if(!await this.beforeChange())throw new UserFacingError('请先保存项目信息。');
      this.controller.signal.throwIfAborted();
      selection.attempted=true;
      let state:ProspectusVersions;
      try{
        state=await this.api.selectProspectus(this.id,selection.request,AbortSignal.any([this.controller.signal,AbortSignal.timeout(30_000)]));
      }catch(e){
        if(this.controller.signal.aborted)return;
        if(e instanceof ApiError&&e.status===409){
          this.pendingSelection=undefined;this.closeDialog();
          let refreshed=true;
          try{this.state=await this.api.prospectusVersions(this.id,this.controller.signal);}catch{refreshed=false;}
          this.controller.signal.throwIfAborted();this.render();
          this.status(`采用未完成：当前稿或项目状态已变化。文件仍保留，${refreshed?'请查看当前版本后重新选择。':'当前状态暂未读取，请刷新后重新选择。'}`);
          return;
        }
        if(e instanceof ApiError&&e.status>=400&&e.status<500)selection.attempted=false;
        else{
          this.status('采用结果尚未确认。文件仍保留，请重试确认；重试会沿用本次操作，不重复切换版本。');
          const button=this.dialog?.querySelector('#confirm-prospectus-selection');if(button)button.textContent='重试确认';
          this.render();return;
        }
        throw e;
      }
      this.controller.signal.throwIfAborted();
      this.state=state;this.pendingSelection=undefined;this.closeDialog();this.render();
      const adopted=state.current_version_id===selection.request.version_id;
      const message=adopted?`已采用 V${selection.version.sequence} · ${selection.version.filename}，关联文件请按新版重新核对。`:'本次采用请求已确认，但项目当前稿随后已变化。文件仍保留，请查看当前版本。';
      this.status(message);
      try{await this.changed();}
      catch{this.status(message+' 页面刷新尚未完成，请重新读取项目。');}
    });
  }
  private async action(fn:()=>Promise<void>,operation:'save'|'download'='save'){
    if(this.busy||this.controller.signal.aborted)return;this.busy=true;this.busyChanged();
    this.disableControls();
    this.status('正在处理…');
    try{await fn();}catch(e){if(!this.controller.signal.aborted)this.status(friendlyError(e,operation));}
    finally{this.busy=false;if(!this.controller.signal.aborted){this.busyChanged();this.disableControls();}}
  }
  private async upload(operationId?:string){
    const file=this.host.querySelector<HTMLInputElement>('#prospectus-version-file')!.files?.[0]??this.pendingUpload?.file;
    if(!file&&!operationId&&!this.pendingUpload){this.status('请先选择 DOCX 或 PDF 文件。');return;}
    await this.action(async()=>{
      const ext=file?.name.split('.').at(-1)?.toLowerCase();
      if(file&&(!['docx','pdf'].includes(ext??'')||!file.size||file.size>M1_UPLOAD_LIMITS.fileBytes))throw new UserFacingError('请上传不超过 100 MB 的 DOCX 或 PDF 文件。');
      if(!await this.beforeChange())throw new UserFacingError('请先保存项目信息。');
      this.controller.signal.throwIfAborted();
      const recovery=this.uploads();
      let id=operationId??this.pendingUpload?.id;
      if(!id){
        const sha256=[...new Uint8Array(await crypto.subtle.digest('SHA-256',await file!.arrayBuffer()))].map(n=>n.toString(16).padStart(2,'0')).join('');
        this.controller.signal.throwIfAborted();
        id=recovery.begin({filename:file!.name,byte_size:file!.size,sha256,media_type:ext==='docx'?M1_UPLOAD_MIME_TYPES[0]:M1_UPLOAD_MIME_TYPES[1],role:'historical'},{purpose:this.purpose}).id;
      }
      const original=recovery.list().find(r=>r.id===id);
      if(!original||original.declaration.role!=='historical'||![M1_UPLOAD_MIME_TYPES[0],M1_UPLOAD_MIME_TYPES[1]].includes(original.declaration.media_type as typeof M1_UPLOAD_MIME_TYPES[0]))throw new UserFacingError('原上传不符合募集书文件类型和角色，请保留记录并核对。');
      const pending:NonNullable<ProspectusPanel['pendingUpload']>=this.pendingUpload={id,file,uncertain:true};
      let material:Awaited<ReturnType<ApiClient['completeUpload']>>;
      try{
        material=await recovery.resume(id,{file,signal:this.controller.signal,status:s=>this.status(s),progress:(bytes,total)=>this.status(`正在上传 ${Math.floor(bytes/total*100)}%…`)});
        pending.uncertain=false;
      }catch(e){
        this.render();
        throw e;
      }
      this.status('文件已保存，正在读取版本记录…');
      try{
        const state=await this.api.prospectusVersions(this.id,this.controller.signal);
        this.controller.signal.throwIfAborted();
        const saved=state.versions.find(v=>v.material_id===material.material_id&&v.material_version===material.material_version&&v.sha256===material.sha256);
        if(!saved)throw new UserFacingError('募集书版本尚未确认。');
        await recovery.forget(id);
        this.state=state;this.savedVersionId=saved.version_id;this.pendingUpload=undefined;this.render(false);
        this.status(state.current_version_id===saved.version_id?`文件已保存，与当前采用的 V${saved.sequence} 相同，当前选择保持不变。`:`已保存 V${saved.sequence} · ${saved.filename}，尚未采用。请查看后选择“采用此版”；当前稿保持不变。`);
      }catch{
        this.controller.signal.throwIfAborted();
        throw new UserFacingError('文件已保存，但版本记录暂未读取。请重试“上传并保存”以读取原记录，文件不会重复上传。');
      }
    });
  }
}
