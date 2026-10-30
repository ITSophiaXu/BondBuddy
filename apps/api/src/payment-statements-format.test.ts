import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {parsePaymentStatement,statementMoney,StatementFormatError} from './payment-statements-format.js';
import {syntheticTradeStatement,syntheticFundStatement,statementFixtureDate} from './test-payment-statements.js';
const parse=(source:string,kind:'trade'|'funds'='trade')=>parsePaymentStatement(Buffer.from(source),{billDate:statementFixtureDate,kind,merchantId:'1900000001',appId:'wx1234567890abcdef',sha1:createHash('sha1').update(source).digest('hex'),verifiedAt:'2026-10-28T04:00:00Z'});

test('modern ALL statement separates gross sale, refund application, fees and historical refund status',()=>{
  const result=parse(syntheticTradeStatement({refund:true}));
  assert.equal(result.entries.length,2);assert.equal(result.totals.nominalFen,10000);assert.equal(result.totals.refundRequestedFen,2500);assert.equal(result.totals.feeFen,45);
  assert.equal(result.entries[1].kind,'refund');if(result.entries[1].kind==='refund'){assert.equal(result.entries[1].refundStatus,'PROCESSING');assert.equal(result.entries[1].eventAt,'2026-10-27T05:00:00.000Z');}
});
test('funds statement preserves accounting direction separately from user credits',()=>{
  const result=parse(syntheticFundStatement({direction:'支出',type:'退款',amount:'25.00'}),'funds');
  assert.equal(result.totals.expenseFen,2500);assert.equal(result.totals.incomeFen,0);assert.equal(result.accountType,'BASIC');
});
test('integer CNY parsing rejects exponents, excess precision, negatives and unbounded values',()=>{
  assert.equal(statementMoney('0.01'),1);assert.equal(statementMoney('-0.15',true),-15);
  for(const value of ['1e2','1.001','-1.00','NaN','100','999999999999999.00'])assert.throws(()=>statementMoney(value),StatementFormatError);
});
test('foreign merchant, wrong currency, duplicate rows, unsupported headers and inconsistent totals stay unresolved',()=>{
  const source=syntheticTradeStatement(),lines=source.trimEnd().split(/\r?\n/);
  for(const changed of [syntheticTradeStatement({merchant:'1900000002'}),source.replace('`CNY','`USD'),source.replace('订单金额','历史总金额'),
    source.replace('`1,`100.00,`0.00','`1,`99.99,`0.00'),[lines[0],lines[1],lines[1],lines[2],lines[3]].join('\n'),source.replace('12:00:00','24:00:00')])
    assert.throws(()=>parse(changed),StatementFormatError);
});
