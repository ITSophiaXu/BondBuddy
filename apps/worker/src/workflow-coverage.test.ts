import test from 'node:test';
import assert from 'node:assert/strict';
import {pageCoverage} from './workflow-coverage.js';
test('coverage partitions every physical page and never invents a failure',()=>{
  assert.deepEqual(pageCoverage(5,[3,1,1],[2,3]),{page_count:5,covered:[1,3],failed:[2],missing:[4,5]});
  assert.deepEqual(pageCoverage(3,[1]),{page_count:3,covered:[1],failed:[],missing:[2,3]});
  assert.throws(()=>pageCoverage(3,[4]),/INVALID/);
});
