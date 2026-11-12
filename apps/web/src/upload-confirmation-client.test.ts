import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ApiClient,ApiError} from './api.js';
const declaration={byte_size:73,sha256:'a'.repeat(64)};
const material={material_id:'canonical',material_version:1,upload_id:'canonical-upload',role:'historical',filename:'synthetic.docx',media_type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',...declaration,state:'persisted',persisted_at:'2026-11-09T00:00:00Z',error:null};
const response=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Retry-After':'0.05'}});
function fixture(responses:(Response|Error)[]){
 const before=globalThis.fetch,doc=Object.getOwnPropertyDescriptor(globalThis,'document');const calls:{path:string;input:any}[]=[];
 Object.defineProperty(globalThis,'document',{configurable:true,value:{cookie:''}});
 globalThis.fetch=async(path,input)=>{calls.push({path:String(path),input});const value=responses.shift();if(value instanceof Error)throw value;if(!value)throw new Error('Unexpected request');return value;};
 return {api:new ApiClient(()=>{}),calls,restore:()=>{globalThis.fetch=before;if(doc)Object.defineProperty(globalThis,'document',doc);else delete (globalThis as any).document;}};
}
test('202 is pending until the exact final MaterialResponse; repeated requests keep upload and declaration',async()=>{
 const f=fixture([response({status:'confirming',upload_id:'original'},202),response({status:'confirming',upload_id:'original'},202),response(material)]);
 try{let saved=false;const work=f.api.completeUpload('project','original',declaration).then(m=>{saved=true;return m;});await new Promise(r=>setTimeout(r,10));assert.equal(saved,false);assert.deepEqual(await work,material);assert.equal(f.calls.length,3);for(const c of f.calls){assert.equal(c.path,'/api/v1/projects/project/materials/uploads/original/complete');assert.equal(c.input.headers.Prefer,'respond-async');assert.deepEqual(JSON.parse(c.input.body),declaration);}}
 finally{f.restore();}
});
test('wrong upload pending DTO, malformed DTO and final hash/size mismatch never mark saved',async()=>{
 for(const bad of [response({status:'confirming',upload_id:'foreign'},202),response({status:'confirming',upload_id:'original',material_id:'invented'},202),response({...material,sha256:'b'.repeat(64)}),response({...material,byte_size:72}),response({material_id:'partial'})]){
  const f=fixture([bad]);try{await assert.rejects(f.api.completeUpload('project','original',declaration),ApiError);}finally{f.restore();}
 }
});
test('temporary connection failure recovers with the same upload and preserved declaration',async()=>{
 const f=fixture([new TypeError('Synthetic disconnect'),response({status:'confirming',upload_id:'original'},202),response(material)]);
 try{assert.deepEqual(await f.api.completeUpload('project','original',declaration),material);assert.equal(new Set(f.calls.map(c=>c.path)).size,1);}finally{f.restore();}
});
test('aborting a pending wait stops requests; a reopened client resumes original upload',async()=>{
 const f=fixture([response({status:'confirming',upload_id:'original'},202),response(material)]);const controller=new AbortController();
 try{const work=f.api.completeUpload('project','original',declaration,controller.signal);await new Promise(r=>setTimeout(r,10));controller.abort();await assert.rejects(work);assert.equal(f.calls.length,1);const reopened=new ApiClient(()=>{});assert.deepEqual(await reopened.completeUpload('project','original',declaration),material);}finally{f.restore();}
});
test('terminal server inspection error preserves its original public reason without additional requests',async()=>{
 const f=fixture([response({code:'MATERIAL_UNREADABLE',field_errors:[{field:'material_upload',code:'document_structure_invalid'}],correlation_id:'original-error'},422)]);
 try{await assert.rejects(f.api.completeUpload('project','original',declaration),(e:any)=>e instanceof ApiError&&e.code==='MATERIAL_UNREADABLE'&&e.details.correlationId==='original-error');assert.equal(f.calls.length,1);}finally{f.restore();}
});
