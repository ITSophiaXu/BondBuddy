import assert from 'node:assert/strict';
import test from 'node:test';
import {cumulativeRefundFen} from './payment-refund-calculation.js';

test('original consideration excludes consumed cash and rounds cumulative partial refunds exactly',()=>{
  assert.equal(cumulativeRefundFen(50000,52500,0,0,42000),40000);
  let r=0,f=0;
  for(const points of [2,...Array(19).fill(1),52479]){
    const cash=cumulativeRefundFen(50000,52500,r,f,points);assert.ok(cash>=1);
    r+=points;f+=cash;assert.equal(f,Number(BigInt(50000)*BigInt(r)/BigInt(52500)));
  }
  assert.equal(r,52500);assert.equal(f,50000);
  assert.equal(cumulativeRefundFen(50000,52500,0,0,1),0,'A sub-cent request leaves credits available for a larger request');
  assert.equal(cumulativeRefundFen(50000,52500,42000,40000,10500),10000,'Restored credits use the original basis');
});
test('integer arithmetic does not lose precision and rejects invalid cumulative cursors',()=>{
  const a=Number.MAX_SAFE_INTEGER,q=a-2;
  assert.equal(cumulativeRefundFen(a,q,0,0,q),a);
  for(const args of [[50000,52500,42000,40000,10501],[50000,52500,42000,39999,1],
    [50000,52500,0,0,-1],[50000,52500,0,0,1.1],[NaN,52500,0,0,1],[Infinity,52500,0,0,1],
    [50000,0,0,0,1],[50000,52500,0,0,Number.MAX_SAFE_INTEGER+1]]){
    assert.throws(()=>cumulativeRefundFen(...args as [number,number,number,number,number]),RangeError);
  }
});
