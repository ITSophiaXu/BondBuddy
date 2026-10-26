import {M1_UPLOAD_MIME_TYPES,type M4MaterialPin} from '@bondbuddy/contracts';
import {ApiClient,friendlyError,type Dto} from './api';
import {esc} from './ui';
import './material-reference-picker.css';

export type MaterialReferencePurpose='source'|'material';
export type MaterialReferenceChoice={applied:boolean;message:string};
type MaterialRecord={pin:M4MaterialPin;record:Dto<'MaterialResponse'>};
type PickerProject=Pick<Dto<'ProjectResponse'>,'project_id'|'name'>;
type PickerOptions={
  api:ApiClient;signal:AbortSignal;purpose:MaterialReferencePurpose;targetLabel:string;
  initialProjectId?:string;notice?:string;opener?:HTMLElement;current:()=>boolean;targetCurrent:()=>boolean;busy:()=>boolean;
  unavailable:(pin:M4MaterialPin)=>string|undefined;
  choose:(pin:M4MaterialPin,record:Dto<'MaterialResponse'>,stillChosen:()=>boolean)=>Promise<MaterialReferenceChoice>;
  report:(text:string,error?:boolean)=>void;fallbackFocus:()=>HTMLElement|undefined;
};
const pinKey=(p:M4MaterialPin)=>`${p.source_project_id}:${p.material_id}:${p.material_version}:${p.sha256}`;
const sourceMedia=new Set<string>(M1_UPLOAD_MIME_TYPES.slice(0,2));
const searchable=(s:string)=>s.normalize('NFKC').toLocaleLowerCase().trim();

