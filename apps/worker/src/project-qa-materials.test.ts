import test from 'node:test';
import assert from 'node:assert/strict';
import {qaMissingMaterials,qaPromptEvidence,groundedQaAnswer,qaHasGroundedCitations} from './project-qa-stage.js';
import {PROJECT_QA_PRICE,type QaInput,type QaResult} from '@bondbuddy/contracts';
import {qaEvidenceContext,qaModelEvidenceContext,qaAnswerInstructions} from './project-qa-evidence.js';
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
 assert.ok(selected.reduce((n,e)=>n+e.text.length,0)<=120000);
});

const snapshot=(texts:{text:string;location?:string}[]):QaResult['evidence'][number]=>({filename:'合成募集书.docx',snapshot:{version:'project-file-text-v1',format:'docx',sha256:'a'.repeat(64),coverage:'complete',warnings:[],spans:texts.map((s,i)=>({id:'p'+i,location:s.location??`段落 ${i+1}`,sha256:'a'.repeat(64),...s}))}});

test('a short prospectus with over 400 cells remains complete including its last disclosure',()=>{
 const facts=snapshot([...Array.from({length:650},(_,i)=>({text:String(i),location:`表格 1 / 行 ${Math.floor(i/5)+1} / 列 ${i%5+1}`})),{text:'附注：交易金额含税，结算期为半年。'}]);
 const context=qaEvidenceContext(q,[facts],0);
 assert.equal(context.materials.length,651);assert.equal(context.selection[0].omitted_spans,0);
 assert.equal(context.materials.at(-1)?.text,'附注：交易金额含税，结算期为半年。');
});

test('table blanks remain distinct from zero and a dash in selected evidence',()=>{
 const evidence=[snapshot(['项目','2024年','2025年','应收款','0',''].map((text,i)=>({text,location:`表格 1 / 行 ${Math.floor(i/3)+1} / 列 ${i%3+1}`})).concat([{text:'-',location:'表格 1 / 行 3 / 列 2'}]))];
 assert.deepEqual(qaPromptEvidence(q,evidence).map(s=>s.text),['项目','2024年','2025年','应收款','0','','-']);
});

test('model evidence removes repeated metadata without losing cells, locators or asset identity',()=>{
 const facts=snapshot(['项目','2024年','2025年','应收款','0',''].map((text,i)=>({text,location:`表格 1 / 行 ${Math.floor(i/3)+1} / 列 ${i%3+1}`})));
 const second=snapshot([{text:'附注：金额含税。'}]);
 const full=qaEvidenceContext(q,[facts,second],0),compact=qaModelEvidenceContext(q,[facts,second],0);
 assert.deepEqual(compact.selection,full.selection);
 assert.deepEqual(compact.materials.flatMap(e=>e.spans.map(([id,location,text])=>({asset_index:e.asset_index,id,location,text}))),full.materials.map(({asset_index,id,location,text})=>({asset_index,id,location,text})));
 assert.ok(JSON.stringify(compact).length<JSON.stringify(full).length/2);
});

test('long documents retain complete matching tables, units, notes and distant explanations',()=>{
 const filler=Array.from({length:450},()=>({text:'普通背景介绍。'.repeat(70)}));
 const facts=snapshot([...filler,{text:'关联交易定价明细'},{text:'单位：万元'},
  ...Array.from({length:90},(_,i)=>({text:i===0?'项目':i===1?'2024年度':`交易${i} 金额${i*100}`,location:`表格 1 / 行 ${Math.floor(i/3)+1} / 列 ${i%3+1}`})),
  {text:'附注：金额含税，向下取整。'},...filler,{text:'关联交易定价采用市场可比价格；本期偿债资金来自经营回款。'}]);
 const context=qaEvidenceContext(q,[facts],0),selected=context.materials;
 assert.equal(selected.filter(s=>s.location.startsWith('表格 1')).length,90);
 for(const phrase of ['单位：万元','附注：金额含税','市场可比价格'])assert.ok(selected.some(s=>s.text.includes(phrase)),phrase);
 assert.ok(context.selection[0].omitted_spans>0);assert.deepEqual(context.selection[0].partial_tables,[]);
 assert.ok(selected.reduce((n,s)=>n+s.text.length,0)<=120000);
});

