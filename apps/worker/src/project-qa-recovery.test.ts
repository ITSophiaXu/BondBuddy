import test from 'node:test';
import assert from 'node:assert/strict';
import {PROJECT_QA_PRICE,type QaInput,type QaAnswer} from '@bondbuddy/contracts';
import {inputManifestHash} from '@bondbuddy/api/production-rule-pin';
import {qaRecoveryScope,validQaRecovery,QA_ANSWER_TEMPLATE} from './project-qa-recovery.js';

const asset={kind:'material' as const,pin:{source_project_id:'project',material_id:'material',material_version:1,sha256:'a'.repeat(64)}};
const input:QaInput={version:'project-qa-v1',operation:'answer',project_name:'Synthetic',source:{filename:'Questions.docx',asset},
 preparation_id:'prep',questions:[{id:'q0',start:0,end:0,question:'请说明收入'}],materials:[{filename:'Source.docx',asset}],requirements:'仅回答本题',cases:[],price_version:PROJECT_QA_PRICE.version,points:60};
const answer:QaAnswer={question_id:'q0',answer:'收入为 0 元。',status:'draft',missing_materials:[],citations:[{asset_index:0,span_id:'p0',quote:'收入为 0 元。'}],case_ids:[],approach:''};
const row=()=>({run_id:'earlier',manifest:structuredClone(input),input_hash:inputManifestHash(input),run_hash:inputManifestHash(input),answer:structuredClone(answer),sha256:inputManifestHash(answer),template_version:QA_ANSWER_TEMPLATE});

test('recovery requires unchanged semantic inputs and verified answer hashes, policy, question and grounding',()=>{
 assert.equal(validQaRecovery(row(),input,'q0',()=>true),true);
 assert.equal(validQaRecovery({...row(),template_version:'project-qa-direct-answer-v6'},input,'q0',()=>true),true);
 assert.equal(validQaRecovery({...row(),template_version:'project-qa-direct-answer-v5'},input,'q0',()=>true),false);
 assert.equal(validQaRecovery({...row(),run_hash:'b'.repeat(64)},input,'q0',()=>true),false);
 assert.equal(validQaRecovery({...row(),sha256:'b'.repeat(64)},input,'q0',()=>true),false);
 assert.equal(validQaRecovery(row(),input,'other-question',()=>true),false);
 assert.equal(validQaRecovery(row(),input,'q0',()=>false),false);
 assert.equal(validQaRecovery({...row(),manifest:{}},input,'q0',()=>true),false);
 const changedInputs=[{...input,requirements:'新要求'},{...input,project_name:'Other'},
  {...input,questions:[{...input.questions[0],question:'说明利润'}]},
  {...input,materials:[{...input.materials[0],asset:{...asset,pin:{...asset.pin,sha256:'b'.repeat(64)}}}]},
  {...input,source:{...input.source,filename:'Different questions.docx'}},{...input,preparation_id:'new-preparation'}];
 for(const changed of changedInputs)assert.equal(validQaRecovery(row(),changed,'q0',()=>true),false);
 assert.equal(qaRecoveryScope(input),qaRecoveryScope({...input,points:0}),'new quote amounts do not change answer content');
 const tampered=row();tampered.answer.answer='篡改答案';assert.equal(validQaRecovery(tampered,input,'q0',()=>true),false);
});
