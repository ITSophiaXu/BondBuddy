import assert from 'node:assert/strict';
import {test} from 'node:test';
import {PROJECT_QA_PRICE,LEGACY_OUTCOME_PRICE_VERSION,OUTCOME_PRICE_VERSION,commerceMetadata,encodeBillingDto,type ProjectFileAsset,type QaAnswer,type QaDraft,type QaQuestion,type QaResult,type QaRun} from './billing-types.js';
import {qaAssetKey,qaSameDraft,qaPreparationFor,qaFollowupFor} from './qa-continuation.js';

const projectId='qa-project',sha='a'.repeat(64),snapshotSha='b'.repeat(64),documentSha='c'.repeat(64),prepareHash='d'.repeat(64),answerHash='e'.repeat(64),evidenceSha='f'.repeat(64);
const source=():ProjectFileAsset=>({kind:'material',pin:{source_project_id:projectId,material_id:'question-list',material_version:2,sha256:sha}});
const material=():ProjectFileAsset=>({kind:'material',pin:{source_project_id:'collection-member',material_id:'audit-report',material_version:4,sha256:evidenceSha}});
const artifact=():ProjectFileAsset=>({kind:'artifact',pin:{source_project_id:projectId,artifact_id:'prospectus',artifact_version:3,sha256:documentSha}});
const snapshot=():QaResult['snapshot']=>({version:'project-file-text-v1',sha256:snapshotSha,format:'docx',coverage:'complete',warnings:[],
  spans:['问题清单','项目概况','  请说明偿付安排。  ','有关财务情况','请补充最新财务指标。','并说明变动原因。','有关担保情况','请说明担保措施。'].map((text,i)=>({id:`p${i}`,text,location:`段落 ${i+1}`,sha256:sha}))});
const questions=():QaQuestion[]=>[2,4,7].map(i=>({id:`q${i}`,start:i,end:i,question:snapshot().spans[i].text.trim()}));
const draft=(patch:Partial<QaDraft>={}):QaDraft=>({preparation_id:'exact-prepare',questions:questions(),materials:[material(),artifact()],requirements:'按原问题逐项说明',use_knowledge:false,...patch});
const answers=():QaAnswer[]=>questions().map(q=>({question_id:q.id,answer:'根据项目资料形成的回答草稿',status:'draft',missing_materials:[],
  citations:[{asset_index:0,span_id:'e1',quote:'项目资料'}],case_ids:[],approach:'请人工核对原始依据与口径。'}));
const evidence=():QaResult['evidence']=>[{filename:'财务报告.pdf',snapshot:{version:'project-file-text-v1',format:'pdf',sha256:evidenceSha,coverage:'complete',warnings:[],
  spans:[{id:'e1',text:'项目资料与事实依据',location:'第 1 页',sha256:sha}]}}];
const result=(patch:Partial<QaResult>={}):QaResult=>({version:'project-qa-result-v1',input_hash:prepareHash,document:{key:'prepared/document.docx',sha256:documentSha,byte_size:1024},
  snapshot:snapshot(),questions:questions(),answers:[],warnings:[],evidence:[],...patch});
const preparation=(patch:Partial<QaRun>={}):QaRun=>({run_id:'exact-prepare',sequence:1,operation:'prepare',state:'succeeded',stage:'completed',created_at:'2026-10-25T00:00:00Z',
  manifest:{version:'project-qa-v1',operation:'prepare',project_name:'债券项目',source:{filename:'问题清单.docx',asset:source()},preparation_id:null,
    questions:[],materials:[],requirements:'',cases:[],price_version:PROJECT_QA_PRICE.version,points:"0"},result:result(),artifact_id:'prepared-artifact',reserved_points:"0",charged_points:"0",...patch});
