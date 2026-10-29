import test from 'node:test';
import assert from 'node:assert/strict';
import {add,subtract,divide,ratio,ratioJson,exactDecimal,nonnegativeDecimal,roundedDecimal,unsignedInteger} from './commerce-economics-math.js';
test('exact decimal parsing and fraction cancellation never round at intermediate steps',()=>{
 assert.equal(exactDecimal(add(nonnegativeDecimal('0.1'),nonnegativeDecimal('0.2'))),'0.3');
 assert.deepEqual(ratioJson(add(ratio(1n,3n),ratio(2n,3n))),{numerator:'1',denominator:'1'});
 assert.deepEqual(ratioJson(subtract(ratio(1n,3n),ratio(1n,3n))),{numerator:'0',denominator:'1'});
 assert.equal(exactDecimal(divide(ratio(1n),ratio(8n))),'0.125');assert.equal(exactDecimal(ratio(1n,3n)),null);
});
test('display rounding records nearest ties away from zero, including tiny negative results',()=>{
 assert.equal(roundedDecimal(ratio(1n,8n),2),'0.13');assert.equal(roundedDecimal(ratio(-1n,8n),2),'-0.13');
 assert.equal(roundedDecimal(ratio(-1n,100000000n),6),'0.000000');assert.equal(roundedDecimal(ratio(1n,3n),6),'0.333333');
 assert.equal(roundedDecimal(null,6),null);assert.equal(roundedDecimal(ratio(9999995n,1000000n),5),'10.00000');
});
test('integer and supplier decimal parsers reject already lossy or invalid inputs',()=>{
 assert.equal(unsignedInteger('9223372036854775807'),9223372036854775807n);assert.equal(unsignedInteger(12),12n);
 for(const value of ['9223372036854775808','-1','1.0','01','1e3',9007199254740992,null])assert.throws(()=>unsignedInteger(value));
 for(const value of [0.1,NaN,Infinity,'-1','1e-3','',null])assert.throws(()=>nonnegativeDecimal(value));
 assert.throws(()=>ratio(1n,0n));assert.throws(()=>divide(ratio(1n),ratio(0n)));
});
