import {M1_MATERIAL_PARTITIONS, M1_UPLOAD_LIMITS, M1_UPLOAD_MIME_TYPES, ReviewMaterialPinSchema, schemas} from '@bondbuddy/contracts';
import {Value} from '@sinclair/typebox/value';
import {ApiClient, ApiError, friendlyError, type Dto} from './api';
import {UserFacingError} from './user-facing-error';
import {UploadRecovery, UploadRecoveryNeedsFileError, type UploadRecoveryRecord} from './upload-recovery';
import {date, esc} from './ui';
import './schema-formats';
import './run-supplement-draft.css';

type Response = Dto<'RunSupplementDraftResponse'>;
type Request = Dto<'RunSupplementDraftRequest'>;
type Change = Dto<'RunSupplementChange'>;
type Pin = Change['material'];
type Material = Dto<'RunSupplementMaterial'>;
type Cache = {version:1;owner:string;project:string;run:string;base_revision:number;base_hash:string;expected_revision:number;changes:Change[];pending:Request|null};
const pin = (m:Pin):Pin => ({material_id:m.material_id,material_version:m.material_version,sha256:m.sha256});
const key = (m:Pin) => `${m.material_id}:${m.material_version}:${m.sha256}`;
const same = (a:unknown,b:unknown) => Value.Equal(a,b);
const roles=M1_MATERIAL_PARTITIONS.flatMap<{code:Dto<'UploadCreateRequest'>['role'];label:string}>(p=>p.roles);
const mime:Record<string,string>=Object.fromEntries(['docx','pdf','xlsx','csv','txt','png','jpg','jpeg'].map((ext,i)=>[ext,M1_UPLOAD_MIME_TYPES[Math.min(i,6)]]));

