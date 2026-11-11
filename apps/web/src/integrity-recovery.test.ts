import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {INTEGRITY_PRICE,INTEGRITY_SITES,INTEGRITY_SITE_LIMIT,type IntegrityDraft,type M4MaterialPin} from '@bondbuddy/contracts';
import {IntegrityRecoveryCache,IntegrityRecoveryJournal,type IntegrityRecoveryValue,type IntegrityRecoveryStorage,type IntegrityEvidenceDraft} from './integrity-recovery.js';

class MemoryStorage implements IntegrityRecoveryStorage{
  values=new Map<string,string>();
  get length(){return this.values.size;}
  key(index:number):string|null{return [...this.values.keys()][index]??null;}
  getItem(key:string){return this.values.get(key)??null;}
  setItem(key:string,value:string){this.values.set(key,value);}
  removeItem(key:string){this.values.delete(key);}
}
const sha='a'.repeat(64),mainKey='bb-integrity-recovery:owner:project',prefix='bb-integrity-recovery-journal-v1:owner:project:';
const pin=():M4MaterialPin=>({source_project_id:'project',material_id:'evidence-material',material_version:3,sha256:sha});
const draft=():IntegrityDraft=>({subjects:[{id:'company-1',kind:'company',name:'示例公司',identifier:'91310000123456789A',role:'发行人',province:'上海',city:''},
  {id:'person-1',kind:'person',name:'张三',identifier:'',role:'董事',province:'',city:''}],site_ids:['credit-china','local-csrc'],notes:'核对主体身份与日期'});
const value=():IntegrityRecoveryValue=>({revision:4,draft:draft(),sourceRun:'viewed-historical-export'});
const check=(id='check-request'):IntegrityRecoveryValue=>({...value(),pending:{kind:'check',request:{request_id:id,expected_revision:4,expected_points:"5000",price_version:INTEGRITY_PRICE.version}}});

test('round intent survives preparation, pending recovery and journal replay without generating a new ID',()=>{
 const storage=new MemoryStorage(),cache=new IntegrityRecoveryCache('owner','project',storage),journal=new IntegrityRecoveryJournal('owner','project',storage);
 const prepared={...value(),roundId:'stable-round'};assert.equal(cache.save(prepared).status,'valid');assert.equal(cache.read().value?.roundId,'stable-round');
 const pending=check();pending.roundId='stable-round';if(pending.pending?.kind!=='check')throw Error('fixture');pending.pending.request.round_id='stable-round';
 assert.equal(cache.save(pending,prepared).status,'valid');assert.equal(journal.retain(pending).status,'valid');
 assert.deepEqual(journal.readAll().values?.[0],pending);
 const mismatched=structuredClone(pending);mismatched.roundId='other-round';assert.equal(cache.save(mismatched).status,'invalid');
});
test('ordinary upgrade retains numeric integrity requests in both recovery cache and journal',()=>{
  const storage=new MemoryStorage(),cache=new IntegrityRecoveryCache('owner','project',storage),journal=new IntegrityRecoveryJournal('owner','project',storage);
  const legacy=JSON.parse(JSON.stringify(check()));legacy.pending.request.expected_points=INTEGRITY_PRICE.points;
  const raw=JSON.stringify({version:'integrity-recovery-cache-v1',owner:'owner',project:'project',value:legacy});storage.setItem(mainKey,raw);
  const result=cache.read();assert.equal(result.status,'valid');assert.deepEqual(result.value,legacy);assert.equal(storage.getItem(mainKey),raw);
  assert.equal(journal.retain(legacy).status,'valid');const restored=journal.readAll();assert.equal(restored.status,'valid');
  if(restored.status==='valid')assert.deepEqual(restored.values,[legacy]);
});
const savingDraft=():IntegrityRecoveryValue=>({...value(),pending:{kind:'draft',request:{expected_revision:4,draft:draft()}}});
const exporting=(id='export-request'):IntegrityRecoveryValue=>({...value(),pending:{kind:'export',roundId:'original-round',request:{request_id:id,expected_evidence_ids:['evidence-2','evidence-1']}}});
const evidence=(id='evidence-request'):IntegrityRecoveryValue=>({...value(),pending:{kind:'evidence',roundId:'original-round',request:{request_id:id,
  subject_id:'historical-subject',site_id:'credit-china',queried_at:'2026-10-20T04:05:06.123Z',url:'https://www.creditchina.gov.cn/query',note:'已核对主体与查询条件',
  conclusion:'records_found',material:pin(),registration:{province:'上海',city:''}}}});
