import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { azureBlobs, digest, type PrivateBlobs } from '@bondbuddy/api/data';
import { authorizeOcrMaterial, storeOcr, validateOcrResponse, type OcrContext } from '@bondbuddy/api/ocr';
import type { OcrEngineResponse } from '@bondbuddy/contracts';

export type OcrInput = OcrContext & { maxPages?:number; language?:'chi_sim+eng'|'eng' };
export type OcrRunnerOptions = { pythonExecutable?:string; repoRoot?:string; timeoutMs?:number };

export async function extractOcr(pool:Pool, blobs:PrivateBlobs, input:OcrInput, options:OcrRunnerOptions={}):Promise<OcrEngineResponse> {
  const maxPages=input.maxPages ?? (input.purpose==='source_preflight'?3:50);
  if(!Number.isInteger(maxPages) || maxPages<1 || maxPages>(input.purpose==='source_preflight'?5:50))throw new Error('INVALID_OCR_BUDGET');
  if(input.language && !['chi_sim+eng','eng'].includes(input.language))throw new Error('INVALID_OCR_LANGUAGE');
  const source=await authorizeOcrMaterial(pool,input);
  if(!['application/pdf','image/png','image/jpeg'].includes(source.media_type))throw new Error('OCR_UNSUPPORTED_FORMAT');
  const size=Number(source.byte_size);
  if(!Number.isSafeInteger(size)||size<1||size>100*1024*1024)throw new Error('OCR_INPUT_LIMIT');
  const bytes=await blobs.getIfExistsBounded(source.object_key,size);
  if(!bytes || bytes.length!==size || digest(bytes)!==source.sha256.trim())throw new Error('OCR_SOURCE_INTEGRITY_FAILED');
  const directory=await mkdtemp(join(tmpdir(),'bb-ocr-source-'));
  try {
    const path=join(directory,'source');await writeFile(path,bytes,{flag:'wx',mode:0o600});
    const request={schema_version:'ocr-request-v1',request_id:input.requestId,
      material:{material_id:input.materialId,material_version:input.version,sha256:source.sha256.trim(),media_type:source.media_type,authorized_local_path:path},
      options:{purpose:input.purpose,max_pages:maxPages,language:input.language??'chi_sim+eng',execution_authorized:input.purpose==='full_ocr' && !!input.runId}};
    const timeoutMs=options.timeoutMs??Math.min(10*60_000, maxPages*60_000);
    if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>30*60_000)throw new Error('INVALID_OCR_TIMEOUT');
    const root=options.repoRoot??process.cwd();
    const output=await new Promise<string>((resolveOutput,reject)=>{
      const detached=process.platform!=='win32';
      const child=spawn(options.pythonExecutable??process.env.BB_PYTHON??'python3',['-m','bondbuddy_ocr'],{
        cwd:root,env:{...process.env,PYTHONPATH:resolve(root,'python')},stdio:['pipe','pipe','pipe'],detached});
      const chunks:Buffer[]=[];let length=0,settled=false,stderrBytes=0;
      const stop=(code:string)=>{if(settled)return;settled=true;clearTimeout(timer);
        try { if(detached && child.pid)process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL'); } catch {}
        reject(new Error(code));};
      const timer=setTimeout(()=>stop('OCR_PROCESS_TIMEOUT'),timeoutMs);
      child.stdout.on('data',(chunk:Buffer)=>{length+=chunk.length;if(length>64*1024*1024)return stop('OCR_OUTPUT_LIMIT');chunks.push(chunk);});
      child.stderr.on('data',(chunk:Buffer)=>{stderrBytes+=chunk.length;if(stderrBytes>65536)stop('OCR_PROCESS_FAILED');});
      child.on('error',()=>stop('OCR_PROCESS_UNAVAILABLE'));child.stdin.on('error',()=>stop('OCR_PROCESS_FAILED'));
      child.on('close',code=>{if(settled)return;settled=true;clearTimeout(timer);if(code!==0)return reject(new Error('OCR_PROCESS_FAILED'));resolveOutput(Buffer.concat(chunks).toString('utf8'));});
      child.stdin.end(JSON.stringify(request));
    });
    if(output.includes(path)||output.includes(source.object_key))throw new Error('OCR_PRIVATE_PATH_IN_RESULT');
    let result:unknown;try{result=JSON.parse(output);}catch{throw new Error('OCR_INVALID_RESPONSE');}
    return validateOcrResponse(result,{materialId:input.materialId,version:input.version,requestId:input.requestId,purpose:input.purpose,sha256:source.sha256.trim(),mediaType:source.media_type});
  } finally {await rm(directory,{recursive:true,force:true});}
}

/** Called by a trusted parse/preflight worker, never by the public HTTP request handler. */
export async function processOcrMaterial(pool:Pool, blobs:PrivateBlobs,input:OcrInput,options:OcrRunnerOptions={}) {
  const result=await extractOcr(pool,blobs,input,options);
  if(result.status==='failed')throw new Error(result.error??'OCR_FAILED');
  const snapshotId=await storeOcr(pool,blobs,input,result);
  return {snapshot_id:snapshotId,coverage:result.coverage,pages:result.pages.length,records:result.records.length,eligible_for_manuscript:false as const};
}

// Operational one-shot worker for bounded source preflight. It cannot start full OCR or a model task.
if(process.argv[1] && import.meta.url===new URL(`file://${process.argv[1]}`).href){
  const [owner,projectId,materialId,version,requestId]=process.argv.slice(2);
  if(!owner||!projectId||!materialId||!version||!requestId||!process.env.DATABASE_URL||!process.env.AZURE_STORAGE_CONNECTION_STRING)throw new Error('OCR_WORKER_CONFIGURATION_REQUIRED');
  const pool=new Pool({connectionString:process.env.DATABASE_URL});
  try {const result=await processOcrMaterial(pool,azureBlobs(process.env.AZURE_STORAGE_CONNECTION_STRING),{owner,projectId,materialId,version:Number(version),requestId,purpose:'source_preflight'});process.stdout.write(JSON.stringify(result)+'\n');}
  catch {process.stderr.write('OCR_PREFLIGHT_FAILED\n');process.exitCode=1;}finally{await pool.end();}
}
