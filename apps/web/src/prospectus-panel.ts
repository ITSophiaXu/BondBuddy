import './upload-progress.css';
import {uploadActivity,uploadTransfer,uploadProgressHtml,type FileUploadProgress} from './upload-progress';
import { PROSPECTUS_DOCX_ONLY_MESSAGE, M1_UPLOAD_LIMITS, M1_UPLOAD_MIME_TYPES, requiresProspectusSelection, PROSPECTUS_SELECTION_REQUIRED_MESSAGE, type ProspectusVersions } from '@bondbuddy/contracts';
import { ApiClient, friendlyError, ApiError } from './api';
import { UserFacingError } from './user-facing-error';
import { ArtifactDownloads, artifactFilename } from './artifact-download';
import { esc, date } from './ui';
import { prototypeIcon as icon } from './prototype-design';
import '../../../product-prototype/public/prospectus-panel.css';
import {UploadRecovery,type UploadRecoveryRecord} from './upload-recovery';
import './update-entry.css';
import './prospectus-saved-reentry.css';
import './prospectus-reference.css';
import '../../../product-prototype/public/file-generation-ux.css';

const referenceTitle='历史／参考募集书（必填）';
const referenceDescription='上传本企业历史稿或相似企业募集书，作为本次更新的原稿或结构参考。';
const referenceUploadHint='仅支持 Word（.docx） · 每次一份，单份不超过 100 MB · 选择或拖入后自动保存并采用为原稿。';

