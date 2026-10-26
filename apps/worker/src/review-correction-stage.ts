import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp,readFile,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve,join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest } from '@bondbuddy/api/data';
import { writeRunWorkingFile } from '@bondbuddy/api/run-working-files';
import { reviewEditor, resolveReviewEditorExecution, reviewEditorExecution, registerReviewEditorSnapshot } from '@bondbuddy/api/review-editor';
import { Value } from '@sinclair/typebox/value';
import { ReviewExportRequestSchema,type ReviewExportPin } from '@bondbuddy/contracts';
import type { StageContext, StageOutcome } from './run-pipeline.js';
import type { ReviewFileInput,ReviewFileResult } from './review-file-stage.js';

const root=resolve(fileURLToPath(import.meta.url),'../../../..'),runFile=promisify(execFile),MAX=100*1024*1024;
export function validCorrectionExportPin(saved:unknown):saved is ReviewExportPin{
  if(!saved||typeof saved!=='object'||Array.isArray(saved))return false;
  const pin=saved as Record<string,unknown>;
  return Object.keys(pin).every(key=>['source_run_id','source_execution','editor_sha256','decisions'].includes(key))
    &&Value.Check(ReviewExportRequestSchema,{request_id:'saved-correction-export',source_run_id:pin.source_run_id,
      ...(Object.hasOwn(pin,'source_execution')?{source_execution:pin.source_execution}:{}),
      expected_editor_sha256:pin.editor_sha256,decisions:pin.decisions});
}
/** Same queue and input gate, deterministic file conversion only. Never invokes an adapter. */
export async function correctionFiles(ctx:StageContext,input:ReviewFileInput,markdown?:Buffer,providerAttemptId?:string,
  writer:typeof writeRunWorkingFile=writeRunWorkingFile,
  registerEditor:typeof registerReviewEditorSnapshot=registerReviewEditorSnapshot):Promise<ReviewFileResult>{
  const pin=input.manifest.review.input.source_material_ref!,source=input.materials.find(m=>m.pin.material_id===pin.material_id&&m.pin.material_version===pin.material_version&&m.pin.sha256===pin.sha256);
  if(!source)throw Error('INPUT_REVISION_CONFLICT');
  const original=await ctx.blobs.getIfExistsBounded(source.object_key,MAX);
  if(!original||digest(original)!==pin.sha256)throw Error('INPUT_REVISION_CONFLICT');
  const saved=input.manifest.review.file_delivery!.export;
  if(Object.hasOwn(input.manifest.review.file_delivery!,'export')&&!validCorrectionExportPin(saved))throw Error('INPUT_REVISION_CONFLICT');
  const sourceExecution=saved?await resolveReviewEditorExecution(ctx.pool,ctx.run.owner_user_id,ctx.run.project_id,
    saved.source_run_id,saved.source_execution?.execution_version??1):undefined;
  if(saved?.source_execution&&!Value.Equal(saved.source_execution,reviewEditorExecution(sourceExecution!)))throw Error('INPUT_REVISION_CONFLICT');
  const editor=saved?await reviewEditor(ctx.pool,ctx.run.owner_user_id,ctx.run.project_id,saved.source_run_id,sourceExecution!):undefined;
  if(saved&&editor?.sha256!==saved.editor_sha256)throw Error('INPUT_REVISION_CONFLICT');
  const directory=await mkdtemp(join(tmpdir(),'bb-review-export-'));
  try{
    const suffix=source.media_type==='application/pdf'?'.pdf':'.docx',path=join(directory,'source'+suffix);
    await writeFile(path,original,{mode:0o600});
    await writeFile(join(directory,'request.json'),JSON.stringify({pin,filename:source.filename,...(editor?{editor:editor.snapshot,decisions:saved!.decisions}:{markdown:markdown?.toString('utf8')??''})}),{mode:0o600});
    const options={cwd:root,env:{...process.env,PYTHONPATH:join(root,'python')},timeout:300000,signal:ctx.signal,maxBuffer:1024*1024};
    const python=process.env.BONDBUDDY_WORD_PYTHON??process.env.BONDBUDDY_TEST_PYTHON??'python3';
    await runFile(python,['-m','bondbuddy_file_authoring.review_corrections',path,join(directory,'request.json'),directory],options);
    const snapshot=JSON.parse(await readFile(join(directory,'editor.json'),'utf8'));
    if(snapshot.version!=='review-editor-v1'||snapshot.source_sha256!==pin.sha256)throw Error('INPUT_REVISION_CONFLICT');
    const report=markdown??Buffer.from(`# 复核成果处理清单\n\n${snapshot.issues.map((i:any)=>`### ${i.id} ${i.title}\n${i.reason}\n\n依据：${i.evidence}\n\n处理：${i.applied?'已修改':i.decision==='original'?'保留原文':'待人工确认'}\n${i.missing}\n${i.limitation}`).join('\n\n')}`);
    await writeFile(join(directory,'report.md'),report);
    await runFile(python,[join(root,'python/bondbuddy_file_authoring/report_from_text.py'),join(directory,'report.md'),join(directory,'report.docx')],options);
    const result:ReviewFileResult={version:'codex-review-file-v1',input_hash:ctx.run.input_hash.trim(),files:{}};
    for(const name of ['revision.docx','clean.docx','baseline.docx','report.docx','report.md','editor.json']){
      const bytes=await readFile(join(directory,name));if(bytes.length>MAX)throw Error('REVIEW_OUTPUT_UNSAFE');
      const sha256=digest(bytes),key=`owners/${ctx.run.owner_user_id}/projects/${ctx.run.project_id}/runs/${ctx.run.id}/review-files/correction/${sha256}/${name}`;
      await writer({pool:ctx.pool,blobs:ctx.blobs,lease:ctx.lease,projectId:ctx.run.project_id,
        source:providerAttemptId===undefined?{kind:'local_correction'}:{kind:'provider',attemptId:providerAttemptId,resultSchemaVersion:'codex-review-file-v1'},
        name,key,bytes,mediaType:name.endsWith('.docx')?'application/vnd.openxmlformats-officedocument.wordprocessingml.document':name.endsWith('.json')?'application/json':'text/markdown'});
      const check=await ctx.blobs.getIfExistsBounded(key,MAX);if(!check||digest(check)!==sha256)throw Error('REVIEW_OUTPUT_STORE_FAILED');
      result.files[name]={key,sha256,byte_size:bytes.length};
    }
    await registerEditor(ctx.pool,ctx.lease,ctx.run.project_id,snapshot);
    return result;
  }finally{await rm(directory,{recursive:true,force:true});}
}

export async function correctionExport(ctx:StageContext,input:ReviewFileInput,writer:typeof writeRunWorkingFile=writeRunWorkingFile,
  registerEditor:typeof registerReviewEditorSnapshot=registerReviewEditorSnapshot):Promise<StageOutcome>{
  const saved=ctx.checkpoint.model_generation?.correction_result as ReviewFileResult|undefined;
  const result=saved??await correctionFiles(ctx,input,undefined,undefined,writer,registerEditor);
  return {kind:'done',checkpoint:{correction_result:result},value:result};
}