const answerRun=(patch:Partial<QaRun>={}):QaRun=>({run_id:'historical-answer',sequence:2,operation:'answer',state:'succeeded',stage:'completed',created_at:'2026-10-25T01:00:00Z',
  manifest:{version:'project-qa-v1',operation:'answer',project_name:'债券项目',source:{filename:'问题清单.docx',asset:source()},preparation_id:'exact-prepare',questions:questions(),
    materials:[{filename:'财务报告.pdf',asset:material()},{filename:'募集书.docx',asset:artifact()}],requirements:'按原问题逐项说明',cases:[],price_version:PROJECT_QA_PRICE.version,points:"180"},
  result:result({input_hash:answerHash,document:{key:'answered/document.docx',sha256:evidenceSha,byte_size:2048},answers:answers(),evidence:evidence()}),artifact_id:'answer-artifact',reserved_points:"0",charged_points:"180",...patch});
function assertBlocked(run:QaRun,runs:readonly QaRun[]=[preparation()],project=projectId){
  const choice=qaFollowupFor(run,runs,project);assert.ok(choice.error);assert.deepEqual(choice.questions,[]);assert.deepEqual(choice.missingIds,[]);assert.equal(choice.preparation,undefined);
}

test('historical and current CNY answer continuations preserve the paid amount instead of reclassifying it as per-question credits',()=>{
 for(const version of [LEGACY_OUTCOME_PRICE_VERSION,OUTCOME_PRICE_VERSION]){
  const run=answerRun();run.manifest={...run.manifest,...encodeBillingDto('commerceMetadata',commerceMetadata(3900,3900,1,version)),price_version:version,points:"3900"};run.charged_points="3900";
  const choice=qaFollowupFor(run,[preparation()],projectId);assert.equal(choice.error,undefined);assert.ok(choice.preparation);
  assertBlocked({...run,manifest:{...run.manifest,points:"180"}});
 }
});

test('QA asset keys normalize property order and retain every exact material or artifact pin field',()=>{
  const original=source();if(original.kind!=='material')return;
  const reordered:ProjectFileAsset={pin:{sha256:sha,material_version:2,material_id:'question-list',source_project_id:projectId},kind:'material'};
  assert.equal(qaAssetKey(original),qaAssetKey(reordered));
  for(const pin of [{...original.pin,source_project_id:'other-project'},{...original.pin,material_id:'other-material'},
    {...original.pin,material_version:3},{...original.pin,sha256:snapshotSha}])assert.notEqual(qaAssetKey(original),qaAssetKey({kind:'material',pin}));
  const item=artifact();if(item.kind!=='artifact')return;
  assert.equal(qaAssetKey(item),qaAssetKey({kind:'artifact',pin:{sha256:item.pin.sha256,artifact_version:3,artifact_id:'prospectus',source_project_id:projectId}}));
  for(const pin of [{...item.pin,source_project_id:'other-project'},{...item.pin,artifact_id:'other-artifact'},
    {...item.pin,artifact_version:4},{...item.pin,sha256:sha}])assert.notEqual(qaAssetKey(item),qaAssetKey({kind:'artifact',pin}));
  assert.notEqual(qaAssetKey(source()),qaAssetKey(artifact()));
});

test('QA draft comparison ignores object key insertion order and compares every complete ordered field',()=>{
  const original=draft(),reordered:QaDraft={use_knowledge:false,requirements:original.requirements,materials:[material(),artifact()],
    questions:original.questions.map(q=>({question:q.question,end:q.end,start:q.start,id:q.id})),preparation_id:'exact-prepare'};
  assert.equal(qaSameDraft(original,reordered),true);assert.equal(qaSameDraft(draft({preparation_id:null,questions:[],materials:[]}),draft({preparation_id:null,questions:[],materials:[]})),true);
  for(const change of [draft({preparation_id:'different-prepare'}),draft({questions:questions().slice(0,2)}),draft({questions:questions().reverse()}),
    draft({questions:[{...questions()[0],question:'different'},...questions().slice(1)]}),draft({questions:[{...questions()[0],end:3},...questions().slice(1)]}),
    draft({materials:[artifact(),material()]}),draft({materials:[source(),artifact()]}),draft({requirements:'different'}),draft({use_knowledge:true})])assert.equal(qaSameDraft(original,change),false);
  for(const invalid of [null,{...original,extra:true},{...original,use_knowledge:'no'},{...original,questions:[{...questions()[0],extra:true}]}])assert.equal(qaSameDraft(invalid as QaDraft,invalid as QaDraft),false);
});