export class ProspectusPanel {
  private uploadProgress?:FileUploadProgress; private uploadProgressError?:string;
  private paintUploadProgress(){
    for(const slot of this.host.querySelectorAll<HTMLElement>("[data-file-upload-progress]"))slot.innerHTML=this.uploadProgress?uploadProgressHtml(this.uploadProgress,this.pendingUpload?.file?.name??this.host.querySelector<HTMLInputElement>("#prospectus-version-file")?.files?.[0]?.name??"募集说明书",{error:this.uploadProgressError,paused:!this.busy&&!this.uploadProgressError}):"";
    const status=this.host.querySelector<HTMLElement>('#prospectus-status');if(status)status.hidden=!!this.uploadProgress;
    const label=this.host.querySelector(".prospectus-upload-label");if(label&&this.uploadProgress)label.textContent="";
  }
  state?:ProspectusVersions;
  busy=false;
  private readOnly=false;
  private controller=new AbortController();
  private downloads=new ArtifactDownloads();
  private message='';
  private refreshRead=0;
  private savedVersionId?:string;
  private ignoredSavedVersions=new Set<string>();
  private dialog?:HTMLDialogElement;
  private pendingSelection?:{
    request:Parameters<ApiClient['selectProspectus']>[1];
    version:ProspectusVersions['versions'][number];
    attempted:boolean;
  };
  private pendingUpload?:{id:string;file?:File;uncertain?:boolean};
  private recovery?:UploadRecovery;
  private generationSourceMode?:'upload'|'project';
  constructor(private api:ApiClient,private id:string,private host:HTMLElement,private beforeChange:()=>Promise<boolean>,private changed:()=>Promise<void>,private busyChanged:()=>void=()=>{},private purpose:'update'|'generation'|'consistency'|'project'|'qa'='update',private owner?:string,private retryRead:()=>Promise<void>=()=>this.refresh()){
    this.renderInitial();
  }
  setReadOnly(readOnly:boolean){
    if(this.readOnly===readOnly)return;
    this.readOnly=readOnly;this.host.classList.toggle('prospectus-readonly',readOnly);
    if(readOnly){
      this.host.querySelector('.is-dragging')?.classList.remove('is-dragging');
      if(!this.busy){this.closeDialog();if(!this.pendingSelection?.attempted)this.pendingSelection=undefined;}
    }
    this.disableControls();
  }
  private uploads(){if(!this.owner)throw new UserFacingError('当前账号身份尚未确认，不能建立可恢复的上传记录。');return this.recovery??=new UploadRecovery(this.api,this.owner,this.id,'prospectus-version',()=>!this.controller.signal.aborted&&this.host.isConnected);}
  private uploadRows():UploadRecoveryRecord[]{try{return this.owner?this.uploads().list():[];}catch(e){this.message=friendlyError(e,'read');return [];}}
  dispose(){this.controller.abort();this.closeDialog();this.downloads.dispose();}
  get hasUnconfirmed(){return !this.controller.signal.aborted&&(this.busy||!!this.pendingSelection?.attempted||!!this.pendingUpload?.uncertain||this.purpose==='generation'&&(!!this.pendingUpload||this.uploadRows().length>0));}
  get selectedVersionId(){return this.verifiedVersions()?this.state?.current_version_id:null;}
  get sourceSelectionMessage(){return this.purpose==='update'&&this.verifiedVersions()&&requiresProspectusSelection(this.state!)?PROSPECTUS_SELECTION_REQUIRED_MESSAGE:'';}
  private generationCandidate(){
    if(!['generation','qa'].includes(this.purpose)||!this.verifiedVersions())return;
    const current=this.state!.versions.find(v=>v.version_id===this.state!.current_version_id);
    return this.state!.versions.filter(v=>v.version_id!==current?.version_id&&!this.ignoredSavedVersions.has(v.version_id)&&(v.version_id===this.savedVersionId||!current||v.sequence>current.sequence))
      .sort((a,b)=>Number(b.version_id===this.savedVersionId)-Number(a.version_id===this.savedVersionId)||b.sequence-a.sequence)[0];
  }
  get hasPendingGenerationVersion(){return this.purpose==='generation'?false:!!this.generationCandidate();}
  async beforeLeave(){
    if(!this.hasUnconfirmed)return true;
    this.status(this.busy?'募集书正在上传或保存，请等待本次操作确认后再离开。':'本次上传或采用结果尚未确认，请先重试确认，避免重复操作。');
    return false;
  }
  get inactive(){return new Set(this.state?.inactive_material_ids??[]);}
  private referenceUpload(disabled=false){
    return `<p class="prospectus-upload-hint" id="reference-upload-hint">${referenceUploadHint}</p><p class="reference-readonly-note">本次编制材料已锁定，仅可查看和下载。</p><button type="button" class="button secondary reference-upload-picker" id="choose-prospectus-version" aria-label="上传历史／参考稿" aria-describedby="reference-upload-hint${disabled?' reference-read-status':''}" ${disabled?'disabled':''}>${icon('upload')}<span>点击或拖入文件</span></button>`;
  }
  private renderInitial(error?:string){
    if(this.purpose!=='update'||this.state||this.controller.signal.aborted)return;
    this.host.innerHTML=`<section class="panel prospectus-panel reference-prospectus" aria-label="${referenceTitle}"><header class="prospectus-panel-heading"><div><h2 tabindex="-1" data-prospectus-heading>${referenceTitle}</h2><p>${referenceDescription}</p></div></header>
      ${this.referenceUpload(true)}
      <section class="reference-files" aria-label="已上传文件" data-prospectus-files aria-busy="${!error}"><h3>已上传文件</h3><p class="reference-empty" id="reference-read-status" role="${error?'alert':'status'}">${error?`无法读取已保存的历史／参考募集书。${esc(error)}`:'正在读取已保存的历史／参考募集书，读取完成后可上传。'}</p>${error?'<button type="button" class="button secondary" data-retry-prospectus-read>重新读取募集书</button>':''}</section>
      <p id="prospectus-status" role="status"></p></section>`;
    // Keep the drop target visible without accepting a file before its records are known.
    const dropzone=this.host.querySelector<HTMLElement>('.reference-prospectus')!;
    dropzone.addEventListener('dragover',event=>{event.preventDefault();if(event.dataTransfer)event.dataTransfer.dropEffect='none';});
    dropzone.addEventListener('drop',event=>{event.preventDefault();event.stopPropagation();});
    this.host.querySelector('[data-retry-prospectus-read]')?.addEventListener('click',()=>{void this.retryRead().catch(()=>{});});
  }
  async refresh(){
    if(this.busy||this.controller.signal.aborted)return;
    const read=++this.refreshRead;
    this.renderInitial();
    let state:ProspectusVersions;
    try{state=await this.api.prospectusVersions(this.id,this.controller.signal);}
    catch(error){
      if(!this.busy&&read===this.refreshRead)this.renderInitial(friendlyError(error,'read'));
      throw error;
    }
    if(this.busy||this.controller.signal.aborted||read!==this.refreshRead||this.state&&state.selection_revision<this.state.selection_revision)return;
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
  private updateFiles(verified:boolean,current?:ProspectusVersions['versions'][number]){
    const pending=this.pendingSelection?.attempted;
    const row=(v:ProspectusVersions['versions'][number])=>{
      const selected=v.version_id===current?.version_id;
      const state=!verified?'选用状态待核对':pending?selected?'上次选用 · 结果待确认':'选用结果待确认':selected?'本次更新已选用':'未选用';
      const canDelete=verified&&!pending&&v.origin==='upload'&&v.delete_block_reason===null;
      const retained=verified&&v.origin==='upload'&&v.delete_block_reason==='used';
      return `<div class="prospectus-version reference-file ${selected?'is-selected':''}" data-prospectus-version="${esc(v.version_id)}">
        <span class="prospectus-file-icon" aria-hidden="true">${icon('file')}</span>
        <div class="prospectus-version-info"><strong>${esc(v.filename)}</strong><div class="reference-file-meta"><span class="reference-selection ${selected?'is-selected':''}" data-prospectus-selection-state>${state}</span><small>${esc(v.filename.split('.').at(-1)?.toUpperCase()??'')} · V${v.sequence} · ${esc(date(v.created_at))}</small></div>${verified?this.versionReference(v):''}${retained?'<small class="reference-retained">已作为编制依据保留</small>':''}</div>
        <div class="prospectus-version-actions">${verified&&!selected&&!pending?`<button type="button" class="btn secondary" data-use-version="${esc(v.version_id)}">改用此版</button>`:''}<button type="button" class="text-button" data-download-version="${esc(v.version_id)}">${v.origin==='generated'?'下载清洁版':'下载原文件'}</button>${v.revision_artifact_id?`<button type="button" class="text-button" data-download-revision="${esc(v.version_id)}">下载修订版</button>`:''}${canDelete?`<button type="button" class="text-button prospectus-delete" data-delete-version="${esc(v.version_id)}">删除</button>`:''}</div>
      </div>`;
    };
    const uploads=this.state!.versions.filter(v=>v.origin==='upload').sort((a,b)=>Number(b.version_id===current?.version_id)-Number(a.version_id===current?.version_id)||b.sequence-a.sequence);
    const generated=this.state!.versions.filter(v=>v.origin==='generated'&&v.version_id!==current?.version_id).sort((a,b)=>b.sequence-a.sequence);
    const historyOpen=this.host.querySelector<HTMLDetailsElement>('[data-prospectus-history]')?.open;
    return `${current?.origin==='generated'?`<section class="reference-files" aria-label="本次更新已选用"><h3>本次更新已选用</h3>${row(current)}</section>`:''}
      <section class="reference-files" aria-label="已上传文件" data-prospectus-files><h3>已上传文件 <span class="reference-file-count">${uploads.length}</span></h3>${uploads.length?uploads.map(row).join(''):`<p class="reference-empty">${current?.origin==='generated'?'本次更新沿用已选用的生成稿。':'请上传一份历史／参考募集书，填写原稿信息后再开始更新。'}</p>`}</section>
      <details class="prospectus-history reference-generated-history" data-prospectus-history ${generated.length?'':'hidden'} ${historyOpen?'open':''}><summary tabindex="0" data-prospectus-history-summary>${icon('clock')}历史生成稿（${generated.length}）${icon('down')}</summary>${generated.map(row).join('')}</details>`;
  }
  private render(preserveUpload=true){
    if(!this.state||this.controller.signal.aborted)return;
    if(this.purpose==='generation'){this.renderGeneration(preserveUpload);return;}
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
    const recoveryRows=this.uploadRows(),generation=['generation','qa'].includes(this.purpose),updating=this.purpose==='update';
    const title=updating?referenceTitle:'项目募集说明书';
    const removeButton=(v:ProspectusVersions['versions'][number])=>v.origin!=='upload'?'':v.delete_block_reason===null&&v.version_id!==current?.version_id?`<button type="button" class="text-button prospectus-delete" data-delete-version="${esc(v.version_id)}">删除</button>`:`<small class="prospectus-delete-reason">${v.version_id===current?.version_id?'正在使用，切换后可删除未使用的稿件':v.delete_block_reason==='used'?'已作为编制依据保留':'版本记录待核对'}</small>`;
    const saved=this.generationCandidate();
    const downloadButtons=(v:ProspectusVersions['versions'][number])=>`<button type="button" class="text-button" data-download-version="${esc(v.version_id)}">${icon('download')}${v.origin==='generated'?'下载清洁版':'下载原文件'}</button>${v.revision_artifact_id?`<button type="button" class="text-button" data-download-revision="${esc(v.version_id)}">下载修订版</button>`:''}`;
    this.host.innerHTML=`<section class="panel prospectus-panel ${updating?'reference-prospectus':''} ${generation?'pf-generation-prospectus':''}" aria-label="${title}"><header class="prospectus-panel-heading" data-current-summary="${current&&!this.pendingSelection?.attempted?'true':'false'}"><div><h2 tabindex="-1" data-prospectus-heading>${title}</h2><p>${!verified?'版本记录尚待核对，请重新读取项目后查看当前稿。':current&&generation?(this.pendingSelection?.attempted?'当前稿状态待确认，请先重试确认采用结果。':this.purpose==='qa'?'问答将依据此版本及选中的补充材料；已提交任务保留原依据。':'关联文件将依据此版本编制；已提交任务保留原依据。'):updating?referenceDescription:current?`${this.pendingSelection?.attempted?'上次读取的项目当前稿':'项目当前稿'}：V${current.sequence} · ${esc(current.filename)}`:this.purpose==='consistency'?'选择募集书后自动上传，再明确采用为当前稿，作为关联文件的一致性检查依据。':generation?(saved?this.purpose==='qa'?'核对募集说明书后，回到项目问答。':'核对募集说明书后，继续准备要生成的文件。':this.purpose==='qa'?'请提供本项目募集说明书，或选择项目已保存版本作为回答依据。':'上传募集书作为文件编制依据，或选择项目已保存版本。'):updating?'这里可上传历史募集说明书，作为本次更新的原稿或结构参考；无需先准备更新后的成稿。请先上传并采用一份参考稿。':'保存项目募集说明书，选择当前稿后供新任务使用。'}</p></div>${updating||generation&&!current&&!saved?'':`<button type="button" class="btn secondary" id="choose-prospectus-version">${icon('upload')}${updating?'上传历史／参考稿':current?'上传新版本':saved?'更换文件':'上传募集说明书'}</button>`}</header>
      ${updating?'':current?`<div class="prospectus-current-file"><span class="prospectus-file-icon">${icon('file')}</span><div class="prospectus-file-info"><span class="prospectus-current">${this.pendingSelection?.attempted?'上次读取的当前版本':'当前版本'} · V${current.sequence}</span><h3>${esc(current.filename)}</h3><p>${current.origin==='upload'?'用户上传':'BondBuddy 更新'} · ${esc(date(current.created_at))}</p></div><div class="prospectus-version-actions">${downloadButtons(current)}</div></div>`:generation?(saved?'':`<button type="button" class="pf-prospectus-dropzone" id="choose-prospectus-version" aria-label="上传募集说明书" ${selectedFile||saved?'hidden':''}><span class="prospectus-file-icon">${icon('upload')}</span><strong>上传募集说明书</strong><span>点击选择文件，或拖放到此处</span><small>${this.uploadFormats} · 单份不超过 100 MB</small></button>`):verified&&!(updating&&this.state.versions.length)?`<div class="prospectus-empty"><span class="prospectus-file-icon">${icon('file')}</span><div><h3>${updating?(this.state.versions.length?'尚未选择本次更新的参考稿':'请先上传历史／参考募集书'):this.state.versions.length?'尚未选择当前版本':'尚未保存募集说明书'}</h3><p>${updating?'上传成功即自动采用为原稿；尚未被任务使用的误传文件可以删除。':this.state.versions.length?'从版本历史中选择一份，或上传新版本。':'选文件后自动保存，再确认是否采用；旧版和原任务依据保留。'}</p></div></div>`:''}
      ${updating?this.referenceUpload():`<p class="prospectus-upload-hint">${generation?'选择文件后自动上传。上传仅保存文件，不启动生成或扣费。':`${this.uploadFormats}，单份不超过 100 MB。上传仅保存文件，不启动${this.purpose==='consistency'?'检查':'更新'}或扣费。`}</p>`}
      ${saved?`<aside class="pf-upload-ready" aria-label="已上传的募集说明书"><span class="prospectus-file-icon">${icon('check')}</span><div><strong>${saved.origin==='upload'?'已上传':'已保存'} · ${esc(saved.filename)}</strong><p>${current?`继续后将采用 V${saved.sequence} 为项目当前稿，原 V${current.sequence} 保留。`:`继续后将采用 V${saved.sequence} 为项目当前稿。`}已提交任务保留原依据。</p></div><button type="button" class="btn primary" data-use-saved="${esc(saved.version_id)}">使用此版继续 ${icon('arrow')}</button>${current?'<button type="button" class="text-button" data-keep-current>继续使用原版本</button>':''}</aside>`:''}
      ${otherSaved.length&&!saved&&!updating?`<aside class="prospectus-saved-notice" data-prospectus-saved-notice><div><strong>${current?'还有其他已保存版本可核对':updating?'参考稿已保存，尚未用于本次更新':'募集书已保存，尚未设置项目当前稿'}</strong><p>${current?`当前仍选用 V${current.sequence}，另有 ${otherSaved.length} 个之后保存的版本，可按需要查看或继续使用当前稿。`:`已有 ${otherSaved.length} 个已保存版本，可查看后${updating?'选择用于本次更新；上传错了可删除':'选择项目当前稿'}。`}查看不会切换当前稿或启动任务。</p></div><button type="button" class="btn secondary" data-prospectus-saved-review>查看已保存版本</button></aside>`:''}
      ${updating?this.updateFiles(verified,current):`<details class="${generation?'prospectus-history':''}" ${generation&&!this.state.versions.length?'hidden':''} data-prospectus-history data-prospectus-saved-id="${esc(this.savedVersionId??'')}" ${historyOpen||!generation&&newlySaved||this.pendingSelection?.attempted?'open':''}><summary tabindex="0" data-prospectus-history-summary>${generation?icon('clock'):''}版本历史（${this.state.versions.length}）${generation?icon('down'):''}</summary><p>${generation?'“使用此版继续”会将该版本设为项目当前稿，后续新任务将使用此版；已提交任务保留原依据。':updating?'选择一份用于本次更新。仅保存的稿件不会参与更新；未使用的上传可删除。':'“项目当前稿”是项目的默认选择；本轮复核稿和已提交任务各自保留其依据。'}版本序号表示保存顺序。</p>${this.state.versions.map(v=>`<div class="prospectus-version" data-prospectus-version="${esc(v.version_id)}"><div class="prospectus-version-info"><strong>V${v.sequence} · ${esc(v.filename)}</strong><small>${v.origin==='upload'?'用户上传':'BondBuddy 更新'} · ${esc(date(v.created_at))}</small><small data-prospectus-selection-state>${!verified?'当前稿状态待核对':v.version_id===current?.version_id?this.pendingSelection?.attempted?'上次读取的项目当前稿':'项目当前稿':this.pendingSelection?.attempted?'已保存；项目当前稿状态待确认':'已保存，未设为项目当前稿'}</small>${verified?this.versionReference(v):''}</div><div class="prospectus-version-actions">${verified&&v.version_id===current?.version_id?`<span class="prospectus-current">${this.pendingSelection?.attempted?'上次读取的项目当前稿':'项目当前稿'}</span>`:`<button type="button" class="text-button" data-use-version="${esc(v.version_id)}">${generation?'使用此版继续':updating?'用于本次更新':'采用此版'}</button>`}<button type="button" class="text-button" data-download-version="${esc(v.version_id)}">${v.origin==='generated'?'下载清洁版':'下载原文件'}</button>${v.revision_artifact_id?`<button type="button" class="text-button" data-download-revision="${esc(v.version_id)}">下载修订版</button>`:''}${verified?removeButton(v):''}</div></div>`).join('')||'<p>尚无版本记录。</p>'}</details>`}
      <${(generation||updating)?'section':'details'} class="prospectus-upload-editor" ${(generation||updating)?selectedFile||recoveryRows.length||this.pendingUpload?'':'hidden':recoveryRows.length?'open':''}>${(generation||updating)?'':`<summary>${updating?'上传历史／参考稿':'上传募集书新版本'}</summary>`}<p>${updating?'选文件后自动保存历史稿、待修改稿，或母子公司、相似企业的参考稿。上传成功即自动采用为本次原稿，再填写原稿信息；新上传稿替换当前原稿，其他版本保留。参考企业的事实不会作为本发行人的事实。':'选文件后自动上传并保存，再选择是否采用为当前稿；旧版保留。保存和采用不会启动付费更新。原稿信息仍需按文件填写。'}</p><div class="prospectus-upload"><input id="prospectus-version-file" aria-label="募集书新版本文件" type="file" accept="${this.uploadAccept}" ${(generation||updating)?'hidden':''}/><button type="button" class="btn secondary" id="save-prospectus-version" hidden>重试上传</button></div>${recoveryRows.map(r=>`<div class="prospectus-version"><div><strong>${esc(r.declaration.filename)}</strong><small>${r.stage==='saved'?'文件已保存，版本记录待确认':'原上传待确认'}；${updating?'确认成功后自动采用为原稿':'确认不会采用为当前稿'}。若需字节，请在上方重选原文件。</small></div><button type="button" class="text-button" data-resume-prospectus="${esc(r.id)}">确认原上传</button></div>`).join('')}</${(generation||updating)?'section':'details'}>
      <div data-file-upload-progress></div><p id="prospectus-status" role="status">${esc(this.message)}</p>${this.pendingSelection?.attempted?'<button type="button" class="text-button" id="retry-prospectus-selection">重试确认采用结果</button>':''}</section>`;
    if(selectedFile){
      this.host.querySelector('#prospectus-version-file')!.replaceWith(selectedFile);
      const details=selectedFile.closest('details');if(details&&uploadOpen)details.open=true;
    }
    const input=this.host.querySelector<HTMLInputElement>('#prospectus-version-file')!;
    const choose=()=>{if(this.readOnly||this.busy)return;const details=input.closest('details');if(details)details.open=true;input.click();};
    this.host.querySelector('#choose-prospectus-version')!.addEventListener('click',choose);
    const dropzone=this.host.querySelector<HTMLElement>('.pf-prospectus-dropzone')??this.host.querySelector<HTMLElement>('.reference-prospectus')??this.host.querySelector<HTMLElement>('.prospectus-upload-editor');
    dropzone?.addEventListener('dragover',e=>{
      if(!e.dataTransfer?.types.includes('Files'))return;
      e.preventDefault();const available=!this.readOnly&&!this.busy&&!this.pendingUpload&&!this.pendingSelection?.attempted;
      e.dataTransfer.dropEffect=available?'copy':'none';dropzone.classList.toggle('is-dragging',available);
    });
    dropzone?.addEventListener('dragleave',e=>{if(!(e.relatedTarget instanceof Node)||!dropzone.contains(e.relatedTarget))dropzone.classList.remove('is-dragging');});
    dropzone?.addEventListener('drop',e=>{e.preventDefault();e.stopPropagation();dropzone.classList.remove('is-dragging');if(this.readOnly||this.busy||this.pendingUpload||this.pendingSelection?.attempted)return;
      const files=e.dataTransfer?.files;if(!files?.length)return;
      if(files.length!==1){this.status('每次请选择一份募集说明书。',true);return;}
      input.files=files;input.dispatchEvent(new Event('change',{bubbles:true}));
    });
    if(input.files?.[0]){
      const file=input.files[0],preview=document.createElement('div');
      preview.className='prospectus-selected-file';
      preview.innerHTML=`<span class="prospectus-file-icon">${icon('file')}</span><div class="prospectus-file-info"><span class="prospectus-upload-label">正在准备上传</span><strong>${esc(file.name)}</strong><small>${this.fileSize(file.size)} · 保存后可明确采用，已有版本保留</small></div><button type="button" class="text-button" id="cancel-prospectus-version">取消</button><button type="button" class="text-button" id="replace-prospectus-version">重新选择</button>`;
      input.before(preview);
      preview.querySelector('#replace-prospectus-version')!.addEventListener('click',choose);
      preview.querySelector('#cancel-prospectus-version')!.addEventListener('click',()=>{if(this.busy||this.pendingUpload)return;input.value='';this.render();this.host.querySelector<HTMLElement>('#choose-prospectus-version')?.focus();});
    }
    input.onchange=()=>{
      if(this.readOnly){input.value='';return;}
      if(this.busy)return;
      this.render();const error=this.fileError();
      if(error){this.host.querySelector<HTMLElement>('#replace-prospectus-version')?.focus();this.status(error,true);return;}
      if(input.files?.length){
        // A recovery row retains its original receipt and scope; reselecting supplies bytes only.
        if(this.pendingUpload||recoveryRows.length){this.status('已重新选择文件，请点击“重试上传”或“确认原上传”继续原操作。');return;}
        void this.upload();
      }else this.host.querySelector<HTMLElement>('#save-prospectus-version')?.focus();
    };
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
    this.host.querySelectorAll<HTMLButtonElement>('[data-use-version],[data-use-saved]').forEach(b=>b.addEventListener('click',()=>this.confirmSelection((b.dataset.useVersion??b.dataset.useSaved)!)));
    this.host.querySelector('[data-keep-current]')?.addEventListener('click',()=>{for(const v of otherSaved)this.ignoredSavedVersions.add(v.version_id);this.savedVersionId=undefined;this.render();this.busyChanged();this.host.querySelector<HTMLElement>('[data-prospectus-heading]')?.focus();});
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
    this.host.querySelectorAll<HTMLElement>('[data-delete-version]').forEach(button=>button.addEventListener('click',()=>this.confirmDeletion(button.dataset.deleteVersion!)));
    this.disableControls();this.paintUploadProgress();
    {
      const save=this.host.querySelector<HTMLButtonElement>('#save-prospectus-version')!;
      save.hidden=this.busy||!selectedFile&&!this.pendingUpload||!!this.fileError();save.textContent='重试上传';
      const editor=this.host.querySelector('.prospectus-upload-editor > p');if(editor)editor.textContent=generation?'选择或拖入文件后自动上传，完成后选择使用此版继续；原版本保留。':'选择或拖入文件后自动上传并保存，再选择是否采用为当前稿；旧版保留。';
      const label=this.host.querySelector('.prospectus-upload-label');if(label)label.textContent=this.uploadProgress?'':this.fileError()?'文件无法上传':this.busy?'正在处理':'等待上传';
    }
  }
  private renderGeneration(preserveUpload:boolean){
    const state=this.state!,verified=this.verifiedVersions(),current=verified?state.versions.find(v=>v.version_id===state.current_version_id):undefined;
    const previous=preserveUpload?this.host.querySelector<HTMLInputElement>('#prospectus-version-file'):null;
    const selectedFile=previous?.files?.length?previous:null,rows=this.uploadRows();
    const hasSources=verified&&state.versions.length>0;
    const mode=hasSources?(this.generationSourceMode??(rows.length||this.pendingUpload?'upload':'project')):'upload';
    this.host.innerHTML=`<section class="panel pf-generation-prospectus pf-source-picker"><h2 data-prospectus-heading tabindex="-1">选择募集说明书</h2><p class="pf-source-help">${hasSources?'选择一种方式，确定本次使用的募集说明书。':'上传本次用于文件生成的募集说明书。'}单份不超过 100 MB。</p>
      <fieldset class="pf-source-modes" ${hasSources?'':'hidden'}><legend class="sr-only">提供募集说明书的方式</legend><label><input type="radio" name="generation-source-mode" value="upload" aria-controls="pf-source-upload" ${mode==='upload'?'checked':''}>上传新募集说明书</label><label><input type="radio" name="generation-source-mode" value="project" aria-controls="pf-source-existing" ${mode==='project'?'checked':''}>选择项目已有募集说明书</label></fieldset>
      <div id="pf-source-upload" ${mode==='upload'?'':'hidden'}><p class="pf-source-help">上传一份用于文件生成的募集说明书，${this.uploadFormats}。</p><button class="pf-source-drop" id="choose-prospectus-version" type="button">${icon('upload')}点击或拖入文件</button><input id="prospectus-version-file" type="file" accept="${this.uploadAccept}" aria-label="募集书新版本文件" hidden>
      ${selectedFile||this.pendingUpload?`<div class="pf-source-upload-state"><strong>${esc(selectedFile?.files?.[0]?.name??rows.find(r=>r.id===this.pendingUpload?.id)?.declaration.filename??'募集说明书')}</strong><span class="prospectus-upload-label">等待保存</span><button type="button" class="btn secondary" id="save-prospectus-version">重试上传</button>${!this.pendingUpload&&!rows.length?'<button type="button" class="text-button" id="cancel-prospectus-version">清除选择</button>':''}</div>`:'<button type="button" id="save-prospectus-version" hidden>重试上传</button>'}
      ${rows.filter(r=>r.id!==this.pendingUpload?.id).map(r=>`<div class="pf-source-upload-state"><strong>${esc(r.declaration.filename)}</strong><span>原上传待确认</span><button class="btn secondary" data-resume-prospectus="${esc(r.id)}">重试此文件</button></div>`).join('')}
      ${rows.map(r=>`<button class="text-button" data-stop-generation-upload="${esc(r.id)}">停止继续上传${rows.length>1?' '+esc(r.declaration.filename):''}</button>`).join('')}</div>
      <div id="pf-source-existing" ${mode==='project'?'':'hidden'}><label for="pf-project-source">选择募集说明书版本</label><select id="pf-project-source"><option value="">请选择募集说明书版本</option>${state.versions.map(v=>`<option value="${esc(v.version_id)}" ${v.version_id===current?.version_id?'selected':''}>V${v.sequence} · ${esc(v.filename)}${v.version_id===current?.version_id?' · 项目当前版本':''}</option>`).join('')}</select><p class="pf-source-help">${state.versions.length?'选用后作为项目文件生成依据，已提交任务保留原版本。':'项目还没有可选的募集说明书，请切换到“上传新募集说明书”。'}</p></div>
      ${current?`<section class="pf-selected-source" aria-label="本次生成依据"><strong>本次生成依据</strong><div><strong>${esc(current.filename)}</strong><small>募集说明书 · V${current.sequence} · 已保存</small></div><p class="pf-source-help">上传新稿或选择其他版本后，将替换本次生成依据。</p></section>`:'<p class="pf-source-help">尚未选择本次生成依据。</p>'}
      <div data-file-upload-progress></div><p id="prospectus-status" role="status">${esc(this.message)}</p>${this.pendingSelection?.attempted?'<button type="button" class="text-button" id="retry-prospectus-selection">重试确认采用结果</button>':''}</section>`;
    if(selectedFile)this.host.querySelector('#prospectus-version-file')!.replaceWith(selectedFile);
    const input=this.host.querySelector<HTMLInputElement>('#prospectus-version-file')!,drop=this.host.querySelector<HTMLElement>('#choose-prospectus-version')!;
    drop.addEventListener('click',()=>input.click());
    input.onchange=()=>{if(this.busy)return;this.generationSourceMode='upload';this.render();const error=this.fileError();if(error){this.status(error,true);return;}if(this.pendingUpload||rows.length){this.status('已重新选择文件，请重试原上传。');return;}if(input.files?.length)void this.upload();};
    drop.addEventListener('dragover',e=>{e.preventDefault();if(!this.busy)drop.classList.add('is-dragging');});
    drop.addEventListener('dragleave',()=>drop.classList.remove('is-dragging'));
    drop.addEventListener('drop',e=>{e.preventDefault();drop.classList.remove('is-dragging');if(this.busy)return;const files=e.dataTransfer?.files;if(!files?.length)return;if(files.length!==1){this.status('每次请选择一份募集说明书。',true);return;}input.files=files;input.dispatchEvent(new Event('change',{bubbles:true}));});
    this.host.querySelectorAll<HTMLInputElement>('[name=generation-source-mode]').forEach(r=>r.addEventListener('change',()=>{if(this.hasUnconfirmed)return;this.generationSourceMode=r.value as 'upload'|'project';this.host.querySelector<HTMLElement>('#pf-source-upload')!.hidden=r.value!=='upload';this.host.querySelector<HTMLElement>('#pf-source-existing')!.hidden=r.value!=='project';}));
    this.host.querySelector<HTMLSelectElement>('#pf-project-source')!.addEventListener('change',e=>{const select=e.target as HTMLSelectElement;if(!select.value||this.hasUnconfirmed){select.value=current?.version_id??'';return;}if(select.value!==current?.version_id)this.confirmSelection(select.value);});
    this.host.querySelector('#save-prospectus-version')!.addEventListener('click',()=>void this.upload());
    this.host.querySelector('#cancel-prospectus-version')?.addEventListener('click',()=>{if(this.busy||this.pendingUpload||this.uploadRows().length)return;input.value='';this.message='';this.render(false);this.host.querySelector<HTMLElement>('#choose-prospectus-version')?.focus();});
    this.host.querySelectorAll<HTMLElement>('[data-resume-prospectus]').forEach(b=>b.onclick=()=>void this.upload(b.dataset.resumeProspectus));
    this.host.querySelectorAll<HTMLElement>('[data-stop-generation-upload]').forEach(b=>b.onclick=()=>void this.action(async()=>{await this.uploads().forget(b.dataset.stopGenerationUpload!);if(this.pendingUpload?.id===b.dataset.stopGenerationUpload)this.pendingUpload=undefined;this.uploadProgress=undefined;this.uploadProgressError=undefined;this.render(false);this.status('已停止继续上传；服务器已保存的材料保留。');}));
    this.host.querySelector('#retry-prospectus-selection')?.addEventListener('click',()=>this.confirmSelection(this.pendingSelection!.request.version_id));
    this.disableControls();this.paintUploadProgress();
  }
  private get docxOnly(){return this.purpose==='update'||this.state?.upload_docx_only===true;}
  private get uploadAccept(){return this.docxOnly?'.docx':'.docx,.pdf';}
  private get uploadFormats(){return this.docxOnly?'仅支持 Word（.docx）':'支持 Word（.docx）和 PDF';}
  private uploadFileError(file:File){
    if(this.docxOnly&&!/\.docx$/i.test(file.name))return PROSPECTUS_DOCX_ONLY_MESSAGE;
    return !/\.(docx|pdf)$/i.test(file.name)||!file.size||file.size>M1_UPLOAD_LIMITS.fileBytes
      ? this.docxOnly?'请上传不超过 100 MB 的 Word（.docx）文件。':'请上传不超过 100 MB 的 DOCX 或 PDF 文件。':'';
  }
  private fileSize(bytes:number){return bytes>=1024*1024?`${(bytes/1024/1024).toFixed(1)} MB`:`${Math.max(1,Math.ceil(bytes/1024))} KB`;}
  private fileError(){const file=this.host.querySelector<HTMLInputElement>('#prospectus-version-file')?.files?.[0];return file?this.uploadFileError(file):'';}
  private status(s:string,error=false,progress?:FileUploadProgress){
    if(this.controller.signal.aborted)return;
    this.message=s;
    if(this.uploadProgress){this.uploadProgress=progress??uploadActivity(s);this.uploadProgressError=error?s:undefined;this.paintUploadProgress();}
    const panelStatus=this.host.querySelector<HTMLElement>('#prospectus-status');if(panelStatus){panelStatus.textContent=s;panelStatus.dataset.tone=error?'error':'info';panelStatus.setAttribute('role',error?'alert':'status');}
    const dialogStatus=this.dialog?.querySelector('[role="status"]');if(dialogStatus)dialogStatus.textContent=s;
  }
  private disableControls(){
    for(const root of [this.host,this.dialog])root?.querySelectorAll<HTMLButtonElement|HTMLInputElement>('button,input').forEach(b=>b.disabled=this.busy||this.readOnly&&!b.matches('[data-download-version],[data-download-revision]'));
    const save=this.host.querySelector<HTMLButtonElement>('#save-prospectus-version');if(save&&((!this.host.querySelector<HTMLInputElement>('#prospectus-version-file')?.files?.length&&!this.pendingUpload)||this.fileError())){save.disabled=true;if(this.fileError())this.status(this.fileError(),true);}
    this.host.querySelector('.prospectus-panel')?.setAttribute('aria-busy',String(this.busy));
    {
      if(save)save.hidden=this.busy||!!this.fileError()||!this.host.querySelector<HTMLInputElement>('#prospectus-version-file')?.files?.length&&!this.pendingUpload;
      const label=this.host.querySelector('.prospectus-upload-label');if(label&&!this.fileError())label.textContent=this.uploadProgress?'':this.busy?'正在处理':'等待重试';
    }
    if(this.purpose==='generation'){
      this.host.querySelectorAll<HTMLInputElement>('[name=generation-source-mode]').forEach(r=>r.disabled=this.hasUnconfirmed);
      const select=this.host.querySelector<HTMLSelectElement>('#pf-project-source');if(select)select.disabled=this.hasUnconfirmed||!this.verifiedVersions()||!this.state?.versions.length;
      const chooser=this.host.querySelector<HTMLButtonElement>('#choose-prospectus-version');if(chooser)chooser.disabled=this.busy||!!this.pendingSelection?.attempted;
    }
  }
  private closeDialog(){this.dialog?.close();this.dialog?.remove();this.dialog=undefined;}
  private confirmDeletion(versionId:string){
    if(this.readOnly||this.hasUnconfirmed||!this.verifiedVersions())return;
    const version=this.state!.versions.find(v=>v.version_id===versionId);
    if(!version?.material_id||version.delete_block_reason!==null||(versionId===this.state!.current_version_id&&this.purpose!=='update'))return;
    this.closeDialog();
    const dialog=document.createElement('dialog');this.dialog=dialog;
    dialog.className='collection-file-dialog';dialog.setAttribute('aria-labelledby','prospectus-delete-heading');
    dialog.innerHTML=`<h2 id="prospectus-delete-heading">删除这份上传文件？</h2><p><strong>V${version.sequence} · ${esc(version.filename)}</strong></p><p>此文件尚未被任务或关联文件使用。删除后会从材料和版本列表移除，可以重新上传。</p><p role="status"></p><footer class="prospectus-version-actions"><button type="button" class="btn secondary" data-cancel-delete>取消</button><button type="button" class="btn primary" data-confirm-delete>确认删除</button></footer>`;
    const dismiss=()=>{if(!this.busy)this.closeDialog();};
    dialog.querySelector('[data-cancel-delete]')!.addEventListener('click',dismiss);
    dialog.addEventListener('cancel',e=>{e.preventDefault();dismiss();});
    dialog.querySelector('[data-confirm-delete]')!.addEventListener('click',()=>{void this.removeVersion(version);});
    document.body.append(dialog);dialog.showModal();
  }
  private async removeVersion(version:ProspectusVersions['versions'][number]){
    if(this.readOnly)return;
    let removed=false;
    await this.action(async()=>{
      if(!await this.beforeChange())throw new UserFacingError('请先保存项目信息。');
      if(this.readOnly)return;
      this.controller.signal.throwIfAborted();
      try{await this.api.deleteMaterial(this.id,version.material_id!);}
      catch(e){
        if(e instanceof ApiError&&e.status===409){
          this.closeDialog();this.state=await this.api.prospectusVersions(this.id,this.controller.signal);this.render();
          this.status('文件状态已变化：正在使用或已被任务引用，不能删除。请查看最新版本。',true);return;
        }
        throw e;
      }
      removed=true;this.closeDialog();
      this.host.dispatchEvent(new CustomEvent('prospectus:deleted',{detail:{materialId:version.material_id}}));
      if(this.savedVersionId===version.version_id)this.savedVersionId=undefined;
      this.state!.versions=this.state!.versions.filter(v=>v.material_id!==version.material_id);
      this.state!.inactive_material_ids=this.state!.inactive_material_ids.filter(id=>id!==version.material_id);
      this.render();this.status(`已删除 ${version.filename}。${this.purpose==='update'?'可以重新上传参考稿，或继续提供发行人材料。':'可以重新上传正确的文件。'}`);
    });
    if(removed&&this.purpose!=='generation'&&!this.controller.signal.aborted){try{await this.changed();}catch{this.status('文件已删除，项目材料暂未刷新，请重新读取项目。');}}
  }
  private confirmSelection(versionId:string){
    if(this.readOnly||this.busy||this.controller.signal.aborted||!this.state)return;
    if(this.pendingSelection?.attempted&&this.pendingSelection.request.version_id!==versionId){
      this.status('上次采用结果尚未确认，请先重试确认；已保存的文件仍保留。');if(['generation','qa'].includes(this.purpose))return;
    }else if(this.pendingSelection?.request.version_id!==versionId){
      const version=this.state.versions.find(v=>v.version_id===versionId);if(!version)return;
      this.pendingSelection={request:{request_id:crypto.randomUUID(),expected_selection_revision:this.state.selection_revision,version_id:versionId},version,attempted:false};
    }
    const selection=this.pendingSelection;if(!selection)return;
    if(['generation','qa'].includes(this.purpose)){void this.adopt();return;}
    this.closeDialog();
    const current=this.state.versions.find(v=>v.version_id===this.state!.current_version_id),v=selection.version;
    const dialog=document.createElement('dialog');this.dialog=dialog;
    dialog.className='collection-file-dialog';dialog.setAttribute('aria-labelledby','prospectus-selection-heading');
    dialog.innerHTML=`<h2 id="prospectus-selection-heading">${this.purpose==='update'?'将这份稿件用于本次更新？':'采用这版募集书？'}</h2><p><strong>V${v.sequence} · ${esc(v.filename)}</strong></p><p>${current?`当前采用 V${current.sequence} · ${esc(current.filename)}。采用后旧版仍保留。`:this.purpose==='update'?'确认后将以此稿作为更新原稿或结构参考，请继续补充原稿信息和最新发行人材料。':'项目尚未采用募集书，确认后将以此版为当前稿。'}</p><p>此后新任务以当前稿为依据，已有任务保留原依据；关联文件需要按新版重新核对。此操作不启动付费更新。</p><p role="status">${selection.attempted?esc(this.message):''}</p><footer class="prospectus-version-actions"><button type="button" class="btn secondary" id="cancel-prospectus-selection">暂不采用</button><button type="button" class="btn primary" id="confirm-prospectus-selection">${selection.attempted?'重试确认':'确认采用'}</button></footer>`;
    const dismiss=()=>{if(this.busy)return;if(!this.pendingSelection?.attempted)this.pendingSelection=undefined;this.closeDialog();this.render();};
    dialog.querySelector('#cancel-prospectus-selection')!.addEventListener('click',dismiss);
    dialog.querySelector('#confirm-prospectus-selection')!.addEventListener('click',()=>{void this.adopt();});
    dialog.addEventListener('cancel',e=>{e.preventDefault();dismiss();});
    document.body.append(dialog);dialog.showModal();
  }
  private async adopt(){
    if(this.readOnly)return;
    const selection=this.pendingSelection;if(!selection)return;
    let notifyChanged=false;
    await this.action(async()=>{
      if(!await this.beforeChange())throw new UserFacingError('请先保存项目信息。');
      if(this.readOnly)return;
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
      notifyChanged=adopted||!['generation','qa'].includes(this.purpose);
    });
    // Let navigation guards observe the completed save before moving to the next step.
    if(notifyChanged&&!this.controller.signal.aborted){try{await this.changed();}catch{this.status('募集书已采用，但下一步暂未打开，请重试继续或重新读取项目。');}}
  }
  private async action(fn:()=>Promise<void>,operation:'save'|'download'='save'){
    if(this.busy||this.controller.signal.aborted||this.readOnly&&operation==='save')return;this.busy=true;this.refreshRead++;this.busyChanged();
    this.disableControls();this.paintUploadProgress();
    this.status('正在处理…');
    try{await fn();}catch(e){if(!this.controller.signal.aborted)this.status(friendlyError(e,operation),true);}
    finally{this.busy=false;if(!this.controller.signal.aborted){this.busyChanged();this.disableControls();}}
  }
  private async upload(operationId?:string){
    if(this.readOnly)return;
    const file=this.host.querySelector<HTMLInputElement>('#prospectus-version-file')!.files?.[0]??this.pendingUpload?.file;
    if(!file&&!operationId&&!this.pendingUpload){this.status(this.docxOnly?'请先选择 Word（.docx）文件。':'请先选择 DOCX 或 PDF 文件。');return;}
    await this.action(async()=>{
      this.uploadProgress=uploadActivity();this.uploadProgressError=undefined;this.status('正在准备募集说明书…');
      const ext=file?.name.split('.').at(-1)?.toLowerCase();
      if(file&&this.uploadFileError(file))throw new UserFacingError(this.uploadFileError(file));
      if(!await this.beforeChange())throw new UserFacingError('请先保存项目信息。');
      if(this.readOnly)return;
      this.controller.signal.throwIfAborted();
      const recovery=this.uploads();
      let id=operationId??this.pendingUpload?.id;
      if(!id){
        const sha256=[...new Uint8Array(await crypto.subtle.digest('SHA-256',await file!.arrayBuffer()))].map(n=>n.toString(16).padStart(2,'0')).join('');
        this.controller.signal.throwIfAborted();
        if(this.readOnly)return;
        id=recovery.begin({filename:file!.name,byte_size:file!.size,sha256,media_type:ext==='docx'?M1_UPLOAD_MIME_TYPES[0]:M1_UPLOAD_MIME_TYPES[1],role:'historical'},{purpose:this.purpose}).id;
      }
      const original=recovery.list().find(r=>r.id===id);
      if(!original||original.declaration.role!=='historical'||![M1_UPLOAD_MIME_TYPES[0],M1_UPLOAD_MIME_TYPES[1]].includes(original.declaration.media_type as typeof M1_UPLOAD_MIME_TYPES[0]))throw new UserFacingError('原上传不符合募集书文件类型和角色，请保留记录并核对。');
      const pending:NonNullable<ProspectusPanel['pendingUpload']>=this.pendingUpload={id,file,uncertain:true};
      let material:Awaited<ReturnType<ApiClient['completeUpload']>>;
      try{
        material=await recovery.resume(id,{file,signal:this.controller.signal,status:s=>this.status(s),progress:(bytes,total)=>{const p=uploadTransfer(bytes,total);this.status(p.message,false,p);}});
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
        this.state=state;this.savedVersionId=saved.version_id;this.ignoredSavedVersions.delete(saved.version_id);this.pendingUpload=undefined;this.uploadProgress=undefined;this.uploadProgressError=undefined;this.render(false);
        this.status(this.purpose==='update'?(state.current_version_id===saved.version_id?`已保存并自动采用 V${saved.sequence} · ${saved.filename}，将在原文基础上修改。`:'文件已保存，当前原稿随后已更新，请查看当前版本。'):['generation','qa'].includes(this.purpose)&&state.current_version_id!==saved.version_id?'':state.current_version_id===saved.version_id?`文件已保存，与当前采用的 V${saved.sequence} 相同，当前选择保持不变。`:`已保存 V${saved.sequence} · ${saved.filename}，尚未采用。${['generation','qa'].includes(this.purpose)?'点击“使用此版继续”准备文件。':'请查看后选择“采用此版”；当前稿保持不变。'}`);
      }catch{
        pending.uncertain=true;
        this.controller.signal.throwIfAborted();
        throw new UserFacingError(`文件已保存，但版本记录暂未读取。请点击“重试上传”以读取原记录，文件不会重复上传。`);
      }
    });
    if(!this.controller.signal.aborted){
      this.render();this.busyChanged();
      if(this.purpose==='generation'&&!this.pendingUpload&&this.savedVersionId){
        if(this.state?.current_version_id!==this.savedVersionId)this.confirmSelection(this.savedVersionId);
        else await this.changed();
      }else if(this.purpose==='update'&&!this.pendingUpload&&this.savedVersionId){await this.changed();}
      else if(this.purpose==='qa')this.host.querySelector<HTMLElement>('[data-use-saved]')?.focus();
    }
  }
}
