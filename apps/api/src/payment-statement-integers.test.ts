import assert from 'node:assert/strict';
import test from 'node:test';
import {statementInteger,statementAbsolute} from './payment-statement-integers.js';

test('statement comparisons retain exact safe numbers and canonical signed int64 values',()=>{
  for(const value of [0,1,-1,Number.MAX_SAFE_INTEGER,Number.MIN_SAFE_INTEGER]){
    assert.equal(statementInteger(value),BigInt(value));
  }
  for(const value of ['0','1','-1','9007199254740992','9007199254740993',
    '9223372036854775807','-9223372036854775808']){
    assert.equal(statementInteger(value),BigInt(value));
  }
  assert.notEqual(statementInteger('9007199254740992'),statementInteger('9007199254740993'));
  assert.equal(statementInteger((1n<<63n)-1n),(1n<<63n)-1n);
  assert.equal(statementInteger(-(1n<<63n)),-(1n<<63n));
});

test('statement integers reject missing, coerced, rounded and out-of-int64 evidence',()=>{
  for(const value of [null,undefined,true,false,{},[],NaN,Infinity,-Infinity,0.5,-1.5,
    Number.MAX_SAFE_INTEGER+1,Number.MIN_SAFE_INTEGER-1,'',' ','01','-0','+1','1.0','1e3','1 ',
    '9223372036854775808','-9223372036854775809',1n<<63n,-(1n<<63n)-1n]){
    assert.throws(()=>statementInteger(value),Error,'value must remain invalid rather than becoming a financial amount: '+String(value));
  }
});

test('absolute statement fees preserve precision and reject INT64_MIN overflow',()=>{
  assert.equal(statementAbsolute('0'),0n);
  assert.equal(statementAbsolute('-9007199254740993'),9007199254740993n);
  assert.equal(statementAbsolute('-9223372036854775807'),9223372036854775807n);
  assert.throws(()=>statementAbsolute('-9223372036854775808'),/int64/);
  assert.throws(()=>statementAbsolute(Number.MAX_SAFE_INTEGER+1),/exact/);
});
