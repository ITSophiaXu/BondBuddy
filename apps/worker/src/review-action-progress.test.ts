import assert from 'node:assert/strict';
import test from 'node:test';
import { Value } from '@sinclair/typebox/value';
import { ReviewActionSchema, type ReviewAction } from '@bondbuddy/contracts';
import { createReviewActionObserver, projectReviewAction, reviewActionMode } from './review-action-progress.js';

const event=(tool:string,type='item.started',extra:Record<string,unknown>={})=>({type,item:{id:'synthetic-item',
  type:'mcp_tool_call',server:'bb_review',tool,...extra}});
test('M3 projection uses host tool/mode evidence, safe enums and opaque attempt-specific identities',()=>{
  for(const [tool,code] of [['list_materials','read_materials'],['read_records','read_materials'],['search_material','read_materials'],
    ['read_knowledge','read_knowledge'],['check_financial','check_financial'],['check_compliance','check_compliance']]){
    const action=projectReviewAction(event(tool,undefined,{arguments:{prompt:'private'},result:{private:'secret'}}),'attempt-1','review');
    assert.ok(action);assert.equal(Value.Check(ReviewActionSchema,action),true);assert.equal(action.code,code);assert.equal(action.state,'started');
    assert.deepEqual(Object.keys(action).sort(),['action_id','code','state','version']);assert.equal(JSON.stringify(action).includes('private'),false);
    assert.notEqual(action.action_id,projectReviewAction(event(tool),'attempt-2','review')?.action_id);
  }
  assert.equal(projectReviewAction({type:'item.started',item:{id:'search',type:'web_search',query:'private'}},'a','public_search')?.code,'search_public');
  assert.equal(projectReviewAction(event('read_records',undefined,{server:'bb_materials'}),'a','public_compare')?.code,'compare_sources');
  assert.equal(projectReviewAction({type:'item.started',item:{id:'command',type:'command_execution',command:'private command'}},'a','revision')?.code,'revise_document');
  for(const rejected of [event('exec'),event('read_records',undefined,{server:'other'}),event('read_records',undefined,{id:'/private/path'}),
    event('read_records','item.updated'),{type:'item.completed',item:{id:'reason',type:'reasoning',text:'hidden'}},
    {type:'item.completed',item:{id:'reply',type:'agent_message',text:'done'}},
    {type:'item.completed',item:{id:'todo',type:'todo_list',text:'private plan'}},{type:'fake.trace',prompt:'private'},
    event('read_records','item.completed',{status:'unknown'})])assert.equal(projectReviewAction(rejected,'a','review'),null);
  assert.equal(projectReviewAction(event('check_financial'),'a','public_search'),null);
  for(const [call,mode] of [['review-cli-v3-abcd','review'],['m3-public-search-v2','public_search'],['m3-public-compare-v2','public_compare'],
    ['review-revision-cli-v1','revision']])assert.equal(reviewActionMode(call),mode);
  for(const call of ['unified-v3-abcd','project-assistant','review-cli-unknown','review-cli-v3-/private'])assert.equal(reviewActionMode(call),undefined);
});

test('completed items with errors are failed actions, never completed checks',()=>{
  for(const extra of [{status:'failed'},{error:{message:'private'}},{result:{isError:true}},
    {result:{structuredContent:{status:'error',message:'private'}}},{result:{output:{isError:true}}},{output:{error:'private'}}]){
    const action=projectReviewAction(event('check_financial','item.completed',extra),'a','review');
    assert.equal(action?.state,'failed');assert.equal(JSON.stringify(action).includes('private'),false);
  }
  assert.equal(projectReviewAction(event('check_financial','item.completed',{result:{isError:false},status:'completed'}),'a','review')?.state,'completed');
  assert.equal(projectReviewAction({type:'item.completed',item:{id:'cmd',type:'command_execution',exit_code:1}},'a','revision')?.state,'failed');
});

test('observer serializes and drains bounded progress, deduplicates replays and ignores terminal regressions',async()=>{
  const saved:ReviewAction[]=[],abort=new AbortController();let release!:()=>void,active=0,maxActive=0;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const observer=createReviewActionObserver({mode:'review',signal:abort.signal,maxPending:4,persist:async action=>{
    active++;maxActive=Math.max(maxActive,active);if(!saved.length)await gate;saved.push(action);active--;
  }});
  observer.onEvent(event('read_records'),{call_id:'a'});
  for(let i=0;i<200;i++)observer.onEvent(event('read_records','item.started',{id:`tool-${i}`}),{call_id:'a'});
  let drained=false;const finished=observer.drain().then(()=>{drained=true;});await Promise.resolve();assert.equal(drained,false);
  release();await finished;assert.equal(maxActive,1);assert.equal(saved.length,5);
  assert.equal(saved.at(-1)?.action_id,projectReviewAction(event('read_records','item.started',{id:'tool-199'}),'a','review')?.action_id);
  observer.onEvent(event('check_financial'),{call_id:'a'});assert.equal(saved.length,5,'closed observer rejects late events');
  const replayed:ReviewAction[]=[];
  const replay=createReviewActionObserver({mode:'review',signal:abort.signal,persist:async action=>{replayed.push(action);}});
  for(const type of ['item.started','item.started','item.completed','item.completed','item.started'])replay.onEvent(event('read_records',type),{call_id:'a'});
  await replay.drain();assert.deepEqual(replayed.map(action=>action.state),['started','completed']);
});

test('abort drops queued activity, and progress storage/diagnostic failure does not alter execution',async()=>{
  const saved:ReviewAction[]=[],abort=new AbortController();let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const observer=createReviewActionObserver({mode:'review',signal:abort.signal,persist:async action=>{await gate;saved.push(action);}});
  observer.onEvent(event('read_records'),{call_id:'a'});observer.onEvent(event('check_financial',undefined,{id:'next'}),{call_id:'a'});
  abort.abort();release();await observer.drain();assert.equal(saved.length,1,'only the already in-flight write can reach the lease guard');
  let errors=0;
  const failing=createReviewActionObserver({mode:'review',signal:new AbortController().signal,
    persist:async()=>{throw Error('private database failure');},onError:()=>{errors++;throw Error('private log failure');}});
  assert.doesNotThrow(()=>failing.onEvent(event('read_records'),{call_id:'a'}));await failing.drain();assert.equal(errors,1);
});
