import assert from 'node:assert/strict';
import test from 'node:test';
import { validateRenderedPagination } from './verify-prospectus-acceptance.mjs';

const note='Synthetic pagination-only policy test; no artifact or human acceptance is claimed.';
const accepted=(source,clean)=>assert.doesNotThrow(()=>validateRenderedPagination(source,clean,note));
const rejected=(source,clean)=>assert.throws(()=>validateRenderedPagination(source,clean,note),/PROSPECTUS_ACCEPTANCE_RENDER_PAGINATION_REGRESSION/);

test('approved long-document threshold accepts exactly 70 percent, including the formerly rejected 70–80 band',()=>{
  accepted(100,70);accepted(300,210);accepted(100,79);accepted(101,71);
});
test('one page below 70 percent remains rejected when at least twenty pages were lost',()=>{
  rejected(100,69);rejected(300,209);rejected(101,70);rejected(501,350);
});
test('fifty actual source pages is the inclusive long-document page boundary',()=>{
  accepted(49,29);rejected(50,30);
});
test('nineteen lost pages alone cannot trigger the page collapse rule even below 70 percent',()=>{
  accepted(50,31);accepted(60,41);
});
test('twenty lost pages triggers rejection only together with source length and ratio conditions',()=>{
  rejected(50,30);rejected(60,40);rejected(65,45);accepted(100,80);accepted(49,29);
});
test('unchanged or expanded pagination passes this numeric check without claiming other acceptance',()=>{
  accepted(100,100);accepted(100,101);accepted(1,1);
});
test('integer ratio comparison remains exact at the safe-number boundary',()=>{
  const source=Number.MAX_SAFE_INTEGER,floor=Number(BigInt(source)*7n/10n);
  rejected(source,floor);accepted(source,floor+1);
});
test('missing, zero, negative, fractional or imprecise actual page counts cannot pass',()=>{
  for(const value of [undefined,null,'100',0,-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1]){
    assert.throws(()=>validateRenderedPagination(value,70,note),/RENDER_PAGE_COVERAGE_INCOMPLETE/);
    assert.throws(()=>validateRenderedPagination(100,value,note),/RENDER_PAGE_COVERAGE_INCOMPLETE/);
  }
});
test('the human pagination explanation is still required even when the numeric policy passes',()=>{
  for(const value of [undefined,null,'','  ','x'.repeat(1001)])assert.throws(()=>validateRenderedPagination(100,70,value),/RENDER_PAGINATION_REGRESSION/);
});
