import {int64} from '@bondbuddy/contracts';
import {formatPoints} from '@bondbuddy/contracts';
import type {WorkpaperLibrary,WorkpaperLibraryItem,WorkpaperPaidCheckRequest,WorkpaperPaidCheckQuote,WorkpaperPaidCheckBatch} from './billing-types.js';
import {ApiClient,friendlyError,type Dto} from './api';
import {ArtifactDownloads,artifactError,boundedDownload} from './artifact-download';
import {esc,date} from './ui';
import './workpaper-library.css';
const labels={needs_update:'内容需更新',manual:'需核对',current:'未发现关联变动'};
/** A bounded page of files, independent of the generation task list. */
export class WorkpaperLibraryPanel {
  private abort=new AbortController();private downloads=new ArtifactDownloads();private timer?:ReturnType<typeof setTimeout>;private debounce?:ReturnType<typeof setTimeout>;
  private checkRequests=new Map<string,string>();private data?:WorkpaperLibrary;private revision=0;private offset=0;private busy=false;private dialog?:HTMLDialogElement;
  private downloadFeedback?:{node:HTMLElement;key:string};
  private quotes=new Map<string,{request:WorkpaperPaidCheckRequest;quote?:WorkpaperPaidCheckQuote;error?:string}>();
  constructor(private api:ApiClient,private host:HTMLElement,private project:string){}
  dispose(){this.abort.abort();clearTimeout(this.timer);clearTimeout(this.debounce);this.downloads.dispose();this.dialog?.remove();}
  private get base(){return `/projects/${encodeURIComponent(this.project)}/workpapers`;}
  private live(){return !this.abort.signal.aborted&&this.host.isConnected;}
  async render(){
    this.host.innerHTML=`<div class="wl-heading"><div><h2>尽职调查底稿文件</h2><p>按目录查看生成文件和不适用说明，检查新版募集书影响。</p></div><a class="btn secondary" href="#generate?project=${encodeURIComponent(this.project)}&step=workpapers&return_project=${encodeURIComponent(this.project)}">批量生成底稿</a></div>
      <form class="wl-filters"><label>查找底稿<input name="search" type="search" maxlength="300" placeholder="编号、名称或目录"></label><label>分类<select name="category" aria-label="分类"><option value="all">全部文件</option><option value="generated">可生成文件</option><option value="explanation">不适用说明</option></select></label><label>状态<select name="status" aria-label="状态"><option value="all">全部状态</option><option value="stale">需用新版检查</option><option value="needs_update">内容需更新</option><option value="manual">需核对</option><option value="failed">生成失败</option></select></label><label class="wl-history"><input name="history" type="checkbox">包括历史批次</label><button class="btn secondary" type="submit">刷新</button></form><p class="wl-message" role="status"></p><div class="wl-checks"></div><div class="wl-list"></div><nav class="wl-pages" aria-label="底稿文件翻页"></nav>`;
    const form=this.host.querySelector<HTMLFormElement>('form')!;
    form.onsubmit=e=>{e.preventDefault();this.offset=0;this.quotes.clear();void this.refresh();};
    form.onchange=()=>{this.offset=0;void this.refresh();};
    form.querySelector('input')!.oninput=()=>{clearTimeout(this.debounce);this.debounce=setTimeout(()=>{this.offset=0;void this.refresh();},250);};
    await this.refresh();
  }
  private message(s:string){if(this.live())this.host.querySelector('.wl-message')!.textContent=s;}
  async refresh(){
    if(!this.live())return;const revision=++this.revision,form=new FormData(this.host.querySelector('form')!);
    const query=new URLSearchParams({offset:String(this.offset),limit:'50',search:String(form.get('search')??''),category:String(form.get('category')),status:String(form.get('status')),history:String(form.has('history'))});
    try{
      const data=await this.api.request<WorkpaperLibrary>('GET',this.base+'/library?'+query,undefined,{},this.abort.signal);
      if(!this.live()||revision!==this.revision)return;this.data=data;this.paint();
      this.message(`${data.total} 份${form.has('history')?'（含历史版本）':''} · ${data.source?'当前募集书 V'+data.source.sequence:'尚未采用募集书'}`);
    }catch(e){if(this.live()&&revision===this.revision)this.message('底稿列表读取失败，原文件已保留。'+friendlyError(e,'read'));}
    this.scheduleRefresh();
  }
  private scheduleRefresh(){clearTimeout(this.timer);if(this.live())this.timer=setTimeout(()=>{if(this.busy||this.dialog?.open)this.scheduleRefresh();else void this.refresh();},10000);}
  private paint(){
    const data=this.data!;
    let capability=this.host.querySelector<HTMLElement>('.wl-check-capability');
    if(!capability){capability=document.createElement('p');capability.className='wl-check-capability';capability.setAttribute('role','status');this.host.querySelector('.wl-checks')!.before(capability);}
    capability.textContent=data.check_capability?.enabled===false?data.check_capability.reason:'';capability.hidden=!capability.textContent;
    const list=this.host.querySelector('.wl-list')!,opened=new Set([...list.querySelectorAll<HTMLDetailsElement>('details[open]')].map(e=>e.dataset.key));
    list.innerHTML=data.items.length?data.items.map((i,n)=>{
      const file=i.file?.current,paid=data.check_capability?.mode==='per_file',key=i.batch_id+':'+i.entry.id;
      const status=paid&&file?({unchecked:'未检查',checking:'检查中',conflict:'内容需更新',manual:'需核对',consistent:'已检查一致',stale:'需用新版检查',updated:'已同步更新'}[file.consistency.status]):i.check_stale?'需用新版检查':i.impact?labels[i.impact.status]:i.state==='succeeded'?'未检查':i.state==='failed'?'生成失败':'生成中';
      const single=paid?this.quotes.get(this.quoteKey(i,false)):undefined,batch=paid?this.quotes.get(this.quoteKey(i,true)):undefined;
      return `<details class="wl-file" data-key="${esc(key)}" ${opened.has(key)?'open':''}><summary><span class="wl-name">${esc(i.explanation?.filename??i.entry.path.split('/').at(-1)!)}</span><span class="wl-status">${esc(status)}</span><small>${i.explanation?'不适用说明':'可生成文件'} · 募集书 V${i.source.sequence}${i.latest?' · 当前底稿':' · 历史底稿'}</small></summary>
      <div class="wl-details"><p>${esc(i.entry.folder||'尽职调查文件')} · ${date(i.created_at)} · ${i.version_count} 个批次版本</p><p>${esc(i.impact?.reason??i.decision?.reason??'生成后可检查与新版募集书的关联内容。')}</p>
      ${file?`<p>文件 V${file.sequence}${file.version_id!==i.file!.original.version_id?' · 原批次文件的维护修订版，原文件继续保留':''}</p>`:''}
      <div class="wl-actions">${i.explanation||i.artifacts.length?`<button class="btn secondary" data-preview="${n}">预览正文</button><button class="btn secondary" data-download="${n}">下载文件</button>`:''}${file&&file.version_id!==i.file!.original.version_id?`<button class="text-button" data-original="${n}">下载原批次文件</button>`:''}<button class="text-button" data-zip="${n}">下载所在批次 ZIP</button>
      ${paid?`<button class="text-button" data-check-one="${n}" ${!single?.quote||!file?.latest?'disabled':''}>检查此份底稿${single?.quote?' · '+formatPoints(single.quote.points)+' 积分':''}</button>`:''}
      <button class="text-button" data-check="${n}" ${!data.source||data.check_capability?.enabled===false||paid&&!batch?.quote?'disabled':''}>检查本批底稿</button>${file?.consistency.check_run_id?`<a class="text-button" href="${this.checkHref(file.consistency.check_run_id,file.version_id)}">查看检查与修订</a>`:''}${i.impact&&i.impact.status!=='current'&&!i.check_stale?`<a class="text-button" href="#generate?project=${encodeURIComponent(this.project)}&step=workpapers&workpaper_batch=${encodeURIComponent(i.batch_id)}&return_project=${encodeURIComponent(this.project)}">重新编制受影响底稿</a>`:''}</div>
      ${paid?this.quoteSummary(batch):''}
      ${i.check_stale&&i.impact?'<p>以下为旧检查记录，尚未对当前募集书生效。</p>':''}
      ${(i.impact?.changes??[]).map(c=>`<div class="wl-change"><strong>${esc(c.fields.join('；')||'披露内容变更')}</strong><p>底稿位置：${esc(c.target_locations.join('；')||'需重新判断适用性')}</p><dl><div><dt>原募集书</dt><dd>${esc(c.before||'无')}</dd></div><div><dt>新募集书</dt><dd>${esc(c.after||'已删除')}</dd></div></dl></div>`).join('')}</div></details>`;
    }).join(''):'<p class="collection-empty">没有符合条件的底稿文件。</p>';
    const page=this.host.querySelector('.wl-pages')!;page.innerHTML=`<button class="btn secondary" data-prev ${!data.offset?'disabled':''}>上一页</button><span>第 ${Math.floor(data.offset/data.limit)+1} / ${Math.max(1,Math.ceil(data.total/data.limit))} 页</span><button class="btn secondary" data-next ${data.offset+data.limit>=data.total?'disabled':''}>下一页</button>`;
    page.querySelector<HTMLButtonElement>('[data-prev]')!.onclick=()=>{this.offset=Math.max(0,this.offset-50);void this.refresh();};
    page.querySelector<HTMLButtonElement>('[data-next]')!.onclick=()=>{this.offset+=50;void this.refresh();};
    this.host.querySelector('.wl-checks')!.innerHTML=data.checks.filter(c=>!['succeeded','cancelled'].includes(c.state)).map(c=>`<p>${c.state==='failed'?'检查未完成，可重试':'检查进行中'} · 原募集书 V${c.baseline.sequence} → V${c.source.sequence}${c.stale?' · 当前募集书已更换':''}</p>`).join('')+(data.paid_checks??[]).map(c=>`<details class="wl-paid-check"><summary>逐份检查 · ${c.items.length} 份 · 募集书 V${c.source.sequence} · ${c.items.filter(i=>i.state==='succeeded').length} 份已交付</summary><p>委托 ${formatPoints(c.points)} 积分；每份交付结算，未完成部分释放。</p>${c.items.map(i=>`<p><a href="${this.checkHref(i.run_id,i.file_version_id)}">${esc(i.filename)}</a> · ${i.state==='succeeded'?'已交付':i.state==='failed'?'未完成，已释放':'处理中'} · ${formatPoints(i.points)} 积分${i.scope_quote_id?` · <a href="#/account?quotation=${encodeURIComponent(i.scope_quote_id)}">原委托范围</a>`:''}</p>`).join('')}</details>`).join('');
    for(const action of ['download','original','preview','zip','check','check-one'])list.querySelectorAll<HTMLButtonElement>(`[data-${action}]`).forEach(button=>button.onclick=()=>void this.act(button,()=>this.perform(action,data.items[Number(button.getAttribute('data-'+action))]!,button)));
    if(data.check_capability?.mode==='per_file')list.querySelectorAll<HTMLDetailsElement>('.wl-file').forEach((row,n)=>{row.ontoggle=()=>{if(row.open){const item=data.items[n];void this.prepareQuote(item,true);if(item.file?.current.latest)void this.prepareQuote(item,false);}};if(row.open){void this.prepareQuote(data.items[n],true);if(data.items[n].file?.current.latest)void this.prepareQuote(data.items[n],false);}});
    const feedback=this.downloadFeedback;
    if(feedback){const file=[...list.querySelectorAll<HTMLElement>('[data-key]')].find(el=>el.dataset.key===feedback.key);if(file)file.querySelector('.wl-actions')!.append(feedback.node);else this.host.querySelector('.wl-message')!.after(feedback.node);}
  }
  private checkHref(run:string,file:string){return '#consistency?'+new URLSearchParams({project:this.project,run,file,return_project:this.project});}
  private quoteKey(item:WorkpaperLibraryItem,all:boolean){const source=this.data?.source;return [item.batch_id,all?'all':item.file?.current.version_id,source?.version_id,source?.selection_revision].join(':');}
  private quoteSummary(value:{quote?:WorkpaperPaidCheckQuote;error?:string}|undefined){
    if(!value?.quote)return `<p class="wl-price" role="status">${esc(value?.error??'正在读取本批可检查范围与积分总额…')}</p>`;
    const q=value.quote;return `<details class="wl-price"><summary>本批检查范围：${q.items.length} 份 · 合计 ${formatPoints(q.points)} 积分${q.excluded.length?' · '+q.excluded.length+' 份不纳入收费':''}</summary><p>对照募集书 V${q.source.sequence}。点击“检查本批底稿”即按所列范围自动冻结积分，每份交付后结算。</p><ul>${q.items.map(i=>`<li>${esc(i.filename)} · ${formatPoints(i.points)} 积分${int64(i.points)===0n?'（已付范围维护）':''}</li>`).join('')}${q.excluded.map(i=>`<li>${esc(i.filename)}：${esc(i.reason)}</li>`).join('')}</ul></details>`;
  }
  private async prepareQuote(item:WorkpaperLibraryItem,all:boolean){
    const source=this.data?.source;if(!source)return;
    const key=this.quoteKey(item,all);if(this.quotes.has(key))return;
    const request:WorkpaperPaidCheckRequest={request_id:crypto.randomUUID(),workpaper_batch_id:item.batch_id,source_version_id:source.version_id,source_selection_revision:source.selection_revision,...(!all?{file_version_ids:[item.file!.current.version_id]}:{})};
    const saved:{request:WorkpaperPaidCheckRequest;quote?:WorkpaperPaidCheckQuote;error?:string}={request};this.quotes.set(key,saved);
    try{saved.quote=await this.api.request<WorkpaperPaidCheckQuote>('POST',this.base+'/check-batches/quote',request,{},this.abort.signal);
      saved.request={...request,file_version_ids:saved.quote.items.map(i=>i.file_version_id),expected_points:saved.quote.points,price_version:saved.quote.price_version,scopes:saved.quote.items.filter(i=>i.scope_quote_id).map(i=>({file_version_id:i.file_version_id,scope_quote_id:i.scope_quote_id!}))};
    }catch(e){saved.error=friendlyError(e,'read');}
    if(this.live())this.paint();
  }
  private async act(button:HTMLButtonElement,action:()=>Promise<void>){if(this.busy)return;this.busy=true;button.disabled=true;try{await action();}catch(e){this.message(friendlyError(e,'read'));}finally{this.busy=false;button.disabled=false;}}
  private async saveFile(button:HTMLButtonElement,read:(signal:AbortSignal,progress:(received:number)=>void)=>Promise<{bytes:Blob;filename:string}>,archive=false){
    const feedback=this.downloadFeedback?.node??document.createElement('p');
    feedback.className='wl-download-feedback';feedback.setAttribute('role','status');
    this.downloadFeedback={node:feedback,key:button.closest<HTMLElement>('[data-key]')!.dataset.key!};button.closest('.wl-actions')!.append(feedback);
    const text=button.textContent;button.textContent='正在准备下载…';button.setAttribute('aria-busy','true');
    feedback.textContent='正在准备下载，请稍候…';
    const progress=(received:number)=>{if(this.live())feedback.textContent=`正在下载文件包，已接收 ${(received/1024/1024).toFixed(2)} MB…`;};
    try{const file=await boundedDownload(this.abort.signal,signal=>read(signal,progress),archive?20*60_000:120_000);if(this.live())this.downloads.save(file.bytes,file.filename,feedback);}
    catch(e){if(this.live())feedback.textContent=artifactError(e);}
    finally{button.textContent=text;button.removeAttribute('aria-busy');}
  }
  private async perform(action:string,item:WorkpaperLibraryItem,button:HTMLButtonElement){
    if(action==='check'||action==='check-one'){
      if(this.data?.check_capability?.enabled===false){this.message(this.data.check_capability.reason);return;}
      if(this.data?.check_capability?.mode==='per_file'){
        const key=this.quoteKey(item,action==='check'),saved=this.quotes.get(key);if(!saved?.quote){this.message('本次检查范围尚未读完，请稍候。');return;}
        const result=await this.api.request<WorkpaperPaidCheckBatch>('POST',this.base+'/check-batches',saved.request,{},this.abort.signal);
        this.quotes.clear();await this.refresh();this.message(`已委托 ${result.items.length} 份底稿逐份检查，交付后自动结算。`);return;
      }
      const source=this.data!.source!;
      const key=item.batch_id+':'+source.version_id+':'+source.selection_revision;const request=this.checkRequests.get(key)??crypto.randomUUID();this.checkRequests.set(key,request);
      await this.api.request('POST',this.base+`/batches/${encodeURIComponent(item.batch_id)}/checks`,{request_id:request,source_version_id:source.version_id,source_selection_revision:source.selection_revision},{},this.abort.signal);
      this.checkRequests.delete(key);
      await this.refresh();this.message('检查已提交，关闭页面后仍会继续。');return;
    }
    if(action==='preview'){
      const result=await this.api.request<{text:string}>('GET',this.base+`/batches/${encodeURIComponent(item.batch_id)}/items/${encodeURIComponent(item.entry.id)}/preview`,undefined,{},this.abort.signal);
      if(!this.live())return;this.dialog?.remove();const d=document.createElement('dialog');this.dialog=d;d.className='wl-preview';
      d.innerHTML=`<header><h2>${esc(item.explanation?.filename??item.entry.path.split('/').at(-1)!)}</h2><button class="btn secondary">关闭</button></header><p>正文文本预览；Word 文件保留完整排版。</p><pre>${esc(result.text)}</pre>`;
      document.body.append(d);d.querySelector('button')!.onclick=()=>d.close();d.onclose=()=>{if(this.live())void this.refresh();};d.showModal();return;
    }
    if(action==='zip'){await this.saveFile(button,async (signal,progress)=>({bytes:await this.api.workpaperZip(this.project,item.batch_id,signal,progress),filename:'尽职调查底稿.zip'}),true);return;}
    if(action==='original'&&item.file?.original.asset.kind==='artifact'){const original=item.file.original;await this.saveFile(button,async signal=>{const pin=(original.asset as Extract<typeof original.asset,{kind:'artifact'}>).pin;const meta=await this.api.request<Dto<'ArtifactResponse'>>('GET',`/artifacts/${encodeURIComponent(pin.artifact_id)}?version=${pin.artifact_version}`,undefined,{},signal);return {bytes:await this.api.artifactBytes(meta,signal),filename:original.filename};});return;}
    if(item.explanation){await this.saveFile(button,async signal=>({bytes:await this.api.workpaperExplanation(this.project,item.batch_id,item.entry.id,signal),filename:item.explanation!.filename}));return;}
    await this.saveFile(button,async signal=>{const a=item.artifacts[0]!;const meta=await this.api.request<Dto<'ArtifactResponse'>>('GET',`/artifacts/${encodeURIComponent(a.pin.artifact_id)}?version=${a.pin.artifact_version}`,undefined,{},signal);
      return {bytes:await this.api.artifactBytes(meta,signal),filename:item.entry.path.split('/').at(-1)!};});
  }
}
