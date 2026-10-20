import { reviewSteps } from './review-steps';
import { withProjectContext } from './project-navigation';
import { MARKET_LABELS, OFFERING_LABELS } from '@bondbuddy/contracts';
import { ApiClient, friendlyError, type Dto } from './api';
import { esc } from './ui';
import './update-entry.css';
export class ReviewEntry {
  private controller=new AbortController();private generation=0;private items:Dto<'ProjectListResponse'>['items']=[];private cursor:string|null=null;private selected='';private busy=false;
  constructor(private api:ApiClient,private shell:(html:string,section:string)=>void,private current:()=>boolean){}
  dispose(){this.controller.abort();this.generation++;}
  async render(projectId?:string){
    this.shell(`<div class="update-entry"><header class="page-head"><div><p class="eyebrow">PROSPECTUS REVIEW</p><h1>复核募集书</h1><p>先选择项目，复用募集书和核验材料，生成带修订痕迹的复核成果。</p></div><a class="btn secondary" href="#review?new=1">＋ 新建项目</a></header>${reviewSteps(1)}<section class="review-panel update-entry-existing"><h2>选择本次工作的项目</h2><form id="review-project-search"><label class="sr-only" for="review-project-query">搜索项目名称或发行人</label><input id="review-project-query" type="search" maxlength="200" placeholder="搜索项目名称或发行人"><button class="btn secondary">搜索</button></form><p id="review-entry-status" role="status"></p><div id="review-project-list"></div><button id="review-project-more" class="text-button" hidden>加载更多项目</button><footer><span>项目中的材料与历次成果会保留。</span><button id="continue-review" class="btn primary" disabled>下一步：材料与要求</button></footer></section><p id="review-entry-error" role="alert"></p></div>`,'review');
    document.querySelector('#review-project-search')!.addEventListener('submit',e=>{e.preventDefault();void this.load(true);});
    document.querySelector('#review-project-more')!.addEventListener('click',()=>void this.load(false));
    document.querySelector('#continue-review')!.addEventListener('click',()=>void this.open());
    if(projectId){this.selected=projectId;await this.open();}else await this.load(true);
  }
  private async load(reset:boolean){
    const gen=++this.generation;if(reset){this.items=[];this.cursor=null;this.selected='';}
    const status=document.querySelector('#review-entry-status')!;status.textContent='正在读取项目…';
    try{
      const result=await this.api.projects(this.cursor??undefined,{q:document.querySelector<HTMLInputElement>('#review-project-query')!.value.trim(),archive:'active',limit:'20'},this.controller.signal);
      if(!this.current()||gen!==this.generation)return;
      this.items=[...new Map([...this.items,...result.items].map(p=>[p.project_id,p])).values()];this.cursor=result.page.next_cursor;
      document.querySelector('#review-project-list')!.innerHTML=this.items.map(p=>`<label class="update-project-option"><input type="radio" name="review-project" value="${esc(p.project_id)}"><span><strong>${esc(p.name)}</strong><small>${esc([p.issuer_name,p.market?MARKET_LABELS[p.market]:'',p.offering?OFFERING_LABELS[p.offering]:''].filter(Boolean).join(' · '))}</small></span><span class="update-prospectus-badge">${p.has_prospectus?'有募集说明书':'待添加募集说明书'}</span></label>`).join('');
      document.querySelectorAll<HTMLInputElement>('[name=review-project]').forEach(r=>{r.checked=r.value===this.selected;r.addEventListener('change',()=>{this.selected=r.value;document.querySelector<HTMLButtonElement>('#continue-review')!.disabled=false;});});
      document.querySelector<HTMLButtonElement>('#continue-review')!.disabled=!this.selected||this.busy;
      document.querySelector<HTMLButtonElement>('#review-project-more')!.hidden=!this.cursor;status.textContent=this.items.length?'':'暂无匹配项目，可新建项目开始复核。';
    }catch(e){if(this.current())status.textContent=friendlyError(e);}
  }
  private async open(){
    if(this.busy||!this.selected)return;this.busy=true;
    const button=document.querySelector<HTMLButtonElement>('#continue-review')!;button.disabled=true;button.textContent='正在打开…';
    try{const result=await this.api.request<{project_id:string}>('POST',`/projects/${encodeURIComponent(this.selected)}/review-entry`,{}, {},this.controller.signal);if(this.current())location.hash=`/projects/${encodeURIComponent(result.project_id)}/review?${withProjectContext(new URLSearchParams({tab:'materials'}))}`;}
    catch(e){if(this.current())document.querySelector('#review-entry-error')!.textContent=friendlyError(e);}
    finally{this.busy=false;if(this.current()){button.disabled=!this.selected;button.textContent='下一步：材料与要求';}}
  }
}
