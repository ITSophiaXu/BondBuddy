import assert from 'node:assert/strict';
import {test} from 'node:test';
import {PROJECT_QA_PRICE,LEGACY_OUTCOME_PRICE_VERSION,OUTCOME_PRICE_VERSION,type QaDraft,type ProjectFileAsset} from '@bondbuddy/contracts';
import {QaRecoveryCache,type QaRecoveryValue,type QaRecoveryCacheStorage} from './qa-recovery-cache.js';

class MemoryStorage implements QaRecoveryCacheStorage{
  values=new Map<string,string>();
  getItem(key:string){return this.values.get(key)??null;}
  setItem(key:string,value:string){this.values.set(key,value);}
  removeItem(key:string){this.values.delete(key);}
}
const sha='a'.repeat(64),otherSha='b'.repeat(64),key='bb-qa-recovery:owner:project';
const source=():ProjectFileAsset=>({kind:'material',pin:{source_project_id:'project',material_id:'questions',material_version:2,sha256:sha}});
test('ordinary upgrade restores the original numeric QA request without changing its identity or bytes',()=>{
  const storage=new MemoryStorage(),cache=new QaRecoveryCache('owner','project',storage);
  const legacy={revision:7,draft:draft(),pending:{kind:'answer',request:{request_id:'old-answer',expected_revision:7,
    price_version:PROJECT_QA_PRICE.version,expected_points:2*PROJECT_QA_PRICE.points}}};
  const raw=JSON.stringify({version:'qa-recovery-cache-v1',owner:'owner',project:'project',value:legacy});storage.setItem(key,raw);
  const result=cache.read();assert.equal(result.status,'valid');assert.deepEqual(result.value,legacy);assert.equal(storage.getItem(key),raw);
  if(result.status==='valid'){assert.equal(cache.save(result.value,result.value).status,'valid');assert.deepEqual(cache.read().value,legacy);}
  for(const amount of [Number.MAX_SAFE_INTEGER+1,-1,0.5,'05000']){
    storage.setItem(key,JSON.stringify({version:'qa-recovery-cache-v1',owner:'owner',project:'project',value:{...legacy,pending:{...legacy.pending,request:{...legacy.pending.request,expected_points:amount}}}}));
    assert.equal(cache.read().status,'invalid');
  }
});
const draft=():QaDraft=>({preparation_id:'prepare-run',questions:[{id:'q0',start:0,end:2,question:'请说明债券的偿付安排。'},{id:'q4',start:4,end:4,question:'补充最新财务指标。'}],
  materials:[{kind:'material',pin:{source_project_id:'member-project',material_id:'financial-report',material_version:3,sha256:otherSha}},
    {kind:'artifact',pin:{source_project_id:'project',artifact_id:'prospectus',artifact_version:5,sha256:sha}}],requirements:'逐项标记缺失的证据',use_knowledge:false});
const value=():QaRecoveryValue=>({revision:7,draft:draft(),needsKnowledgeChoice:false,sourceRun:'viewed-answer-run',pending:{kind:'answer',request:{request_id:'same-answer-request',expected_revision:7,expected_points:"120",price_version:PROJECT_QA_PRICE.version}}});
const pendingDraft=():QaRecoveryValue=>{const saved=value();return {...saved,pending:{kind:'draft',request:{expected_revision:saved.revision,draft:draft()}}};};
const pendingPrepare=():QaRecoveryValue=>({...value(),needsKnowledgeChoice:true,pending:{kind:'prepare',request:{request_id:'same-prepare-request',source:source()}}});
const wrapper=(saved:unknown)=>({version:'qa-recovery-cache-v1',owner:'owner',project:'project',value:saved});
function put(storage:MemoryStorage,saved:unknown){const raw=JSON.stringify(wrapper(saved));storage.values.set(key,raw);return raw;}

