import assert from 'node:assert/strict';
import test from 'node:test';
import {sampleRunMemory} from './run-memory-performance.js';

test('records the highest observed cgroup memory, including the final sample',async()=>{
 const values=[100,240];
 const sampler=sampleRunMemory({readMemory:async()=>values.shift()??240,intervalMs:1000});
 const result=await sampler.stop();
 assert.equal(result.cgroup_memory_peak_bytes,240);
 assert.equal(result.resource_scope,'shared_worker_container');
 assert.equal(result.resource_availability,'cgroup_v2');
 assert.equal(result.resource_sample_count,2);
 assert.equal(result.resource_sample_error_count,0);
});

test('reports unavailable samples without fabricating a zero-byte peak',async()=>{
 const sampler=sampleRunMemory({readMemory:async()=>{throw Error('unavailable');},intervalMs:1000});
 const result=await sampler.stop();
 assert.equal(result.cgroup_memory_peak_bytes,null);
 assert.equal(result.resource_availability,'unavailable');
 assert(result.resource_sample_error_count>0);
});
