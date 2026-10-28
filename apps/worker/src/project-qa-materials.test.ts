import test from 'node:test';
import assert from 'node:assert/strict';
import {qaMissingMaterials,qaPromptEvidence,groundedQaAnswer} from './project-qa-stage.js';
import {PROJECT_QA_PRICE,type QaInput,type QaResult} from '@bondbuddy/contracts';
const q={id:'q0',start:0,end:0,question:'请说明关联交易定价依据及偿债资金安排。'};
test('missing evidence yields question-specific requests and suppresses unsupported conclusion',()=>{
 const input={cases:[],price_version:PROJECT_QA_PRICE.version} as unknown as QaInput;
 const answer=groundedQaAnswer({question_id:q.id,answer:'不存在风险。',status:'draft',missing_materials:[],citations:[],case_ids:[],approach:''},q,input,[]);
 assert.equal(answer.status,'missing');assert.doesNotMatch(answer.answer,/不存在风险/);
 assert.match(answer.missing_materials.join(' '),/定价说明/);assert.match(answer.missing_materials.join(' '),/偿付安排/);
 assert.match(qaMissingMaterials('请解释特定的业务模式。')[0],/业务模式/);
});
test('retrieval includes units and surrounding table rows, bounded and in document order',()=>{
 const texts=['单位：万元','关联交易定价明细','交易甲 100','交易乙 200','附注：金额含税'];
 const evidence:QaResult['evidence']=[{filename:'募集书.docx',snapshot:{version:'project-file-text-v1',format:'docx',sha256:'a'.repeat(64),coverage:'complete',warnings:[],spans:texts.map((text,i)=>({id:'p'+i,text,location:String(i),sha256:'a'.repeat(64)}))}}];
 assert.deepEqual(qaPromptEvidence(q,evidence).map(e=>e.text),texts);
 evidence[0].snapshot.spans.push(...Array.from({length:500},(_,i)=>({id:'more'+i,text:'普通无关说明'.repeat(80),location:String(i),sha256:'a'.repeat(64)})));
 const selected=qaPromptEvidence(q,evidence);assert.ok(selected.some(e=>e.text==='单位：万元'));assert.ok(selected.some(e=>e.text==='附注：金额含税'));
 assert.ok(selected.length<=400);assert.ok(selected.reduce((n,e)=>n+e.text.length,0)<=120000);
});
