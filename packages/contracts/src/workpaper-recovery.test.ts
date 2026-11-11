import assert from 'node:assert/strict';
import {test} from 'node:test';
import {RUN_STATES} from './run-states.js';
import {workpaperItemUnfinished} from './workpaper-recovery.js';
import {generationBatchActive} from './generation-progress.js';
test('stopped queues retain nonterminal runs through settlement and require manual recovery for paused files',()=>{
  for(const state of RUN_STATES){
    const item={run_id:'current',state};
    assert.equal(workpaperItemUnfinished(item),!['succeeded','test_completed','failed','cancelled','rejected'].includes(state),state);
    for(const queue of ['cancelled','paused'])assert.equal(generationBatchActive({state:queue,items:[item]}),['queued','preparing','running','validating','delivering','settlement_pending'].includes(state),state);
  }
  assert.equal(workpaperItemUnfinished({run_id:null,state:'queued'}),false,'an unstarted item does not block retry');
});