test('QA preparation resolves only the exact explicit successful run and permits user-corrected multi-span questions',()=>{
  const exact=preparation(),newer=preparation({run_id:'newer-prepare',sequence:9}),q=questions();q[1]={...q[1],end:5,question:snapshot().spans.slice(4,6).map(s=>s.text).join('\n').trim()};
  assert.equal(qaPreparationFor(draft({questions:q}),[newer,exact],projectId).preparation,exact);
  assert.equal(qaPreparationFor(draft({questions:[q[1]]}),[exact],projectId).preparation,exact);
  assert.equal(qaPreparationFor(draft({questions:[]}),[exact],projectId).preparation,exact);
  assert.ok(qaPreparationFor(draft({preparation_id:'not-present'}),[newer,exact],projectId).error);
  assert.ok(qaPreparationFor(draft({preparation_id:null}),[newer,exact],projectId).error);
  assert.ok(qaPreparationFor(draft(),[exact,preparation()],projectId).error);
});

test('QA preparation requires complete public schemas, prepare operation, success and a same-project material source',()=>{
  const base=preparation(),m=base.manifest;
  const invalid:QaRun[]=[preparation({operation:'answer'}),preparation({state:'running'}),preparation({state:'test_completed'}),preparation({state:'failed'}),preparation({result:null}),
    preparation({manifest:{...m,operation:'answer'}}),preparation({manifest:{...m,preparation_id:'other'}}),preparation({manifest:{...m,points:"60"}}),
    preparation({manifest:{...m,questions:questions()}}),preparation({manifest:{...m,materials:[{filename:'material',asset:material()}]}}),
    preparation({manifest:{...m,source:{...m.source,asset:artifact()}}}),preparation({manifest:{...m,source:{...m.source,asset:material()}}}),
    {...base,project_id:projectId} as QaRun,{...base,manifest:{...m,request_id:'not-in-public-schema'}} as QaRun,
    {...base,result:{...base.result!,extra:true}} as QaRun,preparation({sequence:Number.MAX_SAFE_INTEGER+1})];
  for(const run of invalid)assert.ok(qaPreparationFor(draft(),[run],projectId).error);
  assert.ok(qaPreparationFor(draft(),[base],'different-project').error);assert.ok(qaPreparationFor(draft(),[base],'bad\nproject').error);
  assert.ok(qaPreparationFor({...draft(),extra:true} as QaDraft,[base],projectId).error);
  assert.ok(qaPreparationFor(draft({materials:[source()]}),[base],projectId).error);
});

test('QA preparation validates exact source text, q-start IDs, safe bounds, ordering and non-overlapping ranges',()=>{
  const q=questions(),base=preparation();
  const invalid:QaQuestion[][]=[
    [{...q[0],id:'question-2'}],[{...q[0],question:'请说明偿付安排。 '}],[{...q[0],question:'edited wording'}],
    [{...q[0],start:-1}],[{...q[0],end:8}],[{...q[0],end:1}],[{...q[0],end:2.5}],
    [{id:'q9007199254740992',start:Number.MAX_SAFE_INTEGER+1,end:Number.MAX_SAFE_INTEGER+1,question:'unsafe'}],
    [q[0],q[0]],[q[1],q[0]],[{...q[0],end:4,question:snapshot().spans.slice(2,5).map(s=>s.text).join('\n').trim()},q[1]],
    [{...q[1],end:5,question:snapshot().spans.slice(4,6).map(s=>s.text).join(' ').trim()}],
  ];
  for(const questions of invalid)assert.ok(qaPreparationFor(draft({questions}),[base],projectId).error);
  const emptySnapshot=snapshot();emptySnapshot.spans[2].text=' \n ';
  assert.ok(qaPreparationFor(draft({questions:[q[0]]}),[preparation({result:result({snapshot:emptySnapshot})})],projectId).error);
});

