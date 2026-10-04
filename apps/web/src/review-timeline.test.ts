import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ReviewTask, ReviewTimelineEntry, Run, RunEvent } from '@bondbuddy/contracts';
import { uniqueReviewTimeline, reviewTaskHtml, reviewTaskNotice } from './review-timeline.js';
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
