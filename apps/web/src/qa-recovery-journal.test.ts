import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {PROJECT_QA_PRICE,type QaDraft} from '@bondbuddy/contracts';
import {QaRecoveryCache,type QaRecoveryValue} from './qa-recovery-cache.js';
import {QaRecoveryJournal,type QaRecoveryJournalStorage} from './qa-recovery-journal.js';

class MemoryStorage implements QaRecoveryJournalStorage{
  values=new Map<string,string>();
  get length(){return this.values.size;}
  key(index:number){return [...this.values.keys()][index]??null;}
  getItem(key:string){return this.values.get(key)??null;}
  setItem(key:string,value:string){this.values.set(key,value);}
  removeItem(key:string){this.values.delete(key);}
}
const prefix='bb-qa-recovery-journal-v1:owner:project:',sha='a'.repeat(64),mainKey='bb-qa-recovery:owner:project';
const draft=():QaDraft=>({preparation_id:'prepare-run',questions:[{id:'q2',start:2,end:2,question:'请说明偿债安排。'}],materials:[{kind:'material',pin:{source_project_id:'member-project',material_id:'audit',material_version:3,sha256:sha}}],requirements:'核对项目原始依据',use_knowledge:false});
const answer=(request='answer-request'):QaRecoveryValue=>({revision:4,draft:draft(),sourceRun:'historical-answer',needsKnowledgeChoice:false,
  pending:{kind:'answer',request:{request_id:request,expected_revision:4,expected_points:60,price_version:PROJECT_QA_PRICE.version}}});
const prepare=(request='prepare-request'):QaRecoveryValue=>({...answer(),needsKnowledgeChoice:true,pending:{kind:'prepare',request:{request_id:request,
  source:{kind:'material',pin:{source_project_id:'project',material_id:'questions',material_version:1,sha256:sha}}}}});
const savingDraft=():QaRecoveryValue=>({...answer(),pending:{kind:'draft',request:{expected_revision:4,draft:draft()}}});
function canonical(value:QaRecoveryValue){
  const storage=new MemoryStorage(),saved=new QaRecoveryCache('owner','project',storage).save(value);assert.equal(saved.status,'valid');
  if(saved.status!=='valid')throw Error('Invalid fixture');return {value:saved.value,raw:storage.values.get(mainKey)!};
}

test('QA journal retains every pending kind as independent fully validated and deeply frozen snapshots',()=>{
  const storage=new MemoryStorage(),journal=new QaRecoveryJournal('owner','project',storage),values=[answer(),prepare(),savingDraft()];
  assert.deepEqual(journal.readAll(),{status:'valid',values:[]});for(const value of values)assert.equal(journal.retain(value).status,'valid');
  const read=journal.readAll();assert.equal(read.status,'valid');if(read.status!=='valid')return;
  assert.equal(read.values.length,3);assert.equal(Object.isFrozen(read.values),true);
  for(const value of read.values)for(const object of [value,value.draft,value.draft.questions,value.draft.questions[0],value.draft.materials[0].pin,value.pending,value.pending!.request])assert.equal(Object.isFrozen(object),true);
  const restored=read.values.find(value=>value.pending?.kind==='answer')!;values[0].draft.requirements='external mutation';assert.equal(restored.draft.requirements,'核对项目原始依据');
  const again=journal.readAll();assert.equal(again.status,'valid');if(again.status==='valid')assert.notEqual(again.values[0],read.values[0]);
});

test('QA journal survives another page clearing or replacing the single draft cache',()=>{
  const storage=new MemoryStorage(),journal=new QaRecoveryJournal('owner','project',storage),cache=new QaRecoveryCache('owner','project',storage),original=answer();
  assert.equal(cache.save(original,null).status,'valid');assert.equal(journal.retain(original).status,'valid');assert.equal(cache.clear(original).status,'empty');
  assert.equal(cache.save({...answer('other-request'),pending:undefined},null).status,'valid');assert.deepEqual(journal.readAll(),{status:'valid',values:[original]});
  const before=new Map(storage.values);assert.equal(journal.retain(original).status,'valid');assert.deepEqual(storage.values,before);
});

