import {WORKPAPER_PRICE,WORKPAPER_LIMITS,WORKPAPER_DECISION_LABELS,WorkpaperAssessSchema,type WorkpaperAssess,type WorkpaperAssessment,WorkpaperStartSchema,type WorkpaperStart,type WorkpaperWorkspace,type WorkpaperCatalogue,type WorkpaperBatch,type ProjectFileSource} from '@bondbuddy/contracts';
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
  private assessing?:WorkpaperAssess;private reviewed=false;private reviewedHash?:string;
  private pending?:WorkpaperStart;private busy=false;private status='';private requirements='';private filter='';private upload:UploadFileMaterialState={};private storageError=false;
  constructor(private api:ApiClient,private host:HTMLElement,private project:string,private owner:string,private source:ProjectFileSource|null,private current:()=>boolean){}
  private get key(){return `bb-workpapers-v1:${this.owner}:${this.project}`;}
  get hasUnconfirmed(){return this.busy||!!this.pending||!!this.assessing||this.storageError;}
  async beforeLeave(){return !this.busy&&!this.storageError;}
  dispose(){this.controller.abort();clearTimeout(this.timer);this.downloads.dispose();}
  private live(){return !this.controller.signal.aborted&&this.current()&&this.host.isConnected;}
  private request<T>(method:string,path='',body?:unknown){return this.api.request<T>(method,`/projects/${encodeURIComponent(this.project)}/workpapers${path}`,body,{},this.controller.signal);}
  private save(){try{localStorage.setItem(this.key,JSON.stringify({catalogue:this.catalogue?.catalogue_id,selected:[...this.selected],requirements:this.requirements,pending:this.pending,assessing:this.assessing}));this.storageError=false;return true;}catch{this.storageError=true;this.status='本浏览器无法保存待提交请求，请恢复存储后重试；尚未提交生成任务。';return false;}}
  async render(){
    this.host.innerHTML='<p role="status">正在读取底稿目录与生成进度…</p>';
    try{
      this.data=await this.request<WorkpaperWorkspace>('GET');if(!this.live())return;
      const saved=JSON.parse(localStorage.getItem(this.key)??'null');
      if(saved?.assessing){if(!Value.Check(WorkpaperAssessSchema,saved.assessing))throw Error('invalid assessment');this.assessing=saved.assessing;}
      if(saved?.pending){if(!Value.Check(WorkpaperStartSchema,saved.pending))throw Error('invalid pending');this.pending=saved.pending;}
      this.catalogue=this.data.catalogues.find(c=>c.catalogue_id===(this.pending?.catalogue_id??this.assessing?.catalogue_id??saved?.catalogue))??this.data.catalogues[0];
      this.selected=new Set(this.pending?.item_ids??this.assessing?.item_ids??(saved&&this.catalogue&&saved.catalogue===this.catalogue.catalogue_id?saved.selected:undefined)??this.catalogue?.entries.filter(e=>e.kind==='file').map(e=>e.id)??[]);
      this.requirements=this.pending?.requirements??this.assessing?.requirements??saved?.requirements??'';this.paint();this.poll();
    }catch(e){if(this.live()){this.host.innerHTML='<p role="status">底稿记录暂时无法读取。原记录已保留，请刷新重试。</p>';}}
  }
  private paint(){
    if(!this.live())return;
    const sourceHref='#generate?'+withProjectContext(new URLSearchParams({project:this.project,step:'source'}));
    this.host.innerHTML=`<ol class="wp-workflow" aria-label="底稿生成流程"><li><span>1</span><div><strong>上传目录</strong><small>Excel 列出所需底稿</small></div></li><li><span>2</span><div><strong>判断范围</strong><small>核对不能生成的文件</small></div></li><li><span>3</span><div><strong>确认生成</strong><small>下载底稿与逐份说明</small></div></li></ol>
      <section class="panel wp-prepare" aria-label="按底稿目录批量生成"><div class="wp-upload-zone"><span class="wp-upload-icon">${ico('upload')}</span><h2>上传底稿目录</h2><p>将你的 Excel 目录变成一套底稿文件。</p><label class="wp-upload-picker"><span class="btn primary">${ico('plus')}选择 Excel 底稿目录</span><input id="wp-upload" type="file" accept=".xlsx" aria-label="上传底稿目录（XLSX，10 MB 以内）" aria-describedby="wp-upload-help" ${this.pending||this.assessing?'disabled':''}></label><small id="wp-upload-help">XLSX · 10 MB 以内 · 最多 ${WORKPAPER_LIMITS.items.toLocaleString()} 份文件</small></div>
      <div class="wp-source-context ${this.source?'':'wp-source-missing'}"><span class="wp-source-icon">${ico('file')}</span><div><small>生成依据 · 募集说明书</small><strong>${this.source?`${esc(this.source.filename)} · V${this.source.sequence}`:'请先上传并采用募集说明书'}</strong></div><a class="text-button" href="${esc(sourceHref)}">${this.source?'查看 / 更换':'上传募集说明书'} ${ico('arrow')}</a></div>
      <details class="wp-format-help"><summary>Excel 目录怎么准备？</summary><p>至少包含“底稿名称”或“文件名称”列；可提供“编号、目录路径、类型、编制要求”。文件夹在“类型”列填写“目录”。旧版 XLS 请另存为 XLSX。</p></details>
      ${this.data.catalogues.length?`<div class="wp-catalogue-selection"><label>已上传目录<select id="wp-catalogue" ${this.pending||this.assessing?'disabled':''}>${this.data.catalogues.map(c=>`<option value="${esc(c.catalogue_id)}" ${this.catalogue?.catalogue_id===c.catalogue_id?'selected':''}>${esc(c.filename)}</option>`).join('')}</select></label><span>${this.catalogue?.entries.filter(e=>e.kind==='file').length??0} 份底稿已识别</span></div>`:''}
      <div id="wp-upload-recovery"></div><p id="wp-status" role="status">${esc(this.status)}</p>
      ${this.catalogue?`<details ${this.catalogue.warnings.length?'open':''}><summary>目录识别提示（${this.catalogue.warnings.length}）</summary>${this.catalogue.warnings.map(w=>`<p>${esc(w)}</p>`).join('')}</details>
      <div class="wp-controls"><label>查找底稿<input id="wp-filter" type="search" value="${esc(this.filter)}" placeholder="编号或名称"></label><button class="btn secondary" id="wp-all" ${this.pending||this.assessing?'disabled':''}>选择全部文件</button><button class="btn secondary" id="wp-none" ${this.pending||this.assessing?'disabled':''}>清空选择</button></div><div id="wp-entries"></div>
      <label>本批编制要求（选填）<textarea id="wp-requirements" rows="3" maxlength="12000" ${this.pending||this.assessing?'disabled':''}>${esc(this.requirements)}</textarea></label>
      <div id="wp-confirm"></div>`:''}<p class="wp-explanation-note">不生成的文件将逐份附说明。资料不足或需要原始证据时，会注明“暂无法生成”，不直接认定业务不适用。</p></section><section class="wp-batches" id="wp-batches" aria-label="底稿生成任务"></section>`;
    this.host.querySelector('#wp-upload')?.addEventListener('change',e=>{const file=(e.target as HTMLInputElement).files?.[0];if(file)void this.importFile(file);});
    this.host.querySelector('#wp-catalogue')?.addEventListener('change',e=>{this.catalogue=this.data.catalogues.find(c=>c.catalogue_id===(e.target as HTMLSelectElement).value);this.selected=new Set(this.catalogue?.entries.filter(e=>e.kind==='file').map(e=>e.id));this.save();this.paint();});
    this.host.querySelector('#wp-filter')?.addEventListener('input',e=>{this.filter=(e.target as HTMLInputElement).value;this.paintEntries();});
    this.host.querySelector('#wp-all')?.addEventListener('click',()=>{this.selected=new Set(this.catalogue!.entries.filter(e=>e.kind==='file').map(e=>e.id));this.save();this.paintEntries();});
    this.host.querySelector('#wp-none')?.addEventListener('click',()=>{this.selected.clear();this.save();this.paintEntries();});
    this.host.querySelector('#wp-requirements')?.addEventListener('input',e=>{this.requirements=(e.target as HTMLTextAreaElement).value;this.reviewed=false;this.save();this.paintConfirm();});
    this.paintEntries();this.paintBatches();this.paintRecovery();
  }
  private paintEntries(){
    const node=this.host.querySelector('#wp-entries');if(!node||!this.catalogue)return;
    const entries=this.catalogue.entries.filter(e=>!this.filter||`${e.code} ${e.title} ${e.folder}`.includes(this.filter));
    node.innerHTML=`<div class="wp-table-wrap"><table class="wp-table"><thead><tr><th>生成</th><th>编号 / 名称</th><th>保存目录</th><th>原表位置</th></tr></thead><tbody>${entries.map(e=>`<tr><td>${e.kind==='file'?`<input type="checkbox" aria-label="选择 ${esc(e.title)}" data-wp-item="${esc(e.id)}" ${this.selected.has(e.id)?'checked':''} ${this.pending||this.assessing?'disabled':''}>`:'目录'}</td><td><strong>${esc(e.code)} ${esc(e.title)}</strong>${e.instructions?`<small>${esc(e.instructions)}</small>`:''}</td><td>${esc(e.folder||'根目录')}</td><td>${esc(e.sheet)} · ${e.row} 行</td></tr>`).join('')}</tbody></table></div>`;
    node.querySelectorAll<HTMLInputElement>('[data-wp-item]').forEach(c=>c.addEventListener('change',()=>{c.checked?this.selected.add(c.dataset.wpItem!):this.selected.delete(c.dataset.wpItem!);this.reviewed=false;this.save();this.paintConfirm();}));this.paintConfirm();
  }
  private matchingAssessment(){
    return this.data.assessments.find(a=>a.request.catalogue_id===this.catalogue?.catalogue_id&&a.request.catalogue_sha256===this.catalogue?.sha256
      &&a.source.version_id===this.source?.version_id&&a.source.selection_revision===this.source.selection_revision
      &&a.request.requirements===this.requirements&&a.request.item_ids.length===this.selected.size&&a.request.item_ids.every(id=>this.selected.has(id)));
  }
  private paintConfirm(){
    const node=this.host.querySelector('#wp-confirm');if(!node)return;const count=this.selected.size,a=this.matchingAssessment();
    if(this.pending){
      node.innerHTML='<p>上次已确认 '+this.pending.item_ids.length+' 项，费用 '+this.pending.expected_points.toLocaleString()+' 积分。请先确认上次提交结果，原范围及判断版本保留。</p><button class="btn primary" id="wp-start" '+(this.busy||this.storageError?'disabled':'')+'>继续确认上次提交</button>';
      node.querySelector('#wp-start')?.addEventListener('click',()=>void this.start());return;
    }
    if(this.reviewedHash!==a?.result_hash)this.reviewed=false;
    const ready=a?.state==='succeeded'&&!!a.result_hash,waiting=!!a&&['queued','running','paused'].includes(a.state);
    const active=this.data.batches.some(b=>['queued','running','paused'].includes(b.state));
    const generated=ready?a.decisions.filter(d=>d.status==='generate').length:0,excluded=ready?count-generated:0;
    node.innerHTML=`<p><strong>已选 ${count} 份底稿</strong></p><p>本批依据：${this.source?`${esc(this.source.filename)} · V${this.source.sequence}`:'请先选择募集说明书'}</p>
      <p class="muted">范围判断及不生成项说明不另收费。实际生成底稿每份 ${WORKPAPER_PRICE.points.toLocaleString()} 积分，包含正文和编制说明；确认后按现有规则逐份扣费。</p>
      ${ready?`<h3>生成范围判断</h3><p><strong>可生成 ${generated} 份；不生成 ${excluded} 份，改为对应说明。</strong> 本批共 ${(generated*WORKPAPER_PRICE.points).toLocaleString()} 积分。</p>
       <p>请核对下面全部不生成项及理由。补充资料或更换募集书后可重新判断。</p>
       ${a.warnings.map(w=>'<p class="muted">'+esc(w)+'</p>').join('')}
       <div class="wp-table-wrap wp-assessment"><table class="wp-table"><thead><tr><th>编号 / 文件</th><th>判断 / 理由</th><th>募集书依据 / 待补材料</th></tr></thead><tbody>${[...a.decisions].sort((x,y)=>Number(x.status==='generate')-Number(y.status==='generate')).map(d=>{
         const entry=this.catalogue!.entries.find(e=>e.id===d.item_id)!;
         return '<tr data-wp-decision="'+esc(d.status)+'"><td>'+esc(entry.code+' '+entry.title)+'</td><td><strong>'+esc(WORKPAPER_DECISION_LABELS[d.status])+'</strong><p>'+esc(d.reason)+'</p></td><td>'+d.citations.map(c=>'<p>['+esc(c.location??c.span_id)+'] '+esc(c.quote)+'</p>').join('')+(!d.citations.length?'<p>未取得充分引用依据。</p>':'')+d.missing_materials.map(m=>'<p>待补：'+esc(m)+'</p>').join('')+'</td></tr>';
       }).join('')}</tbody></table></div>
       <label class="wp-review"><input type="checkbox" id="wp-reviewed" ${this.reviewed?'checked':''} ${this.busy||this.pending?'disabled':''}>我已核对生成范围及全部不生成项，同意为不生成项逐份生成说明</label>
       <button class="btn primary" id="wp-start" ${(!this.reviewed&&!this.pending)||this.busy||this.storageError||active&&!this.pending?'disabled':''}>${this.pending?'继续确认上次提交':'确认范围与费用，生成底稿及说明'}</button>`
       :`<p>${waiting?'正在结合募集说明书判断：'+a!.completed_items+' / '+count+' 项。完成前不会生成底稿。':a?'上次判断未完成，可重新判断。':'先判断每份文件能否生成，再确认生成范围。'}</p>`}
      ${!ready||!this.pending?`<button class="btn secondary" id="wp-assess" ${!count||!this.source||this.busy||this.storageError||(waiting&&!this.assessing)||active?'disabled':''}>${this.assessing?'继续确认判断请求':ready?'重新判断':'判断生成范围'}</button>`:''}
      ${a&&a.state==='paused'?`<a href="#tasks">查看暂停任务</a>`:''}`;
    node.querySelector('#wp-reviewed')?.addEventListener('change',e=>{this.reviewed=(e.target as HTMLInputElement).checked;this.reviewedHash=a?.result_hash??undefined;this.paintConfirm();});
    node.querySelector('#wp-start')?.addEventListener('click',()=>void this.start());
    node.querySelector('#wp-assess')?.addEventListener('click',()=>void this.assess());
  }
  private async assess(){await this.act(async()=>{
    if(!this.assessing){if(!this.catalogue||!this.source||!this.selected.size)return;
      this.assessing={request_id:crypto.randomUUID(),catalogue_id:this.catalogue.catalogue_id,catalogue_sha256:this.catalogue.sha256,item_ids:[...this.selected],source_version_id:this.source.version_id,source_selection_revision:this.source.selection_revision,requirements:this.requirements};
      if(!this.save())return;this.paint();
    }
    let a:WorkpaperAssessment;
    try{a=await this.request<WorkpaperAssessment>('POST','/assessments',this.assessing);}
    catch(e){if(e instanceof ApiError&&e.code==='PROJECT_FILE_BATCH_INPUT_EXPIRED'){this.assessing=undefined;this.source=null;this.save();this.paint();}throw e;}
    this.assessing=undefined;this.reviewed=false;this.save();this.data.assessments=[a,...this.data.assessments.filter(x=>x.assessment_id!==a.assessment_id)];
    this.status='范围判断已提交；完成后请核对不生成项及理由。';this.paint();this.poll();
  });}
  private paintRecovery(){
    const node=this.host.querySelector('#wp-upload-recovery');if(!node)return;
    try{const records=new UploadRecovery(this.api,this.owner,this.project,'workpaper-catalogue',()=>this.live()).list();
      node.innerHTML=records.map(r=>`<p>待确认上传：${esc(r.declaration.filename)} <button class="btn secondary" data-wp-upload="${esc(r.id)}">继续确认</button> <label>重新选择原文件<input type="file" accept=".xlsx" data-wp-reselect="${esc(r.id)}"></label></p>`).join('');
      node.querySelectorAll<HTMLElement>('[data-wp-upload]').forEach(b=>b.onclick=()=>void this.importFile(undefined,b.dataset.wpUpload));
      node.querySelectorAll<HTMLInputElement>('[data-wp-reselect]').forEach(b=>b.onchange=()=>void this.importFile(b.files?.[0],b.dataset.wpReselect));
    }catch{node.textContent='原上传记录无法读取，请恢复浏览器存储后刷新。';}
  }
  private async act(fn:()=>Promise<void>){if(this.busy)return;this.busy=true;this.paintConfirm();try{await fn();}catch(e){this.status=friendlyError(e,'submit');}finally{this.busy=false;if(this.live()){const status=this.host.querySelector('#wp-status');if(status)status.textContent=this.status;this.paintConfirm();this.paintRecovery();}}}
  private async importFile(file?:File,operation?:string){
    if(this.pending||this.assessing)return;
    await this.act(async()=>{
      if(file&&(!/\.xlsx$/i.test(file.name)||file.size>WORKPAPER_LIMITS.fileBytes))throw new UserFacingError('请上传 10 MB 以内的 XLSX。');
      if(operation)this.upload={operationId:operation,projectId:this.project};else if(file)this.upload={};
      const pin=await uploadFileMaterial(this.api,this.project,file,this.controller.signal,s=>{this.status=s;const n=this.host.querySelector('#wp-status');if(n)n.textContent=s;},this.upload,this.owner,'workpaper-catalogue',undefined,()=>this.live());
      const cat=await this.request<WorkpaperCatalogue>('POST','/catalogues',{request_id:this.upload.operationId,material:pin});
      await this.upload.recovery?.forget(this.upload.operationId!);this.upload={};this.catalogue=cat;
      this.data.catalogues=[cat,...this.data.catalogues.filter(c=>c.catalogue_id!==cat.catalogue_id)];this.selected=new Set(cat.entries.filter(e=>e.kind==='file').map(e=>e.id));this.status='目录已保存，请核对文件清单、数量与费用。';this.save();this.paint();
    });
  }
  private async start(){await this.act(async()=>{
    if(!this.pending){if(!this.catalogue||!this.source||!this.selected.size)return;
      const assessment=this.matchingAssessment();if(!assessment?.result_hash||!this.reviewed)return;
      this.pending={assessment_id:assessment.assessment_id,assessment_hash:assessment.result_hash,request_id:crypto.randomUUID(),catalogue_id:this.catalogue.catalogue_id,catalogue_sha256:this.catalogue.sha256,item_ids:[...this.selected],source_version_id:this.source.version_id,source_selection_revision:this.source.selection_revision,requirements:this.requirements,price_version:WORKPAPER_PRICE.version,expected_points:assessment.decisions.filter(d=>d.status==='generate').length*WORKPAPER_PRICE.points};
      if(!this.save())return;this.paint();}
    let batch:WorkpaperBatch;
    try{batch=await this.request<WorkpaperBatch>('POST','/batches',this.pending);}catch(e){
      if(e instanceof ApiError&&e.code==='PROJECT_FILE_BATCH_INPUT_EXPIRED'){this.pending=undefined;this.save();this.source=null;this.paint();throw new UserFacingError('原底稿文件包未提交。募集书依据已变化，请刷新页面后重新核对并提交。');}throw e;
    }
    this.pending=undefined;this.reviewed=false;this.save();this.data.batches=[batch,...this.data.batches.filter(b=>b.batch_id!==batch.batch_id)];this.status='底稿文件包已提交，关闭页面后仍会继续。';this.paint();this.poll();
  });}
  private paintBatches(){
    const node=this.host.querySelector('#wp-batches');if(!node)return;
    const opened=new Set([...node.querySelectorAll<HTMLDetailsElement>('details[open]')].map(e=>e.dataset.batch));
    node.innerHTML=`<h2>底稿生成进度</h2>${!this.data.batches.length?'<p class="muted">尚未提交底稿文件包。</p>':''}${this.data.batches.map(b=>{
      const done=b.items.filter(i=>i.state==='succeeded').length,failed=b.items.filter(i=>['failed','rejected','cancelled'].includes(i.state)&&i.run_id).length;
      return `<article class="panel wp-batch"><h3>${esc(stateNames[b.state])} · ${done} / ${b.items.length} 份完成${failed?` · ${failed} 份未完成`:''}</h3><progress max="${b.items.length}" value="${done}" aria-label="底稿完成进度"></progress><p>${esc(b.source.filename)} · V${b.source.sequence} · ${date(b.created_at)} · 已扣 ${b.charged_points.toLocaleString()} 积分</p>${b.error?`<p role="status">${esc(b.error)}</p>`:''}
      <div class="wp-actions">${done?`<button class="btn secondary" data-wp-zip="${esc(b.batch_id)}">打包下载已完成底稿</button>`:''}${(['queued','running'].includes(b.state)?['pause','cancel']:b.state==='paused'?['resume','cancel']:b.state==='partial'||b.state==='cancelled'?['retry_failed']:[]).map(action=>`<button class="btn secondary" data-wp-action="${action}" data-batch="${esc(b.batch_id)}">${({pause:'当前文件后暂停',resume:'继续文件包',cancel:'结束后续排队',retry_failed:'重试未完成项'} as Record<string,string>)[action]}</button>`).join('')}</div>
      <details data-batch="${esc(b.batch_id)}" ${opened.has(b.batch_id)?'open':''}><summary>查看逐份状态与下载</summary><ul class="wp-items">${b.items.map(i=>`<li><div><strong>${esc(i.entry.code)} ${esc(i.entry.title)}</strong><small>${esc(runStateLabel[i.state as keyof typeof runStateLabel]??stateNames[i.state]??i.state)}${i.explanation?' · 已生成不适用说明':''}${i.error?' · '+esc(i.error):''}</small></div><div class="wp-actions">${i.explanation?'<button class="text-button" data-wp-explanation="'+esc(i.entry.id)+'" data-batch="'+esc(b.batch_id)+'">下载不适用说明</button>':''}${i.artifacts.map(a=>`<button class="text-button" data-wp-art="${esc(a.pin.artifact_id)}" data-wp-batch="${esc(b.batch_id)}">${a.kind==='document'?'下载底稿':'编制说明'}</button>`).join('')}${i.run_id?`<a href="#generate?topic=${encodeURIComponent(b.topic_id)}&run=${encodeURIComponent(i.run_id)}&return_project=${encodeURIComponent(this.project)}">任务详情</a>`:''}</div></li>`).join('')}</ul></details></article>`;}).join('')}`;
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
    try{if(!this.busy){const data=await this.request<WorkpaperWorkspace>('GET');if(this.live()){this.data=data;this.paintBatches();this.paintConfirm();}}}catch{const node=this.host.querySelector('#wp-status');if(node)node.textContent='进度暂时无法读取，后台任务继续；稍后自动重试。';}finally{this.poll();}
  })(),5000);}
}
