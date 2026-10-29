import type { Dto } from './api.js';
export type ProjectItem=Dto<'ProjectListResponse'>['items'][number];
export type ProjectTask=Dto<'ProjectTasksResponse'>['items'][number];
export type ProjectFile=Dto<'ProjectFilesResponse'>['items'][number];
export const taskKinds={update:'更新募集书',review:'复核募集书',generation:'文件生成',qa:'项目问答'};
export function taskLabel(t:Pick<ProjectTask,'kind'|'operation'>){return t.operation==='workpaper_batch'?'批量生成底稿':t.operation==='workpaper_assessment'?'检查可生成底稿':t.operation==='workpaper_check'?'检查底稿更新影响':t.operation==='qa_prepare'?'识别问题清单':t.operation==='qa_answer'?'项目问答':t.operation==='integrity_check'?'诚信核查':t.operation==='integrity_export'?'导出核查底稿':t.operation==='file_check'?'检查文件一致性':t.operation==='file_patch'?'更新关联文件':taskKinds[t.kind];}
export const activeStates=new Set(['preparing','queued','running','validating','delivering','settlement_pending']);
export function taskView(t:Pick<ProjectTask,'kind'|'state'|'stage'|'operation'|'workpaper_batch'>){
  const labels:Record<string,string>={preparing:'准备中',queued:'排队中',running:'执行中',awaiting_input:'待补材料',paused:'已暂停',validating:'整理结果',delivering:'准备下载',settlement_pending:'确认结果中',succeeded:'已完成',test_completed:'内部测试稿',failed:'本次未完成',cancelled:'已停止',rejected:'未启动'};
  const details:Record<string,string>={preparing:'正在准备材料与要求',queued:'任务已提交，等待执行',running:'正在'+taskLabel(t),awaiting_input:'请查看任务中需要补充的材料',paused:'输入和已完成进度保留，可进入任务恢复',validating:'正在整理本次结果',delivering:'正在保存文档并准备下载',settlement_pending:'正在确认交付与结算状态',succeeded:'成果已保存，可查看与下载',test_completed:'内部测试结果，请查看任务说明',failed:'已保存材料与此前成果保留，请查看原因',cancelled:'任务已停止，已保存材料保留',rejected:'请查看未启动原因'};
  const phases:Record<string,string>={input_lock:'正在准备材料与要求',materials_ready:'正在准备本次材料',word_delivery:'正在准备成果下载',word_delivery_pair:'正在准备成果下载',artifact_registration:'正在保存成果',provider_reconcile:'正在核对执行状态'};
  const unreadableReason=t.operation==='file_patch'&&['failed','rejected'].includes(t.state);
  if((t.operation==='workpaper_assessment'||t.operation==='workpaper_check')&&t.state==='succeeded')details.succeeded='检查结果已保存，可查看';
  if(t.workpaper_batch?.total!==undefined&&t.workpaper_batch.completed!==undefined){
    details[t.state]=`${t.workpaper_batch.completed} / ${t.workpaper_batch.total} 份完成 · ${details[t.state]}`;
    if(t.state==='failed'&&t.workpaper_batch.completed>0)labels.failed='部分完成';
  }
  return {label:labels[t.state],detail:unreadableReason?(t.state==='failed'?'本次更新未完成':'本次更新未启动')+'，已保存材料与此前成果保留':(t.state==='running'&&t.stage&&phases[t.stage])||details[t.state],tone:activeStates.has(t.state)?'active':t.state==='succeeded'?'done':'attention',action:unreadableReason?'查看任务':t.state==='succeeded'?'查看结果':activeStates.has(t.state)?'查看进度':['failed','rejected'].includes(t.state)?'查看原因':'查看任务'};
}
export function taskHref(t:ProjectTask){
  if(t.workpaper_batch)return '#generate?'+new URLSearchParams({from:'projects',project:t.workpaper_batch.project_id,step:'workpapers',view:'results',batch:t.workpaper_batch.batch_id});
  if(t.operation==='workpaper_assessment'||t.operation==='workpaper_check')return '#generate?'+new URLSearchParams({from:'projects',project:t.project_id,step:'workpapers',run:t.run_id,operation:t.operation});
  if(t.operation==='qa_prepare'||t.operation==='qa_answer')return '#qa?project='+encodeURIComponent(t.project_id)+'&run='+encodeURIComponent(t.run_id);
  if(t.operation==='integrity_check'||t.operation==='integrity_export')return '#integrity?project='+encodeURIComponent(t.project_id)+'&run='+encodeURIComponent(t.run_id);
  if(t.operation==='file_check'||t.operation==='file_patch')return '#consistency?project='+encodeURIComponent(t.project_id)+(t.operation==='file_check'?'&run=':'&update_run=')+encodeURIComponent(t.run_id);
  const q=new URLSearchParams({from:'projects',run:t.run_id});
  if(t.kind==='review'&&t.operation==='revision'&&t.state==='succeeded'&&t.artifact_id)return '#/artifacts/'+encodeURIComponent(t.artifact_id);
  if(t.kind==='review'){q.set('tab',t.state==='succeeded'?'results':'making');if(t.report_id)q.set('report_id',t.report_id);return '#/projects/'+encodeURIComponent(t.project_id)+'/review?'+q;}
  if(t.topic_id){q.set('topic',t.topic_id);return '#generate?'+q;}
  if(t.state==='succeeded'&&t.artifact_id)return '#/artifacts/'+encodeURIComponent(t.artifact_id);
  return '#/projects/'+encodeURIComponent(t.project_id)+'?'+q;
}
export const fileFolders=[
  {id:'all',name:'全部项目文件'},
  {id:'1',name:'1 投标文件及立项申请文件'},
  {id:'2',name:'2 申报、发行备案文件'},
  {id:'2.2',name:'其他申报、发行备案文件',parent:'2'},
  {id:'3',name:'3 受托管理材料'},
  {id:'4',name:'4 底稿文件'},
  {id:'4.1',name:'说明性文件',parent:'4'},
  {id:'4.2',name:'核查记录 / 已导入底稿',parent:'4'},
  {id:'4.3',name:'诚信核查',parent:'4'},
  {id:'sources',name:'原始资料'}
];
export const inFolder=(f:ProjectFile,folder:string)=>folder==='prospectus'?f.folder==='2':folder==='all'||f.folder===folder||f.folder.startsWith(folder+'.');
/** Mixed projects can have many newer review tasks. Keep paging to restore authoring. */
export async function authoringTasks(read:(cursor?:string)=>Promise<Dto<'ProjectTasksResponse'>>,projectId:string,aborted:()=>boolean,observe?:(task:ProjectTask)=>void){
  const items=new Map<string,ProjectTask>(),seen=new Set<string>();let cursor:string|undefined;
  do{const page=await read(cursor);if(aborted())return [];
    for(const task of page.items)if(task.project_id===projectId){observe?.(task);if(task.kind==='update'||task.kind==='generation'&&!task.topic_id&&!task.operation)items.set(task.run_id,task);}
    if(!page.page.has_more)break;const next=page.page.next_cursor;
    if(!next||seen.has(next))throw Error('Task pagination did not advance');seen.add(next);cursor=next;
  }while(true);
  return [...items.values()];
}
/** Do not display partial pagination as a complete account count. */
export async function loadProjectCollection(read:(cursor?:string)=>Promise<Dto<'ProjectListResponse'>>,aborted:()=>boolean){
  const items=new Map<string,ProjectItem>(),seen=new Set<string>();let cursor:string|undefined;
  do{const page=await read(cursor);if(aborted())return null;for(const p of page.items)items.set(p.project_id,p);
    if(!page.page.has_more)break;const next=page.page.next_cursor;if(!next||seen.has(next))throw Error('Project pagination did not advance');seen.add(next);cursor=next;
  }while(true);
  return [...items.values()].sort((a,b)=>b.updated_at.localeCompare(a.updated_at)||b.project_id.localeCompare(a.project_id));
}
