import assert from 'node:assert/strict';
import test from 'node:test';
import {Inspection,emptyFilters,type Row} from './admin-inspection-model.js';
import {errors,overview,taskTable,taskSignalsPanel,recentExecutions} from './admin-inspection-render.js';
import {taskDetail} from './admin-inspection-detail.js';

const at='2026-11-05T06:00:00Z';
const run:Row={id:'run-1',owner_user_id:'user-1',project_id:'project-1',task_kind:'update',state:'paused',stage:'provider_reconcile',created_at:'2026-11-05T03:51:00Z',updated_at:'2026-11-05T04:52:00Z'};
function fixture(extra:Record<string,Row[]>={}){
 const tables:Record<string,Row[]>={bb_runs:[run],bb_jobs:[{id:'job-1',run_id:run.id}],bb_run_events:[{id:'event-1',run_id:run.id,seq:1,state:'queued',reason:'submitted',occurred_at:run.created_at},{id:'event-2',run_id:run.id,seq:2,state:'paused',stage:'provider_reconcile',reason:'provider_result_pending',occurred_at:run.updated_at}],bb_observability_errors:[],bb_model_call_attempts:[{id:'call-1',job_id:'job-1',attempt_no:1,status:'failed'},{id:'call-2',job_id:'job-1',attempt_no:2,status:'pending_reconcile'}],bb_model_call_attempt_runtime:[1,2].map(n=>({id:'runtime-'+n,run_id:run.id,job_id:'job-1',attempt_id:'call-'+n,error_code:'MODEL_TURN_FAILED',exit_code:'1',finish_reason:'turn_failed',recorded_at:`2026-11-05T04:${n===1?'02':'52'}:00Z`})),...extra};
 return new Inspection({schema_version:1,captured_at:at,source:'synthetic_test',release:null,scope:{run_limit:1000,run_count:1,available_run_count:1,description:'Synthetic regression'},warnings:[],tables:Object.entries(tables).map(([name,rows])=>({name,available:true,total:rows.length,truncated:false,rows}))});
}
test('model failures appear in errors, search and timeline even with no unified error rows',()=>{
 const d=fixture();assert.equal(d.errors(run).length,0);assert.equal(d.errorEvidence(run).length,2);
 assert.deepEqual(d.filtered({...emptyFilters(),state:'attention',search:'MODEL_TURN_FAILED'}).map(r=>r.id),[run.id]);
 assert.equal(d.filtered({...emptyFilters(),state:'failed'}).length,0);
 const html=errors(d,d.filtered(emptyFilters()),emptyFilters());
 for(const text of ['需关注任务','异常暂停','MODEL_TURN_FAILED','待核对','runtime-1','runtime-2','bb_model_call_attempt_runtime'])assert.ok(html.includes(text)||d.errorEvidence(run).some(e=>e.source_table===text));
 assert.equal(d.events(run).filter(e=>e.event_source==='模型运行错误').length,2);
 assert.match(taskTable(d,[run]),/2 条错误证据/);
 assert.match(overview(d,[run]),/查看已暂停任务（1）/);
 assert.match(taskDetail(d,'run-1','timeline'),/provider_result_pending/);
 assert.match(taskDetail(d,'run-1','timeline'),/MODEL_TURN_FAILED/);
});
test('a recovered success keeps history but does not become an active incident',()=>{
 const recovered={...run,state:'succeeded',stage:'done'};const d=fixture({bb_runs:[recovered]});
 assert.equal(d.attention(recovered),false);assert.equal(d.filtered({...emptyFilters(),state:'attention'}).length,0);
 assert.equal(d.errorEvidence(recovered).length,2);assert.match(taskSignalsPanel(d,recovered),/历史错误证据/);
});
test('manual pauses remain visible without calling them failures or provider errors',()=>{
 const paused={...run,stage:'user_paused'};const d=fixture({bb_runs:[paused],bb_model_call_attempt_runtime:[]});
 assert.equal(d.attention(paused),true);assert.equal(d.errorEvidence(paused).length,0);
 assert.match(d.attentionReason(paused),/不能直接计为失败/);assert.doesNotMatch(d.attentionReason(paused),/异常暂停/);
 assert.equal(d.filtered({...emptyFilters(),state:'failed'}).length,0);
});
test('pending reconciliation still surfaces when error details were never recorded',()=>{
 const d=fixture({bb_model_call_attempt_runtime:[],bb_run_events:[]});
 assert.match(errors(d,[run],emptyFilters()),/异常暂停/);
 assert.match(taskSignalsPanel(d,run),/未记录/);assert.doesNotMatch(taskSignalsPanel(d,run),/MODEL_TURN_FAILED/);
});
test('runtime evidence requires a matching attempt and no contradictory run or job',()=>{
 const d=fixture({bb_model_call_attempt_runtime:[{id:'other',run_id:'other-run',job_id:'job-1',attempt_id:'call-1',error_code:'FOREIGN'},{id:'wrong-job',run_id:run.id,job_id:'other-job',attempt_id:'call-1',error_code:'FOREIGN'},{id:'project-only',project_id:run.project_id,error_code:'FOREIGN'}]});
 assert.equal(d.errorEvidence(run).length,0);assert.equal(d.filtered({...emptyFilters(),search:'FOREIGN'}).length,0);
});
test('missing exit status and successful exits are not errors; source IDs remain separate',()=>{
 const d=fixture({bb_observability_errors:[{id:'same-id',job_id:'job-1',code:'MODEL_TURN_FAILED',created_at:at}],bb_model_call_attempt_runtime:[{id:'same-id',attempt_id:'call-1',exit_code:'1',recorded_at:at},{id:'ok',attempt_id:'call-2',exit_code:'0'},{id:'unknown',attempt_id:'call-2',exit_code:null}]});
 assert.equal(d.errorEvidence(run).length,2);assert.equal(new Set(d.errorEvidence(run).map(e=>e.source_table)).size,2);
 assert.equal(d.errorEvidence(run).find(e=>e.source_table==='bb_model_call_attempt_runtime')?.code,null);
});
test('error evidence and pause reasons are escaped and filters remain scoped',()=>{
 const attack='<img src=x onerror=alert(1)>';const d=fixture({bb_model_call_attempt_runtime:[{id:'runtime-1',attempt_id:'call-1',error_code:attack,recorded_at:at}],bb_run_events:[{id:'evt',run_id:run.id,seq:9,reason:attack,occurred_at:at}]});
 const html=taskSignalsPanel(d,run);assert.doesNotMatch(html,/<img/);assert.match(html,/&lt;img/);
 assert.equal(d.filtered({...emptyFilters(),state:'attention',user:'other-user'}).length,0);
 assert.equal(d.filtered({...emptyFilters(),state:'attention',kind:'review'}).length,0);
});
test('overview makes the active failure filter and eight-row preview explicit',()=>{
 const failed=Array.from({length:10},(_,i)=>({...run,id:'failed-'+i,state:'failed'}));
 const d=fixture({bb_runs:[run,...failed],bb_users:[{id:'user-1',username:'operator'}]});
 const f={...emptyFilters(),state:'failed',user:'user-1'};
 const html=recentExecutions(d,d.filtered(f),f);
 assert.match(html,/状态：失败/);assert.match(html,/用户：operator/);assert.match(html,/当前匹配 10 次执行，下方展示最新 8 条/);
 assert.doesNotMatch(html,/data-detail="run-1"/);assert.doesNotMatch(html,/data-detail="failed-8"/);
 assert.match(html,/data-overview-reset/);assert.match(html,/data-view="tasks"/);
 const reset=recentExecutions(d,d.filtered(emptyFilters()),emptyFilters());
 assert.match(reset,/未设置筛选/);assert.match(reset,/data-detail="run-1"/);assert.doesNotMatch(reset,/data-overview-reset/);
});