test('CNY pending answer recovery keeps the exact historical/current scope and request without treating fen as legacy credits',()=>{
 for(const version of [LEGACY_OUTCOME_PRICE_VERSION,OUTCOME_PRICE_VERSION]){
  const cache=new QaRecoveryCache('owner','project',new MemoryStorage()),saved=value();
  saved.pending={kind:'answer',request:{request_id:'same-answer-request',expected_revision:7,expected_points:"3900",price_version:version,scope_quote_id:'exact-accepted-scope'}};
  assert.equal(cache.save(saved).status,'valid');assert.deepEqual(cache.read(),{status:'valid',value:saved});
  const missingScope=structuredClone(saved);if(missingScope.pending?.kind==='answer')delete missingScope.pending.request.scope_quote_id;
  assert.equal(cache.save(missingScope).status,'invalid');
 }
});

test('QA recovery restores the complete answer envelope and all exact material versions as independent frozen copies',()=>{
  const storage=new MemoryStorage(),cache=new QaRecoveryCache('owner','project',storage),input=value();
  assert.deepEqual(cache.read(),{status:'empty'});const saved=cache.save(input,null);assert.equal(saved.status,'valid');
  const restored=cache.read();assert.equal(restored.status,'valid');if(restored.status!=='valid'||saved.status!=='valid')return;
  assert.deepEqual(restored.value,input);assert.notEqual(saved.value,restored.value);assert.notEqual(saved.value.draft,restored.value.draft);
  for(const item of [restored.value,restored.value.draft,restored.value.draft.questions,restored.value.draft.questions[0],restored.value.draft.materials,
    restored.value.draft.materials[0],restored.value.draft.materials[0].pin,restored.value.draft.materials[1].pin,restored.value.pending,restored.value.pending!.request])assert.equal(Object.isFrozen(item),true);
  input.draft.questions[0].question='changed';input.draft.materials[0].pin.sha256=sha;
  if(input.pending?.kind==='answer')input.pending.request.request_id='replacement-request';
  assert.equal(restored.value.draft.questions[0].question,'请说明债券的偿付安排。');assert.equal(restored.value.draft.materials[0].pin.sha256,otherSha);
  assert.equal(restored.value.pending?.kind==='answer'&&restored.value.pending.request.request_id,'same-answer-request');
  assert.equal(Reflect.set(restored.value.draft.materials[0].pin,'sha256','bad'),false);
  assert.deepEqual(JSON.parse(storage.values.get(key)!),wrapper(value()));
});

test('QA recovery freezes separate pending draft and prepare bodies without reconstructing request IDs',()=>{
  for(const input of [pendingDraft(),pendingPrepare()]){
    const cache=new QaRecoveryCache('owner','project',new MemoryStorage()),saved=cache.save(input);assert.equal(saved.status,'valid');if(saved.status!=='valid')continue;
    assert.deepEqual(saved.value,input);assert.equal(Object.isFrozen(saved.value.pending),true);assert.equal(Object.isFrozen(saved.value.pending!.request),true);
    if(saved.value.pending?.kind==='draft'){
      assert.notEqual(saved.value.draft,saved.value.pending.request.draft);assert.equal(Object.isFrozen(saved.value.pending.request.draft),true);
      assert.equal(Object.isFrozen(saved.value.pending.request.draft.questions[0]),true);assert.equal(Object.isFrozen(saved.value.pending.request.draft.materials[0].pin),true);
    }else if(saved.value.pending?.kind==='prepare'){
      assert.equal(Object.isFrozen(saved.value.pending.request.source),true);assert.equal(Object.isFrozen(saved.value.pending.request.source.pin),true);
      assert.equal(saved.value.pending.request.request_id,'same-prepare-request');
    }
  }
});

