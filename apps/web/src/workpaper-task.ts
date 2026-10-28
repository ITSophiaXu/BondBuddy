import {WORKPAPER_DECISION_LABELS,type WorkpaperAssessment,type WorkpaperCatalogue,type WorkpaperCheck} from '@bondbuddy/contracts';
import {ApiClient,ApiError,friendlyError,type Dto} from './api';
import {esc,date} from './ui';
import {runStateLabel} from './review-state';
import {taskLabel} from './project-collection-model';
import {withProjectContext} from './project-navigation';
import './workpaper-panel.css';
import '../../../product-prototype/public/workpaper-task.css';

/** An immutable task selection. Opening history must not restore a newer draft or run. */
export class WorkpaperTaskPanel {
  private abort=new AbortController();private timer?:ReturnType<typeof setTimeout>;private busy=false;
  private run?:Dto<'RunResponse'>;
  constructor(private api:ApiClient,private host:HTMLElement,private project:string,private runId:string,private operation:string,private current:()=>boolean){}
  dispose(){this.abort.abort();clearTimeout(this.timer);}
  get hasUnconfirmed(){return this.busy;}
  async beforeLeave(){return !this.busy;}
  private live(){return !this.abort.signal.aborted&&this.current()&&this.host.isConnected;}
  private get base(){return `/projects/${encodeURIComponent(this.project)}/workpapers`;}
  private read<T>(path:string){return this.api.request<T>('GET',this.base+path,undefined,{},this.abort.signal);}
  private href(){return '#generate?'+withProjectContext(new URLSearchParams({project:this.project,step:'workpapers'}));}
  async render(){
    this.host.innerHTML=`<section class="panel wp-task" aria-label="底稿检查任务"><h2>${esc(taskLabel({kind:'generation',operation:this.operation}))}</h2><p id="wp-task-message" role="status">正在读取任务…</p><div id="wp-task-content"></div><div class="wp-action-buttons wp-task-nav"><button class="btn secondary" id="wp-task-refresh">刷新状态</button><a class="btn secondary" href="${esc(this.href())}">返回底稿生成</a></div></section>`;
    this.host.querySelector('#wp-task-refresh')!.addEventListener('click',()=>{if(!this.busy)void this.refresh();});
    await this.refresh();
  }
  private message(s:string){if(this.live())this.host.querySelector('#wp-task-message')!.textContent=s;}
  private async refresh(){
    clearTimeout(this.timer);
    try{
      const run=await this.api.run(this.runId,this.abort.signal);
      if(run.project_id!==this.project||run.run_id!==this.runId)throw new ApiError(0,'DATA_UNAVAILABLE');
      let details='';
      if(this.operation==='workpaper_assessment'){
        const a=await this.read<WorkpaperAssessment>('/assessments/'+encodeURIComponent(this.runId));
        if(a.assessment_id!==this.runId)throw new ApiError(0,'DATA_UNAVAILABLE');
        const catalogue=await this.read<WorkpaperCatalogue>('/catalogues/'+encodeURIComponent(a.request.catalogue_id));
        if(catalogue.catalogue_id!==a.request.catalogue_id||catalogue.sha256!==a.request.catalogue_sha256)throw new ApiError(0,'DATA_UNAVAILABLE');
        // The assessment response is read after the run; use its fresher state.
        run.state=a.state as Dto<'RunResponse'>['state'];
        const entries=new Map(catalogue.entries.map(e=>[e.id,e]));
        details=`<p>本次目录：${esc(catalogue.filename)}</p><p>本次依据：${esc(a.source.filename)} · V${a.source.sequence}</p><p>已检查 ${a.completed_items} / ${a.request.item_ids.length} 项</p>${a.request.requirements?`<p>本次要求：${esc(a.request.requirements)}</p>`:''}`;
        if(a.state==='succeeded')details+=`<p>检查已完成。核对清单与费用后，可在底稿生成页面确认生成。</p><div class="wp-table-wrap"><table class="wp-table"><thead><tr><th>编号 / 名称</th><th>检查结果</th><th>说明</th></tr></thead><tbody>${a.decisions.map(d=>{const e=entries.get(d.item_id);return `<tr><td>${esc(e?`${e.code} ${e.title}`:'底稿条目')}</td><td>${esc(WORKPAPER_DECISION_LABELS[d.status])}</td><td>${esc(d.reason)}</td></tr>`;}).join('')}</tbody></table></div>`;
        details+=a.warnings.map(w=>`<p>${esc(w)}</p>`).join('');
      }else if(this.operation==='workpaper_check'){
        const checks=await this.read<{checks:WorkpaperCheck[]}>('/checks');
        const check=checks.checks.find(c=>c.run_id===this.runId);if(!check)throw new ApiError(404,'NOT_FOUND');
        run.state=check.state as Dto<'RunResponse'>['state'];
        details=`<p>原募集书：${esc(check.baseline.filename)} · V${check.baseline.sequence}</p><p>本次检查依据：${esc(check.source.filename)} · V${check.source.sequence}</p>${check.stale?'<p>当前募集书已更换，以下为本次任务保留的历史检查。</p>':''}`;
        if(check.result)details+=`<p>已检查 ${check.result.items.length} 项底稿，识别 ${check.result.changed_spans} 处募集书变化。</p>${check.result.items.map(i=>`<details><summary>${{current:'未发现关联变动',needs_update:'内容需更新',manual:'需核对'}[i.status]} · ${esc(i.reason)}</summary>${i.changes.map(c=>`<p>${esc(c.target_locations.join('；'))}</p><p>原募集书：${esc(c.before)}</p><p>新募集书：${esc(c.after)}</p>`).join('')}</details>`).join('')}${check.result.warnings.map(w=>`<p>${esc(w)}</p>`).join('')}`;
      }else throw new ApiError(404,'NOT_FOUND');
      if(!this.live())return;this.run=run;
      const terminal=['succeeded','failed','cancelled','rejected','test_completed'].includes(run.state);
      const reconciling=run.state==='paused'&&run.stage==='provider_reconcile';
      const summary=reconciling?'检查服务正在核对本次执行结果，原进度保留。请刷新查看恢复状态。':run.state==='paused'?'本次检查已暂停，输入和已完成进度保留。':terminal?'本次任务记录已保留。':'关闭页面后检查仍会继续，重新打开可查看进度。';
      this.message('');
      this.host.querySelector('#wp-task-content')!.innerHTML=`<div class="wp-check-status"><strong role="status">${esc(runStateLabel[run.state])}</strong><span>${esc(date(run.updated_at))}</span></div>${details}<p>${summary}</p><div class="wp-action-buttons">${run.state==='paused'&&!reconciling?'<button class="btn primary" data-wp-task-action="resume">继续检查</button>':['queued','running'].includes(run.state)?'<button class="btn secondary" data-wp-task-action="pause">暂停检查</button>':''}${!terminal?'<button class="btn secondary" data-wp-task-action="cancel">停止本次检查</button>':''}</div>`;
      this.host.querySelectorAll<HTMLButtonElement>('[data-wp-task-action]').forEach(button=>button.onclick=()=>void this.act(button.dataset.wpTaskAction as 'pause'|'resume'|'cancel'));
      if(!terminal)this.timer=setTimeout(()=>{if(!this.busy)void this.refresh();},5000);
    }catch(e){if(this.live())this.message('这次底稿检查暂时无法读取，请刷新重试。'+friendlyError(e,'read'));}
  }
  private async act(action:'pause'|'resume'|'cancel'){
    if(this.busy||!this.run)return;
    if(action==='cancel'&&!window.confirm('停止本次检查？已保存的材料和检查记录会保留。'))return;
    this.busy=true;clearTimeout(this.timer);this.host.querySelectorAll<HTMLButtonElement>('button').forEach(b=>b.disabled=true);
    try{await this.api.runAction(this.runId,action,this.abort.signal);if(this.live())await this.refresh();}
    catch(e){this.message(friendlyError(e,'action'));}
    finally{this.busy=false;if(this.live()){this.host.querySelectorAll<HTMLButtonElement>('button').forEach(b=>b.disabled=false);if(this.run&&!['succeeded','failed','cancelled','rejected','test_completed'].includes(this.run.state))this.timer=setTimeout(()=>void this.refresh(),5000);}}
  }
}
