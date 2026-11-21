import {withPerformanceSpan} from '@bondbuddy/api/performance-trace';
import {taskExecFile as run} from './task-execution.js';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Value} from '@sinclair/typebox/value';
import {ProjectFileTextSchema,type ProjectFileText} from '@bondbuddy/contracts';
import {digest} from '@bondbuddy/api/data';
import type {Pool,PoolClient} from 'pg';
import {inputManifestHash} from '@bondbuddy/api/production-rule-pin';
import type {StageContext} from './run-pipeline.js';
import type {M4WorkerInput} from './m4-input.js';
import {verifiedFileLinks} from './project-file-evidence.js';

export const projectFilesRoot=resolve(fileURLToPath(import.meta.url),'../../../..');
export async function projectFilePython(ctx:StageContext,args:string[]){
  const operation=['inspect','inspect-complete','patch'].includes(args[0]??'')?args[0]!:'other';
  return withPerformanceSpan(operation.startsWith('inspect')?'document.inspect':'document.transform',{operation},()=>run(process.env.BONDBUDDY_WORD_PYTHON??process.env.BONDBUDDY_TEST_PYTHON??'python3',['-B','-m','bondbuddy_file_authoring.project_files',...args],
    {cwd:projectFilesRoot,env:{...process.env,PYTHONPATH:join(projectFilesRoot,'python'),PYTHONDONTWRITEBYTECODE:'1'},signal:ctx.signal,timeout:300000,maxBuffer:1024*1024}));
}
export async function inspectProjectFile(ctx:StageContext,path:string,complete=false):Promise<ProjectFileText>{
  const dir=await mkdtemp(join(tmpdir(),'bb-file-text-'));
  try{
    const output=join(dir,'text.json');await projectFilePython(ctx,[complete?'inspect-complete':'inspect',path,output]);
    const bytes=await readFile(output);if(bytes.length>32*1024*1024)throw Error('FILE_TEXT_TOO_LARGE');
    const value=JSON.parse(bytes.toString('utf8'));
    if(!Value.Check(ProjectFileTextSchema,value))throw Error('FILE_TEXT_INVALID');
    return value;
  }finally{await rm(dir,{recursive:true,force:true});}
}
export async function prepareProjectFileSource(ctx:StageContext,input:M4WorkerInput,cwd:string){
  if(input.manifest.kind!=='document'||(!input.manifest.input.project_file&&!input.manifest.input.workpaper))return null;
  const pin=input.manifest.input.source_material!,source=input.materials.find(m=>inputManifestHash(m.pin)===inputManifestHash(pin));
  if(!source)throw Error('INPUT_REVISION_CONFLICT');
  const bytes=await ctx.blobs.getIfExistsBounded(source.objectKey,100*1024*1024);
  if(!bytes||digest(bytes)!==pin.sha256)throw Error('INPUT_REVISION_CONFLICT');
  const path=join(cwd,'scratch',source.mediaType==='application/pdf'?'association-source.pdf':'association-source.docx');
  await writeFile(path,bytes,{mode:0o400});
  const text=await inspectProjectFile(ctx,path,!!input.manifest.input.workpaper);
  await writeFile(join(cwd,'source-spans.json'),JSON.stringify(text),{mode:0o400});
  return text;
}
export async function saveGenerationLinks(ctx:StageContext,source:ProjectFileText,cwd:string,complete=false){
  const target=await inspectProjectFile(ctx,join(cwd,'output/document.docx'));
  let proposals:unknown=[];
  try{
    const info=await import('./m4-file-workspace.js');
    const bytes=await info.checkedM4File(join(cwd,'output'),'file-links.json',complete?32*1024*1024:4*1024*1024);
    proposals=JSON.parse(bytes.toString('utf8')).links;
  }catch{/* Word delivery remains available; missing associations remain explicit. */}
  const links=verifiedFileLinks(source,target,proposals,complete?100000:10000);
  const result={links,source_sha256:source.sha256,target_sha256:target.sha256,
    warnings:[...source.warnings,...target.warnings,...(!links.length?['未取得可核验的内容关联，需执行一致性检查。']:[])]};
  return result;
}
/** Publish only metadata from durable output bytes; replay never rebinds a run to regenerated content. */
export async function publishProjectFileLinks(db:Pool|PoolClient,owner:string,runId:string,result:Awaited<ReturnType<typeof saveGenerationLinks>>){
  const hash=inputManifestHash(result);
  await db.query(`INSERT INTO bb_project_file_generation_links(run_id,owner_user_id,result,result_hash) VALUES($1,$2,$3,$4) ON CONFLICT(run_id) DO NOTHING`,[runId,owner,result,hash]);
  const old=(await db.query('SELECT result_hash FROM bb_project_file_generation_links WHERE owner_user_id=$1 AND run_id=$2',[owner,runId])).rows[0];
  if(old.result_hash.trim()!==hash)throw Error('INPUT_REVISION_CONFLICT');
}
