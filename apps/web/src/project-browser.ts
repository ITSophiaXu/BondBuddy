import { MARKET_LABELS, OFFERING_LABELS, M4_DOCUMENT_LABELS, type M4DocumentType, PROJECT_FIELD_LIMITS } from '@bondbuddy/contracts';
import { ApiClient, friendlyError, type Dto } from './api';
import { UserFacingError } from './user-facing-error';
import { esc, date } from './ui';
import { prototypeIcon as ico } from './prototype-design';
import { loadProjectCollection, taskHref, taskKinds,taskLabel, taskView, type ProjectItem, type ProjectTask } from './project-collection-model';
import './project-browser.css';
import { ReviewHistory } from './review-history';
import { refreshProjectTasks, type ProjectTaskRefreshBoundary } from './project-task-refresh';

const updatedDate=new Intl.DateTimeFormat('sv-SE',{year:'numeric',month:'2-digit',day:'2-digit'});
const updatedTime=new Intl.DateTimeFormat('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false});
const syncTime=new Intl.DateTimeFormat('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
const readingKey=(kind:string,...ids:string[])=>JSON.stringify([kind,...ids]);
type Reading={key:string;kind:'focus'|'anchor';top:number;root?:string;focusKey?:string};
type CollectionView={expanded:string[];results:string[];limit:number;tails:[string,ProjectTaskRefreshBoundary][];reading?:Reading};
// Same-tab preferences only; task/project content and authority always come from the API.
const collectionViews=new Map<string,CollectionView>();

export class ProjectBrowser {
  private items:ProjectItem[]=[];private loaded=false;private busy=false;private disposed=false;
  private controller=new AbortController();private timer?:ReturnType<typeof setTimeout>;private limit=30;
  private expanded=new Set<string>();private tasks=new Map<string,Dto<'ProjectTasksResponse'>>();private taskErrors=new Map<string,string>();private taskLoading=new Set<string>();
  private results=new Set<string>();
  private menu?:HTMLElement;private q='';private group='all';private archiveView='active';private legacyKind='';
  private menuProject?:string;private menuArchived=false;
  private taskSynced=new Map<string,string>();private lastSync?:string;private stale=false;private offline=!navigator.onLine;
  private taskReads=new Map<string,{promise:Promise<void>;refresh:boolean}>();
  private refreshPending=false;private pendingManual=false;
  private syncRendered=false;private syncProblem='';private hadSyncProblem=false;
  private restoring?:CollectionView;private interaction=0;
  private noteInteraction=()=>{this.interaction++;};
  private refreshOnReturn=()=>{if(this.live()&&document.visibilityState==='visible')void this.load();};
  private onOnline=()=>{if(this.live()){this.offline=false;this.refreshOnReturn();}};
  private onOffline=()=>{if(this.live()){this.offline=true;this.renderSync();}};
  private reviewHistory:ReviewHistory;
  constructor(private api:ApiClient,private shell:(html:string,section:string)=>void,private current:()=>boolean,private owner=''){this.reviewHistory=new ReviewHistory(api);}
  private live(){return !this.disposed&&this.current();}
  private viewKey(){return JSON.stringify([this.owner,this.q,this.group,this.archiveView,this.legacyKind]);}
  dispose(){
    if(this.owner&&this.loaded){collectionViews.set(this.viewKey(),{expanded:[...this.expanded],results:[...this.results],limit:this.limit,reading:this.captureReading(),tails:[...this.tasks].flatMap(([id,data])=>{const tail=data.items.at(-1);return tail?[[id,{run_id:tail.run_id,created_at:tail.created_at}] as [string,ProjectTaskRefreshBoundary]]:[];})});if(collectionViews.size>50)collectionViews.delete(collectionViews.keys().next().value!);}
    this.disposed=true;this.controller.abort();clearTimeout(this.timer);this.closeMenu();this.reviewHistory.dispose();document.removeEventListener('visibilitychange',this.refreshOnReturn);window.removeEventListener('online',this.onOnline);window.removeEventListener('offline',this.onOffline);
    for(const event of ['pointerdown','keydown','wheel','touchstart'])document.removeEventListener(event,this.noteInteraction);
  }
  async render(){
    const query=new URLSearchParams(location.hash.split('?')[1]);this.q=query.get('q')??'';this.group=query.get('group')??'all';this.archiveView=query.get('archive')??'active';this.legacyKind=query.get('kind')??'';
    this.restoring=this.owner?collectionViews.get(this.viewKey()):undefined;if(this.restoring){this.expanded=new Set(this.restoring.expanded);this.results=new Set(this.restoring.results);this.limit=this.restoring.limit;}
    this.shell(`<div class="page-head"><div><div class="eyebrow">TASKS & RESULTS</div><h1>任务进度与结果</h1><p>查看各项目的任务进度，打开与下载已完成的结果。</p></div><a class="btn secondary" href="#/new">${ico('plus')}新建项目</a></div>
      <section class="collection-panel" aria-labelledby="projects-title"><header class="collection-heading"><h2 id="projects-title">项目列表 <span id="project-count" class="collection-count">—</span></h2><div><span>按最近活动排序</span><button class="text-button" id="refresh-projects">刷新状态</button></div></header>
      <div class="collection-search">${ico('search')}<input id="project-search" type="search" maxlength="${PROJECT_FIELD_LIMITS.issuer}" placeholder="搜索项目名称或发行人" aria-label="搜索项目名称或发行人" value="${esc(this.q)}"/></div>
      <div class="collection-filters"><div aria-label="按项目任务状态筛选">${[['all','全部'],['attention','待处理'],['active','进行中'],['done','已完成']].map(([k,v])=>`<button class="collection-filter" data-group="${k}" aria-pressed="${this.group===k}">${v} <span data-count="${k}">—</span></button>`).join('')}</div><select id="project-archive" aria-label="项目范围"><option value="active">未归档项目</option><option value="archived">已归档项目</option><option value="all">全部项目</option></select></div>
      <p id="collection-error" class="collection-error" role="alert" hidden></p><p id="collection-status" role="status"></p><div id="project-list" aria-busy="true"><p class="collection-empty">正在同步项目与任务…</p></div>
      <footer class="collection-footer"><span id="list-count"></span><button class="btn secondary small" id="load-more" hidden>加载更多项目</button></footer></section>`,'projects');
    window.scrollTo(0,0);
    document.querySelector<HTMLSelectElement>('#project-archive')!.value=this.archiveView;
    const sync=document.createElement('p');sync.id='collection-sync';sync.className='collection-sync';sync.setAttribute('role','status');sync.setAttribute('aria-live','polite');document.querySelector('.collection-heading')!.after(sync);this.renderSync();
    document.querySelector('#refresh-projects')!.addEventListener('click',()=>void this.load(true));
    document.querySelector('#load-more')!.addEventListener('click',()=>{this.limit+=30;this.paint();});
    const search=document.querySelector<HTMLInputElement>('#project-search')!;let composing=false;
    search.addEventListener('compositionstart',()=>{composing=true;});search.addEventListener('compositionend',()=>{composing=false;this.filter();});
    search.addEventListener('input',()=>{if(!composing)this.filter();});
    document.querySelector('#project-archive')!.addEventListener('change',()=>this.filter());
    document.querySelectorAll<HTMLElement>('[data-group]').forEach(b=>b.addEventListener('click',()=>{this.group=b.dataset.group!;this.filter();}));
    document.addEventListener('visibilitychange',this.refreshOnReturn);window.addEventListener('online',this.onOnline);window.addEventListener('offline',this.onOffline);
    for(const event of ['pointerdown','keydown','wheel','touchstart'])document.addEventListener(event,this.noteInteraction,{passive:true});
    const interaction=this.interaction;await this.load();if(this.live()&&interaction===this.interaction)this.restoreReading(this.restoring?.reading,false);this.restoring=undefined;
  }
  private filter(){
    this.q=document.querySelector<HTMLInputElement>('#project-search')!.value;this.archiveView=document.querySelector<HTMLSelectElement>('#project-archive')!.value;this.limit=30;
    const q=new URLSearchParams();if(this.q)q.set('q',this.q);if(this.group!=='all')q.set('group',this.group);if(this.archiveView!=='active')q.set('archive',this.archiveView);
    this.legacyKind='';history.replaceState(null,'',location.pathname+location.search+'#tasks'+(q.size?'?'+q:''));this.paint();
  }
  private matches(p:ProjectItem,group:string){
    const s=p.task_summary;return group==='all'||group==='active'&&!!s?.active||group==='attention'&&!!s?.attention||group==='done'&&!!s?.completed;
  }
  private schedule(){clearTimeout(this.timer);if(this.live())this.timer=setTimeout(()=>{if(document.visibilityState==='visible')void this.load();else this.schedule();},30000);}
  private renderSync(){
    if(!this.live())return;const el=document.querySelector<HTMLElement>('#collection-sync');if(!el)return;
    const working=this.busy||this.taskLoading.size>0,problem=this.offline?'offline':this.stale?'list-error':this.taskErrors.size?'tasks:'+[...this.taskErrors.keys()].sort().join(','):'';
    const recovered=!problem&&!working&&this.hadSyncProblem,announce=!this.syncRendered||Boolean(problem&&problem!==this.syncProblem)||recovered;
    if(problem)this.hadSyncProblem=true;else if(recovered)this.hadSyncProblem=false;this.syncProblem=problem;this.syncRendered=true;
    el.setAttribute('aria-live',announce?'polite':'off');
    const last=this.lastSync?`列表上次同步 <time datetime="${esc(this.lastSync)}">${esc(syncTime.format(new Date(this.lastSync)))}</time>`:'尚未完成同步';
    const message=this.offline?`当前离线，${this.loaded?'保留上次结果，可继续查看已加载内容。':'连接恢复后将重新同步。'}`:working?'正在同步，已展开内容保持可读。':this.stale?'同步未成功，当前显示上次结果。':this.taskErrors.size?'部分任务未能更新，保留已展开记录，请在对应项目重试。':recovered?'已恢复同步，状态每 30 秒自动同步。':'状态每 30 秒自动同步。';
    el.innerHTML=`<span>${message}</span><span>${last}</span>`;el.dataset.state=this.offline?'offline':this.stale||this.taskErrors.size?'stale':working?'syncing':'current';
  }
  private async load(manual=false){
    if(!this.live())return;if(this.busy){this.refreshPending=true;this.pendingManual ||= manual;return;}if(this.offline&&!manual){if(!this.loaded){const list=document.querySelector<HTMLElement>('#project-list');if(list){list.setAttribute('aria-busy','false');list.innerHTML='<p class="collection-empty">当前离线。连接恢复后将读取项目与任务。</p>';}}this.renderSync();this.schedule();return;}this.busy=true;clearTimeout(this.timer);this.renderSync();
    const button=document.querySelector<HTMLButtonElement>('#refresh-projects')!;button.setAttribute('aria-disabled','true');document.querySelector('#project-list')!.setAttribute('aria-busy','true');
    try{
      const items=await loadProjectCollection(c=>this.api.projects(c,{archive:'all',limit:'100'},this.controller.signal),()=>!this.live());
      if(!items||!this.live())return;this.items=items;this.loaded=true;this.stale=false;this.lastSync=new Date().toISOString();this.offline=!navigator.onLine;document.querySelector<HTMLElement>('#collection-error')!.hidden=true;
      const ids=new Set(items.map(p=>p.project_id));this.expanded=new Set([...this.expanded].filter(id=>ids.has(id)));for(const map of [this.tasks,this.taskErrors,this.taskSynced])for(const id of map.keys())if(!ids.has(id))map.delete(id);
      this.paint();await Promise.allSettled([...this.expanded].map(id=>this.loadTasks(id,true)));
    }catch(error){if(this.live()){this.stale=true;const node=document.querySelector<HTMLElement>('#collection-error')!;node.hidden=false;node.textContent=(this.loaded?'刷新未成功，当前显示上次同步结果。':'项目与任务未能同步。')+friendlyError(error,'read');}}
    finally{if(this.live()){this.busy=false;button.setAttribute('aria-disabled','false');document.querySelector('#project-list')!.setAttribute('aria-busy','false');this.renderSync();if(this.refreshPending){const queuedManual=this.pendingManual;this.refreshPending=false;this.pendingManual=false;await this.load(queuedManual);}else this.schedule();}}
  }
  private paint(){
    if(!this.live()||!this.loaded)return;
    const reading=this.captureReading();
    const base=this.items.filter(p=>(this.archiveView==='all'||Boolean(p.archived_at)===(this.archiveView==='archived'))&&(!this.legacyKind||p.kind===this.legacyKind));
    for(const k of ['all','attention','active','done']){document.querySelector(`[data-count="${k}"]`)!.textContent=String(base.filter(p=>this.matches(p,k)).length);document.querySelector(`[data-group="${k}"]`)!.setAttribute('aria-pressed',String(this.group===k));}
    const q=this.q.trim().toLocaleLowerCase();const filtered=base.filter(p=>this.matches(p,this.group)&&(!q||(p.name+' '+(p.issuer_name??'')).toLocaleLowerCase().includes(q)));
    const readingRoot=reading?.root??this.restoring?.reading?.root,index=filtered.findIndex(p=>p.project_id===readingRoot);if(index>=this.limit)this.limit=Math.ceil((index+1)/30)*30;
    const visible=filtered.slice(0,this.limit);
    document.querySelector('#project-count')!.textContent=String(filtered.length);
    document.querySelector('#list-count')!.textContent=`显示 ${visible.length} / ${filtered.length} 个项目 · 状态自动同步`;
    document.querySelector<HTMLButtonElement>('#load-more')!.hidden=visible.length>=filtered.length;
    const list=document.querySelector<HTMLElement>('#project-list')!;
    list.innerHTML=visible.length?`<div class="collection-table-wrap"><table class="collection-table"><thead><tr><th scope="col">项目名称</th><th scope="col">任务概况</th><th scope="col">最近更新</th><th scope="col">任务与结果</th></tr></thead><tbody>${visible.map(p=>this.row(p)).join('')}</tbody></table></div>`:`<div class="collection-empty"><h3>${this.items.length?'没有找到匹配的项目':'还没有项目'}</h3><p>${this.items.length?'试试其他项目名称、发行人或任务状态。':'新建一个项目，开始准备募集书和项目文件。'}</p>${this.items.length?'<button class="btn secondary" id="clear-project-filters">清除筛选</button>':'<a class="btn primary" href="#/new">新建项目</a>'}</div>`;
    this.tagReadingTargets(list);
    list.querySelector('#clear-project-filters')?.addEventListener('click',()=>{document.querySelector<HTMLInputElement>('#project-search')!.value='';this.group='all';document.querySelector<HTMLSelectElement>('#project-archive')!.value='active';this.filter();});
    list.querySelectorAll<HTMLButtonElement>('[data-tasks]').forEach(b=>b.addEventListener('click',()=>{
      const id=b.dataset.tasks!;if(this.expanded.has(id)&&!this.results.has(id))this.expanded.delete(id);else this.expanded.add(id);this.results.delete(id);this.paint();if(this.expanded.has(id))void this.loadTasks(id,!this.tasks.has(id));
    }));
    list.querySelectorAll<HTMLButtonElement>('[data-results]').forEach(b=>b.addEventListener('click',()=>void this.showResults(b.dataset.results!)));
    list.querySelectorAll<HTMLButtonElement>('[data-task-view]').forEach(b=>b.addEventListener('click',()=>{const id=b.dataset.root!;if(b.dataset.taskView==='results')void this.showResults(id);else{this.results.delete(id);this.paint();}}));
    list.querySelectorAll<HTMLButtonElement>('[data-work]').forEach(b=>b.addEventListener('click',()=>this.openMenu(b,this.items.find(p=>p.project_id===b.dataset.work)!)));
    list.querySelectorAll<HTMLButtonElement>('[data-task-more]').forEach(b=>b.addEventListener('click',()=>void this.loadTasks(b.dataset.taskMore!,false)));
    list.querySelectorAll<HTMLButtonElement>('[data-task-retry]').forEach(b=>b.addEventListener('click',async()=>{const id=b.dataset.taskRetry!;await this.loadTasks(id,true);if(this.live()&&this.results.has(id))void this.showResults(id);}));
    list.querySelectorAll<HTMLButtonElement>('[data-review-history]').forEach(b=>b.addEventListener('click',()=>{
      void this.reviewHistory.open(b.dataset.reviewHistory!,this.items.find(p=>p.project_id===b.dataset.root)?.name??'项目');
      document.querySelector<HTMLDialogElement>('.review-history-dialog[open]')?.addEventListener('close',()=>{if(this.live())(this.findFocus(b.dataset.collectionFocus!)??document.querySelector<HTMLElement>('#project-search'))?.focus({preventScroll:true});},{once:true});
    }));
    this.restoreReading(reading,true);this.positionMenu();
  }
  private findFocus(key:string){return [...document.querySelectorAll<HTMLElement>('#project-list [data-collection-focus]')].find(el=>el.dataset.collectionFocus===key);}
  private tagReadingTargets(list:HTMLElement){
    const focus=(node:HTMLElement|null,key:string)=>{if(node)node.dataset.collectionFocus=key;};
    list.querySelectorAll<HTMLElement>('[data-project-id]').forEach(row=>{
      const root=row.dataset.projectId!;row.dataset.collectionAnchor=readingKey('project',root);
      for(const [selector,action] of [['.collection-title','title'],['.collection-result','result'],['[data-tasks]','tasks'],['[data-work]','work']])focus(row.querySelector(selector),readingKey(action,root));
    });
    list.querySelectorAll<HTMLElement>('[data-task-panel]').forEach(panel=>{
      const root=panel.dataset.taskPanel!;const header=panel.querySelector<HTMLElement>('header');if(header)header.dataset.collectionAnchor=readingKey('task-heading',root);
      panel.querySelectorAll<HTMLElement>('[data-run-id]').forEach(row=>{const task=this.tasks.get(root)?.items.find(t=>t.run_id===row.dataset.runId);if(!task)return;const key=readingKey('task',root,task.project_id,task.run_id);row.dataset.collectionAnchor=key;focus(row.querySelector('a'),key);});
      panel.querySelectorAll<HTMLElement>('[data-review-history]').forEach(button=>focus(button,readingKey('history',root,button.dataset.reviewHistory!)));
      panel.querySelectorAll<HTMLElement>('[data-task-view]').forEach(button=>focus(button,readingKey('view',root,button.dataset.taskView!)));
      for(const [selector,action] of [['[data-task-more]','more'],['[data-task-retry]','retry'],['.collection-draft a','prepare']])focus(panel.querySelector(selector),readingKey(action,root));
    });
  }
  private captureReading():Reading|undefined{
    if(document.querySelector('dialog[open]'))return;
    const list=document.querySelector<HTMLElement>('#project-list');if(!list)return;
    const active=document.activeElement as HTMLElement|null;
    const focused=active&&list.contains(active)?active.closest<HTMLElement>('[data-collection-focus]'):undefined;
    const visible=(el:HTMLElement)=>{const rect=el.getBoundingClientRect();return rect.height>0&&rect.bottom>0&&rect.top<innerHeight;};
    const menuTrigger=this.menuProject?this.findFocus(readingKey('work',this.menuProject)):undefined;
    const target=focused&&visible(focused)?focused:menuTrigger&&visible(menuTrigger)?menuTrigger:[...list.querySelectorAll<HTMLElement>('[data-collection-anchor]')].find(visible);
    if(!target)return;const kind=target===focused?'focus':'anchor';
    return {key:kind==='focus'?target.dataset.collectionFocus!:target.dataset.collectionAnchor??target.dataset.collectionFocus!,kind,top:target.getBoundingClientRect().top,root:target.closest<HTMLElement>('[data-project-id]')?.dataset.projectId??target.closest<HTMLElement>('[data-task-panel]')?.dataset.taskPanel,focusKey:focused?.dataset.collectionFocus};
  }
  private restoreReading(reading:Reading|undefined,restoreFocus:boolean){
    if(!reading||!this.live()||document.querySelector('dialog[open]'))return;
    const target=reading.kind==='focus'?this.findFocus(reading.key):[...document.querySelectorAll<HTMLElement>('#project-list [data-collection-anchor],#project-list [data-collection-focus]')].find(el=>el.dataset.collectionAnchor===reading.key||el.dataset.collectionFocus===reading.key);
    const fallback=reading.root?this.findFocus(readingKey('tasks',reading.root)):undefined;
    const anchor=target?.getBoundingClientRect().height?target:fallback;
    if(anchor)window.scrollBy(0,anchor.getBoundingClientRect().top-reading.top);
    if(restoreFocus&&(reading.kind==='focus'||reading.focusKey))(this.findFocus(reading.focusKey??reading.key)??fallback??document.querySelector<HTMLElement>('#project-search'))?.focus({preventScroll:true});
  }
  private row(p:ProjectItem){
    const s=p.task_summary,latest=s?.latest,opened=this.expanded.has(p.project_id),href='#/projects/'+encodeURIComponent(p.project_id)+'/files';
    // recent_result includes failures and cancellations; only actual results get a direct link.
    const result=[latest,s?.recent_result].find((task):task is ProjectTask=>!!task&&this.hasResult(task));
    const recent=latest?taskLabel(latest)+' · '+taskView(latest).label:'尚未开始任务';
    const resultClass=`btn ${s?.active?'secondary':'primary'} small collection-result`;
    const resultAction=result?`<a class="${resultClass}" href="${esc(taskHref(result))}" title="${esc(taskLabel(result)+' · '+date(result.created_at))}">${ico('file')}查看结果</a>`:s?.completed?`<button class="${resultClass}" data-results="${esc(p.project_id)}" aria-expanded="${opened&&this.results.has(p.project_id)}" aria-controls="tasks-${esc(p.project_id)}">${ico('file')}查看结果</button>`:'<button class="btn secondary small collection-result" disabled>暂无结果</button>';
    return `<tr class="collection-project" data-project-id="${esc(p.project_id)}"><td><a class="collection-title" href="${href}">${esc(p.name)}</a><small class="collection-issuer">${esc(p.issuer_name||'发行人待填写')}</small><span class="collection-market">${p.market?esc(MARKET_LABELS[p.market]):'市场待填写'}${p.offering?' · '+esc(OFFERING_LABELS[p.offering]):''}</span></td>
      <td class="collection-task-cell"><div class="collection-task-summary">${s?.active?`<span class="task-active">${s.active} 项进行中</span>`:''}${s?.attention?`<span class="task-attention">${s.attention} 项待处理</span>`:''}${s?.completed?`<span class="task-done">${s.completed} 项已完成</span>`:''}</div><small class="collection-recent">${esc(recent)}</small>${result&&result.run_id!==latest?.run_id?`<small class="collection-recent">最近结果：${esc(taskLabel(result))}</small>`:''}</td>
      <td class="collection-updated"><time datetime="${esc(p.updated_at)}" title="${esc(date(p.updated_at))}"><span>${esc(updatedDate.format(new Date(p.updated_at)))}</span><span>${esc(updatedTime.format(new Date(p.updated_at)))}</span></time>${p.archived_at?'<small>已归档</small>':''}</td>
      <td><div class="collection-actions"><button class="btn ${s?.active?'primary':'secondary'} small" data-tasks="${esc(p.project_id)}" aria-expanded="${opened}" aria-controls="tasks-${esc(p.project_id)}">${ico('clock')}${s?.active?'查看进度':'查看任务'} ${ico('down')}</button>${resultAction}<button class="text-button collection-more" data-work="${esc(p.project_id)}" aria-label="更多操作 · ${esc(p.name)}" aria-haspopup="menu" aria-expanded="false">更多 ${ico('down')}</button></div></td></tr>
      <tr id="tasks-${esc(p.project_id)}" class="collection-task-row" ${opened?'':'hidden'}><td colspan="4"><div class="collection-tasks" data-task-panel="${esc(p.project_id)}">${this.taskPanel(p)}</div></td></tr>`;
  }
  private hasResult(t:ProjectTask){return t.state==='succeeded'||(t.workpaper_batch?.completed??0)>0;}
  private async showResults(id:string){
    this.results.add(id);this.expanded.add(id);this.paint();
    if(!this.tasks.has(id))await this.loadTasks(id,true);
    // A recent failure must not bury an earlier result behind several pages of failed tasks.
    const seen=new Set<string>();
    while(this.live()&&this.expanded.has(id)&&this.results.has(id)&&!this.taskErrors.has(id)){
      const data=this.tasks.get(id);if(!data?.page.has_more||data.items.some(t=>this.hasResult(t)))break;
      const cursor=data.page.next_cursor;if(!cursor||seen.has(cursor)){this.taskErrors.set(id,'任务记录未能完整读取，请重试。');this.paint();this.renderSync();break;}seen.add(cursor);
      await this.loadTasks(id,false);
    }
  }
  private taskPanel(p:ProjectItem){
    const id=p.project_id,data=this.tasks.get(id),error=this.taskErrors.get(id),synced=this.taskSynced.get(id),loading=this.taskLoading.has(id);
    const results=this.results.has(id),items=data?.items.filter(t=>!results||this.hasResult(t));
    const preparation=p.kind==='generation'?'generate':p.kind==='qa'?'qa':p.kind==='review'?'review':'update';
    return `<header><h3>任务记录与结果</h3><span>按提交时间排序 · 关闭页面后任务仍会继续</span></header><div class="collection-task-views" role="group" aria-label="任务记录范围">${[['all','全部任务'],['results','已有结果']].map(([view,label])=>`<button class="collection-filter" data-task-view="${view}" data-root="${esc(id)}" aria-pressed="${results===(view==='results')}">${label}</button>`).join('')}</div><p class="collection-task-sync collection-muted" data-task-sync="${esc(id)}" role="status" aria-live="off">${loading?'正在读取任务，已加载内容保持可读。':error?'任务同步未成功，保留上次结果。':''}${synced?`任务上次同步 <time datetime="${esc(synced)}">${esc(syncTime.format(new Date(synced)))}</time>`:''}</p>${error?`<p role="alert">${esc(error)} <button class="text-button" data-task-retry="${esc(id)}" aria-disabled="${loading}">重试</button></p>`:''}${data?items?.length?items.map(t=>this.taskRow(t)).join(''):results?`<p class="collection-muted">${data.page.has_more?'当前记录中暂无结果，可加载更早任务查看。':'暂无可查看的结果。'}</p>`:`<div class="collection-draft"><span>项目已保存，尚未开始任务。</span><a class="text-button" href="#${preparation}?project=${encodeURIComponent(id)}&from=projects">继续准备材料 ${ico('chevron')}</a></div>`:'<p role="status">正在读取任务…</p>'}
      ${[...new Set([...(p.kind==='review'?[id]:[]),...(data?.items.filter(t=>t.kind==='review').map(t=>t.project_id)??[])])].map(reviewId=>`<button class="text-button" data-review-history="${esc(reviewId)}" data-root="${esc(id)}">复核版本记录</button>`).join('')}
      ${data?.page.has_more?`<button class="text-button" data-task-more="${esc(id)}" aria-disabled="${loading}">加载更早任务</button>`:''}`;
  }
  private taskRow(t:ProjectTask){
    const view=taskView(t);const label=t.document_type&&M4_DOCUMENT_LABELS[t.document_type as M4DocumentType]||taskLabel(t);
    return `<article class="collection-task" data-run-id="${esc(t.run_id)}"><div><strong>${esc(label)}${t.operation==='revision'?' · 修订导出':''}</strong><time>${esc(date(t.created_at))}</time></div><div><span class="collection-state ${view.tone}">${view.label}</span><small>${esc(view.detail)}</small></div><a class="btn ${this.hasResult(t)?'primary':'secondary'} small" href="${taskHref(t)}">${this.hasResult(t)?'查看结果':view.action} ${ico('chevron')}</a></article>`;
  }
  private async loadTasks(id:string,reset:boolean){
    if(!this.live()||!this.items.some(p=>p.project_id===id))return;
    const pending=this.taskReads.get(id);if(pending){if(reset)pending.refresh=true;return pending.promise;}
    const job={promise:Promise.resolve(),refresh:reset};this.taskReads.set(id,job);
    job.promise=(async()=>{do{const refresh=job.refresh;job.refresh=false;await this.readTasks(id,refresh);}while(job.refresh&&this.live()&&this.items.some(p=>p.project_id===id));})();
    try{await job.promise;}finally{if(this.taskReads.get(id)===job)this.taskReads.delete(id);}
  }
  private async readTasks(id:string,reset:boolean){
    const existing=this.tasks.get(id);if(!reset&&existing&&!existing.page.has_more)return;
    const valid=()=>this.live()&&this.items.some(p=>p.project_id===id);
    this.taskLoading.add(id);this.taskErrors.delete(id);this.paint();this.renderSync();
    try{
      const boundary=this.restoring?.tails.find(([root])=>root===id)?.[1];
      const data=await refreshProjectTasks(id,reset?existing:undefined,cursor=>this.api.projectTasks(id,reset?cursor:existing?.page.next_cursor??cursor,this.controller.signal),()=>!valid(),reset?boundary:undefined);
      if(!data||!valid())return;
      if(!reset&&existing){
        for(const task of data.items){const old=existing.items.find(t=>t.run_id===task.run_id);if(old&&(old.project_id!==task.project_id||Date.parse(old.created_at)!==Date.parse(task.created_at)))throw new UserFacingError('任务信息发生变化，请刷新后重试。');}
        this.tasks.set(id,{...data,items:[...new Map([...existing.items,...data.items].map(t=>[t.run_id,t])).values()]});
      }else this.tasks.set(id,data);
      if(reset||!existing)this.taskSynced.set(id,new Date().toISOString());
    }catch(error){if(valid())this.taskErrors.set(id,friendlyError(error,'read'));}
    finally{this.taskLoading.delete(id);if(this.live()){this.paint();this.renderSync();}}
  }
  private closeMenu(){
    const menu=this.menu,root=this.menuProject;this.menu=undefined;this.menuProject=undefined;
    if(menu){if(menu.matches(':popover-open'))menu.hidePopover();menu.remove();}
    if(root)this.findFocus(readingKey('work',root))?.setAttribute('aria-expanded','false');
  }
  private positionMenu(){
    if(!this.menu||!this.menuProject)return;const item=this.items.find(p=>p.project_id===this.menuProject),button=this.findFocus(readingKey('work',this.menuProject));
    if(!button||!item||Boolean(item.archived_at)!==this.menuArchived){const focused=this.menu.contains(document.activeElement);this.closeMenu();document.querySelector('#collection-status')!.textContent='项目状态或筛选范围已变化，请从当前项目重新选择操作。';if(focused)(button??document.querySelector<HTMLElement>('#project-search'))?.focus({preventScroll:true});return;}
    button.setAttribute('aria-expanded','true');const rect=button.getBoundingClientRect(),menu=this.menu;menu.style.left=Math.max(12,Math.min(rect.right-menu.offsetWidth,innerWidth-menu.offsetWidth-12))+'px';menu.style.top=Math.max(12,rect.bottom+menu.offsetHeight+8>innerHeight?rect.top-menu.offsetHeight-8:rect.bottom+8)+'px';
  }
  private openMenu(button:HTMLButtonElement,p:ProjectItem){
    this.closeMenu();const menu=document.createElement('div');this.menu=menu;this.menuProject=p.project_id;this.menuArchived=Boolean(p.archived_at);menu.className='collection-menu';menu.setAttribute('popover','auto');menu.setAttribute('role','menu');menu.setAttribute('aria-label',p.name+' · 项目操作');
    menu.innerHTML=`<a role="menuitem" href="#/projects/${encodeURIComponent(p.project_id)}/files">项目文件${ico('folder')}</a><a role="menuitem" href="#consistency?project=${encodeURIComponent(p.project_id)}">检查文件一致性${ico('chevron')}</a>${p.archived_at?'':`<div class="collection-menu-label" role="presentation">开始工作</div>`+[['update','更新募集书'],['review','复核募集书'],['generate','文件生成'],['integrity','诚信核查'],['qa','项目问答']].map(([route,label])=>`<a role="menuitem" href="#${route}?project=${encodeURIComponent(p.project_id)}&from=projects">${label}${ico('chevron')}</a>`).join('')}<div class="collection-menu-divider" role="separator"></div><button role="menuitem" data-archive-project>${p.archived_at?'恢复项目':'归档项目'}</button>`;
    document.body.append(menu);menu.showPopover();this.positionMenu();
    const items=[...menu.querySelectorAll<HTMLElement>('[role=menuitem]')];items[0]?.focus();menu.addEventListener('keydown',e=>{const i=items.indexOf(document.activeElement as HTMLElement);if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){e.preventDefault();items[e.key==='Home'?0:e.key==='End'?items.length-1:(i+(e.key==='ArrowDown'?1:items.length-1))%items.length]?.focus();}if(e.key==='Escape'){e.preventDefault();this.closeMenu();this.findFocus(readingKey('work',p.project_id))?.focus({preventScroll:true});}});
    menu.addEventListener('toggle',()=>{if(!menu.matches(':popover-open')&&this.menu===menu)this.closeMenu();});
    menu.querySelector('[data-archive-project]')!.addEventListener('click',()=>{const latest=this.items.find(item=>item.project_id===p.project_id);this.closeMenu();if(latest)void this.archive(latest);});
    menu.querySelectorAll('a').forEach(a=>a.addEventListener('click',()=>this.closeMenu()));
  }
  private async archive(p:ProjectItem){
    try{await this.api.archiveProject(p.project_id,!p.archived_at);if(!this.live())return;document.querySelector('#collection-status')!.textContent=p.archived_at?'项目已恢复。':'项目已归档；任务与文件保留，可在已归档项目中恢复。';await this.load(true);}
    catch(e){if(this.live())document.querySelector('#collection-status')!.textContent=friendlyError(e,'save');}
  }
}
