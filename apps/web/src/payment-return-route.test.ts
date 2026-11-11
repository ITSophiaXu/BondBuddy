import assert from 'node:assert/strict';
import test from 'node:test';
import {alipayReturnRoute,paymentLoginReturn} from './payment-return-route.js';

test('only the candidate order survives the provider return; success, amount and redirect claims are discarded',()=>{
  assert.equal(alipayReturnRoute('?out_trade_no=order_123&trade_status=TRADE_SUCCESS&total_amount=999&return_to=https://evil.example&sign=private'), '#/account?order=order_123&payment_return=alipay');
  for(const query of ['','?out_trade_no=','?out_trade_no=a&out_trade_no=b','?out_trade_no=%3Cimg%3E','?out_trade_no=..%2Forder','?out_trade_no='+ 'a'.repeat(129)])assert.equal(alipayReturnRoute(query),undefined);
});
test('login resumes only the exact payment account route without retaining an arbitrary destination',()=>{
  assert.equal(paymentLoginReturn('#/account?payment_return=alipay&order=order-123&return_to=https://evil.example'), '#/account?order=order-123&payment_return=alipay');
  for(const hash of ['#tasks?order=a&payment_return=alipay','#/account?order=a','#/account?order=a&order=b&payment_return=alipay','#/account?order=a&payment_return=alipay&payment_return=alipay'])assert.equal(paymentLoginReturn(hash),undefined);
});
