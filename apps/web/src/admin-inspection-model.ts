import type {AdminInspectionRow as Row,AdminInspectionSnapshot as Snapshot} from '@bondbuddy/contracts';
import {executionTiming} from './admin-inspection-timing.js';
export type {Row,Snapshot};
export const labels:Record<string,string>={unknown:'未记录',production:'正式渠道',preparing:'准备中',queued:'排队中',running:'执行中',awaiting_input:'等待补充',paused:'已暂停',validating:'校验中',delivering:'交付中',settlement_pending:'等待结算',succeeded:'已完成',test_completed:'测试完成',failed:'失败',rejected:'被拒绝',cancelled:'已取消',generation:'生成募集书',update:'更新募集书',review:'复核募集书',qa:'项目问答',integrity:'诚信核查',material_generation:'生成材料',workpaper:'生成底稿材料',project_qa:'项目问答',complete:'完成',partial:'部分完成',generate:'可生成',not_applicable:'业务不适用',missing_information:'缺少资料',external_evidence:'需外部履职证据',draft:'草稿',missing:'缺少资料',active:'正常',disabled:'停用'};
export const label=(x:unknown)=>labels[String(x)]??String(x??'未记录');
Object.assign(labels,{pending_reconcile:'待核对',completed:'已完成',confirmed_not_sent:'确认未发送'});
export const str=(x:unknown)=>x===null||x===undefined?'':String(x);
export const time=(x:unknown)=>{const t=new Date(str(x));return Number.isFinite(t.getTime())?t.toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'未记录';};
export const terminal=new Set(['succeeded','test_completed','failed','rejected','cancelled']);
export interface Filters {search:string;kind:string;state:string;user:string;from:string;to:string;channel:string}
export const emptyFilters=():Filters=>({search:'',kind:'',state:'',user:'',from:'',to:'',channel:''});
export class Inspection {
  private indexes=new Map<string,Map<unknown,Row[]>>();
  private errorCache=new Map<unknown,Row[]>();
  private eventCache=new Map<unknown,Row[]>();
  private evidenceCache=new Map<unknown,Row[]>();
  by(name:string,key:string,value:unknown){let index=this.indexes.get(name+':'+key);if(!index){index=new Map();for(const row of this.rows(name)){const v=row[key];if(v===null||v===undefined)continue;const list=index.get(v)??[];list.push(row);index.set(v,list);}this.indexes.set(name+':'+key,index);}return index.get(value)??[];}
  constructor(public snapshot:Snapshot){}
  table(name:string){return this.snapshot.tables.find(t=>t.name===name);}
  rows(name:string){return this.table(name)?.rows??[];}
  user(id:unknown){return this.by('bb_users','id',id)[0];}
  project(id:unknown){return this.by('bb_projects','id',id)[0];}
  userName(id:unknown){return str(this.user(id)?.username)||str(id)||'未知账号';}
  related(name:string,id:unknown){return this.by(name,'run_id',id);}
  kind(r:Row){if(this.related('bb_workpaper_attempts',r.id).length||this.related('bb_workpaper_items',r.id).length)return 'workpaper';if(this.related('bb_integrity_runs',r.id).length)return 'integrity';if(this.related('bb_project_qa_runs',r.id).length)return 'project_qa';const input=this.related('task_input_snapshots',r.id)[0];if(input?.document_type==='workpaper')return 'workpaper';if(input?.document_type)return 'material_generation';return str(r.task_kind);}
  jobs(r:Row){return this.related('bb_jobs',r.id);}
  attempts(r:Row){return this.jobs(r).flatMap(j=>this.by('bb_model_call_attempts','job_id',j.id));}
  errors(r:Row){if(this.errorCache.has(r.id))return this.errorCache.get(r.id)!;const name='bb_observability_errors';const rows=[...this.jobs(r).flatMap(j=>this.by(name,'job_id',j.id)),...this.attempts(r).flatMap(a=>this.by(name,'attempt_id',a.id)),...this.related('bb_operations',r.id).flatMap(o=>this.by(name,'operation_id',o.id)),...this.by(name,'trace_id',r.id)];const unique=[...new Map(rows.map(e=>[e.id,e])).values()];this.errorCache.set(r.id,unique);return unique;}
  runtime(r:Row){return this.attempts(r).flatMap(a=>this.by('bb_model_call_attempt_runtime','attempt_id',a.id).filter(e=>(!e.run_id||e.run_id===r.id)&&(!e.job_id||e.job_id===a.job_id)));}
  errorEvidence(r:Row):Row[]{
    if(this.evidenceCache.has(r.id))return this.evidenceCache.get(r.id)!;
    const observed=this.errors(r).map(e=>({...e,run_id:r.id,source_table:'bb_observability_errors',source_id:e.id}));
    const runtime=this.runtime(r).filter(e=>e.error_code||e.exit_signal||(e.exit_code!==null&&e.exit_code!==undefined&&str(e.exit_code)!==''&&Number(e.exit_code)!==0)).map(e=>({...e,run_id:r.id,code:e.error_code??null,created_at:e.recorded_at,source_table:'bb_model_call_attempt_runtime',source_id:e.id}));
    const rows:Row[]=[...observed,...runtime];rows.sort((a,b)=>(Date.parse(str(b.created_at))||0)-(Date.parse(str(a.created_at))||0));
    this.evidenceCache.set(r.id,rows);return rows;
  }
  latestRunEvent(r:Row){return [...this.related('bb_run_events',r.id)].sort((a,b)=>Number(b.seq)-Number(a.seq)||(Date.parse(str(b.occurred_at))||0)-(Date.parse(str(a.occurred_at))||0))[0];}
  attention(r:Row){
    // Historical failures must not turn a successfully recovered task into an active incident.
    if(terminal.has(str(r.state)))return ['failed','rejected'].includes(str(r.state));
    return ['paused','awaiting_input'].includes(str(r.state))||this.stale(r);
  }
  attentionReason(r:Row){
    if(r.state==='paused'&&r.stage==='provider_reconcile')return '异常暂停：模型结果或用量待核对';
    if(r.state==='paused')return '已暂停：需结合暂停原因确认，不能直接计为失败';
    if(r.state==='awaiting_input')return '等待补充资料或确认';
    if(['failed','rejected'].includes(str(r.state)))return '任务终态：'+label(r.state);
    if(this.stale(r))return '活动任务 30 分钟无新记录';
    return '';
  }
  events(r:Row):Row[]{
    if(this.eventCache.has(r.id))return this.eventCache.get(r.id)!;
    const jobs=this.jobs(r),observed=[...new Map([...this.related('bb_observability_events',r.id),...jobs.flatMap(j=>this.by('bb_observability_events','job_id',j.id))].map(e=>[e.id,e])).values()];
    const sources:Row[]=[...this.related('bb_operations',r.id).map(e=>({...e,event_source:'请求',event_time:e.created_at,event_name:e.operation_kind})),...this.related('bb_run_events',r.id).map(e=>({...e,event_source:'任务',event_time:e.occurred_at,event_name:e.type})),...jobs.flatMap(j=>this.by('bb_job_events','job_id',j.id)).map(e=>({...e,event_source:'执行器',event_time:e.occurred_at,event_name:e.type})),...observed.map(e=>({...e,event_source:'观测',event_time:e.created_at,event_name:e.kind})),...this.errors(r).map(e=>({...e,event_source:'错误',event_time:e.created_at,event_name:e.code}))];
    sources.push(...this.errorEvidence(r).filter(e=>e.source_table==='bb_model_call_attempt_runtime').map(e=>({...e,event_source:'模型运行错误',event_time:e.created_at,event_name:e.code??e.finish_reason??'非正常退出'})));
    const sorted=sources.sort((a,b)=>Date.parse(str(a.event_time))-Date.parse(str(b.event_time))||Number(a.seq??0)-Number(b.seq??0));this.eventCache.set(r.id,sorted);return sorted;
  }
  stale(r:Row){if(!['queued','running','preparing','validating','delivering','settlement_pending'].includes(str(r.state)))return false;const last=Math.max(Date.parse(str(r.updated_at))||0,...this.events(r).map(e=>Date.parse(str(e.event_time))||0));return Date.parse(this.snapshot.captured_at)-last>30*60*1000;}
  filtered(f:Filters){const q=f.search.trim().toLowerCase(),from=f.from?Date.parse(f.from+'T00:00:00+08:00'):-Infinity,to=f.to?Date.parse(f.to+'T23:59:59.999+08:00'):Infinity;return this.rows('bb_runs').filter(r=>(!f.user||r.owner_user_id===f.user)&&(!f.kind||this.kind(r)===f.kind)&&(!f.state||(f.state==='attention'?this.attention(r):f.state==='stale'?this.stale(r):r.state===f.state))&&(!f.channel||(f.channel==='unknown'?!r.channel:r.channel===f.channel))&&Date.parse(str(r.created_at))>=from&&Date.parse(str(r.created_at))<=to&&(!q||[r.id,r.owner_user_id,this.userName(r.owner_user_id),this.project(r.project_id)?.name,r.project_id,r.task_kind,...this.errorEvidence(r).map(e=>e.code),...this.events(r).map(e=>e.trace_id)].some(x=>str(x).toLowerCase().includes(q))));}
  batches(f:Filters){const q=f.search.trim().toLowerCase(),from=f.from?Date.parse(f.from+'T00:00:00+08:00'):-Infinity,to=f.to?Date.parse(f.to+'T23:59:59.999+08:00'):Infinity;return this.rows('bb_workpaper_batches').filter(b=>(!f.user||b.owner_user_id===f.user)&&(!f.kind||f.kind==='workpaper')&&(!f.state||(f.state==='attention'?['paused','partial'].includes(str(b.state)):(b.state==='complete'?'succeeded':b.state)===f.state))&&(!f.channel||f.channel==='unknown')&&Date.parse(str(b.created_at))>=from&&Date.parse(str(b.created_at))<=to&&(!q||[b.id,b.project_id,this.userName(b.owner_user_id),this.project(b.project_id)?.name,...this.by('bb_workpaper_attempts','batch_id',b.id).map(a=>a.run_id)].some(x=>str(x).toLowerCase().includes(q))));}
  batchRuns(batchId:unknown){const ids=new Set([...this.by('bb_workpaper_attempts','batch_id',batchId),...this.by('bb_workpaper_items','batch_id',batchId)].map(i=>i.run_id).filter(Boolean));return this.rows('bb_runs').filter(r=>ids.has(r.id));}
  timing(r:Row){return executionTiming(r,this.related('bb_run_events',r.id),this.snapshot.captured_at);}
  inputDiagnosis(r:Row){if(!['generation','update'].includes(this.kind(r)))return '请结合本次锁定资料、执行事件与业务子项排障。募集书的采用和格式策略字段并不适用于所有任务类型。';const i=this.related('task_input_snapshots',r.id)[0];if(!i)return '未找到本次任务输入快照，无法判断模板是否进入任务。';if(i.format_material_id||i.format_artifact_id)return '输入快照已绑定格式模板；是否实际读取并遵循，还需核对执行和成果证据。';if(i.format_mode==='new_document')return '输入快照明确采用新文档格式策略；这能解释格式来源，但不能单凭它断定用户没点“采用”。';if(i.selection_recorded===true&&!i.selected_version_id)return '任务创建时未选定募集书版本；没有前端点击及确认日志，无法判断是未点击、请求失败还是选择被重置。';if(i.selected_version_id)return '任务创建时已选定募集书版本，但此快照没有明确的格式模板策略。';return '旧版快照未记录完整选择或格式策略；当前项目状态不能证明本次任务当时的状态。';}
  cost(runs:Row[]){const aids=new Set(runs.flatMap(r=>this.attempts(r)).map(a=>a.id));const costs=this.rows('bb_platform_cost_ledger').filter(c=>aids.has(c.attempt_id));const sums=new Map<string,bigint>();let priced=0;for(const c of costs){const value=str(c.cost_amount);if(c.pricing_status!=='priced'||!c.currency||!/^\d+(\.\d{1,10})?$/.test(value))continue;const [w,d='']=value.split('.');sums.set(str(c.currency),(sums.get(str(c.currency))??0n)+BigInt(w)*10n**10n+BigInt(d.padEnd(10,'0')));priced++;}return {attempts:aids.size,priced,unknown:aids.size-priced,amounts:[...sums].map(([currency,n])=>`${n/10n**10n}.${(n%10n**10n).toString().padStart(10,'0').replace(/0+$/,'')||'0'} ${currency}`)};}
}
