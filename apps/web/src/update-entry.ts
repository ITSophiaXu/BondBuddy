import { MARKET_LABELS, OFFERING_LABELS } from '@bondbuddy/contracts';
import { ApiClient, friendlyError, type Dto } from './api';
import { esc, icon } from './ui';
import './update-entry.css';

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
    this.shell(`<div class="update-entry"><header class="page-head"><div><p class="eyebrow">PROSPECTUS WORKSPACE</p><h1>更新募集书</h1><p>为新一期发行建立项目，补充材料与要求，开始更新募集说明书。</p></div></header>
      <section class="update-entry-primary"><div class="update-entry-icon">${icon('M14 2H5v20h14V7h-5ZM12 11v6M9 14h6')}</div><div><p class="eyebrow">开始新一期工作</p><h2>新建项目，更新募集书</h2><p>项目资料、更新要求和各轮成果独立保存，便于后续迭代。</p><a href="#/new" class="btn primary">＋ 新建项目并更新</a></div></section>
      <details class="update-entry-existing" ${projectId?'open':''}><summary>继续已有项目 <span>已有项目的材料与填写内容可继续使用</span></summary>
        <form id="update-project-search"><label class="sr-only" for="update-project-query">搜索项目名称或发行人</label><input id="update-project-query" type="search" placeholder="搜索项目名称或发行人" maxlength="200"/><button class="btn secondary" type="submit">搜索</button></form>
        <p id="update-entry-status" role="status"></p><div id="update-project-list"></div><button id="update-project-more" class="text-button" hidden>加载更多项目</button>
        <footer><span>选择项目后，继续补充募集书、材料和更新要求。</span><button id="continue-update" class="btn primary" disabled>进入更新募集书</button></footer>
      </details><p id="update-entry-error" class="form-message" role="alert"></p></div>`, 'new');
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
    if(reset){this.items=[];this.cursor=null;this.selected='';this.paint();}
    const status=document.querySelector('#update-entry-status')!;
    status.textContent='正在读取项目…';
    try{
      const q=document.querySelector<HTMLInputElement>('#update-project-query')!.value.trim();
      const result=await this.api.projects(this.cursor??undefined,{q,archive:'active',limit:'20'},this.controller.signal);
      if(!this.current()||generation!==this.generation)return;
      this.items=[...new Map([...this.items,...result.items].map(p=>[p.project_id,p])).values()];this.cursor=result.page.next_cursor;
      this.paint();status.textContent=this.items.length?'':'没有匹配的项目，可以新建项目开始。';
    }catch(e){if(this.current()&&generation===this.generation)status.textContent=friendlyError(e);}
  }
  private paint(){
    document.querySelector('#update-project-list')!.innerHTML=this.items.map(p=>`<label class="update-project-option"><input type="radio" name="update-project" value="${esc(p.project_id)}" ${p.project_id===this.selected?'checked':''}/><span class="update-folder">${icon('M3 7V5h7l2 2h9v13H3Z')}</span><span><strong>${esc(p.name)}</strong><small>${esc([p.issuer_name,p.market?MARKET_LABELS[p.market]:'',p.offering?OFFERING_LABELS[p.offering]:''].filter(Boolean).join(' · '))}</small></span><span class="update-prospectus-badge">${p.has_prospectus?'有募集说明书':'待添加募集说明书'}</span></label>`).join('');
    document.querySelectorAll<HTMLInputElement>('[name="update-project"]').forEach(r=>r.addEventListener('change',()=>{this.selected=r.value;document.querySelector<HTMLButtonElement>('#continue-update')!.disabled=false;}));
    document.querySelector<HTMLButtonElement>('#continue-update')!.disabled=!this.selected||this.opening;
    document.querySelector<HTMLButtonElement>('#update-project-more')!.hidden=!this.cursor;
  }
  private async open(id:string){
    if(!id||this.opening)return;this.opening=true;
    const button=document.querySelector<HTMLButtonElement>('#continue-update')!;button.disabled=true;button.textContent='正在准备项目材料…';
    const error=document.querySelector('#update-entry-error')!;error.textContent='';
    try{
      const result=await this.api.updateWorkspace(id,this.controller.signal);
      if(this.current())location.hash=`/projects/${encodeURIComponent(result.update_project_id)}`;
    }catch(e){if(this.current()){error.textContent=friendlyError(e);this.selected=id;}}
    finally{this.opening=false;if(this.current()){button.disabled=!this.selected;button.textContent='进入更新募集书';}}
  }
}
