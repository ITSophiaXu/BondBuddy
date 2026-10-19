import { dashboardFrame } from './dashboard-view';
import { ApiClient, friendlyError, type Dto } from './api';
import { date, esc } from './ui';
import { prototypeIcon as icon } from './prototype-design';
import { ReviewHistory } from './review-history';
import { dashboardKinds, dashboardGroups, dashboardGroup, dashboardHref, dashboardPresentation, loadDashboardProjects, projectState, type DashboardProject, type DashboardKind, type DashboardGroup } from './dashboard-model';
import './dashboard.css';

/** Status-first workbench confirmed by the product owner on 2026-10-08 (#361). */
export class Dashboard {
  private controller=new AbortController();
  private timer:ReturnType<typeof setTimeout>|undefined;
  private kind:DashboardKind='all';
  private group:DashboardGroup='all';
  private items:DashboardProject[]=[];
  private runs=new Map<string,Dto<'RunResponse'>>();
  private limit=8;
  private loaded=false;
  private busy=false;
  private disposed=false;
  private history:ReviewHistory;
  private onReturn=()=>{if(document.visibilityState==='visible')void this.load();};
  constructor(private api:ApiClient,private shell:(html:string,section:string)=>void,private current:()=>boolean){
    this.history=new ReviewHistory(api,()=>new URLSearchParams({from:'dashboard',dashboard_kind:this.kind,dashboard_status:this.group}));
  }
  dispose(){this.disposed=true;this.controller.abort();clearTimeout(this.timer);this.history.dispose();document.removeEventListener('visibilitychange',this.onReturn);window.removeEventListener('focus',this.onReturn);}
  private live(){return !this.disposed&&this.current();}
  async render(){
    const query=new URLSearchParams(location.hash.split('?')[1]),kind=query.get('kind'),group=query.get('status');
    if(kind&&Object.hasOwn(dashboardKinds,kind))this.kind=kind as DashboardKind;
    if(group&&Object.hasOwn(dashboardGroups,group))this.group=group as DashboardGroup;
    this.shell(dashboardFrame(), 'dashboard');
    document.querySelectorAll<HTMLButtonElement>('[data-dashboard-group]').forEach(b=>b.addEventListener('click',()=>{this.group=this.group===b.dataset.dashboardGroup?'all':b.dataset.dashboardGroup as DashboardGroup;this.kind='all';this.changed();}));
    document.querySelectorAll<HTMLButtonElement>('[data-dashboard-kind]').forEach(b=>b.addEventListener('click',()=>{this.kind=b.dataset.dashboardKind as DashboardKind;this.changed();}));
    document.querySelector<HTMLSelectElement>('#dashboard-status')!.addEventListener('change',e=>{this.group=(e.target as HTMLSelectElement).value as DashboardGroup;this.changed();});
    document.querySelector('#dashboard-refresh')!.addEventListener('click',()=>void this.load());
    document.querySelector('#dashboard-more')!.addEventListener('click',()=>{this.limit+=8;this.paint();void this.loadStages();});
    document.addEventListener('visibilitychange',this.onReturn);window.addEventListener('focus',this.onReturn);
    this.paintControls();await this.load();
  }
  private changed(){this.limit=8;const query=new URLSearchParams();if(this.kind!=='all')query.set('kind',this.kind);if(this.group!=='all')query.set('status',this.group);history.replaceState(null,'',`${location.pathname}${location.search}#dashboard${query.size?'?'+query:''}`);this.paint();void this.loadStages();}
  private visible(){return this.items.filter(p=>(this.kind==='all'||p.kind===this.kind)&&(this.group==='all'||dashboardGroup(p)===this.group));}
  private paintControls(){
    document.querySelectorAll<HTMLElement>('[data-dashboard-group]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.dashboardGroup===this.group)));
    document.querySelectorAll<HTMLElement>('[data-dashboard-kind]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.dashboardKind===this.kind)));
    document.querySelector<HTMLSelectElement>('#dashboard-status')!.value=this.group;
  }
  private paint(){
    if(!this.live())return;this.paintControls();if(!this.loaded)return;
    for(const group of ['attention','active','done'] as const){
      const items=this.items.filter(p=>dashboardGroup(p)===group),count=(states:string[])=>items.filter(p=>states.includes(projectState(p))).length;
      document.querySelector(`[data-dashboard-count="${group}"]`)!.textContent=String(items.length);
      document.querySelector(`[data-dashboard-sub="${group}"]`)!.innerHTML=group==='done'?'可查看与下载':group==='active'?`<span>执行 ${count(['preparing','running','validating','delivering','settlement_pending'])}</span><span>排队 ${count(['queued'])}</span>`:`<span>草稿 ${count(['draft'])}</span><span>未完成 ${items.length-count(['draft'])}</span>`;
    }
    const filtered=this.visible(),visible=filtered.slice(0,this.limit);
    document.querySelector('#dashboard-list-title')!.textContent=`${this.group==='all'?'最近任务':dashboardGroups[this.group]} · ${filtered.length}`;
    document.querySelector('#dashboard-projects')!.innerHTML=visible.length?`<div class="dashboard-table-head"><span>任务 / 项目</span><span>当前状态</span><span>操作</span></div>${visible.map(p=>{const view=dashboardPresentation(p,this.runs.get(p.latest_run?.run_id??'')),href=dashboardHref(p,this.kind,this.group);return `<article class="dashboard-task" data-project-id="${esc(p.project_id)}"><div class="dashboard-task-info"><a class="dashboard-task-title" href="${href}">${esc(p.name)}</a><div class="dashboard-task-meta"><span>${icon(p.kind==='generation'?'spark':p.kind??'file')}${dashboardKinds[p.kind as keyof typeof dashboardKinds]}</span>${p.issuer_name?`<span>${esc(p.issuer_name)}</span>`:''}${p.market?`<span>${esc(({sse:'上交所',szse:'深交所',nafmii:'交易商协会'} as Record<string,string>)[p.market]??'')}</span>`:''}<time datetime="${esc(p.updated_at)}">${esc(date(p.updated_at))}</time></div></div><div class="dashboard-task-status"><span class="badge dashboard-state ${['failed','rejected'].includes(view.state)?'error':dashboardGroup(p)==='attention'?'warning':'neutral'}">${esc(view.label)}</span><span class="dashboard-task-stage">${esc(view.detail)}</span></div><div class="dashboard-task-actions"><a href="${href}" class="text-btn dashboard-primary-action">${view.action}${icon('chevron')}</a>${p.kind==='review'?`<button type="button" class="text-btn dashboard-history" data-review-history="${esc(p.project_id)}">版本记录</button>`:''}</div></article>`;}).join('')}`:`<div class="empty"><h3>${this.items.length?'没有符合筛选的任务':'你的第一份成果，从这里开始'}</h3><p>${this.items.length?'可以切换任务类型或状态。':'选择上方任务类型，填写信息并上传材料。'}</p>${this.items.length?'<button type="button" class="btn secondary small" id="dashboard-clear">清除筛选</button>':''}</div>`;
    document.querySelector('#dashboard-list-note')!.textContent=`显示 ${visible.length} / ${filtered.length} 项 · 按最近更新排序 · 每个未归档项目显示当前或最近任务`;
    document.querySelector<HTMLButtonElement>('#dashboard-more')!.hidden=visible.length>=filtered.length;
    document.querySelector('#dashboard-clear')?.addEventListener('click',()=>{this.kind='all';this.group='all';this.changed();});
    document.querySelectorAll<HTMLButtonElement>('[data-review-history]').forEach(b=>b.addEventListener('click',()=>{const p=this.items.find(p=>p.project_id===b.dataset.reviewHistory);if(p)void this.history.open(p.project_id,p.name);}));
  }
  private async load(){
    if(!this.live()||this.busy)return;this.busy=true;clearTimeout(this.timer);
    const button=document.querySelector<HTMLButtonElement>('#dashboard-refresh')!;button.disabled=true;
    const signal=this.controller.signal;
    try{
      const result=await loadDashboardProjects(cursor=>this.api.projects(cursor,{limit:'100',archive:'active'},signal),()=>!this.live()||signal.aborted);
      if(!result||!this.live())return;this.items=result;this.loaded=true;this.runs.clear();
      document.querySelector<HTMLElement>('#dashboard-error')!.hidden=true;this.paint();await this.loadStages();
    }catch(error){if(this.live()&&!signal.aborted){const node=document.querySelector<HTMLElement>('#dashboard-error')!;node.textContent=`${this.loaded?'刷新未成功，当前为上次同步结果。':'任务未能同步，统计暂不可用。'} ${friendlyError(error)} 请点击“刷新状态”重试。`;node.hidden=false;if(!this.loaded)document.querySelector('#dashboard-projects')!.innerHTML='';}}
    finally{this.busy=false;if(this.live()){button.disabled=false;this.timer=setTimeout(()=>{if(document.visibilityState==='visible')void this.load();else this.timer=undefined;},30000);}}
  }
  private async loadStages(){
    const signal=this.controller.signal;
    const items=this.visible().slice(0,this.limit).filter(p=>dashboardGroup(p)==='active'&&p.latest_run&&!this.runs.has(p.latest_run.run_id));
    const results=await Promise.allSettled(items.map(async p=>({p,run:await this.api.run(p.latest_run!.run_id,signal)})));
    if(!this.live()||signal.aborted)return;
    for(const r of results)if(r.status==='fulfilled'&&r.value.run.project_id===r.value.p.project_id&&r.value.run.run_id===r.value.p.latest_run!.run_id)this.runs.set(r.value.run.run_id,r.value.run);
    for(const p of this.visible().slice(0,this.limit)){const row=[...document.querySelectorAll<HTMLElement>('.dashboard-task')].find(row=>row.dataset.projectId===p.project_id);const stage=row?.querySelector('.dashboard-task-stage');if(stage)stage.textContent=dashboardPresentation(p,this.runs.get(p.latest_run?.run_id??'')).detail;}
  }
}