test('QA journal same request identity conflicts on every complete snapshot difference and preserves the old record',()=>{
  const storage=new MemoryStorage(),journal=new QaRecoveryJournal('owner','project',storage),base=answer();journal.retain(base);const raw=storage.getItem(prefix+'answer:answer-request');
  const changes=[{...base,sourceRun:'other-view'},{...base,needsKnowledgeChoice:undefined},{...base,draft:{...draft(),requirements:'different'}},
    {...base,draft:{...draft(),materials:[]}},{...base,draft:{...draft(),use_knowledge:true}},
    {...base,revision:5,pending:{kind:'answer' as const,request:{request_id:'answer-request',expected_revision:5,expected_points:60,price_version:PROJECT_QA_PRICE.version}}}];
  for(const value of changes){assert.deepEqual(journal.retain(value),{status:'conflict'});assert.deepEqual(journal.confirm(value),{status:'conflict'});assert.equal(storage.getItem(prefix+'answer:answer-request'),raw);}
  const second=prepare();journal.retain(second);if(second.pending?.kind==='prepare')second.pending.request.source.pin.sha256='b'.repeat(64);
  assert.equal(journal.retain(second).status,'conflict');
});

test('QA journal separates request IDs, operation kinds and complete draft request identities',()=>{
  const storage=new MemoryStorage(),journal=new QaRecoveryJournal('owner','project',storage),first=savingDraft(),second=savingDraft();
  second.draft.requirements='第二种修改';if(second.pending?.kind==='draft')second.pending.request.draft.requirements=second.draft.requirements;
  for(const value of [answer('same-id'),prepare('same-id'),answer('other-id'),first,second])assert.equal(journal.retain(value).status,'valid');
  const result=journal.readAll();assert.equal(result.status,'valid');if(result.status==='valid')assert.equal(result.values.length,5);
  assert.equal([...storage.values.keys()].filter(key=>key.includes(':draft:4:')).length,2);
  assert.equal(journal.confirm(first).status,'empty');assert.equal(journal.readAll().status,'valid');assert.equal(storage.length,4);
});

test('QA journal canonicalizes property ordering and omitted optionals while encoding request identities',()=>{
  const storage=new MemoryStorage(),journal=new QaRecoveryJournal('owner','project',storage),base=savingDraft(),reordered=savingDraft();
  reordered.draft={use_knowledge:false,requirements:base.draft.requirements,materials:base.draft.materials.map(asset=>asset.kind==='material'?{pin:{sha256:asset.pin.sha256,material_version:asset.pin.material_version,material_id:asset.pin.material_id,source_project_id:asset.pin.source_project_id},kind:'material'}:asset),
    questions:base.draft.questions.map(q=>({question:q.question,end:q.end,start:q.start,id:q.id})),preparation_id:base.draft.preparation_id};
  reordered.pending={kind:'draft',request:{draft:reordered.draft,expected_revision:4}};
  assert.equal(journal.retain(base).status,'valid');assert.equal(journal.retain(reordered).status,'valid');assert.equal(storage.length,1);
  const omitted={...answer('请求:百分比%/😀'),sourceRun:undefined,needsKnowledgeChoice:undefined};assert.equal(journal.retain(omitted).status,'valid');
  assert.equal(storage.values.has(prefix+'answer:'+encodeURIComponent('请求:百分比%/😀')),true);assert.equal(journal.confirm(omitted).status,'empty');
});

test('QA journal isolates owner and project namespaces and rejects transplanted wrapper identities',()=>{
  const storage=new MemoryStorage(),first=new QaRecoveryJournal('owner:a','project',storage),other=new QaRecoveryJournal('owner','a:project',storage),base={...answer(),pending:answer().pending};
  assert.equal(first.retain(base).status,'valid');assert.deepEqual(other.readAll(),{status:'valid',values:[]});assert.equal(other.retain(base).status,'valid');assert.equal(storage.length,2);
  const target=prefix+'answer:answer-request',foreign=[...storage.values.values()][0];storage.setItem(target,foreign);
  assert.deepEqual(new QaRecoveryJournal('owner','project',storage).readAll(),{status:'invalid'});assert.equal(storage.getItem(target),foreign);
});

test('QA journal rejects corrupted or incomplete scoped records and key/body mismatches without deleting them',()=>{
  const storage=new MemoryStorage(),journal=new QaRecoveryJournal('owner','project',storage),good=canonical(answer()).raw;
  const parsed=JSON.parse(good),bad:unknown[]=[null,[],{...parsed,extra:true},{...parsed,version:'future'},{...parsed,value:{...parsed.value,pending:undefined}},
    {...parsed,value:{...parsed.value,extra:true}},{...parsed,value:{...parsed.value,pending:{...parsed.value.pending,request:{...parsed.value.pending.request,expected_points:120}}}}];
  for(const value of bad){const raw=JSON.stringify(value);storage.setItem(prefix+'answer:answer-request',raw);assert.deepEqual(journal.readAll(),{status:'invalid'});assert.equal(storage.getItem(prefix+'answer:answer-request'),raw);}
  storage.setItem(prefix+'answer:answer-request','{broken');assert.equal(journal.readAll().status,'invalid');
  storage.values.clear();storage.setItem(prefix+'answer:wrong-request',good);assert.equal(journal.readAll().status,'invalid');assert.equal(storage.length,1);
  storage.values.clear();journal.retain(savingDraft());const [key,raw]=[...storage.values.entries()][0];storage.values.clear();storage.setItem(key.slice(0,-1)+(key.endsWith('0')?'1':'0'),raw);assert.equal(journal.readAll().status,'invalid');
});

