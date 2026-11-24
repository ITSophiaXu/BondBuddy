import assert from 'node:assert/strict';
import {test} from 'node:test';
import {FormatRegistry} from '@sinclair/typebox';
import {QaRecoveryCache,type QaRecoveryValue} from './qa-recovery-cache.js';
import {QaUploadJournal,qaUploadEnvelope,qaUploadExpected,qaUploadSame,qaUploadContext,qaUploadRecordMatches,qaUploadMaterialMatches,type QaUploadEnvelope} from './qa-upload-recovery.js';
import type {Dto} from './api.js';
import type {UploadRecoveryRecord,UploadRecoveryStorage} from './upload-recovery.js';
FormatRegistry.Set('date-time',v=>!Number.isNaN(Date.parse(v)));
class Store implements UploadRecoveryStorage{values=new Map<string,string>();get length(){return this.values.size;}key(i:number){return [...this.values.keys()][i]??null;}getItem(k:string){return this.values.get(k)??null;}setItem(k:string,v:string){this.values.set(k,v);}removeItem(k:string){this.values.delete(k);}}
const base=():QaRecoveryValue=>({revision:8,draft:{preparation_id:'prepare-original',questions:[{id:'q0',start:0,end:0,question:'原问题'}],materials:[],requirements:'原要求',use_knowledge:false},needsKnowledgeChoice:true,sourceRun:'original-answer'});
const declaration=(name='原补料.doc'):Dto<'UploadCreateRequest'>=>({filename:name,role:'other',media_type:'application/msword',sha256:'a'.repeat(64),byte_size:88});
const envelope=()=>qaUploadEnvelope('owner','project','supplement',base(),[declaration()]);
const material=():Dto<'MaterialResponse'>=>({material_id:'saved-original',material_version:3,upload_id:'older-deduplicated-upload',role:'other',filename:'原先的同内容.doc',media_type:'application/msword',sha256:'a'.repeat(64),byte_size:88,state:'persisted',persisted_at:'2026-10-25T00:00:00Z',error:null});
test('source upload pins the saved list in the draft without creating a preparation request',()=>{
 const initial:QaRecoveryValue={revision:0,draft:{preparation_id:null,questions:[],materials:[],requirements:'',use_knowledge:false}};
 const e=qaUploadEnvelope('owner','project','source',initial,[declaration('问题清单.doc')]);
 const confirmed=structuredClone(e);confirmed.items[0].material=material();confirmed.items[0].applied=true;
 const journal=new QaUploadJournal('owner','project',new Store());
 assert.equal(journal.save(e,null).status,'valid');assert.equal(journal.save(confirmed,e).status,'valid');
 const next=qaUploadExpected(confirmed);
 assert.deepEqual(next.draft.source,{kind:'material',pin:{source_project_id:'project',material_id:'saved-original',material_version:3,sha256:'a'.repeat(64)}});
 assert.equal(next.draft.preparation_id,null);assert.deepEqual(next.draft.questions,[]);assert.deepEqual(next.draft.materials,[]);
 assert.equal(next.pending,undefined);
});
test('QA upload envelopes preserve a large original draft outside the bounded transport context',()=>{
 const value=base();value.draft.questions=Array.from({length:40},(_,i)=>({id:`q${i}`,start:i,end:i,question:'原'.repeat(16000)}));
 const e=qaUploadEnvelope('owner','project','supplement',value,[declaration()]),store=new Store(),journal=new QaUploadJournal('owner','project',store);
 assert.equal(journal.save(e,null).status,'valid');assert.deepEqual(journal.readAll(),{status:'valid',value:[e]});
 const context=qaUploadContext(e,0);assert.ok(JSON.stringify(context).length<512);assert.ok(!JSON.stringify(context).includes('原要求'));
 assert.deepEqual(new QaUploadJournal('other','project',store).readAll(),{status:'valid',value:[]});assert.deepEqual(new QaUploadJournal('owner','other',store).readAll(),{status:'valid',value:[]});
});
test('QA upload uses a new strict v1 envelope and leaves the existing QA cache schema unchanged',()=>{
 const store=new Store(),cache=new QaRecoveryCache('owner','project',store),b=base();assert.equal(cache.save(b,null).status,'valid');
 const journal=new QaUploadJournal('owner','project',store),e=envelope();assert.equal(journal.save(e,null).status,'valid');assert.deepEqual(cache.read(),{status:'valid',value:b});
 const original=[...store.values.entries()].find(([k])=>k.startsWith('bb-qa-upload-v1:'))!;
 for(const change of [{version:2},{owner:'other'},{project:'other'},{extra:'unknown'},{base:{...e.base,upload:{id:'unknown'}}},{digest:'f'.repeat(64)}]){
  const bad={...e,...change};store.values.set(original[0],JSON.stringify(bad));assert.notEqual(journal.readAll().status,'valid');assert.equal(journal.save(e,null).status==='valid',false);assert.equal(store.values.get(original[0]),JSON.stringify(bad));
 }store.values.set(original[0],original[1]);assert.equal(journal.readAll().status,'valid');
});
test('QA upload declarations preserve DOC and reject unsupported source types or non-other roles',()=>{
 assert.equal(qaUploadEnvelope('owner','project','source',base(),[declaration()]).items[0].declaration.media_type,'application/msword');
 assert.equal(qaUploadEnvelope('owner','project','source',base(),[{...declaration(),filename:'questions.PDF',media_type:'application/pdf'}]).items[0].declaration.media_type,'application/pdf');
 for(const d of [{...declaration(),role:'audit'},{...declaration(),filename:'questions.xlsx',media_type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'},{...declaration(),filename:'questions.docx'},{...declaration(),byte_size:0}])assert.throws(()=>qaUploadEnvelope('owner','project','source',base(),[d as Dto<'UploadCreateRequest'>]));
 assert.throws(()=>qaUploadEnvelope('owner','project','supplement',{...base(),pending:{kind:'prepare',request:{request_id:'pending',source:{kind:'material',pin:{source_project_id:'project',material_id:'old',material_version:1,sha256:'b'.repeat(64)}}}}},[declaration()]));
});
test('QA envelopes bind ordered operations and their original immutable preparation digest',()=>{
 const e=envelope();const r:UploadRecoveryRecord={version:1,id:e.items[0].id,owner:e.owner,projectId:e.project,purpose:'qa-supplement',declaration:e.items[0].declaration,context:qaUploadContext(e,0),stage:'pending'};
 assert.equal(qaUploadRecordMatches(e,0,r),true);
 for(const changed of [{owner:'foreign'},{projectId:'foreign'},{purpose:'qa-source'},{id:'other'},{context:{...(r.context as object),index:1}},{declaration:{...r.declaration,sha256:'b'.repeat(64)}}])assert.equal(qaUploadRecordMatches(e,0,{...r,...changed}),false);
});
test('QA envelope accepts exact old-upload dedup receipts and appends only the original pinned material',()=>{
 const e=envelope(),next=structuredClone(e);next.items[0].material=material();const store=new Store(),journal=new QaUploadJournal('owner','project',store);assert.equal(journal.save(e,null).status,'valid');assert.equal(journal.save(next,e).status,'valid');
 const expected=qaUploadExpected(next),adopted=qaUploadExpected(next,0);assert.deepEqual(expected,e.base);assert.equal(adopted.draft.materials.length,1);assert.equal(adopted.draft.preparation_id,e.base.draft.preparation_id);assert.equal(adopted.draft.materials[0].pin.sha256,material().sha256);assert.equal(adopted.needsKnowledgeChoice,true);
 next.items[0].applied=true;assert.deepEqual(qaUploadExpected(next),adopted);assert.equal(qaUploadSame(expected,adopted),false);
 for(const change of [{role:'audit'},{sha256:'f'.repeat(64)},{material_version:0},{state:'uploading'},{media_type:'application/pdf'},{byte_size:89},{error:'unverified'}]){
  const invalid=structuredClone(next);invalid.items[0].material={...material(),...change} as Dto<'MaterialResponse'>;assert.equal(journal.save(invalid,e).status,'invalid');
 }
});
test('QA envelope CAS preserves another page and requires the exact current envelope for cleanup',()=>{
 const e=envelope(),store=new Store(),journal=new QaUploadJournal('owner','project',store);assert.equal(journal.save(e,null).status,'valid');
 const next=structuredClone(e);next.items[0].material=material();assert.equal(journal.save(next,e).status,'valid');assert.equal(journal.save(e,e).status,'conflict');assert.equal(journal.remove(e).status,'conflict');assert.equal(journal.save(e,null).status,'conflict');assert.equal(journal.remove(next).status,'valid');
});
test('QA envelope storage quota and write-readback failures cannot authorize uploads',()=>{
 for(const fault of ['quota','readback'] as const){const store=new Store();store.setItem=()=>{if(fault==='quota')throw Error('quota');};const journal=new QaUploadJournal('owner','project',store);assert.equal(journal.save(envelope(),null).status,'unavailable');assert.deepEqual(journal.readAll(),{status:'valid',value:[]});}
});
test('QA upload progress cannot skip an ordered original item or claim prepare handoff before a saved source',()=>{
 const e=qaUploadEnvelope('owner','project','supplement',base(),[declaration(),declaration('第二份.doc')]),store=new Store(),journal=new QaUploadJournal('owner','project',store);assert.equal(journal.save(e,null).status,'valid');
 const invalid=structuredClone(e);invalid.items[1].material=material();invalid.items[1].applied=true;assert.equal(journal.save(invalid,e).status,'invalid');
 const source=qaUploadEnvelope('owner','project','source',base(),[declaration()]);source.handedOff=true;assert.equal(journal.save(source,null).status,'invalid');
});

test('QA saved-file identity tolerates later parsing metadata but rejects replaced bytes or versions',()=>{
 const original={...material(),parse_snapshot_id:null};
 assert.equal(qaUploadMaterialMatches(original,{...original,parse_snapshot_id:'parsed-later',state:'parsed'}),true);
 for(const changed of [{material_id:'other'},{material_version:4},{upload_id:'other'},{sha256:'b'.repeat(64)},{byte_size:89},{media_type:'application/pdf'},{role:'historical'}])
  assert.equal(qaUploadMaterialMatches(original,{...original,...changed} as Dto<'MaterialResponse'>),false);
});
