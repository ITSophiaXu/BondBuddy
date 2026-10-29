import {isAutomaticCharge} from './commerce';
import {UserFacingError} from './user-facing-error.js';
import {PROJECT_DOCUMENT_CATALOG,PROJECT_FILE_UPDATE_PRICE,OUTCOME_PRICE_VERSION,isOutcomePriceVersion,schemas,type ProjectFileCheck,type ProjectFileVersion,type ProjectFileSource,type ProjectFileFinding,type ProjectFileAsset} from '@bondbuddy/contracts';
import {Value} from '@sinclair/typebox/value';
import {ApiClient,ApiError,friendlyError,type Dto} from './api';
import {withProjectContext,rechargeHref} from './project-navigation';
import {ArtifactDownloads,artifactFilename} from './artifact-download';
import {ProspectusPanel} from './prospectus-panel';
import {esc,date} from './ui';
import {runStateLabel} from './review-state';
import {prototypeIcon as ico} from './prototype-design';
import {createConfirmationSnapshot,restoreConfirmationSnapshot,type ConfirmationBinding,type ConfirmationSnapshot} from './consistency-confirmation';
import {linkedConsistencyCheck,linkedConsistencyUpdateCheck} from './consistency-history';
import './file-workspace.css';
import './consistency-selection.css';
import './consistency-originals.css';
import './consistency-manual-reading.css';
import './consistency-file-search.css';
import './consistency-confirmation.css';
import {readCommerce,isCnyPrice,cny,displayPrice,confirmCnyTask,scopeLinesHtml,scopeStatus,scopeStatusLabel,scopeLifecycleHtml,guardScopeExpiry} from './commerce';
type Updates=import('@bondbuddy/contracts').ProjectFileUpdateBatches;
type FileFreshness={checked:ProjectFileCheck['files'][number];current?:ProjectFileVersion;state:'same'|'changed'|'delivered'|'missing'};
type UpdateTarget={run:string;check:ProjectFileCheck;update:ProjectFileCheck['updates'][number];file:ProjectFileCheck['files'][number]};
type ReadingFile={version:string;family:string;sequence:number};
type FindingIdentity={id:string;signature:string};
type ManualNav={context:string;file:ReadingFile;checkedFileSignature:string;mode:'first'|'previous'|'next'|'file';origin?:FindingIdentity;target?:FindingIdentity};
type ReadingTarget={kind:'file'|'select'|'detail'|'finding'|'coverage'|'manual-nav';file:ReadingFile;finding?:FindingIdentity;value?:string}|
  {kind:'search';start:number|null;end:number|null;direction:'forward'|'backward'|'none'|null}|
  {kind:'clear-search'|'show-all'|'filter'|'history'|'all'|'refresh'|'facet'|'show-selected'|'clear-selection'|'freshness'|'results'|'page'|'update';value?:string}|
  {kind:'nav';href:string;label:string};
