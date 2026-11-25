import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {withPerformanceSpan} from '@bondbuddy/api/performance-trace';
import {loadUnifiedInput} from './unified-input.js';
import {runDocumentParser} from './document-parser.js';
import type {StageContext} from './run-pipeline.js';

const repo=resolve(fileURLToPath(import.meta.url),'../../../..');
export type DirectFinancialReport={version:'direct-financial-v1';status:'passed'|'not_checked'|'mismatch';compared:number;
  issues:{code:string;scope?:string;period?:string;metric?:string;source?:string;document?:string}[];unchecked:string[]};

export async function verifyDirectFinancial(ctx:StageContext,clean:Buffer):Promise<DirectFinancialReport>{
  const input=await withPerformanceSpan('direct_financial.source.load',{},()=>loadUnifiedInput(ctx,{originalFiles:true}));
  const sourceMaterials=input.materials.filter(m=>['audit','financial','interimFinancial'].includes(m.pin.role));
  const root=await mkdtemp(join(tmpdir(),'bb-direct-financial-'));
  try{
    const materials:{material_id:string;role:string;media_type:string;records:unknown[]}[]=[];
    const sourceUnchecked:string[]=[];
    const xlsx='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    for(const material of sourceMaterials){
      if(material.mediaType!==xlsx){sourceUnchecked.push(`financial_source_format_unchecked:${material.pin.material_id}`);continue;}
      const path=join(root,`${material.pin.material_id}.xlsx`);
      try{
        if(ctx.blobs.readToFile){
          const saved=await ctx.blobs.readToFile(material.objectKey,path,100*1024*1024);
          if(!saved||saved.sha256!==material.pin.sha256)throw Error('INPUT_REVISION_CONFLICT');
        }else{
          const bytes=await ctx.blobs.getIfExistsBounded(material.objectKey,100*1024*1024);
          if(!bytes||createHash('sha256').update(bytes).digest('hex')!==material.pin.sha256)throw Error('INPUT_REVISION_CONFLICT');
          await writeFile(path,bytes);
        }
        const parsed=await withPerformanceSpan('direct_financial.source.parse',{material_id:material.pin.material_id},()=>runDocumentParser({
          schema_version:'document-parse-request-v1',request_id:ctx.run.id,
          material:{material_id:material.pin.material_id,material_version:material.pin.material_version,media_type:xlsx,
            sha256:material.pin.sha256,authorized_local_path:path},options:{}},
        {pythonExecutable:process.env.BONDBUDDY_WORD_PYTHON??process.env.BONDBUDDY_TEST_PYTHON??'python3',repoRoot:repo,timeoutMs:300000}));
        if(parsed.status==='failed'||!parsed.records.length)throw Error('DIRECT_FINANCIAL_SOURCE_PARSE_FAILED');
        materials.push({material_id:material.pin.material_id,role:material.pin.role,media_type:xlsx,records:parsed.records});
      }catch(error){
        if(ctx.signal.aborted)throw error;
        if(error instanceof Error&&error.message==='INPUT_REVISION_CONFLICT')throw error;
        sourceUnchecked.push(`financial_source_parse_unchecked:${material.pin.material_id}`);
      }
    }
    const doc=join(root,'clean.docx'),data=join(root,'input.json');
    await Promise.all([writeFile(doc,clean),writeFile(data,JSON.stringify({issuer_name:input.manifest.issuer_name,materials,source_unchecked:sourceUnchecked}))]);
    const {stdout}=await withPerformanceSpan('direct_financial.check',{material_count:materials.length},()=>promisify(execFile)(
      process.env.BONDBUDDY_WORD_PYTHON??process.env.BONDBUDDY_TEST_PYTHON??'python3',
      ['-B','-s','-m','bondbuddy_file_authoring.direct_financial','--clean',doc,'--input',data],
      {cwd:repo,env:{...process.env,PYTHONPATH:join(repo,'python'),PYTHONIOENCODING:'utf-8'},timeout:300000,maxBuffer:1024*1024,signal:ctx.signal}));
    const report=JSON.parse(stdout.trim()) as DirectFinancialReport;
    if(report.version!=='direct-financial-v1'||!['passed','not_checked','mismatch'].includes(report.status)||
      !Number.isInteger(report.compared)||report.compared<0||!Array.isArray(report.issues)||!Array.isArray(report.unchecked))
      throw Error('DIRECT_FINANCIAL_REPORT_INVALID');
    return report;
  }finally{await rm(root,{recursive:true,force:true});}
}
