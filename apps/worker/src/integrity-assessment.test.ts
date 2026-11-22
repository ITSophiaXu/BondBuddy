import test from 'node:test';
import assert from 'node:assert/strict';
import {validateIntegrityAssessment} from './integrity-browser-stage.js';
const subject={name:'河南合成企业',kind:'company' as const},quote='河南合成企业 被列入被执行人名单，案号（2026）合成执1号。';
const finding={capture_id:'c',quote,title:'被执行记录',explanation:'记录显示有执行案件，未载明履行情况。',nature:'adverse',subject_match:'company_name'};
const result={summary:'官网返回记录',findings:[finding]},materials=[{ref:'c',text:quote}];
test('specific findings must cite captured evidence and named-company claims need the full company name',()=>{
 assert.equal(validateIntegrityAssessment(result,subject,materials),true);
 assert.equal(validateIntegrityAssessment({...result,findings:[{...finding,quote:'其他企业 执行案件'}]},subject,[{ref:'c',text:'其他企业 执行案件'}]),false);
 assert.equal(validateIntegrityAssessment({...result,findings:[{...finding,capture_id:'missing'}]},subject,materials),false);
 assert.equal(validateIntegrityAssessment({...result,findings:[{...finding,quote:quote+'已经整改'}]},subject,materials),false);
 assert.equal(validateIntegrityAssessment(result,{...subject,kind:'person'},materials),false);
 assert.equal(validateIntegrityAssessment({...result,findings:[{...finding,subject_match:'unconfirmed'}]},{...subject,kind:'person'},materials),true);
});