type ReadingSnapshot={context:string;filter:string;query:string;anchor?:{target:ReadingTarget;top:number};focus?:ReadingTarget};
type RenderedView={host:HTMLElement;context:string;filter:string;query:string;check?:ProjectFileCheck};
type PendingUpdate={checkId:string;body:Dto<'ProjectFileUpdateRequest'>;filenames:string[];attempted:boolean;confirmation?:ConfirmationSnapshot;quote?:Dto<'ProjectFileUpdateQuoteResponse'>};
const active=new Set(['queued','preparing','running','validating','delivering','settlement_pending']);
export class FileConsistency {
  private commerce=false;
  private updateTotal(c:ProjectFileCheck,files:ProjectFileCheck['files']){if(!this.commerce)return files.length*PROJECT_FILE_UPDATE_PRICE.points;if(files.some(file=>!Number.isSafeInteger(file.update_points)))throw new ApiError(503,'BILLING_NOT_READY');return files.reduce((total,file)=>total+file.update_points!,0);}
  private abort=new AbortController();private timer?:ReturnType<typeof setTimeout>;private busy=false;private downloads=new ArtifactDownloads();
  private checks:ProjectFileCheck[]=[];private files:ProjectFileVersion[]=[];private updates:Updates['batches']=[];private source:ProjectFileSource|null=null;
  private linkedHistory?:string;private historyReadError='';
  private linkedUpdateHistory?:string;
  private chosen=new Set<string>();private selectionCheck?:string;private filter='all';private name='';private message='';private needsCredits=false;
  private prospectus?:ProspectusPanel;private prospectusHost?:HTMLElement;
  private checkRequest?:Dto<'ProjectFileCheckRequest'>;
  private pendingUpdate?:PendingUpdate;
  private dialog?:HTMLDialogElement;private locatedUpdate?:string;
  private originalMessages=new Map<string,string>();
  private manualTokens=new Map<string,string>();private manualControls=new Map<string,ManualNav>();
  private query='';private composingSearch=false;private deferredPaint=false;
  private reloadRevision=0;private view?:RenderedView;private detailsContext?:string;
  private detailStates=new Map<string,boolean>();private freshnessDetailOpen=false;private detailsRevealed=false;
  get hasUnconfirmed(){return this.busy||!!this.checkRequest||!!this.pendingUpdate?.attempted||!!this.prospectus?.hasUnconfirmed;}
  async beforeLeave(){if(this.prospectus&&!await this.prospectus.beforeLeave())return false;if(!this.hasUnconfirmed){this.closeDialog();return true;}this.message=this.busy?'正在确认本次操作，请等待提交结果后再离开。':'上次提交结果尚未确认，请先重试确认同一请求，避免重复创建任务。';this.status();return false;}
  constructor(private api:ApiClient,private shell:(html:string,section:string)=>void,private current:()=>boolean,private id:string,private owner?:string){
    this.restore();
    // A file link must reveal its target on arrival; later filter choices stay explicit.
    const q=new URLSearchParams(location.hash.split('?')[1]);if(q.get('file')||q.has('update_run'))this.filter='all';
  }
  private get cacheKey(){return this.owner?'bondbuddy:file-consistency:'+encodeURIComponent(this.owner)+':'+encodeURIComponent(this.id):undefined;}
  private restore(){
    if(!this.cacheKey)return;
    try{const cached=JSON.parse(sessionStorage.getItem(this.cacheKey)??'null');
      if(cached?.owner!==this.owner||cached?.project!==this.id)return;
      if(typeof cached.selectionCheck==='string'&&cached.selectionCheck.length<=128&&Array.isArray(cached.chosen)&&cached.chosen.length<=200&&cached.chosen.every((id:unknown)=>typeof id==='string'&&id.length>0&&id.length<=128)){this.selectionCheck=cached.selectionCheck;this.chosen=new Set(cached.chosen);}
      if(['all','conflict','consistent','manual','updated','selected'].includes(cached.filter))this.filter=cached.filter;
      this.needsCredits=cached.needsCredits===true;
      if(Value.Check(schemas.ProjectFileCheckRequest,cached.checkRequest))this.checkRequest=cached.checkRequest;
      const pending=cached.pendingUpdate;
      if(pending?.attempted===true&&typeof pending.checkId==='string'&&pending.checkId.length>0&&pending.checkId.length<=128&&Value.Check(schemas.ProjectFileUpdateRequest,pending.body)&&Array.isArray(pending.filenames)&&pending.filenames.length===pending.body.files.length&&pending.filenames.every((n:unknown)=>typeof n==='string'&&n.length<=200)){
        this.pendingUpdate={checkId:pending.checkId,body:pending.body,filenames:pending.filenames,attempted:true,...(Value.Check(schemas.ProjectFileUpdateQuoteResponse,pending.quote)?{quote:pending.quote}:{})};
        this.pendingUpdate.confirmation=restoreConfirmationSnapshot(pending.confirmation,this.confirmationBinding(this.pendingUpdate));
      }
      if(this.checkRequest||this.pendingUpdate)this.message='已恢复上次尚未确认的提交，请重试核对同一请求。';
      else if(this.needsCredits)this.message='已恢复本轮文件选择。充值后请重新确认费用，尚未提交更新。';
    }catch{/* Server records remain authoritative; do not invent a completed operation. */}
  }
  private cache(){
    if(!this.cacheKey)return;
    try{if(!this.checkRequest&&!this.pendingUpdate?.attempted&&!this.chosen.size&&!this.needsCredits)sessionStorage.removeItem(this.cacheKey);else sessionStorage.setItem(this.cacheKey,JSON.stringify({owner:this.owner,project:this.id,selectionCheck:this.checkRequest||this.pendingUpdate?.attempted?this.selectionCheck:this.selected()?.run_id??this.selectionCheck,chosen:[...this.chosen],filter:this.filter,needsCredits:this.needsCredits,checkRequest:this.checkRequest,pendingUpdate:this.pendingUpdate?.attempted?this.pendingUpdate:undefined}));}
    catch{this.message='浏览器无法保存重试凭据，请保持页面打开并确认本次提交结果。';}
  }
  private live(){return this.current()&&!this.abort.signal.aborted;}
  dispose(){this.abort.abort();clearTimeout(this.timer);this.downloads.dispose();this.prospectus?.dispose();this.closeDialog();}
  private request<T>(method:'GET'|'POST',path:string,body?:unknown){return this.api.request<T>(method,`/projects/${encodeURIComponent(this.id)}/project-files${path}`,body,{},AbortSignal.any([this.abort.signal,AbortSignal.timeout(30000)]));}
  async render(){
    if(!this.id){this.shell('<h1>检查文件一致性</h1><p>请从全部项目选择需要检查的项目。</p><a class="btn primary" href="#tasks">选择项目</a>','projects');return;}
    this.shell('<p role="status">正在读取文件与检查记录…</p>','projects');
    try{const [p,catalog]=await Promise.all([this.api.project(this.id,this.abort.signal),readCommerce(this.api,this.abort.signal)]);this.commerce=catalog?.enabled===true;this.name=p.name;await this.reload();}
    catch(e){if(this.live())this.shell(`<h1>文件一致性检查</h1><p role="alert">${esc(friendlyError(e,'read'))}</p><a class="btn secondary" href="#/projects/${encodeURIComponent(this.id)}/files">返回项目文件</a>`,'projects');}
  }
  private updateTarget():UpdateTarget|null|undefined{
    const q=new URLSearchParams(location.hash.split('?')[1]);if(!q.has('update_run'))return undefined;
    const runs=q.getAll('update_run');if(runs.length!==1||!runs[0])return null;
    const matches=this.checks.flatMap(check=>check.updates.filter(update=>update.run_id===runs[0]).map(update=>({check,update})));if(matches.length!==1)return null;
    const {check,update}=matches[0],checks=this.checks.filter(c=>c.run_id===check.run_id),files=check.files.filter(f=>f.file_version_id===update.file_version_id),results=check.result?.files.filter(f=>f.file_version_id===update.file_version_id)??[],checkRuns=q.getAll('run'),fileIds=q.getAll('file');
    if(checks.length!==1||files.length!==1||results.length!==1||q.has('run')&&(checkRuns.length!==1||checkRuns[0]!==check.run_id)||q.has('file')&&(fileIds.length!==1||!fileIds[0]||![files[0].file_version_id,files[0].file_id].includes(fileIds[0])))return null;
    return {run:runs[0],check,update,file:files[0]};
  }
  private selected(){const target=this.updateTarget();if(target!==undefined)return target?.check;const q=new URLSearchParams(location.hash.split('?')[1]),runs=q.getAll('run');if(!q.has('run'))return this.checks[0];const matches=this.checks.filter(c=>c.run_id===runs[0]);return runs.length===1&&!!runs[0]&&matches.length===1?matches[0]:undefined;}
  private async workspace(prepare=true){
    try{return await this.request<{source:ProjectFileSource|null}>('GET','/workspace');}
    catch(e){if(!(e instanceof ApiError)||e.status!==404)throw e;return prepare?this.request<{source:ProjectFileSource|null}>('POST','/workspace',{request_id:crypto.randomUUID()}):{source:null};}
  }
  private async reload(readOnly=false){
    const revision=++this.reloadRevision;clearTimeout(this.timer);
    try{
      const query=new URLSearchParams(location.hash.split('?')[1]),runs=query.getAll('run'),updateRuns=query.getAll('update_run');
      const linkedRun=runs.length===1&&runs[0].trim()&&runs[0].length<=128?runs[0]:undefined;
      const linkedUpdate=updateRuns.length===1&&updateRuns[0].trim()&&updateRuns[0].length<=128?updateRuns[0]:undefined;
      const [checks,files,state,updates]=await Promise.all([this.request<{checks:ProjectFileCheck[]}>('GET','/checks'),this.request<{files:ProjectFileVersion[]}>('GET',''),
        this.workspace(!readOnly&&!query.has('run')&&!query.has('update_run')),this.request<Updates>('GET','/updates')]);
      if(!this.live()||revision!==this.reloadRevision)return;
      let linkedHistory:string|undefined,linkedUpdateHistory:string|undefined,historyReadError='';
      if(linkedRun&&!checks.checks.some(c=>c.run_id===linkedRun)){
        try{
          const check=await linkedConsistencyCheck(this.api,this.id,linkedRun,checks.checks,AbortSignal.any([this.abort.signal,AbortSignal.timeout(15000)]));
          checks.checks=[...checks.checks,check];linkedHistory=linkedRun;
        }catch(error){
          historyReadError=error instanceof ApiError&&[403,404].includes(error.status)?'原检查不存在或当前账号无权读取，请核对原链接。':friendlyError(error,'read');
          const previous=this.checks.filter(c=>c.run_id===linkedRun);
          // A transient read failure must not discard the active historical
          // run and thereby stop its polling. Keep the last exact snapshot.
          const transient=!(error instanceof UserFacingError)&&(!(error instanceof ApiError)||error.status>=500||[408,429].includes(error.status));
          if(transient&&this.linkedHistory===linkedRun&&previous.length===1){checks.checks=[...checks.checks,previous[0]];linkedHistory=linkedRun;}
        }
      }
      else if(!query.has('run')&&linkedUpdate&&!checks.checks.some(c=>c.updates.some(update=>update.run_id===linkedUpdate))){
        try{
          const check=await linkedConsistencyUpdateCheck(this.api,this.id,linkedUpdate,checks.checks,AbortSignal.any([this.abort.signal,AbortSignal.timeout(15000)]));
          // An existing check without this acceptance is an inconsistent
          // projection, not permission to replace its contents silently.
          if(checks.checks.some(c=>c.run_id===check.run_id))throw new UserFacingError('原检查中的更新记录尚未一致，请重新读取。');
          checks.checks=[...checks.checks,check];linkedHistory=check.run_id;linkedUpdateHistory=linkedUpdate;
        }catch(error){
          historyReadError=error instanceof ApiError&&[403,404].includes(error.status)?'原更新任务不存在或当前账号无权读取，请核对原链接。':friendlyError(error,'read');
          const previous=this.checks.filter(c=>c.updates.some(update=>update.run_id===linkedUpdate));
          const transient=!(error instanceof UserFacingError)&&(!(error instanceof ApiError)||error.status>=500||[408,429].includes(error.status));
          if(transient&&this.linkedUpdateHistory===linkedUpdate&&previous.length===1&&!checks.checks.some(c=>c.run_id===previous[0].run_id)){
            checks.checks=[...checks.checks,previous[0]];linkedHistory=previous[0].run_id;linkedUpdateHistory=linkedUpdate;
          }
        }
      }
      if(!this.live()||revision!==this.reloadRevision)return;
      this.checks=checks.checks;this.files=files.files;this.source=state.source;this.updates=updates.batches;
      this.linkedHistory=linkedHistory;this.historyReadError=historyReadError;
      this.linkedUpdateHistory=linkedUpdateHistory;
      // Explicit actions repaint in finally, after busy is cleared. A first
      // disabled repaint would remove the focused node before it can be read.
      if(!this.busy)this.paint();
    }catch(error){if(this.live()&&revision===this.reloadRevision)throw error;}
    finally{if(this.live()&&revision===this.reloadRevision)this.schedule();}
  }
  private schedule(){clearTimeout(this.timer);if(!this.live())return;
    const check=this.selected();if(check&&(active.has(check.state)||check.updates.some(u=>active.has(u.state)))||this.updates.some(b=>['queued','running'].includes(b.state)))
      this.timer=setTimeout(()=>{void this.reload(true).catch(e=>{if(this.live()){this.message='刷新未成功，当前显示上次结果。'+friendlyError(e,'read');this.status();this.schedule();}});},4000);
  }
  private status(){const reading=this.captureReading(),s=document.querySelector('#fc-status');if(s)s.textContent=this.message;this.restoreReading(reading,true);}
  private async act(fn:()=>Promise<void>,progress='正在提交…',operation:'read'|'save'|'download'|'submit'|'action'='submit'){if(this.busy)return;this.busy=true;this.message=progress;this.status();
    try{await fn();}catch(e){if(this.live()){this.message=friendlyError(e,operation);this.status();}}
    finally{this.busy=false;if(this.live())this.paint();}
  }
  private readingContext(c=this.selected()){
    const q=new URLSearchParams(location.hash.split('?')[1]);
    return JSON.stringify([this.owner??null,this.id,c?.run_id??null,c?.sha256??null,c?.source??null,...['run','update_run','file'].map(key=>q.getAll(key))]);
  }
  private readingFile(c:ProjectFileCheck|undefined,version:string):ReadingFile|undefined{
    const files=c?.files.filter(f=>f.file_version_id===version)??[],results=c?.result?.files.filter(f=>f.file_version_id===version)??[];
    if(files.length!==1||results.length!==1)return;
    return {version,family:files[0].file_id,sequence:files[0].sequence};
  }
  private displayed(node:HTMLElement){
    if(!node.isConnected||!node.checkVisibility())return false;
    const closed=node.closest('details:not([open])'),summary=closed?.querySelector(':scope > summary');
    if(closed&&summary!==node&&!summary?.contains(node))return false;
    return true;
  }
  private visible(node:HTMLElement){
    if(!this.displayed(node))return false;
    const box=node.getBoundingClientRect();return box.height>0&&box.bottom>0&&box.top<innerHeight;
  }
  private fileReadingTarget(node:HTMLElement,view:RenderedView):ReadingTarget|undefined{
    const row=node.closest<HTMLElement>('[data-fc-result-version]');if(!row||!view.host.contains(row))return;
    const version=row.dataset.fcResultVersion!,file=this.readingFile(view.check,version);
    if(!file||[...view.host.querySelectorAll<HTMLElement>('[data-fc-result-version]')].filter(r=>r.dataset.fcResultVersion===version).length!==1)return;
    if(node.matches('[data-fc-select]'))return {kind:'select',file};
    if(node.matches('[data-fc-manual-nav]')){
      const value=node.dataset.fcManualNav,payload=value&&this.manualControls.get(value);
      return payload&&payload.context===view.context?{kind:'manual-nav',file,value}:{kind:'file',file};
    }
    const finding=node.closest<HTMLElement>('[data-fc-finding-id]');
    if(finding&&row.contains(finding)){
      const id=finding.dataset.fcFindingId!,items=view.check!.result!.files.find(f=>f.file_version_id===version)!.findings.filter(i=>i.id===id);
      if(items.length===1&&[...row.querySelectorAll<HTMLElement>('[data-fc-finding-id]')].filter(n=>n.dataset.fcFindingId===id).length===1)return {kind:'finding',file,finding:{id,signature:JSON.stringify(items[0])}};
    }
    if(node.closest('[data-fc-coverage]'))return {kind:'coverage',file};
    if(node.matches('summary')&&node.parentElement?.matches('[data-fc-detail]'))return {kind:'detail',file};
    return {kind:'file',file};
  }
  private captureReading():ReadingSnapshot|undefined{
    const view=this.view;if(!view?.host.isConnected)return;
    const snapshot:ReadingSnapshot={context:view.context,filter:view.filter,query:view.query},focused=document.activeElement instanceof HTMLElement?document.activeElement:undefined;
    if(focused&&focused!==document.body&&!view.host.contains(focused)){
      if(focused instanceof HTMLAnchorElement&&focused.closest('#sidebar'))snapshot.focus={kind:'nav',href:focused.getAttribute('href')??'',label:focused.textContent??''};
      return snapshot.focus?snapshot:undefined;
    }
    let focus:ReadingTarget|undefined;
    if(focused&&focused!==document.body&&focused!==view.host){
      focus=this.fileReadingTarget(focused,view);
      if(!focus){
        if(focused instanceof HTMLInputElement&&focused.id==='fc-file-search')focus={kind:'search',start:focused.selectionStart,end:focused.selectionEnd,direction:focused.selectionDirection};
        else if(focused.matches('[data-fc-clear-search]'))focus={kind:'clear-search'};
        else if(focused.matches('[data-fc-show-all]'))focus={kind:'show-all',value:focused.dataset.fcShowAll};
        else if(focused.id==='fc-filter')focus={kind:'filter'};
        else if(focused.id==='fc-history')focus={kind:'history'};
        else if(focused.id==='fc-all')focus={kind:'all',value:this.selectionRange(view)};
        else if(focused.matches('[data-fc-filter]'))focus={kind:'facet',value:focused.dataset.fcFilter};
        else if(focused.matches('[data-fc-refresh]'))focus={kind:'refresh',value:focused.closest('#fc-update-task')?'update':'source'};
        else if(focused.matches('[data-fc-show-selected]'))focus={kind:'show-selected'};
        else if(focused.matches('[data-fc-clear-selection]'))focus={kind:'clear-selection'};
        else if(focused.matches('[data-fc-freshness-detail] > summary'))focus={kind:'freshness'};
        else if(focused.closest('#fc-update-task'))focus={kind:'update'};
        else focus={kind:focused.closest('.fc-results,.pf-footer')?'results':'page'};
      }
    }
    snapshot.focus=focus;
    const focusedPart=focused&&this.visible(focused)?this.fileReadingTarget(focused,view):undefined;
    const candidates=focusedPart?[focused!]:[...view.host.querySelectorAll<HTMLElement>('[data-fc-finding-id], [data-fc-coverage], [data-fc-detail] > summary'),...view.host.querySelectorAll<HTMLElement>('[data-fc-result-version]')];
    for(const node of candidates){if(!this.visible(node))continue;const target=this.fileReadingTarget(node,view);if(target){const actual=this.readingNode(target,view);if(actual){snapshot.anchor={target,top:actual.getBoundingClientRect().top};break;}}}
    return snapshot.anchor||snapshot.focus?snapshot:undefined;
  }
  private readingNode(target:ReadingTarget,view=this.view):HTMLElement|undefined{
    if(!view?.host.isConnected)return;
    const one=(selector:string,predicate:(node:HTMLElement)=>boolean=()=>true)=>{const nodes=[...view.host.querySelectorAll<HTMLElement>(selector)].filter(predicate);return nodes.length===1?nodes[0]:undefined;};
    if('file' in target){
      const file=this.readingFile(view.check,target.file.version);if(!file||file.family!==target.file.family||file.sequence!==target.file.sequence)return;
      const row=one('[data-fc-result-version]',n=>n.dataset.fcResultVersion===file.version);if(!row)return;
      if(target.kind==='file')return row;
      if(target.kind==='select')return row.querySelector<HTMLElement>('[data-fc-select]')??undefined;
      if(target.kind==='detail')return row.querySelector<HTMLElement>('[data-fc-detail] > summary')??undefined;
      if(target.kind==='coverage')return row.querySelector<HTMLElement>('[data-fc-coverage]')??undefined;
      if(target.kind==='manual-nav'){
        const payload=target.value&&this.manualControls.get(target.value);if(!payload||!view.check||!this.manualValid(payload,view.check))return;
        const nodes=[...row.querySelectorAll<HTMLElement>('[data-fc-manual-nav]')].filter(n=>n.dataset.fcManualNav===target.value);return nodes.length===1?nodes[0]:undefined;
      }
      const items=view.check!.result!.files.find(f=>f.file_version_id===file.version)!.findings.filter(i=>i.id===target.finding?.id);
      if(items.length!==1||JSON.stringify(items[0])!==target.finding?.signature)return;
      const nodes=[...row.querySelectorAll<HTMLElement>('[data-fc-finding-id]')].filter(n=>n.dataset.fcFindingId===target.finding!.id);return nodes.length===1?nodes[0]:undefined;
    }
    if(target.kind==='nav')return;
    if(target.kind==='all')return this.selectionRange(view)===target.value?one('#fc-all'):undefined;
    if(target.kind==='show-all')return one('[data-fc-show-all]',n=>n.dataset.fcShowAll===target.value);
    if(target.kind==='facet')return one('[data-fc-filter]',n=>n.dataset.fcFilter===target.value);
    if(target.kind==='refresh')return one('[data-fc-refresh]',n=>!!n.closest('#fc-update-task')===(target.value==='update'));
    const selectors={search:'#fc-file-search','clear-search':'[data-fc-clear-search]','show-all':'[data-fc-show-all]',filter:'#fc-filter',history:'#fc-history','show-selected':'[data-fc-show-selected]','clear-selection':'[data-fc-clear-selection]',freshness:'[data-fc-freshness-detail] > summary',results:'#fc-results-heading',page:'#fc-page-heading',update:'#fc-update-task-heading'};
    return one(selectors[target.kind]);
  }
  private selectionRange(view:RenderedView){return JSON.stringify([...view.host.querySelectorAll<HTMLInputElement>('[data-fc-select]:not(:disabled)')].map(control=>control.dataset.fcSelect));}
  private restoreReading(snapshot:ReadingSnapshot|undefined,scrollOnly=false){
    const view=this.view;if(!snapshot||!view||(this.busy&&!scrollOnly)||this.checkRequest||this.pendingUpdate?.attempted||document.querySelector('dialog[open]'))return;
    if(snapshot.focus?.kind==='nav'){
      if(scrollOnly)return;
      const {href,label}=snapshot.focus,nodes=[...document.querySelectorAll<HTMLAnchorElement>('#sidebar a[href]')].filter(a=>a.getAttribute('href')===href&&a.textContent===label);
      if(nodes.length===1)nodes[0].focus({preventScroll:true});return;
    }
    if(snapshot.context!==view.context||snapshot.filter!==view.filter||snapshot.query!==view.query){
      if(!scrollOnly&&snapshot.focus?.kind==='manual-nav'){
        this.message='检查范围已变化，请重新选择需要核对的人工事项。';const status=view.host.querySelector('#fc-status');if(status)status.textContent=this.message;
        const heading=this.readingNode({kind:'results'})??this.readingNode({kind:'page'});if(heading&&this.displayed(heading))heading.focus({preventScroll:true});
      }
      return;
    }
    const anchor=snapshot.anchor&&this.readingNode(snapshot.anchor.target),focus=snapshot.focus;
    if(anchor&&this.displayed(anchor)&&Number.isFinite(snapshot.anchor!.top)){const delta=anchor.getBoundingClientRect().top-snapshot.anchor!.top;if(delta!==0)window.scrollBy(0,delta);}
    if(scrollOnly)return;
    if(!focus)return;
    let node=this.readingNode(focus);
    if(!node||node.matches(':disabled')||!this.displayed(node)){
      if(focus.kind==='manual-nav'){this.message='人工事项记录或可用位置已变化，请在此文件重新核对。';const status=view.host.querySelector('#fc-status');if(status)status.textContent=this.message;}
      node='file' in focus?this.readingNode({kind:'file',file:focus.file}):undefined;
    }
    node??=this.readingNode({kind:'results'})??this.readingNode({kind:'page'});
    if(node&&!node.matches(':disabled')&&this.displayed(node)){
      if(document.activeElement!==node)node.focus({preventScroll:true});
      if(focus.kind==='search'&&node instanceof HTMLInputElement&&focus.start!==null&&focus.end!==null)node.setSelectionRange(focus.start,focus.end,focus.direction??undefined);
    }
  }
  private captureDetails(){
    const view=this.view;if(!view?.host.isConnected||view.context!==this.detailsContext)return;
    view.host.querySelectorAll<HTMLDetailsElement>('[data-fc-detail]').forEach(d=>this.detailStates.set(d.dataset.fcDetail!,d.open));
    const freshness=view.host.querySelector<HTMLDetailsElement>('[data-fc-freshness-detail]');if(freshness)this.freshnessDetailOpen=freshness.open;
  }
  private originalVersion(c:ProjectFileCheck,version:string){
    const checked=c.files.filter(f=>f.file_version_id===version),results=c.result?.files.filter(f=>f.file_version_id===version)??[],versions=this.files.filter(f=>f.version_id===version);
    if(checked.length!==1||results.length!==1||versions.length!==1)return;
    const v=versions[0];return v.file_id===checked[0].file_id&&v.sequence===checked[0].sequence?v:undefined;
  }
  private fileHref(c:ProjectFileCheck,version:string){
    const files=c.files.filter(f=>f.file_version_id===version);if(files.length!==1)return '#/projects/'+encodeURIComponent(this.id)+'/files';
    return '#/projects/'+encodeURIComponent(this.id)+'/files?'+new URLSearchParams({file:files[0].file_id,version,check:c.run_id});
  }
  private originalStatus(key:string,message:string){
    if(!this.live())return;this.originalMessages.set(key,message);
    document.querySelectorAll<HTMLElement>('[data-fc-original-status]').forEach(n=>{if(n.dataset.fcOriginalStatus===key)n.textContent=message;});
  }
  private async pinnedOriginal(asset:ProjectFileAsset,expectedRun?:string|null){
    const pin=asset.pin;let bytes:Blob,filename:string;
    if(asset.kind==='material'){
      const p=asset.pin,m=await this.api.material(p.source_project_id,p.material_id,this.abort.signal,p.material_version);
      if(m.material_id!==p.material_id||m.material_version!==p.material_version||m.sha256!==p.sha256)throw new UserFacingError('原稿版本校验未通过，请重新读取记录后重试。');
      bytes=await this.api.materialBytes(p.source_project_id,m,this.abort.signal);filename=m.filename;
    }else{
      const p=asset.pin,a=await this.api.artifact(p.artifact_id,this.abort.signal);
      if(a.artifact_id!==p.artifact_id||a.version!==p.artifact_version||a.sha256!==p.sha256||expectedRun===null||expectedRun!==undefined&&a.run_id!==expectedRun)throw new UserFacingError('原稿版本校验未通过，请重新读取记录后重试。');
      const run=await this.api.run(a.run_id,this.abort.signal);
      if(run.run_id!==a.run_id||run.project_id!==pin.source_project_id||run.state!=='succeeded')throw new UserFacingError('原稿任务归属暂不可核对，请重新读取记录后重试。');
      bytes=await this.api.artifactBytes(a,this.abort.signal);filename=artifactFilename(a);
    }
    this.abort.signal.throwIfAborted();if(!this.live())return;this.downloads.save(bytes,filename);
  }
  private async downloadOriginal(c:ProjectFileCheck,button:HTMLButtonElement,version?:string){
    if(this.busy)return;const key=version?'file:'+c.run_id+':'+version:'source:'+c.run_id;let restoreFocus=false;
    await this.act(async()=>{
      this.originalStatus(key,'正在读取并核验原稿…');button.disabled=true;
      try{
        if(version){const v=this.originalVersion(c,version);if(!v)throw new UserFacingError('检查时原稿暂不可确认，请重新读取记录后重试。');await this.pinnedOriginal(v.asset,v.run_id);}
        else{if(c.source.project_id!==c.source.asset.pin.source_project_id)throw new UserFacingError('本轮募集书依据暂不可核对，请重新读取记录后重试。');await this.pinnedOriginal(c.source.asset);}
        if(!this.live())return;this.message=version?'检查时原稿已交给浏览器下载。':'本轮募集书依据已交给浏览器下载。';this.originalStatus(key,this.message);
      }catch(error){this.originalStatus(key,friendlyError(error,'download'));throw error;}
      finally{restoreFocus=document.activeElement===button;}
    },'正在读取并核验原稿…','download');
    if(this.live()&&restoreFocus){const controls=document.querySelectorAll<HTMLButtonElement>(version?'[data-fc-original]':'[data-fc-source-download]');[...controls].find(b=>!version||b.dataset.fcOriginal===version)?.focus({preventScroll:true});}
  }
  private pending(c:ProjectFileCheck,version:string){
    const accepted=new Set(c.updates.filter(u=>u.file_version_id===version&&u.state==='succeeded').flatMap(u=>u.issue_ids));
    return c.result?.files.find(f=>f.file_version_id===version)?.findings.filter(f=>f.kind==='conflict'&&f.replacement!==null&&!accepted.has(f.id))??[];
  }
  private blockReason(c:ProjectFileCheck,version:string){
    const checked=c.files.find(f=>f.file_version_id===version),latest=this.files.find(f=>f.file_id===checked?.file_id&&f.latest);
    if(!this.source)return '当前募集书暂不可读取，请返回项目文件核对。';
    if(c.stale||c.source.project_id!==this.source.project_id||c.source.version_id!==this.source.version_id||c.source.selection_revision!==this.source.selection_revision)return c.source.project_id===this.source.project_id&&c.source.version_id===this.source.version_id?'募集书采用记录已变化，请按当前依据重新核对。':'募集书已换稿，请按当前稿重新核对。';
    if(!latest)return '当前文件无法读取，请返回项目文件确认。';
    if(latest.version_id!==version&&!c.updates.some(u=>u.new_version_id===latest.version_id&&u.state==='succeeded'))return '这份文件在检查后已换版，请重新核对，保留你的新稿。';
    if(c.updates.some(u=>u.file_version_id===version&&(active.has(u.state)||['paused','awaiting_input'].includes(u.state))))return '这份文件已有更新任务，请先查看或继续原任务。';
    if(this.updates.some(b=>['queued','running','paused'].includes(b.state)))return '本项目已有一批文件更新，请先处理下方任务。';
    return '';
  }
  private blocked(c:ProjectFileCheck,version:string){return !!this.blockReason(c,version);}
  private freshness(c:ProjectFileCheck){
    const latest=this.files.filter(f=>f.latest),families=new Set(c.files.map(f=>f.file_id));
    const files:FileFreshness[]=c.files.map(checked=>{
      const candidates=latest.filter(f=>f.file_id===checked.file_id),current=candidates.length===1?candidates[0]:undefined;
      const state:FileFreshness['state']=!current?'missing':current.version_id===checked.file_version_id?'same':c.updates.some(u=>u.file_version_id===checked.file_version_id&&u.new_version_id===current.version_id&&u.state==='succeeded')?'delivered':'changed';
      return {checked,current,state};
    });
    const added=latest.filter(f=>!families.has(f.file_id)),sourceChanged=c.stale||!this.source||c.source.project_id!==this.source.project_id||c.source.version_id!==this.source.version_id||c.source.selection_revision!==this.source.selection_revision;
    return {files,added,sourceChanged,changed:sourceChanged||added.length>0||files.some(f=>f.state!=='same')};
  }
  private freshnessText(file:FileFreshness){
    const original='检查时 V'+file.checked.sequence;
    if(file.state==='missing')return original+'；原文件的当前版本暂不可读取，请回到项目文件核对。';
    if(file.state==='delivered')return '本轮已交付 V'+file.current!.sequence+'；此检查针对原 V'+file.checked.sequence+'，交付后的新稿未在本轮检查。';
    if(file.state==='changed')return '当前已保存 V'+file.current!.sequence+'；本轮检查针对原 V'+file.checked.sequence+'，不能作为当前新稿的检查结论。';
    return original+'，文件版本未变；募集书依据或采用记录已变化，旧结论不能代表当前依据。';
  }
  private freshnessHtml(c:ProjectFileCheck,scope:ReturnType<FileConsistency['freshness']>){
    if(!scope.changed)return '';
    const source=this.source,sourceMessage=!source?'当前募集书暂不可读取，请回到项目文件核对。':c.source.project_id===source.project_id&&c.source.version_id===source.version_id?'募集书采用记录已变化；即使文件仍是 V'+source.sequence+'，也需按当前采用记录重新核对。':'募集书依据已变化：本轮使用 '+c.source.filename+'（V'+c.source.sequence+'），当前为 '+source.filename+'（V'+source.sequence+'）。';
    const changes=scope.files.filter(f=>f.state!=='same'),counts=[['changed','份文件已换版'],['delivered','份已有本轮交付新稿'],['missing','份原文件的当前版本暂不可读']] as const;
    const summary=counts.map(([state,label])=>{const count=changes.filter(f=>f.state===state).length;return count?count+' '+label:'';}).filter(Boolean);if(scope.added.length)summary.push(scope.added.length+' 份新增文件未在本轮检查');
    const next=this.checkRequest?'原检查提交结果尚未确认，请先继续确认原请求和原范围；确认后再按当前文件重新检查。':this.pendingUpdate?.attempted?'原文件更新提交结果尚未确认，请先确认原更新；确认后再按当前文件重新检查。':source?'重新检查将使用当前募集书 '+source.filename+'（V'+source.sequence+'）及本项目全部 '+this.files.filter(f=>f.latest).length+' 份当前文件。':'请先确认当前募集书，再检查全部当前项目文件。';
    return `<section class="fc-freshness" aria-label="当前文件与本轮检查范围"><h2>当前范围需要重新核对</h2><p>本轮结论仅对应检查时固定的版本。当前有以下范围变化，需要重新核对的文件不能沿用旧结论。</p>${scope.sourceChanged?'<p class="fc-source-freshness">'+esc(sourceMessage)+'</p>':''}${summary.length?'<p class="fc-freshness-counts">'+esc(summary.join('；'))+'。</p>':''}<p>${esc(next)}只有明确确认后才会开始。${this.commerce?'主动检查按文件收费，开始前显示总价；有效已付范围复用。':'检查免费。'}</p>${changes.length||scope.added.length?`<details data-fc-freshness-detail ${this.freshnessDetailOpen?'open':''}><summary>查看文件范围变化（${changes.length+scope.added.length} 份）</summary><ul>${changes.map(f=>'<li data-fc-current-state="'+f.state+'"><strong>'+esc(f.checked.filename)+'</strong>：'+esc(this.freshnessText(f))+'</li>').join('')}${scope.added.map(f=>'<li data-fc-current-state="added"><strong>'+esc(f.filename)+'</strong> · 当前 V'+f.sequence+'，本轮未覆盖。</li>').join('')}</ul></details>`:''}<a class="text-button" href="#/projects/${encodeURIComponent(this.id)}/files">回到项目文件核对</a></section>`;
  }
  private batchItem(item:Updates['batches'][number]['items'][number]){
    const update=item.run_id?this.checks.flatMap(c=>c.updates).find(u=>u.run_id===item.run_id):undefined,state=update?.state;
    const running=!!state&&active.has(state),resumable=state==='paused'||state==='awaiting_input';
    const label=item.error??(state?runStateLabel[state as keyof typeof runStateLabel]??'任务状态待同步':item.run_id?'已提交后台处理':'等待前一份文件完成');
    return `<p>${esc(item.filename)} · ${esc(label)}${item.run_id&&(running||resumable)?` <button class="text-button" data-fc-control="${resumable?'resume':'pause'}" data-run="${esc(item.run_id)}">${resumable?'继续任务':'暂停任务'}</button> <button class="text-button" data-fc-control="cancel" data-run="${esc(item.run_id)}">结束任务</button>`:''}</p>`;
  }
  private updateOutput(target:UpdateTarget){
    if(target.update.state!=='succeeded'||!target.update.new_version_id)return;
    const files=this.files.filter(f=>f.version_id===target.update.new_version_id);if(files.length!==1)return;
    const file=files[0];return file.file_id===target.file.file_id&&file.run_id===target.run&&file.asset.kind==='artifact'&&file.revision_asset?.kind==='artifact'?file:undefined;
  }
  private updateTaskHtml(target:UpdateTarget|null){
    const refresh=`<button class="btn secondary" data-fc-refresh ${this.busy?'disabled':''}>重新读取记录</button>`;
    if(!target)return `<section class="panel fc-update" id="fc-update-task"><h2 id="fc-update-task-heading" tabindex="-1">指定的文件更新任务暂时无法读取</h2><p>${esc(this.historyReadError||'当前记录无法唯一对应原任务、原检查与原文件版本。')} 没有自动切换到其他任务或最近一轮。</p>${refresh} <button class="btn secondary" data-fc-latest>查看最近检查记录</button></section>`;
    const {run,update,file}=target,output=this.updateOutput(target),resumable=['paused','awaiting_input'].includes(update.state),running=active.has(update.state),disabled=this.busy||!!this.checkRequest||!!this.pendingUpdate?.attempted;
    const state=update.state==='failed'?'本次未完成':update.state==='rejected'?'本次未启动':runStateLabel[update.state as keyof typeof runStateLabel]??'任务状态待同步';
    const description=update.state==='failed'?'本次更新未完成；当前记录未提供失败原因。已保存的原文件与此前成果保留。':update.state==='rejected'?'本次更新未启动；当前记录未提供未启动原因。已保存的原文件与此前成果保留。':update.state==='succeeded'?output?'本次交付 V'+output.sequence+'；以下双稿仅来自这次更新任务。':'任务已完成，原任务的交付文件尚待同步；暂不提供其他更新或重试的成果。':resumable?'本次更新尚未完成，已保存的输入和进度保留，可继续原任务。':'此处仅显示这次更新任务的状态；下方文件行汇总整轮检查中的更新与重试。';
    return `<section class="panel fc-update" id="fc-update-task" data-fc-update-run="${esc(run)}" data-fc-update-file-version="${esc(file.file_version_id)}"><h2 id="fc-update-task-heading" tabindex="-1">原文件更新任务</h2><p><strong>${esc(file.filename)}</strong> · 原 V${file.sequence}</p><p id="fc-update-task-state">${esc(state)}</p><p>${esc(description)}</p>${output?`<div class="fc-downloads"><span>本次交付 V${output.sequence}</span><button class="btn secondary" data-fc-download="${esc(output.version_id)}" data-fc-update-download="${esc(run)}" data-variant="revision">下载本次修订版</button><button class="btn secondary" data-fc-download="${esc(output.version_id)}" data-fc-update-download="${esc(run)}" data-variant="clean">下载本次清洁版</button></div>`:''}${running||resumable?`<button class="btn secondary" data-fc-control="${resumable?'resume':'pause'}" data-run="${esc(run)}" ${disabled?'disabled':''}>${resumable?'继续原任务':'暂停原任务'}</button> <button class="btn secondary" data-fc-control="cancel" data-run="${esc(run)}" ${disabled?'disabled':''}>结束原任务</button> `:''}<button class="btn secondary" data-fc-locate-update ${this.busy?'disabled':''}>查看这份文件与检查依据</button> ${refresh}</section>`;
  }
  private updateKey(target:UpdateTarget){return target.run+'|'+target.check.run_id+'|'+target.file.file_version_id;}
  private locateUpdate(target:UpdateTarget){
    const row=[...document.querySelectorAll<HTMLElement>('[data-fc-result-version]')].find(r=>r.dataset.fcResultVersion===target.file.file_version_id);if(!row)return;
    const detail=row.querySelector<HTMLDetailsElement>('[data-fc-detail]');if(detail)detail.open=true;
    this.detailStates.set(target.file.file_version_id,true);
    this.locatedUpdate=this.updateKey(target);row.focus({preventScroll:true});row.scrollIntoView({block:'center'});
  }
  private paint(preserveReading=true,localOnly=false){
    if(!this.live())return;
    if(this.composingSearch&&document.querySelector('#fc-file-search')){this.deferredPaint=true;return;}
    this.deferredPaint=false;const reading=this.captureReading();this.captureDetails();this.manualControls.clear();
    const target=this.updateTarget(),c=this.selected(),context=this.readingContext(c),checking=!!c&&active.has(c.state),latest=this.files.filter(f=>f.latest),base=c?.source??this.source,scope=c?this.freshness(c):undefined;
    if(context!==this.detailsContext){this.detailsContext=context;this.detailStates.clear();this.freshnessDetailOpen=false;this.detailsRevealed=false;}
    if(c?.result&&!this.detailsRevealed){
      this.detailsRevealed=true;const values=new URLSearchParams(location.hash.split('?')[1]).getAll('file');
      if(values.length===1&&values[0]){const matches=c.files.filter(f=>f.file_id===values[0]||f.file_version_id===values[0]);if(matches.length===1&&this.readingFile(c,matches[0].file_version_id))this.detailStates.set(matches[0].file_version_id,true);}
    }
    const locate=!!target&&this.locatedUpdate!==this.updateKey(target)&&!this.busy&&!this.checkRequest&&!this.pendingUpdate?.attempted;if(locate){this.filter='all';this.query='';}
    if(!this.checkRequest&&!this.pendingUpdate?.attempted){if(this.selectionCheck&&this.selectionCheck!==c?.run_id){this.chosen.clear();this.needsCredits=false;}this.selectionCheck=c?.run_id;}
    const open=new Set([...this.detailStates].filter(([,opened])=>opened).map(([version])=>version));
    const source=base?`<div class="pf-source-strip fc-original-source">${ico('file')}<div><strong>${esc(base.filename)}</strong><small>${c?'本轮固定使用':'本项目正在使用'} · V${base.sequence} · ${esc(this.name)}</small></div><span class="pf-chip">${c?'本轮依据':'当前募集书'}</span>${c?'<button type="button" class="btn secondary" data-fc-source-download '+(this.busy?'disabled':'')+'>下载本轮募集书依据</button>':''}${c&&target===undefined?'<button type="button" class="text-button" data-fc-refresh '+(this.busy?'disabled':'')+'>重新读取记录</button>':''}</div>${c?'<p class="fc-original-status" role="status" data-fc-original-status="'+esc('source:'+c.run_id)+'">'+esc(this.originalMessages.get('source:'+c.run_id)??'')+'</p>':''}`:'';
    const start=`<button class="btn ${this.checkRequest||scope?.changed||!c?'primary':'secondary'}" data-fc-start ${this.busy||!!this.pendingUpdate?.attempted||!this.checkRequest&&(checking||!this.source||!latest.length)?'disabled':''}>${this.checkRequest?'重试确认原检查':scope?.changed?(this.commerce?'核对当前范围与费用':'按当前全部文件重新检查（免费）'):c?(this.commerce?'核对重新检查费用':'重新检查（免费）'):(this.commerce?'查看检查总价':'开始检查（免费）')}</button>`;
    const filesHref='#/projects/'+encodeURIComponent(this.id)+'/files',emptyAction=this.checkRequest?start:!this.source?start+' <a class="btn primary" href="'+filesHref+'">添加并采用募集书</a> <a class="btn secondary" href="'+filesHref+'">上传关联文件</a> <a class="btn secondary" href="#generate?project='+encodeURIComponent(this.id)+'">生成关联文件</a>':!latest.length?'<a class="btn primary" href="'+filesHref+'">上传已有项目文件</a>':start;
    const html=`<a class="back-link" href="#tasks">← 返回全部项目</a><div class="page-head"><div><div class="eyebrow">FILE CONSISTENCY</div><h1 id="fc-page-heading" tabindex="-1">${checking?'正在检查文件一致性':'文件一致性检查'}</h1><p>${esc(this.name)} · 核对关联文件与募集书，查看差异后选择是否生成修订版与清洁版。</p></div><a class="btn secondary" href="${filesHref}">返回项目文件</a></div>${source}
      <p id="fc-status" role="status">${esc(this.message)}</p>${this.pendingUpdate?.attempted?'<section class="fc-warning"><p>上次更新提交结果尚未确认。请沿用原范围确认，避免重复创建批次。</p><button class="btn secondary" id="fc-pending-action" data-fc-confirm-pending>重试确认上次更新</button></section>':''}${this.needsCredits?`<p><a class="text-button" href="${esc(rechargeHref(this.id))}">${this.commerce?'查看余额与按需充值':'查看积分与充值'}</a> · 检查结果和选择保留，充值后需重新确认更新。</p>`:''}
      ${!this.source?'<div id="fc-prospectus"></div>':''}
      ${target!==undefined?this.updateTaskHtml(target):''}
      ${this.checks.length?`<div class="pf-section-head"><label>检查记录 <select id="fc-history">${!c?'<option value="" selected disabled>指定的检查记录不可读</option>':''}${this.checks.map(x=>`<option value="${esc(x.run_id)}" ${x.run_id===c?.run_id?'selected':''}>${x.run_id===this.linkedHistory?'链接指定记录 · ':''}${esc(date(x.created_at))} · ${esc(runStateLabel[x.state as keyof typeof runStateLabel]??x.state)}</option>`).join('')}</select></label>${start}</div>${this.linkedHistory?'<p class="fc-history-scope">已读取链接指定的历史检查；下拉列表另含最近 30 轮，不代表全部历史记录。</p>':''}`:''}
      ${c&&scope?this.freshnessHtml(c,scope):''}
      ${c&&this.historyReadError?'<p class="fc-warning" role="status">原检查读取未成功，当前显示上次读取的记录。'+esc(this.historyReadError)+'</p>':''}
      ${target===null?'':!c&&new URLSearchParams(location.hash.split('?')[1]).has('run')?`<section class="panel fc-empty"><h2>指定的检查记录暂时无法读取</h2><p>${esc(this.historyReadError||'检查链接不完整、无效或无法唯一对应记录。')} 没有自动切换到其他一轮。</p><button class="btn secondary" data-fc-refresh>重新读取原检查</button> <button class="btn secondary" data-fc-latest>查看最近检查记录</button>${start}</section>`:!c?`<section class="panel fc-empty"><h2>${!this.source?'请先添加募集说明书':!latest.length?'还没有可检查的关联文件':'准备检查项目文件'}</h2><p>${!this.source?'先回到项目文件保存募集书，并明确采用为当前依据；已有项目文件保留。':!latest.length?'已有 Word 或 PDF 可以直接上传到项目文件，无需重新生成。':'扫描项目每份关联文件的当前版本；历史版本保留。'}</p><p>本次范围：${latest.length} 份文件</p>${emptyAction} ${!latest.length&&this.source?'<a class="btn secondary" href="#generate?project='+this.id+'">生成关联文件</a>':''}</section>`:
        checking?`<section class="panel fc-progress"><span class="fc-spinner" aria-hidden="true"></span><h2>${c.stage==='queued'?'等待检查':c.stage?.includes('word')?'正在整理检查报告':'正在核对文件内容'}</h2><p>本轮已固定 ${c.files.length} 份关联文件，核对数据、期间、单位、发行安排和披露内容。</p><ol><li>固定募集书与文件版本</li><li>比对内容与原文依据</li><li>整理冲突位置和修改建议</li></ol><p>关闭页面后任务继续处理，完成后可返回查看。</p><button class="btn secondary" data-fc-control="pause" data-run="${c.run_id}">暂停检查</button></section>`:
        c.result?this.results(c,open):`<section class="panel fc-empty"><h2>${esc(runStateLabel[c.state as keyof typeof runStateLabel]??c.state)}</h2><p>本次检查尚未完成，已保存的输入与历史文件保留。</p>${['paused','awaiting_input'].includes(c.state)?`<button class="btn primary" data-fc-control="resume" data-run="${c.run_id}">继续检查</button> <button class="btn secondary" data-fc-control="cancel" data-run="${c.run_id}">结束检查</button>`:start}</section>`}
      ${this.updates.filter(b=>['queued','running','paused'].includes(b.state)).map(b=>`<section class="panel fc-update"><h2>${b.state==='paused'?'文件更新需要处理':'正在生成新版本'}</h2>${b.items.map(i=>this.batchItem(i)).join('')}${b.state==='paused'?`<button class="btn primary" data-fc-retry="${b.batch_id}">重试原批次未完成文件</button>`:''}<button class="btn secondary" data-fc-stop="${b.batch_id}">停止后续文件更新</button><p class="muted">已经启动的任务不会被批次停止按钮取消；可按任务当前状态单独处理，已生成版本保留。</p></section>`).join('')}`;
    const workspace=document.querySelector<HTMLElement>('#fc-workspace');
    if(localOnly&&workspace)workspace.innerHTML=html;else this.shell('<div id="fc-workspace">'+html+'</div>','projects');
    this.mountProspectus();
    document.querySelectorAll('[data-fc-start]').forEach(b=>b.addEventListener('click',()=>void this.act(async()=>{
      if(!this.checkRequest){
        const request:Dto<'ProjectFileCheckRequest'>={request_id:crypto.randomUUID(),expected_source_version_id:this.source!.version_id};
        if(this.commerce){
          const quote=await this.request<Dto<'ProjectFileCheckQuoteResponse'>>('POST','/checks/quote',request);
          const price={...quote,price_version:quote.price_version??undefined};
          if(!isCnyPrice(price))throw new ApiError(503,'BILLING_NOT_READY');
          if(!await confirmCnyTask('确认一致性检查费用',price,`${this.name} · 募集书 ${this.source!.filename} V${this.source!.sequence} · 本次固定 ${quote.file_version_ids.length} 份当前关联文件。相同有效范围已付结果复用，以本次报价为准。`))return;
          Object.assign(request,{price_version:quote.price_version,expected_points:quote.points,file_version_ids:quote.file_version_ids,...(quote.scope_quote_id?{scope_quote_id:quote.scope_quote_id}:{})});
        }
        this.checkRequest=request;
      }
      this.cache();let r:{run_id:string};
      try{r=await this.request<{run_id:string}>('POST','/checks',this.checkRequest);}
      catch(e){if(e instanceof ApiError&&e.status>=400&&e.status<500&&![408,429].includes(e.status)){this.checkRequest=undefined;this.cache();try{await this.reload();}catch{}}throw e;}
      this.checkRequest=undefined;this.cache();this.message='检查已提交，关闭页面后仍会继续处理。';
      history.replaceState(null,'',location.pathname+location.search+'#consistency?'+withProjectContext(new URLSearchParams({project:this.id,run:r.run_id})));await this.reload();
    })));
    const host=document.querySelector<HTMLElement>('#main');if(host)this.view={host,context,filter:this.filter,query:this.query,check:c};
    if(c)this.bindResults(c);
    document.querySelector('[data-fc-latest]')?.addEventListener('click',()=>{const q=new URLSearchParams(location.hash.split('?')[1]);q.delete('run');q.delete('update_run');q.delete('file');this.locatedUpdate=undefined;this.query='';history.replaceState(null,'',location.pathname+location.search+'#consistency?'+q);this.paint(false);this.schedule();});
    document.querySelector('#fc-history')?.addEventListener('change',e=>{if(!this.checkRequest&&!this.pendingUpdate?.attempted)this.chosen.clear();this.locatedUpdate=undefined;this.query='';history.replaceState(null,'',location.pathname+location.search+'#consistency?'+withProjectContext(new URLSearchParams({project:this.id,run:(e.target as HTMLSelectElement).value})));this.paint(false);document.querySelector<HTMLElement>('#fc-history')?.focus({preventScroll:true});this.schedule();});
    document.querySelector('[data-fc-refresh]')?.addEventListener('click',()=>void (async()=>{
      if(this.busy)return;this.busy=true;this.message='正在重新读取记录…';this.status();
      try{await this.reload(true);this.message=this.historyReadError?'原检查读取未成功，请重试。':'已重新读取任务与文件记录。';}catch(e){if(this.live())this.message='重新读取未成功，当前显示上次记录。'+friendlyError(e,'read');}finally{this.busy=false;if(this.live())this.paint();}
    })());
    document.querySelector('[data-fc-locate-update]')?.addEventListener('click',()=>{const target=this.updateTarget();if(!target||this.busy)return;this.filter='all';this.query='';this.locatedUpdate=this.updateKey(target);this.paint(false);this.locateUpdate(target);});
    document.querySelector('[data-fc-confirm-pending]')?.addEventListener('click',()=>this.confirmUpdate());
    if(c)document.querySelector<HTMLButtonElement>('[data-fc-source-download]')?.addEventListener('click',e=>void this.downloadOriginal(c,e.currentTarget as HTMLButtonElement));
    this.bindDownloads(document.querySelector('#fc-update-task'));
    document.querySelectorAll<HTMLButtonElement>('[data-fc-control]').forEach(b=>b.addEventListener('click',()=>void this.act(async()=>{await this.api.runAction(b.dataset.run!,b.dataset.fcControl as 'pause'|'resume'|'cancel',this.abort.signal);this.message='任务状态已更新。';await this.reload();},undefined,'action')));
    document.querySelectorAll<HTMLButtonElement>('[data-fc-retry]').forEach(b=>b.addEventListener('click',()=>void this.act(async()=>{await this.request('POST','/updates/'+b.dataset.fcRetry+'/retry');this.message='已重试未完成文件；已成功文件不会重复扣费。';await this.reload();})));
    document.querySelectorAll<HTMLButtonElement>('[data-fc-stop]').forEach(b=>b.addEventListener('click',()=>void this.act(async()=>{await this.request('POST','/updates/'+b.dataset.fcStop+'/cancel');this.message='后续文件更新已停止，已运行任务和成果保留。';await this.reload();},undefined,'action')));
    this.syncSelection(!localOnly);if(locate)this.locateUpdate(target!);else if(preserveReading)this.restoreReading(reading);
  }
  private bindResults(c:ProjectFileCheck){
    const host=document.querySelector<HTMLElement>('#fc-results-view');if(!host)return;
    host.querySelectorAll<HTMLButtonElement>('[data-fc-manual-nav]').forEach(b=>b.addEventListener('click',()=>this.navigateManual(b)));
    const input=host.querySelector<HTMLInputElement>('#fc-file-search');
    input?.addEventListener('compositionstart',()=>{this.composingSearch=true;});
    input?.addEventListener('compositionend',()=>{this.composingSearch=false;this.applySearch(input);});
    input?.addEventListener('input',event=>{if(!this.composingSearch&&!(event as InputEvent).isComposing)this.applySearch(input);});
    host.querySelector('[data-fc-clear-search]')?.addEventListener('click',()=>{this.query='';this.repaintResults();document.querySelector<HTMLInputElement>('#fc-file-search')?.focus({preventScroll:true});});
    host.querySelectorAll('[data-fc-show-all]').forEach(b=>b.addEventListener('click',()=>{this.query='';this.changeFilter('all',`[data-fc-show-all="${(b as HTMLElement).dataset.fcShowAll}"]`);}));
    document.querySelector('#fc-filter')?.addEventListener('change',e=>this.changeFilter((e.target as HTMLSelectElement).value));
    document.querySelectorAll<HTMLButtonElement>('[data-fc-filter]:not([data-fc-show-all])').forEach(b=>b.addEventListener('click',()=>this.changeFilter(b.dataset.fcFilter!,`[data-fc-filter="${b.dataset.fcFilter}"]`)));
    document.querySelector('[data-fc-show-selected]')?.addEventListener('click',()=>{this.query='';this.changeFilter('selected','[data-fc-show-selected]');});
    document.querySelector('[data-fc-clear-selection]')?.addEventListener('click',()=>{this.chosen.clear();this.paint(false);document.querySelector<HTMLElement>('#fc-filter')?.focus({preventScroll:true});});
    document.querySelectorAll<HTMLInputElement>('[data-fc-select]').forEach(b=>b.addEventListener('change',()=>{if(b.checked)this.chosen.add(b.dataset.fcSelect!);else this.chosen.delete(b.dataset.fcSelect!);this.selectionChanged(b.dataset.fcSelect!);}));
    document.querySelector('#fc-all')?.addEventListener('change',e=>{document.querySelectorAll<HTMLInputElement>('[data-fc-select]:not(:disabled)').forEach(b=>{b.checked=(e.target as HTMLInputElement).checked;if(b.checked)this.chosen.add(b.dataset.fcSelect!);else this.chosen.delete(b.dataset.fcSelect!);});this.selectionChanged();});
    document.querySelectorAll('#fc-accept,[data-fc-accept]').forEach(b=>b.addEventListener('click',()=>this.confirmUpdate(c!)));
    document.querySelectorAll<HTMLButtonElement>('[data-fc-file]').forEach(b=>b.addEventListener('click',()=>this.confirmUpdate(c!,b.dataset.fcFile)));
    host.querySelectorAll<HTMLButtonElement>('[data-fc-original]').forEach(b=>b.addEventListener('click',()=>void this.downloadOriginal(c,b,b.dataset.fcOriginal)));
    this.bindDownloads(host);
  }
  private applySearch(input:HTMLInputElement){
    if(!input.isConnected||!this.live())return;
    const value=input.value.slice(0,200),start=input.selectionStart,end=input.selectionEnd,direction=input.selectionDirection,top=input.getBoundingClientRect().top;
    input.value=value;
    if(value===this.query&&!this.deferredPaint)return;
    this.query=value;
    // A poll may adopt newer data during IME composition. Repaint the owned
    // workspace after committing; keep the shell and wallet mounted.
    if(this.deferredPaint)this.paint(false,true);else this.repaintResults();
    const next=document.querySelector<HTMLInputElement>('#fc-file-search');if(!next)return;
    next.focus({preventScroll:true});if(start!==null&&end!==null)next.setSelectionRange(start,end,direction??undefined);
    const delta=next.getBoundingClientRect().top-top;if(Number.isFinite(delta)&&delta!==0)window.scrollBy(0,delta);
  }
  private repaintResults(){
    const c=this.selected(),container=document.querySelector<HTMLElement>('#fc-results-view');
    if(!this.live()||!c?.result||!container||!this.view)return;
    this.captureDetails();this.manualControls.clear();
    const open=new Set([...this.detailStates].filter(([,opened])=>opened).map(([version])=>version));
    container.outerHTML=this.results(c,open);
    this.view={...this.view,context:this.readingContext(c),filter:this.filter,query:this.query,check:c};
    this.bindResults(c);this.syncSelection(false);
  }
  private bindDownloads(scope:Element|null){
    scope?.querySelectorAll<HTMLButtonElement>('[data-fc-download]').forEach(b=>b.addEventListener('click',()=>void this.act(async()=>{
      const files=this.files.filter(f=>f.version_id===b.dataset.fcDownload),target=this.updateTarget();
      if(files.length!==1||b.dataset.fcUpdateDownload&&(!target||target.run!==b.dataset.fcUpdateDownload||this.updateOutput(target)?.version_id!==b.dataset.fcDownload))throw new UserFacingError('原任务文件版本暂不可确认，请重新读取记录。');
      const f=files[0],asset=b.dataset.variant==='revision'?f.revision_asset:f.asset;
      if(asset?.kind!=='artifact')throw new UserFacingError('本次交付文件尚待同步，请重新读取记录。');const a=await this.api.artifact(asset.pin.artifact_id,this.abort.signal);
      if(a.artifact_id!==asset.pin.artifact_id||a.run_id!==f.run_id||a.version!==asset.pin.artifact_version||a.sha256!==asset.pin.sha256)throw new UserFacingError('文件版本校验未通过，请刷新。');
      const bytes=await this.api.artifactBytes(a,this.abort.signal);this.abort.signal.throwIfAborted();if(!this.live())return;
      this.downloads.save(bytes,artifactFilename(a));this.message='文件已交给浏览器下载。';
    },undefined,'download')));
  }
  private changeFilter(filter:string,focus='#fc-filter',persist=true){
    this.filter=filter;this.repaintResults();if(persist)this.cache();
    const target=document.querySelector<HTMLElement>(focus);
    (target&&!target.matches(':disabled')?target:document.querySelector<HTMLElement>('#fc-filter'))?.focus({preventScroll:true});
  }
  private selectionChanged(version?:string){
    if(this.filter!=='selected'){this.syncSelection();return;}
    const controls=[...document.querySelectorAll<HTMLInputElement>('[data-fc-select]')],index=controls.findIndex(control=>control.dataset.fcSelect===version);
    this.paint(false);
    const remaining=[...document.querySelectorAll<HTMLInputElement>('[data-fc-select]:not(:disabled)')];
    (remaining[Math.max(0,Math.min(index,remaining.length-1))]??document.querySelector<HTMLElement>('#fc-filter'))?.focus({preventScroll:true});
  }
  private isManual(i:ProjectFileFinding){return i.kind==='manual'||i.replacement===null;}
  private manualValid(nav:ManualNav,c:ProjectFileCheck){
    if(nav.context!==this.readingContext(c))return false;
    const file=this.readingFile(c,nav.file.version);if(!file||file.family!==nav.file.family||file.sequence!==nav.file.sequence)return false;
    if(JSON.stringify(c.files.find(f=>f.file_version_id===file.version))!==nav.checkedFileSignature)return false;
    const findings=c.result!.files.find(f=>f.file_version_id===file.version)!.findings,manual=findings.filter(i=>this.isManual(i));
    const exact=(identity:FindingIdentity|undefined)=>{if(!identity)return;const matches=findings.filter(i=>i.id===identity.id);return matches.length===1&&this.isManual(matches[0])&&JSON.stringify(matches[0])===identity.signature?matches[0]:undefined;};
    const origin=exact(nav.origin),target=exact(nav.target);
    if(nav.mode==='first')return !!target&&manual[0]===target&&!nav.origin;
    if(!origin)return false;if(nav.mode==='file')return !nav.target;
    return !!target&&manual[manual.indexOf(origin)+(nav.mode==='previous'?-1:1)]===target;
  }
  private manualButton(c:ProjectFileCheck,version:string,mode:ManualNav['mode'],label:string,origin?:ProjectFileFinding,target?:ProjectFileFinding){
    const file=this.readingFile(c,version),identity=(i:ProjectFileFinding|undefined)=>i?{id:i.id,signature:JSON.stringify(i)}:undefined;
    if(!file)return '<button type="button" class="text-button" data-fc-manual-mode="'+mode+'" disabled>'+esc(label)+'</button>';
    const payload:ManualNav={context:this.readingContext(c),file,checkedFileSignature:JSON.stringify(c.files.find(f=>f.file_version_id===version)),mode,origin:identity(origin),target:identity(target)},key=JSON.stringify(payload);
    let token=this.manualTokens.get(key);if(!token){token='m'+(this.manualTokens.size+1);this.manualTokens.set(key,token);}this.manualControls.set(token,payload);
    return '<button type="button" class="text-button" data-fc-manual-nav="'+token+'" data-fc-manual-mode="'+mode+'" data-fc-manual-origin="'+esc(origin?.id??'')+'" data-fc-manual-target="'+esc(target?.id??'')+'" '+(!this.manualValid(payload,c)||this.busy?'disabled':'')+'>'+esc(label)+'</button>';
  }
  private navigateManual(button:HTMLButtonElement){
    const view=this.view,c=this.selected(),nav=this.manualControls.get(button.dataset.fcManualNav??'');
    if(!this.live()||!view?.host.isConnected||!button.isConnected||!view.host.contains(button)||button.disabled||this.busy||document.querySelector('dialog[open]'))return;
    const file=nav&&this.readingNode({kind:'file',file:nav.file}),fallback=()=>{this.message='人工事项记录已变化，请在此文件重新核对。';this.status();if(file){file.focus({preventScroll:true});file.scrollIntoView({block:'start'});}};
    if(!nav||!c||view.context!==this.readingContext(c)||!this.manualValid(nav,c)){fallback();return;}
    if(!file){fallback();return;}
    let node:HTMLElement|undefined=file;
    if(nav.mode!=='file'){
      node=this.readingNode({kind:'finding',file:nav.file,finding:nav.target});if(!node){fallback();return;}
      const detail=file.querySelector<HTMLDetailsElement>('[data-fc-detail]');if(detail)detail.open=true;
    }
    node.focus({preventScroll:true});node.scrollIntoView({block:'start'});
  }
  private mountProspectus(){
    const host=document.querySelector<HTMLElement>('#fc-prospectus');
    if(!host){this.prospectus?.dispose();this.prospectus=undefined;this.prospectusHost=undefined;return;}
    // Keep a selected file and in-flight upload intact when check polling repaints the page.
    if(this.prospectusHost){host.replaceWith(this.prospectusHost);return;}
    this.prospectusHost=host;
    this.prospectus=new ProspectusPanel(this.api,this.id,host,async()=>{
      if(this.busy||this.checkRequest||this.pendingUpdate?.attempted)throw new UserFacingError('本次检查或更新结果尚未确认，请先核对原请求，再采用募集书。');
      return true;
    },async()=>{
      this.message='募集书采用请求已确认，正在重新读取当前依据。';await this.reload();
    },()=>{},'consistency',this.owner);
    const panel=this.prospectus;
    void panel.refresh().catch(e=>{if(this.live()&&this.prospectus===panel){
      host.innerHTML=`<section class="panel fc-empty"><p role="alert">募集说明书读取失败：${esc(friendlyError(e,'read'))}</p><button class="btn secondary" data-fc-source-retry>重试读取募集说明书</button></section>`;
      host.querySelector('[data-fc-source-retry]')!.addEventListener('click',()=>{panel.dispose();this.prospectus=undefined;this.prospectusHost=undefined;this.mountProspectus();});
    }});
  }
  private results(c:ProjectFileCheck,open:Set<string>){
    const manual=(f:NonNullable<ProjectFileCheck['result']>['files'][number])=>f.status==='manual'||f.findings.some(i=>this.isManual(i));
    const counts={conflict:0,consistent:0,manual:0,updated:0},state=(v:string)=>this.pending(c,v).length?'conflict':manual(c.result!.files.find(f=>f.file_version_id===v)!)?'manual':c.updates.some(u=>u.file_version_id===v&&u.state==='succeeded')?'updated':'consistent';
    const revised=(v:string)=>c.updates.some(u=>u.file_version_id===v&&u.state==='succeeded');
    c.result!.files.forEach(f=>{const status=state(f.file_version_id);if(status==='conflict'||status==='consistent')counts[status]++;if(manual(f))counts.manual++;if(revised(f.file_version_id))counts.updated++;});
    const labels={conflict:'不一致',consistent:'本轮未发现差异',manual:'需人工确认',updated:'已生成修订版'};
    const scope=this.freshness(c);
    const query=this.query.trim().toLocaleLowerCase(),visible=c.result!.files.filter(f=>{
      const checked=c.files.filter(file=>file.file_version_id===f.file_version_id);
      const matches=!query||checked.length===1&&checked[0].filename.toLocaleLowerCase().includes(query);
      return matches&&(this.filter==='all'||(this.filter==='selected'?this.chosen.has(f.file_version_id):this.filter==='manual'?manual(f):this.filter==='updated'?revised(f.file_version_id):state(f.file_version_id)===this.filter));
    });
    return `<div id="fc-results-view"><p class="fc-history-scope">以下统计与筛选只描述本轮检查时的 ${c.files.length} 份文件。同一文件可同时有差异、人工事项或已交付新稿；各类数量不相加。${this.updateTarget()?'下方为整轮检查汇总，包含其他更新与重试；原任务状态和本次交付见上方任务区。':''}${scope.changed?'当前新稿及新增文件的范围见上方提示。':''}</p><div class="fc-summary" aria-label="本轮检查时版本统计">${Object.entries(counts).map(([k,v])=>`<button type="button" data-fc-filter="${k}" aria-pressed="${this.filter===k}" aria-controls="fc-result-list"><span>${labels[k as keyof typeof labels]}</span><strong>${v}<small> 份文件</small></strong><small>查看这些文件</small></button>`).join('')}</div>
      <section class="panel fc-results"><div class="pf-section-head"><div><h2 id="fc-results-heading" tabindex="-1">${scope.changed?'本轮历史检查结果':'文件检查结果'}</h2><p>${this.commerce?'主动检查收费；同步按服务端逐份范围报价，复用有效已付同版本检查，避免重复收费。':'检查免费。每份更新 4,500 积分，'}生成全部可确认差异的修订版和清洁版；存疑内容保留批注，旧版保留。每份文件分别结算：成功交付后扣款，失败或取消的文件不扣费。检查范围内未发现差异不等于内容全部正确。</p></div><select id="fc-filter" aria-label="筛选文件状态"><option value="all" ${this.filter==='all'?'selected':''}>全部文件</option>${Object.entries(labels).map(([k,v])=>`<option value="${k}" ${this.filter===k?'selected':''}>${v}</option>`).join('')}<option value="selected" ${this.filter==='selected'?'selected':''}>已选文件</option></select></div>
      <div class="fc-file-search"><label for="fc-file-search">按本轮文件名查找</label><div><input type="search" id="fc-file-search" maxlength="200" autocomplete="off" value="${esc(this.query)}" aria-describedby="fc-file-search-help fc-file-search-count" aria-controls="fc-result-list" placeholder="输入文件名中的文字"/><button type="button" class="text-button" data-fc-clear-search ${!this.query?'disabled':''}>清除查找</button><button type="button" class="text-button" data-fc-show-all="toolbar">查看全部文件</button></div><p id="fc-file-search-help">只影响显示，不改变本轮检查范围或已选文件；按检查时的文件名查找。</p><p id="fc-file-search-count" data-fc-search-count role="status">当前显示 ${visible.length} 份 / 本轮 ${c.result!.files.length} 份文件${this.filter!=='all'?'（已叠加状态筛选）':''}。</p></div>
      <div class="fc-selection-toolbar" aria-label="本轮文件选择"><p data-fc-selection></p><div><button type="button" class="text-button" data-fc-show-selected>查看已选文件</button><button type="button" class="text-button" data-fc-clear-selection>清空选择</button><button type="button" class="btn primary" id="fc-accept-top" data-fc-accept disabled>更新所选文件</button></div></div>
      <label class="fc-select-all"><input type="checkbox" id="fc-all"/> 选择当前显示的可更新文件</label><div id="fc-result-list">
      ${visible.length?visible.map(f=>{
        const checked=c.files.find(x=>x.file_version_id===f.file_version_id)!,pending=this.pending(c,f.file_version_id),blocked=this.blocked(c,f.file_version_id),status=state(f.file_version_id);
        const updated=this.files.filter(x=>c.updates.some(u=>u.new_version_id===x.version_id&&u.file_version_id===f.file_version_id)).sort((a,b)=>b.sequence-a.sequence)[0],fresh=scope.files.find(x=>x.checked.file_version_id===f.file_version_id)!,historical=scope.sourceChanged||fresh.state!=='same',hasManual=manual(f);
        const manualItems=f.findings.filter(i=>this.isManual(i)),automaticItems=f.findings.filter(i=>!this.isManual(i)),duplicateManual=manualItems.some(i=>f.findings.filter(x=>x.id===i.id).length!==1);
        return `<article class="fc-file" tabindex="-1" data-fc-result-version="${esc(f.file_version_id)}"><div class="pf-template-row"><input type="checkbox" data-fc-select="${f.file_version_id}" aria-label="选择更新 ${esc(checked.filename)}" ${this.chosen.has(f.file_version_id)?'checked':''} ${!pending.length||blocked||this.busy?'disabled':''}/><span class="collection-file-icon">${ico('file')}</span><div><strong>${esc(checked.filename)}</strong><small>检查时 V${checked.sequence} · 基于募集书 V${c.source.sequence} · ${manualItems.length} 项需人工确认</small></div><span class="pf-chip ${historical||['conflict','manual'].includes(status)?'attention':''}">${historical?'原 V'+checked.sequence+' 结论：':''}${labels[status]}${pending.length?' · '+pending.length+' 处':''}</span>${pending.length?`<button class="btn primary" data-fc-file="${f.file_version_id}" ${blocked||this.busy||!!this.checkRequest||!!this.pendingUpdate?.attempted?'disabled':''}>${this.commerce?'核对本文件范围报价':'更新文件 · 4,500 积分'}</button>`:''}</div>
          ${historical?'<p class="fc-file-freshness" data-fc-current-state="'+fresh.state+'">'+esc(this.freshnessText(fresh))+'</p>':''}
          ${blocked&&(pending.length||this.chosen.has(f.file_version_id))?'<p class="muted">'+esc(this.blockReason(c,f.file_version_id))+'</p>':''}
          ${updated?`<div class="fc-downloads"><span>${this.updateTarget()?'本轮检查汇总成果 · ':''}已保存 V${updated.sequence}${this.updateTarget()?'（可能来自其他更新或重试）':''}</span><button class="btn secondary" data-fc-download="${updated.version_id}" data-variant="revision">下载修订版</button><button class="btn secondary" data-fc-download="${updated.version_id}" data-variant="clean">下载清洁版</button></div>`:''}
          <div class="fc-originals"><button type="button" class="text-button" data-fc-original="${esc(f.file_version_id)}" ${!this.originalVersion(c,f.file_version_id)||this.busy?'disabled':''}>下载检查时 V${checked.sequence}</button>${!hasManual?'<a class="text-button" href="'+esc(this.fileHref(c,f.file_version_id))+'">回到此文件核对</a>':''}</div><p class="fc-original-status" role="status" data-fc-original-status="${esc('file:'+c.run_id+':'+f.file_version_id)}">${esc(this.originalMessages.get('file:'+c.run_id+':'+f.file_version_id)??(!this.originalVersion(c,f.file_version_id)?'检查时原稿暂不可确认，请重新读取记录后核对。':''))}</p>
          ${hasManual?'<p class="fc-manual-next">下一步：下载原稿并核实原文依据；如需修改，在本地处理后，<a class="text-button" href="'+esc(this.fileHref(c,f.file_version_id))+'">'+(fresh.state==='same'?'回到此文件上传修改稿':'回到此文件核对当前稿')+'</a>，再重新申请检查，费用以当前范围报价为准。需人工确认的事项继续保留。</p>':''}
          ${manualItems.length?'<div class="fc-manual-entry">'+this.manualButton(c,f.file_version_id,'first','查看人工事项（'+manualItems.length+'）',undefined,manualItems[0])+'<span>逐项核实原文依据；阅读不会标记为已处理。</span></div>':''}
          ${hasManual&&!manualItems.length?'<p class="fc-warning" data-fc-manual-unavailable>本轮标记需人工核实，但未提供逐项信息。请结合原稿与核对范围确认。</p>':''}
          ${duplicateManual?'<p class="fc-warning" data-fc-manual-unavailable>部分人工事项的记录编号重复，相关定位暂不可用。请直接展开原文核对。</p>':''}
          <details data-fc-detail="${f.file_version_id}" ${open.has(f.file_version_id)?'open':''}><summary>查看冲突、原文依据及需补充事项（${f.findings.length}）</summary>
          <section data-fc-coverage="${esc(f.file_version_id)}" tabindex="-1"><h3>本轮核对范围与限制</h3><p>以下为本轮检查记录中的范围说明，需结合下方差异和人工事项核对。</p><p data-fc-coverage-text style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(f.coverage.trim()?f.coverage:'本轮记录未提供具体核对范围，请结合差异与人工事项逐项核实。')}</p></section>
          ${f.findings.length?[...automaticItems,...manualItems].map(i=>this.finding(i,f.file_version_id,pending.some(x=>x.id===i.id),blocked,manualItems.indexOf(i),manualItems,c)).join(''):hasManual?'':'<p>本轮已核对的内容未发现不一致。</p>'}</details></article>`;
      }).join(''):`<div class="fc-filter-empty"><p>${query?'没有同时符合文件名与当前状态的文件。可清除查找，或查看全部文件继续核对。':this.filter==='selected'?'当前没有已选文件。先查看全部文件，再选择需要更新的文件。':'本轮没有符合此分类的文件，可查看全部文件继续核对。'}</p><button type="button" class="text-button" data-fc-filter="all" data-fc-show-all="empty">查看全部文件</button></div>`}</div></section><footer class="pf-footer"><span id="fc-selection" role="status">尚未选择文件</span><button class="btn primary" id="fc-accept" disabled>更新所选文件</button></footer></div>`;
  }
  private finding(i:ProjectFileFinding,version:string,pending:boolean,blocked:boolean,manualIndex:number,manualItems:ProjectFileFinding[],c:ProjectFileCheck){
    return `<div class="fc-finding" tabindex="-1" data-fc-finding-id="${esc(i.id)}" ${manualIndex>=0?'data-fc-manual-item':''}>${manualIndex>=0?'<span class="fc-manual-position" data-fc-manual-position>人工事项 '+(manualIndex+1)+'/'+manualItems.length+'</span>':''}<label><strong>${esc(i.field||'披露内容')}${i.period?' · '+esc(i.period):''}${i.unit?' · '+esc(i.unit):''}</strong><span>${this.isManual(i)?'需人工确认':pending?'待更新':'已更新'}</span></label>
      <div class="fc-comparison"><section><h4>关联文件原文</h4><small>${esc(i.target_location)}</small><p>${esc(i.original)||'未能准确定位'}</p></section><section><h4>本轮募集书依据</h4><small>${esc(i.source_location)}</small><p>${esc(i.source_quote)||'缺少可核验依据'}</p></section></div><p><strong>说明：</strong>${esc(i.reason)}</p>
      ${i.replacement!==null?`<div class="fc-replacement"><strong>建议更新为</strong><p>${esc(i.replacement)}</p></div>`:'<p class="fc-warning">请补充相关材料或人工确认，此项不会自动修改。</p>'}
      ${manualIndex>=0?'<nav class="fc-manual-navigation" aria-label="人工事项 '+(manualIndex+1)+'/'+manualItems.length+' 的阅读操作">'+this.manualButton(c,version,'previous','上一项人工事项',i,manualItems[manualIndex-1])+this.manualButton(c,version,'next','下一项人工事项',i,manualItems[manualIndex+1])+this.manualButton(c,version,'file','返回此文件操作',i)+'</nav>':''}</div>`;
  }
  private syncSelection(persist=true){const c=this.selected(),available=[...document.querySelectorAll<HTMLInputElement>('[data-fc-select]:not(:disabled)')],visible=available.filter(x=>x.checked).length;
    const eligible=c?c.files.filter(f=>this.chosen.has(f.file_version_id)&&!this.blocked(c,f.file_version_id)&&this.pending(c,f.file_version_id).length):[],count=eligible.length;
    const selected=c?.files.filter(f=>this.chosen.has(f.file_version_id)).length??0;
    const displayed=new Set([...document.querySelectorAll<HTMLInputElement>('[data-fc-select]')].map(control=>control.dataset.fcSelect));
    const hidden=eligible.filter(file=>!displayed.has(file.file_version_id)).length;
    const amount=this.commerce?'确认范围后报价': (count*PROJECT_FILE_UPDATE_PRICE.points).toLocaleString('zh-CN')+' 积分';
    const text='已选择 '+count+' 份文件 · 共 '+amount+(hidden?'（含 '+hidden+' 份筛选外文件）':'')+(selected>count?'；另有 '+(selected-count)+' 份已选文件当前不可更新，未计入费用。':'');
    document.querySelectorAll('#fc-selection,[data-fc-selection]').forEach(s=>s.textContent=text);
    document.querySelectorAll<HTMLButtonElement>('#fc-accept,[data-fc-accept]').forEach(b=>b.disabled=!count||this.busy||!!this.checkRequest||!!this.pendingUpdate?.attempted);
    document.querySelectorAll<HTMLButtonElement>('[data-fc-show-selected],[data-fc-clear-selection]').forEach(b=>b.disabled=!selected||this.busy);
    const all=document.querySelector<HTMLInputElement>('#fc-all');if(all){all.checked=!!visible&&visible===available.length;all.indeterminate=visible>0&&visible<available.length;}if(persist)this.cache();}
  private closeDialog(){this.dialog?.close();this.dialog?.remove();this.dialog=undefined;}
  private confirmationBinding(pending:PendingUpdate):ConfirmationBinding{
    return {owner:this.owner,project:this.id,checkId:pending.checkId,body:pending.body,filenames:pending.filenames};
  }
  private confirmationContent(pending:PendingUpdate){
    const snapshot=restoreConfirmationSnapshot(pending.confirmation,this.confirmationBinding(pending));
    const identity=(label:string,value:unknown)=>'<dt>'+esc(label)+'</dt><dd>'+esc(typeof value==='string'?value:JSON.stringify(value))+'</dd>';
    const rows=snapshot?snapshot.files.map(file=>`<li data-confirm-version="${esc(file.versionId)}"><strong class="fc-confirm-filename">${esc(file.filename)}</strong><p><span class="fc-confirm-type">${esc(PROJECT_DOCUMENT_CATALOG.find(type=>type.id===file.documentType)?.name??'文种未确认')}</span> · <span class="fc-confirm-version">检查时 V${file.sequence}</span></p><p class="fc-confirm-counts">自动更新 ${file.automatic} 处 · ${file.manualUnlisted?'人工事项未提供逐项信息，继续保留':'人工 '+file.manual+' 项继续保留'}</p></li>`).join(''):
      pending.body.files.map((file,index)=>`<li data-confirm-version="${esc(file.file_version_id)}"><strong class="fc-confirm-filename">${esc(pending.filenames[index])}</strong><p>原文件版本编号可在下方核对，修改明细暂不可确认。</p></li>`).join('');
    const source=snapshot?`<section class="fc-confirm-source" aria-label="本次固定的募集书依据"><h3>依据这版募集书更新</h3><strong>${esc(snapshot.source.filename)}</strong><p>V${snapshot.source.sequence} · 采用记录 ${snapshot.source.selection_revision}</p><p>沿用本轮检查固定的版本。</p></section>`:
      '<p class="fc-confirm-unavailable" role="note">原确认的版本与修改明细无法完整恢复。以下保留原文件名、版本编号与费用，重试仍沿用原请求；请勿将当前页面的新稿视为本次依据。</p>';
    return `<p class="fc-confirm-project">${esc(snapshot?.projectName??this.name)}</p>${source}<h3>将更新的 ${pending.body.files.length} 份文件</h3><ul class="fc-confirm-files">${rows}</ul><p>更新范围：本轮检查中可确认的差异；需人工判断的内容保留批注。原稿保留，每份生成修订版和清洁版。</p><details class="fc-confirm-scope"><summary>核对完整版本编号与本次请求</summary><dl>${identity('检查编号',pending.checkId)}${identity('检查结果 hash',pending.body.expected_check_sha256)}${identity('请求编号',pending.body.request_id)}${snapshot?identity('募集书项目编号',snapshot.source.project_id)+identity('募集书版本编号',snapshot.source.version_id)+identity('募集书文件引用',snapshot.source.asset):''}${pending.body.files.map((file,index)=>identity('文件 '+(index+1)+' 版本编号',file.file_version_id)+(snapshot?identity('文件 '+(index+1)+' 文件族编号',snapshot.files[index].fileId)+identity('文件 '+(index+1)+' 原稿引用',snapshot.files[index].asset??'原稿引用未确认'):'')).join('')}</dl></details>`;
  }
  private confirmUpdate(c?:ProjectFileCheck,file?:string){if(this.busy)return;void this.act(()=>this.prepareUpdate(c,file));}
  private async prepareUpdate(c?:ProjectFileCheck,file?:string){
    if(this.checkRequest){this.message='请先重试确认上次检查结果，再提交文件更新。';this.status();return;}
    if(!this.pendingUpdate?.attempted){
      if(!c?.sha256)return;
      const files=c.files.filter(f=>!file||f.file_version_id===file).filter(f=>!this.blocked(c,f.file_version_id)&&this.pending(c,f.file_version_id).length&&(file||this.chosen.has(f.file_version_id)));
      if(!files.length){this.message='请先选择可更新的文件。';this.status();return;}
      const quote=this.commerce?await this.request<Dto<'ProjectFileUpdateQuoteResponse'>>('POST','/checks/'+encodeURIComponent(c.run_id)+'/updates/quote',{expected_check_sha256:c.sha256,files:files.map(f=>({file_version_id:f.file_version_id}))}):undefined;
      if(quote&&(scopeStatus(quote)!=='ready'||quote.items.some(item=>scopeStatus(item)!=='ready'))){this.closeDialog();const pending=document.createElement('dialog');this.dialog=pending;pending.className='pf-modal commerce-confirm';const blocked=quote.items.find(item=>scopeStatus(item)!=='ready')??quote;pending.innerHTML='<h2>'+esc(scopeStatusLabel(blocked))+'</h2>'+scopeLifecycleHtml(blocked)+'<button class="btn secondary" data-close>返回准备</button><button class="btn primary" id="fc-refresh-scope">刷新范围报价</button>';pending.querySelector('[data-close]')!.addEventListener('click',()=>this.closeDialog());pending.querySelector('#fc-refresh-scope')!.addEventListener('click',()=>{this.closeDialog();this.confirmUpdate(c,file);});document.body.append(pending);pending.showModal();return;}
      if(quote&&(quote.items.length!==files.length||files.some(f=>!quote.items.some(item=>item.file_version_id===f.file_version_id&&item.scope_quote_id))||quote.items.reduce((n,item)=>n+item.points,0)!==quote.points))throw new ApiError(0,'DATA_UNAVAILABLE');
      const priceVersion=quote?.items[0]?.price_version??(this.commerce?OUTCOME_PRICE_VERSION:PROJECT_FILE_UPDATE_PRICE.version);
      if(!isOutcomePriceVersion(priceVersion)&&priceVersion!==PROJECT_FILE_UPDATE_PRICE.version)throw new ApiError(0,'DATA_UNAVAILABLE');
      this.pendingUpdate={checkId:c.run_id,body:{request_id:crypto.randomUUID(),expected_check_sha256:c.sha256,price_version:priceVersion,expected_points:quote?.points??this.updateTotal(c,files),files:files.map(f=>({file_version_id:f.file_version_id,...(quote?{scope_quote_id:quote.items.find(item=>item.file_version_id===f.file_version_id)!.scope_quote_id!}:{})}))},filenames:files.map(f=>f.filename),attempted:false,...(quote?{quote}: {})};
      this.pendingUpdate.confirmation=createConfirmationSnapshot(this.confirmationBinding(this.pendingUpdate),c,this.files,files.map(f=>this.pending(c,f.file_version_id).length),this.name);
    }
    const pending=this.pendingUpdate;if(!pending)return;
    if(pending.quote?.items.every(isAutomaticCharge)){await this.submitUpdateRequest(pending);return;}
    this.closeDialog();const d=document.createElement('dialog');this.dialog=d;d.className='pf-modal fc-confirm';d.setAttribute('aria-labelledby','fc-confirm-heading');
    d.innerHTML=`<header><h2 id="fc-confirm-heading">确认更新这些文件</h2><button class="icon-btn" data-close aria-label="关闭费用确认">${ico('close')}</button></header><div class="fc-confirm-body" tabindex="0" aria-label="更新范围与版本明细">${this.confirmationContent(pending)}${pending.quote?pending.quote.items.map(item=>scopeLinesHtml(item)+scopeLifecycleHtml(item)).join(''):''}</div><footer><p class="fc-confirm-total">${isOutcomePriceVersion(pending.body.price_version)?`${pending.body.files.length} 份 · 本次总价 <strong>${cny(pending.body.expected_points)}</strong>`:`${pending.body.files.length} 份 × ${PROJECT_FILE_UPDATE_PRICE.points.toLocaleString('zh-CN')} 积分 = <strong>${pending.body.expected_points.toLocaleString('zh-CN')} 积分</strong>`}${isOutcomePriceVersion(pending.body.price_version)?'<small>已按服务端核实的各文件工作项报价合计；原范围修正与平台重试包含。</small>':''}</p><p>确认时需余额覆盖本批总额。每份分别结算，成功交付后扣费；失败或取消的文件不扣费。</p><p id="fc-confirm-status" role="status">${pending.attempted?'上次提交结果尚未确认。重试沿用同一份已确认请求，不创建新的重复批次。':''}</p><div class="pf-footer"><button class="btn secondary" data-close>返回调整</button><button class="btn primary" id="fc-confirm-update">${pending.attempted?'重试确认提交结果':'确认更新'}</button></div></footer>`;
    const dismiss=()=>{if(this.busy)return;this.closeDialog();if(!pending.attempted)this.pendingUpdate=undefined;};
    d.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',dismiss));d.addEventListener('cancel',e=>{e.preventDefault();dismiss();});d.querySelector('#fc-confirm-update')!.addEventListener('click',()=>void this.submitUpdate());document.body.append(d);if(pending.quote&&!pending.attempted)guardScopeExpiry(d,pending.quote.items,'#fc-confirm-update');d.showModal();
  }
  private async submitUpdate(){const pending=this.pendingUpdate;if(!pending)return;if(!pending.attempted&&pending.quote&&pending.quote.items.some(item=>scopeStatus(item)!=='ready')){this.message='报价已过期，未开始；选择与准备保留，请返回重新核对。';this.status();return;}await this.act(()=>this.submitUpdateRequest(pending));}
  private async submitUpdateRequest(pending:NonNullable<FileConsistency['pendingUpdate']>){
    pending.attempted=true;this.cache();this.dialog?.querySelectorAll<HTMLButtonElement>('button').forEach(b=>b.disabled=true);
    try{await this.request('POST','/checks/'+encodeURIComponent(pending.checkId)+'/updates',pending.body);}
    catch(e){
      if(e instanceof ApiError&&e.status>=400&&e.status<500&&![408,429].includes(e.status)){this.pendingUpdate=undefined;this.cache();this.needsCredits=e.code==='CREDITS_INSUFFICIENT';this.closeDialog();try{await this.reload();}catch{};}
      else {const status=this.dialog?.querySelector('#fc-confirm-status');if(status)status.textContent='提交结果尚未确认。请重试核对同一请求，避免重复更新。';}
      throw e;
    }finally{this.dialog?.querySelectorAll<HTMLButtonElement>('button').forEach(b=>b.disabled=false);}
    this.pendingUpdate=undefined;this.needsCredits=false;window.dispatchEvent(new Event('bondbuddy:credits-changed'));this.closeDialog();this.chosen.clear();this.cache();this.message='已提交所选文件更新。每份分别交付、分别结算；存疑事项保留，原稿保留。';await this.reload();
  }
}

