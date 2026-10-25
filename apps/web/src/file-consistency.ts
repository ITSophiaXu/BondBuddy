import {PROJECT_FILE_UPDATE_PRICE,type ProjectFileCheck,type ProjectFileVersion,type ProjectFileSource,type ProjectFileFinding} from '@bondbuddy/contracts';
import {ApiClient,ApiError,friendlyError} from './api';
import {ArtifactDownloads} from './artifact-download';
import {esc,date} from './ui';
import {runStateLabel} from './review-state';
import {prototypeIcon as ico} from './prototype-design';
import './file-workspace.css';
type Updates=import('@bondbuddy/contracts').ProjectFileUpdateBatches;
const active=new Set(['queued','preparing','running','validating','delivering','settlement_pending']);
export class FileConsistency {
  private abort=new AbortController();private timer?:ReturnType<typeof setTimeout>;private busy=false;private downloads=new ArtifactDownloads();
  private checks:ProjectFileCheck[]=[];private files:ProjectFileVersion[]=[];private updates:Updates['batches']=[];private source:ProjectFileSource|null=null;
  private chosen=new Set<string>();private filter='all';private name='';private requestId?:string;private acceptRequest?:unknown;private message='';
  constructor(private api:ApiClient,private shell:(html:string,section:string)=>void,private current:()=>boolean,private id:string){}
  private live(){return this.current()&&!this.abort.signal.aborted;}
  dispose(){this.abort.abort();clearTimeout(this.timer);this.downloads.dispose();}
  private request<T>(method:'GET'|'POST',path:string,body?:unknown){return this.api.request<T>(method,`/projects/${encodeURIComponent(this.id)}/project-files${path}`,body,{},this.abort.signal);}
  async render(){
    if(!this.id){this.shell('<h1>检查文件一致性</h1><p>请从全部项目选择需要检查的项目。</p><a class="btn primary" href="#tasks">选择项目</a>','projects');return;}
    this.shell('<p role="status">正在读取文件与检查记录…</p>','projects');
    try{const p=await this.api.project(this.id,this.abort.signal);this.name=p.name;await this.reload();}
    catch(e){if(this.live())this.shell(`<h1>文件一致性检查</h1><p role="alert">${esc(friendlyError(e))}</p><a class="btn secondary" href="#/projects/${encodeURIComponent(this.id)}/files">返回项目文件</a>`,'projects');}
  }
  private selected(){return this.checks.find(c=>c.run_id===new URLSearchParams(location.hash.split('?')[1]).get('run'))??this.checks[0];}
  private async reload(){
    const [checks,files,state,updates]=await Promise.all([this.request<{checks:ProjectFileCheck[]}>('GET','/checks'),this.request<{files:ProjectFileVersion[]}>('GET',''),
      this.request<{source:ProjectFileSource|null}>('POST','/workspace',{request_id:crypto.randomUUID()}),this.request<Updates>('GET','/updates')]);
    if(!this.live())return;this.checks=checks.checks;this.files=files.files;this.source=state.source;this.updates=updates.batches;this.paint();this.schedule();
  }
  private schedule(){clearTimeout(this.timer);if(!this.live())return;
    const check=this.selected();if(check&&(active.has(check.state)||check.updates.some(u=>active.has(u.state)))||this.updates.some(b=>['queued','running'].includes(b.state)))
      this.timer=setTimeout(()=>{void this.reload().catch(e=>{if(this.live()){this.message='刷新未成功，当前显示上次结果。'+friendlyError(e);this.status();this.schedule();}});},4000);
  }
  private status(){const s=document.querySelector('#fc-status');if(s)s.textContent=this.message;}
  private async act(fn:()=>Promise<void>){if(this.busy)return;this.busy=true;this.message='正在提交…';this.status();
    try{await fn();}catch(e){if(this.live()){this.message=e instanceof ApiError?friendlyError(e):e instanceof Error?e.message:'提交失败，请重试。';this.status();}}
    finally{this.busy=false;if(this.live())this.paint();}
  }
  private pending(c:ProjectFileCheck,version:string){
    const accepted=new Set(c.updates.filter(u=>u.file_version_id===version&&u.state==='succeeded').flatMap(u=>u.issue_ids));
    return c.result?.files.find(f=>f.file_version_id===version)?.findings.filter(f=>f.kind==='conflict'&&!accepted.has(f.id))??[];
  }
  private blocked(c:ProjectFileCheck,version:string){
    const checked=c.files.find(f=>f.file_version_id===version),latest=this.files.find(f=>f.file_id===checked?.file_id&&f.latest);
    return c.stale||!latest||(latest.version_id!==version&&!c.updates.some(u=>u.new_version_id===latest.version_id&&u.state==='succeeded'))||
      c.updates.some(u=>u.file_version_id===version&&(active.has(u.state)||['paused','awaiting_input'].includes(u.state)))||
      this.updates.some(b=>['queued','running','paused'].includes(b.state));
  }
  private paint(){
    if(!this.live())return;const c=this.selected(),checking=!!c&&active.has(c.state),latest=this.files.filter(f=>f.latest),base=c?.source??this.source;
    const open=new Set([...document.querySelectorAll<HTMLDetailsElement>('[data-fc-detail][open]')].map(d=>d.dataset.fcDetail!));
    const source=base?`<div class="pf-source-strip">${ico('file')}<div><strong>${esc(base.filename)}</strong><small>本次基准 · V${base.sequence} · ${esc(this.name)}</small></div><span class="pf-chip">以募集书为准</span></div>`:'';
    const start=`<button class="btn ${c?'secondary':'primary'}" data-fc-start ${this.busy||checking||!this.source||!latest.length?'disabled':''}>${c?'重新检查（免费）':'开始检查（免费）'}</button>`;
    this.shell(`<a class="back-link" href="#tasks">← 返回全部项目</a><div class="page-head"><div><div class="eyebrow">FILE CONSISTENCY</div><h1>${checking?'正在检查文件一致性':'文件一致性检查'}</h1><p>${esc(this.name)} · 以当前募集书为准，核对关联文件，一键生成修订版与清洁版。</p></div><a class="btn secondary" href="#/projects/${encodeURIComponent(this.id)}/files">返回项目文件</a></div>${source}
      <p id="fc-status" role="status">${esc(this.message)}</p>
      ${this.checks.length?`<div class="pf-section-head"><label>检查记录 <select id="fc-history">${this.checks.map((x,i)=>`<option value="${x.run_id}" ${x.run_id===c?.run_id?'selected':''}>第 ${this.checks.length-i} 轮 · ${esc(date(x.created_at))} · ${esc(runStateLabel[x.state as keyof typeof runStateLabel]??x.state)}</option>`).join('')}</select></label>${start}</div>`:''}
      ${!c?`<section class="panel fc-empty"><h2>${!this.source?'请先添加募集说明书':!latest.length?'还没有可检查的关联文件':'准备检查项目文件'}</h2><p>扫描项目每份关联文件的当前版本；历史版本保留。</p><p>本次范围：${latest.length} 份文件</p>${start} <a class="btn secondary" href="#generate?project=${this.id}">生成关联文件</a></section>`:
        checking?`<section class="panel fc-progress"><span class="fc-spinner" aria-hidden="true"></span><h2>${c.stage==='queued'?'等待检查':c.stage?.includes('word')?'正在整理检查报告':'正在核对文件内容'}</h2><p>本轮已固定 ${c.files.length} 份关联文件，核对数据、期间、单位、发行安排和披露内容。</p><ol><li>固定募集书与文件版本</li><li>比对内容与原文依据</li><li>整理冲突位置和修改建议</li></ol><p>关闭页面后任务继续处理，完成后可返回查看。</p><button class="btn secondary" data-fc-control="pause" data-run="${c.run_id}">暂停检查</button></section>`:
        c.result?this.results(c,open):`<section class="panel fc-empty"><h2>${esc(runStateLabel[c.state as keyof typeof runStateLabel]??c.state)}</h2><p>本次检查尚未完成，已保存的输入与历史文件保留。</p>${['paused','awaiting_input'].includes(c.state)?`<button class="btn primary" data-fc-control="resume" data-run="${c.run_id}">继续检查</button> <button class="btn secondary" data-fc-control="cancel" data-run="${c.run_id}">结束检查</button>`:start}</section>`}
      ${this.updates.filter(b=>['queued','running','paused'].includes(b.state)).map(b=>`<section class="panel fc-update"><h2>${b.state==='paused'?'文件更新需要处理':'正在生成新版本'}</h2>${b.items.map(i=>`<p>${esc(i.filename)} · ${esc(i.error??(i.run_id?'已提交后台处理':'等待前一份文件完成'))}${i.run_id?` <button class="text-button" data-fc-control="resume" data-run="${i.run_id}">继续任务</button> <button class="text-button" data-fc-control="cancel" data-run="${i.run_id}">结束任务</button>`:''}</p>`).join('')}${b.state==='paused'?`<button class="btn primary" data-fc-retry="${b.batch_id}">重试未完成文件 · 4,500 积分/份</button>`:''}<button class="btn secondary" data-fc-stop="${b.batch_id}">停止后续文件更新</button><p class="muted">已运行的任务保留，可单独结束；已生成版本保留。</p></section>`).join('')}`,'projects');
    document.querySelectorAll('[data-fc-start]').forEach(b=>b.addEventListener('click',()=>void this.act(async()=>{
      this.requestId??=crypto.randomUUID();const r=await this.request<{run_id:string}>('POST','/checks',{request_id:this.requestId,expected_source_version_id:this.source!.version_id});this.requestId=undefined;this.message='';
      history.replaceState(null,'',location.pathname+location.search+`#consistency?project=${this.id}&run=${r.run_id}`);await this.reload();
    })));
    document.querySelector('#fc-history')?.addEventListener('change',e=>{this.chosen.clear();history.replaceState(null,'',location.pathname+location.search+`#consistency?project=${this.id}&run=${(e.target as HTMLSelectElement).value}`);this.paint();this.schedule();});
    document.querySelector('#fc-filter')?.addEventListener('change',e=>{this.filter=(e.target as HTMLSelectElement).value;this.paint();});
    document.querySelectorAll<HTMLInputElement>('[data-fc-select]').forEach(b=>b.addEventListener('change',()=>{if(b.checked)this.chosen.add(b.dataset.fcSelect!);else this.chosen.delete(b.dataset.fcSelect!);this.syncSelection();}));
    document.querySelector('#fc-all')?.addEventListener('change',e=>{document.querySelectorAll<HTMLInputElement>('[data-fc-select]:not(:disabled)').forEach(b=>{b.checked=(e.target as HTMLInputElement).checked;if(b.checked)this.chosen.add(b.dataset.fcSelect!);else this.chosen.delete(b.dataset.fcSelect!);});this.syncSelection();});
    document.querySelector('#fc-accept')?.addEventListener('click',()=>void this.accept(c!,false));
    document.querySelectorAll<HTMLButtonElement>('[data-fc-file]').forEach(b=>b.addEventListener('click',()=>void this.accept(c!,false,b.dataset.fcFile)));
    document.querySelectorAll<HTMLButtonElement>('[data-fc-download]').forEach(b=>b.addEventListener('click',()=>void this.act(async()=>{
      const f=this.files.find(f=>f.version_id===b.dataset.fcDownload)!,asset=b.dataset.variant==='revision'?f.revision_asset:f.asset;
      if(asset?.kind!=='artifact')return;const a=await this.api.artifact(asset.pin.artifact_id,this.abort.signal);
      if(a.version!==asset.pin.artifact_version||a.sha256!==asset.pin.sha256)throw new Error('文件版本校验未通过，请刷新。');
      this.downloads.save(await this.api.artifactBytes(a,this.abort.signal),f.filename.replace(/\.docx$/i,'')+'_V'+f.sequence+'_'+(b.dataset.variant==='revision'?'修订版':'清洁版')+'.docx');this.message='文件已交给浏览器下载。';
    })));
    document.querySelectorAll<HTMLButtonElement>('[data-fc-control]').forEach(b=>b.addEventListener('click',()=>void this.act(async()=>{await this.api.runAction(b.dataset.run!,b.dataset.fcControl as 'pause'|'resume'|'cancel',this.abort.signal);this.message='任务状态已更新。';await this.reload();})));
    document.querySelectorAll<HTMLButtonElement>('[data-fc-retry]').forEach(b=>b.addEventListener('click',()=>void this.act(async()=>{await this.request('POST','/updates/'+b.dataset.fcRetry+'/retry');this.message='已重试未完成文件；已成功文件不会重复扣费。';await this.reload();})));
    document.querySelectorAll<HTMLButtonElement>('[data-fc-stop]').forEach(b=>b.addEventListener('click',()=>void this.act(async()=>{await this.request('POST','/updates/'+b.dataset.fcStop+'/cancel');this.message='后续文件更新已停止，已运行任务和成果保留。';await this.reload();})));
    this.syncSelection();
  }
  private results(c:ProjectFileCheck,open:Set<string>){
    const counts={conflict:0,consistent:0,manual:0,updated:0},state=(v:string,status:string)=>this.pending(c,v).length?'conflict':status==='manual'||c.result!.files.find(f=>f.file_version_id===v)!.findings.some(f=>f.kind==='manual')?'manual':c.updates.some(u=>u.file_version_id===v&&u.state==='succeeded')?'updated':'consistent';
    c.result!.files.forEach(f=>counts[state(f.file_version_id,f.status)]++);
    const revised=(v:string)=>c.updates.some(u=>u.file_version_id===v&&u.state==='succeeded');
    counts.updated=c.result!.files.filter(f=>revised(f.file_version_id)).length;
    const labels={conflict:'不一致',consistent:'一致',manual:'需人工确认',updated:'已生成修订版'};
    const selected=new URLSearchParams(location.hash.split('?')[1]).get('file');
    return `<div class="fc-summary">${Object.entries(counts).map(([k,v])=>`<div><span>${labels[k as keyof typeof labels]}</span><strong>${v}<small> 份文件</small></strong></div>`).join('')}</div>
      ${c.stale?'<div class="fc-warning" role="status">募集书版本已变化。历史结果和文件仍可下载，请按当前募集书重新检查。</div>':''}
      <section class="panel fc-results"><div class="pf-section-head"><div><h2>文件检查结果</h2><p>检查免费。更新每份文件 4,500 积分，直接生成全部可确认修改的修订版和清洁版；存疑内容仅加批注，旧版保留。成功交付后扣款，失败或取消不扣费。</p></div><select id="fc-filter" aria-label="筛选文件状态"><option value="all">全部文件</option>${Object.entries(labels).map(([k,v])=>`<option value="${k}" ${this.filter===k?'selected':''}>${v}</option>`).join('')}</select></div>
      <label class="fc-select-all"><input type="checkbox" id="fc-all"/> 选择可更新的文件</label>
      ${c.result!.files.filter(f=>this.filter==='all'||(this.filter==='updated'?revised(f.file_version_id):state(f.file_version_id,f.status)===this.filter)).map(f=>{
        const checked=c.files.find(x=>x.file_version_id===f.file_version_id)!,pending=this.pending(c,f.file_version_id),blocked=this.blocked(c,f.file_version_id),status=state(f.file_version_id,f.status);
        const updated=this.files.filter(x=>c.updates.some(u=>u.new_version_id===x.version_id&&u.file_version_id===f.file_version_id)).sort((a,b)=>b.sequence-a.sequence)[0];
        return `<article class="fc-file"><div class="pf-template-row"><input type="checkbox" data-fc-select="${f.file_version_id}" aria-label="选择更新 ${esc(checked.filename)}" ${this.chosen.has(f.file_version_id)?'checked':''} ${!pending.length||blocked||this.busy?'disabled':''}/><span class="collection-file-icon">${ico('file')}</span><div><strong>${esc(checked.filename)}</strong><small>检查时 V${checked.sequence} · 基于募集书 V${c.source.sequence} · ${f.findings.filter(i=>i.kind==='manual').length} 项需人工确认</small></div><span class="pf-chip ${['conflict','manual'].includes(status)?'attention':''}">${labels[status]}${pending.length?' · '+pending.length+' 处':''}</span>${pending.length?`<button class="btn primary" data-fc-file="${f.file_version_id}" ${blocked||this.busy?'disabled':''}>更新文件 · 4,500 积分</button>`:''}</div>
          ${blocked&&pending.length?'<p class="muted">当前有更新任务，或募集书 / 文件版本已变化，请处理后重新核对。</p>':''}
          ${updated?`<div class="fc-downloads"><span>已保存 V${updated.sequence}</span><button class="btn secondary" data-fc-download="${updated.version_id}" data-variant="revision">下载修订版</button><button class="btn secondary" data-fc-download="${updated.version_id}" data-variant="clean">下载清洁版</button></div>`:''}
          <details data-fc-detail="${f.file_version_id}" ${open.has(f.file_version_id)||selected===f.file_version_id||selected===checked.file_id?'open':''}><summary>查看冲突、原文依据及需补充事项（${f.findings.length}）</summary>
          ${f.findings.length?[...f.findings].sort((a,b)=>Number(a.kind==='manual')-Number(b.kind==='manual')).map(i=>this.finding(i,f.file_version_id,pending.some(x=>x.id===i.id),blocked)).join(''):'<p>本轮已核对的内容未发现不一致。</p>'}</details></article>`;
      }).join('')}</section><footer class="pf-footer"><span id="fc-selection">尚未选择文件</span><button class="btn primary" id="fc-accept" disabled>更新所选文件</button></footer>`;
  }
  private finding(i:ProjectFileFinding,version:string,pending:boolean,blocked:boolean){
    return `<div class="fc-finding"><label><strong>${esc(i.field||'披露内容')}${i.period?' · '+esc(i.period):''}${i.unit?' · '+esc(i.unit):''}</strong><span>${i.kind==='manual'?'需人工确认':pending?'待更新':'已更新'}</span></label>
      <div class="fc-comparison"><section><h4>关联文件原文</h4><small>${esc(i.target_location)}</small><p>${esc(i.original)||'未能准确定位'}</p></section><section><h4>当前募集书依据</h4><small>${esc(i.source_location)}</small><p>${esc(i.source_quote)||'缺少可核验依据'}</p></section></div><p><strong>说明：</strong>${esc(i.reason)}</p>
      ${i.replacement!==null?`<div class="fc-replacement"><strong>建议更新为</strong><p>${esc(i.replacement)}</p></div>`:'<p class="fc-warning">请补充相关材料或人工确认，此项不会自动修改。</p>'}</div>`;
  }
  private syncSelection(){const available=[...document.querySelectorAll<HTMLInputElement>('[data-fc-select]:not(:disabled)')],count=available.filter(x=>x.checked).length;
    const s=document.querySelector('#fc-selection');if(s)s.textContent='已选择 '+count+' 份文件 · 共 '+(count*PROJECT_FILE_UPDATE_PRICE.points).toLocaleString('zh-CN')+' 积分';const b=document.querySelector<HTMLButtonElement>('#fc-accept');if(b)b.disabled=!count||this.busy;
    const all=document.querySelector<HTMLInputElement>('#fc-all');if(all){all.checked=!!count&&count===available.length;all.indeterminate=count>0&&count<available.length;}}
  private async accept(c:ProjectFileCheck,_all:boolean,file?:string){await this.act(async()=>{
    if(!this.acceptRequest){const files=c.files.filter(f=>!file||f.file_version_id===file).filter(f=>!this.blocked(c,f.file_version_id)).filter(f=>this.pending(c,f.file_version_id).length&&(file||this.chosen.has(f.file_version_id))).map(f=>({file_version_id:f.file_version_id}));
      if(!files.length)throw new Error('请先选择可更新的文件。');this.acceptRequest={request_id:crypto.randomUUID(),expected_check_sha256:c.sha256,price_version:PROJECT_FILE_UPDATE_PRICE.version,expected_points:files.length*PROJECT_FILE_UPDATE_PRICE.points,files};}
    try{await this.request('POST','/checks/'+c.run_id+'/updates',this.acceptRequest);}
    catch(e){if(e instanceof ApiError&&e.status>=400&&e.status<500){this.acceptRequest=undefined;await this.reload();}throw e;}
    this.acceptRequest=undefined;this.chosen.clear();this.message='已提交文件更新，每份 4,500 积分，成功交付后扣款。修订版和清洁版生成后可下载，原文件保留。';await this.reload();
  });}
}