test('QA journal blocks retaining new requests when any same-scope record is invalid and ignores unrelated scopes',()=>{
  const storage=new MemoryStorage(),journal=new QaRecoveryJournal('owner','project',storage);storage.setItem('bb-qa-recovery-journal-v1:other:project:garbage','{broken');
  assert.equal(journal.retain(answer()).status,'valid');storage.setItem(prefix+'broken','bad');const before=new Map(storage.values);
  assert.deepEqual(journal.retain(prepare()),{status:'invalid'});assert.deepEqual(storage.values,before);
  assert.equal(journal.confirm(answer()).status,'empty');assert.equal(storage.values.has(prefix+'broken'),true);
});

test('QA journal confirmation removes only the complete expected request and does not treat missing records as confirmed',()=>{
  const storage=new MemoryStorage(),journal=new QaRecoveryJournal('owner','project',storage),first=answer(),second=answer('second');journal.retain(first);journal.retain(second);
  assert.equal(journal.confirm({...first,pending:undefined}).status,'invalid');assert.equal(storage.length,2);
  assert.deepEqual(journal.confirm(first),{status:'empty'});assert.equal(storage.length,1);assert.deepEqual(journal.readAll(),{status:'valid',values:[second]});
  assert.deepEqual(journal.confirm(first),{status:'conflict'});assert.equal(storage.length,1);
  storage.setItem(prefix+'answer:second','{broken');assert.deepEqual(journal.confirm(second),{status:'invalid'});assert.equal(storage.getItem(prefix+'answer:second'),'{broken');
});

test('QA journal checks for a changed confirmation target and verifies removal readback',()=>{
  const backing=new MemoryStorage(),base=answer();new QaRecoveryJournal('owner','project',backing).retain(base);const target=prefix+'answer:answer-request',raw=backing.getItem(target)!;
  let reads=0,removed=false;
  const changed:QaRecoveryJournalStorage={get length(){return backing.length;},key:i=>backing.key(i),getItem(key){reads++;return reads===2?canonical({...base,sourceRun:'changed'}).raw:backing.getItem(key);},setItem:(k,v)=>backing.setItem(k,v),removeItem(){removed=true;}};
  assert.equal(new QaRecoveryJournal('owner','project',changed).confirm(base).status,'conflict');assert.equal(removed,false);assert.equal(backing.getItem(target),raw);
  const ignored:QaRecoveryJournalStorage={get length(){return backing.length;},key:i=>backing.key(i),getItem:k=>backing.getItem(k),setItem:(k,v)=>backing.setItem(k,v),removeItem(){}};
  assert.equal(new QaRecoveryJournal('owner','project',ignored).confirm(base).status,'unavailable');assert.equal(backing.getItem(target),raw);
});

test('QA journal reports enumeration and storage exceptions as unavailable',()=>{
  const storage=new MemoryStorage(),base=answer();new QaRecoveryJournal('owner','project',storage).retain(base);
  const seam=(patch:Partial<QaRecoveryJournalStorage>):QaRecoveryJournalStorage=>({get length(){return storage.length;},key:i=>storage.key(i),getItem:k=>storage.getItem(k),setItem:(k,v)=>storage.setItem(k,v),removeItem:k=>storage.removeItem(k),...patch});
  for(const broken of [seam({key(){throw Error('key denied');}}),seam({getItem(){throw Error('read denied');}})]){
    const journal=new QaRecoveryJournal('owner','project',broken);assert.equal(journal.readAll().status,'unavailable');assert.equal(journal.retain(prepare()).status,'unavailable');
  }
  const quota=new QaRecoveryJournal('owner','project',seam({setItem(){throw Error('quota');}}));assert.equal(quota.retain(prepare()).status,'unavailable');
  const denied=new QaRecoveryJournal('owner','project',seam({removeItem(){throw Error('remove denied');}}));assert.equal(denied.confirm(base).status,'unavailable');
  const badLength=seam({});Object.defineProperty(badLength,'length',{get(){throw Error('length denied');}});assert.equal(new QaRecoveryJournal('owner','project',badLength).readAll().status,'unavailable');
});