const form=():IntegrityEvidenceDraft=>({roundId:'original-round',subjectId:'historical-subject',siteId:'credit-china',url:'unfinished://url',time:'not-yet-a-time',
  note:'尚未完成的输入',conclusion:'unresolved',registration:{province:'',city:''},material:pin()});
const wrapper=(saved:unknown)=>({version:'integrity-recovery-cache-v1',owner:'owner',project:'project',value:saved});
function put(storage:MemoryStorage,saved:unknown){const raw=JSON.stringify(wrapper(saved));storage.setItem(mainKey,raw);return raw;}
function invalid(cache:IntegrityRecoveryCache,storage:MemoryStorage,bad:unknown){
  assert.equal(cache.save(bad as IntegrityRecoveryValue).status,'invalid');const raw=put(storage,bad);assert.equal(cache.read().status,'invalid');assert.equal(storage.getItem(mainKey),raw);
}
function canonical(input:IntegrityRecoveryValue){
  const storage=new MemoryStorage(),result=new IntegrityRecoveryCache('owner','project',storage).save(input);assert.equal(result.status,'valid');
  if(result.status!=='valid')throw Error('Invalid fixture');return {value:result.value,raw:storage.getItem(mainKey)!};
}

test('Integrity cache restores exact independent frozen snapshots for all pending operations and form material versions',()=>{
  for(const input of [savingDraft(),check(),exporting(),{...evidence(),evidenceDraft:form()}]){
    const storage=new MemoryStorage(),cache=new IntegrityRecoveryCache('owner','project',storage);assert.deepEqual(cache.read(),{status:'empty'});
    const saved=cache.save(input,null),read=cache.read();assert.equal(saved.status,'valid');assert.equal(read.status,'valid');if(saved.status!=='valid'||read.status!=='valid')continue;
    assert.deepEqual(read.value,input);assert.notEqual(saved.value,read.value);assert.notEqual(input.draft,read.value.draft);
    for(const object of [read.value,read.value.draft,read.value.draft.subjects,read.value.draft.subjects[0],read.value.draft.site_ids,read.value.pending,read.value.pending!.request])assert.equal(Object.isFrozen(object),true);
    if(read.value.pending?.kind==='draft'){assert.notEqual(read.value.draft,read.value.pending.request.draft);assert.equal(Object.isFrozen(read.value.pending.request.draft.subjects[0]),true);}
    if(read.value.pending?.kind==='export')assert.equal(Object.isFrozen(read.value.pending.request.expected_evidence_ids),true);
    if(read.value.pending?.kind==='evidence')for(const object of [read.value.pending.request.material,read.value.pending.request.registration,read.value.evidenceDraft,
      read.value.evidenceDraft!.material,read.value.evidenceDraft!.registration])assert.equal(Object.isFrozen(object),true);
    input.draft.subjects[0].name='external edit';assert.equal(read.value.draft.subjects[0].name,'示例公司');assert.equal(Reflect.set(read.value.draft.site_ids,'0','unknown'),false);
    assert.equal(JSON.parse(storage.getItem(mainKey)!).value.draft.subjects[0].name,'示例公司');
  }
});

test('Integrity local editing retains empty inline names, incomplete identifiers and unknown sites without treating them as executable',()=>{
  const storage=new MemoryStorage(),cache=new IntegrityRecoveryCache('owner','project',storage),editing=value();
  editing.draft.subjects[0].name='';editing.draft.subjects[0].identifier='not complete';editing.draft.subjects[1].name='';editing.draft.site_ids=['removed-or-future-site'];
  assert.deepEqual(cache.save(editing),{status:'valid',value:editing});assert.deepEqual(cache.read(),{status:'valid',value:editing});
  assert.equal(cache.save({...editing,pending:{kind:'draft',request:{expected_revision:4,draft:editing.draft}}}).status,'invalid');
  assert.equal(cache.save({...editing,pending:check().pending}).status,'invalid');
  assert.equal(cache.save({revision:0,draft:{subjects:[],site_ids:[],notes:''}}).status,'valid');
});

test('Integrity evidence form preserves raw incomplete values and never substitutes a query timestamp or original request body',()=>{
  const storage=new MemoryStorage(),cache=new IntegrityRecoveryCache('owner','project',storage),input={...evidence(),evidenceDraft:{...form(),url:'',time:'',note:'',material:undefined}};
  const saved=cache.save(input);assert.equal(saved.status,'valid');if(saved.status!=='valid')return;
  const {material:_material,...rawForm}=form();assert.deepEqual(saved.value.evidenceDraft,{...rawForm,url:'',time:'',note:''});
  assert.equal(Object.hasOwn(saved.value.evidenceDraft!,'material'),false);
  const restored=cache.read();assert.equal(restored.status,'valid');if(restored.status!=='valid')return;
  assert.equal(restored.value.evidenceDraft!.time,'');assert.equal(restored.value.evidenceDraft!.url,'');
  assert.equal(restored.value.pending?.kind==='evidence'&&restored.value.pending.request.queried_at,'2026-10-20T04:05:06.123Z');
});

