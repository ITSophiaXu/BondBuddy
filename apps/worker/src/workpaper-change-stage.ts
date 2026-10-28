import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Value} from '@sinclair/typebox/value';
import {WorkpaperChangeInputSchema,type WorkpaperChangeInput,type WorkpaperChangeResult} from '@bondbuddy/contracts';
import type {Pool} from 'pg';
import {readProjectFileAsset} from '@bondbuddy/api/project-file-storage';
import {workpaperDocx} from '@bondbuddy/api/workpapers';
import {inputManifestHash} from '@bondbuddy/api/production-rule-pin';
import {digest,transaction} from '@bondbuddy/api/data';
import type {StageContext,RunRow,InputRevisionRow,RunStage,StageOutcome} from './run-pipeline.js';
import {inspectProjectFile,projectFilePython} from './project-file-tools.js';
import {workpaperImpact,type SourceDiff} from './workpaper-changes.js';
export const isWorkpaperChange=(value:unknown):value is WorkpaperChangeInput=>Value.Check(WorkpaperChangeInputSchema,value);
export async function workpaperChangeGate(pool:Pool,run:RunRow,input:InputRevisionRow):Promise<Extract<StageOutcome,{kind:'fail'}>|null>{
  const fail={kind:'fail',code:'INPUT_REVISION_CONFLICT'} as const,m=input.manifest;
  if(!isWorkpaperChange(m)||run.task_kind!=='generation'||inputManifestHash(m)!==run.input_hash.trim()||input.input_hash.trim()!==run.input_hash.trim())return fail;
  const row=(await pool.query(`SELECT c.*,j.subtype,b.source FROM bb_workpaper_checks c JOIN bb_jobs j ON j.owner_user_id=c.owner_user_id AND j.run_id=c.run_id
    JOIN bb_workpaper_batches b ON b.owner_user_id=c.owner_user_id AND b.project_id=c.project_id AND b.id=c.batch_id WHERE c.owner_user_id=$1 AND c.project_id=$2 AND c.run_id=$3`,[run.owner_user_id,run.project_id,run.id])).rows[0];
  if(!row||row.subtype!=='workpaper_change_v1'||row.input_hash.trim()!==run.input_hash.trim()||inputManifestHash(row.manifest)!==run.input_hash.trim()||inputManifestHash(row.source)!==inputManifestHash(m.baseline))return fail;
  try{for(const source of [m.source,m.baseline])await readProjectFileAsset(pool,run.owner_user_id,source.asset);}catch{return fail;}
  return null;
}
async function load(ctx:StageContext){
  const row=(await ctx.pool.query('SELECT input_hash,manifest FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3',[ctx.run.owner_user_id,ctx.run.project_id,ctx.run.input_revision])).rows[0];
  if(!row||await workpaperChangeGate(ctx.pool,ctx.run,row))throw Error('INPUT_REVISION_CONFLICT');return row.manifest as WorkpaperChangeInput;
}
export function workpaperChangeStage():RunStage{return {name:'model_generation',replay:true,run:async ctx=>{
  const input=await load(ctx),saved=(await ctx.pool.query('SELECT result,result_hash FROM bb_workpaper_checks WHERE owner_user_id=$1 AND run_id=$2',[ctx.run.owner_user_id,ctx.run.id])).rows[0];
  if(saved.result){if(inputManifestHash(saved.result)!==saved.result_hash.trim())throw Error('INPUT_REVISION_CONFLICT');return {kind:'done',value:saved.result};}
  const dir=await mkdtemp(join(tmpdir(),'bb-workpaper-change-'));
  try{
    const snapshots=[];
    for(const [index,source] of [input.baseline,input.source].entries()){
      const asset=await readProjectFileAsset(ctx.pool,ctx.run.owner_user_id,source.asset),bytes=await ctx.blobs.getIfExistsBounded(asset.object_key,100*1024*1024);
      if(!bytes||digest(bytes)!==source.asset.pin.sha256)throw Error('INPUT_REVISION_CONFLICT');
      const path=join(dir,`${index}.${asset.media_type==='application/pdf'?'pdf':'docx'}`);await writeFile(path,bytes);snapshots.push(await inspectProjectFile(ctx,path,true));
    }
    const [baseline,current]=snapshots;await writeFile(join(dir,'baseline.json'),JSON.stringify(baseline));await writeFile(join(dir,'current.json'),JSON.stringify(current));
    await projectFilePython(ctx,['diff',join(dir,'baseline.json'),join(dir,'current.json'),join(dir,'diff.json')]);
    const diff:SourceDiff=JSON.parse(await readFile(join(dir,'diff.json'),'utf8'));
    const rows=(await ctx.pool.query(`SELECT i.*,l.result AS links,l.result_hash,r.state AS run_state,w.decision AS output_decision,coalesce(i.explanation,w.explanation) AS delivered_explanation FROM bb_workpaper_items i
      LEFT JOIN bb_project_file_generation_links l ON l.owner_user_id=i.owner_user_id AND l.run_id=i.run_id LEFT JOIN bb_runs r ON r.owner_user_id=i.owner_user_id AND r.id=i.run_id
      LEFT JOIN bb_workpaper_item_results w ON w.owner_user_id=i.owner_user_id AND w.run_id=i.run_id AND r.state='succeeded'
      WHERE i.owner_user_id=$1 AND i.batch_id=$2 ORDER BY i.ordinal`,[ctx.run.owner_user_id,input.batch_id])).rows;
    const result:WorkpaperChangeResult={version:'workpaper-change-result-v1',source_sha256:current!.sha256,baseline_sha256:baseline!.sha256,
      changed_spans:diff.reduce((n,d)=>n+d.before_ids.length+d.after_ids.length,0),warnings:[...baseline!.warnings,...current!.warnings],items:rows.map(r=>{
        const valid=r.links&&inputManifestHash(r.links)===r.result_hash.trim()&&r.links.source_sha256===baseline!.sha256;
        return workpaperImpact({id:r.item_id,links:valid?r.links.links:[],decision:r.output_decision??r.manifest.input.workpaper.decision,explanation:!!r.delivered_explanation,available:!!r.delivered_explanation||r.run_state==='succeeded'},baseline!,current!,diff);
      })};
    await transaction(ctx.pool,async c=>{
      if(!(await c.query("SELECT 1 FROM bb_jobs WHERE id=$1 AND owner_user_id=$2 AND state='running' AND lease_token=$3 AND lease_until>now() FOR UPDATE",[ctx.lease.jobId,ctx.run.owner_user_id,ctx.lease.token])).rowCount)throw Error('LEASE_LOST');
      await c.query('UPDATE bb_workpaper_checks SET result=$3,result_hash=$4 WHERE owner_user_id=$1 AND run_id=$2 AND result IS NULL',[ctx.run.owner_user_id,ctx.run.id,result,inputManifestHash(result)]);
    });return {kind:'done',value:result};
  }finally{await rm(dir,{recursive:true,force:true});}
}};}
export function workpaperChangeDelivery():RunStage{return {name:'word_delivery',replay:true,run:async ctx=>{
  await load(ctx);const result=ctx.values.get('model_generation') as WorkpaperChangeResult;
  const saved=(await ctx.pool.query('SELECT result_hash FROM bb_workpaper_checks WHERE owner_user_id=$1 AND run_id=$2',[ctx.run.owner_user_id,ctx.run.id])).rows[0];
  if(!saved||saved.result_hash?.trim()!==inputManifestHash(result))return {kind:'fail',code:'INPUT_REVISION_CONFLICT'};
  const bytes=await workpaperDocx('底稿变更影响检查',result.items.flatMap(i=>[i.item_id+'：'+i.reason,...i.changes.map(c=>c.before+' → '+(c.after||'已删除'))]));
  return {kind:'deliver',bytes,deliveryPolicy:'generated_review_v1'};
}};}
