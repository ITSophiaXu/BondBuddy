import test from 'node:test';
import assert from 'node:assert/strict';
import {Value} from '@sinclair/typebox/value';
import {Int64Schema,PositiveInt64Schema,BILLING_INT64_MAX,parseInt64,int64,serializeInt64,safeBillingNumber,addInt64,subtractInt64,minInt64,shortageInt64,formatPoints,formatFen,parseYuanToFen} from './billing-integers.js';

test('wire schema and strict parser accept exactly canonical nonnegative int64 strings',()=>{
  for(const value of ['0','1','999999999999999999','1000000000000000000','9007199254740991','9007199254740992',BILLING_INT64_MAX.toString()]){
    assert.equal(Value.Check(Int64Schema,value),true,value);assert.equal(serializeInt64(parseInt64(value)),value);
  }
  for(const value of [0,1,9007199254740992,NaN,Infinity,null,undefined,'',' 1','1 ','01','-0','-1','+1','1.0','1e3','9223372036854775808','9999999999999999999','10000000000000000000']){
    assert.equal(Value.Check(Int64Schema,value),false,String(value));assert.throws(()=>parseInt64(value),RangeError,String(value));
  }
  assert.equal(Value.Check(PositiveInt64Schema,'0'),false);assert.equal(Value.Check(PositiveInt64Schema,'1'),true);
});
test('schema int64 upper bound is exact at every decimal prefix',()=>{
  for(let position=0;position<19;position++){
    const step=10n**BigInt(position);
    for(const value of [BILLING_INT64_MAX-step,BILLING_INT64_MAX+step])
      assert.equal(Value.Check(Int64Schema,value.toString()),value<=BILLING_INT64_MAX,value.toString());
  }
});
test('legacy/config narrowing is explicit and never rounds a quantity',()=>{
  assert.equal(int64(123),123n);assert.equal(safeBillingNumber('123',123),123);assert.equal(safeBillingNumber('9007199254740991'),Number.MAX_SAFE_INTEGER);
  assert.throws(()=>int64(9007199254740992));assert.throws(()=>int64(-1));assert.throws(()=>safeBillingNumber('124',123));assert.throws(()=>safeBillingNumber('9007199254740992'));
});
test('account sums, per-lot differences and shortage use BigInt with checked overflow',()=>{
  assert.equal(addInt64('9007199254740991','2'),9007199254740993n);
  assert.equal(subtractInt64('9007199254740993','9007199254740991'),2n);
  assert.equal(minInt64('9007199254740993',2n),2n);assert.equal(shortageInt64('2','9007199254740993'),0n);
  assert.throws(()=>addInt64(BILLING_INT64_MAX,1n));assert.throws(()=>subtractInt64(1n,2n));
});
test('points and CNY formatting and input parsing do not use floating-point currency',()=>{
  assert.equal(formatPoints('9007199254740993'),'9,007,199,254,740,993');
  assert.equal(formatFen('9223372036854775807'),'¥92,233,720,368,547,758.07');
  assert.equal(parseYuanToFen('92233720368547758.07'),'9223372036854775807');assert.equal(parseYuanToFen('0.1'),'10');
  for(const value of ['92233720368547758.08','0.001','1e2',1.01,'-1','01',' 1'])assert.throws(()=>parseYuanToFen(value));
});