test('adopted prospectus is not crowded out by repetitive supplement matches',()=>{
 const supplement=snapshot(Array.from({length:500},()=>({text:'关联交易定价偿债资金。'.repeat(60)})));
 const prospectus=snapshot([{text:'募集说明书披露关联交易定价采用市场可比价格，偿债资金为经营回款。'},{text:'附注：结算含税。'}]);
 const context=qaEvidenceContext(q,[supplement,prospectus],1);
 assert.equal(context.materials.filter(s=>s.asset_index===1).length,2);
 assert.equal(context.selection[1].role,'prospectus');assert.equal(context.selection[1].omitted_spans,0);
});

test('unreadable assets and oversized tables report selection limits without claiming absence',()=>{
 const facts=snapshot([{text:'关联交易定价明细'},...Array.from({length:90},(_,i)=>({text:(i===0?'报告期间':`关联交易定价${i}。`)+ '长文本'.repeat(600),location:`表格 1 / 行 ${i+1} / 列 1`}))]);
 const unreadable=snapshot([]);unreadable.snapshot.coverage='partial';
 const context=qaEvidenceContext(q,[facts,unreadable],0);
 assert.ok(context.materials.some(s=>s.text.includes('报告期间')));
 assert.deepEqual(context.selection[0].partial_tables,['表格 1']);
 assert.equal(context.selection[1].selected_spans,0);assert.equal(context.selection[1].extraction_coverage,'partial');
 assert.ok(context.materials.reduce((n,s)=>n+s.text.length,0)<=120000);
});

test('fact-first policy retains grounded table answers and only the local unresolved question',()=>{
 const evidence=[snapshot([{text:'募集资金5亿元偿还到期债务，3亿元补充营运资金。'}])],input={cases:[]} as unknown as QaInput;
 const proposal={question_id:q.id,answer:'单位：亿元\n|用途|金额|\n|---|---|\n|偿债|5|\n|营运资金|3|',status:'draft' as const,missing_materials:[],citations:[{asset_index:0,span_id:'p0',quote:evidence[0].snapshot.spans[0].text}],case_ids:[],approach:''};
 assert.deepEqual(groundedQaAnswer(proposal,q,input,evidence),proposal);
 const partial={...proposal,status:'missing' as const,answer:proposal.answer+'\n【待确认：2026年10月末实际使用金额】',missing_materials:['2026年10月末募集资金实际使用金额。']};
 assert.deepEqual(groundedQaAnswer(partial,q,input,evidence),partial);
 assert.match(qaAnswerInstructions,/missing_materials=\[\]/);assert.match(qaAnswerInstructions,/不要因未提供审计底稿/);
 assert.match(qaAnswerInstructions,/Markdown 表格/);assert.match(qaAnswerInstructions,/不预设必须有多少题/);
});

test('a unique verbatim quote repairs a locator typo, but ambiguous or invented quotes remain missing',()=>{
 const evidence=[snapshot([{text:'募集资金5亿元偿还到期债务。'},{text:'重复文字'},{text:'重复文字'}])],input={cases:[]} as unknown as QaInput;
 const proposal={question_id:q.id,answer:'募集资金5亿元偿还到期债务。',status:'draft' as const,missing_materials:[],citations:[{asset_index:0,span_id:'wrong',quote:'募集资金5亿元偿还到期债务。'}],case_ids:[],approach:''};
 const repaired=groundedQaAnswer(proposal,q,input,evidence);
 assert.equal(qaHasGroundedCitations(proposal,evidence),true);
 assert.equal(repaired.status,'draft');assert.equal(repaired.citations[0].span_id,'p0');assert.deepEqual(repaired.missing_materials,[]);
 for(const quote of ['重复文字','募集资金9亿元',' ']){
  assert.equal(qaHasGroundedCitations({...proposal,citations:[{asset_index:0,span_id:'wrong',quote}]},evidence),false);
  const rejected=groundedQaAnswer({...proposal,citations:[{asset_index:0,span_id:'wrong',quote}]},q,input,evidence);
  assert.equal(rejected.status,'missing');assert.equal(rejected.citations.length,0);
  assert.match(rejected.missing_materials[0],/不代表该事项未披露/);
  assert.doesNotMatch(rejected.missing_materials.join(' '),/合同|审计报告|凭证/);
 }
 assert.equal(qaHasGroundedCitations({...proposal,citations:[]},evidence),false);
 assert.equal(qaHasGroundedCitations({...proposal,citations:[{asset_index:0,span_id:'p0',quote:'募集资金5亿元偿还到期债务。保证不存在风险。'}]},evidence),false);
});

