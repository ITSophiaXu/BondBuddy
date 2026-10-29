import test from 'node:test';
import assert from 'node:assert/strict';
import type {PaymentRefundEligibility} from '@bondbuddy/contracts';
import {parseRefundInput,pointRefundPreview,refundRequestCash} from './refund-input.js';

const original=(overrides:Partial<PaymentRefundEligibility>={}):PaymentRefundEligibility=>({order_id:'original',currency:'CNY',order_amount_fen:50000,paid_amount_fen:50000,
  original_points:52500,refundable_fen:40000,refundable_points:42000,refunded_points:0,refunded_fen:0,held_refund_fen:0,request_unit:'points',enabled:true,reason:'',refunds:[],...overrides});

test('refund entry parses cash and points as distinct bounded integers',()=>{
  assert.equal(parseRefundInput('123.45','amount_fen'),12345);assert.equal(parseRefundInput('0.29','amount_fen'),29);
  assert.equal(parseRefundInput('10000.00','amount_fen'),1000000);assert.equal(parseRefundInput('42000','points'),42000);
  for(const input of ['1e3','-1','0','NaN','10000.01','0.001'])assert.equal(parseRefundInput(input,'amount_fen'),null);
  for(const input of ['1.1','1e3','-1','0','1150001'])assert.equal(parseRefundInput(input,'points'),null);
});
test('legacy paid proportion excludes the consumed part and never refunds its rounding remainder',()=>{
  assert.equal(pointRefundPreview(original(),42000),40000);
  assert.equal(pointRefundPreview(original(),42001),null);
  assert.equal(pointRefundPreview(original({refunded_points:10500,refunded_fen:10000,refundable_points:31500,refundable_fen:30000}),31500),30000);
});
test('cumulative cash rounding carries the prior successful refund cursor',()=>{
  assert.equal(pointRefundPreview(original(),1),null,'less than one cash cent does not spend points');
  assert.equal(pointRefundPreview(original(),2),1);
  assert.equal(pointRefundPreview(original({refunded_points:2,refunded_fen:1}),1),1);
  assert.equal(pointRefundPreview(original({refunded_points:52500,refunded_fen:50000}),1),null);
  assert.equal(pointRefundPreview(original({paid_amount_fen:null}),2),null);
  assert.equal(pointRefundPreview(original({refunded_points:10500,refunded_fen:9999}),2),null,'inconsistent successful cash cursor cannot be previewed');
});
test('retained refund requests preserve their original denomination and expected cash',()=>{
  assert.equal(refundRequestCash({request_id:'cash',amount_fen:19900}),19900);
  assert.equal(refundRequestCash({request_id:'points',points:42000,expected_amount_fen:40000}),40000);
  assert.equal(refundRequestCash({request_id:'old-points',points:42000}),undefined);
});
