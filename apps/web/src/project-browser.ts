import { MARKET_LABELS, OFFERING_LABELS, M4_DOCUMENT_LABELS, type M4DocumentType, PROJECT_FIELD_LIMITS } from '@bondbuddy/contracts';
import { ApiClient, friendlyError, type Dto } from './api';
import { esc, date } from './ui';
import { prototypeIcon as ico } from './prototype-design';
import { loadProjectCollection, taskHref, taskKinds,taskLabel, taskView, type ProjectItem, type ProjectTask } from './project-collection-model';
import './project-browser.css';
import { ReviewHistory } from './review-history';

const updatedDate=new Intl.DateTimeFormat('sv-SE',{year:'numeric',month:'2-digit',day:'2-digit'});
const updatedTime=new Intl.DateTimeFormat('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false});

export class ProjectBrowser {
  private items:ProjectItem[]=[];private loaded=false;private busy=false;private disposed=false;
  private controller=new AbortController();private timer?:ReturnType<typeof setTimeout>;private limit=30;
  private expanded=new Set<string>();private tasks=new Map<string,Dto<'ProjectTasksResponse'>>();private taskErrors=new Map<string,string>();private taskLoading=new Set<string>();
  private menu?:HTMLElement;private q='';private group='all';private archiveView='active';private legacyKind='';
  private refreshOnReturn=()=>{if(this.live()&&document.visibilityState==='visible')void this.load();};
  private reviewHistory:ReviewHistory;
  constructor(private api:ApiClient,private shell:(html:string,section:string)=>void,private current:()=>boolean){this.reviewHistory=new ReviewHistory(api);}
  private live(){return !this.disposed&&this.current();}
  dispose(){this.disposed=true;this.controller.abort();clearTimeout(this.timer);this.menu?.remove();this.reviewHistory.dispose();document.removeEventListener('visibilitychange',this.refreshOnReturn);window.removeEventListener('online',this.refreshOnReturn);}
  async render(){
    const query=new URLSearchParams(location.hash.split('?')[1]);this.q=query.get('q')??'';this.group=query.get('group')??'all';this.archiveView=query.get('archive')??'active';this.legacyKind=query.get('kind')??'';
    this.shell(`<div class="page-head"><div><div class="eyebrow">ALL PROJECTS</div><h1>全部项目</h1><p>每个项目的募集书、关联文件与核查底稿，都在同一个文件目录。</p></div><a class="btn primary" href="#/new">${ico('plus')}新建项目</a></div>
      <section class="collection-panel" aria-labelledby="projects-title"><header class="collection-heading"><h2 id="projects-title">项目列表 <span id="project-count" class="collection-count">—</span></h2><div><span>按最近活动排序</span><button class="text-button" id="refresh-projects">刷新状态</button></div></header>
      <div class="collection-search">${ico('search')}<input id="project-search" type="search" maxlength="${PROJECT_FIELD_LIMITS.issuer}" placeholder="搜索项目名称或发行人" aria-label="搜索项目名称或发行人" value="${esc(this.q)}"/></div>
      <div class="collection-filters"><div aria-label="按项目任务状态筛选">${[['all','全部'],['attention','待处理'],['active','进行中'],['done','已完成']].map(([k,v])=>`<button class="collection-filter" data-group="${k}" aria-pressed="${this.group===k}">${v} <span data-count="${k}">—</span></button>`).join('')}</div><select id="project-archive" aria-label="项目范围"><option value="active">未归档项目</option><option value="archived">已归档项目</option><option value="all">全部项目</option></select></div>
      <p id="collection-error" class="collection-error" role="alert" hidden></p><p id="collection-status" role="status"></p><div id="project-list" aria-busy="true"><p class="collection-empty">正在同步项目与任务…</p></div>
      <footer class="collection-footer"><span id="list-count"></span><button class="btn secondary small" id="load-more" hidden>加载更多项目</button></footer></section>`,'projects');
    window.scrollTo(0,0);
    document.querySelector<HTMLSelectElement>('#project-archive')!.value=this.archiveView;
    document.querySelector('#refresh-projects')!.addEventListener('click',()=>void this.load());
    document.querySelector('#load-more')!.addEventListener('click',()=>{this.limit+=30;this.paint();});
    const search=document.querySelector<HTMLInputElement>('#project-search')!;let composing=false;
    search.addEventListener('compositionstart',()=>{composing=true;});search.addEventListener('compositionend',()=>{composing=false;this.filter();});
    search.addEventListener('input',()=>{if(!composing)this.filter();});
    document.querySelector('#project-archive')!.addEventListener('change',()=>this.filter());
    document.querySelectorAll<HTMLElement>('[data-group]').forEach(b=>b.addEventListener('click',()=>{this.group=b.dataset.group!;this.filter();}));
    document.addEventListener('visibilitychange',this.refreshOnReturn);window.addEventListener('online',this.refreshOnReturn);
    await this.load();
  }
  private filter(){
    this.q=document.querySelector<HTMLInputElement>('#project-search')!.value;this.archiveView=document.querySelector<HTMLSelectElement>('#project-archive')!.value;this.limit=30;
    const q=new URLSearchParams();if(this.q)q.set('q',this.q);if(this.group!=='all')q.set('group',this.group);if(this.archiveView!=='active')q.set('archive',this.archiveView);
    this.legacyKind='';history.replaceState(null,'',location.pathname+location.search+'#tasks'+(q.size?'?'+q:''));this.paint();
  }
  private matches(p:ProjectItem,group:string){
    const s=p.task_summary;return group==='all'||group==='active'&&!!s?.active||group==='attention'&&!!s?.attention||group==='done'&&!!s?.completed;
  }
  private async load(){
    if(!this.live()||this.busy)return;this.busy=true;clearTimeout(this.timer);
    const button=document.querySelector<HTMLButtonElement>('#refresh-projects')!;button.disabled=true;
    try{
      const items=await loadProjectCollection(c=>this.api.projects(c,{archive:'all',limit:'100'},this.controller.signal),()=>!this.live());
      if(!items||!this.live())return;this.items=items;this.loaded=true;document.querySelector<HTMLElement>('#collection-error')!.hidden=true;
      this.paint();await Promise.allSettled([...this.expanded].map(id=>this.loadTasks(id,true)));
    }catch(error){if(this.live()){const node=document.querySelector<HTMLElement>('#collection-error')!;node.hidden=false;node.textContent=(this.loaded?'刷新未成功，当前显示上次同步结果。':'项目与任务未能同步。')+friendlyError(error);}}
    finally{if(this.live()){this.busy=false;button.disabled=false;document.querySelector('#project-list')!.setAttribute('aria-busy','false');this.timer=setTimeout(()=>{if(document.visibilityState==='visible')void this.load();},30000);}}
  }
  private paint(){
    if(!this.live()||!this.loaded)return;
    const focused=document.activeElement as HTMLElement|null;
    const focusKey=['tasks','work','taskMore','taskRetry'].find(k=>focused?.dataset[k]);
    const focusId=focusKey?focused?.dataset[focusKey]:undefined;
    const base=this.items.filter(p=>(this.archiveView==='all'||Boolean(p.archived_at)===(this.archiveView==='archived'))&&(!this.legacyKind||p.kind===this.legacyKind));
    for(const k of ['all','attention','active','done']){document.querySelector(`[data-count="${k}"]`)!.textContent=String(base.filter(p=>this.matches(p,k)).length);document.querySelector(`[data-group="${k}"]`)!.setAttribute('aria-pressed',String(this.group===k));}
    const q=this.q.trim().toLocaleLowerCase();const filtered=base.filter(p=>this.matches(p,this.group)&&(!q||(p.name+' '+(p.issuer_name??'')).toLocaleLowerCase().includes(q)));
    const visible=filtered.slice(0,this.limit);
    document.querySelector('#project-count')!.textContent=String(filtered.length);
    document.querySelector('#list-count')!.textContent=`显示 ${visible.length} / ${filtered.length} 个项目 · 状态自动同步`;
    document.querySelector<HTMLButtonElement>('#load-more')!.hidden=visible.length>=filtered.length;
    const list=document.querySelector<HTMLElement>('#project-list')!;
    list.innerHTML=visible.length?`<div class="collection-table-wrap"><table class="collection-table"><thead><tr><th scope="col">项目名称</th><th scope="col">任务状态</th><th scope="col">文件与一致性</th><th scope="col">最近更新</th><th scope="col">操作</th></tr></thead><tbody>${visible.map(p=>this.row(p)).join('')}</tbody></table></div>`:`<div class="collection-empty"><h3>${this.items.length?'没有找到匹配的项目':'还没有项目'}</h3><p>${this.items.length?'试试其他项目名称、发行人或任务状态。':'新建一个项目，开始准备募集书和项目文件。'}</p>${this.items.length?'<button class="btn secondary" id="clear-project-filters">清除筛选</button>':'<a class="btn primary" href="#/new">新建项目</a>'}</div>`;
    list.querySelector('#clear-project-filters')?.addEventListener('click',()=>{document.querySelector<HTMLInputElement>('#project-search')!.value='';this.group='all';document.querySelector<HTMLSelectElement>('#project-archive')!.value='active';this.filter();});
    list.querySelectorAll<HTMLButtonElement>('[data-tasks]').forEach(b=>b.addEventListener('click',()=>{
      const id=b.dataset.tasks!;if(this.expanded.has(id))this.expanded.delete(id);else this.expanded.add(id);this.paint();if(this.expanded.has(id))void this.loadTasks(id,!this.tasks.has(id));
    }));
    list.querySelectorAll<HTMLButtonElement>('[data-work]').forEach(b=>b.addEventListener('click',()=>this.openMenu(b,this.items.find(p=>p.project_id===b.dataset.work)!)));
    list.querySelectorAll<HTMLButtonElement>('[data-task-more]').forEach(b=>b.addEventListener('click',()=>void this.loadTasks(b.dataset.taskMore!,false)));
    list.querySelectorAll<HTMLButtonElement>('[data-task-retry]').forEach(b=>b.addEventListener('click',()=>void this.loadTasks(b.dataset.taskRetry!,true)));
    list.querySelectorAll<HTMLButtonElement>('[data-review-history]').forEach(b=>b.addEventListener('click',()=>void this.reviewHistory.open(b.dataset.reviewHistory!,this.items.find(p=>p.project_id===b.dataset.root)?.name??'项目')));
    if(focusKey&&focusId)[...list.querySelectorAll<HTMLElement>('button')].find(b=>b.dataset[focusKey]===focusId)?.focus({preventScroll:true});
  }
  private row(p:ProjectItem){
    const s=p.task_summary,latest=s?.recent_result,opened=this.expanded.has(p.project_id),href='#/projects/'+encodeURIComponent(p.project_id)+'/files';
    const recent=latest?taskLabel(latest)+' · '+taskView(latest).label:s?.latest?taskLabel(s.latest)+' · '+taskView(s.latest).label:'尚未开始任务';
    return `<tr class="collection-project" data-project-id="${esc(p.project_id)}"><td><a class="collection-title" href="${href}">${esc(p.name)}</a><small class="collection-issuer">${esc(p.issuer_name||'发行人待填写')}</small><span class="collection-market">${p.market?esc(MARKET_LABELS[p.market]):'市场待填写'}${p.offering?' · '+esc(OFFERING_LABELS[p.offering]):''}</span></td>
      <td class="collection-task-cell"><button class="collection-task-toggle" data-tasks="${esc(p.project_id)}" aria-expanded="${opened}" aria-controls="tasks-${esc(p.project_id)}">${s?.active?`<span class="task-active">${s.active} 项进行中</span>`:''}${s?.attention?`<span class="task-attention">${s.attention} 项待处理</span>`:''}<span>${s?.active||s?.attention?'任务详情':'查看任务'} ${ico(opened?'down':'chevron')}</span></button><small class="collection-recent">${latest?'最近结果：':''}${esc(recent)}</small></td>
      <td><a class="collection-file-count" href="${href}">${ico('folder')}${p.file_count??0} 份项目文件</a><small class="collection-muted">以当前募集书为准</small></td>
      <td class="collection-updated"><time datetime="${esc(p.updated_at)}" title="${esc(date(p.updated_at))}"><span>${esc(updatedDate.format(new Date(p.updated_at)))}</span><span>${esc(updatedTime.format(new Date(p.updated_at)))}</span></time>${p.archived_at?'<small>已归档</small>':''}</td>
      <td><div class="collection-actions"><a class="btn primary small" href="${href}">项目文件</a><a class="btn secondary small collection-consistency" href="#consistency?project=${encodeURIComponent(p.project_id)}">检查文件一致性</a><button class="btn secondary small" data-work="${esc(p.project_id)}" aria-haspopup="menu" aria-expanded="false">${p.archived_at?'项目操作':'开始工作'} ${ico('down')}</button></div></td></tr>
      <tr id="tasks-${esc(p.project_id)}" class="collection-task-row" ${opened?'':'hidden'}><td colspan="5"><div class="collection-tasks" data-task-panel="${esc(p.project_id)}">${this.taskPanel(p)}</div></td></tr>`;
  }
  private taskPanel(p:ProjectItem){
    const id=p.project_id,data=this.tasks.get(id),error=this.taskErrors.get(id);
    return `<header><h3>项目任务</h3><span>按提交时间排序 · 关闭页面后任务仍会继续</span></header>${error?`<p role="alert">${esc(error)} <button class="text-button" data-task-retry="${esc(id)}">重试</button></p>`:''}${data?data.items.length?data.items.map(t=>this.taskRow(t)).join(''):`<div class="collection-draft"><span>项目已保存，尚未开始任务。</span><a class="text-button" href="#${p.kind==='review'?'review':'update'}?project=${encodeURIComponent(id)}&from=projects">继续准备材料 ${ico('chevron')}</a></div>`:'<p role="status">正在读取任务…</p>'}
      ${[...new Set([...(p.kind==='review'?[id]:[]),...(data?.items.filter(t=>t.kind==='review').map(t=>t.project_id)??[])])].map(reviewId=>`<button class="text-button" data-review-history="${esc(reviewId)}" data-root="${esc(id)}">复核版本记录</button>`).join('')}
      ${data?.page.has_more?`<button class="text-button" data-task-more="${esc(id)}" ${this.taskLoading.has(id)?'disabled':''}>加载更早任务</button>`:''}`;
  }
  private taskRow(t:ProjectTask){
    const view=taskView(t);const label=t.document_type&&M4_DOCUMENT_LABELS[t.document_type as M4DocumentType]||taskLabel(t);
    return `<article class="collection-task" data-run-id="${esc(t.run_id)}"><div><strong>${esc(label)}${t.operation==='revision'?' · 修订导出':''}</strong><time>${esc(date(t.created_at))}</time></div><div><span class="collection-state ${view.tone}">${view.label}</span><small>${esc(view.detail)}</small></div><a class="text-button" href="${taskHref(t)}">${view.action} ${ico('chevron')}</a></article>`;
  }
  private async loadTasks(id:string,reset:boolean){
    if(this.taskLoading.has(id)||!this.live())return;const existing=this.tasks.get(id);if(!reset&&existing&&!existing.page.has_more)return;
    this.taskLoading.add(id);this.taskErrors.delete(id);
    try{const data=await this.api.projectTasks(id,reset?undefined:existing?.page.next_cursor??undefined,this.controller.signal);if(!this.live())return;
      this.tasks.set(id,reset||!existing?data:{...data,items:[...new Map([...existing.items,...data.items].map(t=>[t.run_id,t])).values()]});
    }catch(error){if(this.live())this.taskErrors.set(id,friendlyError(error));}
    finally{this.taskLoading.delete(id);if(this.live())this.paint();}
  }
  private openMenu(button:HTMLButtonElement,p:ProjectItem){
    this.menu?.remove();const menu=document.createElement('div');this.menu=menu;menu.className='collection-menu';menu.setAttribute('popover','auto');menu.setAttribute('role','menu');menu.setAttribute('aria-label',p.name+' · 项目操作');
    menu.innerHTML=`${p.archived_at?'':[['update','更新募集书'],['review','复核募集书'],['generate','文件生成'],['integrity','诚信核查'],['qa','项目问答']].map(([route,label])=>`<a role="menuitem" href="#${route}?project=${encodeURIComponent(p.project_id)}&from=projects">${label}${ico('chevron')}</a>`).join('')}<button role="menuitem" data-archive-project>${p.archived_at?'恢复项目':'归档项目'}</button>`;
    document.body.append(menu);menu.showPopover();button.setAttribute('aria-expanded','true');const rect=button.getBoundingClientRect();menu.style.left=Math.max(12,Math.min(rect.right-menu.offsetWidth,innerWidth-menu.offsetWidth-12))+'px';menu.style.top=Math.max(12,rect.bottom+menu.offsetHeight+8>innerHeight?rect.top-menu.offsetHeight-8:rect.bottom+8)+'px';
    const items=[...menu.querySelectorAll<HTMLElement>('[role=menuitem]')];items[0]?.focus();menu.addEventListener('keydown',e=>{const i=items.indexOf(document.activeElement as HTMLElement);if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){e.preventDefault();items[e.key==='Home'?0:e.key==='End'?items.length-1:(i+(e.key==='ArrowDown'?1:items.length-1))%items.length]?.focus();}if(e.key==='Escape')button.focus();});
    menu.addEventListener('toggle',()=>{if(!menu.matches(':popover-open')){button.setAttribute('aria-expanded','false');menu.remove();}});
    menu.querySelector('[data-archive-project]')!.addEventListener('click',()=>{menu.hidePopover();void this.archive(p);});
    menu.querySelectorAll('a').forEach(a=>a.addEventListener('click',()=>menu.hidePopover()));
  }
  private async archive(p:ProjectItem){
    try{await this.api.archiveProject(p.project_id,!p.archived_at);if(!this.live())return;document.querySelector('#collection-status')!.textContent=p.archived_at?'项目已恢复。':'项目已归档；任务与文件保留，可在已归档项目中恢复。';await this.load();}
    catch(e){if(this.live())document.querySelector('#collection-status')!.textContent=friendlyError(e);}
  }
}