test('QA recovery preserves empty initial drafts, unresolved knowledge choice and unrelated viewed run identity',()=>{
  const storage=new MemoryStorage(),cache=new QaRecoveryCache('owner','project',storage);
  const initial:QaRecoveryValue={revision:0,draft:{preparation_id:null,questions:[],materials:[],requirements:'',use_knowledge:true},needsKnowledgeChoice:true,
    sourceRun:'viewed-historical-run',pending:{kind:'prepare',request:{request_id:'initial-prepare',source:source()}}};
  assert.deepEqual(cache.save(initial),{status:'valid',value:initial});assert.deepEqual(cache.read(),{status:'valid',value:initial});
  const local={...initial,pending:undefined,sourceRun:undefined,needsKnowledgeChoice:undefined};
  assert.deepEqual(cache.save(local,initial),{status:'valid',value:{revision:0,draft:initial.draft}});
  const dirty={revision:0,draft:draft(),needsKnowledgeChoice:true,sourceRun:'different-viewed-run'};
  assert.deepEqual(cache.save(dirty),{status:'valid',value:dirty});
});

test('QA recovery isolates owner and API project namespaces and encoded delimiter identities',()=>{
  const storage=new MemoryStorage(),cache=new QaRecoveryCache('owner','project',storage);cache.save(value());const raw=storage.values.get(key)!;
  for(const [owner,project] of [['other-owner','project'],['owner','other-project']]){
    const other=new QaRecoveryCache(owner,project,storage);assert.equal(other.read().status,'empty');
    storage.values.set(`bb-qa-recovery:${encodeURIComponent(owner)}:${encodeURIComponent(project)}`,raw);assert.equal(other.read().status,'invalid');
  }
  const first=new QaRecoveryCache('owner:a','project',storage),second=new QaRecoveryCache('owner','a:project',storage);
  assert.equal(first.save({...value(),pending:undefined}).status,'valid');assert.equal(second.read().status,'empty');
  assert.equal(second.save({...value(),pending:undefined}).status,'valid');assert.equal(first.read().status,'valid');
  assert.notEqual(storage.values.get('bb-qa-recovery:owner%3Aa:project'),storage.values.get('bb-qa-recovery:owner:a%3Aproject'));
});

test('QA recovery requires a strict versioned wrapper and leaves unknown or malformed saved data untouched',()=>{
  const storage=new MemoryStorage(),cache=new QaRecoveryCache('owner','project',storage),base=wrapper(value());
  for(const bad of [value(),{...base,version:'future-version'},{...base,owner:'other-owner'},{...base,project:'navigation-project'},
    {...base,extra:true},{owner:'owner',project:'project',value:value()},{version:base.version,owner:base.owner,value:value()}]){
    const raw=JSON.stringify(bad);storage.values.set(key,raw);assert.deepEqual(cache.read(),{status:'invalid'});assert.equal(storage.values.get(key),raw);
  }
  for(const raw of ['{broken','null','[]','"value"']){storage.values.set(key,raw);assert.equal(cache.read().status,'invalid');assert.equal(storage.values.get(key),raw);}
});

test('QA recovery rejects schema changes and invalid local question span semantics',()=>{
  const storage=new MemoryStorage(),cache=new QaRecoveryCache('owner','project',storage),base=value(),q=draft().questions;
  const badDrafts:unknown[]=[null,{...draft(),extra:true},{...draft(),preparation_id:''},{...draft(),preparation_id:'bad\nrun'},
    {...draft(),requirements:'x'.repeat(16001)},{...draft(),use_knowledge:'yes'},
    {...draft(),questions:[{...q[0],extra:true}]},{...draft(),questions:[{...q[0],question:''}]},
    {...draft(),questions:[{...q[0],question:'x'.repeat(16001)}]},
    {...draft(),questions:[{...q[0],start:-1}]},{...draft(),questions:[{...q[0],end:1.5}]},
    {...draft(),questions:[{...q[0],start:3,end:2,id:'q3'}]},
    {...draft(),questions:[{...q[0],id:'different-id'}]},
    {...draft(),questions:[q[0],q[0]]},{...draft(),questions:[q[1],q[0]]},
    {...draft(),questions:[q[0],{...q[1],id:'q2',start:2}]},
    {...draft(),questions:[{id:'q9007199254740992',start:9007199254740992,end:9007199254740992,question:'unsafe integer'}]},
    {...draft(),questions:Array.from({length:201},(_,i)=>({id:`q${i}`,start:i,end:i,question:'question'}))},
  ];
  const malformed:unknown[]=[null,[],{}, {...base,extra:true},{...base,revision:-1},{...base,revision:1.5},{...base,revision:Number.MAX_SAFE_INTEGER+1},
    {...base,needsKnowledgeChoice:'true'},{...base,sourceRun:''},{...base,sourceRun:'run\u0085id'},
    ...badDrafts.map(bad=>({...base,draft:bad}))];
  for(const bad of malformed){
    assert.equal(cache.save(bad as QaRecoveryValue).status,'invalid');const raw=put(storage,bad);assert.equal(cache.read().status,'invalid');assert.equal(storage.values.get(key),raw);
  }
});