test('Integrity cache namespaces encode delimiters and reject transplanted owner or project wrappers',()=>{
  const storage=new MemoryStorage(),first=new IntegrityRecoveryCache('owner:a','project',storage),second=new IntegrityRecoveryCache('owner','a:project',storage);
  assert.equal(first.save(value()).status,'valid');assert.equal(second.read().status,'empty');assert.equal(second.save(value()).status,'valid');
  assert.equal(storage.length,2);assert.notEqual(storage.getItem('bb-integrity-recovery:owner%3Aa:project'),storage.getItem('bb-integrity-recovery:owner:a%3Aproject'));
  const raw=canonical(value()).raw;for(const [owner,project] of [['other-owner','project'],['owner','other-project']]){
    const cache=new IntegrityRecoveryCache(owner,project,storage);assert.equal(cache.read().status,'empty');storage.setItem(`bb-integrity-recovery:${owner}:${project}`,raw);assert.equal(cache.read().status,'invalid');
  }
});

test('Integrity cache rejects unknown wrapper versions, additional fields and malformed data without deleting it',()=>{
  const storage=new MemoryStorage(),cache=new IntegrityRecoveryCache('owner','project',storage),base=wrapper(value());
  for(const bad of [value(),{...base,version:'future'},{...base,owner:'other'},{...base,project:'other'},{...base,extra:true},{owner:'owner',project:'project',value:value()}]){
    const raw=JSON.stringify(bad);storage.setItem(mainKey,raw);assert.equal(cache.read().status,'invalid');assert.equal(storage.getItem(mainKey),raw);
  }
  for(const raw of ['{broken','null','[]','"value"']){storage.setItem(mainKey,raw);assert.equal(cache.read().status,'invalid');assert.equal(storage.getItem(mainKey),raw);}
});

test('Integrity cache requires strict bounded edit fields, safe revisions, unique subject IDs and site IDs',()=>{
  const storage=new MemoryStorage(),cache=new IntegrityRecoveryCache('owner','project',storage),base=value(),subject=draft().subjects[0];
  const badDrafts:unknown[]=[null,{...draft(),extra:true},{...draft(),notes:'x'.repeat(12001)},{...draft(),subjects:[{...subject,extra:true}]},
    {...draft(),subjects:[{...subject,id:'bad\nsubject'}]},{...draft(),subjects:[{...subject,kind:'other'}]},{...draft(),subjects:[{...subject,name:'x'.repeat(201)}]},
    {...draft(),subjects:[{...subject,identifier:null}]},{...draft(),subjects:[subject,subject]},{...draft(),subjects:Array(101).fill(subject)},
    {...draft(),site_ids:['credit-china','credit-china']},{...draft(),site_ids:['bad\u0085id']},{...draft(),site_ids:Array.from({length:INTEGRITY_SITE_LIMIT+1},(_,i)=>`site-${i}`)}];
  for(const bad of [null,[],{}, {...base,extra:true},{...base,revision:-1},{...base,revision:1.5},{...base,revision:Number.MAX_SAFE_INTEGER+1},
    {...base,sourceRun:''},{...base,sourceRun:'run\nidentity'},...badDrafts.map(draft=>({...base,draft}))])invalid(cache,storage,bad);
});

test('Integrity public draft saves bind the full draft and revision and require valid business subjects',()=>{
  const storage=new MemoryStorage(),cache=new IntegrityRecoveryCache('owner','project',storage),base=savingDraft();
  for(const mutate of [(d:IntegrityDraft)=>{d.subjects[0].name=' ';},(d:IntegrityDraft)=>{d.subjects[0].identifier='lowercase-or-short';},
    (d:IntegrityDraft)=>{d.subjects.push({...d.subjects[0],id:'same-business-identity'});},(d:IntegrityDraft)=>{d.site_ids=['unknown'];}]){
    const modified=draft();mutate(modified);invalid(cache,storage,{...base,draft:modified,pending:{kind:'draft',request:{expected_revision:4,draft:modified}}});
  }
  for(const request of [{expected_revision:3,draft:draft()},{expected_revision:4,draft:{...draft(),notes:'different'}},
    {expected_revision:4,draft:{...draft(),site_ids:[...draft().site_ids].reverse()}},{expected_revision:4,draft:draft(),request_id:'extra'}])invalid(cache,storage,{...base,pending:{kind:'draft',request}});
  const empty={subjects:[],site_ids:[],notes:''};assert.equal(cache.save({...base,draft:empty,pending:{kind:'draft',request:{expected_revision:4,draft:empty}}}).status,'valid');
});

