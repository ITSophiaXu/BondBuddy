import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,basename} from 'node:path';
import {fixtureUpload,finalUploadResponse,uploadFixture} from './uploads.mjs';

function response(file,status=200,patch={}){
 const body={material_id:'material-1',material_version:1,upload_id:'upload-1',role:'historical',filename:file.name,media_type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',byte_size:file.size,sha256:file.hash,state:'persisted',persisted_at:'2026-11-12T00:00:00.000Z',error:null,...patch};
 return {status:()=>status,url:()=> 'http://localhost:5288/api/v1/projects/project-1/materials/uploads/upload-1/complete',request:()=>({method:()=> 'POST',postDataJSON:()=>({sha256:file.hash,byte_size:file.size})}),json:async()=>body};
}

test('Windows original bytes survive Chinese paths longer than MAX_PATH',()=>{
 const root=mkdtempSync(join(tmpdir(),'release-upload-'));
 try{
  const dir=join(root,...Array.from({length:6},(_,i)=>'中文募集说明书材料目录-'+i+'-'.repeat(28)));
  mkdirSync(dir,{recursive:true});const path=join(dir,'财务材料.docx'),bytes=Buffer.from('synthetic original fixture bytes');writeFileSync(path,bytes);
  assert.ok(path.length>260);const file=fixtureUpload(path,'win32');
  assert.deepEqual(file.input.buffer,bytes);assert.equal(file.input.name,basename(path));assert.equal(file.input.mimeType,'application/vnd.openxmlformats-officedocument.wordprocessingml.document');assert.equal(fixtureUpload(path,'linux').input,path);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('queued and unrelated responses cannot finish an upload; final HTTP failures are surfaced',()=>{
 const file={name:'fixture.docx',size:10,hash:'a'.repeat(64)};
 assert.equal(finalUploadResponse(response(file,202),file),false);
 assert.equal(finalUploadResponse(response({...file,hash:'b'.repeat(64)}),file),false);
 assert.equal(finalUploadResponse(response({...file,size:11}),file),false);
 assert.equal(finalUploadResponse(response(file,422),file),true);
 assert.equal(finalUploadResponse(response(file),file),true);
});

test('the browser flow waits for the final material and rejects altered server receipts',async()=>{
 const root=mkdtempSync(join(tmpdir(),'release-receipt-')),path=join(root,'fixture.docx');writeFileSync(path,'synthetic bytes');
 try{
  const file=fixtureUpload(path,'win32');
  for(const [status,patch,error] of [[200,{},null],[422,{},/Upload failed/],[200,{sha256:'b'.repeat(64)},/receipt/],[200,{byte_size:file.size+1},/receipt/],[200,{filename:'other.docx'},/receipt/],[200,{upload_id:'other-upload'},/receipt/],[200,{material_version:0},/receipt/]]){
   let resolve;const final=new Promise(r=>resolve=r);let installed=false;
   const page={waitForResponse(predicate,options){installed=true;assert.equal(options.timeout,600000);assert.equal(predicate(response(file,202)),false);assert.equal(predicate(response(file,status,patch)),true);return final;}};
   const locator={async setInputFiles(input){assert.ok(installed);assert.deepEqual(input.buffer,file.input.buffer);resolve(response(file,status,patch));}};
   if(error)await assert.rejects(uploadFixture(page,locator,path,'win32'),error);
   else assert.equal((await uploadFixture(page,locator,path,'win32')).material_id,'material-1');
  }
 }finally{rmSync(root,{recursive:true,force:true});}
});