test('QA recovery validates exact material and artifact pins while allowing collection member projects',()=>{
  const storage=new MemoryStorage(),cache=new QaRecoveryCache('owner','project',storage),base=value(),m=draft().materials;
  const invalidMaterials:unknown[][]=[
    [{kind:'material',pin:{...m[0].pin,material_version:0}}],
    [{kind:'material',pin:{...m[0].pin,material_version:1.5}}],
    [{kind:'material',pin:{...m[0].pin,material_version:Number.MAX_SAFE_INTEGER+1}}],
    [{kind:'material',pin:{...m[0].pin,sha256:sha.toUpperCase()}}],
    [{kind:'material',pin:{...m[0].pin,source_project_id:''}}],
    [{kind:'material',pin:{...m[0].pin,material_id:'bad\nmaterial'}}],
    [{kind:'material',pin:{...m[0].pin,extra:true}}],
    [{kind:'material',pin:{...m[0].pin},extra:true}],
    [{kind:'artifact',pin:{...m[1].pin,artifact_id:''}}],
    [{kind:'artifact',pin:{...m[1].pin,artifact_version:0}}],
    [{kind:'artifact',pin:{...m[1].pin,artifact_version:Number.MAX_SAFE_INTEGER+1}}],
    [{kind:'artifact',pin:{...m[1].pin,sha256:'not-a-hash'}}],
    [{kind:'unknown',pin:{...m[0].pin}}], [m[0],m[0]],Array(51).fill(m[0]),
    [{kind:'material',pin:{source_project_id:'project',material_id:'missing-hash',material_version:1}}],
  ];
  for(const materials of invalidMaterials){const bad={...base,draft:{...draft(),materials}};assert.equal(cache.save(bad as QaRecoveryValue).status,'invalid');put(storage,bad);assert.equal(cache.read().status,'invalid');}
  assert.equal(cache.save(base).status,'valid');const restored=cache.read();assert.equal(restored.status==='valid'&&restored.value.draft.materials[0].pin.source_project_id,'member-project');
});

test('QA recovery requires exact draft revision and complete matching draft body for pending save',()=>{
  const storage=new MemoryStorage(),cache=new QaRecoveryCache('owner','project',storage),base=pendingDraft();
  const badRequests:unknown[]=[{expected_revision:6,draft:draft()},{expected_revision:7,draft:{...draft(),requirements:'different'}},
    {expected_revision:7,draft:{...draft(),materials:draft().materials.reverse()}},
    {expected_revision:7,draft:{...draft(),questions:[draft().questions[0]]}},
    {expected_revision:7,draft:{...draft(),use_knowledge:true}},{expected_revision:7,draft:draft(),request_id:'extra-id'}];
  for(const request of badRequests){const bad={...base,pending:{kind:'draft',request}};assert.equal(cache.save(bad as QaRecoveryValue).status,'invalid');put(storage,bad);assert.equal(cache.read().status,'invalid');}
  assert.equal(cache.save(base).status,'valid');
});

