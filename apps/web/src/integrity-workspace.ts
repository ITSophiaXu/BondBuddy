import {INTEGRITY_SITES,INTEGRITY_PROVINCES,INTEGRITY_PRICE,resolveIntegritySite,inferIntegrityRegion,MARKET_LABELS,OFFERING_LABELS,MARKET_OFFERINGS,type IntegrityWorkspace as Workspace,type IntegritySubject,type IntegrityRound,type IntegrityRecord} from '@bondbuddy/contracts';
import {ApiClient,ApiError,friendlyError,type Dto} from './api';
import {ProjectEntry,projectFlowSteps} from './project-entry';
import {integritySitePicker,bindIntegritySitePicker} from './integrity-site-picker';
import {ArtifactDownloads,artifactFilename} from './artifact-download';
import {mountIntegrityBrowserEvidence} from './integrity-browser-evidence';
import {esc,date} from './ui';
import {runStateLabel} from './review-state';
import './file-workspace.css';
import './integrity-workspace.css';

const steps=['选择项目','名单与网站范围','核查结果与底稿'];
const terminal=new Set(['succeeded','failed','cancelled','rejected','test_completed']);
const links=(site:{links:{url:string;label:string}[]})=>site.links.map(l=>`<a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(l.label)} ↗</a>`).join(' · ');
const statusNames={public_matches:'发现相关记录',no_public_results:'本次未检索到',needs_manual:'待核实',not_applicable:'不适用',query_failed:'查询未完成'};
const recordStatus=(record:IntegrityRecord)=>record.browser?.outcome==='blocked'?(/验证码|登录|滑块/.test(record.reason)?'需要验证码 / 登录':'查询未完成'):statusNames[record.status];
const provinces=(value:string)=>`<option value="">请选择注册地</option>${INTEGRITY_PROVINCES.map(p=>`<option ${p===value?'selected':''}>${esc(p)}</option>`).join('')}`;
export class IntegrityWorkspace {
 private controller=new AbortController();private entry?:ProjectEntry;private state?:Workspace;private project?:Dto<'ProjectResponse'>;private busy=false;private dirty=false;private dialog?:HTMLDialogElement;private timer?:ReturnType<typeof setTimeout>;private downloads=new ArtifactDownloads();private runRequest?:{request_id:string;expected_revision:number;price_version:typeof INTEGRITY_PRICE.version;expected_points:5000};
 constructor(private api:ApiClient,private shell:(html:string,section:string)=>void,private current:()=>boolean,private id?:string){}
 private live(){return this.current()&&!this.controller.signal.aborted;}
 get hasUnconfirmed(){return this.busy||this.dirty;}
 async beforeLeave(){if(this.busy)return false;if(this.dirty){try{await this.save();}catch(e){this.status('名单尚未保存。'+this.error(e));return false;}}return true;}
 dispose(){this.entry?.dispose();this.controller.abort();this.dialog?.remove();clearTimeout(this.timer);this.downloads.dispose();}
 private request<T>(method:'GET'|'POST',suffix:string,body?:unknown){const run=new URLSearchParams(location.hash.split('?')[1]).get('run');if(method==='GET'&&!suffix&&run)suffix='?run_id='+encodeURIComponent(run);return this.api.request<T>(method,`/projects/${encodeURIComponent(this.id!)}/integrity${suffix}`,body,{},this.controller.signal);}
 private error(e:unknown){return e instanceof ApiError?friendlyError(e):e instanceof Error?e.message:'操作未完成，请重试。';}
 private status(s:string){const n=document.querySelector('#integrity-status');if(n)n.textContent=s;}
 private async act(fn:()=>Promise<void>){if(this.busy)return;this.busy=true;const fields=[...document.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement|HTMLButtonElement>('main input,main select,main textarea,main button,dialog input,dialog select,dialog textarea,dialog button')].map(n=>({n,disabled:n.disabled}));fields.forEach(f=>f.n.disabled=true);try{await fn();}catch(e){if(this.live()){this.status(this.error(e));const n=this.dialog?.querySelector('[role=status]');if(n)n.textContent=this.error(e);}}finally{this.busy=false;fields.forEach(f=>{if(f.n.isConnected)f.n.disabled=f.disabled;});}}
 async render(){
  if(!this.id){this.entry=new ProjectEntry(this.api,this.shell,()=>this.live(),{section:'integrity',title:'诚信核查',eyebrow:'INTEGRITY CHECK',description:'选择项目，准备企业与人员名单，查询公开记录并形成核查底稿。',steps,next:'下一步：名单与网站范围',onNew:()=>this.newProject(),open:async id=>{if(this.live())location.hash='integrity?project='+encodeURIComponent(id);}});await this.entry.render();return;}
  this.shell('<p role="status">正在读取诚信核查…</p>','integrity');
  try{[this.project,this.state]=await Promise.all([this.api.project(this.id,this.controller.signal),this.request<Workspace>('GET','')]);if(this.live())this.paint();}
  catch(e){if(this.live())this.shell(`<h1>诚信核查暂时无法打开</h1><p role="alert">${esc(this.error(e))}</p><a class="btn secondary" href="#integrity">重新选择项目</a>`,'integrity');}
 }
 private header(step:number){return `<a class="back-link" href="#tasks">← 返回全部项目</a><header class="page-head"><div><p class="eyebrow">INTEGRITY CHECK</p><h1>诚信核查</h1><p>按项目准备名单与网站范围，保留查询记录与核查底稿。</p></div></header>${projectFlowSteps(steps,step,'诚信核查流程')}<div class="pf-source-strip pf-project-strip"><div><strong>${esc(this.project!.name)}</strong><small>${esc(this.project!.issuer_name??'')}</small></div><a class="text-button" href="#integrity">更换项目</a><a class="text-button" href="#/projects/${encodeURIComponent(this.id!)}/files">项目文件 →</a></div>`;}
 private paint(){
  clearTimeout(this.timer);if(!this.live()||!this.state)return;
  const runId=new URLSearchParams(location.hash.split('?')[1]).get('run'),round=this.state.rounds.find(r=>r.run_id===runId);
  if(runId&&!round){this.shell(`${this.header(3)}<p role="alert">本项目没有此核查记录，或记录已超出本页历史范围。</p><a href="#integrity?project=${encodeURIComponent(this.id!)}">返回名单</a>`,'integrity');return;}
  if(round){this.paintRound(round);return;}
  this.paintDraft();
 }
 private paintDraft(){
  for(const subject of this.state!.draft.subjects){const region=inferIntegrityRegion(subject);if(region.province!==subject.province){Object.assign(subject,region);this.changed();}}
  const d=this.state!.draft;
  this.shell(`${this.header(2)}<section class="panel integrity-panel integrity-roster-panel"><div class="pf-section-head"><div><h2>核查对象名单 <small id="integrity-subject-count">${d.subjects.length}</small></h2><p>直接在行内编辑企业与人员，保存后可在本项目继续使用。</p></div><div class="integrity-actions"><button class="btn secondary" id="integrity-issuer">带入发行人</button><button class="btn secondary" id="integrity-add">＋ 添加企业</button><button class="btn secondary" id="integrity-person">＋ 添加人员</button></div></div><div class="integrity-roster" id="integrity-roster">${this.subjectRows()}</div><p class="integrity-roster-help">人员识别信息用于内部核对，不会传入公开搜索，底稿仅显示尾号。</p><details class="integrity-batch"><summary>批量添加名单</summary><p>每行一个对象，使用制表符分隔：类型（企业或人员）、名称、关系或职务、身份标识（选填）。最多 100 个对象。</p><label>批量名单<textarea id="integrity-batch" rows="4" placeholder="企业&#9;企业全称&#9;子公司&#10;人员&#9;姓名&#9;董事"></textarea></label><button class="btn secondary" id="integrity-import">添加到名单</button><p id="integrity-batch-status" role="status"></p></details></section>
  <section class="panel integrity-panel integrity-sites-panel">${integritySitePicker(d.site_ids)}
   <div class="integrity-registration"><h3>企业注册地 · 自动识别与匹配</h3><p>优先使用已有注册地；企业名称含明确省份时自动带入，可直接修改。深圳、大连、宁波、厦门、青岛单独匹配。</p><div id="integrity-regions">${this.regionRows()}</div></div>
   <p class="integrity-contact">网站还在持续补充，找不到所需网站？<button class="text-button" id="integrity-contact">联系我们加网站 →</button></p></section>
  <section class="panel integrity-panel"><label>本轮核查说明<textarea id="integrity-notes" rows="3" maxlength="12000" placeholder="选填：补充核查范围与需要关注的事项">${esc(d.notes)}</textarea></label></section><section class="panel integrity-panel"><h2>生成核查底稿文件</h2><p>包含核查汇总、各网站查询记录、取证索引、待办说明与签字页。</p><ul><li>3-1-1 发行人诚信信息汇总清单及查询记录</li><li>1-5-3-4 董事及高级管理人员诚信信息汇总清单及查询记录</li></ul><p>按名单分别生成企业、人员底稿，归档至 4 底稿文件 / 4.3 诚信核查。</p></section><p id="integrity-status" role="status"></p>
  <footer class="pf-footer"><button class="btn secondary" id="integrity-save">保存名单与范围</button><div><span>每轮 <strong>5,000</strong> 积分 · 同轮重新导出免费</span><button class="btn primary" id="integrity-start" ${d.subjects.length&&d.site_ids.length?'':'disabled'}>开始诚信核查</button></div></footer>
  ${this.state!.rounds.length?`<section class="panel integrity-panel"><h2>核查历史与底稿</h2>${this.state!.rounds.map(r=>`<a class="integrity-history" href="#integrity?project=${encodeURIComponent(this.id!)}&run=${encodeURIComponent(r.run_id)}"><span><strong>${r.operation==='check'?'诚信核查':'核查底稿导出'} · 第 ${r.sequence} 次任务</strong><small>${esc(date(r.created_at))} · ${r.manifest.draft.subjects.length} 个对象 · ${r.manifest.draft.site_ids.length} 个网站</small></span><span>${esc((runStateLabel[r.state as keyof typeof runStateLabel]??r.state))} →</span></a>`).join('')}</section>`:''}`,'integrity');
  document.querySelector('#integrity-add')!.addEventListener('click',()=>this.addSubject('company'));
  document.querySelector('#integrity-person')!.addEventListener('click',()=>this.addSubject('person'));
  document.querySelector('#integrity-issuer')!.addEventListener('click',()=>{const name=this.project!.issuer_name?.trim()??'',existing=d.subjects.find(s=>s.kind==='company'&&(name?s.name.trim()===name:s.role==='发行人'));if(existing){this.subjectField(existing.id,'name')?.focus();this.status('发行人已在名单中，可直接在该行编辑。');return;}this.addSubject('company',name,'发行人');});
  document.querySelector('#integrity-import')!.addEventListener('click',()=>this.importSubjects());
  document.querySelector('#integrity-roster')!.addEventListener('input',e=>{
   const n=e.target;if(!(n instanceof HTMLInputElement||n instanceof HTMLSelectElement)||!n.dataset.subject)return;
   const s=d.subjects.find(s=>s.id===n.dataset.subject);if(!s)return;const field=n.dataset.field;
   if(field==='kind'){if(n.value!=='company'&&n.value!=='person')return;s.kind=n.value;this.changed();this.paintSubjects(s.id,'kind');return;}
   if(field!=='name'&&field!=='role'&&field!=='identifier')return;s[field]=n.value;this.changed();this.subjectError(s.id);
   if(field==='name'){const label=document.getElementById('integrity-region-name-'+s.id);if(label)label.textContent=s.name.trim()||'未填写企业名称';}
  });
  document.querySelector('#integrity-roster')!.addEventListener('focusout',e=>{const n=e.target;if(!(n instanceof HTMLInputElement)||n.dataset.field!=='name')return;const subject=d.subjects.find(s=>s.id===n.dataset.subject);if(!subject||subject.province)return;const region=inferIntegrityRegion(subject);if(region.province){Object.assign(subject,region);this.changed();document.querySelector('#integrity-regions')!.innerHTML=this.regionRows();}});
  document.querySelector('#integrity-roster')!.addEventListener('click',e=>{
   const b=(e.target as Element).closest<HTMLButtonElement>('[data-remove]');if(!b||this.busy)return;const index=d.subjects.findIndex(s=>s.id===b.dataset.remove);if(index<0)return;
   d.subjects.splice(index,1);this.changed();this.paintSubjects(d.subjects[Math.min(index,d.subjects.length-1)]?.id);if(!d.subjects.length)document.querySelector<HTMLButtonElement>('#integrity-add')!.focus();
  });
  bindIntegritySitePicker(()=>d.site_ids,ids=>{d.site_ids=ids;this.changed();this.updateCount();});
  document.querySelector('#integrity-regions')!.addEventListener('input',e=>{const n=e.target;if(!(n instanceof HTMLInputElement||n instanceof HTMLSelectElement)||!n.dataset.region)return;const s=d.subjects.find(s=>s.id===n.dataset.region);if(!s||(n.dataset.field!=='province'&&n.dataset.field!=='city'))return;s[n.dataset.field]=n.value;this.changed();document.getElementById('integrity-region-'+s.id)!.innerHTML=this.regional(s);});
  document.querySelector('#integrity-notes')!.addEventListener('input',e=>{d.notes=(e.target as HTMLTextAreaElement).value;this.changed();});
  document.querySelector('#integrity-save')!.addEventListener('click',()=>{if(this.validateSubjects())void this.act(async()=>{await this.save();this.status('名单与网站范围已保存。');});});
  document.querySelector('#integrity-start')!.addEventListener('click',()=>this.confirmStart());
  document.querySelector('#integrity-contact')!.addEventListener('click',()=>void this.act(async()=>{const a=await this.api.agreement();if(this.live())this.modal('联系我们加网站',`<p>请提供网站名称、官网网址和需要查询的事项。</p><p>${esc(a.support_contact||'请通过账号帮助渠道联系 BondBuddy 服务团队。')}</p>`);}));
 }
 private regional(s:IntegritySubject){return ['local-csrc','local-tax'].map(id=>{const site=resolveIntegritySite(INTEGRITY_SITES.find(s=>s.id===id)!,s);return site.links.length?`<div>${links({...site,links:site.links.map(l=>({...l,label:site.name}))})}</div>`:'<small>待补注册地 / 网站</small>';}).join('');}
 private changed(){this.dirty=true;this.runRequest=undefined;}
 private updateCount(){document.querySelector('#integrity-site-count')!.textContent=`（已选 ${this.state!.draft.site_ids.length} 个）`;document.querySelector<HTMLButtonElement>('#integrity-start')!.disabled=!this.state!.draft.subjects.length||!this.state!.draft.site_ids.length;}
 private async save(){if(!this.validateSubjects())throw Error('请先修正名单中标出的内容，或移除不需要的行。');const draft={...this.state!.draft,subjects:this.state!.draft.subjects.map(s=>({...s,name:s.name.trim(),role:s.role.trim(),identifier:s.identifier.trim()}))};const snapshot=JSON.stringify(this.state!.draft);const saved=await this.request<Workspace>('POST','/draft',{expected_revision:this.state!.revision,draft});if(this.live()){this.state!.revision=saved.revision;this.state!.rounds=saved.rounds;this.dirty=JSON.stringify(this.state!.draft)!==snapshot;}}
 private modal(title:string,body:string){this.dialog?.remove();const d=document.createElement('dialog');d.className='pf-modal integrity-modal';d.innerHTML=`<header><h2>${esc(title)}</h2><button class="icon-btn" data-close aria-label="关闭">×</button></header>${body}<p role="status"></p>`;document.body.append(d);d.showModal();d.querySelector('[data-close]')!.addEventListener('click',()=>{if(!this.busy)d.close();});d.addEventListener('cancel',e=>{if(this.busy)e.preventDefault();});d.addEventListener('close',()=>d.remove());this.dialog=d;return d;}
 private newProject(){
  const d=this.modal('新建项目',`<form><label>项目名称<input name="name" required maxlength="200"></label><label>发行人全称<input name="issuer_name" required maxlength="200"></label><label>市场<select name="market">${Object.entries(MARKET_LABELS).map(([k,v])=>`<option value="${k}">${v}</option>`).join('')}</select></label><label>品种<select name="offering"></select></label><button class="btn primary">创建项目并准备核查</button></form>`);
  const market=d.querySelector<HTMLSelectElement>('[name=market]')!,offering=d.querySelector<HTMLSelectElement>('[name=offering]')!,key=crypto.randomUUID();const sync=()=>{offering.innerHTML=MARKET_OFFERINGS[market.value as keyof typeof MARKET_OFFERINGS].map(v=>`<option value="${v}">${OFFERING_LABELS[v]}</option>`).join('');};sync();market.addEventListener('change',sync);
  d.querySelector('form')!.addEventListener('submit',e=>{e.preventDefault();const f=new FormData(e.target as HTMLFormElement);void this.act(async()=>{const p=await this.api.request<Dto<'ProjectResponse'>>('POST','/projects',{creation_request_id:key,kind:'generation',name:f.get('name'),issuer_name:f.get('issuer_name'),market:market.value,offering:offering.value},{},this.controller.signal);if(this.live()){d.close();location.hash='integrity?project='+encodeURIComponent(p.project_id);}});});
 }
 private subjectRows(){
  return this.state!.draft.subjects.map((s,i)=>`<div class="integrity-subject" data-subject-row="${esc(s.id)}"><span class="integrity-row-number">${String(i+1).padStart(2,'0')}</span>
   <label>对象类型<select data-subject="${esc(s.id)}" data-field="kind" aria-label="对象 ${i+1} 类型"><option value="company" ${s.kind==='company'?'selected':''}>企业</option><option value="person" ${s.kind==='person'?'selected':''}>人员</option></select></label>
   <label>名称 / 姓名<input data-subject="${esc(s.id)}" data-field="name" aria-label="对象 ${i+1} 名称" aria-describedby="integrity-subject-error-${esc(s.id)}" value="${esc(s.name)}" required maxlength="200" placeholder="填写完整名称"></label>
   <label>关系 / 职务<input data-subject="${esc(s.id)}" data-field="role" aria-label="对象 ${i+1} 关系" value="${esc(s.role)}" maxlength="200" placeholder="如发行人、董事"></label>
   <label>${s.kind==='company'?'统一社会信用代码':'识别信息'} <span class="muted">选填</span><input data-subject="${esc(s.id)}" data-field="identifier" aria-label="对象 ${i+1} 识别信息" aria-describedby="integrity-subject-error-${esc(s.id)}" value="${esc(s.identifier)}" maxlength="${s.kind==='company'?18:200}" placeholder="${s.kind==='company'?'18 位信用代码':'任职公司等消歧信息'}"></label>
   <button type="button" class="icon-btn" data-remove="${esc(s.id)}" aria-label="移除对象 ${i+1}" title="移除此行">×</button><p class="integrity-subject-error" id="integrity-subject-error-${esc(s.id)}" role="alert" hidden></p></div>`).join('')||'<div class="collection-empty"><h3>添加本轮需要核查的对象</h3><p>可先带入发行人，再补充相关企业与人员。</p></div>';
 }
 private regionRows(){return this.state!.draft.subjects.filter(s=>s.kind==='company').map(s=>`<div class="integrity-region"><strong id="integrity-region-name-${esc(s.id)}">${esc(s.name.trim()||'未填写企业名称')}</strong><label>省 / 自治区 / 直辖市<select data-region="${esc(s.id)}" data-field="province">${provinces(s.province)}</select></label><label>城市<input data-region="${esc(s.id)}" data-field="city" value="${esc(s.city)}" placeholder="如：深圳市" maxlength="60"></label><div id="integrity-region-${esc(s.id)}">${this.regional(s)}</div></div>`).join('')||'<p>添加企业后在这里填写注册地。</p>';}
 private subjectField(id:string,field:string){return document.querySelector<HTMLInputElement|HTMLSelectElement>(`[data-subject="${CSS.escape(id)}"][data-field="${field}"]`);}
 private paintSubjects(focusId?:string,field='name'){
  // Replace only the roster and registration rows: pending batch text, notes and scope stay intact.
  document.querySelector('#integrity-roster')!.innerHTML=this.subjectRows();document.querySelector('#integrity-regions')!.innerHTML=this.regionRows();document.querySelector('#integrity-subject-count')!.textContent=String(this.state!.draft.subjects.length);this.updateCount();
  if(focusId)this.subjectField(focusId,field)?.focus();
 }
 private addSubject(kind:IntegritySubject['kind'],name='',role=''){
  if(this.busy)return;if(this.state!.draft.subjects.length>=100){this.status('每轮最多 100 个对象。');return;}
  const s={id:crypto.randomUUID(),kind,name,role,identifier:'',province:'',city:''};Object.assign(s,inferIntegrityRegion(s));this.state!.draft.subjects.push(s);this.changed();this.paintSubjects(s.id);
 }
 private subjectError(id:string,message='',field='name'){
  const error=document.getElementById('integrity-subject-error-'+id);if(error){error.textContent=message;error.hidden=!message;}
  for(const name of ['name','identifier']){const input=this.subjectField(id,name);if(message&&name===field)input?.setAttribute('aria-invalid','true');else input?.removeAttribute('aria-invalid');}
 }
 private validateSubjects(){
  const seen=new Map<string,number>();let first:HTMLInputElement|HTMLSelectElement|undefined;
  for(const [i,s] of this.state!.draft.subjects.entries()){
   const key=JSON.stringify([s.kind,s.name.trim(),s.identifier.trim()]);let error='',field='name';
   if(!s.name.trim())error='请填写名称 / 姓名，或移除此行。';
   else if(s.kind==='company'&&s.identifier.trim()&&!/^[0-9A-Z]{18}$/.test(s.identifier.trim())){error='统一社会信用代码应为 18 位大写字母或数字，也可暂不填写。';field='identifier';}
   else if(seen.has(key))error=`与第 ${seen.get(key)!+1} 行重复，请核对名称和识别信息，或移除重复行。`;
   seen.set(key,i);this.subjectError(s.id,error,field);if(error&&!first)first=this.subjectField(s.id,field)??undefined;
  }
  if(first){first.focus();this.status('请先修正名单中标出的内容，或移除不需要的行。');return false;}return true;
 }
 private importSubjects(){
  const input=document.querySelector<HTMLTextAreaElement>('#integrity-batch')!,status=document.querySelector('#integrity-batch-status')!,existing=this.state!.draft.subjects;
  const rows=input.value.split(/\r?\n/).map(line=>line.trim()).filter(Boolean),added:IntegritySubject[]=[];
  if(!rows.length){status.textContent='请先粘贴名单。';return;}
  if(existing.length+rows.length>100){status.textContent='每轮最多 100 个对象，请减少名单后重试。';return;}
  for(const [index,line] of rows.entries()){
   const [type,name='',role='',identifier='',...extra]=line.split('\t').map(s=>s.trim()),kind=type==='企业'?'company':['人员','个人'].includes(type)?'person':null;
   if(!kind||!name||extra.length||[name,role,identifier].some(s=>s.length>200)||(kind==='company'&&identifier&&!/^[0-9A-Z]{18}$/.test(identifier))){status.textContent=`第 ${index+1} 行格式不正确，请按“类型、名称、关系、身份标识”四列核对。`;return;}
   if([...existing,...added].some(s=>s.kind===kind&&s.name===name&&s.identifier===identifier)){status.textContent=`第 ${index+1} 行与已有对象重复，请核对名称和身份标识。`;return;}
   added.push({id:crypto.randomUUID(),kind,name,role,identifier,province:'',city:''});
  }
  existing.push(...added);this.changed();input.value='';status.textContent=`已添加 ${added.length} 个对象，请核对名单后保存。`;this.paintSubjects(added[0]?.id);this.status(status.textContent);
 }
 private confirmStart(){
  if(this.busy||!this.validateSubjects())return;const d=this.modal('开始本轮诚信核查',`<p>${this.state!.draft.subjects.length} 个对象 · ${this.state!.draft.site_ids.length} 个网站</p><p>本轮费用 <strong>5,000 积分</strong>，开始时冻结，底稿交付后扣除。未完成交付将释放积分。</p><p>逐站打开官网，等待页面加载、提交查询并截图；加载异常会自动重试。需要验证码或登录的网站单独标明，其他网站继续，无需上传补充证据。同轮重新导出免费，重新开始核查另计一轮。</p><button class="btn primary" id="integrity-confirm">确认并开始 · 5,000 积分</button>`);
  d.querySelector('#integrity-confirm')!.addEventListener('click',()=>void this.act(async()=>{if(!this.runRequest){await this.save();this.runRequest={request_id:crypto.randomUUID(),expected_revision:this.state!.revision,price_version:INTEGRITY_PRICE.version,expected_points:5000};}
   const run=await this.request<{run_id:string}>('POST','/runs',this.runRequest);if(this.live()){this.runRequest=undefined;d.close();location.hash=`integrity?project=${encodeURIComponent(this.id!)}&run=${encodeURIComponent(run.run_id)}`;}}));
 }
 private paintRound(r:IntegrityRound){
  const done=terminal.has(r.state),pending=r.records.filter(x=>['needs_manual','query_failed'].includes(x.status)).length,total=r.manifest.draft.subjects.length*r.manifest.draft.site_ids.length;
  this.shell(`${this.header(3)}<section class="panel integrity-panel"><div class="pf-section-head"><div><h2>${r.operation==='export'?'核查底稿导出':'本轮诚信核查'} · ${esc((runStateLabel[r.state as keyof typeof runStateLabel]??r.state))}</h2><p>${esc(date(r.created_at))} · ${r.manifest.draft.subjects.length} 个对象 · ${r.manifest.draft.site_ids.length} 个网站</p></div><div>${r.artifacts.map(a=>`<button class="btn primary" data-integrity-download="${esc(a.artifact_id)}">下载${a.kind==='company'?'企业':'人员'}核查底稿</button>`).join('')}<a class="btn secondary" href="#integrity?project=${encodeURIComponent(this.id!)}">返回名单与历史</a></div></div><p>${r.charged_points?`本轮已扣除 ${r.charged_points.toLocaleString()} 积分`:r.reserved_points?`已冻结 ${r.reserved_points.toLocaleString()} 积分，完成交付后扣除`:r.operation==='export'?'同轮重新导出 · 免费':'本轮未扣除积分'}</p><div class="integrity-progress"><progress value="${r.records.length}" max="${total||1}"></progress><span>${r.records.length} / ${total} 项已有处理记录 · ${pending} 项未完成或待核实</span></div><p class="muted">公开来源仅为核查线索。页面明确返回无结果才记为未检索到。验证码、登录或未完成查询会单独说明。</p><p>${r.evidence.filter(e=>!r.manifest.evidence_ids.includes(e.id)).length?`有 ${r.evidence.filter(e=>!r.manifest.evidence_ids.includes(e.id)).length} 份新增证据尚未包含在此版底稿中，请免费重新导出。`:r.evidence.length?`此版底稿已包含 ${r.manifest.evidence_ids.length} 份人工证据。`:"无需上传补充证据。"}</p><div class="integrity-actions">${!done?`<button class="btn secondary" data-run-action="${r.state==='paused'||r.state==='awaiting_input'?'resume':'pause'}">${r.state==='paused'||r.state==='awaiting_input'?'继续任务':'暂停任务'}</button><button class="text-button" data-run-action="cancel">停止本轮</button>`:''}${done?'<button class="btn secondary" id="integrity-export">重新导出底稿 · 免费</button>':''}</div>${['failed','cancelled'].includes(r.state)?'<p role="alert">本轮未完成交付，冻结积分会释放。已取得的记录仍保留，可免费导出底稿。</p>':''}</section>
   <div id="integrity-records">${r.manifest.draft.subjects.map((s,i)=>`<details class="panel integrity-query" ${i===0?'open':''}><summary><strong>${esc(s.name)}</strong><span>${s.kind==='company'?'企业':'人员'} · ${esc(s.role||'角色待补充')}</span></summary><div class="integrity-table-wrap"><table><thead><tr><th>核查网站 / 查询条件</th><th>查询状态</th><th>取证记录</th></tr></thead><tbody>${r.manifest.draft.site_ids.map(id=>{const record=r.records.find(x=>x.subject_id===s.id&&x.site_id===id),site=resolveIntegritySite(INTEGRITY_SITES.find(x=>x.id===id)!,s),evidence=r.evidence.filter(e=>e.subject_id===s.id&&e.site_id===id);return `<tr><td><strong>${esc(site.name)}</strong><small>${esc(s.name)}</small>${links(site)}</td><td><span class="pf-chip ${record?.status==='not_applicable'?'':'attention'}">${record?recordStatus(record):done?'未执行':'等待查询'}</span><small>${esc(record?.reason??'本轮还未记录该网站的查询结果。')}</small></td><td>${record?.browser?.captures.length?`<small>${record.browser.captures.length} 张官网截图</small>`:""}${record?.sources.length?`<small>${record.sources.length} 条公开来源</small>`:''}${evidence.length?`<small>${evidence.length} 份历史补充证据</small>`:''}<button class="text-button" data-evidence="${i}:${id}">查看查询记录</button></td></tr>`;}).join('')}</tbody></table></div></details>`).join('')}</div><p id="integrity-status" role="status"></p>`,'integrity');
  document.querySelectorAll<HTMLButtonElement>('[data-integrity-download]').forEach(b=>b.addEventListener('click',()=>void this.act(async()=>{const a=await this.api.artifact(b.dataset.integrityDownload!,this.controller.signal),bytes=await this.api.artifactBytes(a,this.controller.signal);if(this.live())this.downloads.save(bytes,artifactFilename(a));})));
  document.querySelectorAll<HTMLButtonElement>('[data-run-action]').forEach(b=>b.addEventListener('click',()=>void this.act(async()=>{await this.api.runAction(r.run_id,b.dataset.runAction as 'pause'|'resume'|'cancel',this.controller.signal);await this.refresh();})));
  const exportId=crypto.randomUUID();document.querySelector('#integrity-export')?.addEventListener('click',()=>void this.act(async()=>{const result=await this.request<{run_id:string}>('POST',`/runs/${encodeURIComponent(r.round_id)}/exports`,{request_id:exportId,expected_evidence_ids:r.evidence.map(e=>e.id)});if(this.live())location.hash=`integrity?project=${encodeURIComponent(this.id!)}&run=${encodeURIComponent(result.run_id)}`;}));
  document.querySelectorAll<HTMLButtonElement>('[data-evidence]').forEach(b=>b.addEventListener('click',()=>{const [index,siteId]=b.dataset.evidence!.split(':');this.evidenceModal(r,r.manifest.draft.subjects[Number(index)],siteId);}));
  if(!done)this.timer=setTimeout(()=>{if(!this.dialog?.open&&!this.busy)void this.refresh();else this.poll();},3000);
 }
 private poll(){clearTimeout(this.timer);this.timer=setTimeout(()=>{if(!this.live())return;if(this.dialog?.open||this.busy)this.poll();else void this.refresh();},3000);}
 private async refresh(){try{const state=await this.request<Workspace>('GET','');if(this.live()){this.state=state;this.paint();}}catch(e){if(this.live()){this.status(this.error(e));this.poll();}}}
 private evidenceModal(r:IntegrityRound,s:IntegritySubject,siteId:string){
  const site=resolveIntegritySite(INTEGRITY_SITES.find(x=>x.id===siteId)!,s),record=r.records.find(x=>x.subject_id===s.id&&x.site_id===siteId),evidence=r.evidence.filter(e=>e.subject_id===s.id&&e.site_id===siteId);
  const d=this.modal(`${s.name} · ${site.name}`,`<p>${links(site)}</p><p>${esc(record?.reason??'尚无查询记录。')}</p>${record?`<p>查询时间：${esc(date(record.checked_at))}</p><p>实际查询：${esc(record.query||'未记录')}</p>`:''}${record?.sources.map(source=>`<blockquote><a href="${esc(source.url)}" target="_blank" rel="noopener noreferrer">${esc(source.title)}</a><p>${esc(source.quote)}</p><small>${esc(date(source.retrieved_at))} · 公开来源，需核对主体与事项</small></blockquote>`).join('')??''}<div data-auto-evidence></div>${evidence.length?`<h3>历史补充证据</h3>${evidence.map((e,i)=>`<div class="integrity-evidence"><strong>${e.conclusion==='records_found'?'发现记录':e.conclusion==='no_records'?'该次查询未发现记录':'仍待核实'}（用户提交）</strong><p>${esc(e.note)}</p><small>${esc(date(e.queried_at))}</small><button class="text-button" data-download-evidence="${i}">下载原始证据</button></div>`).join('')}`:''}`);
  mountIntegrityBrowserEvidence(d,record,this.api,this.id!,r.round_id,this.controller.signal);
  d.querySelectorAll<HTMLButtonElement>('[data-download-evidence]').forEach(b=>b.addEventListener('click',()=>void this.act(async()=>{const pin=evidence[Number(b.dataset.downloadEvidence)].material,m=await this.api.material(this.id!,pin.material_id,this.controller.signal,pin.material_version);if(m.sha256!==pin.sha256)throw Error('证据内容已变化，请刷新后重试。');const bytes=await this.api.materialBytes(this.id!,m,this.controller.signal);if(this.live())this.downloads.save(bytes,m.filename);} )));
 }
}
