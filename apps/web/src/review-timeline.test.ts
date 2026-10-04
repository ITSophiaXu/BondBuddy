import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ReviewTask, ReviewTimelineEntry, Run, RunEvent } from '@bondbuddy/contracts';
import { uniqueReviewTimeline, reviewTaskHtml, reviewTaskNotice, reviewEmptyResultText } from './review-timeline.js';
import { isActiveRun } from './review-state.js';
const run=(state:Run['state'],cursor:number):Run=>({run_id:'same-run',project_id:'project',execution_request_id:'request',input_revision:2,input_hash:'a'.repeat(64),state,event_cursor:cursor,stage:'review_sources',channel:'production',test_grant_id:null,uncovered_items:[],billing_mode:'platform_trial',reservation_id:null,artifact_id:null,prompt_snapshot_ref:null,updated_at:'2026-10-04T10:00:00Z'});
const task=(state:Run['state'],cursor:number):ReviewTask=>({run:run(state,cursor),operation:'differential_review',version:2,input_version:2,input_revision:2,input_sha256:'a'.repeat(64),source_report_id:'source-report',report_id:null,finding_ids:['F02'],origin:{version:'review-execution-origin-v1',entrypoint:'quick_action',accepted_proposal:null,context_report_ref:null},artifacts:[],events:[]});
const entry=(state:Run['state'],cursor:number):ReviewTimelineEntry=>({kind:'task',entry_id:'task:same-run',created_at:'2026-10-04T09:00:00Z',task:task(state,cursor)});
test('replayed/out-of-order snapshots cannot duplicate tasks or regress a terminal run',()=>{
  const result=uniqueReviewTimeline([entry('queued',1),entry('running',3),entry('succeeded',7),entry('running',5),entry('queued',8)]);
  assert.equal(result.length,1);assert.equal(result[0].kind,'task');if(result[0].kind==='task')assert.equal(result[0].task.run.state,'succeeded');
  const restored=entry('running',8);if(restored.kind==='task')restored.task.events=[{event_id:'recovery',schema_version:1,trace_id:'trace',run_id:'same-run',seq:7,occurred_at:'2026-10-04T10:00:00Z',stage:'queued',type:'run.state_changed',state:'queued',payload:{reason:'review_assembly_requeued'}}];
  const recovery=uniqueReviewTimeline([entry('failed',5),restored]);assert.equal(recovery.length,1);if(recovery[0].kind==='task')assert.equal(recovery[0].task.run.state,'running');
});
test('task HTML renders true fixed input and known stage while unknown raw fields stay out',()=>{
  const current=task('running',3);Object.assign(current,{raw_log:'secret CLI output'});current.run.stage='raw_secret_stage';
  const html=reviewTaskHtml(current,'2026-10-04T09:00:00Z',{'source-report':'R1'});
  assert.match(html,/固定输入 V2/);assert.match(html,/页面快捷操作/);assert.match(html,/data-report-id="source-report"/);assert.match(html,/>R1<\/button>/);
  assert.doesNotMatch(html,/raw_secret_stage|secret CLI output|62%|预计/);
  current.run.stage='review_sources';assert.match(reviewTaskHtml(current,'2026-10-04T09:00:00Z'),/读取已固定的材料依据/);
});
test('recorded failure and actual timestamps are shown without inferring times or exposing raw errors',()=>{
  const current=task('failed',5);
  const failure:RunEvent={event_id:'failed-event',schema_version:1,trace_id:'trace',run_id:current.run.run_id,seq:5,occurred_at:'2026-10-04T09:10:00Z',stage:current.run.stage,type:'run.state_changed',state:'failed',payload:{error_code:'DELIVERY_FAILED'}};
  current.events=[failure];
  assert.match(reviewTaskNotice(current)??'',/文档交付失败/);
  let html=reviewTaskHtml(current,'2026-10-04T09:00:00Z');
  assert.match(html,/文档交付失败/);assert.doesNotMatch(html,/ · 开始 | · 结束 | · 更新 /);
  current.started_at='2026-10-04T09:01:00Z';current.completed_at='2026-10-04T09:10:00Z';
  html=reviewTaskHtml(current,'2026-10-04T09:00:00Z');assert.match(html,/ · 开始 /);assert.match(html,/ · 结束 /);
  current.events=[{...failure,payload:{reason:'raw_secret_failure'}}];
  assert.match(reviewTaskNotice(current)??'',/本轮未完成/);assert.doesNotMatch(reviewTaskHtml(current,'2026-10-04T09:00:00Z'),/raw_secret_failure/);
  current.run.state='running';assert.equal(reviewTaskNotice(current),undefined);
});