test('QA recovery requires exact answer revision, question count, price version and resolved knowledge choice',()=>{
  const storage=new MemoryStorage(),cache=new QaRecoveryCache('owner','project',storage),base=value();if(base.pending?.kind!=='answer')return;
  const request=base.pending.request;
  const malformed:unknown[]=[{...base,pending:null},{...base,pending:{kind:'other',request}},{...base,pending:{kind:'answer',request,extra:true}},
    {...base,pending:{kind:'answer',request:{...request,extra:true}}},{...base,pending:{kind:'answer',request:{...request,request_id:''}}},
    {...base,pending:{kind:'answer',request:{...request,request_id:'bad\nrequest'}}},
    {...base,pending:{kind:'answer',request:{...request,expected_revision:6}}},
    {...base,pending:{kind:'answer',request:{...request,expected_points:60}}},
    {...base,pending:{kind:'answer',request:{...request,expected_points:121}}},
    {...base,pending:{kind:'answer',request:{...request,price_version:'old-price'}}},
    {...base,draft:{...draft(),preparation_id:null}},{...base,draft:{...draft(),questions:[]}},
    {...base,needsKnowledgeChoice:true},{...pendingDraft(),needsKnowledgeChoice:true}];
  for(const bad of malformed){assert.equal(cache.save(bad as QaRecoveryValue).status,'invalid');put(storage,bad);assert.equal(cache.read().status,'invalid');}
  assert.equal(cache.save({...base,needsKnowledgeChoice:undefined}).status,'valid');
});

test('QA recovery only permits preparation from an exact same-project material pin',()=>{
  const storage=new MemoryStorage(),cache=new QaRecoveryCache('owner','project',storage),base=pendingPrepare();if(base.pending?.kind!=='prepare')return;
  const request=base.pending.request;
  for(const asset of [draft().materials[0],draft().materials[1],{...source(),pin:{...source().pin,material_version:0}},
    {...source(),pin:{...source().pin,sha256:'bad'}},{...source(),extra:true}]){
    const bad={...base,pending:{kind:'prepare',request:{...request,source:asset}}};assert.equal(cache.save(bad as QaRecoveryValue).status,'invalid');put(storage,bad);assert.equal(cache.read().status,'invalid');
  }
  for(const badRequest of [{...request,request_id:''},{...request,request_id:'bad\u007frequest'},{...request,extra:true}]){
    const bad={...base,pending:{kind:'prepare',request:badRequest}};assert.equal(cache.save(bad as QaRecoveryValue).status,'invalid');
  }
  assert.equal(cache.save(base).status,'valid');
});

test('QA recovery guards expected empty and complete previous values without overwriting another page pending request',()=>{
  const storage=new MemoryStorage(),first=new QaRecoveryCache('owner','project',storage),other=new QaRecoveryCache('owner','project',storage),base=value();
  assert.equal(first.save(base,null).status,'valid');const initial=storage.values.get(key)!;
  assert.deepEqual(other.save(pendingPrepare(),null),{status:'conflict'});assert.equal(storage.values.get(key),initial);
  const next={...base,sourceRun:'new-viewed-run'};assert.equal(first.save(next,base).status,'valid');const changed=storage.values.get(key)!;
  assert.deepEqual(other.save(pendingPrepare(),base),{status:'conflict'});assert.deepEqual(other.clear(base),{status:'conflict'});assert.equal(storage.values.get(key),changed);
  assert.equal(first.clear(next).status,'empty');assert.deepEqual(other.save(pendingPrepare(),base),{status:'conflict'});assert.deepEqual(other.clear(base),{status:'conflict'});
  assert.equal(other.save(pendingPrepare(),null).status,'valid');
});

