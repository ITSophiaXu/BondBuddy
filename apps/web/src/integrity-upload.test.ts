import assert from 'node:assert/strict';
import {test} from 'node:test';
import {IntegrityRecoveryCache,type IntegrityRecoveryStorage,type IntegrityEvidenceDraft,type IntegrityRecoveryValue} from './integrity-recovery.js';
import {UploadRecovery,UploadRecoveryConflictError,type UploadRecoveryLock,type UploadRecoveryRecord} from './upload-recovery.js';
import {beginIntegrityUpload,integrityUploadPair,integrityUploadPurpose,integrityUploadRecord,sameIntegrityUploadPair} from './integrity-upload.js';

class Store implements IntegrityRecoveryStorage{
 values=new Map<string,string>();get length(){return this.values.size;}key(index:number){return [...this.values.keys()][index]??null;}
 getItem(key:string){return this.values.get(key)??null;}setItem(key:string,value:string){this.values.set(key,value);}removeItem(key:string){this.values.delete(key);}
}
const form=():IntegrityEvidenceDraft=>({roundId:'original-check',subjectId:'original-subject',siteId:'credit-china',url:'https://www.creditchina.gov.cn/',time:'2026-10-24T10:20',note:'原事项的实际查询记录。',conclusion:'unresolved'});
const value=(evidenceDraft=form()):IntegrityRecoveryValue=>({revision:4,draft:{subjects:[],site_ids:[],notes:''},evidenceDraft});
function fixture(){
 const store=new Store(),calls:string[]=[],lock:UploadRecoveryLock={run:async(_name,action)=>action()};let sequence=0;
 const api={createUpload:async()=>{calls.push('create');throw Error('Unexpected network');},completeUpload:async()=>{calls.push('complete');throw Error('Unexpected network');},uploadBytes:async()=>{calls.push('PUT');throw Error('Unexpected network');},material:async()=>{calls.push('material');throw Error('Unexpected network');},project:async()=>{calls.push('project');throw Error('Unexpected network');}};
 const recovery=new UploadRecovery(api,'owner','project',integrityUploadPurpose,()=>true,{store,lock,id:()=>`operation-${++sequence}`});
 return {store,calls,recovery};
}
const file=(name='证据.pdf')=>new File(['synthetic bytes'],name,{type:'application/octet-stream'});

test('integrity transport preparation keeps only a bounded original pair and performs no HTTP or evidence write',async()=>{
 const h=fixture(),original=form();original.note='x'.repeat(200_000);
 const record=await beginIntegrityUpload(h.recovery,original,file(),new AbortController().signal,()=>true);
 assert.deepEqual(integrityUploadPair(record),{roundId:original.roundId,subjectId:original.subjectId,siteId:original.siteId});
 assert.deepEqual(Object.keys(record.context as object).sort(),['kind','roundId','siteId','subjectId']);
 assert.ok(JSON.stringify(record).length<1000);assert.equal(original.uploadOperationId,undefined);assert.equal(record.declaration.role,'other');assert.equal(record.declaration.media_type,'application/pdf');assert.deepEqual(h.calls,[]);
});

test('the original upload identity must exist and match all three evidence coordinates',async()=>{
 const h=fixture(),original=form(),record=await beginIntegrityUpload(h.recovery,original,file(),new AbortController().signal,()=>true);original.uploadOperationId=record.id;
 assert.equal(integrityUploadRecord(h.recovery,original).id,record.id);
 for(const change of [{roundId:'another-round'},{subjectId:'another-subject'},{siteId:'local-tax'},{uploadOperationId:'missing'}])assert.throws(()=>integrityUploadRecord(h.recovery,{...original,...change}),UploadRecoveryConflictError);
 const count=h.store.length;await beginIntegrityUpload(h.recovery,original,file('different.pdf'),new AbortController().signal,()=>true);assert.equal(h.store.length,count);assert.deepEqual(h.calls,[]);
 await h.recovery.forget(record.id);assert.throws(()=>integrityUploadRecord(h.recovery,original),UploadRecoveryConflictError);assert.equal(h.store.length,0);
});

test('foreign purposes, other roles, unknown sites and extra business payloads cannot be used as evidence transport context',async()=>{
 const h=fixture(),record=await beginIntegrityUpload(h.recovery,form(),file(),new AbortController().signal,()=>true);
 for(const change of [{purpose:'project-file-import'},{declaration:{...record.declaration,role:'historical'}},{context:{...record.context as object,siteId:'unknown-site'}},{context:{...record.context as object,material:{id:'hidden'}}},{context:{kind:'integrity-evidence',roundId:'',subjectId:'s',siteId:'credit-china'}}])assert.throws(()=>integrityUploadPair({...record,...change} as UploadRecoveryRecord),UploadRecoveryConflictError);
 assert.equal(sameIntegrityUploadPair(form(),{...form(),subjectId:'other'}),false);
});

test('evidence preparation rejects unsupported types, empty files and late page changes before writing a record',async()=>{
 for(const input of [file('文件.xlsx'),new File([],'空证据.pdf')]){const h=fixture();await assert.rejects(beginIntegrityUpload(h.recovery,form(),input,new AbortController().signal,()=>true));assert.equal(h.store.length,0);assert.deepEqual(h.calls,[]);}
 const h=fixture();await assert.rejects(beginIntegrityUpload(h.recovery,form(),file(),new AbortController().signal,()=>false),error=>error instanceof DOMException&&error.name==='AbortError');assert.equal(h.store.length,0);assert.deepEqual(h.calls,[]);
});

test('the additive form upload operation survives cache CAS without changing the original pending evidence request',()=>{
 const store=new Store(),cache=new IntegrityRecoveryCache('owner','project',store),input=value({...form(),uploadOperationId:'original-operation'});
 const pin={source_project_id:'project',material_id:'old-material',material_version:2,sha256:'a'.repeat(64)};
 input.pending={kind:'evidence',roundId:'original-check',request:{request_id:'original-evidence-request',subject_id:form().subjectId,site_id:form().siteId,queried_at:'2026-10-24T02:20:00.000Z',url:form().url,note:form().note,conclusion:'unresolved',material:pin}};
 const saved=cache.save(input,null);assert.equal(saved.status,'valid');assert.deepEqual(cache.read(),{status:'valid',value:input});assert.deepEqual(input.pending.request.material,pin);
 const changed=value({...form(),uploadOperationId:'another-operation'});assert.equal(cache.save(changed,input).status,'valid');assert.equal(cache.save(input,input).status,'conflict');
 assert.equal(cache.read().status,'valid');
});

test('form operation IDs are strict, optional, bounded and never silently dropped',()=>{
 for(const uploadOperationId of ['',1,{},'x'.repeat(129),'id\n']){
  const cache=new IntegrityRecoveryCache('owner','project',new Store());assert.equal(cache.save(value({...form(),uploadOperationId} as IntegrityEvidenceDraft)).status,'invalid');
 }
 const store=new Store(),cache=new IntegrityRecoveryCache('owner','project',store),without=value();assert.equal(cache.save(without).status,'valid');assert.deepEqual(cache.read(),{status:'valid',value:without});
 assert.equal(cache.save(value({...form(),uploadOperationId:undefined})).status,'valid');const read=cache.read();assert.equal(read.status,'valid');if(read.status==='valid')assert.equal(Object.hasOwn(read.value.evidenceDraft!,'uploadOperationId'),false);
 assert.equal(cache.save(value({...form(),uploadOperationId:'safe-id',upload_url:'https://invalid.test'} as IntegrityEvidenceDraft)).status,'invalid');
});