test('Integrity check pending requests require exact price, revision and a nonempty executable subject/site scope',()=>{
  const storage=new MemoryStorage(),cache=new IntegrityRecoveryCache('owner','project',storage),base=check();if(base.pending?.kind!=='check')throw Error('Fixture');
  for(const request of [{...base.pending.request,request_id:''},{...base.pending.request,request_id:'bad\nrequest'},{...base.pending.request,expected_revision:5},
    {...base.pending.request,expected_points:0},{...base.pending.request,expected_points:4999},{...base.pending.request,price_version:'future'},
    {...base.pending.request,extra:true}])invalid(cache,storage,{...base,pending:{kind:'check',request}});
  for(const changedDraft of [{...draft(),subjects:[]},{...draft(),site_ids:[]},{...draft(),site_ids:['unknown']},
    {...draft(),subjects:[draft().subjects[1]],site_ids:['local-csrc']}])invalid(cache,storage,{...base,draft:changedDraft});
  const companyOnly={...draft(),subjects:[draft().subjects[0]],site_ids:['local-csrc']};assert.equal(cache.save({...base,draft:companyOnly}).status,'valid');
});

test('Integrity recovery preserves saved legacy site IDs without remapping or silently dropping them',()=>{
  const legacy=INTEGRITY_SITES.find(site=>site.legacy)!;assert.ok(legacy);const storage=new MemoryStorage(),cache=new IntegrityRecoveryCache('owner','project',storage);
  const input=check();input.draft={...draft(),subjects:[draft().subjects[0]],site_ids:[legacy.id]};assert.equal(cache.save(input).status,'valid');
  const read=cache.read();assert.equal(read.status,'valid');if(read.status==='valid')assert.deepEqual(read.value.draft.site_ids,[legacy.id]);
});

test('Integrity export pending keeps original round and the exact unique evidence snapshot independent of editable draft',()=>{
  const storage=new MemoryStorage(),cache=new IntegrityRecoveryCache('owner','project',storage),base=exporting();if(base.pending?.kind!=='export')throw Error('Fixture');
  assert.equal(cache.save({...base,draft:{subjects:[],site_ids:['unknown-editing-site'],notes:''}}).status,'valid');
  for(const pending of [{...base.pending,roundId:''},{...base.pending,roundId:'bad\nround'},{...base.pending,extra:true},
    {...base.pending,request:{request_id:'export-request',expected_evidence_ids:['same','same']}},
    {...base.pending,request:{request_id:'export-request',expected_evidence_ids:['']}},
    {...base.pending,request:{request_id:'export-request',expected_evidence_ids:Array.from({length:2001},(_,i)=>`e-${i}`)}},
    {...base.pending,request:{...base.pending.request,expected_points:0}}])invalid(cache,storage,{...base,pending});
  assert.equal(cache.save({...base,pending:{...base.pending,request:{request_id:'export-request',expected_evidence_ids:[]}}}).status,'valid');
});

test('Integrity evidence pending preserves historical subject, round, timestamp and material pin without consulting current draft',()=>{
  const storage=new MemoryStorage(),cache=new IntegrityRecoveryCache('owner','project',storage),input=evidence();
  input.draft={subjects:[],site_ids:[],notes:'current roster differs from old round'};const saved=cache.save(input);assert.equal(saved.status,'valid');
  if(saved.status!=='valid'||saved.value.pending?.kind!=='evidence')return;
  assert.deepEqual(saved.value.pending,input.pending);assert.equal(saved.value.pending.request.material.material_version,3);
  // Pending recovery may remain for years; restoration must not compare its time to today's clock.
  const future=evidence();if(future.pending?.kind==='evidence')future.pending.request.queried_at='2099-10-20T04:05:06Z';assert.equal(cache.save(future).status,'valid');
});

