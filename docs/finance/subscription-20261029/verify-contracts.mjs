// Run after building @bondbuddy/contracts; prevent financial snapshots drifting from the product.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {AUTOMATIC_PRICE_VERSION,AUTOMATIC_TASK_TARIFF,SUBSCRIPTION_PLANS,FULL_REVIEW_PLANNED_COST_CNY} from '../../../packages/contracts/dist/index.js';

const input=JSON.parse(readFileSync(new URL('./inputs.json',import.meta.url),'utf8'));
let checks=0;
const equal=(actual,expected)=>{assert.equal(actual,expected);checks++;};
equal(input.tariff.version,AUTOMATIC_PRICE_VERSION);
for(const task of input.tariff.tasks)equal(task.points,AUTOMATIC_TASK_TARIFF[task.id].points);
for(const plan of input.funding.plans){
  const product=SUBSCRIPTION_PLANS.find(p=>p.id===plan.id);
  assert.ok(product);
  equal(plan.paidFen,product.amount_fen);
  equal(plan.points,product.points);
  equal(input.funding.pointExpiryDays,product.credit_valid_days);
}
equal(input.fullReview.points,AUTOMATIC_TASK_TARIFF.full_review.points);
equal(input.fullReview.CPlanCny,FULL_REVIEW_PLANNED_COST_CNY);
console.log(JSON.stringify({contractFinancialChecks:checks,passed:true}));
