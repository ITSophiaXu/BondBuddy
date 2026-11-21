import {Type,type Static} from '@sinclair/typebox';
import {Value} from '@sinclair/typebox/value';
import {WorkpaperSharedPlanSchema,type M4DocumentManifest,type WorkpaperProgressive,workpaperPlanGroupIds,WORKPAPER_PLAN_GROUP_SIZE} from '@bondbuddy/contracts';
import {inputManifestHash as hash} from '@bondbuddy/api/production-rule-pin';
import {transaction} from '@bondbuddy/api/data';
import {startPerformanceSpan,withPerformanceSpan} from '@bondbuddy/api/performance-trace';
import {withModelStagePerformance} from './model-performance.js';
import {writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {taskExecFile} from './task-execution.js';
import {setTimeout as delay} from 'node:timers/promises';
import {projectFilesRoot} from './project-file-tools.js';
import {checkedM4File} from './m4-file-workspace.js';
import {m4ActionObserver} from './m4-action-progress.js';
import type {StageContext,StageOutcome,codexModelStage} from './run-pipeline.js';
import type {CodexAdapterConfig} from './codex-adapter.js';
import type {SharedSource} from './workpaper-shared-stage.js';

export {WORKPAPER_PLAN_GROUP_SIZE} from '@bondbuddy/contracts';
const MAX_PLAN=64*1024*1024,version='workpaper-progressive-group-result-v1';
const obj=<T extends Parameters<typeof Type.Object>[0]>(p:T)=>Type.Object(p,{additionalProperties:false});
const id=Type.String({minLength:1,maxLength:128});
const error=Type.String({pattern:'^WORKPAPER_[A-Z_]+$'});
export const WorkpaperProgressiveGroupResultSchema=Type.Union([
  obj({version:Type.Literal(version),status:Type.Literal('fallback'),items:Type.Array(Type.Never(),{maxItems:0})}),
  obj({version:Type.Literal(version),status:Type.Literal('items'),items:Type.Array(Type.Union([
    obj({item_id:id,plan:WorkpaperSharedPlanSchema}),obj({item_id:id,error}),
  ]),{minItems:1,maxItems:WORKPAPER_PLAN_GROUP_SIZE})}),
]);
type GroupResult=Static<typeof WorkpaperProgressiveGroupResultSchema>;
type Receipt={version:typeof version;status:'items'|'fallback';items:({item_id:string;plan_hash:string}|{item_id:string;error:string})[]};
type GroupOutcome={kind:'ready';planHash:string}|{kind:'fallback'}|{kind:'item_failed';error:string}|{kind:'outcome';outcome:StageOutcome;logicalCallId:string};
export function progressiveItemPlanIdentity(batchIdentity:string,manifest:M4DocumentManifest){
  return hash({version:'workpaper-progressive-item-v1',batch_identity:batchIdentity,manifest});
}
/** Trial files never wait for a group. Remaining membership is derived only
 * from the frozen chapter/catalogue order, not the current queue or retry order. */
export function progressivePlanGroup(manifests:M4DocumentManifest[],plan:WorkpaperProgressive|undefined,itemId:string){
  const membership=workpaperPlanGroupIds(plan,itemId);if(!membership)return null;
  const {ids,chapter}=membership;
  const group=ids.map(id=>manifests.find(m=>m.input.workpaper!.entry.id===id));
  if(group.some(m=>!m))throw Error('INPUT_REVISION_CONFLICT');
  return {id:hash({version:'workpaper-chapter-group-v1',chapter,ids,size:WORKPAPER_PLAN_GROUP_SIZE}),manifests:group as M4DocumentManifest[]};
}

/** The durable result distinguishes fallback from accepted item plans. A
 * malformed group consumes its recorded provider usage once, but it never
 * masquerades as an accepted document or causes an entire group to be retried. */
export async function prepareProgressiveGroup(ctx:StageContext,options:{
  batch:string;itemId:string;group:NonNullable<ReturnType<typeof progressivePlanGroup>>;
  batchIdentity:string;method:string;source:SharedSource;dir:string;input:Record<string,unknown>;
  skill:{content:string};config:CodexAdapterConfig;model:typeof codexModelStage;
  prepare:(cwd:string,input:Record<string,unknown>)=>Promise<void>;
  validPlan:(value:unknown,manifests:M4DocumentManifest[])=>boolean;
  itemError:(code:string)=>boolean;
}):Promise<GroupOutcome>{
  const {batch,itemId,group,source,method,dir}=options,owner=ctx.run.owner_user_id;
  const identity=hash({version:'workpaper-progressive-group-v1',batch_identity:options.batchIdentity,group_id:group.id,manifests:group.manifests});
  const logicalCallId='workpaper-group-'+group.id.slice(0,40),key=`workpaper-plan-group:${owner}:${batch}:${group.id}`;
  const performanceAttributes={batch_id:batch,group_id:group.id,work_item_id:itemId,logical_call_id:logicalCallId};
  const validResult=(value:unknown):value is GroupResult=>{
    if(!Value.Check(WorkpaperProgressiveGroupResultSchema,value))return false;
    if(value.status==='fallback')return true;
    const ids=group.manifests.map(m=>m.input.workpaper!.entry.id);
    return value.items.length===ids.length&&new Set(value.items.map(i=>i.item_id)).size===ids.length&&value.items.every(i=>{
      const m=group.manifests.find(m=>m.input.workpaper!.entry.id===i.item_id);
      return !!m&&('plan'in i?options.validPlan(i.plan,[m]):options.itemError(i.error));
    });
  };
  const fallback:GroupResult={version,status:'fallback',items:[]};
  const read=async()=> (await ctx.pool.query('SELECT * FROM bb_workpaper_progressive_groups WHERE owner_user_id=$1 AND batch_id=$2 AND group_id=$3',[owner,batch,group.id])).rows[0];
  {
    let saved:any;
    let groupWait:ReturnType<typeof startPerformanceSpan>|undefined,authorRunId:string|undefined;
    let waitStatus:Parameters<ReturnType<typeof startPerformanceSpan>['end']>[0]='succeeded';
    try {
    for(;;){
      ctx.signal.throwIfAborted();
      saved=await read();
      const authorItem=group.manifests[0]!.input.workpaper!.entry.id;
      if(saved||itemId===authorItem)break;
      groupWait??=startPerformanceSpan('group.wait',{...performanceAttributes,wait_reason:'group_producer',owns_worker_slot:true});
      // Only the first immutable member authors this group. If it crashes after
      // durable acceptance, another in-flight item must not create a second
      // provider call under a different run. Wait without occupying a pooled
      // connection, leaving room for its lease renewal and durable replay.
      const author=(await ctx.pool.query(`SELECT b.state AS batch_state,r.state AS run_state,r.id AS run_id,
        (r.state IN ('failed','cancelled','rejected','succeeded','test_completed') AND j.state=r.state AND j.lease_token IS NULL AND j.lease_until IS NULL
          AND NOT EXISTS(SELECT 1 FROM bb_model_call_attempts a WHERE a.owner_user_id=i.owner_user_id AND a.job_id=j.id AND a.status='pending_reconcile')) AS settled_terminal
        FROM bb_workpaper_items i
        JOIN bb_workpaper_batches b ON b.owner_user_id=i.owner_user_id AND b.id=i.batch_id
        LEFT JOIN bb_runs r ON r.owner_user_id=i.owner_user_id AND r.id=i.run_id
        LEFT JOIN bb_jobs j ON j.owner_user_id=r.owner_user_id AND j.run_id=r.id
        WHERE i.owner_user_id=$1 AND i.batch_id=$2 AND i.item_id=$3`,[owner,batch,authorItem])).rows[0];
      if(!author)throw Error('INPUT_REVISION_CONFLICT');
      authorRunId=author.run_id;
      if(!['paused','cancelled'].includes(author.batch_state)&&['failed','cancelled','succeeded'].includes(author.run_state)){
        const disposition=await withPerformanceSpan('group.plan.persist',{...performanceAttributes,author_run_id:author.run_id,fallback_reason:'author_settled'},()=>transaction(ctx.pool,async db=>{
          await db.query('SELECT 1 FROM bb_runs WHERE owner_user_id=$1 AND id=$2 FOR UPDATE',[owner,author.run_id]);
          await db.query('SELECT 1 FROM bb_jobs WHERE owner_user_id=$1 AND run_id=$2 FOR UPDATE',[owner,author.run_id]);
          await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[key]);
          if((await db.query('SELECT 1 FROM bb_workpaper_progressive_groups WHERE owner_user_id=$1 AND batch_id=$2 AND group_id=$3',[owner,batch,group.id])).rowCount)return true;
          const settled=(await db.query(`SELECT r.id FROM bb_workpaper_items i
            JOIN bb_runs r ON r.owner_user_id=i.owner_user_id AND r.id=i.run_id
            JOIN bb_jobs j ON j.owner_user_id=r.owner_user_id AND j.run_id=r.id
            WHERE i.owner_user_id=$1 AND i.batch_id=$2 AND i.item_id=$3 AND j.lease_token IS NULL AND j.lease_until IS NULL
            AND NOT EXISTS(SELECT 1 FROM bb_model_call_attempts pending WHERE pending.owner_user_id=$1 AND pending.job_id=j.id AND pending.status='pending_reconcile')
            AND ((r.state='cancelled' AND j.state='cancelled') OR (r.state='succeeded' AND j.state='succeeded' AND EXISTS(
              SELECT 1 FROM bb_workpaper_progressive_plans p WHERE p.owner_user_id=$1 AND p.batch_id=$2 AND p.item_id=$3 AND p.method_hash=$5 AND p.source_hash=$6))
              OR (r.state='failed' AND j.state='failed' AND EXISTS(SELECT 1 FROM bb_model_call_attempts a JOIN bb_provider_call_observations o ON o.attempt_id=a.id
                WHERE a.owner_user_id=$1 AND a.job_id=j.id AND a.logical_call_id=$4 AND a.status='failed'
                AND o.owner_user_id=$1 AND o.run_id=r.id AND o.job_id=j.id AND o.logical_call_id=$4 AND o.outcome='failed' AND o.usage_status='measured'
                AND o.error_code='MODEL_OUTPUT_SCHEMA_INVALID' AND o.id=(SELECT latest.id FROM bb_provider_call_observations latest WHERE latest.attempt_id=a.id ORDER BY latest.observed_at DESC,latest.id DESC LIMIT 1)
                AND NOT EXISTS(SELECT 1 FROM bb_model_call_attempts newer WHERE newer.job_id=j.id AND newer.logical_call_id=$4 AND newer.attempt_no>a.attempt_no))))`,[owner,batch,authorItem,logicalCallId,method,hash(source)])).rows[0];
          if(!settled)return false;
          const receipt:Receipt={version,status:'fallback',items:[]};
          await db.query(`INSERT INTO bb_workpaper_progressive_groups(owner_user_id,batch_id,group_id,input_hash,method_hash,source_hash,receipt,receipt_hash,author_run_id)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[owner,batch,group.id,identity,method,hash(source),receipt,hash(receipt),settled.id]);
          return true;
        }));
        if(disposition){saved=await read();break;}
      }
      if(author.settled_terminal){waitStatus='failed';return {kind:'outcome',logicalCallId,outcome:{kind:'fail',code:'WORKPAPER_GROUP_BLOCKED'}};}
      if(['paused','cancelled'].includes(author.batch_state)||['paused','failed','cancelled','rejected','succeeded','test_completed'].includes(author.run_state)){
        waitStatus='paused';return {kind:'outcome',logicalCallId,outcome:{kind:'pause',stage:'capability_not_ready',reason:'workpaper_group_plan_pending'}};
      }
      await delay(100,undefined,{signal:ctx.signal});
    }
    } catch(error){waitStatus=ctx.signal.aborted?'cancelled':'failed';throw error;}
    finally{groupWait?.end(waitStatus,{...(saved?.author_run_id||authorRunId?{author_run_id:saved?.author_run_id??authorRunId}:{})});}
    const reused=!!saved;
    if(!saved){
      const observer=m4ActionObserver(ctx,'document');
      let outcome:StageOutcome;
      try{outcome=await withModelStagePerformance('group.plan_prepare',{...performanceAttributes,author_run_id:ctx.run.id},()=>options.model({name:'workpaper_progressive_group_v1',logicalCallId,config:{...options.config,max_schema_reasks:0,max_output_bytes:MAX_PLAN},
        schema:WorkpaperProgressiveGroupResultSchema,validate:validResult,resultSchemaVersion:version,templateVersion:method,buildPrompt:async()=>options.skill.content,onActivity:e=>observer.onEvent(e),
        fileWorkspace:{prepare:cwd=>options.prepare(cwd,options.input),collect:async cwd=>{
          let plan:unknown;
          try{plan=JSON.parse((await checkedM4File(join(cwd,'output'),'batch-plan.json',MAX_PLAN)).toString('utf8'));}
          catch(error){if(error instanceof SyntaxError||(error as {code?:string}).code==='ENOENT')return fallback;throw error;}
          if(plan&&typeof plan==='object'&&'source_sha256'in plan&&plan.source_sha256!==source.source.sha256)throw Error('INPUT_REVISION_CONFLICT');
          if(!options.validPlan(plan,group.manifests))return fallback;
          await writeFile(join(dir,'group-input.json'),JSON.stringify(options.input));await writeFile(join(dir,'group-plan.json'),JSON.stringify(plan));
          await taskExecFile(process.env.BONDBUDDY_WORD_PYTHON??process.env.BONDBUDDY_TEST_PYTHON??'python3',
            ['-B',join(projectFilesRoot,'python/bondbuddy_workpaper_progressive.py'),'prepare',join(dir,'source-data.json'),join(dir,'group-input.json'),join(dir,'group-plan.json'),join(dir,'group-validation.json')],
            {cwd:projectFilesRoot,env:{...process.env,PYTHONPATH:join(projectFilesRoot,'python'),PYTHONDONTWRITEBYTECODE:'1'},signal:ctx.signal,timeout:300000,maxBuffer:16384});
          const result=JSON.parse(await readFile(join(dir,'group-validation.json'),'utf8'));
          if(!validResult(result))throw Error('WORKPAPER_GROUP_VALIDATION_UNSAFE');
          return result;
        }}
      }).run(ctx));}finally{await observer.drain();}
      if(outcome.kind!=='done')return {kind:'outcome',outcome,logicalCallId};
      if(!validResult(outcome.value))throw Error('WORKPAPER_GROUP_VALIDATION_UNSAFE');
      const result=outcome.value;
      const receipt:Receipt={version,status:result.status,items:result.status==='fallback'?[]:result.items.map(i=>'plan'in i?{item_id:i.item_id,plan_hash:hash(i.plan)}:{item_id:i.item_id,error:i.error})};
      // Commit the receipt and every accepted item atomically. The receipt only
      // stores hashes/errors, so it does not duplicate each item's coverage IDs.
      await withPerformanceSpan('group.plan.persist',{...performanceAttributes,author_run_id:ctx.run.id},()=>transaction(ctx.pool,async db=>{
        // Match renewal/cancellation/evidence writers: run first, then job.
        // The plan foreign key later takes a run key-share lock as well.
        await db.query('SELECT 1 FROM bb_runs WHERE owner_user_id=$1 AND id=$2 FOR UPDATE',[owner,ctx.run.id]);
        const active=(await db.query(`SELECT 1 FROM bb_jobs j JOIN bb_runs r ON r.owner_user_id=j.owner_user_id AND r.id=j.run_id
          WHERE j.owner_user_id=$1 AND j.id=$2 AND j.run_id=$3 AND j.state='running' AND r.state='running' AND j.lease_token=$4 AND j.lease_until>now() FOR UPDATE OF j`,[owner,ctx.lease.jobId,ctx.run.id,ctx.lease.token])).rowCount;
        if(!active)throw Error('WORKPAPER_GROUP_LEASE_LOST');
        await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[key]);
        if(result.status==='items')for(const item of result.items){
          if(!('plan'in item))continue;
          const manifest=group.manifests.find(m=>m.input.workpaper!.entry.id===item.item_id)!;
          await db.query(`INSERT INTO bb_workpaper_progressive_plans(owner_user_id,batch_id,input_hash,method_hash,source_hash,plan,plan_hash,author_run_id,item_id)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,[owner,batch,progressiveItemPlanIdentity(options.batchIdentity,manifest),method,hash(source),item.plan,hash(item.plan),ctx.run.id,item.item_id]);
          const accepted=(await db.query('SELECT input_hash,method_hash,source_hash,plan_hash FROM bb_workpaper_progressive_plans WHERE owner_user_id=$1 AND batch_id=$2 AND item_id=$3',[owner,batch,item.item_id])).rows[0];
          if(accepted.input_hash.trim()!==progressiveItemPlanIdentity(options.batchIdentity,manifest)||accepted.method_hash.trim()!==method||accepted.source_hash.trim()!==hash(source)||accepted.plan_hash.trim()!==hash(item.plan))throw Error('INPUT_REVISION_CONFLICT');
        }
        await db.query(`INSERT INTO bb_workpaper_progressive_groups(owner_user_id,batch_id,group_id,input_hash,method_hash,source_hash,receipt,receipt_hash,author_run_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[owner,batch,group.id,identity,method,hash(source),receipt,hash(receipt),ctx.run.id]);
      }));
      saved=await read();
    }
    const resolveSaved=():GroupOutcome=>{
    if(saved.input_hash.trim()!==identity||saved.method_hash.trim()!==method||saved.source_hash.trim()!==hash(source)||saved.receipt_hash.trim()!==hash(saved.receipt))throw Error('INPUT_REVISION_CONFLICT');
    const receipt=saved.receipt as Receipt;
    if(receipt.version!==version)throw Error('INPUT_REVISION_CONFLICT');
    if(receipt.status==='fallback'&&receipt.items.length===0)return {kind:'fallback'};
    const item=receipt.items.find(i=>i.item_id===itemId);
    if(receipt.status!=='items'||!item)throw Error('INPUT_REVISION_CONFLICT');
    if('error'in item){if(!options.itemError(item.error))throw Error('INPUT_REVISION_CONFLICT');return {kind:'item_failed',error:item.error};}
    if(!/^[a-f0-9]{64}$/.test(item.plan_hash))throw Error('INPUT_REVISION_CONFLICT');
    return {kind:'ready',planHash:item.plan_hash};
    };
    if(!reused)return resolveSaved();
    return withPerformanceSpan('group.reuse',{...performanceAttributes,author_run_id:saved.author_run_id,cache_hit:true},span=>{
      const result=resolveSaved();span.end(result.kind==='item_failed'?'failed':'reused',{result_status:result.kind});return result;
    });
  }
}