test('Integrity evidence pending rejects malformed request bodies while leaving original-round membership to the API',()=>{
  const storage=new MemoryStorage(),cache=new IntegrityRecoveryCache('owner','project',storage),base=evidence();if(base.pending?.kind!=='evidence')throw Error('Fixture');
  const request=base.pending.request;
  for(const changed of [{...request,request_id:''},{...request,subject_id:'bad\nsubject'},{...request,site_id:'unknown-site'},
    {...request,queried_at:'2026-10-20T04:05'},{...request,queried_at:'2026-99-99T04:05:06Z'},
    {...request,url:''},{...request,url:'javascript:alert(1)'},{...request,url:'https://user:password@www.creditchina.gov.cn/'},
    {...request,note:' '},{...request,conclusion:'safe'},{...request,extra:true},{...request,registration:{province:'上海',city:'',extra:true}}])
    invalid(cache,storage,{...base,pending:{...base.pending,request:changed}});
  invalid(cache,storage,{...base,pending:{...base.pending,roundId:''}});
  invalid(cache,storage,{...base,pending:{kind:'unknown',request}});
});

test('Integrity form and pending evidence material pins require current project, strict IDs, hashes and safe versions',()=>{
  const storage=new MemoryStorage(),cache=new IntegrityRecoveryCache('owner','project',storage),base=evidence();if(base.pending?.kind!=='evidence')throw Error('Fixture');
  for(const material of [{...pin(),source_project_id:'member-project'},{...pin(),material_id:'bad\nmaterial'},{...pin(),material_version:0},
    {...pin(),material_version:1.5},{...pin(),material_version:Number.MAX_SAFE_INTEGER+1},{...pin(),sha256:sha.toUpperCase()},{...pin(),extra:true}]){
    invalid(cache,storage,{...value(),evidenceDraft:{...form(),material}});
    invalid(cache,storage,{...base,pending:{...base.pending,request:{...base.pending.request,material}}});
  }
});

test('Integrity form accepts incomplete user input but rejects extra fields, invalid identities and unbounded strings',()=>{
  const storage=new MemoryStorage(),cache=new IntegrityRecoveryCache('owner','project',storage);
  for(const evidenceDraft of [{...form(),extra:true},{...form(),roundId:''},{...form(),subjectId:'bad\nsubject'},{...form(),siteId:'x'.repeat(129)},
    {...form(),url:'x'.repeat(4097)},{...form(),time:'x'.repeat(201)},{...form(),note:'x'.repeat(12001)},{...form(),conclusion:'other'},
    {...form(),registration:{province:'x'.repeat(201),city:''}},{...form(),registration:{province:'',city:'',extra:true}}])invalid(cache,storage,{...value(),evidenceDraft});
  const input={...value(),evidenceDraft:{...form(),siteId:'unknown-saved-site',url:'invalid url',time:'invalid time'}};
  assert.equal(cache.save(input).status,'valid');
});

test('Integrity cache compares the complete canonical expected snapshot and refuses foreign edits or clearing another pending request',()=>{
  const storage=new MemoryStorage(),cache=new IntegrityRecoveryCache('owner','project',storage),base={...evidence(),evidenceDraft:form()};cache.save(base);const raw=storage.getItem(mainKey);
  const changes:IntegrityRecoveryValue[]=[{...base,sourceRun:'other-view'},{...base,draft:{...draft(),notes:'other'}},
    {...base,evidenceDraft:{...form(),time:'different'}},{...base,pending:evidence('different-request').pending}];
  for(const expected of changes){assert.deepEqual(cache.save(value(),expected),{status:'conflict'});assert.deepEqual(cache.clear(expected),{status:'conflict'});assert.equal(storage.getItem(mainKey),raw);}
  assert.equal(cache.save(value(),null).status,'conflict');assert.equal(cache.save({...value(),sourceRun:undefined,pending:undefined,evidenceDraft:undefined},base).status,'valid');
  assert.deepEqual(cache.read(),{status:'valid',value:{revision:4,draft:draft()}});assert.equal(cache.clear({revision:4,draft:draft()}).status,'empty');
  assert.equal(cache.save(value(),null).status,'valid');
});

test('Integrity cache canonicalizes nested field order and omitted optionals when comparing expected values',()=>{
  const storage=new MemoryStorage(),cache=new IntegrityRecoveryCache('owner','project',storage),base=evidence();cache.save(base);
  const expected:IntegrityRecoveryValue={pending:base.pending,sourceRun:base.sourceRun,draft:{notes:draft().notes,site_ids:draft().site_ids,
    subjects:draft().subjects.map(s=>({city:s.city,province:s.province,role:s.role,identifier:s.identifier,name:s.name,kind:s.kind,id:s.id}))},revision:4,evidenceDraft:undefined};
  assert.equal(cache.save(value(),expected).status,'valid');assert.equal(cache.clear(value()).status,'empty');
});