test('QA follow-up prioritizes missing questions in a complete three-answer result and keeps original manifest order',()=>{
  const prepared=preparation(),run=answerRun();run.result!.answers[1]={...run.result!.answers[1],status:'missing',missing_materials:['请补充最新审计报告']};run.result!.answers.reverse();
  const choice=qaFollowupFor(run,[prepared],projectId);
  assert.equal(choice.error,undefined);assert.equal(choice.preparation,prepared);assert.deepEqual(choice.missingIds,['q4']);assert.deepEqual(choice.questions,[questions()[1]]);
  assert.notEqual(choice.questions[0],run.manifest.questions[1]);choice.questions[0].question='next round edit';assert.equal(run.manifest.questions[1].question,questions()[1].question);
});

test('QA follow-up combines missing and unanswered questions without claiming a partial fixture is a valid delivery',()=>{
  const run=answerRun();run.result!.answers=[{...answers()[2],status:'missing',missing_materials:['补充担保文件']},answers()[0]];
  const choice=qaFollowupFor(run,[preparation()],projectId);assert.equal(choice.error,undefined);assert.deepEqual(choice.missingIds,['q4','q7']);assert.deepEqual(choice.questions,[questions()[1],questions()[2]]);
  run.result!.answers=[];const empty=qaFollowupFor(run,[preparation()],projectId);assert.deepEqual(empty.missingIds,['q2','q4','q7']);assert.deepEqual(empty.questions,questions());
});

test('QA follow-up permits terminal failures with no result as unanswered work, and rejects active or unknown states',()=>{
  for(const state of ['succeeded','failed','cancelled','rejected','test_completed']){
    const choice=qaFollowupFor(answerRun({state,result:null,artifact_id:null,charged_points:"0"}),[preparation()],projectId);
    assert.equal(choice.error,undefined);assert.deepEqual(choice.questions,questions());assert.deepEqual(choice.missingIds,['q2','q4','q7']);
  }
  for(const state of ['preparing','queued','running','paused','awaiting_input','validating','delivering','settlement_pending','unknown'])assertBlocked(answerRun({state}));
  assertBlocked(preparation());assertBlocked(answerRun({manifest:{...answerRun().manifest,operation:'prepare'}}));
});

test('QA follow-up selects every question only when no missing or unanswered work remains',()=>{
  const run=answerRun(),choice=qaFollowupFor(run,[preparation()],projectId);
  assert.equal(choice.error,undefined);assert.deepEqual(choice.missingIds,[]);assert.deepEqual(choice.questions,questions());assert.notEqual(choice.questions,run.manifest.questions);
  run.result!.answers[0].missing_materials=['仍需补充的原始凭据'];const inconsistent=qaFollowupFor(run,[preparation()],projectId);
  assert.deepEqual(inconsistent.missingIds,['q2']);assert.deepEqual(inconsistent.questions,[questions()[0]]);
});

test('QA follow-up rejects duplicate or unknown answer mappings before returning any subset',()=>{
  const base=answerRun();
  for(const response of [[answers()[0],answers()[0],answers()[2]],[...answers(),{...answers()[0]}],[...answers(),{...answers()[0],question_id:'unknown-question'}],
    [{...answers()[0],status:'missing' as const,missing_materials:['needs data']},{...answers()[1],question_id:'q900'}]])assertBlocked(answerRun({result:{...base.result!,answers:response}}));
});