/** Run-scoped preparation only. This component never changes execution inputs or resumes a run. */
export class RunSupplementDraftPanel {
  readonly element=document.createElement('section');
  private controller=new AbortController();
  private recovery:UploadRecovery;
  private server?:Response;
  private latest?:Response;
  private changes:Change[]=[];
  private pending?:Request;
  private expectedRevision=0;
  private files=new Map<string,File>();
  private uploadStatus=new Map<string,string>();
  private uploadErrors=new Map<string,string>();
  private needsFile=new Set<string>();
  private metadata=new Map<string,Material>();
  private records:UploadRecoveryRecord[]=[];
  private loading?:Promise<boolean>;
  private busy=false;
  private initialized=false;
  private restored=false;
  private paused?:boolean;
  private lastRead=0;
  private refreshing?:Promise<void>;
  private generation=0;
  private latestFloor=0;
  private latestUnavailable=false;
  private notice='';
  private error=false;
  private storageProblem=false;
  private storageConflict=false;
  private baseline:string|null=null;
  private intent='';
  private role:Dto<'UploadCreateRequest'>['role']='other';
  private resumeDialog?:HTMLDialogElement;
  private resumeResolve?: (value:boolean)=>void;
  private cacheKey:string;
  private storageChanged=(event:StorageEvent)=>{
    if(!this.live())return;
    if(event.key===null||event.key===this.cacheKey){this.storageConflict=true;this.say('另一页面的补料记录已有变化。本页选择保留，请明确载入本机记录后再保存。',true);}
    else if(event.key?.startsWith('bondbuddy:upload-recovery:v1:')){this.scan();this.paint();}
  };
  constructor(private api:ApiClient,private owner:string,private projectId:string,private runId:string,private current:()=>boolean,private changed:()=>void=()=>{}) {
    this.cacheKey=`bondbuddy:run-supplement:v1:${encodeURIComponent(owner)}:${encodeURIComponent(projectId)}:${encodeURIComponent(runId)}`;
    this.recovery=new UploadRecovery(api,owner,projectId,`run-supplement:${runId}`,()=>this.live());
    this.element.className='run-supplement-draft';
    this.element.dataset.runSupplement=runId;
    this.element.setAttribute('aria-label','本轮任务的补料准备');
    this.element.addEventListener('click',event=>{
      const target=(event.target as HTMLElement).closest<HTMLElement>('[data-supplement-action]');if(!target||this.busy)return;
      const id=target.dataset.uploadId;
      switch(target.dataset.supplementAction){
        case 'save':void this.save();break;
        case 'retry-save':void this.save(true);break;
        case 'receipt':void this.readReceipt();break;
        case 'reload':void this.reload();break;
        case 'use-latest':void this.resolveConflict(false);break;
        case 'keep-local':void this.resolveConflict(true);break;
        case 'local-reload':void this.reloadLocal();break;
        case 'remove':void this.removeChange(target.dataset.material??'');break;
        case 'upload-resume':if(id)void this.resumeUpload(id);break;
        case 'upload-forget':if(id)void this.forgetUpload(id);break;
      }
    });
    this.element.addEventListener('change',event=>{
      const target=event.target;
      if(target instanceof HTMLSelectElement&&target.hasAttribute('data-supplement-intent')){this.intent=target.value;const base=this.server?.base_materials.find(m=>key(m)===this.intent);if(base)this.role=base.role;this.paint();}
      if(target instanceof HTMLSelectElement&&target.hasAttribute('data-supplement-role'))this.role=target.value as typeof this.role;
      if(target instanceof HTMLInputElement&&target.hasAttribute('data-supplement-file')){const file=target.files?.[0];target.value='';target.blur();if(file)void this.addFile(file);}
      if(target instanceof HTMLInputElement&&target.dataset.supplementReselect){const file=target.files?.[0];target.value='';target.blur();if(file)void this.resumeUpload(target.dataset.supplementReselect,file);}
    });
    window.addEventListener('storage',this.storageChanged);
    this.paint();
  }
  private live(){return !this.controller.signal.aborted&&this.current();}
  private get canSave(){return !!this.server?.can_save&&this.paused!==false&&!this.latestUnavailable;}
  private get dirty(){return !!this.server&&!same(this.changes,this.server.changes);}
  get hasUnconfirmed(){return this.busy||this.dirty||!!this.pending||this.files.size>0||this.storageProblem||this.storageConflict;}
  get blocksLeave(){return this.busy||this.files.size>0||(this.dirty||!!this.pending)&&(this.storageProblem||this.storageConflict);}
  get hasSupplements(){return this.changes.length>0||!!this.server?.changes.length||!!this.latest?.changes.length||this.records.length>0||this.files.size>0||!!this.pending?.changes.length;}
  updateRun(run:Dto<'RunResponse'>){
    if(run.run_id!==this.runId)return;
    const paused=run.state==='paused';
    const changed=this.paused!==paused;
    this.paused=paused;
    // Only inspect preparation in durable paused views, or keep an existing preparation visible.
    if(paused||this.hasSupplements)void this.ensureLoaded();
    if(this.initialized&&(changed||paused&&!this.server?.can_save&&Date.now()-this.lastRead>10_000))void this.refreshAvailability();
    this.element.hidden=!paused&&!this.hasSupplements;
    if(changed)this.paint();
  }
  async ensureLoaded(){
    if(this.initialized)return true;
    if(this.loading)return this.loading;
    const task=this.load();this.loading=task;
    try{return await task;}finally{if(this.loading===task)this.loading=undefined;}
  }
  private checked(value:Response,request?:Request){
    if(!Value.Check(schemas.RunSupplementDraftResponse,value)||value.run_id!==this.runId||value.project_id!==this.projectId||value.latest_revision<value.revision||value.adopted!==false||
      this.server&&(value.base_input_revision!==this.server.base_input_revision||value.base_input_hash!==this.server.base_input_hash)||
      request&&(value.request_id!==request.request_id||value.revision!==request.expected_revision+1||!same(value.changes,request.changes)))throw new UserFacingError('补料回执与本轮原始输入或原保存请求不一致，请重新核对。');
    for(const material of [...value.base_materials,...value.result_materials])this.metadata.set(key(material),material);
    return value;
  }
  /** Latest-draft reads cannot undo an intervening write or a newer observed revision. */
  private acceptLatest(value:Response,generation:number){
    const floor=Math.max(this.latestFloor,this.server?.revision??0,this.latest?.revision??0);
    if(!this.live()||generation!==this.generation||value.revision<floor||value.latest_revision<floor)return false;
    if(value.revision!==value.latest_revision)throw new UserFacingError('最新补料版本尚未核实，请重新读取补料。');
    this.latestFloor=value.latest_revision;this.latestUnavailable=false;this.lastRead=Date.now();return true;
  }
  private async load(){
    const generation=this.generation;
    try{
      const response=this.checked(await this.api.runSupplementDraft(this.runId,undefined,this.controller.signal));if(!this.acceptLatest(response,generation))return false;
      this.server=response;this.lastRead=Date.now();this.expectedRevision=response.revision;this.changes=structuredClone(response.changes);
      if(!this.restored){this.restoreCache();this.restored=true;}
      this.scan();this.restoreSavedFiles();this.initialized=true;
      if(this.pending)await this.readReceipt();
      else this.paint();
      this.changed();
      return true;
    }catch(error){if(this.live())this.say(friendlyError(error,'read'),true);return false;}
  }
  private async refreshAvailability(){
    if(this.busy||this.refreshing||!this.server)return;
    const generation=this.generation;
    const task=(async()=>{try{
      const response=this.checked(await this.api.runSupplementDraft(this.runId,undefined,this.controller.signal));if(!this.acceptLatest(response,generation)||!this.server)return;
      const changed=response.can_save!==this.server.can_save||response.blocked_reason!==this.server.blocked_reason||response.revision!==this.server.revision;
      this.server={...this.server,can_save:response.can_save,blocked_reason:response.blocked_reason};
      if(response.revision!==this.server.revision)this.latest=response;
      if(changed){this.paint();this.changed();}
    }catch{/* Original material and local supplement selections remain available for an explicit retry. */}})();
    this.refreshing=task;try{await task;}finally{if(this.refreshing===task)this.refreshing=undefined;}
  }
  private parseCache(raw:string):Cache{
    const value=JSON.parse(raw) as Cache;
    if(!value||Object.keys(value).sort().join(',')!=='base_hash,base_revision,changes,expected_revision,owner,pending,project,run,version'||value.version!==1||value.owner!==this.owner||value.project!==this.projectId||value.run!==this.runId||
      value.base_revision!==this.server?.base_input_revision||value.base_hash!==this.server?.base_input_hash||!Number.isInteger(value.expected_revision)||value.expected_revision<0||
      !Array.isArray(value.changes)||value.changes.length>60||!value.changes.every(c=>Value.Check(schemas.RunSupplementChange,c))||value.pending!==null&&(!Value.Check(schemas.RunSupplementDraftRequest,value.pending)||value.pending.base_input_revision!==value.base_revision||value.pending.base_input_hash!==value.base_hash||!same(value.pending.changes,value.changes)||value.pending.expected_revision!==value.expected_revision))throw new UserFacingError('本机补料记录无法核实，原记录已保留，请联系支持核对。');
    return value;
  }
  private restoreCache(){
    try{
      const raw=localStorage.getItem(this.cacheKey);this.baseline=raw;if(raw===null)return;
      const value=this.parseCache(raw);this.changes=structuredClone(value.changes);this.expectedRevision=value.expected_revision;this.pending=value.pending??undefined;
      if(!this.pending&&this.expectedRevision!==this.server!.revision){
        if(same(this.changes,this.server!.changes))this.expectedRevision=this.server!.revision;
        else this.latest=this.server;
      }
    }catch(error){this.storageProblem=true;this.notice=friendlyError(error,'read');this.error=true;}
  }
  private persist(){
    if(!this.live()||!this.server||this.storageProblem||this.storageConflict)return false;
    try{
      if(localStorage.getItem(this.cacheKey)!==this.baseline){this.storageConflict=true;throw new UserFacingError('另一页面已修改补料记录。本页选择保留，请先载入本机记录。');}
      const value:Cache={version:1,owner:this.owner,project:this.projectId,run:this.runId,base_revision:this.server.base_input_revision,base_hash:this.server.base_input_hash,expected_revision:this.expectedRevision,changes:this.changes,pending:this.pending??null};
      const raw=JSON.stringify(value);this.parseCache(raw);localStorage.setItem(this.cacheKey,raw);if(localStorage.getItem(this.cacheKey)!==raw)throw new Error();this.baseline=raw;this.changed();return true;
    }catch(error){if(!this.storageConflict)this.storageProblem=true;this.notice=error instanceof UserFacingError?error.message:'无法可靠保存本机补料记录，请保留本页和原文件后重试。';this.error=true;this.changed();return false;}
  }
  private scan(){try{this.records=this.recovery.list();}catch(error){this.storageProblem=true;this.notice=friendlyError(error,'read');this.error=true;}}
  private recordReplacement(record:UploadRecoveryRecord):Pin|null{
    const context=record.context as {runId?:unknown;base_revision?:unknown;base_hash?:unknown;replaces?:unknown}|undefined;
    if(!context||Object.keys(context).sort().join(',')!=='base_hash,base_revision,replaces,runId'||context.runId!==this.runId||context.base_revision!==this.server?.base_input_revision||context.base_hash!==this.server?.base_input_hash||
      context.replaces!==null&&(!Value.Check(ReviewMaterialPinSchema,context.replaces)||!this.server?.base_materials.some(m=>key(m)===key(context.replaces as Pin)&&m.role===record.declaration.role)))throw new UserFacingError('原文件的补料用途无法核实，请保留原记录后联系支持。');
    return context.replaces as Pin|null;
  }
  private addSavedMaterial(record:UploadRecoveryRecord){
    if(!record.material)return;
    const replaces=this.recordReplacement(record),material=record.material;
    this.metadata.set(key(material),{...pin(material),source_project_id:this.projectId,filename:material.filename,role:material.role,media_type:material.media_type,available:true});
    if(!this.changes.some(c=>key(c.material)===key(material))&&!this.server?.base_materials.some(m=>key(m)===key(material))){
      if(replaces&&this.changes.some(c=>c.replaces&&key(c.replaces)===key(replaces)))throw new UserFacingError('这份原材料已有替换选择，请先移除原替换项，再确认新文件。');
      this.changes.push({material:pin(material),replaces});
    }
  }
  private restoreSavedFiles(){
    for(const record of this.records)try{this.recordReplacement(record);if(!this.pending&&!this.latest)this.addSavedMaterial(record);}catch(error){this.uploadErrors.set(record.id,friendlyError(error,'read'));}
    if(!this.pending&&!this.latest&&this.dirty)this.persist();
  }
  private say(message:string,error=false){this.notice=message;this.error=error;this.paint();this.changed();}
  private async addFile(file:File){
    if(this.busy||this.pending||this.latest||!this.canSave||!this.server||this.storageProblem||this.storageConflict)return;
    const replaces=this.server.base_materials.find(m=>key(m)===this.intent),role=replaces?.role??this.role;
    if(!file.size||file.size>M1_UPLOAD_LIMITS.fileBytes){this.say('请选择非空且不超过 100 MB 的文件。',true);return;}
    if(this.changes.length+this.records.filter(r=>!r.material).length>=60){this.say('每轮补料最多 60 份，请先核对已有选择。',true);return;}
    const mediaType=mime[file.name.split('.').at(-1)?.toLowerCase()??''];
    if(!mediaType||['historical','reference'].includes(role)&&!M1_UPLOAD_MIME_TYPES.slice(0,2).includes(mediaType as typeof M1_UPLOAD_MIME_TYPES[0])){this.say(['historical','reference'].includes(role)?'募集说明书请选择 Word 或 PDF 文件。':'请选择 Word、PDF、Excel、CSV、TXT 或图片。',true);return;}
    if(replaces&&this.changes.some(c=>c.replaces&&key(c.replaces)===key(replaces))){this.say('这份原材料已有替换选择，请先移除原替换项。',true);return;}
    const id=crypto.randomUUID();this.generation++;this.files.set(id,file);this.busy=true;this.say('正在准备原文件保存记录…');
    try{
      const sha256=[...new Uint8Array(await crypto.subtle.digest('SHA-256',await file.arrayBuffer()))].map(b=>b.toString(16).padStart(2,'0')).join('');if(!this.live())return;
      this.recovery.begin({filename:file.name,media_type:mediaType as Dto<'UploadCreateRequest'>['media_type'],byte_size:file.size,sha256,role},{runId:this.runId,base_revision:this.server.base_input_revision,base_hash:this.server.base_input_hash,replaces:replaces?pin(replaces):null},id);
      this.scan();
    }catch(error){this.files.delete(id);this.say(friendlyError(error,'save'),true);return;}
    finally{this.busy=false;if(this.live())this.paint();}
    await this.resumeUpload(id);
  }
  private async resumeUpload(id:string,file?:File){
    if(this.busy||this.pending||this.latest||!this.canSave||this.storageProblem||this.storageConflict)return;
    this.scan();const record=this.records.find(r=>r.id===id);if(!record)return;
    if(file)this.files.set(id,file);this.generation++;this.busy=true;this.uploadErrors.delete(id);this.paint();
    try{
      this.recordReplacement(record);
      await this.recovery.resume(id,{file:this.files.get(id),signal:this.controller.signal,requireDurableRecord:true,status:message=>{this.uploadStatus.set(id,message);this.paint();}});
      if(!this.live())return;this.scan();const saved=this.records.find(r=>r.id===id);if(!saved?.material)throw new Error();this.addSavedMaterial(saved);
      this.persist();this.files.delete(id);this.needsFile.delete(id);this.uploadStatus.set(id,'文件已保存；补料草稿尚未保存');this.notice='文件已保存。请保存补料草稿；本轮任务尚未采用。';this.error=false;
    }catch(error){if(this.live()){if(error instanceof UploadRecoveryNeedsFileError)this.needsFile.add(id);this.uploadErrors.set(id,friendlyError(error,'save'));}}
    finally{this.busy=false;if(this.live()){this.scan();this.paint();this.changed();}}
  }
  private async forgetUpload(id:string){
    if(this.pending)return;
    if(!window.confirm('停止跟踪这个本机文件保存待办？服务器已保存的文件仍会保留，补料选择需要另行移除。'))return;
    this.generation++;this.busy=true;this.paint();try{await this.recovery.forget(id);this.files.delete(id);this.needsFile.delete(id);this.scan();this.say('本机文件待办已停止；已保存文件和补料草稿保留。');}catch(error){this.say(friendlyError(error,'save'),true);}finally{this.busy=false;if(this.live())this.paint();}
  }
  private async removeChange(materialKey:string){
    if(this.pending||this.busy||!this.canSave||this.storageProblem||this.storageConflict)return;
    this.generation++;this.busy=true;this.paint();
    try{for(const record of this.records)if(record.material&&key(record.material)===materialKey)await this.recovery.forget(record.id);
      this.changes=this.changes.filter(c=>key(c.material)!==materialKey);this.scan();this.persist();this.notice='补料选择已移除，文件仍保留。请保存补料草稿确认本次修改。';this.error=false;
    }catch(error){this.notice=friendlyError(error,'save');this.error=true;}finally{this.busy=false;if(this.live())this.paint();}
  }
  async save(retry=false){
    if(this.busy||!await this.ensureLoaded()||this.busy||!this.canSave||!this.server||this.latest||this.latestUnavailable||this.storageProblem||this.storageConflict)return;
    this.scan();if(this.records.some(r=>!r.material)){this.say('请先确认原文件保存，再保存补料草稿。',true);return;}
    if(this.pending&&!retry){this.say('原保存结果尚未确认，请先核对原回执或重试原保存请求。',true);return;}
    if(!this.pending){if(!this.dirty){this.say('补料草稿已保存，尚未采用。');return;}this.pending={request_id:crypto.randomUUID(),expected_revision:this.expectedRevision,base_input_revision:this.server.base_input_revision,base_input_hash:this.server.base_input_hash,changes:structuredClone(this.changes)};if(!this.persist())return;}
    const generation=++this.generation;
    this.busy=true;this.paint();
    const request=this.pending;
    try{const result=this.checked(await this.api.saveRunSupplementDraft(this.runId,request,this.controller.signal),request);if(this.live())await this.acceptSave(result,request);}
    catch(error){
      if(!this.live())return;
      if(error instanceof ApiError&&error.status===409){
        this.pending=undefined;this.persist();this.notice='补料保存条件已有变化。你的选择仍保留，请核对最新状态。';this.error=true;
        try{const latest=this.checked(await this.api.runSupplementDraft(this.runId,undefined,this.controller.signal));
          if(!this.acceptLatest(latest,generation))return;
          if(latest.revision!==this.expectedRevision){this.latest=latest;this.notice='另一页面已保存补料。你的选择仍保留，请核对最新保存内容。';}
          else {this.server={...this.server,can_save:latest.can_save,blocked_reason:latest.blocked_reason};this.notice=latest.blocked_reason??this.notice;}
        }catch(readError){this.notice+=' '+friendlyError(readError,'read');}
      }
      else if(error instanceof ApiError&&error.status>=400&&error.status<500){this.pending=undefined;this.persist();this.notice=friendlyError(error,'save');this.error=true;}
      else {this.notice='补料草稿保存结果尚未确认，正在核对原保存回执。';this.error=true;await this.receipt(request);}
    }finally{this.busy=false;if(this.live()){this.paint();this.changed();}}
  }
  private async acceptSave(response:Response,request:Request){
    const generation=++this.generation;
    this.latestFloor=Math.max(this.latestFloor,response.latest_revision);
    // An exact historical receipt proves this request, while a later known draft stays current.
    const newest=[this.server,this.latest,response].filter((value):value is Response=>!!value).sort((a,b)=>b.revision-a.revision)[0];
    this.server=newest;this.changes=structuredClone(request.changes);this.expectedRevision=response.revision;this.pending=undefined;
    this.latest=newest.revision>response.revision&&newest.revision>=this.latestFloor?newest:undefined;
    this.latestUnavailable=newest.revision<this.latestFloor;this.persist();
    // Keep transport journals until the exact business receipt proves attachment.
    for(const record of this.records)if(record.material&&request.changes.some(c=>key(c.material)===key(record.material!)))try{await this.recovery.forget(record.id);}catch(error){this.uploadErrors.set(record.id,friendlyError(error,'save'));}
    this.scan();this.notice='补料草稿已保存，尚未采用。本轮任务仍使用原材料。';this.error=false;
    if(this.latest)this.notice=`原补料保存已确认（V${response.revision}），另有更新版本。请核对最新内容。`;
    if(this.latestUnavailable){
      this.notice=`原补料保存已确认（V${response.revision}），正在读取后续保存的最新版本。`;
      try{const latest=this.checked(await this.api.runSupplementDraft(this.runId,undefined,this.controller.signal));
        if(!this.acceptLatest(latest,generation))return;
        this.latest=latest;this.notice=`原补料保存已确认（V${response.revision}），另一页面随后保存了更新版本。请核对最新内容。`;
      }catch(error){if(this.live()&&generation===this.generation){this.latestUnavailable=true;this.notice=`原补料保存已确认（V${response.revision}），最新补料草稿暂不可读取。请重新读取补料核对后续版本。${friendlyError(error,'read')}`;this.error=true;}}
    }
  }
  private async receipt(request:Request){
    try{const result=this.checked(await this.api.runSupplementDraft(this.runId,request.request_id,this.controller.signal),request);if(this.live())await this.acceptSave(result,request);}
    catch(error){if(this.live()){this.notice=error instanceof ApiError&&error.status===404?'尚未找到原保存回执。原请求已保留，可核对回执或重试原保存请求。':`原保存结果尚未确认。${friendlyError(error,'read')}`;this.error=true;}}
  }
  private async readReceipt(){if(!this.pending)return;const wasBusy=this.busy;this.generation++;this.busy=true;this.paint();try{await this.receipt(this.pending);}finally{this.busy=wasBusy;if(this.live())this.paint();}}
  private async reload(){
    if(!this.server){this.initialized=false;await this.ensureLoaded();return;}
    if(this.pending){await this.readReceipt();return;}
    const generation=this.generation;
    try{const response=this.checked(await this.api.runSupplementDraft(this.runId,undefined,this.controller.signal));if(!this.acceptLatest(response,generation))return;
      if(this.dirty||this.expectedRevision!==response.revision){this.latest=response;this.say('最新保存内容已读取。本页选择保留，请选择后续使用哪一份。');}
      else {this.server=response;this.changes=structuredClone(response.changes);this.expectedRevision=response.revision;this.persist();this.say('已读取补料草稿；尚未采用。');}
    }catch(error){if(generation===this.generation)this.say(friendlyError(error,'read'),true);}
  }
  private async resolveConflict(keepLocal:boolean){
    if(!this.latest||this.pending)return;
    const latest=this.latest;
    if(latest.revision<this.latestFloor){this.latestUnavailable=true;this.say('另有更新的补料记录，请重新读取补料后再选择。',true);return;}
    this.generation++;this.busy=true;this.paint();
    try{
      if(!keepLocal){for(const record of this.records)if(record.material&&!latest.changes.some(c=>key(c.material)===key(record.material!)))await this.recovery.forget(record.id);this.scan();}
      if(!this.live())return;
      this.server=latest;this.expectedRevision=latest.revision;if(!keepLocal)this.changes=structuredClone(latest.changes);this.latest=undefined;this.latestUnavailable=false;
      this.persist();this.say(keepLocal?'本页选择保留；明确保存后将替换最新补料草稿。':'已改用最新保存的补料草稿，尚未采用。');
    }catch(error){this.say(friendlyError(error,'save'),true);}finally{this.busy=false;if(this.live())this.paint();}
  }
  private async reloadLocal(){
    if(this.busy||!window.confirm('载入另一页面的本机补料记录？本页尚未保存的补料选择将被替换，已保存文件保留。'))return;
    this.generation++;this.storageConflict=false;this.storageProblem=false;this.restoreCache();this.scan();this.restoreSavedFiles();this.paint();
  }
  beforeLeave(){if(this.busy||this.files.size>0){this.say('请先完成原文件保存并确认结果，再离开本页。',true);return false;}return !this.dirty&&!this.pending||this.persist();}
  async confirmOriginalResume(){
    if(this.busy){this.say('补料保存仍在处理中，请先确认保存结果。',true);return false;}
    if(!await this.ensureLoaded())return false;
    if(this.busy)return false;
    if(this.storageProblem||this.storageConflict){this.say('本机补料记录尚未核实，请先核对补料记录，再决定是否按原材料继续。',true);return false;}
    const generation=this.generation;
    // Read the latest draft as another page may have saved additions since this view opened.
    try{const response=this.checked(await this.api.runSupplementDraft(this.runId,undefined,this.controller.signal));if(!this.acceptLatest(response,generation)||this.busy)return false;if(response.revision!==this.server?.revision)this.latest=response;}
    catch(error){if(generation===this.generation)this.say(`补料状态尚未核实。${friendlyError(error,'read')}`,true);return false;}
    if(!this.hasSupplements)return true;
    if(this.pending){this.say('请先核对原补料保存回执，再决定是否按原材料继续。',true);return false;}
    return new Promise<boolean>(resolve=>{
      this.resumeResolve?.(false);this.resumeResolve=resolve;this.resumeDialog?.remove();
      const dialog=document.createElement('dialog');dialog.className='run-supplement-resume-dialog';
      dialog.innerHTML='<h2>按原材料继续本轮任务？</h2><p>补料尚未采用。继续本轮任务只使用原来固定的材料，本机文件和已保存补料均不会加入本次处理。</p><p>采用补料并继续需另行确认重做报价；当前计价规则尚待确认。</p><div class="form-actions"><button type="button" class="btn secondary" data-supplement-resume-cancel>返回查看补料</button><button type="button" class="btn primary" data-supplement-resume-confirm>确认按原材料继续</button></div>';
      const finish=(value:boolean)=>{dialog.close();dialog.remove();if(this.resumeDialog===dialog)this.resumeDialog=undefined;this.resumeResolve=undefined;resolve(value&&this.live()&&generation===this.generation&&!this.busy);};
      dialog.querySelector('[data-supplement-resume-cancel]')!.addEventListener('click',()=>finish(false));dialog.querySelector('[data-supplement-resume-confirm]')!.addEventListener('click',()=>finish(true));dialog.addEventListener('cancel',event=>{event.preventDefault();finish(false);});
      document.body.append(dialog);this.resumeDialog=dialog;dialog.showModal();
    });
  }
  private materialLabel(p:Pin){const m=this.metadata.get(key(p));return m?`${m.filename} · V${m.material_version}${m.available?'':'（暂不可用）'}`:`材料 ${p.material_id} · V${p.material_version}`;}
  private changesHtml(changes:Change[]){return changes.length?`<ul class="run-supplement-changes">${changes.map(c=>`<li><strong>${esc(this.materialLabel(c.material))}</strong><span>${c.replaces?`拟替换原材料：${esc(this.materialLabel(c.replaces))}`:'拟新增材料'} · 尚未采用</span>${changes===this.changes?`<button type="button" class="text-btn" data-supplement-action="remove" data-material="${esc(key(c.material))}" ${this.busy||this.pending||!this.canSave||this.storageProblem||this.storageConflict?'disabled':''}>移除补料选择</button>`:''}</li>`).join('')}</ul>`:'<p>尚未选择补料。</p>';}
  private paint(){
    if(!this.live())return;
    const focused=document.activeElement instanceof HTMLElement&&this.element.contains(document.activeElement)?document.activeElement:undefined;
    // Retain the connected native input until its file chooser returns.
    if(focused instanceof HTMLInputElement&&focused.type==='file')return;
    const focusAction=focused?.dataset.supplementAction,focusSelect=focused?.hasAttribute('data-supplement-intent')?'[data-supplement-intent]':focused?.hasAttribute('data-supplement-role')?'[data-supplement-role]':undefined;
    const baseOpen=this.element.querySelector<HTMLDetailsElement>('[data-supplement-base]')?.open??false;
    const disabled=this.busy||!this.canSave||!!this.pending||!!this.latest||this.storageProblem||this.storageConflict;
    this.element.innerHTML=`<header><h3>本轮任务补料</h3><span class="run-supplement-badge">尚未采用</span></header><p>先保存文件，再保存本轮补料草稿。保存不会继续任务或扣取重做费用。</p>${this.server?`<details data-supplement-base ${baseOpen?'open':''}><summary>查看本轮提交的原材料</summary><p>以下为本轮提交时固定的材料。</p><ul>${this.server.base_materials.map(m=>`<li>${esc(this.materialLabel(m))}</li>`).join('')||'<li>无原材料记录</li>'}</ul></details>${!this.server.can_save?`<p class="run-supplement-note">${esc(this.server.blocked_reason??'当前暂不能保存补料，请先确认任务已手动暂停且当前处理已保存。')} 已保存的补料仍会保留。</p>`:''}<div class="run-supplement-picker"><label>这份补料的用途<select data-supplement-intent ${disabled?'disabled':''}><option value="">新增材料</option>${this.server.base_materials.map(m=>`<option value="${esc(key(m))}" ${this.intent===key(m)?'selected':''}>替换：${esc(this.materialLabel(m))}</option>`).join('')}</select></label><label>材料类别<select data-supplement-role ${disabled||this.intent?'disabled':''}>${roles.map(r=>`<option value="${r.code}" ${this.role===r.code?'selected':''}>${esc(r.label)}</option>`).join('')}</select></label><label class="run-supplement-file">添加并保存文件<input type="file" data-supplement-file accept="${['historical','reference'].includes(this.role)?'.docx,.pdf':'.docx,.pdf,.xlsx,.csv,.txt,.png,.jpg,.jpeg'}" ${disabled?'disabled':''}></label></div>${this.records.length?`<ul class="run-supplement-uploads">${this.records.map(r=>`<li><strong>${esc(r.declaration.filename)}</strong><p role="status">${esc(this.uploadErrors.get(r.id)??this.uploadStatus.get(r.id)??(r.material?'文件已保存；请核对补料草稿':'原文件保存待确认'))}</p><button type="button" class="text-btn" data-supplement-action="upload-resume" data-upload-id="${esc(r.id)}" ${disabled?'disabled':''}>${r.material?'核对已保存文件':'继续保存原文件'}</button>${this.needsFile.has(r.id)?`<label>重新选择原文件<input type="file" data-supplement-reselect="${esc(r.id)}" ${disabled?'disabled':''}></label>`:''}<button type="button" class="text-btn" data-supplement-action="upload-forget" data-upload-id="${esc(r.id)}" ${this.busy||this.pending?'disabled':''}>停止本机文件待办</button></li>`).join('')}</ul>`:''}<h4>补料选择${this.dirty?' · 尚未保存':''}</h4>${this.changesHtml(this.changes)}${this.latest?`<div class="run-supplement-conflict"><h4>最新已保存内容（V${this.latest.revision}）</h4>${this.changesHtml(this.latest.changes)}<button type="button" class="btn secondary" data-supplement-action="use-latest" ${this.busy?'disabled':''}>改用最新保存内容</button><button type="button" class="btn secondary" data-supplement-action="keep-local" ${this.busy?'disabled':''}>保留本页选择，准备重新保存</button></div>`:''}<p data-supplement-saved>${this.server.saved_at?`草稿已保存 · ${esc(date(this.server.saved_at))} · V${this.server.revision}`:'补料草稿尚未保存'} · 尚未采用</p><div class="form-actions"><button type="button" class="btn primary" data-supplement-action="save" ${disabled||!this.dirty?'disabled':''}>保存补料草稿</button><button type="button" class="text-btn" data-supplement-action="reload" ${this.busy?'disabled':''}>重新读取补料</button>${this.pending?`<button type="button" class="btn secondary" data-supplement-action="receipt" ${this.busy?'disabled':''}>核对原保存回执</button><button type="button" class="btn secondary" data-supplement-action="retry-save" ${this.busy||!this.canSave||this.storageProblem||this.storageConflict?'disabled':''}>重试原保存请求</button>`:''}</div><p class="run-supplement-note">重做部分另行报价，确认追加金额后继续；计价口径待确认。目前保存的补料尚不能采用到本轮。</p><button type="button" class="btn secondary" disabled>采用补料并继续（待定价规则确认）</button>`:`<p>正在读取本轮原材料与补料草稿…</p><button type="button" class="text-btn" data-supplement-action="reload">重新读取补料</button>`}${this.storageConflict?'<button type="button" class="btn secondary" data-supplement-action="local-reload">载入另一页面的补料记录</button>':''}<p class="run-supplement-status ${this.error?'error':''}" role="${this.error?'alert':'status'}">${esc(this.notice)}</p>`;
    if(focusSelect)this.element.querySelector<HTMLElement>(focusSelect)?.focus({preventScroll:true});
    else if(focusAction)this.element.querySelector<HTMLElement>(`[data-supplement-action="${CSS.escape(focusAction)}"]`)?.focus({preventScroll:true});
  }
  dispose(){this.resumeResolve?.(false);this.resumeResolve=undefined;this.resumeDialog?.remove();this.controller.abort();window.removeEventListener('storage',this.storageChanged);this.element.remove();this.files.clear();}
}
