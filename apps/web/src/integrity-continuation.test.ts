import assert from 'node:assert/strict';
import {test} from 'node:test';
import {INTEGRITY_PRICE,type IntegrityDraft,type IntegrityEvidence,type IntegrityManual,type IntegrityRecord,type IntegrityRound,type IntegritySubject} from './billing-types.js';
import {integritySameDraft,integrityRoundFor,integrityWorkItems,integrityManualReadback} from './integrity-continuation.js';

const at='2026-10-25T00:00:00Z',sha='a'.repeat(64);
const subject=(patch:Partial<IntegritySubject>={}):IntegritySubject=>({id:'issuer',kind:'company',name:'测试发行人',identifier:'91310000123456789X',role:'发行人',province:'广东省',city:'深圳市',...patch});
const draft=(patch:Partial<IntegrityDraft>={}):IntegrityDraft=>({subjects:[subject(),subject({id:'director',kind:'person',name:'测试人员',identifier:'任职公司A',role:'董事',province:'',city:''})],site_ids:['execution','gsxt'],notes:'按完整名单核查',...patch});
const records=():IntegrityRecord[]=>draft().subjects.flatMap((subject,i)=>draft().site_ids.map((site_id,j)=>({subject_id:subject.id,site_id,site_name:site_id,urls:['https://example.test/'],query:subject.name,
  status:(['needs_manual','public_matches','query_failed','not_applicable'] as const)[i*2+j],reason:'原官网查询记录',checked_at:at,sources:[],search_performed:i+j===1})));
const manual=(patch:Partial<IntegrityManual>={}):IntegrityManual=>({request_id:'manual-1',subject_id:'issuer',site_id:'execution',queried_at:at,url:'https://zxgk.court.gov.cn/',
  note:'已按主体名称和识别信息核对',conclusion:'unresolved',material:{source_project_id:'project-1',material_id:'evidence-file',material_version:2,sha256:sha},...patch});
const evidence=(patch:Partial<IntegrityEvidence>={}):IntegrityEvidence=>({...manual(),id:'evidence-1',created_at:at,...patch});
const check=(patch:Partial<IntegrityRound>={}):IntegrityRound=>({run_id:'original-check',round_id:'original-check',operation:'check',sequence:2,state:'succeeded',stage:'completed',created_at:at,
  manifest:{version:'integrity-round-v1',operation:'check',round_id:'original-check',project_name:'测试项目',draft:draft(),price_version:INTEGRITY_PRICE.version,points:"5000",records:[],evidence_ids:[],collector:'official-browser-v1'},
  records:records(),evidence:[evidence()],artifact_id:'company-word',artifacts:[{kind:'company',artifact_id:'company-word',artifact_version:1},{kind:'person',artifact_id:'person-word',artifact_version:1}],charged_points:"5000",reserved_points:"0",...patch});
const exported=(patch:Partial<IntegrityRound>={}):IntegrityRound=>{const original=check();return {...original,run_id:'export-run',operation:'export',sequence:3,
  manifest:{...original.manifest,operation:'export',points:"0",records:original.records,evidence_ids:['evidence-1']},charged_points:"0",...patch};};
function blocked(round:IntegrityRound){const result=integrityWorkItems(round);assert.ok(result.error);assert.deepEqual(result.items,[]);}
function noRound(round:IntegrityRound,all:IntegrityRound[]=[check()]){const result=integrityRoundFor(round,all);assert.ok(result.error);assert.equal(result.roundId,undefined);assert.equal(result.original,undefined);}

