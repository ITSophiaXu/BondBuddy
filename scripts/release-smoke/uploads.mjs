import {readFileSync} from 'node:fs';
import {basename,extname} from 'node:path';
import {sha256} from './support.mjs';

const mimeTypes={'.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','.pdf':'application/pdf','.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','.csv':'text/csv','.txt':'text/plain','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg'};

export function fixtureUpload(path,platform=process.platform){
 const bytes=readFileSync(path),name=basename(path),mimeType=mimeTypes[extname(path).toLowerCase()];
 if(!mimeType||bytes.length===0)throw Error('Unsupported or empty release fixture');
 // Edge's Windows path transport can create empty Files beyond MAX_PATH.
 // Keep the exact fixture bytes, filename and MIME through its buffer API.
 return {input:platform==='win32'?{name,mimeType,buffer:bytes}:path,name,size:bytes.length,hash:sha256(bytes)};
}

export function finalUploadResponse(response,file){
 try{
  if(response.request().method()!=='POST'||!/^\/api\/v1\/projects\/[^/]+\/materials\/uploads\/[^/]+\/complete$/.test(new URL(response.url()).pathname)||response.status()===202)return false;
  const declared=response.request().postDataJSON();
  return declared?.sha256===file.hash&&declared?.byte_size===file.size;
 }catch{return false;}
}

export async function uploadFixture(page,locator,path,platform=process.platform){
 const file=fixtureUpload(path,platform);
 // Use the application's existing bounded confirmation budget. A queued 202
 // is not a persisted material, even though HTTP considers it successful.
 const saved=page.waitForResponse(response=>finalUploadResponse(response,file),{timeout:600000});
 saved.catch(()=>{});
 await locator.setInputFiles(file.input);
 const receipt=await saved;
 if(receipt.status()!==200)throw Error('Upload failed: '+receipt.status()+' '+file.name);
 const material=await receipt.json();
 const uploadId=decodeURIComponent(new URL(receipt.url()).pathname.split('/').at(-2));
 // These are end-to-end file identity assertions. The application separately
 // validates the shared MaterialResponse contract before accepting this data.
 if(!material||typeof material.material_id!=='string'||!material.material_id||!Number.isSafeInteger(material.material_version)||material.material_version<1||typeof material.persisted_at!=='string'||!Number.isFinite(Date.parse(material.persisted_at))||material.upload_id!==uploadId||material.sha256!==file.hash||material.byte_size!==file.size||material.filename!==file.name)throw Error('Upload receipt does not match the saved file: '+file.name);
 return material;
}

export function uploadConfirmationEnvironment(){
 return {BB_UPLOAD_CONFIRMATION_ENABLED:'1',BB_UPLOAD_SPOOL_DIR:'/var/lib/bondbuddy/parse-staging/upload-confirmation',BB_UPLOAD_SPOOL_MAX_BYTES:'134217728'};
}
