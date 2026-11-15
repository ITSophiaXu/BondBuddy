import assert from 'node:assert/strict';
import test from 'node:test';
import {Inspection,emptyFilters,type Snapshot,type Row} from './admin-inspection-model.js';
import {table,taskTable,overview,costs,batchList} from './admin-inspection-render.js';
import {taskDetail} from './admin-inspection-detail.js';
const at='2026-11-04T04:00:00Z';
function make(tables:Record<string,Row[]>){return new Inspection({schema_version:1,captured_at:at,source:'synthetic_test',release:null,scope:{run_limit:1000,run_count:2,available_run_count:2,description:'test'},warnings:[],tables:Object.entries(tables).map(([name,rows])=>({name,available:true,total:rows.length,truncated:false,rows}))} satisfies Snapshot);}
const run:Row={id:'r1',owner_user_id:'u1',project_id:'p1',task_kind:'update',state:'running',created_at:'2026-11-03T23:00:00Z',updated_at:'2026-11-04T00:00:00Z'};
test('project-only errors never become task root causes; exact job/attempt/operation links deduplicate',()=>{
 const d=make({bb_runs:[run],bb_jobs:[{id:'j1',run_id:'r1'}],bb_model_call_attempts:[{id:'a1',job_id:'j1'}],bb_operations:[{id:'o1',run_id:'r1'}],bb_observability_errors:[{id:'other',project_id:'p1',job_id:null,attempt_id:null,operation_id:null},{id:'e1',job_id:'j1',attempt_id:'a1'},{id:'e2',operation_id:'o1'}]});
 assert.deepEqual(d.errors(run).map(e=>e.id),['e1','e2']);
});
test('current adoption is never substituted for an immutable task snapshot',()=>{
 const d=make({bb_prospectus_selection:[{project_id:'p1',version_id:'now-adopted'}],task_input_snapshots:[{run_id:'r1',selection_recorded:true,selected_version_id:null}]});
 assert.match(d.inputDiagnosis(run),/未选定/);assert.match(d.inputDiagnosis(run),/无法判断/);
 const legacy=make({bb_prospectus_selection:[{project_id:'p1',version_id:'now-adopted'}]});assert.match(legacy.inputDiagnosis(run),/未找到/);
});
test('stale is evaluated at snapshot capture, ignores paused and terminal, includes recent events',()=>{
 const d=make({bb_run_events:[{id:'event',run_id:'r2',occurred_at:'2026-11-04T03:59:00Z'}]});assert.equal(d.stale(run),true);assert.equal(d.stale({...run,state:'paused'}),false);assert.equal(d.stale({...run,state:'succeeded'}),false);assert.equal(d.stale({...run,id:'r2'}),false);
});
test('filters use Beijing calendar days and username, task type and trace keys',()=>{
 const d=make({bb_runs:[run,{...run,id:'r2',created_at:'2026-11-04T16:01:00Z'}],bb_users:[{id:'u1',username:'yyx'}],bb_run_events:[{id:'event',run_id:'r1',trace_id:'trace-key',occurred_at:at}]});
 const f={...emptyFilters(),from:'2026-11-04',to:'2026-11-04',search:'yyx'};assert.deepEqual(d.filtered(f).map(r=>r.id),['r1']);assert.equal(d.filtered({...f,search:'trace-key'}).length,1);assert.equal(d.filtered({...f,kind:'review'}).length,0);
});
test('cost remains exact, currency-separated; missing measurements are unknown',()=>{
 const d=make({bb_jobs:[{id:'j1',run_id:'r1'}],bb_model_call_attempts:['a','b','c','d'].map(id=>({id,job_id:'j1'})),bb_platform_cost_ledger:[{attempt_id:'a',pricing_status:'priced',cost_amount:'0.1000000001',currency:'CNY'},{attempt_id:'b',pricing_status:'priced',cost_amount:'0.2',currency:'CNY'},{attempt_id:'c',pricing_status:'priced',cost_amount:'1',currency:'USD'},{attempt_id:'d',pricing_status:'unknown',cost_amount:null,currency:null}]});
 assert.deepEqual(d.cost([run]),{attempts:4,priced:3,unknown:1,amounts:['0.3000000001 CNY','1.0 USD']});
});
test('customer strings cannot inject markup or attributes into task and log tables',()=>{
 const attack='<img src=x onerror=alert(1)>';const d=make({bb_projects:[{id:'p1',name:attack}],bb_users:[{id:'u1',username:'" onclick="alert(1)'}]});
 for(const html of [table([{reason:attack}],['reason']),taskTable(d,[run])]){assert.equal(html.includes('<img'),false);assert.equal(html.includes(' onclick="'),false);assert.match(html,/&lt;img/);}
});
test('each business task exposes its own persisted subitems and evidence gaps',()=>{
 const fixtures:Array<{kind:string;tables:Record<string,Row[]>;text:string}>=[
  {kind:'review',tables:{review_checks:[{run_id:'r1',check_id:'check-fin-1',outcome:'uncovered'}],bb_review_executions:[{run_id:'r1'}]},text:'check-fin-1'},
  {kind:'generation',tables:{bb_workpaper_attempts:[{run_id:'r1',batch_id:'b1'}],bb_workpaper_items:[{run_id:'r1',batch_id:'b1',item_id:'item-1'}],bb_workpaper_item_results:[{run_id:'r1',item_id:'item-1',decision_status:'missing_information'}]},text:'missing_information'},
  {kind:'generation',tables:{bb_integrity_runs:[{run_id:'r1'}],bb_integrity_observations:[{run_id:'r1',subject_id:'subject-1',site_id:'site-1',reason_code:'captcha_required',search_performed:false}]},text:'captcha_required'},
  {kind:'qa',tables:{bb_project_qa_runs:[{run_id:'r1'}],bb_project_qa_answers:[{run_id:'r1',question_id:'question-1',status:'missing'}]},text:'question-1'}
 ];for(const f of fixtures){const d=make({bb_runs:[{...run,task_kind:f.kind}],...f.tables} as Record<string,Row[]>);assert.ok(taskDetail(d,'r1','subitems').includes(f.text));}
});
test('one observability record with both run and job links appears once',()=>{const d=make({bb_jobs:[{id:'j1',run_id:'r1'}],bb_observability_events:[{id:'e1',run_id:'r1',job_id:'j1',kind:'worker.started',created_at:at}]});assert.equal(d.events(run).length,1);});
test('historical examples and missing usage cannot masquerade as current operating metrics or zero costs',()=>{const d=make({bb_runs:[run]});d.snapshot.source='historical_evidence';assert.match(overview(d,[run]),/历史个案不能代表/);assert.match(costs(d,[run]),/均未知/);assert.match(taskTable(d,[run]),/调用未采集/);});
test('generic document generation is separated from prospectus generation using its immutable input',()=>{const d=make({task_input_snapshots:[{run_id:'r1',document_type:'underwriting'}]});assert.equal(d.kind({...run,task_kind:'generation'}),'material_generation');assert.match(table([{run_id:'r1'}],['run_id'],['任务'],true),/data-detail="r1"/);});

