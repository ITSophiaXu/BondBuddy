import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {digest} from '@bondbuddy/api/data';
import {checkpointStage} from '@bondbuddy/api/queue';
import {inputManifestHash} from '@bondbuddy/api/production-rule-pin';
import {documentParserVersion} from '@bondbuddy/api/material-jobs';
import type {WorkflowObject} from '@bondbuddy/contracts';
import {loadUnifiedInput,type UnifiedInput} from './unified-input.js';
import {editingSource} from './file-authoring-stage.js';
import {taskExecFile} from './task-execution.js';
import type {StageContext} from './run-pipeline.js';
import type {ChapterSource,WorkflowNode} from './workflow-authoring.js';
import type {MaterialToolData} from './authoring-material-tools.js';

const repo=resolve(fileURLToPath(import.meta.url),'../../../..');
export type ChapterContextV1={version:'chapter-context-v1';input_hash:string;parser_version:string;input:UnifiedInput;source:WorkflowObject|null;chapters:ChapterSource[];nodes:WorkflowNode[];material_snapshot_hash:string};
export const workflowPrefix=(ctx:StageContext)=>`users/${ctx.run.owner_user_id}/projects/${ctx.run.project_id}/runs/${ctx.run.id}/workflow-v1/`;
export async function writeWorkflowObject(ctx:StageContext,name:string,bytes:Buffer):Promise<WorkflowObject>{
  const sha256=digest(bytes),key=workflowPrefix(ctx)+sha256+'/'+name;
  await ctx.blobs.put(key,bytes,name.endsWith('.docx')?'application/vnd.openxmlformats-officedocument.wordprocessingml.document':'application/json');
  const stored=await ctx.blobs.getIfExistsBounded(key,100*1024*1024);
  if(!stored||stored.length!==bytes.length||digest(stored)!==sha256)throw Error('WORKFLOW_OBJECT_READBACK_FAILED');
  return {key,sha256,byte_size:bytes.length};
}
export async function readWorkflowObject(ctx:StageContext,ref:WorkflowObject){
  if(!ref.key.startsWith(workflowPrefix(ctx))||ref.key.includes('..')||!Number.isSafeInteger(ref.byte_size)||ref.byte_size<1||ref.byte_size>100*1024*1024)throw Error('WORKFLOW_OBJECT_SCOPE_INVALID');
  const bytes=await ctx.blobs.getIfExistsBounded(ref.key,ref.byte_size);
  if(!bytes||bytes.length!==ref.byte_size||digest(bytes)!==ref.sha256)throw Error('WORKFLOW_OBJECT_READBACK_FAILED');return bytes;
}
export function contextRecords(input:UnifiedInput){return input.materials.flatMap((m,mi)=>m.records.map((r,ri)=>({id:`m${mi}:${ri}`,text:r.literal_quote,uncertainty:r.uncertainty,locator:r.locator,material_sha256:m.pin.sha256,record_sha256:inputManifestHash(r)})));}
export function contextEvidence(input:UnifiedInput){return new Set(contextRecords(input).map(r=>r.id).concat(input.manifest.authoring.knowledge.map(k=>k.path)));}
export function workflowMaterialTools(input:UnifiedInput):MaterialToolData{
  return {materials:[...input.materials.map((m,mi)=>({id:`m${mi}`,filename:m.filename,context:{...m.pin,pending:m.pending??[]},records:m.records.map((r,ri)=>({id:`m${mi}:${ri}`,text:r.literal_quote,uncertainty:r.uncertainty,locator:r.locator}))})),
    ...input.manifest.authoring.knowledge.map((k,ki)=>({id:`k${ki}`,filename:k.path,context:{knowledge_path:k.path,content_sha256:digest(k.markdown),reference_id:k.path},records:Array.from({length:Math.ceil(k.markdown.length/12000)},(_,i)=>({id:`knowledge:${ki}:${i}`,text:k.markdown.slice(i*12000,(i+1)*12000),uncertainty:[],locator:{char_start:i*12000,char_end:Math.min(k.markdown.length,(i+1)*12000)}}))}))]};
}
export function knowledgeIndex(input:UnifiedInput){return input.manifest.authoring.knowledge.map(k=>({path:k.path,content_sha256:digest(k.markdown),char_count:k.markdown.length}));}
export async function loadChapterContext(ctx:StageContext):Promise<ChapterContextV1>{
  const saved=ctx.checkpoint.chapter_context_v1?.ref as WorkflowObject|undefined;
  if(saved){
    const value=JSON.parse((await readWorkflowObject(ctx,saved)).toString('utf8')) as ChapterContextV1;
    if(value.version!=='chapter-context-v1'||value.input_hash!==ctx.run.input_hash.trim()||value.material_snapshot_hash!==inputManifestHash({input:value.input,parser_version:value.parser_version}))throw Error('INPUT_REVISION_CONFLICT');
    return value;
  }
  const input=await loadUnifiedInput(ctx,{partialCoverage:true});const source=editingSource(input);
  let sourceRef:WorkflowObject|null=null,nodes:WorkflowNode[]=[],chapters:ChapterSource[]=[];
  if(source){
    const bytes=await ctx.blobs.getIfExistsBounded(source.objectKey,100*1024*1024);if(!bytes||digest(bytes)!==source.pin.sha256)throw Error('INPUT_REVISION_CONFLICT');
    sourceRef=await writeWorkflowObject(ctx,source.mediaType==='application/pdf'?'source.pdf':'source.docx',bytes);
    if(source.mediaType==='application/vnd.openxmlformats-officedocument.wordprocessingml.document'){
      const dir=await mkdtemp(join(tmpdir(),'bb-chapter-inventory-'));
      try{
        await mkdir(join(dir,'input'),{mode:0o700});const path=join(dir,'input/source.docx');await writeFile(path,bytes,{mode:0o600});
        const result=await taskExecFile(process.env.BONDBUDDY_WORD_PYTHON??process.env.BONDBUDDY_TEST_PYTHON??'python3',['-B','-s','-m','bondbuddy_file_authoring.chapter_inventory',path],
          {cwd:repo,env:{...process.env,PYTHONPATH:join(repo,'python'),PYTHONIOENCODING:'utf-8'},timeout:300000,maxBuffer:32*1024*1024,signal:ctx.signal});
        const inventory=JSON.parse(result.stdout);if(inventory.version!=='word-chapter-inventory-v1'||inventory.source_sha256!==source.pin.sha256)throw Error('INPUT_REVISION_CONFLICT');
        chapters=inventory.chapters;nodes=inventory.nodes;
      }finally{await rm(dir,{recursive:true,force:true});}
    }
  }
  if(!chapters.length){
    const titles=[...new Set(input.manifest.authoring.knowledge.flatMap(k=>k.markdown.split(/\r?\n/).filter(l=>/^#{1,2}\s+/.test(l)).map(l=>l.replace(/^#+\s+/,''))))];
    if(!titles.length||titles.length>40)throw Error('WORKFLOW_STANDARD_OUTLINE_UNAVAILABLE');
    chapters=titles.map(title=>({title,source_node_ids:[]}));
  }
  const parser_version=documentParserVersion(),value:ChapterContextV1={version:'chapter-context-v1',input_hash:ctx.run.input_hash.trim(),parser_version,input,source:sourceRef,chapters,nodes,material_snapshot_hash:inputManifestHash({input,parser_version})};
  const ref=await writeWorkflowObject(ctx,'chapter-context.json',Buffer.from(JSON.stringify(value)));
  const checkpoint={ref,material_snapshot_hash:value.material_snapshot_hash,input_hash:value.input_hash};
  await checkpointStage(ctx.pool,ctx.lease,'chapter_context_v1',checkpoint);ctx.checkpoint.chapter_context_v1=checkpoint;
  return value;
}
