import type { ReviewEditorResponse,ReviewEditorIssue,ReviewArtifact,ReviewHistoryEntry,ReviewExportRequest,Run } from '@bondbuddy/contracts';
import { ApiClient,ApiError,friendlyError } from './api';
import { ArtifactDownloads,artifactError } from './artifact-download';
import { esc } from './ui';
import './review-editor.css';

export class ReviewEditor {
  private downloads=new ArtifactDownloads();
  private state?:ReviewEditorResponse;private host?:HTMLElement;private selected='';private view='tracked';private category='all';private dirty=false;private busy=false;private disposed=false;private generation=0;
  private artifacts:ReviewArtifact[]=[];private history:ReviewHistoryEntry[]=[];private pending?:ReviewExportRequest;
  private downloading=new Set<string>();
  constructor(private api:ApiClient,private project:string,private owner:string,private signal:AbortSignal,private submitted:(run:Run)=>void,private currentChanged:()=>void){}
  dispose(){this.downloads.dispose();this.disposed=true;this.generation++;}
  private path(s:string){return `/projects/${encodeURIComponent(this.project)}/${s}`;}
  private get cache(){return `bb-review-editor:${this.owner}:${this.project}:${this.state?.run_id}`;}
  private live(){return !this.disposed&&!this.signal.aborted&&this.host?.isConnected;}
  async mount(host:HTMLElement,run:string,artifacts:ReviewArtifact[]){
    this.host=host;this.artifacts=artifacts;host.innerHTML='<p role="status">正在读取复核成果…</p>';
    const generation=++this.generation;
    try{
      const [state,history]=await Promise.all([this.api.request<ReviewEditorResponse>('GET',this.path(`review-executions/${encodeURIComponent(run)}/editor`),undefined,{},this.signal),this.api.request<{items:ReviewHistoryEntry[]}>('GET',this.path('review-history'),undefined,{},this.signal)]);
      if(!this.live()||generation!==this.generation)return;
      this.state=state;this.history=history.items.filter(h=>['succeeded','test_completed'].includes(h.run.state)&&h.operation!=='revision'&&h.artifacts.some(a=>a.kind==='clean'));this.dirty=false;this.pending=undefined;
      try{const saved=JSON.parse(localStorage.getItem(this.cache)??'null');if(saved?.sha256===state.sha256&&Array.isArray(saved.decisions)&&saved.decisions.length===state.snapshot.issues.length){for(const issue of state.snapshot.issues){const d=saved.decisions.find((d:any)=>d.id===issue.id);if(d&&['suggested','original','manual'].includes(d.decision)&&typeof d.manual_text==='string')Object.assign(issue,d);}this.dirty=true;this.pending=saved.pending;}}catch{/* Server version remains available. */}
      this.selected=state.snapshot.issues[0]?.id??'';this.paint();
    }catch(e){if(this.live()&&generation===this.generation){host.innerHTML=`<p role="alert">${esc(friendlyError(e))}</p><button class="btn secondary" data-reload-editor>重试读取复核结果</button>`;host.querySelector('[data-reload-editor]')!.addEventListener('click',()=>void this.mount(host,run,artifacts));}}
  }
  private remember(){
    if(!this.state)return;this.dirty=true;
    try{localStorage.setItem(this.cache,JSON.stringify({sha256:this.state.sha256,decisions:this.decisions(),pending:this.pending}));}catch{/* Explicit save remains available. */}
  }
  private decisions(){return this.state!.snapshot.issues.map(({id,decision,manual_text})=>({id,decision,manual_text}));}
  private text(issue:ReviewEditorIssue){return issue.decision==='manual'?issue.manual_text:issue.decision==='suggested'&&!issue.uncertain?issue.replacement:issue.original;}
  private preview(){
    if(!this.state)return;
    const s=this.state.snapshot;
    const html=s.paragraphs.map(p=>{
      let text=p.text;const edits=s.issues.filter(i=>i.paragraph_id===p.id&&this.text(i)!==i.original&&!i.limitation);
      let markup=esc(text);
      if(this.view!=='original'){
        const ranges=edits.map(i=>({i,start:text.indexOf(i.original),end:text.indexOf(i.original)+i.original.length})).filter(r=>r.start>=0).sort((a,b)=>a.start-b.start);
        let cursor=0;markup='';
        for(const r of ranges){if(r.start<cursor)continue;markup+=esc(text.slice(cursor,r.start))+(this.view==='tracked'?`<del>${esc(r.i.original)}</del><ins>${esc(this.text(r.i))}</ins>`:esc(this.text(r.i)));cursor=r.end;}markup+=esc(text.slice(cursor));
      }
      const comments=this.view==='tracked'?s.issues.filter(i=>i.paragraph_id===p.id).map(i=>`<div class="review-preview-comment"><strong>批注 ${esc(i.id)} · BondBuddy</strong><p>${esc(i.reason)}</p><p>依据：${esc(i.evidence||'待补充')}</p>${i.missing?`<p>缺少材料：${esc(i.missing)}</p>`:''}${i.limitation?`<p>${esc(i.limitation)}</p>`:''}</div>`).join(''):'';
      return `<section id="review-paragraph-${esc(p.id)}" class="${s.issues.find(i=>i.id===this.selected)?.paragraph_id===p.id?'selected':''}"><p>${markup||'&nbsp;'}</p>${comments}</section>`;
    }).join('');
    const unresolved=s.issues.filter(i=>i.decision!=='original'&&(i.missing||i.limitation||(i.uncertain&&i.decision!=='manual')));
    const pending=this.view==='clean'&&(s.warnings.length||unresolved.length)?`<section><h3>复核待确认事项</h3>${s.warnings.map(w=>`<p>${esc(w)}</p>`).join('')}${unresolved.map(i=>`<p>${esc(i.id+' '+i.title+'：'+(i.missing||i.limitation||i.reason))}</p>`).join('')}</section>`:'';
    this.host!.querySelector('[data-editor-document]')!.innerHTML=`<p class="review-muted">${this.dirty?'尚未保存的文字预览':'正文文字预览'} · 排版以下载 Word 为准</p><article class="review-paper">${html}${pending}</article>`;
  }
  private paint(){
    if(!this.state||!this.live())return;
    const s=this.state.snapshot;
    const changed=s.issues.filter(i=>i.applied&&i.decision!=='original'&&this.text(i)!==i.original).length;
    const revisionLabel=changed?'修订版':s.issues.length?'批注版（无正文修订）':'原文（未修订）';
    const summary=s.issues.length?`${s.issues.length} 项复核发现 · ${changed} 项正文修订`:'未提取到可处理的问题条目 · 正文未修改';
    const filtered=s.issues.filter(i=>this.category==='all'||i.category===this.category),issue=s.issues.find(i=>i.id===this.selected);
    this.host!.innerHTML=`<div class="review-editor-head"><div><p class="review-kicker">REVIEW RESULTS</p><h2>复核成果</h2><p>${summary} · 成果独立保存，可手动设为项目当前版本</p></div><div class="review-downloads">${this.artifacts.filter(a=>['revision','clean','report'].includes(a.kind)).map(a=>`<button class="btn ${a.kind==='revision'?'primary':'secondary'}" data-editor-download data-artifact-id="${esc(a.artifact_id)}" ${this.dirty||this.downloading.has(a.artifact_id)?'disabled':''}>${this.downloading.has(a.artifact_id)?'正在读取…':'下载'+(a.kind==='revision'?revisionLabel:a.kind==='clean'?'清洁版':'复核报告')}</button>`).join('')}<button class="btn secondary" data-editor-current ${this.dirty||this.busy?'disabled':''}>设为项目当前版本</button><a class="btn secondary" href="#consistency?project=${encodeURIComponent(this.project)}">检查文件一致性</a></div></div><p data-editor-status role="status" aria-live="polite"></p>${s.warnings.map(w=>`<p class="review-notice">${esc(w)}</p>`).join('')}<div class="review-editor-toolbar"><label>成果历史 <select data-editor-history>${this.history.map(h=>`<option value="${esc(h.run.run_id)}" ${h.run.run_id===this.state!.run_id?'selected':''}>成果 V${h.version} · ${esc(new Date(h.created_at).toLocaleString())}</option>`).join('')}</select></label><span>${this.dirty?'有未保存的处理选择':'当前查看已保存版本'}</span><button class="btn primary" data-editor-save ${!this.dirty||this.busy?'disabled':''}>${this.busy?'正在提交…':'保存处理结果并生成新版'}</button></div><p class="review-muted">保存处理结果只重新导出文档，不重复 AI 复核或收取 AI 费用。存疑内容保留原文，批注说明缺少材料；清洁版附待确认事项。</p><div class="review-editor-grid"><aside><label for="review-editor-category">复核发现</label><select id="review-editor-category"><option value="all">全部类别</option>${[...new Set(s.issues.map(i=>i.category))].map(c=>`<option value="${esc(c)}" ${c===this.category?'selected':''}>${esc(c)}</option>`).join('')}</select><div class="review-editor-issues">${filtered.map(i=>`<button class="review-issue ${i.id===this.selected?'active':''}" data-editor-issue="${esc(i.id)}"><small>${esc(i.category)} · ${i.uncertain||i.limitation?'待确认':'修改建议'}</small><strong>${esc(i.title)}</strong><span>${i.decision==='original'?'保留原文':i.decision==='manual'?'手动修改':i.applied?'已采用建议':'查看建议'}</span></button>`).join('')||'<p>未提取到可处理的问题条目，请查看复核报告；这不表示未发现问题。</p>'}</div>${issue?`<section class="review-issue-detail"><h3>${esc(issue.title)}</h3><p>${esc(issue.reason)}</p><blockquote>${esc(issue.original||'无可定位原文')}</blockquote><p><strong>建议文本</strong><br>${esc(issue.replacement||'保留原文，待补充材料后确认')}</p><p><strong>依据</strong><br>${esc(issue.evidence||'待补充')}</p>${issue.missing?`<p class="review-warning">缺少材料：${esc(issue.missing)}</p>`:''}${issue.limitation?`<p class="review-warning">${esc(issue.limitation)}</p>`:''}<fieldset><legend>处理这项发现</legend>${[['suggested',issue.uncertain?'保留待确认批注':'采用建议'],['original','保留原文'],['manual','手动修改']].map(([key,label])=>`<label><input type="radio" name="review-decision" value="${key}" ${issue.decision===key?'checked':''} ${key==='manual'&&!issue.paragraph_id?'disabled':''}>${label}</label>`).join('')}</fieldset>${issue.decision==='manual'?`<label for="review-manual-text">替换原文的内容</label><textarea id="review-manual-text" rows="6" maxlength="12000">${esc(issue.manual_text)}</textarea>`:''}</section>`:''}</aside><section class="review-editor-preview"><div role="group" aria-label="文档预览版本">${[['original','原文'],['tracked',changed?'修订版':s.issues.length?'批注版':'未修订正文'],['clean','清洁版']].map(([v,label])=>`<button class="btn ${this.view===v?'primary':'secondary'}" data-editor-view="${v}" aria-pressed="${this.view===v}">${label}</button>`).join('')}</div><div data-editor-document></div></section></div>`;
    this.preview();
    if(this.busy)this.host!.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>('[name=review-decision],#review-manual-text,[data-editor-history]').forEach(control=>control.disabled=true);
    this.host!.querySelectorAll<HTMLElement>('[data-editor-download]').forEach(button=>button.onclick=()=>void this.download(button.dataset.artifactId!));
    this.host!.querySelectorAll<HTMLElement>('[data-editor-issue]').forEach(b=>b.onclick=()=>{this.selected=b.dataset.editorIssue!;this.paint();this.host!.querySelector(`#review-paragraph-${CSS.escape(this.state!.snapshot.issues.find(i=>i.id===this.selected)?.paragraph_id??'')}`)?.scrollIntoView({block:'nearest'});});
    this.host!.querySelectorAll<HTMLElement>('[data-editor-view]').forEach(b=>b.onclick=()=>{this.view=b.dataset.editorView!;this.paint();});
    this.host!.querySelector<HTMLSelectElement>('#review-editor-category')!.onchange=e=>{this.category=(e.target as HTMLSelectElement).value;this.paint();};
    this.host!.querySelectorAll<HTMLInputElement>('[name=review-decision]').forEach(r=>r.onchange=()=>{issue!.decision=r.value as ReviewEditorIssue['decision'];if(r.value==='manual'&&!issue!.manual_text)issue!.manual_text=issue!.replacement||issue!.original;this.pending=undefined;this.remember();this.paint();});
    const manual=this.host!.querySelector<HTMLTextAreaElement>('#review-manual-text');if(manual)manual.oninput=()=>{issue!.manual_text=manual.value;this.pending=undefined;this.remember();this.preview();this.host!.querySelector<HTMLButtonElement>('[data-editor-save]')!.disabled=false;this.host!.querySelectorAll<HTMLButtonElement>('[data-editor-download],[data-editor-current]').forEach(b=>b.disabled=true);};
    this.host!.querySelector<HTMLElement>('[data-editor-save]')!.onclick=()=>void this.save();
    this.host!.querySelector<HTMLElement>('[data-editor-current]')!.onclick=()=>void this.selectCurrent();
    this.host!.querySelector<HTMLSelectElement>('[data-editor-history]')!.onchange=e=>{if(this.dirty||this.busy){this.status('请先完成当前处理，再切换成果。');(e.target as HTMLSelectElement).value=this.state!.run_id;return;}const h=this.history.find(h=>h.run.run_id===(e.target as HTMLSelectElement).value);if(h)void this.mount(this.host!,h.run.run_id,h.artifacts);};
  }
  private status(message:string){const el=this.host?.querySelector('[data-editor-status]');if(el)el.textContent=message;}
  private async download(id:string){
    if(this.dirty||this.downloading.has(id)||!this.state)return;
    const artifact=this.artifacts.find(a=>a.artifact_id===id),runId=this.state.run_id,generation=this.generation;
    if(!artifact)return;
    this.downloading.add(id);this.paint();this.status('正在读取并校验文件，请稍候…');
    try{
      const metadata=await this.api.artifact(id,this.signal);
      if(metadata.artifact_id!==id||metadata.run_id!==runId||metadata.version!==artifact.artifact_version)throw new ApiError(0,'DATA_UNAVAILABLE');
      const bytes=await this.api.artifactBytes(metadata,this.signal);
      if(this.live()&&this.generation===generation){
        this.downloads.save(bytes,metadata.filename??artifact.filename);
        this.status('文件已就绪，已提交浏览器下载；可在浏览器下载列表中查看。');
      }
    }catch(error){if(this.live()&&this.generation===generation)this.status(artifactError(error));}
    finally{
      this.downloading.delete(id);
      if(this.live()&&this.generation===generation){const message=this.host!.querySelector('[data-editor-status]')?.textContent??'';this.paint();this.status(message);}
    }
  }
  private async save(){
    if(this.busy||!this.state)return;this.busy=true;
    this.pending??={request_id:crypto.randomUUID(),source_run_id:this.state.run_id,expected_editor_sha256:this.state.sha256,decisions:this.decisions()};this.remember();this.paint();
    try{const run=await this.api.request<Run>('POST',this.path('review-exports'),this.pending,{},this.signal);if(!this.live())return;try{localStorage.removeItem(this.cache);}catch{}this.dirty=false;this.submitted(run);}
    catch(e){if(this.live())this.status(friendlyError(e)+'；本页处理选择已保留，可以重试。');}
    finally{this.busy=false;if(this.live()){const message=this.host!.querySelector('[data-editor-status]')?.textContent??'';this.paint();this.status(message);}}
  }
  private async selectCurrent(){
    if(this.busy||!this.state)return;const runId=this.state.run_id;this.busy=true;this.paint();
    try{const versions=await this.api.prospectusVersions(this.project,this.signal);const v=versions.versions.find(v=>v.run_id===runId);if(!v)throw Error('成果版本尚未登记，请稍后重试。');await this.api.selectProspectus(this.project,{request_id:crypto.randomUUID(),version_id:v.version_id,expected_selection_revision:versions.selection_revision},this.signal);if(this.live()){this.status('已将本成果清洁版设为项目当前募集书，历史版本保留。');this.currentChanged();}}
    catch(e){if(this.live())this.status(friendlyError(e));}finally{this.busy=false;if(this.live()){const message=this.host!.querySelector('[data-editor-status]')?.textContent??'';this.paint();this.status(message);}}
  }
}