test('submitted workpaper batches stay visible without a run and keep channel uncertainty',()=>{
 const d=make({bb_projects:[{id:'p2',name:'Imported documents'}],bb_workpaper_batches:[{id:'b1',project_id:'p2',owner_user_id:'u1',state:'complete',created_at:at}],bb_workpaper_items:[{batch_id:'b1',item_id:'item1',title:'真实批次条目',run_id:null,state:'succeeded'}]});
 assert.match(batchList(d,emptyFilters()),/data-detail="b1"/);assert.match(taskDetail(d,'b1','subitems'),/真实批次条目/);
 assert.equal(d.batches({...emptyFilters(),state:'succeeded'}).length,1);assert.equal(d.batches({...emptyFilters(),channel:'production'}).length,0);assert.equal(d.batches({...emptyFilters(),user:'another'}).length,0);
 assert.equal(d.batches({...emptyFilters(),from:'2026-11-05'}).length,0);assert.equal(d.batches({...emptyFilters(),search:'Imported'}).length,1);
});
test('batch execution links use explicit item and attempt IDs, never a shared project',()=>{
 const d=make({bb_runs:[run,{...run,id:'unrelated'}],bb_workpaper_batches:[{id:'b1',project_id:'p1'}],bb_workpaper_attempts:[{batch_id:'b1',run_id:'r1'}],bb_workpaper_items:[{batch_id:'b1',run_id:'r1'}]});
 assert.deepEqual(d.batchRuns('b1').map(r=>r.id),['r1']);assert.doesNotMatch(taskDetail(d,'b1','execution'),/unrelated/);
});