/** A read-only browser until an explicit, purpose-bound file choice. */
export class MaterialReferencePicker {
  readonly dialog=document.createElement('dialog');
  private controller=new AbortController();
  private active=true;
  private projectRequest=0;
  private materialRequest=0;
  private projects:PickerProject[]=[];
  private cursor:string|null=null;
  private query='';
  private projectId='';
  private records:MaterialRecord[]=[];
  private materialQuery='';
  private materialsLoading=false;
  private materialWarning='';
  private projectLoading=false;
  private registering=false;
  private waitingForOther=false;
  private initialProject?:PickerProject;
  constructor(private options:PickerOptions){
    const source=options.purpose==='source';
    this.dialog.className='m4-picker-dialog m4-reference-picker';
    this.dialog.dataset.materialReferencePicker='';this.dialog.dataset.pickerPurpose=options.purpose;
    this.dialog.setAttribute('aria-labelledby','m4-reference-picker-title');
    this.dialog.setAttribute('aria-describedby','m4-reference-picker-purpose');
    this.dialog.innerHTML=`<header data-picker-header><div><h2 id="m4-reference-picker-title">${source?'选择募集书依据':'添加已有补充资料'}</h2><p id="m4-reference-picker-purpose">用于：<strong>${esc(options.targetLabel)}</strong> · ${source?'只更换募集书依据，补充资料与要求保留。':'加入本轮补充资料，募集书依据与要求保留。'}</p>${options.notice?`<p class="m4-reference-unavailable">${esc(options.notice)}</p>`:''}</div><button type="button" class="text-btn" data-close-picker aria-label="关闭材料选择">关闭</button></header>
      <section class="m4-reference-projects" aria-label="查找来源项目"><form data-picker-project-search><label for="m4-picker-project-query">查找已有项目</label><div class="m4-reference-search"><input id="m4-picker-project-query" name="q" maxlength="200" placeholder="项目名称或发行人"/><button type="submit" class="btn secondary" data-picker-search-projects>查找项目</button></div></form><label for="m4-picker-project">来源项目</label><div class="m4-reference-search"><select id="m4-picker-project"><option value="">选择项目</option></select><button type="button" class="text-btn" data-picker-more-projects hidden>加载更多项目</button></div><p data-picker-project-status role="status"></p></section>
      <div class="m4-reference-file-search"><label for="m4-picker-material-query">查找该项目的文件</label><input id="m4-picker-material-query" type="search" placeholder="输入文件名"/><p>${source?'仅 Word（DOCX）和 PDF 可用作募集书依据；其他格式可从补充资料区添加。':'选择后沿用这里显示的准确版本，不会自动换成同名新稿。'}</p></div>
      <div id="m4-picker-materials" data-picker-content role="region" aria-label="可选择的准确材料版本" tabindex="0"></div>
      <footer data-picker-footer><p data-picker-status role="status" tabindex="-1"></p><button type="button" class="btn secondary" data-close-picker>关闭</button><small>查看和查找不会保存材料选择；明确选择后也不会开始生成或扣费。</small></footer>`;
    this.dialog.querySelectorAll('[data-close-picker]').forEach(b=>b.addEventListener('click',()=>this.close()));
    this.dialog.addEventListener('cancel',event=>{event.preventDefault();this.close();});
    this.dialog.querySelector('[data-picker-project-search]')!.addEventListener('submit',event=>{
      event.preventDefault();const q=this.dialog.querySelector<HTMLInputElement>('#m4-picker-project-query')!.value.trim();void this.loadProjects(q,false);
    });
    this.dialog.querySelector('[data-picker-more-projects]')!.addEventListener('click',()=>void this.loadProjects(this.query,true));
    this.dialog.querySelector('#m4-picker-project')!.addEventListener('change',event=>void this.loadMaterials((event.target as HTMLSelectElement).value));
    const search=this.dialog.querySelector<HTMLInputElement>('#m4-picker-material-query')!;
    let composing=false;
    search.addEventListener('compositionstart',()=>{composing=true;});
    const filter=()=>{if(!composing){this.materialQuery=search.value;this.paintMaterials();}};
    search.addEventListener('input',filter);search.addEventListener('compositionend',()=>{composing=false;filter();});
    this.dialog.addEventListener('click',event=>{
      const target=(event.target as HTMLElement).closest<HTMLElement>('[data-adopt-pin]');
      if(target)void this.choose(target.dataset.adoptPin!);
      if((event.target as HTMLElement).closest('[data-picker-clear-materials]')){search.value='';this.materialQuery='';this.paintMaterials();search.focus();}
      if((event.target as HTMLElement).closest('[data-picker-retry-materials]'))void this.loadMaterials(this.projectId);
    });
  }
  open(){document.body.append(this.dialog);this.dialog.showModal();this.waitingForOther=this.options.busy();this.setStatus(this.waitingForOther?'原文件仍在登记。可先查找，原结果确认后再选择。':'请核对文件、版本与本次用途，再明确选择。');this.paintMaterials();void this.loadProjects('',false,true);}
  private live(){return this.active&&!this.options.signal.aborted&&this.dialog.isConnected&&this.dialog.open&&this.options.current();}
  private setStatus(text:string,error=false){
    const node=this.dialog.querySelector<HTMLElement>('[data-picker-status]')!;
    node.textContent=text;node.classList.toggle('error',error);node.setAttribute('role',error?'alert':'status');
  }
  private paintProjects(){
    const select=this.dialog.querySelector<HTMLSelectElement>('#m4-picker-project')!;
    const pinned=this.initialProject&&!this.projects.some(p=>p.project_id===this.initialProject!.project_id)?this.initialProject:undefined;
    select.innerHTML='<option value="">选择项目</option>'+(pinned?`<optgroup label="本页来源项目"><option value="${esc(pinned.project_id)}">${esc(pinned.name)}</option></optgroup>`:'')+this.projects.map(p=>`<option value="${esc(p.project_id)}">${esc(p.name)}</option>`).join('');
    select.value=this.projectId;
    const more=this.dialog.querySelector<HTMLButtonElement>('[data-picker-more-projects]')!;
    more.hidden=!this.cursor;more.disabled=this.projectLoading;more.textContent=this.projectLoading?'正在读取项目…':'加载更多项目';
  }
  private async loadProjects(q:string,more:boolean,initial=false){
    if(!this.live()||more&&(!this.cursor||this.projectLoading))return;
    const token=++this.projectRequest,cursor=more?this.cursor:undefined;
    this.projectLoading=true;this.paintProjects();
    const status=this.dialog.querySelector<HTMLElement>('[data-picker-project-status]')!;status.textContent='正在读取可访问项目…';
    try{
      const page=await this.options.api.projects(cursor??undefined,{q,limit:'50'},this.controller.signal);
      if(!this.live()||token!==this.projectRequest)return;
      if(initial&&this.options.initialProjectId){
        this.initialProject=page.items.find(p=>p.project_id===this.options.initialProjectId);
        if(!this.initialProject)try{const project=await this.options.api.project(this.options.initialProjectId,this.controller.signal);if(project.project_id===this.options.initialProjectId)this.initialProject=project;}catch{/* The successfully read project page remains usable. */}
        if(!this.live()||token!==this.projectRequest)return;
      }
      const seen=new Set<string>();
      this.projects=[...(more?this.projects:[]),...page.items].filter(p=>!seen.has(p.project_id)&&!!seen.add(p.project_id));
      this.query=q;this.cursor=page.page.next_cursor;
      if(cursor&&this.cursor===cursor){this.cursor=null;status.textContent='后续项目游标未前进，已保留当前项目；请重新查找。';}
      else status.textContent=`已读取 ${this.projects.length} 个项目${this.cursor?'，可加载更多':''}${q?' · 查找：'+q:''}。`;
      if(initial&&this.initialProject)this.projectId=this.initialProject.project_id;
      else if(!more&&!this.projects.some(p=>p.project_id===this.projectId)&&this.initialProject?.project_id!==this.projectId){this.projectId='';this.materialRequest++;this.records=[];this.materialsLoading=false;this.paintMaterials();}
      this.paintProjects();
      if(initial&&this.projectId)void this.loadMaterials(this.projectId);
    }catch(error){if(this.live()&&token===this.projectRequest)status.textContent=`项目尚未读取完成，原已读范围保留。${friendlyError(error,'read')} 可再次查找或加载更多。`;}
    finally{if(this.live()&&token===this.projectRequest){this.projectLoading=false;this.paintProjects();}}
  }
  private async loadMaterials(projectId:string){
    if(!this.live())return;
    const token=++this.materialRequest;
    this.projectId=projectId;this.records=[];this.materialWarning='';this.materialsLoading=!!projectId;this.materialQuery='';
    this.dialog.querySelector<HTMLInputElement>('#m4-picker-material-query')!.value='';
    this.paintMaterials();if(!projectId)return;
    try{
      let cursor=0;const ids=new Set<string>();
      while(this.live()&&token===this.materialRequest){
        const page=await this.options.api.projectEvents(projectId,cursor,this.controller.signal);
        if(!this.live()||token!==this.materialRequest)return;
        for(const event of page.items)if(event.type==='material.upload_progress'&&event.payload.material_id)ids.add(event.payload.material_id);
        if(page.next_cursor===null)break;
        if(page.next_cursor<=cursor)throw new Error('Material event cursor did not advance');
        cursor=page.next_cursor;
      }
      const records=await Promise.allSettled([...ids].map(async id=>({id,record:await this.options.api.material(projectId,id,this.controller.signal)})));
      if(!this.live()||token!==this.materialRequest||this.projectId!==projectId)return;
      let inaccessible=0;
      this.records=records.flatMap(result=>{
        if(result.status==='rejected'){inaccessible++;return [];}
        const {id,record:m}=result.value;
        if(m.material_id!==id||!Number.isInteger(m.material_version)||m.material_version<1||!/^[a-f0-9]{64}$/i.test(m.sha256)){inaccessible++;return [];}
        return m.state==='persisted'?[{record:m,pin:{source_project_id:projectId,material_id:id,material_version:m.material_version,sha256:m.sha256}}]:[];
      });
      this.materialWarning=inaccessible?'部分文件暂不可读取或准确版本无法核实，未列为可选项。':'';
    }catch(error){if(this.live()&&token===this.materialRequest)this.materialWarning=`材料尚未读取完成。${friendlyError(error,'read')}`;}
    finally{if(this.live()&&token===this.materialRequest){this.materialsLoading=false;this.paintMaterials();}}
  }
  private paintMaterials(){
    const host=this.dialog.querySelector<HTMLElement>('#m4-picker-materials')!;
    if(this.materialsLoading){host.innerHTML='<p role="status">正在读取材料…</p>';return;}
    if(!this.projectId){host.innerHTML='<p>请先选择来源项目。</p>';return;}
    const q=searchable(this.materialQuery),visible=this.records.filter(r=>!q||searchable(r.record.filename).includes(q));
    host.innerHTML=`<p class="m4-reference-count">已读取 ${this.records.length} 份可访问文件${q?' · 匹配 '+visible.length+' 份':''}</p><ul class="m4-file-list">${visible.map(({pin,record})=>{
      const unsupported=this.options.purpose==='source'&&!sourceMedia.has(record.media_type);
      const unavailable=unsupported?'此格式不能用作募集书依据，请从补充资料区添加。':this.options.unavailable(pin);
      return `<li class="m4-file" data-picker-file="${esc(pinKey(pin))}"><strong>${esc(record.filename)}</strong><p>V${pin.material_version} · ${esc(this.projects.find(p=>p.project_id===pin.source_project_id)?.name??(this.initialProject?.project_id===pin.source_project_id?this.initialProject.name:pin.source_project_id))}</p><details><summary>查看准确引用</summary><p>项目 ${esc(pin.source_project_id)}<br>材料 ${esc(pin.material_id)} · V${pin.material_version}<br>SHA-256 ${esc(pin.sha256)}</p></details>${unavailable?`<p class="m4-reference-unavailable">${esc(unavailable)}</p>`:''}<button type="button" class="btn secondary" data-adopt-pin="${esc(pinKey(pin))}" ${this.registering||this.options.busy()||unavailable||!this.options.targetCurrent()?'disabled':''}>${this.options.purpose==='source'?'用作募集书依据':'添加为补充资料'}</button></li>`;
    }).join('')||`<li>${q?'没有匹配的文件。<button type="button" class="text-btn" data-picker-clear-materials>清除文件查找</button>':'该项目暂无可选择的已保存文件。'}</li>`}</ul>${this.materialWarning?`<p role="alert">${esc(this.materialWarning)}</p><button type="button" class="text-btn" data-picker-retry-materials>重新读取该项目文件</button>`:''}`;
  }
  refreshAvailability(){
    if(!this.live())return;
    for(const button of this.dialog.querySelectorAll<HTMLButtonElement>('[data-adopt-pin]')){
      const item=this.records.find(r=>pinKey(r.pin)===button.dataset.adoptPin);
      button.disabled=!item||this.registering||this.options.busy()||!this.options.targetCurrent()||!!(item&&(this.options.purpose==='source'&&!sourceMedia.has(item.record.media_type)||this.options.unavailable(item.pin)));
    }
    if(this.waitingForOther&&!this.options.busy()){this.waitingForOther=false;this.setStatus('原文件登记已结束，请核对当前文件与用途后明确选择。');}
  }
  private async choose(key:string){
    if(!this.live()||this.registering||this.options.busy())return;
    const item=this.records.find(r=>pinKey(r.pin)===key);
    if(!item)return;
    if(this.options.purpose==='source'&&!sourceMedia.has(item.record.media_type)||this.options.unavailable(item.pin))return;
    if(!this.options.targetCurrent()){this.setStatus('本页材料、文种或待确认状态已有变化。原内容保留，请关闭后重新选择。',true);return;}
    const project=this.projectId,read=this.materialRequest;
    this.registering=true;this.paintMaterials();this.setStatus('正在登记所选准确版本；原草稿尚未改变。关闭后不会再自动采用。');
    try{
      const result=await this.options.choose(structuredClone(item.pin),structuredClone(item.record),()=>this.live()&&this.projectId===project&&this.materialRequest===read);
      if(result.applied){if(this.live())this.close(false);this.options.report(result.message);}
      else{if(this.live())this.setStatus(result.message,true);this.options.report(result.message,true);}
    }catch(error){
      const text=`文件登记或选择尚未确认。${friendlyError(error,'save')} 原草稿保留；请刷新工作区核对已登记文件，再明确选择，不会自动重发。`;
      if(this.live())this.setStatus(text,true);this.options.report(text,true);
    }finally{this.registering=false;if(this.live())this.paintMaterials();}
  }
  close(report=true){
    if(!this.active)return;
    if(report&&this.registering)this.options.report('已关闭材料选择。已发出的文件登记可能继续，但不会再自动用于本页草稿；可刷新核对已登记文件。');
    this.dispose();const focus=this.options.opener?.isConnected?this.options.opener:this.options.fallbackFocus();focus?.focus({preventScroll:true});
  }
  dispose(){this.active=false;this.controller.abort();if(this.dialog.open)this.dialog.close();this.dialog.remove();}
}