test('QA recovery expected comparison uses all optional and exact nested request values with semantic property ordering',()=>{
  const storage=new MemoryStorage(),cache=new QaRecoveryCache('owner','project',storage),base=pendingDraft();cache.save(base);
  const mismatches:QaRecoveryValue[]=[{...base,revision:6,pending:undefined},{...base,pending:undefined},{...base,sourceRun:undefined},{...base,needsKnowledgeChoice:undefined},
    {...base,draft:{...base.draft,requirements:'other'},pending:{kind:'draft',request:{expected_revision:7,draft:{...base.draft,requirements:'other'}}}}];
  for(const mismatch of mismatches){const raw=storage.values.get(key)!;assert.equal(cache.save(value(),mismatch).status,'conflict');assert.equal(cache.clear(mismatch).status,'conflict');assert.equal(storage.values.get(key),raw);}
  const reordered={pending:base.pending,sourceRun:base.sourceRun,needsKnowledgeChoice:base.needsKnowledgeChoice,draft:base.draft,revision:base.revision};
  assert.equal(cache.save(value(),reordered).status,'valid');
  const corrupt='{broken';storage.values.set(key,corrupt);assert.equal(cache.save(value(),null).status,'conflict');assert.equal(cache.clear(value()).status,'conflict');assert.equal(storage.values.get(key),corrupt);
  assert.equal(cache.save(value(),{...value(),revision:-1}).status,'invalid');assert.equal(cache.clear({...value(),revision:-1}).status,'invalid');
});

test('QA recovery expected comparison includes prepare and answer request IDs',()=>{
  for(const input of [pendingPrepare(),value()]){
    const storage=new MemoryStorage(),cache=new QaRecoveryCache('owner','project',storage);cache.save(input);
    const mismatch=JSON.parse(JSON.stringify(input)) as QaRecoveryValue;if(mismatch.pending?.kind==='prepare'||mismatch.pending?.kind==='answer')mismatch.pending.request.request_id='other-request';
    assert.equal(cache.save(input,mismatch).status,'conflict');assert.equal(cache.clear(mismatch).status,'conflict');assert.deepEqual(cache.read(),{status:'valid',value:input});
  }
});

test('QA recovery confirms exact storage readback and returns unavailable for silently lost or changed writes',()=>{
  const lost:QaRecoveryCacheStorage={getItem:()=>null,setItem(){},removeItem(){}};
  assert.deepEqual(new QaRecoveryCache('owner','project',lost).save(value(),null),{status:'unavailable'});
  const storage=new MemoryStorage();put(storage,pendingPrepare());const previous=storage.values.get(key)!;
  const ignored:QaRecoveryCacheStorage={getItem:k=>storage.getItem(k),setItem(){},removeItem:k=>storage.removeItem(k)};
  assert.equal(new QaRecoveryCache('owner','project',ignored).save(value(),pendingPrepare()).status,'unavailable');assert.equal(storage.values.get(key),previous);
  const altered:QaRecoveryCacheStorage={getItem:k=>storage.getItem(k),setItem(k,raw){const parsed=JSON.parse(raw);parsed.value.pending.request.request_id='changed-by-storage';storage.setItem(k,JSON.stringify(parsed));},removeItem:k=>storage.removeItem(k)};
  assert.deepEqual(new QaRecoveryCache('owner','project',altered).save(value()),{status:'unavailable'});
});

test('QA recovery reports unavailable on storage exceptions and failed clearing readback',()=>{
  const broken:QaRecoveryCacheStorage={getItem(){throw Error('read denied');},setItem(){throw Error('quota');},removeItem(){throw Error('remove denied');}},cache=new QaRecoveryCache('owner','project',broken);
  assert.deepEqual(cache.read(),{status:'unavailable'});assert.deepEqual(cache.save(value()),{status:'unavailable'});assert.deepEqual(cache.save(value(),null),{status:'unavailable'});
  assert.deepEqual(cache.clear(),{status:'unavailable'});assert.deepEqual(cache.clear(value()),{status:'unavailable'});
  const storage=new MemoryStorage();put(storage,value());const ignored:QaRecoveryCacheStorage={getItem:k=>storage.getItem(k),setItem:k=>{throw Error(k);},removeItem(){}};
  assert.equal(new QaRecoveryCache('owner','project',ignored).clear(value()).status,'unavailable');
  const partial:QaRecoveryCacheStorage={getItem:()=>null,setItem(){throw Error('quota exceeded');},removeItem(){throw Error('denied');}};
  assert.equal(new QaRecoveryCache('owner','project',partial).save(value(),null).status,'unavailable');assert.equal(new QaRecoveryCache('owner','project',partial).clear().status,'unavailable');
});

