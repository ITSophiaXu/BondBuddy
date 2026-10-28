import { MARKET_LABELS, OFFERING_LABELS } from '@bondbuddy/contracts';
import { ApiClient, friendlyError, type Dto } from './api';
import { esc, icon } from './ui';
import './update-entry.css';
import '../../../product-prototype/public/project-entry.css';
import {navigationProjectContext,withProjectContext} from './project-navigation';

export class UpdateEntry {
  private controller=new AbortController();
  private generation=0;
  private items:Dto<'ProjectListResponse'>['items']=[];
  private cursor:string|null=null;
  private selected='';
  private opening=false;
  dispose(){this.controller.abort();this.generation++;}
  constructor(private api:ApiClient,private shell:(html:string,section:string)=>void,private current:()=>boolean){}
  async render(projectId?:string){
    this.shell(`<div class="update-entry project-entry-page project-entry-update"><header class="page-head"><div><p class="eyebrow">PROSPECTUS WORKSPACE</p><h1>更新募集书</h1><p>有原稿可更新，没有原稿也可根据发行人材料编制首稿。</p></div></header>
      <section class="update-entry-primary"><div class="update-entry-icon">${icon('M14 2H5v20h14V7h-5ZM12 11v6M9 14h6')}</div><div><p class="eyebrow">开始新一期工作</p><h2>新建项目，准备募集书</h2><p>先保存项目，再添加材料和要求。各轮成果保留，后续可在同一项目继续修改。</p><a href="#/new" class="btn primary">＋ 新建项目</a></div></section>
      <details class="update-entry-existing" ${projectId?'open':''}><summary>继续已有项目 <span>已有项目的材料与填写内容可继续使用</span></summary>
        <div class="project-picker"><form id="update-project-search"><label class="sr-only" for="update-project-query">搜索项目名称或发行人</label><input id="update-project-query" type="search" placeholder="搜索项目名称或发行人" maxlength="200"/><button class="btn secondary" type="submit">搜索</button></form>
        <p id="update-entry-status" class="project-picker-status" role="status"></p><div class="project-picker-scroll" tabindex="0" role="region" aria-label="可选择的项目"><div id="update-project-list"></div><button id="update-project-more" class="text-button" hidden>加载更多项目</button></div>
        <footer class="project-picker-footer"><div class="project-picker-selection"><strong id="project-entry-selection" role="status">请选择一个项目</strong><span>选择后继续补充募集书、材料和更新要求。</span><p id="update-entry-error" class="form-message" role="alert"></p></div><button id="continue-update" class="btn primary" disabled>进入更新募集书</button></footer></div>
      </details></div>`, 'new');
    let loaded=false;
    document.querySelector('details.update-entry-existing')!.addEventListener('toggle',()=>{if(!loaded){loaded=true;void this.load(true);}});
    document.querySelector('#update-project-search')!.addEventListener('submit',e=>{e.preventDefault();void this.load(true);});
    document.querySelector('#update-project-more')!.addEventListener('click',()=>{void this.load(false);});
    document.querySelector('#continue-update')!.addEventListener('click',()=>{void this.open(this.selected);});
    if(projectId)await this.open(projectId);
  }
  private async load(reset:boolean){
    if(this.opening)return;
    const generation=++this.generation;
    if(reset){this.items=[];this.cursor=null;this.selected='';document.querySelector('.project-picker-scroll')!.scrollTop=0;document.querySelector('#update-entry-error')!.textContent='';this.paint();}
    const more=document.querySelector<HTMLButtonElement>('#update-project-more')!;more.disabled=true;
    const status=document.querySelector('#update-entry-status')!;
    status.textContent='正在读取项目…';
    try{
      const q=document.querySelector<HTMLInputElement>('#update-project-query')!.value.trim();
      const result=await this.api.projects(this.cursor??undefined,{q,archive:'active',limit:'20'},this.controller.signal);
      if(!this.current()||generation!==this.generation)return;
      this.items=[...new Map([...this.items,...result.items].map(p=>[p.project_id,p])).values()];this.cursor=result.page.next_cursor;
      this.paint();status.textContent=this.items.length?'':'没有匹配的项目，可以新建项目开始。';
    }catch(e){if(this.current()&&generation===this.generation)status.textContent=friendlyError(e,'read');}
    finally{if(this.current()&&generation===this.generation)more.disabled=false;}
  }
  private paint(){
    document.querySelector('#update-project-list')!.innerHTML=this.items.map(p=>`<label class="update-project-option"><input type="radio" name="update-project" value="${esc(p.project_id)}" ${p.project_id===this.selected?'checked':''}/><span class="update-folder">${icon('M3 7V5h7l2 2h9v13H3Z')}</span><span><strong>${esc(p.name)}</strong><small>${esc([p.issuer_name,p.market?MARKET_LABELS[p.market]:'',p.offering?OFFERING_LABELS[p.offering]:''].filter(Boolean).join(' · '))}</small></span><span class="update-prospectus-badge">${p.has_prospectus?'有募集说明书':'待添加募集说明书'}</span></label>`).join('');
    document.querySelectorAll<HTMLInputElement>('[name="update-project"]').forEach(r=>r.addEventListener('change',()=>{this.selected=r.value;document.querySelector('#update-entry-error')!.textContent='';this.paintSelection();}));
    this.paintSelection();
    document.querySelector<HTMLButtonElement>('#update-project-more')!.hidden=!this.cursor;
  }
  private paintSelection(){
    const selected=this.items.find(p=>p.project_id===this.selected);
    document.querySelector('#project-entry-selection')!.textContent=selected?'已选：'+selected.name:'请选择一个项目';
    document.querySelector<HTMLButtonElement>('#continue-update')!.disabled=!this.selected||this.opening;
  }
  private async open(id:string){
    if(!id||this.opening)return;this.opening=true;
    const button=document.querySelector<HTMLButtonElement>('#continue-update')!;button.disabled=true;button.textContent='正在准备项目材料…';
    const error=document.querySelector('#update-entry-error')!;error.textContent='';
    try{
      const result=await this.api.updateWorkspace(id,this.controller.signal);
      if(this.current()){
        const query=withProjectContext(new URLSearchParams());
        query.set('return_project',navigationProjectContext(location.hash)?.projectId??id);
        location.hash=`/projects/${encodeURIComponent(result.update_project_id)}?${query}`;
      }
    }catch(e){if(this.current()){error.textContent=friendlyError(e,'submit');this.selected=id;}}
    finally{this.opening=false;if(this.current()){button.disabled=!this.selected;button.textContent='进入更新募集书';}}
  }
}