test('Integrity cache reports read/write/delete failures and failed readback without inventing durable success',()=>{
  const base=new MemoryStorage(),saved=canonical(value()).raw;base.setItem(mainKey,saved);
  for(const method of ['getItem','setItem','removeItem'] as const){
    const storage:IntegrityRecoveryStorage={get length(){return base.length;},key:i=>base.key(i),getItem:k=>base.getItem(k),setItem:(k,v)=>base.setItem(k,v),removeItem:k=>base.removeItem(k)};
    storage[method]=(()=>{throw Error('blocked');}) as never;const cache=new IntegrityRecoveryCache('owner','project',storage);
    if(method==='getItem')assert.equal(cache.read().status,'unavailable');if(method!=='removeItem')assert.equal(cache.save(value(),value()).status,'unavailable');
    assert.equal(cache.clear(value()).status,method==='setItem'?'empty':'unavailable');base.setItem(mainKey,saved);
  }
  const swallowed=new MemoryStorage();swallowed.setItem=()=>{};const cache=new IntegrityRecoveryCache('owner','project',swallowed);assert.equal(cache.save(value()).status,'unavailable');
  base.removeItem=()=>{};assert.equal(new IntegrityRecoveryCache('owner','project',base).clear(value()).status,'unavailable');
});

test('Integrity recovery defaults to local storage and rejects invalid namespace identities',()=>{
  const storage=new MemoryStorage(),descriptor=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
  try{Object.defineProperty(globalThis,'localStorage',{configurable:true,get:()=>storage});assert.equal(new IntegrityRecoveryCache('owner','project').save(value()).status,'valid');
    assert.equal(new IntegrityRecoveryJournal('owner','project').retain(check()).status,'valid');
    Object.defineProperty(globalThis,'localStorage',{configurable:true,get(){throw Error('blocked');}});
    const cache=new IntegrityRecoveryCache('owner','project'),journal=new IntegrityRecoveryJournal('owner','project');
    assert.equal(cache.read().status,'unavailable');assert.equal(cache.save(value()).status,'unavailable');assert.equal(cache.clear().status,'unavailable');
    assert.equal(journal.readAll().status,'unavailable');assert.equal(journal.retain(check()).status,'unavailable');assert.equal(journal.confirm(check()).status,'unavailable');
  }finally{if(descriptor)Object.defineProperty(globalThis,'localStorage',descriptor);else Reflect.deleteProperty(globalThis,'localStorage');}
  for(const identity of ['', 'bad\nowner','x'.repeat(129),'\ud800']){
    const cache=new IntegrityRecoveryCache(identity,'project',storage),journal=new IntegrityRecoveryJournal('owner',identity,storage);
    assert.equal(cache.read().status,'invalid');assert.equal(cache.save(value()).status,'invalid');assert.equal(cache.clear().status,'invalid');
    assert.equal(journal.readAll().status,'invalid');assert.equal(journal.retain(check()).status,'invalid');assert.equal(journal.confirm(check()).status,'invalid');
  }
});

test('Integrity journal retains all operation kinds in independent frozen slots and survives replacement of the main cache',()=>{
  const storage=new MemoryStorage(),cache=new IntegrityRecoveryCache('owner','project',storage),journal=new IntegrityRecoveryJournal('owner','project',storage);
  const values=[savingDraft(),check(),exporting(),{...evidence(),evidenceDraft:form()}];assert.deepEqual(journal.readAll(),{status:'valid',values:[]});
  cache.save(check());for(const input of values)assert.equal(journal.retain(input).status,'valid');cache.clear(check());cache.save(value(),null);
  const read=journal.readAll();assert.equal(read.status,'valid');if(read.status!=='valid')return;assert.equal(read.values.length,4);assert.equal(Object.isFrozen(read.values),true);
  for(const input of read.values)assert.equal(Object.isFrozen(input.pending!.request),true);
  values[0].draft.notes='external edit';assert.equal(read.values.find(v=>v.pending?.kind==='draft')!.draft.notes,'核对主体身份与日期');
  assert.equal(journal.retain(check()).status,'valid');assert.equal(storage.length,5);
});

test('Integrity journal refuses same request identities with any changed complete body, original round or recovered form',()=>{
  for(const base of [check(),exporting(),evidence()]){
    const storage=new MemoryStorage(),journal=new IntegrityRecoveryJournal('owner','project',storage);journal.retain(base);const before=new Map(storage.values);
    const changes:IntegrityRecoveryValue[]=[{...base,sourceRun:'other'},{...base,draft:{...draft(),notes:'other'}},{...base,evidenceDraft:form()}];
    if(base.pending?.kind==='export')changes.push({...base,pending:{...base.pending,roundId:'other-round'}},
      {...base,pending:{...base.pending,request:{...base.pending.request,expected_evidence_ids:[...base.pending.request.expected_evidence_ids].reverse()}}});
    if(base.pending?.kind==='evidence')changes.push({...base,pending:{...base.pending,roundId:'other-round'}},
      {...base,pending:{...base.pending,request:{...base.pending.request,material:{...pin(),material_version:4}}}});
    for(const input of changes){assert.equal(journal.retain(input).status,'conflict');assert.equal(journal.confirm(input).status,'conflict');assert.deepEqual(storage.values,before);}
  }
});