test('QA journal detects silently lost or altered writes and never prunes other requests for quota',()=>{
  const backing=new MemoryStorage(),base=answer();new QaRecoveryJournal('owner','project',backing).retain(base);const initial=new Map(backing.values);
  const seam=(setItem:QaRecoveryJournalStorage['setItem']):QaRecoveryJournalStorage=>({get length(){return backing.length;},key:i=>backing.key(i),getItem:k=>backing.getItem(k),setItem,removeItem:k=>backing.removeItem(k)});
  assert.equal(new QaRecoveryJournal('owner','project',seam(()=>{})).retain(prepare()).status,'unavailable');assert.deepEqual(backing.values,initial);
  const altered=seam((key,raw)=>{const body=JSON.parse(raw);body.value.sourceRun='changed-by-storage';backing.setItem(key,JSON.stringify(body));});
  assert.equal(new QaRecoveryJournal('owner','project',altered).retain(prepare()).status,'unavailable');assert.equal(backing.getItem(prefix+'answer:answer-request'),initial.get(prefix+'answer:answer-request'));
});

test('QA journal fails closed when keys disappear, duplicate or change during enumeration',()=>{
  const backing=new MemoryStorage();new QaRecoveryJournal('owner','project',backing).retain(answer());new QaRecoveryJournal('owner','project',backing).retain(prepare());
  const base:QaRecoveryJournalStorage={get length(){return backing.length;},key:i=>backing.key(i),getItem:k=>backing.getItem(k),setItem:(k,v)=>backing.setItem(k,v),removeItem:k=>backing.removeItem(k)};
  for(const key of [(i:number)=>i===0?backing.key(0):null,()=>backing.key(0)])assert.equal(new QaRecoveryJournal('owner','project',{...base,key}).readAll().status,'unavailable');
  let enumerations=0;const changing={...base,key(i:number){if(i===0)enumerations++;return enumerations===1?backing.key(i):i===0?'unrelated':backing.key(i);}};
  assert.equal(new QaRecoveryJournal('owner','project',changing).readAll().status,'unavailable');
  const gone={...base,getItem:()=>null};assert.equal(new QaRecoveryJournal('owner','project',gone).readAll().status,'unavailable');assert.equal(backing.length,2);
});

test('QA journal draft SHA-256 keys match an independent UTF-8 oracle across block, Unicode and contract text boundaries',()=>{
  for(const text of ['', 'a','x'.repeat(55),'x'.repeat(56),'x'.repeat(63),'x'.repeat(64),'x'.repeat(65),'汉字😀\u0000\n'.repeat(80),'\u0000'.repeat(16000)]){
    const value=savingDraft();value.draft.requirements=text;if(value.pending?.kind!=='draft')throw Error('Wrong fixture');value.pending.request.draft.requirements=text;
    const normalized=canonical(value).value;assert.equal(normalized.pending?.kind,'draft');if(normalized.pending?.kind!=='draft')return;
    const digest=createHash('sha256').update(JSON.stringify(normalized.pending.request),'utf8').digest('hex'),storage=new MemoryStorage(),journal=new QaRecoveryJournal('owner','project',storage);
    assert.equal(journal.retain(value).status,'valid');assert.deepEqual([...storage.values.keys()],[prefix+'draft:4:'+digest]);assert.equal(journal.readAll().status,'valid');
  }
});

test('QA journal defaults to local storage, rejects invalid namespaces and requires a complete pending value',()=>{
  const storage=new MemoryStorage(),local=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
  try{
    Object.defineProperty(globalThis,'localStorage',{configurable:true,get:()=>storage});assert.equal(new QaRecoveryJournal('owner','project').retain(answer()).status,'valid');
    assert.deepEqual(new QaRecoveryJournal('owner','project').readAll(),{status:'valid',values:[answer()]});
    Object.defineProperty(globalThis,'localStorage',{configurable:true,get(){throw Error('blocked');}});const blocked=new QaRecoveryJournal('owner','project');
    assert.equal(blocked.readAll().status,'unavailable');assert.equal(blocked.retain(answer()).status,'unavailable');assert.equal(blocked.confirm(answer()).status,'unavailable');
  }finally{if(local)Object.defineProperty(globalThis,'localStorage',local);else Reflect.deleteProperty(globalThis,'localStorage');}
  for(const invalid of ['', 'bad\nowner','x'.repeat(129),'\ud800']){
    const journal=new QaRecoveryJournal(invalid,'project',storage);assert.equal(journal.readAll().status,'invalid');assert.equal(journal.retain(answer()).status,'invalid');assert.equal(journal.confirm(answer()).status,'invalid');
  }
  const journal=new QaRecoveryJournal('owner','project',storage);assert.equal(journal.retain({...answer(),pending:undefined}).status,'invalid');assert.equal(journal.retain({...answer(),extra:true} as QaRecoveryValue).status,'invalid');
});
