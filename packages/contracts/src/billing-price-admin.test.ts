import assert from 'node:assert/strict';
import test from 'node:test';
import {Value} from '@sinclair/typebox/value';
import {billingPriceAdminSchemas,standardCostBaseFen,standardCostPoints} from './billing-price-admin.js';
import {isAutomaticPriceVersion} from './automatic-pricing.js';
import {OutcomePriceVersionSchema} from './outcome-pricing.js';

test('standard prices use full-precision decimal cost and two separate exact ceilings',()=>{
  assert.equal(standardCostBaseFen('7.5454800512'),'15997');
  assert.equal(standardCostPoints('15997','17000'),'27195');
  assert.equal(standardCostBaseFen('0.000000000001'),'1');
  assert.equal(standardCostPoints(standardCostBaseFen('0.000000000001'),'17000'),'2','two ceilings differ from rounding a combined float');
  assert.equal(standardCostBaseFen('1.000000000001'),'2121');
  assert.equal(standardCostPoints('15997','20000'),'31994','reprice the 1x baseline, never prior 1.7x output');
  assert.throws(()=>standardCostBaseFen('1e-3'));
  assert.throws(()=>standardCostBaseFen(1 as any));
  assert.throws(()=>standardCostPoints('15997',17000 as any));
  assert.throws(()=>standardCostPoints('15997','0'));
  assert.throws(()=>standardCostPoints('15997','1000001'));
});
test('management wire rejects JSON numbers and managed family IDs have a fixed shape',()=>{
  const draft={request_id:'synthetic',base_cost_version:'source',multiplier_bps:'17000',change_reason:'Synthetic validation'};
  assert(Value.Check(billingPriceAdminSchemas.BillingPriceDraftCreateRequest,draft));
  assert(!Value.Check(billingPriceAdminSchemas.BillingPriceDraftCreateRequest,{...draft,multiplier_bps:17000}));
  assert(!Value.Check(billingPriceAdminSchemas.BillingPriceDraftCreateRequest,{...draft,multiplier_bps:'9223372036854775808'}));
  assert(isAutomaticPriceVersion('bb-task-price-managed-'+'a'.repeat(32)));
  assert(!isAutomaticPriceVersion('bb-task-price-managed-arbitrary'));
  assert(Value.Check(OutcomePriceVersionSchema,'bb-task-price-managed-'+'a'.repeat(32)));
  assert(!Value.Check(OutcomePriceVersionSchema,'bb-task-price-managed-arbitrary'));
});
