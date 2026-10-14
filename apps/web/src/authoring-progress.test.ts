import test from 'node:test';
import assert from 'node:assert/strict';
import type {AuthoringActivity,AuthoringProgress,Run,RunEvent} from '@bondbuddy/contracts';
import {authoringEventLabel,authoringStatus,authoringVisibleEvents,retainAuthoringEvents} from './authoring-progress.js';

const at='2026-10-14T05:41:00Z';
const run={run_id:'run',state:'running',stage:'file_authoring',event_cursor:1000} as Run;
const progress={sampled_at:'2026-10-14T05:41:10Z',last_activity_at:at,clock_running:true,active_ms:10000} as AuthoringProgress;
const summary='已完成目录核对，正在更新财务章节。';
function event(seq:number,activity?:Partial<AuthoringActivity>,extra:Partial<RunEvent>={}):RunEvent{
  return {event_id:`event-${seq}`,schema_version:1,trace_id:'trace',run_id:run.run_id,seq,occurred_at:at,
    type:activity?'run.progress':'run.state_changed',state:'running',stage:run.stage,
    payload:activity?{authoring_activity:{activity_id:seq.toString(16).padStart(64,'0'),code:'process_document',state:'completed',...activity}}:{},...extra};
}

test('bounded retention keeps model summaries and failures through a burst and replay',()=>{
  const source=[event(1,{code:'write_document',state:'started',summary}),event(2,{state:'failed'}),
    ...Array.from({length:100},(_,i)=>event(i+3,{state:i%2?'completed':'started'}))];
  let retained:RunEvent[]=[];
  for(const e of source)retained=retainAuthoringEvents([...retained,e]);
  assert.ok(retained.length<=36);
  assert.equal(retained[0].payload.authoring_activity?.summary,summary);
  assert.equal(retained[1].payload.authoring_activity?.state,'failed');
  assert.deepEqual(retainAuthoringEvents([...retained,...retained]),retained);
  const visible=authoringVisibleEvents(run,retained);
  assert.deepEqual(visible.map(e=>e.seq),[1,2,102]);
  assert.doesNotMatch(visible.map(authoringEventLabel).join(' '),/已完成一次/);
  assert.match(authoringEventLabel(visible.at(-1)!)!,/处理步骤已返回/);
});

test('ordinary operations cannot crowd out six recent meaningful history entries',()=>{
  const source=Array.from({length:20},(_,i)=>event(i+1,{summary:`合成进度 ${i+1}`}));
  source.push(event(21,{}),event(22,{}),event(23,{}));
  assert.deepEqual(authoringVisibleEvents(run,source).map(e=>e.seq),[16,17,18,19,20,23]);
  source.push(event(24,undefined,{state:'paused',stage:'user_paused'}));
  assert.deepEqual(authoringVisibleEvents({...run,state:'paused',stage:'user_paused'},source).map(e=>e.seq),[16,17,18,19,20,24]);
});

test('public summary remains the main status after generic tools, even while tools keep arriving',()=>{
  const events=[event(1,{code:'write_document',state:'started',summary}),event(2,{})];
  const current=authoringStatus(run,events,progress)!;
  assert.equal(current.title,'正在编制募集书内容');
  assert.equal(current.summary,`最近一次模型进度：${summary}`);
  const stale=authoringStatus(run,events,{...progress,sampled_at:'2026-10-14T05:43:00Z',last_activity_at:'2026-10-14T05:43:00Z'})!;
  assert.match(stale.summary,/暂未收到新的进度说明/);
  assert.match(stale.summary,/已完成目录核对/);
  assert.doesNotMatch(stale.summary,/模型仍在处理|已收到模型本次处理结果/);
});

test('without a public summary report its absence instead of inventing progress',()=>{
  for(const events of [[],[event(1,{})]]){
    assert.match(authoringStatus(run,events,progress)!.summary,/暂未收到模型的具体进度说明/);
  }
});

test('old stages, other runs, future events and summaries before resume cannot become current progress',()=>{
  const events=[event(1,{summary},{stage:'materials_ready'}),event(2,{summary},{run_id:'other'}),event(1001,{summary})];
  assert.doesNotMatch(authoringStatus(run,events,progress)!.summary,/已完成目录核对/);
  assert.deepEqual(authoringVisibleEvents(run,events).map(e=>e.seq),[1]);
  const resumed=[event(1,{summary}),event(2,undefined,{stage:'user_paused',state:'paused'}),
    event(3,undefined,{payload:{reason:'user_resumed'}}),event(4,{})];
  assert.match(authoringStatus(run,resumed,progress)!.summary,/暂未收到模型的具体进度说明/);
  assert.match(authoringStatus({...run,stage:'word_delivery'},[event(1,{summary})],progress)!.title,/保存 Word/);
});

test('failure, connection, pause, queue and terminal states take precedence over old summaries',()=>{
  const events=[event(1,{summary}),event(2,{state:'failed'})];
  assert.equal(authoringStatus(run,events,progress)!.title,'本次处理遇到问题');
  assert.match(authoringStatus(run,events,{...progress,clock_running:false})!.summary,/执行连接正在恢复/);
  assert.match(authoringStatus(run,events,{...progress,pause_requested:true})!.title,/保存进度后暂停/);
  assert.match(authoringStatus(run,events,{...progress,credit_exhausted:true})!.title,/积分已用完/);
  assert.equal(authoringStatus({...run,state:'paused',stage:'user_paused'},events,progress)!.title,'任务已暂停');
  assert.match(authoringStatus({...run,state:'queued'},events,{...progress,queued_at:at,queue_ahead:2})!.summary,/排队期间不消耗积分/);
  for(const state of ['succeeded','failed','cancelled'] as const)assert.equal(authoringStatus({...run,state},events,progress),undefined);
});