test('integrity draft equality canonicalizes subject keys and retains the complete saved meaning',()=>{
  const original=draft(),reordered:IntegrityDraft={notes:original.notes,site_ids:[...original.site_ids],subjects:original.subjects.map(s=>({city:s.city,province:s.province,role:s.role,identifier:s.identifier,name:s.name,kind:s.kind,id:s.id}))};
  assert.equal(integritySameDraft(original,reordered),true);assert.equal(integritySameDraft(draft({subjects:[],site_ids:[],notes:''}),draft({subjects:[],site_ids:[],notes:''})),true);
});
test('integrity draft equality compares every subject field, site/subject order and notes without trimming',()=>{
  const original=draft();
  for(const [field,value] of Object.entries({id:'changed',kind:'person',name:'测试发行人 ',identifier:'changed',role:'changed',province:'changed',city:'changed'})){
    const changed=draft();(changed.subjects[0] as unknown as Record<string,unknown>)[field]=value;assert.equal(integritySameDraft(original,changed),false,field);
  }
  for(const changed of [draft({subjects:draft().subjects.reverse()}),draft({subjects:[subject()]}),draft({site_ids:['gsxt','execution']}),draft({site_ids:['execution']}),draft({notes:'按完整名单核查 '})])assert.equal(integritySameDraft(original,changed),false);
});
test('integrity equality rejects malformed schemas, extra fields, duplicate subject IDs and unknown sites',()=>{
  const invalid:unknown[]=[null,{...draft(),extra:true},{...draft(),notes:0},{...draft(),subjects:[{...subject(),extra:true}]},draft({subjects:[subject(),subject()]}),
    draft({subjects:[subject({id:'bad\nID'})]}),draft({site_ids:['execution','execution']}),draft({site_ids:['unknown-site']})];
  for(const item of invalid)assert.equal(integritySameDraft(item as IntegrityDraft,item as IntegrityDraft),false);
});
test('integrity round resolution uses the exact check identity and never selects a newer history entry',()=>{
  const original=check(),newer=check({run_id:'newer-check',round_id:'newer-check',sequence:99,manifest:{...check().manifest,round_id:'newer-check'}}),choice=integrityRoundFor(original,[newer,original]);
  assert.equal(choice.error,undefined);assert.equal(choice.roundId,'original-check');assert.equal(choice.original,original);assert.equal(choice.originalMissing,undefined);
});
test('integrity check resolution rejects mismatched operation, round ID, charge snapshot and malformed envelopes',()=>{
  const original=check(),m=original.manifest;
  for(const invalid of [check({round_id:'other'}),check({run_id:'other'}),check({operation:'export'}),check({manifest:{...m,operation:'export'}}),check({manifest:{...m,round_id:'other'}}),
    check({manifest:{...m,points:"0"}}),check({manifest:{...m,records:records()}}),check({manifest:{...m,evidence_ids:['evidence-1']}}),check({sequence:Number.MAX_SAFE_INTEGER+1}),
    {...original,extra:true} as IntegrityRound,{...original,manifest:{...m,extra:true}} as IntegrityRound])noRound(invalid);
});
test('integrity export resolution binds writes to the original check round ID',()=>{
  const original=check(),run=exported(),choice=integrityRoundFor(run,[run,original]);
  assert.equal(choice.error,undefined);assert.equal(choice.roundId,original.run_id);assert.notEqual(choice.roundId,run.run_id);assert.equal(choice.original,original);
});
test('a valid export outside the original history window stays readable and explicitly reports read-only origin absence',()=>{
  const run=exported(),choice=integrityRoundFor(run,[run]);assert.equal(choice.error,undefined);assert.equal(choice.roundId,'original-check');assert.equal(choice.original,undefined);assert.equal(choice.originalMissing,true);
  assert.equal(integrityWorkItems(run).items.length,4);
});
test('integrity export binding rejects a present unrelated original or changed immutable roster, project, collector or records',()=>{
  const original=check(),run=exported();
  for(const parent of [check({operation:'export'}),check({round_id:'other'}),check({state:'running'}),check({manifest:{...original.manifest,draft:draft({notes:'different'})}}),
    check({manifest:{...original.manifest,project_name:'另一个项目'}}),check({manifest:{...original.manifest,collector:undefined}}),check({records:records().slice(0,3)})])noRound(run,[parent]);
  noRound(exported({manifest:{...run.manifest,points:"5000"}}));noRound(exported({run_id:'original-check'}));noRound(exported({charged_points:"5000"}));noRound(exported({reserved_points:"5000"}));
});
test('integrity resolution rejects duplicate original identities and a conflicting check snapshot in the history list',()=>{
  noRound(exported(),[check(),check()]);const original=check();noRound(original,[check({manifest:{...original.manifest,draft:draft({notes:'changed'})}})]);
  noRound(original,[check({operation:'export'})]);noRound(original,null as unknown as IntegrityRound[]);
});
test('integrity helpers do not mutate the selected manifest, observations or evidence while resolving work',()=>{
  const run=exported(),original=check(),before=JSON.stringify([run,original]);integrityRoundFor(run,[run,original]);integrityWorkItems(run);integritySameDraft(run.manifest.draft,original.manifest.draft);
  assert.equal(JSON.stringify([run,original]),before);
});
test('integrity work items preserve the exact manifest subject-by-site order and original statuses',()=>{
  const run=check(),choice=integrityWorkItems(run);assert.equal(choice.error,undefined);
  assert.deepEqual(choice.items.map(item=>[item.subject.id,item.siteId]),[['issuer','execution'],['issuer','gsxt'],['director','execution'],['director','gsxt']]);
  assert.deepEqual(choice.items.map(item=>item.pending),[true,false,true,false]);assert.equal(new Set(choice.items.map(item=>item.key)).size,4);
  assert.deepEqual(choice.items.map(item=>item.record?.status),['needs_manual','public_matches','query_failed','not_applicable']);
});
test('every terminal round missing an applicable observation remains pending, including an unexecuted combination',()=>{
  for(const state of ['succeeded','failed','cancelled','rejected','test_completed']){
    const choice=integrityWorkItems(check({state,records:records().filter((_,index)=>index!==2)}));assert.equal(choice.error,undefined);assert.equal(choice.items[2].record,undefined);assert.equal(choice.items[2].pending,true,state);
  }
});
test('a person on a company-only site never becomes an unfinishable pending evidence item when its record is absent',()=>{
  for(const state of ['succeeded','failed','cancelled','rejected','test_completed','running']){
    const choice=integrityWorkItems(check({state,records:records().slice(0,3)}));assert.equal(choice.error,undefined);assert.equal(choice.items[3].record,undefined);assert.equal(choice.items[3].pending,false,state);
  }
  const automatic=records();automatic[3]={...automatic[3],status:'query_failed'};const choice=integrityWorkItems(check({records:automatic}));
  assert.equal(choice.items[3].record?.status,'query_failed');assert.equal(choice.items[3].pending,false);
});
test('a running round missing an observation is waiting rather than an original manual-query failure',()=>{
  const choice=integrityWorkItems(check({state:'running',records:records().slice(0,2)}));assert.equal(choice.error,undefined);assert.deepEqual(choice.items.map(item=>item.pending),[true,false,false,false]);
});
test('manual evidence, including a no-records conclusion, never changes automatic status or pending count',()=>{
  const run=check({evidence:[evidence({conclusion:'no_records'})]}),choice=integrityWorkItems(run);assert.equal(choice.items[0].pending,true);assert.equal(choice.items[0].record?.status,'needs_manual');
  assert.equal(choice.items[0].evidence[0].conclusion,'no_records');assert.equal(choice.items[3].pending,false);
});
test('included and new evidence counts belong to the selected Word snapshot rather than the current evidence total',()=>{
  const run=exported({evidence:[evidence(),evidence({id:'evidence-2',request_id:'manual-2'}),evidence({id:'evidence-3',request_id:'manual-3',subject_id:'director'})]}),choice=integrityWorkItems(run);
  assert.equal(choice.error,undefined);assert.deepEqual(choice.items.map(item=>[item.includedEvidenceCount,item.newEvidenceCount]),[[1,1],[0,0],[0,1],[0,0]]);
  assert.deepEqual(integrityWorkItems(check({evidence:run.evidence})).items.map(item=>item.includedEvidenceCount),[0,0,0,0]);
});
test('queued exports use the frozen original observations while their own result is empty',()=>{
  const run=exported({state:'queued',records:[]}),choice=integrityWorkItems(run);assert.equal(choice.error,undefined);assert.deepEqual(choice.items.map(item=>item.record?.status),records().map(record=>record.status));
  assert.equal(integrityRoundFor(run,[check()]).roundId,'original-check');
});
test('integrity work rejects duplicate or unknown automatic subject/site associations with no guessed rows',()=>{
  for(const recordsPatch of [[...records(),records()[0]],[{...records()[0],subject_id:'other'}],[{...records()[0],site_id:'other'}]])blocked(check({records:recordsPatch}));
  const run=exported();blocked(exported({manifest:{...run.manifest,records:[...records(),records()[0]]}}));
});
test('integrity work rejects ambiguous or unknown evidence associations and malformed material pins',()=>{
  for(const evidencePatch of [[evidence(),evidence({request_id:'manual-2'})],[evidence(),evidence({id:'evidence-2'})],[evidence({subject_id:'unknown'})],
    [evidence({site_id:'unknown'})],[evidence({subject_id:'director',site_id:'gsxt'})],[evidence({material:{...manual().material,material_version:Number.MAX_SAFE_INTEGER+1}})],
    [{...evidence(),extra:true} as IntegrityEvidence]])blocked(check({evidence:evidencePatch}));
});
test('a Word manifest cannot claim duplicate or absent evidence as included',()=>{
  const run=exported();for(const ids of [['evidence-1','evidence-1'],['not-present'],['bad\nID']])blocked(exported({manifest:{...run.manifest,evidence_ids:ids}}));
});
test('a completed export with changed result observations cannot replace its frozen original query snapshot',()=>{
  const run=exported(),changed=records();changed[0]={...changed[0],reason:'changed after export'};blocked(exported({records:changed}));blocked(exported({records:records().reverse()}));
  const reordered=run.records.map(record=>Object.fromEntries(Object.entries(record).reverse()) as IntegrityRecord);assert.equal(integrityWorkItems(exported({records:reordered})).error,undefined);
});
test('manual readback acknowledges only the exact request, canonically ignoring response ID and creation time',()=>{
  const request=manual({registration:{province:'广东省',city:'深圳市'}}),saved=evidence({...request,id:'server-evidence',created_at:'2026-10-25T01:00:00Z',material:{sha256:sha,material_version:2,material_id:'evidence-file',source_project_id:'project-1'},registration:{city:'深圳市',province:'广东省'}});
  const choice=integrityManualReadback(request,[saved]);assert.equal(choice.error,undefined);assert.equal(choice.evidence,saved);
});
test('manual readback compares every request field, registration field and complete material pin',()=>{
  const request=manual({registration:{province:'广东省',city:'深圳市'}}),changes:Partial<IntegrityEvidence>[]=[{subject_id:'director'},{site_id:'gsxt'},{queried_at:'2026-10-25T00:01:00Z'},
    {url:'https://zxgk.court.gov.cn/other'},{note:request.note+' '},{conclusion:'records_found'},{registration:undefined},{registration:{province:'其他省',city:'深圳市'}},{registration:{province:'广东省',city:'其他市'}},
    ...[{source_project_id:'other-project'},{material_id:'other-material'},{material_version:3},{sha256:'b'.repeat(64)}].map(pin=>({material:{...request.material,...pin}}))];
  for(const patch of changes){const choice=integrityManualReadback(request,[evidence({...request,...patch})]);assert.equal(choice.evidence,undefined);assert.ok(choice.error);}
  assert.ok(integrityManualReadback(manual(),[evidence({registration:{province:'',city:''}})]).error);
});
test('manual readback does not acknowledge missing or duplicate request IDs or duplicate evidence identities',()=>{
  assert.deepEqual(integrityManualReadback(manual(),[]),{});assert.deepEqual(integrityManualReadback(manual(),[evidence({request_id:'another-request'})]),{});
  for(const saved of [[evidence(),evidence({id:'second'})],[evidence(),evidence({request_id:'other'})]]){
    const choice=integrityManualReadback(manual(),saved);assert.equal(choice.evidence,undefined);assert.ok(choice.error);
  }
});
test('manual readback rejects extra fields and unsafe or incomplete request/response schemas',()=>{
  const request=manual();for(const invalid of [null,{...request,extra:true},{...request,request_id:'bad\nID'},{...request,material:{...request.material,extra:true}},
    {...request,material:{...request.material,material_version:Number.MAX_SAFE_INTEGER+1}},{...request,registration:{province:'广东省'}}]){
    const choice=integrityManualReadback(invalid as IntegrityManual,[evidence()]);assert.equal(choice.evidence,undefined);assert.ok(choice.error);
  }
  for(const invalid of [null,{...evidence(),extra:true},{...evidence(),id:'bad\nID'}])assert.ok(integrityManualReadback(request,[invalid as IntegrityEvidence]).error);
});