test('QA recovery refuses invalid namespace IDs and clears only after confirmed removal',()=>{
  const storage=new MemoryStorage();
  for(const invalid of ['', '  ','bad\nid','bad\u007fid','bad\u0085id','x'.repeat(129),'\ud800'])for(const where of [0,1]){
    const ids=['owner','project'];ids[where]=invalid;const cache=new QaRecoveryCache(ids[0],ids[1],storage);
    assert.deepEqual(cache.read(),{status:'invalid'});assert.deepEqual(cache.save(value()),{status:'invalid'});assert.deepEqual(cache.clear(),{status:'invalid'});
  }
  const cache=new QaRecoveryCache('owner','project',storage);cache.save(value());assert.deepEqual(cache.clear(value()),{status:'empty'});assert.deepEqual(cache.read(),{status:'empty'});
});

test('QA recovery accepts contract text and count boundaries without confusing escaped content with schema',()=>{
  const cache=new QaRecoveryCache('owner','project',new MemoryStorage()),questions=Array.from({length:200},(_,i)=>({id:`q${i}`,start:i,end:i,question:i===0?'\u0000'.repeat(16000):'question'}));
  const full:QaRecoveryValue={revision:Number.MAX_SAFE_INTEGER,draft:{preparation_id:'prepare-run',questions,requirements:'\u0000'.repeat(16000),use_knowledge:true,
    materials:Array.from({length:50},(_,i)=>({kind:'material',pin:{source_project_id:'member-project',material_id:`material-${i}`,material_version:1,sha256:sha}}))},
    pending:{kind:'draft',request:{expected_revision:Number.MAX_SAFE_INTEGER,draft:{preparation_id:'prepare-run',questions,requirements:'\u0000'.repeat(16000),use_knowledge:true,
      materials:Array.from({length:50},(_,i)=>({kind:'material',pin:{source_project_id:'member-project',material_id:`material-${i}`,material_version:1,sha256:sha}}))}}}};
  assert.deepEqual(cache.save(full),{status:'valid',value:full});assert.deepEqual(cache.read(),{status:'valid',value:full});
  const answer={...full,pending:{kind:'answer' as const,request:{request_id:'max-count-answer',expected_revision:full.revision,expected_points:'12000',price_version:PROJECT_QA_PRICE.version}}};
  assert.equal(cache.save(answer,full).status,'valid');
});

test('QA recovery defaults to local storage and tolerates a blocked browser storage getter',()=>{
  const storage=new MemoryStorage(),local=Object.getOwnPropertyDescriptor(globalThis,'localStorage'),session=Object.getOwnPropertyDescriptor(globalThis,'sessionStorage');
  try{
    Object.defineProperty(globalThis,'localStorage',{configurable:true,get:()=>storage});
    Object.defineProperty(globalThis,'sessionStorage',{configurable:true,get:()=>{throw Error('must not use session storage');}});
    assert.equal(new QaRecoveryCache('owner','project').save(value(),null).status,'valid');assert.deepEqual(new QaRecoveryCache('owner','project').read(),{status:'valid',value:value()});
    Object.defineProperty(globalThis,'localStorage',{configurable:true,get:()=>{throw Error('blocked');}});
    const blocked=new QaRecoveryCache('owner','project');assert.deepEqual(blocked.read(),{status:'unavailable'});assert.deepEqual(blocked.save(value()),{status:'unavailable'});assert.deepEqual(blocked.clear(),{status:'unavailable'});
    assert.equal(new QaRecoveryCache('owner','project',storage).read().status,'valid');
  }finally{
    if(local)Object.defineProperty(globalThis,'localStorage',local);else Reflect.deleteProperty(globalThis,'localStorage');
    if(session)Object.defineProperty(globalThis,'sessionStorage',session);else Reflect.deleteProperty(globalThis,'sessionStorage');
  }
});