test('grouped status filters use the batch lifecycle without hiding queued or running batches',()=>{
 const states=['draft','queued','running','paused','complete','partial','cancelled','future_batch_state',null];
 const d=make({bb_workpaper_batches:states.map((state,index)=>({id:`b${index}`,project_id:'p1',owner_user_id:'u1',state,created_at:at}))});
 const filtered=(state:string)=>d.batches({...emptyFilters(),state}).map(batch=>batch.state);
 assert.deepEqual(filtered('in_progress'),['queued','running']);
 assert.deepEqual(filtered('unknown_state'),['future_batch_state',null]);
 assert.deepEqual(filtered('attention'),['paused','partial']);
 assert.deepEqual(filtered('succeeded'),['complete']);
 for(const state of ['draft','queued','running','paused','partial','cancelled'])assert.deepEqual(filtered(state),[state]);
 assert.equal(filtered('').length,states.length);
 assert.deepEqual(filtered('stale'),[]);
});

test('grouped batch filters preserve owner date type search and channel restrictions',()=>{
 const batch:Row={id:'active',project_id:'p1',owner_user_id:'u1',state:'running',created_at:at};
 const d=make({bb_projects:[{id:'p1',name:'合成底稿项目'}],bb_workpaper_batches:[batch,{...batch,id:'other-user',owner_user_id:'u2'},{...batch,id:'outside-date',created_at:'2026-11-05T00:00:00Z'},{...batch,id:'paused',state:'paused'}]});
 const f={...emptyFilters(),state:'in_progress',user:'u1',kind:'workpaper',search:'合成底稿',from:'2026-11-04',to:'2026-11-04',channel:'unknown'};
 assert.deepEqual(d.batches(f).map(b=>b.id),['active']);
 assert.deepEqual(d.batches({...f,kind:'review'}),[]);
 assert.deepEqual(d.batches({...f,channel:'production'}),[]);
 assert.deepEqual(d.batches({...f,search:'其他项目'}),[]);
});

test('integrated overview retains task status counts alongside queue and stage timing',()=>{
 const succeeded:Row={...run,state:'succeeded'};
 const d=make({bb_runs:[succeeded]});
 // Render the typed timing projection; the timing calculator and HTTP shape
 // have their own tests and are not bypassed with an invalid public row payload.
 d.timing=()=>({totalMs:12000,initialWaitMs:2000,processingMs:10000,
  startedAt:'2026-11-03T23:00:02Z',endedAt:'2026-11-03T23:00:12Z',open:false,
  stages:[{stage:'provider_call',ms:3000}]});
 const html=overview(d,[succeeded]);
 assert.match(html,/data-status-summary/);
 assert.match(html,/data-status-kind="__total"/);
 assert.match(html,/data-run-state="succeeded"[^>]*>[\s\S]*?<strong>1<\/strong>/);
 assert.match(html,/平均排队/);
 assert.match(html,/data-stage-duration-summary/);
 assert.match(html,/模型调用/);
 assert.match(html,/3 秒/);
});