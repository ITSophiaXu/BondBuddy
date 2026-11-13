import test from 'node:test';
import assert from 'node:assert/strict';
import {authoringPhase,authoringStatusCard,authoringStatusRecords,retryExplanation} from './authoring-status.js';
import type {Run,RunEvent} from './billing-types.js';
const run={run_id:'r',state:'paused',stage:'provider_reconcile',event_cursor:5,input_revision:2,artifact_id:null} as Run;
const event=(state:Run['state'],stage:string,reason?:string)=>({run_id:'r',event_id:'e',seq:5,schema_version:1,trace_id:'t',occurred_at:'2026-11-13T01:42:00Z',state,stage,type:'run.state_changed',payload:{reason}} as RunEvent);
test('pause exposes its real phase and only successful delivery completes all five steps',()=>{
  const paused=authoringStatusCard(run,[],{actions:'<button>立即重试</button>'});
  assert.match(paused,/data-tone="paused"/);assert.match(paused,/编制募集书时暂停/);
  assert.equal((paused.match(/data-step-state="done"/g)??[]).length,2);
  assert.equal((paused.match(/data-step-state="future"/g)??[]).length,2);
  const success=authoringStatusCard({...run,state:'succeeded',artifact_id:'a'},[],{actions:''});
  assert.equal((success.match(/data-step-state="done"/g)??[]).length,5);
  assert.match(success,/募集书已编制完成/);
  const missing=authoringStatusCard({...run,state:'succeeded'},[],{actions:''});
  assert.match(missing,/文档尚未同步/);assert.doesNotMatch(missing,/5 个步骤全部完成/);
  assert.equal(authoringPhase({...run,state:'queued',stage:'queued'},[event('queued','queued','file_authoring_payload_retry_scheduled')]),2);
  assert.equal(authoringPhase({...run,state:'failed'},[],undefined,3),3);
});
test('unknown pause never invents saved work or automatic recovery, and text is escaped',()=>{
  const html=authoringStatusCard(run,[],{actions:'',summary:'结果尚未确认 <img src=x>',retry:{run_id:'r',attempt_id:'a',mode:'restart_materials',reason_code:'restart_confirmation_required'}});
  assert.doesNotMatch(html,/工作进度已保存|恢复后会从第|<img/);assert.match(html,/&lt;img/);
  assert.match(html,/原材料重新处理/);
  assert.match(retryExplanation({run_id:'r',attempt_id:'a',mode:'blocked',reason_code:'active_attempt'}),/暂|尚未确认/);
});

test('waiting for input and billing checks preserve the actual unfinished stage',()=>{
  const waiting=authoringStatusCard({...run,state:'awaiting_input',stage:'awaiting_materials'},[],{actions:''});
  assert.match(waiting,/等待补充信息/);assert.doesNotMatch(waiting,/编制募集书时暂停/);
  const billing={...run,stage:'billing_reconcile'};
  assert.equal(authoringPhase(billing,[]),0);
  assert.equal(authoringPhase(billing,[event('queued','queued')]),0);
  assert.equal(authoringPhase(billing,[event('running','provider_call')]),2);
  assert.equal(authoringPhase(billing,[event('delivering','word_delivery')]),3);
});
test('records isolate run and event cursor, with lifecycle badges and collapsed material-independent markup',()=>{
  const rows=[event('paused','provider_reconcile'),{...event('succeeded','completed'),event_id:'foreign',run_id:'other'},
    {...event('succeeded','completed'),event_id:'future',seq:6}];
  const html=authoringStatusRecords(run,rows);
  assert.match(html,/处理记录（1 条）/);assert.match(html,/data-tone="paused"/);
  assert.doesNotMatch(html,/文档已保存/);assert.match(html,/datetime="2026-11-13/);
});

test('output limit continuation and confirmed material restart keep the authoring phase',()=>{
  for(const reason of ['file_authoring_output_limit_retry_scheduled','file_authoring_manual_restart_scheduled']){
    const queued={...run,state:'queued' as const,stage:'queued'};
    const events=[event('queued','queued',reason)];
    assert.equal(authoringPhase(queued,events),2);
    const html=authoringStatusCard(queued,events,{actions:''});
    assert.equal((html.match(/data-step-state="done"/g)??[]).length,2);
    assert.match(html,/data-step-state="current"[^>]*aria-current="step"[^>]*>[\s\S]*编制募集书/);
  }
});

test('unresolved provider evidence does not assert an active process or an unconfirmed exit',()=>{
  const unresolved=retryExplanation({run_id:'r',attempt_id:'a',mode:'blocked',reason_code:'provider_evidence_unresolved'});
  assert.match(unresolved,/调用记录尚需核对/);
  assert.doesNotMatch(unresolved,/仍在运行|退出状态|终止|已结束|工作进度已保存|自动继续/);
  assert.match(retryExplanation({run_id:'r',attempt_id:'a',mode:'blocked',reason_code:'active_attempt'}),/仍在运行或退出状态尚未确认/);
});

test('output limit unavailable and exhausted are failed terminal states with one material retention note',()=>{
  for(const reason of ['file_authoring_output_limit_recovery_unavailable','file_authoring_output_limit_retries_exhausted']){
    const html=authoringStatusCard({...run,state:'failed',stage:'failed'},[event('failed','failed',reason)],{actions:'',summary:'本次未能完成，请联系支持处理。'});
    assert.match(html,/data-tone="failed"/);assert.match(html,/本轮未完成/);
    assert.doesNotMatch(html,/已暂停|关闭页面不会取消任务|立即重试/);
    assert.equal((html.match(/已保存的材料会保留/g)??[]).length,1);
    assert.equal((html.match(/data-step-state="done"/g)??[]).length,2);
  }
});