test('Integrity journal separates operations, request IDs and canonical SHA-bound draft bodies including Unicode',()=>{
  const storage=new MemoryStorage(),journal=new IntegrityRecoveryJournal('owner','project',storage),first=savingDraft(),second=savingDraft();
  second.draft.notes='中文请求 😀 : %';if(second.pending?.kind==='draft')second.pending.request.draft.notes=second.draft.notes;
  for(const input of [check('same-id'),exporting('same-id'),evidence('same-id'),check('other-id'),first,second])assert.equal(journal.retain(input).status,'valid');
  assert.equal(storage.length,6);
  for(const input of [first,second]){const normalized=canonical(input).value;if(normalized.pending?.kind!=='draft')throw Error('Fixture');
    const digest=createHash('sha256').update(JSON.stringify(normalized.pending.request),'utf8').digest('hex');assert.equal(storage.values.has(prefix+'draft:4:'+digest),true);}
  const encoded=check('请求:百分比%/😀');assert.equal(journal.retain(encoded).status,'valid');assert.equal(storage.values.has(prefix+'check:'+encodeURIComponent('请求:百分比%/😀')),true);
  assert.equal(journal.confirm(first).status,'empty');assert.equal(storage.length,6);
});

test('Integrity journal canonicalizes reordered properties and omitted optionals without overwriting an identity',()=>{
  const storage=new MemoryStorage(),journal=new IntegrityRecoveryJournal('owner','project',storage),base=savingDraft();journal.retain(base);const before=new Map(storage.values);
  const reordered:IntegrityRecoveryValue={pending:{kind:'draft',request:{draft:{notes:draft().notes,site_ids:draft().site_ids,subjects:draft().subjects},expected_revision:4}},
    sourceRun:base.sourceRun,revision:4,evidenceDraft:undefined,draft:{notes:draft().notes,site_ids:draft().site_ids,subjects:draft().subjects}};
  assert.equal(journal.retain(reordered).status,'valid');assert.deepEqual(storage.values,before);assert.equal(journal.confirm(reordered).status,'empty');
});

test('Integrity journal ignores unrelated namespaces, rejects transplanted wrappers and never touches another owner or project',()=>{
  const storage=new MemoryStorage(),journal=new IntegrityRecoveryJournal('owner','project',storage),other=new IntegrityRecoveryJournal('owner:a','project',storage);
  other.retain(check());storage.setItem('unrelated','{broken');assert.deepEqual(journal.readAll(),{status:'valid',values:[]});journal.retain(check());
  const raw=storage.getItem(prefix+'check:check-request')!;const foreign=[...storage.values.entries()].find(([key])=>key.includes('owner%3Aa'))!;
  storage.setItem(prefix+'check:check-request',foreign[1]);assert.equal(journal.readAll().status,'invalid');assert.equal(storage.getItem(prefix+'check:check-request'),foreign[1]);
  storage.setItem(prefix+'check:check-request',raw);assert.equal(journal.confirm(check()).status,'empty');assert.equal(storage.getItem(foreign[0]),foreign[1]);assert.equal(storage.getItem('unrelated'),'{broken');
});

test('Integrity journal refuses corrupt rows, missing pending envelopes and key/body mismatches without deleting recoverable data',()=>{
  const storage=new MemoryStorage(),journal=new IntegrityRecoveryJournal('owner','project',storage),raw=canonical(check()).raw,parsed=JSON.parse(raw);
  for(const corrupt of ['{broken',JSON.stringify({...parsed,version:'future'}),JSON.stringify({...parsed,value:{...parsed.value,pending:undefined}}),
    JSON.stringify({...parsed,value:{...parsed.value,pending:{...parsed.value.pending,request:{...parsed.value.pending.request,expected_points:0}}}})]){
    storage.setItem(prefix+'check:check-request',corrupt);assert.equal(journal.readAll().status,'invalid');assert.equal(journal.retain(check('new-request')).status,'invalid');assert.equal(storage.getItem(prefix+'check:check-request'),corrupt);
  }
  storage.values.clear();storage.setItem(prefix+'check:other-request',raw);assert.equal(journal.readAll().status,'invalid');assert.equal(storage.length,1);
  storage.values.clear();journal.retain(savingDraft());const [key,body]=[...storage.values.entries()][0];storage.values.clear();storage.setItem(key.slice(0,-1)+(key.endsWith('0')?'1':'0'),body);assert.equal(journal.readAll().status,'invalid');
  assert.equal(journal.retain(value()).status,'invalid');assert.equal(journal.confirm(value()).status,'invalid');
});

