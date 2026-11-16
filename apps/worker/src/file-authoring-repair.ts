import { isDeepStrictEqual } from 'node:util';
import { withPerformanceSpan } from '@bondbuddy/api/performance-trace';
import { withModelStagePerformance } from './model-performance.js';
import { digest } from '@bondbuddy/api/data';
import { checkpointStage, pauseAtCheckpoint } from '@bondbuddy/api/queue';
import { FORMAT_JSON_MAX } from './file-authoring-format.js';
import { parseWordQualityReport, type WordQualityReport } from './file-authoring-quality.js';
import type { FileAuthoringResult } from './file-authoring-stage.js';
import type { StageContext, StageOutcome } from './run-pipeline.js';

export const MAX_SIZE_REPAIRS = 2;
export type QualityReportRef = {key:string;sha256:string;byte_size:number};
export type SizeRepair = {round:number;previous:FileAuthoringResult;report:WordQualityReport;reportRef:QualityReportRef};
const repairable = new Set(['WORD_DOCUMENT_SIZE_REDUCED', 'WORD_SOURCE_CONTENT_REDUCED',
  'WORD_SOURCE_CHAPTER_CONTENT_LOST', 'WORD_SOURCE_TABLE_CONTENT_LOST', 'WORD_SOURCE_OUTLINE_CHANGED',
  'WORD_SOURCE_FORMAT_CHANGED']);
const codes = (report:WordQualityReport) => report.issues.map(issue=>
  typeof issue==='object' && issue!==null && 'code' in issue ? String(issue.code) : String(issue));

export async function readAuthoringFile(ctx:StageContext,ref:QualityReportRef,max=FORMAT_JSON_MAX):Promise<Buffer>{
  const prefix=`owners/${ctx.run.owner_user_id}/projects/${ctx.run.project_id}/runs/${ctx.run.id}/file-authoring/`;
  if(!ref || !ref.key?.startsWith(prefix) || ref.key.includes('..') || !/^[a-f0-9]{64}$/.test(ref.sha256)
    || !Number.isSafeInteger(ref.byte_size) || ref.byte_size<1 || ref.byte_size>max)throw Error('WORD_OUTPUT_BLOB_MISMATCH');
  const bytes=await ctx.blobs.getIfExistsBounded(ref.key,max);
  if(!bytes || bytes.length!==ref.byte_size || digest(bytes)!==ref.sha256)throw Error('WORD_OUTPUT_BLOB_MISMATCH');
  return bytes;
}

/** Durable bounded correction in the same run. Completed provider calls are replayed
 * by their stable round IDs; a rejection is never promoted to a deliverable. */
export async function deliverWithSizeRepair(ctx:StageContext,options:{
  attempt:(ctx:StageContext,round:number)=>Promise<StageOutcome>;
  repair:(ctx:StageContext,repair:SizeRepair)=>Promise<StageOutcome>;
  checkpoint?:typeof checkpointStage;
  pause?:typeof pauseAtCheckpoint;
}):Promise<StageOutcome>{
  const original=ctx.values.get('model_generation');
  try{
    for(let round=0;round<=MAX_SIZE_REPAIRS;round++){
      ctx.signal.throwIfAborted();
      const previous=ctx.values.get('model_generation') as FileAuthoringResult;
      const stage=`word_size_review_${round}`;
      const saved=ctx.checkpoint?.[stage];
      let report:WordQualityReport, reportRef:QualityReportRef;
      if(saved){
        if(saved.version!=='word-size-repair-v1' || saved.input_hash!==ctx.run.input_hash.trim()
          || !isDeepStrictEqual(saved.candidate,JSON.parse(JSON.stringify(previous))))throw Error('INPUT_REVISION_CONFLICT');
        reportRef=saved.report as QualityReportRef;
        report=await withPerformanceSpan('authoring.repair.report_replay',{repair_round:round,cache_hit:true},async()=>parseWordQualityReport((await readAuthoringFile(ctx,reportRef)).toString('utf8'),true));
      }else{
        const outcome=await withModelStagePerformance('authoring.delivery.attempt',{repair_round:round},()=>options.attempt(ctx,round));
        if(outcome.kind!=='fail' || outcome.code!=='WORD_QUALITY_REJECTED' || !outcome.checkpoint?.quality_gate)return outcome;
        reportRef=(outcome.checkpoint.quality_gate as {report:QualityReportRef}).report;
        report=parseWordQualityReport((await readAuthoringFile(ctx,reportRef)).toString('utf8'),true);
        const findings=codes(report);
        // A renderer outage must retry the checker, not buy another model turn.
        if(findings.includes('WORD_PAGE_COUNT_UNAVAILABLE'))throw Error('WORD_PAGE_COUNT_UNAVAILABLE');
        if(!findings.includes('WORD_DOCUMENT_SIZE_REDUCED') || !findings.every(code=>repairable.has(code)))return outcome;
        if(ctx.lease?.checkpoint.word_pair_delivery_recovery)return outcome;
        const record={version:'word-size-repair-v1',input_hash:ctx.run.input_hash.trim(),
          candidate:JSON.parse(JSON.stringify(previous)),report:reportRef};
        await (options.checkpoint??checkpointStage)(ctx.pool,ctx.lease,stage,record,false);
        ctx.checkpoint[stage]=record;
      }
      // Revalidate the persisted authorization before replaying or sending a turn.
      const findings=codes(report);
      if(!findings.includes('WORD_DOCUMENT_SIZE_REDUCED') || !findings.every(code=>repairable.has(code)))throw Error('WORD_QUALITY_REPORT_INVALID');
      if(ctx.lease.checkpoint.word_pair_delivery_recovery || round===MAX_SIZE_REPAIRS)
        return {kind:'pause',stage:'capability_not_ready',reason:'word_size_repair_exhausted'};
      ctx.signal.throwIfAborted();
      if(await (options.pause??pauseAtCheckpoint)(ctx.pool,ctx.lease))return {kind:'stopped'};
      const result=await withModelStagePerformance('authoring.repair',{repair_round:round+1},()=>options.repair(ctx,{round:round+1,previous,report,reportRef}));
      if(result.kind!=='done')return result;
      ctx.values.set('model_generation',result.value);
      if(await (options.pause??pauseAtCheckpoint)(ctx.pool,ctx.lease))return {kind:'stopped'};
    }
    throw Error('WORD_QUALITY_REPORT_INVALID');
  }finally{ctx.values.set('model_generation',original);}
}
