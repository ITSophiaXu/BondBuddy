import { MARKET_LABELS, OFFERING_LABELS } from '@bondbuddy/contracts';
import { ApiClient, friendlyError, type Dto } from './api';
import { esc } from './ui';
import './update-entry.css';
export function projectFlowSteps(labels:string[],step:number,label:string){
  return '<nav class="stepper" aria-label="'+esc(label)+'">'+labels.map((text,i)=>(i?'<span class="step-line"></span>':'')+'<span class="step '+(step===i+1?'current':'')+'" '+(step===i+1?'aria-current="step"':'')+'><b>'+(step>i+1?'✓':i+1)+'</b>'+esc(text)+'</span>').join('')+'</nav>';
}
type Options={section:string;title:string;eyebrow:string;description:string;steps:string[];next:string;newHref?:string;onNew?:()=>void;open:(id:string,signal:AbortSignal)=>Promise<void>};
/** Shared selector: review, file generation and integrity use the same layout and behavior. */
export class ProjectEntry {
  private controller=new AbortController();private generation=0;private items:Dto<'ProjectListResponse'>['items']=[];private cursor:string|null=null;private selected='';private busy=false;
  constructor(private api:ApiClient,private shell:(html:string,section:string)=>void,private current:()=>boolean,private options:Options){}
  private live(){return this.current()&&!this.controller.signal.aborted;}
  dispose(){this.controller.abort();this.generation++;}
  async render(projectId?:string){
    const o=this.options;
    this.shell('<div class="update-entry"><header class="page-head"><div>'+(o.eyebrow?'<p class="eyebrow">'+esc(o.eyebrow)+'</p>':'')+'<h1>'+esc(o.title)+'</h1><p>'+esc(o.description)+'</p></div>'+(o.newHref?'<a class="btn secondary" href="'+esc(o.newHref)+'">＋ 新建项目</a>':'<button class="btn secondary" id="project-entry-new">＋ 新建项目</button>')+'</header>'+(o.steps.length?projectFlowSteps(o.steps,1,o.title+'流程'):'')+'<section class="review-panel update-entry-existing"><h2>选择本次工作的项目</h2><form id="review-project-search"><label class="sr-only" for="review-project-query">搜索项目名称或发行人</label><input id="review-project-query" type="search" maxlength="200" placeholder="搜索项目名称或发行人"><button class="btn secondary">搜索</button></form><p id="review-entry-status" role="status"></p><div id="review-project-list"></div><button id="review-project-more" class="text-button" hidden>加载更多项目</button><footer><span>项目中的材料与历次成果会保留。</span><button id="continue-review" class="btn primary" disabled>'+esc(o.next)+'</button></footer></section><p id="review-entry-error" role="alert"></p></div>',o.section);
    document.querySelector('#project-entry-new')?.addEventListener('click',()=>o.onNew?.());
    document.querySelector('#review-project-search')!.addEventListener('submit',e=>{e.preventDefault();void this.load(true);});
    document.querySelector('#review-project-more')!.addEventListener('click',()=>void this.load(false));
    document.querySelector('#continue-review')!.addEventListener('click',()=>void this.open());
    if(projectId){this.selected=projectId;await this.open();}else await this.load(true);
  }
  private async load(reset:boolean){
    const gen=++this.generation;
    if(reset){this.items=[];this.cursor=null;this.selected='';document.querySelector('#review-project-list')!.innerHTML='';document.querySelector<HTMLButtonElement>('#continue-review')!.disabled=true;}
    const status=document.querySelector('#review-entry-status')!;status.textContent='正在读取项目…';
    try{
      const result=await this.api.projects(this.cursor??undefined,{q:document.querySelector<HTMLInputElement>('#review-project-query')!.value.trim(),archive:'active',limit:'20'},this.controller.signal);
      if(!this.live()||gen!==this.generation)return;
      this.items=[...new Map([...this.items,...result.items].map(p=>[p.project_id,p])).values()];this.cursor=result.page.next_cursor;
      document.querySelector('#review-project-list')!.innerHTML=this.items.map(p=>'<label class="update-project-option"><input type="radio" name="review-project" value="'+esc(p.project_id)+'"><span><strong>'+esc(p.name)+'</strong><small>'+esc([p.issuer_name,p.market?MARKET_LABELS[p.market]:'',p.offering?OFFERING_LABELS[p.offering]:''].filter(Boolean).join(' · '))+'</small></span><span class="update-prospectus-badge">'+(p.has_prospectus?'有募集说明书':'待添加募集说明书')+'</span></label>').join('');
      document.querySelectorAll<HTMLInputElement>('[name=review-project]').forEach(r=>{r.checked=r.value===this.selected;r.addEventListener('change',()=>{this.selected=r.value;document.querySelector<HTMLButtonElement>('#continue-review')!.disabled=this.busy;});});
      document.querySelector<HTMLButtonElement>('#continue-review')!.disabled=!this.selected||this.busy;
      document.querySelector<HTMLButtonElement>('#review-project-more')!.hidden=!this.cursor;status.textContent=this.items.length?'':'暂无匹配项目，可新建项目开始。';
    }catch(e){if(this.live()&&gen===this.generation)status.textContent=friendlyError(e,'read');}
  }
  private async open(){
    if(this.busy||!this.selected)return;this.busy=true;
    const button=document.querySelector<HTMLButtonElement>('#continue-review')!;button.disabled=true;button.textContent='正在打开…';
    try{await this.options.open(this.selected,this.controller.signal);}
    catch(e){if(this.live())document.querySelector('#review-entry-error')!.textContent=friendlyError(e,'action');}
    finally{this.busy=false;if(this.live()){button.disabled=!this.selected;button.textContent=this.options.next;}}
  }
}

