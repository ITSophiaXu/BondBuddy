import test from 'node:test';
import assert from 'node:assert/strict';
import {validateScopeLines} from './scope-quotations.js';

const line=(key='synthetic-target',quantity=2,unitPrice=1200)=>({key,label:'已确认的报告期财务表及直接受影响正文',quantity,unit:'报告期范围',unit_price_fen:unitPrice,amount_fen:quantity*unitPrice,evidence:['input:synthetic-hash; target_cutoffs=2025-12-31,2026-03-31; source=baseline-v1']});
test('scope price sums evidenced work items and allows different prices for different approved scope',()=>{
 assert.equal(validateScopeLines([line()]).total,2400);
 assert.equal(validateScopeLines([line('larger',5),line('independent-market-adaptation',1,7300)]).total,13300);
});
test('scope price refuses absent scope evidence, duplicate work and totals inconsistent with agreed quantity',()=>{
 for(const lines of [[],[{...line(),evidence:[]}],[line(),line()],[{...line(),amount_fen:1}],[{...line(),unit:' '}],[{...line(),quantity:0}]])assert.throws(()=>validateScopeLines(lines));
});
