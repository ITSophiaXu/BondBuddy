import test from 'node:test';
import assert from 'node:assert/strict';
import {generationBatchActive} from './generation-progress.js';

test('paused and stopped batches keep polling while an admitted file settles',()=>{
  for(const state of ['paused','cancelled']){
    assert.equal(generationBatchActive({state,items:[{state:'settlement_pending',run_id:'r'}]}),true);
    assert.equal(generationBatchActive({state,items:[{state:'succeeded',run_id:'r'}]}),false);
    assert.equal(generationBatchActive({state,items:[{state:'queued',run_id:null}]}),false);
    assert.equal(generationBatchActive({state,items:[{state:'paused',run_id:'r'}]}),false);
  }
});
