import type { Dto } from './api.js';
export type DashboardProject = Dto<'ProjectListResponse'>['items'][number];
export type DashboardGroup = 'all' | 'attention' | 'active' | 'done';
export const dashboardKinds = { update:'募集书更新', review:'募集书复核', generation:'材料生成' } as const;
export type DashboardKind = 'all' | keyof typeof dashboardKinds;
export const dashboardGroups: Record<DashboardGroup,string> = {all:'全部状态',attention:'待处理',active:'进行中',done:'已完成'};
export const projectState = (p: DashboardProject) => p.latest_run?.state ?? p.status ?? 'draft';
export function dashboardGroup(p: DashboardProject): DashboardGroup {
  const state=projectState(p);
  if(state==='succeeded')return 'done';
  if(['preparing','queued','running','validating','delivering','settlement_pending'].includes(state))return 'active';
  return 'attention';
}
export function dashboardPresentation(p:DashboardProject, run?:Dto<'RunResponse'>) {
  const state=projectState(p),verb=p.kind==='review'?'复核':p.kind==='generation'?'生成材料':'编制募集书';
  const labels:Record<typeof state,string>={draft:'草稿',preparing:'准备中',queued:'排队中',running:p.kind==='review'?'复核中':p.kind==='generation'?'生成中':'编制中',validating:'处理中',delivering:'准备下载',settlement_pending:'确认结果中',succeeded:'已完成',test_completed:'内部测试稿',failed:'本次未完成',cancelled:'已停止',rejected:'未启动',paused:'等待恢复',awaiting_input:'待处理'};
  const details:Record<typeof state,string>={draft:'已保存，可继续填写',preparing:'正在准备材料与要求',queued:'任务已提交，等待执行',running:`正在${verb}`,validating:'正在整理本次结果',delivering:'正在保存文档并准备下载',settlement_pending:'正在确认交付与结算状态',succeeded:p.kind==='review'?'复核结果可查看':p.kind==='generation'?'材料文档与编制说明可查看':'募集书成果可查看与下载',test_completed:'内部测试结果，请查看任务说明',failed:'本次未完成，已保存材料保留',cancelled:'任务已停止，已保存材料保留',rejected:'本次未启动，请查看原因',paused:'等待执行恢复，已保存输入保留',awaiting_input:'请查看任务中的具体提示'};
  // Only known server phases become product copy; never expose arbitrary logs/prompts.
  const phases:Record<string,string>={input_lock:'正在准备材料与要求',materials_ready:'正在准备本次材料',model_generation:`正在${verb}`,m4_document_prompt:'正在生成材料正文',m4_document_v1_prompt:'正在生成材料正文',word_delivery:'正在准备成果下载',word_delivery_pair:'正在准备成果下载',artifact_registration:'正在保存成果',provider_reconcile:'正在核对执行状态'};
  const matching=run&&run.run_id===p.latest_run?.run_id&&run.project_id===p.project_id&&run.state===state;
  return {state,label:labels[state],detail:matching&&state==='running'&&run.stage&&phases[run.stage]||details[state],action:state==='succeeded'?'查看结果':dashboardGroup(p)==='active'?'查看进度':state==='draft'?'继续填写':['failed','rejected'].includes(state)?'查看原因':'查看任务'};
}
export function dashboardHref(p:DashboardProject, kind:DashboardKind, group:DashboardGroup) {
  const query=new URLSearchParams({from:'dashboard',dashboard_kind:kind,dashboard_status:group});
  if(p.kind==='review')query.set('tab',projectState(p)==='draft'?'materials':projectState(p)==='succeeded'?'results':'making');
  if(p.kind==='generation'&&p.latest_run)query.set('run',p.latest_run.run_id);
  if(p.kind==='update'&&projectState(p)==='draft')query.set('step','details');
  return `#/projects/${encodeURIComponent(p.project_id)}${p.kind==='review'?'/review':''}?${query}`;
}
/** Complete owner metadata pagination before displaying any account-wide totals. */
export async function loadDashboardProjects(read:(cursor?:string)=>Promise<Dto<'ProjectListResponse'>>, aborted:()=>boolean) {
  const projects=new Map<string,DashboardProject>(),cursors=new Set<string>();let cursor:string|undefined;
  do {
    const result=await read(cursor);if(aborted())return null;
    for(const p of result.items)if(!p.archived_at&&p.kind&&p.kind in dashboardKinds&&!projects.has(p.project_id))projects.set(p.project_id,p);
    if(!result.page.has_more)break;
    const next=result.page.next_cursor;if(!next||cursors.has(next))throw new Error('Project pagination did not advance');
    cursors.add(next);cursor=next;
  }while(true);
  return [...projects.values()].sort((a,b)=>b.updated_at.localeCompare(a.updated_at)||b.project_id.localeCompare(a.project_id));
}
