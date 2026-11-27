import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp,readFile,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve,join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest } from '@bondbuddy/api/data';
import { inputManifestHash } from '@bondbuddy/api/production-rule-pin';
import { reviewEditor } from '@bondbuddy/api/review-editor';
import type { StageContext, StageOutcome } from './run-pipeline.js';
import type { ReviewFileInput,ReviewFileResult } from './review-file-stage.js';
import { resolvePythonExecutable } from './python-executable.js';

const root=resolve(fileURLToPath(import.meta.url),'../../../..'),runFile=promisify(execFile),MAX=100*1024*1024;
/** Same queue and input gate, deterministic file conversion only. Never invokes an adapter. */
export async function correctionFiles(ctx:StageContext,input:ReviewFileInput,markdown?:Buffer):Promise<ReviewFileResult>{
  const pin=input.manifest.review.input.source_material_ref!,source=input.materials.find(m=>m.pin.material_id===pin.material_id&&m.pin.material_version===pin.material_version&&m.pin.sha256===pin.sha256);
  if(!source)throw Error('INPUT_REVISION_CONFLICT');
  const original=await ctx.blobs.getIfExistsBounded(source.object_key,MAX);
  if(!original||digest(original)!==pin.sha256)throw Error('INPUT_REVISION_CONFLICT');
  const saved=input.manifest.review.file_delivery!.export;
  const editor=saved?await reviewEditor(ctx.pool,ctx.run.owner_user_id,ctx.run.project_id,saved.source_run_id):undefined;
  if(saved&&editor?.sha256!==saved.editor_sha256)throw Error('INPUT_REVISION_CONFLICT');
  const directory=await mkdtemp(join(tmpdir(),'bb-review-export-'));
  try{
    const suffix=source.media_type==='application/pdf'?'.pdf':'.docx',path=join(directory,'source'+suffix);
    await writeFile(path,original,{mode:0o600});
    await writeFile(join(directory,'request.json'),JSON.stringify({pin,filename:source.filename,...(editor?{editor:editor.snapshot,decisions:saved!.decisions}:{markdown:markdown?.toString('utf8')??''})}),{mode:0o600});
    const options={cwd:root,env:{...process.env,PYTHONPATH:join(root,'python')},timeout:300000,signal:ctx.signal,maxBuffer:1024*1024};
    const python=resolvePythonExecutable();
    await runFile(python,['-m','bondbuddy_file_authoring.review_corrections',path,join(directory,'request.json'),directory],options);
    const snapshot=JSON.parse(await readFile(join(directory,'editor.json'),'utf8')),hash=inputManifestHash(snapshot);
    if(snapshot.version!=='review-editor-v1'||snapshot.source_sha256!==pin.sha256)throw Error('INPUT_REVISION_CONFLICT');
    const report=markdown??Buffer.from(`# 复核成果处理清单\n\n${snapshot.issues.map((i:any)=>`### ${i.id} ${i.title}\n${i.reason}\n\n依据：${i.evidence}\n\n处理：${i.applied?'已修改':i.decision==='original'?'保留原文':'待人工确认'}\n${i.missing}\n${i.limitation}`).join('\n\n')}`);
    await writeFile(join(directory,'report.md'),report);
    await runFile(python,[join(root,'python/bondbuddy_file_authoring/report_from_text.py'),join(directory,'report.md'),join(directory,'report.docx')],options);
    const result:ReviewFileResult={version:'codex-review-file-v1',input_hash:ctx.run.input_hash.trim(),files:{}};
    for(const name of ['revision.docx','clean.docx','baseline.docx','report.docx','report.md','editor.json']){
      const bytes=await readFile(join(directory,name));if(bytes.length>MAX)throw Error('REVIEW_OUTPUT_UNSAFE');
      const sha256=digest(bytes),key=`owners/${ctx.run.owner_user_id}/projects/${ctx.run.project_id}/runs/${ctx.run.id}/review-files/correction/${sha256}/${name}`;
      await ctx.blobs.put(key,bytes,name.endsWith('.docx')?'application/vnd.openxmlformats-officedocument.wordprocessingml.document':name.endsWith('.json')?'application/json':'text/markdown');
      const check=await ctx.blobs.getIfExistsBounded(key,MAX);if(!check||digest(check)!==sha256)throw Error('REVIEW_OUTPUT_STORE_FAILED');
      result.files[name]={key,sha256,byte_size:bytes.length};
    }
    await ctx.pool.query(`INSERT INTO bb_review_editors(owner_user_id,project_id,run_id,snapshot,sha256) VALUES($1,$2,$3,$4,$5) ON CONFLICT(run_id) DO NOTHING`,[ctx.run.owner_user_id,ctx.run.project_id,ctx.run.id,snapshot,hash]);
    const stored=(await ctx.pool.query('SELECT sha256 FROM bb_review_editors WHERE owner_user_id=$1 AND project_id=$2 AND run_id=$3',[ctx.run.owner_user_id,ctx.run.project_id,ctx.run.id])).rows[0];
    if(stored.sha256.trim()!==hash)throw Error('INPUT_REVISION_CONFLICT');
    return result;
  }finally{await rm(directory,{recursive:true,force:true});}
}

export async function correctionExport(ctx:StageContext,input:ReviewFileInput):Promise<StageOutcome>{
  const saved=ctx.checkpoint.model_generation?.correction_result as ReviewFileResult|undefined;
  const result=saved??await correctionFiles(ctx,input);
  return {kind:'done',checkpoint:{correction_result:result},value:result};
}
