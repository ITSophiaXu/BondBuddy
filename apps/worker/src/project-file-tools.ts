import type {WorkpaperTableLayout} from './workpaper-content.js';
import {withPerformanceSpan} from '@bondbuddy/api/performance-trace';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
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
const run=promisify(execFile);
export async function projectFilePython(ctx:StageContext,args:string[]){
  const operation=['inspect','inspect-complete','table-layout','normalize-workpaper-layout','patch'].includes(args[0]??'')?args[0]!:'other';
  return withPerformanceSpan((operation.startsWith('inspect')||operation==='table-layout')?'document.inspect':'document.transform',{operation},()=>run(process.env.BONDBUDDY_WORD_PYTHON??process.env.BONDBUDDY_TEST_PYTHON??'python3',['-B','-m','bondbuddy_file_authoring.project_files',...args],
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
/** Host-only layout metadata; never sourced from model JSON or stored in the
 * immutable source-spans snapshot, so old workspace hashes remain compatible. */
export async function inspectWorkpaperTableLayout(ctx:StageContext,path:string,source:ProjectFileText):Promise<WorkpaperTableLayout>{
  const dir=await mkdtemp(join(tmpdir(),'bb-table-layout-'));
  try{
    const output=join(dir,'layout.json');await projectFilePython(ctx,['table-layout',path,output]);
    const bytes=await readFile(output);if(bytes.length>4*1024*1024)throw Error('FILE_TEXT_TOO_LARGE');
    const value=JSON.parse(bytes.toString('utf8')),ids=value.full_width_span_ids;
    const allowed=new Set(source.spans.filter(s=>s.location.includes(' / 行 ')).map(s=>s.id));
    if(value.version!=='workpaper-table-layout-v1'||value.sha256!==source.sha256||!Array.isArray(ids)
      ||ids.length>source.spans.length||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!allowed.has(id)))
      throw Error('INPUT_REVISION_CONFLICT');
    return {source_sha256:source.sha256,full_width_span_ids:ids};
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

export type WorkpaperLayoutReceipt={version:'workpaper-pagination-v1';input_sha256:string;output_sha256:string;changed_paragraphs:number;changed_header_rows:number;content_unchanged:true;
 original:{key:string;sha256:string;byte_size:number}};
/** Reflow only host-recognized table headings. Persist the original bytes before
 * changing the output, then run all original link/coverage gates on the new SHA. */
export async function normalizeWorkpaperLayout(ctx:StageContext,cwd:string):Promise<WorkpaperLayoutReceipt|undefined>{
 const {checkedM4File,M4_FILE_MAX}=await import('./m4-file-workspace.js');
 const original=await checkedM4File(join(cwd,'output'),'document.docx');
 const dir=await mkdtemp(join(tmpdir(),'bb-workpaper-layout-'));
 try{
  const input=join(dir,'input.docx'),output=join(dir,'output.docx'),report=join(dir,'receipt.json');
  await writeFile(input,original,{mode:0o400});await projectFilePython(ctx,['normalize-workpaper-layout',input,output,report]);
  const candidate=await checkedM4File(dir,'output.docx'),bytes=await checkedM4File(dir,'receipt.json',4*1024*1024),r=JSON.parse(bytes.toString('utf8'));
  if(r.version!=='workpaper-pagination-v1'||r.content_unchanged!==true||r.input_sha256!==digest(original)||r.output_sha256!==digest(candidate)
   ||!Number.isSafeInteger(r.changed_paragraphs)||r.changed_paragraphs<0||!Array.isArray(r.changes)||r.changes.length!==r.changed_paragraphs||!Number.isSafeInteger(r.changed_header_rows)||r.changed_header_rows<0||!Array.isArray(r.row_height_changes)||r.row_height_changes.length!==r.changed_header_rows)throw Error('WORKPAPER_LAYOUT_INVALID');
  if(!r.changed_paragraphs&&!r.changed_header_rows){if(!original.equals(candidate))throw Error('WORKPAPER_LAYOUT_INVALID');return;}
  const key=`owners/${ctx.run.owner_user_id}/projects/${ctx.run.project_id}/runs/${ctx.run.id}/m4-layout-preimages/${r.input_sha256}/document.docx`;
  await ctx.blobs.put(key,original,'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  const stored=await ctx.blobs.getIfExistsBounded(key,M4_FILE_MAX);if(!stored||stored.length!==original.length||digest(stored)!==r.input_sha256)throw Error('M4_OUTPUT_STORE_FAILED');
  await writeFile(join(cwd,'output/document.docx'),candidate,{mode:0o600});
  return {version:r.version,input_sha256:r.input_sha256,output_sha256:r.output_sha256,changed_paragraphs:r.changed_paragraphs,changed_header_rows:r.changed_header_rows,content_unchanged:true,original:{key,sha256:r.input_sha256,byte_size:original.length}};
 }finally{await rm(dir,{recursive:true,force:true});}
}