test('Integrity journal confirmation removes only an exact acknowledged envelope even when another archived row is corrupt',()=>{
  const storage=new MemoryStorage(),journal=new IntegrityRecoveryJournal('owner','project',storage);journal.retain(evidence());journal.retain(exporting());storage.setItem(prefix+'check:broken','{broken');
  const exportRaw=storage.getItem(prefix+'export:export-request');assert.equal(journal.readAll().status,'invalid');assert.equal(journal.confirm(evidence()).status,'empty');
  assert.equal(storage.getItem(prefix+'export:export-request'),exportRaw);assert.equal(storage.getItem(prefix+'check:broken'),'{broken');assert.equal(journal.confirm(evidence()).status,'conflict');
});

test('Integrity journal reports quota failures, unstable reads and silent writes rather than claiming persistence',()=>{
  const storage=new MemoryStorage();storage.setItem=()=>{throw Error('quota');};assert.equal(new IntegrityRecoveryJournal('owner','project',storage).retain(check()).status,'unavailable');
  const silent=new MemoryStorage();silent.setItem=()=>{};assert.equal(new IntegrityRecoveryJournal('owner','project',silent).retain(check()).status,'unavailable');
  const unreadable=new MemoryStorage();unreadable.getItem=()=>{throw Error('blocked');};const journal=new IntegrityRecoveryJournal('owner','project',unreadable);
  unreadable.values.set(prefix+'check:check-request',canonical(check()).raw);assert.equal(journal.readAll().status,'unavailable');assert.equal(journal.retain(check()).status,'unavailable');assert.equal(journal.confirm(check()).status,'unavailable');
  const changing=new MemoryStorage();changing.values.set(prefix+'check:check-request',canonical(check()).raw);let reads=0;const get=changing.getItem.bind(changing);
  changing.getItem=key=>{reads++;return reads===2?canonical(check('other-request')).raw:get(key);};assert.equal(new IntegrityRecoveryJournal('owner','project',changing).readAll().status,'unavailable');
});

test('Integrity journal detects enumeration changes and a competing identity before write without overwriting it',()=>{
  for(const bad of ['duplicate','missing','unsafe-length'] as const){
    const storage=new MemoryStorage();storage.setItem('unrelated','one');storage.setItem('second','two');
    if(bad==='duplicate')storage.key=()=> 'unrelated';if(bad==='missing')storage.key=()=>null;
    if(bad==='unsafe-length')Object.defineProperty(storage,'length',{get:()=>Number.MAX_SAFE_INTEGER+1});
    assert.equal(new IntegrityRecoveryJournal('owner','project',storage).readAll().status,'unavailable');
  }
  const storage=new MemoryStorage(),journal=new IntegrityRecoveryJournal('owner','project',storage),foreign={...check(),sourceRun:'other-page'};let reads=0;
  const raw=canonical(foreign).raw;storage.getItem=key=>{reads++;if(reads===1&&key===prefix+'check:check-request'){storage.values.set(key,raw);return raw;}return storage.values.get(key)??null;};
  assert.equal(journal.retain(check()).status,'conflict');assert.equal(storage.values.get(prefix+'check:check-request'),raw);
});

test('Integrity journal distinguishes acknowledgement cleanup failure from unknown request persistence',()=>{
  const storage=new MemoryStorage(),journal=new IntegrityRecoveryJournal('owner','project',storage),original=evidence();journal.retain(original);
  storage.removeItem=()=>{throw Error('cleanup blocked');};assert.equal(journal.confirm(original).status,'unavailable');assert.deepEqual(journal.readAll(),{status:'valid',values:[original]});
  storage.removeItem=key=>{storage.values.delete(key);};let removed=false;const get=storage.getItem.bind(storage);
  storage.removeItem=key=>{storage.values.delete(key);removed=true;};storage.getItem=key=>{if(removed)throw Error('readback blocked');return get(key);};
  assert.equal(journal.confirm(original).status,'unavailable');assert.equal(storage.values.has(prefix+'evidence:evidence-request'),false);
  // confirm reports storage state only. The UI must retain its authoritative ack
  // and display a cleanup warning instead of retrying with a new request ID.
});
