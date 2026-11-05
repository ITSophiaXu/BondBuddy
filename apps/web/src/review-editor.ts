import {ReviewEditorResponseSchema,schemas,type ReviewEditorResponse,type ReviewEditorIssue,type ReviewArtifact,type ReviewHistoryEntry,type ReviewExportRequest,type Run} from './billing-types.js';
import {Value} from '@sinclair/typebox/value';
import { ApiClient,friendlyError } from './api';
import { UserFacingError } from './user-facing-error';
import { ArtifactDownloads,artifactError } from './artifact-download';
import {ReviewEditorCache} from './review-editor-cache';
import { esc } from './ui';
import type { ReviewFollowupSource } from './review-followup';
import './review-editor.css';

class EditorReadError extends UserFacingError{}

export class ReviewEditor {
  private downloads=new ArtifactDownloads();
  private state?:ReviewEditorResponse;private host?:HTMLElement;private selected='';private view='tracked';private category='all';private dirty=false;private busy=false;private disposed=false;private generation=0;
  private artifacts:ReviewArtifact[]=[];private history:ReviewHistoryEntry[]=[];private pending?:ReviewExportRequest;
  private downloading=new Set<string>();
  private cache?:ReviewEditorCache;private recoveryBlocked=false;private cacheWriteUnconfirmed=false;private notice='';
  private baseline:ReviewExportRequest['decisions']=[];
  constructor(private api:ApiClient,private project:string,private owner:string,private signal:AbortSignal,private submitted:(run:Run)=>void,private currentChanged:()=>void,private onSelectRun?:(runId:string)=>void,private onFollowup?:(source:ReviewFollowupSource)=>void){}
  get hasUnconfirmed(){return this.dirty||this.busy||!!this.pending||this.recoveryBlocked;}
  beforeLeave(){
    if(this.busy){this.status('正在确认本次操作结果，请等待回执后再离开。');return false;}
    if(this.recoveryBlocked){this.status('复核恢复记录尚未核实，请保留页面并恢复浏览器存储后重试。');return false;}
    if(!this.dirty&&!this.pending)return true;
    if(this.state&&this.cache){const saved=this.cache.read(this.state.sha256,this.issueIds());if(saved.status==='valid'&&JSON.stringify(saved.value.pending)===JSON.stringify(this.pending)&&saved.value.decisions.every(d=>this.decisions().some(current=>current.id===d.id&&current.decision===d.decision&&current.manual_text===d.manual_text)))return true;}
    this.status('浏览器未能保存并校验恢复记录，请保留本页人工修改，恢复浏览器存储后再离开。');return false;
  }
  dispose(){this.downloads.dispose();this.disposed=true;this.generation++;}
  private path(s:string){return `/projects/${encodeURIComponent(this.project)}/${s}`;}
  private live(){return !this.disposed&&!this.signal.aborted&&this.host?.isConnected;}
  private get locked(){return this.busy||!!this.pending||this.recoveryBlocked;}
  private conflictingPending(pending?:ReviewExportRequest){
    if(!this.pending||!pending||Value.Equal(this.pending,pending))return false;
    this.recoveryBlocked=true;this.notice='另一页面的待确认导出请求与本页请求不一致，已暂停提交。已保留本页处理选择和浏览器中的另一请求，请保留页面并联系支持。';return true;
  }
  private issueIds(){return this.state!.snapshot.issues.map(issue=>issue.id);}
  private cacheValue(){return {sha256:this.state!.sha256,decisions:this.pending?.decisions??this.decisions(),...(this.pending?{pending:this.pending}:{})};}
  private validArtifacts(artifacts:unknown):artifacts is ReviewArtifact[]{return Array.isArray(artifacts)&&artifacts.every(a=>a&&typeof a.artifact_id==='string'&&!!a.artifact_id&&Number.isSafeInteger(a.artifact_version)&&a.artifact_version>0&&['report','comments','revision','clean','baseline'].includes(a.kind)&&typeof a.filename==='string')&&new Set(artifacts.map(a=>a.artifact_id)).size===artifacts.length;}
  private recomputeDirty(){const current=this.decisions(),baseline=new Map(this.baseline.map(value=>[value.id,value]));this.dirty=current.length!==this.baseline.length||current.some(value=>{const saved=baseline.get(value.id);return !saved||saved.decision!==value.decision||(value.decision==='manual'&&saved.manual_text!==value.manual_text);});}
  private restore(saved:{decisions:ReviewExportRequest['decisions'];pending?:ReviewExportRequest}){for(const issue of this.state!.snapshot.issues)Object.assign(issue,saved.decisions.find(d=>d.id===issue.id)!);this.pending=saved.pending;this.cacheWriteUnconfirmed=false;this.recomputeDirty();}
  async mount(host:HTMLElement,run:string,artifacts:ReviewArtifact[],explicitSelection=false){
    if(this.state&&this.hasUnconfirmed){if(this.state.run_id===run&&host===this.host){this.paint();return;}this.status('请先完成当前处理，再切换成果。');return;}
    this.host=host;this.state=undefined;this.artifacts=[];this.notice='';host.innerHTML='<p role="status">正在读取复核成果…</p>';
    const generation=++this.generation;
    try{
      const [state,history]=await Promise.all([this.api.request<ReviewEditorResponse>('GET',this.path(`review-executions/${encodeURIComponent(run)}/editor`),undefined,{},this.signal),this.api.request<{items:ReviewHistoryEntry[]}>('GET',this.path('review-history'),undefined,{},this.signal)]);
      if(!this.live()||generation!==this.generation)return;
      if(!Value.Check(ReviewEditorResponseSchema,state)||state.run_id!==run||new Set(state.snapshot.issues.map(i=>i.id)).size!==state.snapshot.issues.length)throw new EditorReadError('复核编辑器版本与所选任务不一致，请重新选择历史版本。');
      if(!this.validArtifacts(artifacts))throw new EditorReadError('复核成果文件版本无法核实，请重新读取。');
      this.state=state;this.artifacts=artifacts.map(a=>({...a}));this.history=(Array.isArray(history.items)?history.items:[]).filter(h=>h?.run?.project_id===this.project&&typeof h.run.run_id==='string'&&['succeeded','test_completed'].includes(h.run.state)&&h.operation!=='revision'&&this.validArtifacts(h.artifacts)&&h.artifacts.some(a=>a.kind==='clean'));this.dirty=false;this.pending=undefined;this.recoveryBlocked=false;this.cacheWriteUnconfirmed=false;
      this.baseline=this.decisions();
      this.cache=new ReviewEditorCache(this.owner,this.project,run);const saved=this.cache.read(state.sha256,this.issueIds());
      if(saved.status==='valid'){this.restore(saved.value);if(this.pending)this.notice='新版导出回执尚未确认。处理选择已锁定，请显式重试确认；重新打开页面不会自动提交。';}
      else if(saved.status==='invalid'||saved.status==='unavailable'){this.recoveryBlocked=true;this.notice=saved.status==='invalid'?'浏览器中的复核恢复记录无法校验，已暂停修改和导出。请保留页面并联系支持，避免重复生成。':'浏览器暂时无法读取恢复记录，已暂停修改和导出。请恢复浏览器存储后重试读取。';}
      this.paint();
      if(explicitSelection&&this.live()&&generation===this.generation)this.onSelectRun?.(run);
    }catch(e){if(this.live()&&generation===this.generation){host.innerHTML=`<p role="alert">${esc(e instanceof EditorReadError?e.message:friendlyError(e,'read'))}</p><button class="btn secondary" data-reload-editor>重试读取复核结果</button>`;host.querySelector('[data-reload-editor]')!.addEventListener('click',()=>void this.mount(host,run,artifacts,explicitSelection));}}
  }
  private remember(){
    if(!this.state)return false;this.recomputeDirty();this.cacheWriteUnconfirmed=true;
    // A second tab can have saved an uncertain receipt for this same source run.
    // Never overwrite it with fresh choices or replace its idempotency key.
    const prior=this.cache?.read(this.state.sha256,this.issueIds());
    if(prior?.status==='valid'&&this.conflictingPending(prior.value.pending))return false;
    if(prior?.status==='valid'&&prior.value.pending&&!this.pending){this.restore(prior.value);this.notice='另一页面存在尚未确认的新版导出。已恢复原处理选择并锁定，请显式重试确认。';return true;}
    if(prior?.status==='invalid'||prior?.status==='unavailable'){this.recoveryBlocked=true;this.notice='浏览器恢复记录尚未核实，已暂停修改和导出。请保留页面后重试读取。';return false;}
    const saved=this.cache?.save(this.cacheValue(),this.issueIds())??false;
    if(!saved){this.notice='浏览器未能保存并校验恢复记录，本次尚未提交。请恢复浏览器存储后重试；离开前请保留人工修改。';if(!this.dirty)this.recoveryBlocked=true;}else{this.cacheWriteUnconfirmed=false;this.notice='';}return saved;
  }
  private recoverStorage(){
    if(!this.state||!this.cache||this.busy)return;
    const saved=this.cache.read(this.state.sha256,this.issueIds());
    if(saved.status==='invalid'||saved.status==='unavailable'){this.status('浏览器恢复记录仍无法核实，请保留页面并联系支持；尚未提交新版导出。');return;}
    if(saved.status==='valid'&&this.conflictingPending(saved.value.pending)){this.paint();return;}
    this.recoveryBlocked=false;if(saved.status==='valid'&&(saved.value.pending||(!this.dirty&&!this.cacheWriteUnconfirmed)))this.restore(saved.value);
    this.notice=this.pending?'原导出请求已恢复，请显式重试确认；不会自动提交。':'浏览器恢复记录已核实。';
    if((this.dirty||this.cacheWriteUnconfirmed)&&!this.pending)this.remember();this.paint();
  }
  private decisions(){return this.state!.snapshot.issues.map(({id,decision,manual_text})=>({id,decision,manual_text}));}
  private discard(){
    if(!this.state||!this.cache||this.locked||!this.dirty)return;
    const saved=this.cache.read(this.state.sha256,this.issueIds());
    if(saved.status==='valid'&&saved.value.pending){this.restore(saved.value);this.notice='另一页面存在尚未确认的新版导出。已恢复原处理选择并锁定，请显式重试确认；不能放弃待确认请求。';this.paint();return;}
    if(saved.status==='invalid'||saved.status==='unavailable'){this.recoveryBlocked=true;this.notice='浏览器恢复记录尚未核实，未放弃本页处理。请保留页面后重试读取。';this.paint();return;}
    if(!this.cache.clear()||this.cache.read(this.state.sha256,this.issueIds()).status!=='empty'){this.recoveryBlocked=true;this.notice='浏览器未能清除并校验本成果的恢复记录，未放弃本页处理。请保留页面并恢复浏览器存储后重试。';this.paint();return;}
    this.restore({decisions:this.baseline});this.notice='已放弃未保存处理，恢复当前查看的已保存成果。';this.paint();
  }
  private syncControls(){
    if(!this.state||!this.host)return;
    const blocked=this.dirty||this.locked;
    const state=this.host.querySelector('[data-editor-state]');if(state)state.textContent=this.pending?'新版导出回执待确认':this.dirty?'有未保存的处理选择':this.recoveryBlocked?'恢复记录待核实':'当前查看已保存版本';
    const save=this.host.querySelector<HTMLButtonElement>('[data-editor-save]');if(save){save.disabled=(!this.dirty&&!this.pending)||this.busy||this.recoveryBlocked;save.textContent=this.busy?'正在确认…':this.pending?'重试确认新版导出':'保存处理结果并生成新版';}
    this.host.querySelectorAll<HTMLButtonElement>('[data-editor-current],[data-editor-followup]').forEach(button=>button.disabled=blocked);
    const discard=this.host.querySelector<HTMLButtonElement>('[data-editor-discard]');if(discard)discard.disabled=!this.dirty||this.locked;
    const help=this.host.querySelector('[data-editor-followup-help]');if(help)help.textContent=blocked?'请先免费导出并确认当前处理结果，或放弃未保存处理，再准备下一轮。':'补料后可开始新一轮完整复核；本页处理选择可免费重新导出。';
    const issue=this.state.snapshot.issues.find(item=>item.id===this.selected);
    this.host.querySelectorAll<HTMLInputElement>('[name=review-decision]').forEach(control=>{control.checked=control.value===issue?.decision;control.disabled=this.locked||(control.value==='manual'&&!issue?.paragraph_id);});
    const history=this.host.querySelector<HTMLSelectElement>('[data-editor-history]');if(history)history.disabled=this.locked;
    const manual=this.host.querySelector<HTMLTextAreaElement>('#review-manual-text');if(manual){manual.disabled=this.locked;if(issue&&manual.value!==issue.manual_text){const start=manual.selectionStart,end=manual.selectionEnd;manual.value=issue.manual_text;manual.setSelectionRange(Math.min(start,manual.value.length),Math.min(end,manual.value.length));}}
    this.status(this.notice);
    if(this.recoveryBlocked&&!this.host.querySelector('[data-editor-recover]')){const recover=document.createElement('button');recover.className='btn secondary';recover.dataset.editorRecover='';recover.textContent='重试读取恢复记录';recover.onclick=()=>this.recoverStorage();this.host.querySelector('[data-editor-status]')!.after(recover);}
  }
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
      const comments=this.view==='tracked'?s.issues.filter(i=>i.paragraph_id===p.id).map(i=>`<div class="review-preview-comment"><strong>批注 ${esc(i.id)} · BondBuddy</strong><p>问题类别：${esc(i.category)}</p><p>${esc(i.reason)}</p><p>依据：${esc(i.evidence||'待补充')}</p>${i.missing?`<p>缺少材料：${esc(i.missing)}</p>`:''}${i.limitation?`<p>${esc(i.limitation)}</p>`:''}</div>`).join(''):'';
      return `<section id="review-paragraph-${esc(p.id)}" class="${s.issues.find(i=>i.id===this.selected)?.paragraph_id===p.id?'selected':''}"><p>${markup||'&nbsp;'}</p>${comments}</section>`;
    }).join('');
    this.host!.querySelector('[data-editor-document]')!.innerHTML=`<p class="review-muted">${this.dirty?'尚未保存的文字预览':'正文文字预览'} · 排版以下载 Word 为准</p><article class="review-paper">${html}</article>`;
  }
  private paint(){
    if(!this.state||!this.live())return;
    const s=this.state.snapshot;
    const changed=s.issues.filter(i=>i.applied&&i.decision!=='original'&&this.text(i)!==i.original).length;
    const savedDecisions=new Map(this.baseline.map(value=>[value.id,value]));
    const savedChanged=s.issues.filter(issue=>{const saved={...issue,...savedDecisions.get(issue.id)};return saved.applied&&saved.decision!=='original'&&this.text(saved)!==saved.original;}).length;
    const revisionLabel=savedChanged?'修订版':s.issues.length?'批注版（无正文修订）':'原文（未修订）';
    const summary=s.issues.length?`${s.issues.length} 项复核发现 · ${changed} 项正文修订`:'未提取到可处理的问题条目 · 正文未修改';
    if(this.category!=='all'&&!s.issues.some(issue=>issue.category===this.category))this.category='all';
    const filtered=s.issues.filter(i=>this.category==='all'||i.category===this.category);if(!filtered.some(issue=>issue.id===this.selected))this.selected=filtered[0]?.id??'';
    const issue=filtered.find(i=>i.id===this.selected);
    this.host!.innerHTML=`<div class="review-editor-head"><div><p class="review-kicker">REVIEW RESULTS</p><h2>复核成果</h2><p>${summary} · 成果独立保存，可手动设为项目当前版本</p></div><div class="review-downloads">${this.artifacts.filter(a=>['revision','clean','report'].includes(a.kind)).map(a=>`<button class="btn ${a.kind==='revision'?'primary':'secondary'}" data-editor-download data-artifact-id="${esc(a.artifact_id)}" ${this.downloading.has(a.artifact_id)?'disabled':''}>${this.downloading.has(a.artifact_id)?'正在读取…':'下载'+(a.kind==='revision'?revisionLabel:a.kind==='clean'?'清洁版':'复核报告')}</button>`).join('')}<button class="btn secondary" data-editor-current ${this.dirty||this.locked?'disabled':''}>设为项目当前版本</button><a class="btn secondary" href="#consistency?project=${encodeURIComponent(this.project)}">检查文件一致性</a></div></div>${s.warnings.map(w=>`<p class="review-notice">${esc(w)}</p>`).join('')}<div class="review-editor-toolbar"><label>成果历史 <select data-editor-history>${this.history.map(h=>`<option value="${esc(h.run.run_id)}" ${h.run.run_id===this.state!.run_id?'selected':''}>成果 V${h.version} · ${esc(new Date(h.created_at).toLocaleString())}</option>`).join('')}</select></label><span data-editor-state>${this.pending?'新版导出回执待确认':this.dirty?'有未保存的处理选择':'当前查看已保存版本'}</span><button class="btn primary" data-editor-save ${(!this.dirty&&!this.pending)||this.busy||this.recoveryBlocked?'disabled':''}>${this.busy?'正在确认…':this.pending?'重试确认新版导出':'保存处理结果并生成新版'}</button><button class="btn secondary" data-editor-discard ${!this.dirty||this.locked?'disabled':''}>放弃未保存处理</button></div><p class="review-muted">下载按钮始终提供当前已保存的 Word，不包含本页尚未保存的预览修改。保存处理结果只重新导出文档，不重复 AI 复核或收取 AI 费用。存疑内容保留原文，批注说明缺少材料；问题类别及复核说明只在批注、报告和结果页显示，清洁版正文不附复核说明。</p><p data-editor-status role="status" aria-live="polite">${esc(this.notice)}</p><div class="review-editor-grid"><aside><label for="review-editor-category">复核发现</label><select id="review-editor-category"><option value="all">全部类别</option>${[...new Set(s.issues.map(i=>i.category))].map(c=>`<option value="${esc(c)}" ${c===this.category?'selected':''}>${esc(c)}</option>`).join('')}</select><div class="review-editor-issues">${filtered.map(i=>`<button class="review-issue ${i.id===this.selected?'active':''}" data-editor-issue="${esc(i.id)}"><small>${esc(i.category)} · ${i.uncertain||i.limitation?'待确认':'修改建议'}</small><strong>${esc(i.title)}</strong><span>${i.decision==='original'?'保留原文':i.decision==='manual'?'手动修改':i.applied?'已采用建议':'查看建议'}</span></button>`).join('')||'<p>未提取到可处理的问题条目，请查看复核报告；这不表示未发现问题。</p>'}</div>${issue?`<section class="review-issue-detail"><h3>${esc(issue.title)}</h3><p>${esc(issue.reason)}</p><blockquote>${esc(issue.original||'无可定位原文')}</blockquote><p><strong>建议文本</strong><br>${esc(issue.replacement||'保留原文，待补充材料后确认')}</p><p><strong>依据</strong><br>${esc(issue.evidence||'待补充')}</p>${issue.missing?`<p class="review-warning">缺少材料：${esc(issue.missing)}</p>`:''}${issue.limitation?`<p class="review-warning">${esc(issue.limitation)}</p>`:''}<fieldset><legend>处理这项发现</legend>${[['suggested',issue.uncertain?'保留待确认批注':'采用建议'],['original','保留原文'],['manual','手动修改']].map(([key,label])=>`<label><input type="radio" name="review-decision" value="${key}" ${issue.decision===key?'checked':''} ${key==='manual'&&!issue.paragraph_id?'disabled':''}>${label}</label>`).join('')}</fieldset>${issue.decision==='manual'?`<label for="review-manual-text">替换原文的内容</label><textarea id="review-manual-text" rows="6" maxlength="12000">${esc(issue.manual_text)}</textarea>`:''}${this.onFollowup?`<div class="review-issue-followup"><button class="btn secondary" data-editor-followup ${this.dirty||this.locked?'disabled':''}>补充材料与要求</button><p class="review-muted" data-editor-followup-help>${this.dirty||this.locked?'请先免费导出并确认当前处理结果，或放弃未保存处理，再准备下一轮。':'补料后可开始新一轮完整复核；本页处理选择可免费重新导出。'}</p></div>`:''}</section>`:''}</aside><section class="review-editor-preview"><div role="group" aria-label="文档预览版本">${[['original','原文'],['tracked',changed?'修订版':s.issues.length?'批注版':'未修订正文'],['clean','清洁版']].map(([v,label])=>`<button class="btn ${this.view===v?'primary':'secondary'}" data-editor-view="${v}" aria-pressed="${this.view===v}">${label}</button>`).join('')}</div><div data-editor-document></div></section></div>`;
    this.preview();
    this.syncControls();
    this.host!.querySelectorAll<HTMLElement>('[data-editor-download]').forEach(button=>button.onclick=()=>void this.download(button.dataset.artifactId!));
    this.host!.querySelectorAll<HTMLElement>('[data-editor-issue]').forEach(b=>b.onclick=()=>{this.selected=b.dataset.editorIssue!;this.paint();this.host!.querySelector(`#review-paragraph-${CSS.escape(this.state!.snapshot.issues.find(i=>i.id===this.selected)?.paragraph_id??'')}`)?.scrollIntoView({block:'nearest'});});
    this.host!.querySelectorAll<HTMLElement>('[data-editor-view]').forEach(b=>b.onclick=()=>{this.view=b.dataset.editorView!;this.paint();});
    this.host!.querySelector<HTMLSelectElement>('#review-editor-category')!.onchange=e=>{this.category=(e.target as HTMLSelectElement).value;this.paint();};
    this.host!.querySelectorAll<HTMLInputElement>('[name=review-decision]').forEach(r=>r.onchange=()=>{if(this.locked){this.paint();return;}issue!.decision=r.value as ReviewEditorIssue['decision'];if(r.value==='manual'&&!issue!.manual_text)issue!.manual_text=issue!.replacement||issue!.original;this.remember();this.paint();});
    const manual=this.host!.querySelector<HTMLTextAreaElement>('#review-manual-text');if(manual)manual.oninput=()=>{if(!this.locked){issue!.manual_text=manual.value;this.remember();}if(this.locked){this.paint();return;}this.preview();this.syncControls();};
    const followup=this.host!.querySelector<HTMLElement>('[data-editor-followup]');
    if(followup)followup.onclick=()=>{if(this.dirty||this.locked||!issue||!this.state)return;this.onFollowup?.({runId:this.state.run_id,version:this.history.find(h=>h.run.run_id===this.state!.run_id)?.version,title:issue.title,sourceFilename:this.state.snapshot.source_filename,details:[`原文：${issue.original}`,`复核说明：${issue.reason}`,`依据：${issue.evidence||'待补充'}`,issue.missing?`缺少材料：${issue.missing}`:'',issue.limitation?`限制：${issue.limitation}`:''],clean:this.artifacts.find(a=>a.kind==='clean')});};
    this.host!.querySelector<HTMLElement>('[data-editor-save]')!.onclick=()=>void this.save();
    this.host!.querySelector<HTMLElement>('[data-editor-discard]')!.onclick=()=>this.discard();
    this.host!.querySelector<HTMLElement>('[data-editor-current]')!.onclick=()=>void this.selectCurrent();
    this.host!.querySelector<HTMLSelectElement>('[data-editor-history]')!.onchange=e=>{if(this.dirty||this.locked){this.status('请先完成当前处理，再切换成果。');(e.target as HTMLSelectElement).value=this.state!.run_id;return;}const h=this.history.find(h=>h.run.run_id===(e.target as HTMLSelectElement).value);if(h)void this.mount(this.host!,h.run.run_id,h.artifacts,true);};
  }
  private status(message:string){this.notice=message;const el=this.host?.querySelector('[data-editor-status]');if(el)el.textContent=message;}
  private async download(id:string){
    if(this.downloading.has(id)||!this.state)return;
    const artifact=this.artifacts.find(a=>a.artifact_id===id),runId=this.state.run_id,generation=this.generation;
    if(!artifact)return;
    this.downloading.add(id);this.paint();this.status('正在读取并校验文件，请稍候…');
    try{
      const metadata=await this.api.artifact(id,this.signal);
      if(!this.live()||this.generation!==generation||this.state?.run_id!==runId)return;
      if(metadata.artifact_id!==id||metadata.run_id!==runId||metadata.version!==artifact.artifact_version)throw new EditorReadError('下载文件与当前复核版本不一致，请重新打开该版本。');
      const bytes=await this.api.artifactBytes(metadata,this.signal);
      if(this.live()&&this.generation===generation&&this.state?.run_id===runId){
        this.downloads.save(bytes,metadata.filename??artifact.filename);
        this.status('文件已就绪，已提交浏览器下载；可在浏览器下载列表中查看。');
      }
    }catch(error){if(this.live()&&this.generation===generation&&this.state?.run_id===runId)this.status(error instanceof EditorReadError?error.message:artifactError(error));}
    finally{
      this.downloading.delete(id);
      if(this.live()&&this.generation===generation&&this.state?.run_id===runId)this.paint();
    }
  }
  private async save(){
    if(this.busy||!this.state||this.recoveryBlocked||(!this.dirty&&!this.pending)||!this.live())return;
    const generation=this.generation;
    const prior=this.cache?.read(this.state.sha256,this.issueIds());
    if(prior?.status==='valid'&&this.conflictingPending(prior.value.pending)){this.paint();return;}
    if(prior?.status==='invalid'||prior?.status==='unavailable'){this.recoveryBlocked=true;this.status('浏览器恢复记录尚未核实，本次尚未提交。请保留页面后重试读取。');this.paint();return;}
    if(prior?.status==='valid'&&prior.value.pending&&!this.pending){this.restore(prior.value);this.status('另一页面存在尚未确认的新版导出。已恢复原处理选择，请点击“重试确认新版导出”。');this.paint();return;}
    const pending=this.pending??{request_id:crypto.randomUUID(),source_run_id:this.state.run_id,expected_editor_sha256:this.state.sha256,decisions:this.decisions()};
    // Persist and read back the entire immutable retry body before the first POST.
    if(!this.cache?.save({sha256:this.state.sha256,decisions:pending.decisions,pending},this.issueIds())){this.status('浏览器未能保存并校验恢复记录，本次尚未提交。请恢复浏览器存储后重试；离开前请保留人工修改。');return;}
    this.pending=this.cache.read(this.state.sha256,this.issueIds()).value?.pending;
    if(!this.pending){this.status('浏览器未能校验完整导出恢复记录，本次尚未提交。请保留页面后重试。');return;}
    const envelope=this.pending;this.busy=true;this.notice='正在确认新版导出回执…';this.paint();
    try{const run=await this.api.request<Run>('POST',this.path('review-exports'),envelope,{},this.signal);if(!this.live()||generation!==this.generation)return;
      if(!Value.Check(schemas.RunResponse,run)||run.project_id!==this.project||run.execution_request_id!==envelope.request_id)throw new EditorReadError('新版导出回执与本次请求不一致，结果尚未确认。');
      this.cache.clear();this.dirty=false;this.pending=undefined;this.notice='新版导出已确认，正在读取任务状态。';this.submitted(run);
    }
    catch(e){if(this.live()&&generation===this.generation)this.status((e instanceof EditorReadError?e.message:friendlyError(e,'submit'))+' 处理选择已保留并锁定，请点击“重试确认新版导出”使用同一请求重试。');}
    finally{this.busy=false;if(this.live()&&generation===this.generation)this.paint();}
  }
  private async selectCurrent(){
    if(this.locked||this.dirty||!this.state)return;const runId=this.state.run_id,generation=this.generation;this.busy=true;this.paint();
    try{const versions=await this.api.prospectusVersions(this.project,this.signal);if(!this.live()||generation!==this.generation)return;const v=versions.versions.find(v=>v.run_id===runId);if(!v)throw new EditorReadError('成果版本尚未登记，请稍后重试。');await this.api.selectProspectus(this.project,{request_id:crypto.randomUUID(),version_id:v.version_id,expected_selection_revision:versions.selection_revision},this.signal);if(this.live()&&generation===this.generation){this.status('已将本成果清洁版设为项目当前募集书，历史版本保留。');this.currentChanged();}}
    catch(e){if(this.live()&&generation===this.generation)this.status(e instanceof EditorReadError?e.message:friendlyError(e,'save'));}finally{this.busy=false;if(this.live()&&generation===this.generation)this.paint();}
  }
}