test('an unanswered question retains local requests and discards all uncited model prose',()=>{
 const evidence=[snapshot([{text:'募集资金5亿元偿还到期债务。'}])],input={cases:[]} as unknown as QaInput;
 const proposal={question_id:q.id,answer:'无依据的结论：回款率100%。',status:'missing' as const,missing_materials:['2026年10月末实际回款金额。'],citations:[],case_ids:[],approach:''};
 const result=groundedQaAnswer(proposal,q,input,evidence);
 assert.equal(result.status,'missing');assert.deepEqual(result.citations,[]);
 assert.deepEqual(result.missing_materials,proposal.missing_materials);
 assert.match(result.answer,/暂无法形成有依据的回答/);assert.doesNotMatch(result.answer,/100%|引文未能|合同|审计报告/);
});

test('a display paragraph number resolves repeated declarations to the exact source paragraph',()=>{
 const quote='本所确认募集说明书与本所出具的报告不存在矛盾。';
 const evidence=[snapshot([{text:quote},{text:''},{text:quote},{text:''}])],input={cases:[]} as unknown as QaInput;
 const proposal={question_id:q.id,answer:quote,status:'draft' as const,missing_materials:[],citations:[{asset_index:0,span_id:'p1',quote},{asset_index:0,span_id:'p3',quote}],case_ids:[],approach:''};
 assert.equal(qaHasGroundedCitations(proposal,evidence),true);
 const repaired=groundedQaAnswer(proposal,q,input,evidence);
 assert.deepEqual(repaired.citations.map(c=>c.span_id),['p0','p2']);
 assert.equal(repaired.answer,quote);assert.equal(repaired.status,'draft');
 // A valid machine ID takes precedence over interpreting it as a display number.
 assert.equal(groundedQaAnswer({...proposal,citations:[{asset_index:0,span_id:'p2',quote}]},q,input,evidence).citations[0].span_id,'p2');
 for(const citation of [{asset_index:1,span_id:'p1',quote},{asset_index:0,span_id:'p01',quote},{asset_index:0,span_id:'p5',quote},{asset_index:0,span_id:'p1',quote:quote+'不存在风险。'}]){
  assert.equal(qaHasGroundedCitations({...proposal,citations:[citation]},evidence),false);
 }
 assert.match(qaAnswerInstructions,/不得从 location 的“段落 N”推算为 pN/);
});

test('display-number repair never guesses between repeated table cells or incompatible locators',()=>{
 const quote='暂未制定开发计划。';
 const proposal={question_id:q.id,answer:quote,status:'draft' as const,missing_materials:[],citations:[{asset_index:0,span_id:'p1',quote}],case_ids:[],approach:''};
 const table=snapshot([{text:quote,location:'表格 1 / 行 1 / 列 1'},{text:'标题',location:'表格 1 / 行 1 / 列 2'},{text:quote,location:'表格 1 / 行 2 / 列 1'}]);
 assert.equal(qaHasGroundedCitations(proposal,[table]),false);
 const wrongNumber=snapshot([{text:quote,location:'段落 20'},{text:''},{text:quote,location:'段落 30'}]);
 assert.equal(qaHasGroundedCitations(proposal,[wrongNumber]),false);
});