test('QA follow-up requires exact preparation ID and source file name, pin kind, project, version and hash',()=>{
  const base=answerRun(),input=base.manifest,original=source();if(original.kind!=='material')return;
  assertBlocked(answerRun({manifest:{...input,preparation_id:null}}));assertBlocked(answerRun({manifest:{...input,preparation_id:'newer-prepare'}}));
  assertBlocked(base,[preparation(),preparation()]);assertBlocked(base,[preparation({run_id:'newer-prepare',sequence:9})]);
  assertBlocked(answerRun({manifest:{...input,source:{...input.source,filename:'renamed.docx'}}}));
  for(const asset of [artifact(),{kind:'material' as const,pin:{...original.pin,source_project_id:'other-project'}},
    {kind:'material' as const,pin:{...original.pin,material_id:'other-questions'}},{kind:'material' as const,pin:{...original.pin,material_version:3}},
    {kind:'material' as const,pin:{...original.pin,sha256:snapshotSha}}])assertBlocked(answerRun({manifest:{...input,source:{...input.source,asset}}}));
  assertBlocked(base,[preparation()],'other-project');
});

test('QA follow-up requires exact manifest questions and the complete original preparation snapshot',()=>{
  const base=answerRun(),input=base.manifest;
  assertBlocked(answerRun({manifest:{...input,questions:[{...questions()[0],question:'different'},...questions().slice(1)]}}));
  assertBlocked(answerRun({manifest:{...input,questions:[],points:"0"}}));assertBlocked(answerRun({manifest:{...input,points:"120"}}));
  assertBlocked(answerRun({result:{...base.result!,questions:questions().slice(1)}}));
  assertBlocked(answerRun({result:{...base.result!,questions:questions().reverse()}}));
  for(const patch of [{sha256:sha},{coverage:'partial' as const},{warnings:['altered snapshot warning']},
    {spans:snapshot().spans.map((span,i)=>i===2?{...span,text:'different source text'}:span)},
    {spans:snapshot().spans.map((span,i)=>i===2?{...span,location:'different location'}:span)}])assertBlocked(answerRun({result:{...base.result!,snapshot:{...snapshot(),...patch}}}));
});

test('QA follow-up accepts equivalent property ordering and keeps unrelated input, document and source hashes separate',()=>{
  const run=answerRun(),prepared=preparation();
  assert.notEqual(run.result!.input_hash,prepared.result!.input_hash);assert.notEqual(run.result!.snapshot.sha256,run.manifest.source.asset.pin.sha256);
  const s=run.result!.snapshot;run.result!.snapshot={coverage:s.coverage,warnings:s.warnings,spans:s.spans.map(p=>({sha256:p.sha256,location:p.location,text:p.text,id:p.id})),format:s.format,sha256:s.sha256,version:s.version};
  const q=run.result!.questions;run.result!.questions=q.map(item=>({question:item.question,end:item.end,id:item.id,start:item.start}));
  const choice=qaFollowupFor(run,[prepared],projectId);assert.equal(choice.error,undefined);assert.deepEqual(choice.questions,questions());
});

test('QA follow-up refuses schema additions and malformed answer, snapshot or material fields',()=>{
  const base=answerRun(),bad:unknown[]=[null,{...base,owner:'not-public'},{...base,manifest:{...base.manifest,use_knowledge:true}},
    {...base,result:{...base.result!,answers:[{...answers()[0],status:'approved'}]}},
    {...base,result:{...base.result!,answers:[{...answers()[0],extra:true}]}},
    {...base,result:{...base.result!,snapshot:{...snapshot(),extra:true}}},
    {...base,result:{...base.result!,document:{...base.result!.document,sha256:'bad'}}},
    {...base,manifest:{...base.manifest,materials:[{filename:'bad',asset:{kind:'material',pin:{source_project_id:projectId,material_id:'bad',material_version:0,sha256:sha}}}]}}];
  for(const run of bad)assertBlocked(run as QaRun);
});