test('paused quota work retains its active lock and shows the current blocker plus the earlier safe format failure',()=>{
  const current=task('paused',6);current.run.stage='trial_limit';
  const event:RunEvent={event_id:'retry-event',schema_version:1,trace_id:'trace',run_id:current.run.run_id,seq:5,occurred_at:'2026-10-04T09:10:00Z',stage:'review_sources',type:'run.progress',state:'running',payload:{reason:'provider_call_retrying',error_code:'MODEL_OUTPUT_SCHEMA_INVALID'}};
  current.events=[event,{...event,event_id:'paused-event',seq:6,stage:'trial_limit',state:'paused',type:'run.state_changed',payload:{reason:'model_tokens_per_user_per_day',error_code:'TRIAL_QUOTA_EXCEEDED'}}];
  assert.equal(isActiveRun(current.run),true,'paused work must still block duplicate execution');
  assert.match(reviewTaskNotice(current)??'',/今日处理额度已用完/);
  assert.equal(reviewEmptyResultText(current.run).heading,'复核已暂停');
  const html=reviewTaskHtml(current,'2026-10-04T09:00:00Z');
  assert.match(html,/等待处理限制解除/);assert.match(html,/查看暂停任务/);
  assert.match(html,/响应未符合成果格式/);assert.match(html,/系统已准备重试/);
  assert.doesNotMatch(html,/查看进行中任务|已记录处理阶段|明确开始下一轮|充值/);
});

test('queued and input-waiting work have distinct progress copy without losing their active lock',()=>{
  for(const [state,heading]of([['queued','复核等待处理'],['awaiting_input','复核等待补充信息']] as const)){
    const current=run(state,3);assert.equal(isActiveRun(current),true);assert.equal(reviewEmptyResultText(current).heading,heading);
  }
  assert.equal(reviewEmptyResultText(run('running',3)).heading,'复核正在进行');
  const restored=task('queued',7);restored.run.stage='trial_limit';
  restored.events=[{event_id:'resume',schema_version:1,trace_id:'trace',run_id:restored.run.run_id,seq:7,occurred_at:'2026-10-04T09:12:00Z',stage:'trial_limit',type:'run.state_changed',state:'queued',payload:{reason:'trial_limit_cleared'}}];
  const html=reviewTaskHtml(restored,'2026-10-04T09:00:00Z');assert.match(html,/处理限制已解除/);assert.doesNotMatch(html,/等待处理限制解除/);
});

test('paused unknown reason and provider code use a safe fallback in current and historical task notices',()=>{
  const current=task('paused',5);current.run.stage='raw_secret_stage';
  current.events=[{event_id:'private-error',schema_version:1,trace_id:'trace',run_id:current.run.run_id,seq:5,occurred_at:'2026-10-04T09:10:00Z',stage:'raw_secret_stage',type:'run.state_changed',state:'paused',payload:{reason:'raw_secret_failure',error_code:'PRIVATE_PROVIDER_VALUE' as RunEvent['payload']['error_code']}}];
  assert.match(reviewTaskNotice(current)??'',/本轮已暂停/);
  assert.doesNotMatch(reviewTaskHtml(current,'2026-10-04T09:00:00Z'),/raw_secret_stage|raw_secret_failure|PRIVATE_PROVIDER_VALUE/);
});
