import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {Dto} from './api.js';
import {ApiError} from './api.js';
import {restartPolicy,taskRestartHtml,restartSavedTask,restartBatchItems} from './task-restart.js';
const run=(state='paused',stage='user_paused')=>({run_id:'saved-run',project_id:'saved-project',state,stage,input_revision:7,input_hash:'a'.repeat(64)} as Dto<'RunResponse'>);
const signal=()=>new AbortController().signal;
test('all paused stages have a discoverable restart and read-only state check; terminal and running states do not',()=>{
  for(const stage of ['user_paused','credits_exhausted','capability_not_ready','provider_reconcile','billing_reconcile','awaiting_materials','trial_limit','legacy_pause']){
    const html=taskRestartHtml(run('paused',stage));assert.match(html,/重新启动/);assert.match(html,/检查恢复状态/);assert.match(html,/saved-run/);
  }
  for(const state of ['running','queued','succeeded','failed','cancelled','awaiting_input'])assert.equal(taskRestartHtml(run(state)),'');
});
test('known zero balance blocks restart, a positive refreshed balance permits it, and reconciliation stays protected',()=>{
  assert.equal(restartPolicy(run('paused','credits_exhausted'),'0').blocked,true);
  assert.equal(restartPolicy(run('paused','credits_exhausted'),'100').blocked,false);
  for(const stage of ['provider_reconcile','billing_reconcile','awaiting_materials','trial_limit'])assert.equal(restartPolicy(run('paused',stage)).blocked,true);
});
test('restart preserves the same run and only posts resume after rereading the paused execution',async()=>{
  const calls:string[]=[];const api={run:async(id:string)=>{calls.push('read:'+id);return run();},runAction:async(id:string,action:string)=>{calls.push(action+':'+id);return run('queued','queued');}};
  const result=await restartSavedTask(api,'saved-run',signal(),()=>true);
  assert.deepEqual(calls,['read:saved-run','resume:saved-run']);assert.equal(result?.input_revision,7);assert.equal(result?.state,'queued');
});
test('another tab or automatic recovery already queued the run: do not post again',async()=>{
  let posts=0;const api={run:async()=>run('queued','queued'),runAction:async()=>{posts++;return run();}};
  assert.equal((await restartSavedTask(api,'saved-run',signal(),()=>true))?.state,'queued');assert.equal(posts,0);
});
test('unresolved provider results never invoke resume',async()=>{
  let posts=0;const api={run:async()=>run('paused','provider_reconcile'),runAction:async()=>{posts++;return run();}};
  assert.equal((await restartSavedTask(api,'saved-run',signal(),()=>true))?.state,'paused');assert.equal(posts,0);
});
test('a lost resume response is recovered by reading the same run, without a second write',async()=>{
  let reads=0,posts=0;const api={run:async()=>++reads===1?run():run('queued','queued'),runAction:async()=>{posts++;throw new ApiError(0,'DATA_UNAVAILABLE');}};
  assert.equal((await restartSavedTask(api,'saved-run',signal(),()=>true))?.state,'queued');assert.equal(posts,1);assert.equal(reads,2);
});
test('an owner or page change after the initial read prevents the mutation',async()=>{
  let posts=0;const api={run:async()=>run(),runAction:async()=>{posts++;return run('queued');}};
  assert.equal(await restartSavedTask(api,'saved-run',signal(),()=>false),undefined);assert.equal(posts,0);
});
test('mismatched and foreign run IDs cannot be resumed or accepted',async()=>{
  let posts=0;const api={run:async()=>({...run(),run_id:'foreign'}),runAction:async()=>{posts++;return run();}};
  await assert.rejects(restartSavedTask(api,'saved-run',signal(),()=>true),ApiError);assert.equal(posts,0);
});
test('permission errors do not issue recovery reads or any other writes',async()=>{
  let reads=0;const api={run:async()=>{reads++;return run();},runAction:async()=>{throw new ApiError(404,'NOT_FOUND');}};
  await assert.rejects(restartSavedTask(api,'saved-run',signal(),()=>true),ApiError);assert.equal(reads,1);
});

test('batch restart skips completed files, deduplicates child runs, and resumes the original paused item',async()=>{
 const resumed:string[]=[];const api={run:async(id:string)=>({...run(),run_id:id}),runAction:async(id:string)=>{resumed.push(id);return {...run('queued','queued'),run_id:id};}};
 const items=[{run_id:'done',state:'succeeded'},{run_id:'paused-child',state:'paused'},{run_id:'paused-child',state:'paused'},{run_id:null,state:'queued'}];
 assert.equal(await restartBatchItems(api,items,signal(),()=>true),true);assert.deepEqual(resumed,['paused-child']);
});
test('a blocked batch item prevents continuing its remaining queue',async()=>{
 let posts=0;const api={run:async()=>run('paused','provider_reconcile'),runAction:async()=>{posts++;return run();}};
 await assert.rejects(restartBatchItems(api,[{run_id:'saved-run',state:'paused'}],signal(),()=>true),/正在核对/);assert.equal(posts,0);
});
