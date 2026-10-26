import type {Pool,PoolClient} from 'pg';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {Static} from '@sinclair/typebox';
import {Value} from '@sinclair/typebox/value';
import {PROJECT_FILE_UPDATE_PRICE,projectFileSchemas,ProjectFilePatchInputSchema,type ProjectFileOperation,type ProjectFileCheck,type ProjectFileFinding} from '@bondbuddy/contracts';
import {project,transaction,uid,conflict,missing,Problem,date,assertCanonicalBusinessRunIdle} from './data.js';
import {inputManifestHash} from './production-rule-pin.js';
import {projectFileSource,projectFileVersions,readProjectFileAsset} from './project-file-storage.js';
import {enqueue} from './queue.js';
import {requireFileUpdateCredits,reserveFileUpdate} from './project-file-billing.js';

type Patch=Extract<ProjectFileOperation,{operation:'patch'}>;
type UpdateItem={manifest:Patch;issue_ids:string[];run_id:string|null;error:string|null;attempt?:number};
const terminal=['succeeded','failed','cancelled','rejected','test_completed'];
async function available(c:PoolClient,owner:string,id:string){
  const p=await project(c,owner,id,true);if(p.archived_at)throw conflict('INPUT_REVISION_CONFLICT','请先恢复已归档项目。');
  await assertCanonicalBusinessRunIdle(c,owner,p);
  if((await c.query("SELECT 1 FROM bb_runs WHERE owner_user_id=$1 AND project_id=$2 AND task_kind<>'qa' AND NOT(state=ANY($3::text[]))",[owner,id,terminal])).rowCount)
    throw conflict('PROJECT_RUN_ACTIVE','此项目正在处理其他任务，请完成或结束后再试。');
  return p;
}
async function event(c:PoolClient,owner:string,id:string,type:string,payload:unknown){
  await c.query('UPDATE bb_projects SET updated_at=now() WHERE owner_user_id=$1 AND id=$2',[owner,id]);
  await c.query("INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,'project',$3,$4,$5)",[uid(),owner,id,type,payload]);
}
async function createOperation(c:PoolClient,owner:string,id:string,key:string,requestHash:string,manifest:ProjectFileOperation){
  const p=await available(c,owner,id),hash=inputManifestHash(manifest);
  const revision=Number((await c.query('SELECT COALESCE(max(revision),0)+1 AS next FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2',[owner,id])).rows[0].next);
  await c.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
    VALUES($1,$2,$3,$4,$5,$6,'[]','[]')`,[id,revision,owner,p.draft_revision,hash,manifest]);
  await c.query('UPDATE bb_projects SET latest_input_revision=$3,updated_at=now() WHERE owner_user_id=$1 AND id=$2',[owner,id,revision]);
  const run=(await c.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state)
    VALUES($1,$2,$3,$4,$5,$6,'generation',$7,'queued') RETURNING *`,[uid(),owner,id,revision,hash,key,requestHash])).rows[0];
  await c.query('INSERT INTO bb_project_file_operations(run_id,owner_user_id,project_id,operation,manifest,input_hash) VALUES($1,$2,$3,$4,$5,$6)',[run.id,owner,id,manifest.operation,manifest,hash]);
  if(manifest.operation==='patch')await reserveFileUpdate(c,owner,run,manifest);
  await enqueue(c,run,'project_file_v1');await event(c,owner,id,'project.file_'+manifest.operation+'_started',{run_id:run.id});
  return run;
}
async function projectFileChecks(db:Pool,owner:string,id:string,runId?:string):Promise<ProjectFileCheck[]>{
  await project(db,owner,id);const current=await projectFileSource(db,owner,id);
  const rows=(await db.query(`SELECT o.*,r.state,r.stage FROM bb_project_file_operations o JOIN bb_runs r ON r.owner_user_id=o.owner_user_id AND r.project_id=o.project_id AND r.id=o.run_id
    WHERE o.owner_user_id=$1 AND o.project_id=$2 AND o.operation='check' ${runId===undefined?'ORDER BY o.created_at DESC LIMIT 30':'AND o.run_id=$3'}`,runId===undefined?[owner,id]:[owner,id,runId])).rows;
  const updates=(await db.query(`SELECT a.*,r.state,v.id AS new_version_id FROM bb_project_file_acceptances a JOIN bb_runs r ON r.owner_user_id=a.owner_user_id AND r.id=a.run_id
    LEFT JOIN bb_project_file_versions v ON v.owner_user_id=a.owner_user_id AND v.run_id=a.run_id WHERE a.owner_user_id=$1 AND a.check_run_id=ANY($2::text[])`,[owner,rows.map(r=>r.run_id)])).rows;
  const batches=(await db.query("SELECT * FROM bb_project_file_update_batches WHERE owner_user_id=$1 AND project_id=$2 AND state IN ('queued','running','paused')",[owner,id])).rows;
  return rows.map(r=>({run_id:r.run_id,state:r.state,stage:r.stage,created_at:date(r.created_at),source:r.manifest.source,
    stale:r.manifest.source.version_id!==current?.version_id||r.manifest.source.selection_revision!==current?.selection_revision,
    sha256:r.result_hash?.trim()??null,result:r.state==='succeeded'?r.result:null,
    files:r.manifest.files.map((f:any)=>({file_id:f.file_id,file_version_id:f.file_version_id,filename:f.filename,sequence:f.sequence})),
    updates:[...updates.filter(a=>a.check_run_id===r.run_id).map(a=>({file_version_id:a.file_version_id,issue_ids:a.issue_ids,run_id:a.run_id,state:a.state,new_version_id:a.new_version_id??null})),
      ...batches.filter(b=>b.check_run_id===r.run_id).flatMap(b=>(b.items as UpdateItem[]).filter(i=>!i.run_id).map(i=>({file_version_id:i.manifest.file_version_id,issue_ids:i.issue_ids,run_id:null,state:b.state==='paused'?'paused':'queued',new_version_id:null})))]}));
}
export function readProjectFileChecks(db:Pool,owner:string,id:string):Promise<ProjectFileCheck[]>{
  return projectFileChecks(db,owner,id);
}
export async function readProjectFileCheck(db:Pool,owner:string,id:string,runId:string):Promise<ProjectFileCheck>{
  const checks=await projectFileChecks(db,owner,id,runId);
  if(checks.length!==1)throw missing();
  return checks[0];
}
export async function readProjectFileUpdateCheck(db:Pool,owner:string,id:string,runId:string):Promise<ProjectFileCheck>{
  await project(db,owner,id);
  const accepted=(await db.query(`SELECT a.check_run_id,a.file_version_id,o.manifest FROM bb_project_file_acceptances a
    JOIN bb_project_file_operations o ON o.owner_user_id=a.owner_user_id AND o.run_id=a.run_id
    JOIN bb_runs r ON r.owner_user_id=o.owner_user_id AND r.project_id=o.project_id AND r.id=o.run_id
    WHERE a.owner_user_id=$1 AND o.project_id=$2 AND a.run_id=$3 AND o.operation='patch'`,[owner,id,runId])).rows;
  if(accepted.length!==1)throw missing();
  const row=accepted[0],manifest:unknown=row.manifest;
  if(!Value.Check(ProjectFilePatchInputSchema,manifest)||manifest.check_run_id!==row.check_run_id||manifest.file_version_id!==row.file_version_id)throw missing();
  const check=await readProjectFileCheck(db,owner,id,row.check_run_id),updates=check.updates.filter(update=>update.run_id===runId),files=check.files.filter(file=>file.file_version_id===row.file_version_id);
  if(updates.length!==1||updates[0].file_version_id!==row.file_version_id||files.length!==1||files[0].file_id!==manifest.file_id||check.sha256!==manifest.check_sha256||
    inputManifestHash(check.source)!==inputManifestHash(manifest.source))throw missing();
  return check;
}
async function currentSource(c:PoolClient,owner:string,id:string,expected:{version_id:string;selection_revision?:number}){
  const s=await projectFileSource(c,owner,id);
  if(!s||s.version_id!==expected.version_id||(expected.selection_revision!==undefined&&s.selection_revision!==expected.selection_revision))
    throw conflict('INPUT_REVISION_CONFLICT','项目当前募集书已变化，请重新检查后再接受修改。');
  return s;
}
export async function advanceProjectFileUpdates(pool:Pool):Promise<boolean>{
  return transaction(pool,async c=>{
    const b=(await c.query(`SELECT b.* FROM bb_project_file_update_batches b JOIN bb_projects p ON p.id=b.project_id AND p.owner_user_id=b.owner_user_id
      WHERE b.state IN ('queued','running') AND p.deleted_at IS NULL AND p.archived_at IS NULL ORDER BY b.updated_at,b.id FOR UPDATE OF b SKIP LOCKED LIMIT 1`)).rows[0];
    if(!b)return false;
    const items=b.items as UpdateItem[],next=items.find(i=>!i.run_id);
    const running=items.filter(i=>i.run_id).map(i=>i.run_id);
    const states=(await c.query('SELECT id,state FROM bb_runs WHERE owner_user_id=$1 AND id=ANY($2::text[])',[b.owner_user_id,running])).rows;
    if(states.some(r=>!terminal.includes(r.state))){await c.query('UPDATE bb_project_file_update_batches SET updated_at=now() WHERE id=$1',[b.id]);return false;}
    if(states.some(r=>r.state!=='succeeded')){await c.query("UPDATE bb_project_file_update_batches SET state='paused',updated_at=now() WHERE id=$1",[b.id]);return true;}
    if(!next){await c.query("UPDATE bb_project_file_update_batches SET state='complete',updated_at=now() WHERE id=$1",[b.id]);return true;}
    await c.query('SAVEPOINT begin_file_patch');
    try{
      const p=await project(c,b.owner_user_id,b.project_id,true);await currentSource(c,b.owner_user_id,b.project_id,next.manifest.source);
      const f=(await c.query('SELECT * FROM bb_project_files WHERE owner_user_id=$1 AND id=$2 FOR UPDATE',[b.owner_user_id,next.manifest.file_id])).rows[0];
      if(!f||f.latest_version_id!==next.manifest.expected_current_version_id)throw conflict('INPUT_REVISION_CONFLICT','文件已有新版本，请重新检查。');
      const r=await createOperation(c,b.owner_user_id,p.id,'file-patch:'+b.id+':'+items.indexOf(next)+':'+(next.attempt??1),inputManifestHash(next.manifest),next.manifest);
      next.run_id=r.id;next.error=null;
      await c.query('INSERT INTO bb_project_file_acceptances(owner_user_id,check_run_id,file_version_id,issue_ids,run_id) VALUES($1,$2,$3,$4,$5)',
        [b.owner_user_id,b.check_run_id,next.manifest.file_version_id,JSON.stringify(next.issue_ids),r.id]);
      await c.query("UPDATE bb_project_file_update_batches SET state='running',items=$2,updated_at=now() WHERE id=$1",[b.id,JSON.stringify(items)]);
    }catch(e){
      await c.query('ROLLBACK TO SAVEPOINT begin_file_patch');
      if(e instanceof Problem&&e.code==='PROJECT_RUN_ACTIVE'||['55P03','40P01'].includes((e as {code?:string}).code??'')){
        await c.query('UPDATE bb_project_file_update_batches SET updated_at=now() WHERE id=$1',[b.id]);return false;
      }
      next.error=e instanceof Problem?e.message:'文件更新未启动，请刷新后重新检查。';
      await c.query("UPDATE bb_project_file_update_batches SET state='paused',items=$2,updated_at=now() WHERE id=$1",[b.id,JSON.stringify(items)]);
    }
    return true;
  });
}
export function registerProjectFileConsistency(app:FastifyInstance,db:()=>Pool,owner:(r:FastifyRequest)=>Promise<string>){
  const base='/api/v1/projects/:project_id/project-files',params=(r:FastifyRequest)=>r.params as {project_id:string;run_id:string};
  app.get(base+'/checks',async r=>({checks:await readProjectFileChecks(db(),await owner(r),params(r).project_id)}));
  app.get(base+'/checks/:run_id',async r=>({check:await readProjectFileCheck(db(),await owner(r),params(r).project_id,params(r).run_id)}));
  app.get(base+'/updates/:run_id/check',async r=>({check:await readProjectFileUpdateCheck(db(),await owner(r),params(r).project_id,params(r).run_id)}));
  app.post(base+'/checks',{schema:{body:projectFileSchemas.ProjectFileCheckRequest}},async r=>{
    const user=await owner(r),id=params(r).project_id,b=r.body as Static<typeof projectFileSchemas.ProjectFileCheckRequest>;
    const runId=await transaction(db(),async c=>{
      await project(c,user,id,true);const hash=inputManifestHash({project_id:id,...b}),key='file-check:'+b.request_id;
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[user+':'+key]);
      const old=(await c.query('SELECT * FROM bb_runs WHERE owner_user_id=$1 AND execution_request_id=$2',[user,key])).rows[0];
      if(old){if(old.request_hash.trim()!==hash)throw conflict('IDEMPOTENCY_CONFLICT','此请求已用于其他检查。');return old.id;}
      const source=await currentSource(c,user,id,{version_id:b.expected_source_version_id}),files=(await projectFileVersions(c as unknown as Pool,user,id)).filter(f=>f.latest);
      if(!files.length)throw new Problem(422,'INPUT_REQUIRED','请先生成或上传需要检查的项目关联文件。');
      for(const f of files)await readProjectFileAsset(c,user,f.asset);
      return (await createOperation(c,user,id,key,hash,{version:'project-file-operation-v1',operation:'check',source,
        files:files.map(f=>({file_id:f.file_id,file_version_id:f.version_id,filename:f.filename,sequence:f.sequence,asset:f.asset,links:f.links}))})).id;
    });return {run_id:runId};
  });
  app.post(base+'/checks/:run_id/updates',{schema:{body:projectFileSchemas.ProjectFileUpdateRequest}},async r=>{
    const user=await owner(r),{project_id:id,run_id:checkId}=params(r),b=r.body as Static<typeof projectFileSchemas.ProjectFileUpdateRequest>;
    return transaction(db(),async c=>{
      const p=await project(c,user,id,true);if(p.archived_at)throw conflict('INPUT_REVISION_CONFLICT','请先恢复已归档项目。');
      const hash=inputManifestHash({project_id:id,check_run_id:checkId,...b});
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[user+':file-accept:'+b.request_id]);
      const old=(await c.query('SELECT * FROM bb_project_file_update_batches WHERE owner_user_id=$1 AND request_id=$2',[user,b.request_id])).rows[0];
      if(old){if(old.request_hash.trim()!==hash)throw conflict('IDEMPOTENCY_CONFLICT','此请求已用于其他修改。');return {batch_id:old.id};}
      const check=(await c.query(`SELECT o.* FROM bb_project_file_operations o JOIN bb_runs r ON r.owner_user_id=o.owner_user_id AND r.id=o.run_id
        WHERE o.owner_user_id=$1 AND o.project_id=$2 AND o.run_id=$3 AND o.operation='check' AND r.state='succeeded'`,[user,id,checkId])).rows[0];
      if(!check)throw missing();
      if(!check.result||check.result_hash.trim()!==b.expected_check_sha256||inputManifestHash(check.result)!==b.expected_check_sha256)throw conflict('INPUT_REVISION_CONFLICT','检查结果已变化，请刷新。');
      await currentSource(c,user,id,check.manifest.source);
      if((await c.query("SELECT 1 FROM bb_project_file_update_batches WHERE owner_user_id=$1 AND project_id=$2 AND state IN ('queued','running','paused')",[user,id])).rowCount)
        throw conflict('PROJECT_RUN_ACTIVE','已有文件更新任务待完成，请先处理该任务。');
      if(new Set(b.files.map(f=>f.file_version_id)).size!==b.files.length)throw new Problem(422,'VALIDATION_FAILED','文件选择不能重复。');
      const total=b.files.length*PROJECT_FILE_UPDATE_PRICE.points;
      if(b.price_version!==PROJECT_FILE_UPDATE_PRICE.version||b.expected_points!==total)throw conflict('QUOTE_CHANGED','费用已变化，请重新确认文件数量及费用。');
      const items:UpdateItem[]=[];
      for(const selection of b.files){
        const original=check.manifest.files.find((f:any)=>f.file_version_id===selection.file_version_id),result=check.result.files.find((f:any)=>f.file_version_id===selection.file_version_id);
        if(!original||!result)throw missing();
        const family=(await c.query('SELECT * FROM bb_project_files WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE',[user,id,original.file_id])).rows[0];
        if(!family)throw missing();
        const current=family.latest_version_id;
        if(current!==original.file_version_id)throw conflict('INPUT_REVISION_CONFLICT','关联文件已有新版本，请重新检查后再更新。');
        if((await c.query(`SELECT 1 FROM bb_project_file_acceptances a JOIN bb_runs r ON r.owner_user_id=a.owner_user_id AND r.id=a.run_id
          WHERE a.owner_user_id=$1 AND a.check_run_id=$2 AND a.file_version_id=$3 AND r.state='succeeded'`,[user,checkId,original.file_version_id])).rowCount)
          throw conflict('INPUT_REVISION_CONFLICT','此文件本轮修订版已生成，请下载成果；无需重复更新或扣费。');
        const findings:ProjectFileFinding[]=result.findings.filter((f:ProjectFileFinding)=>f.kind==='conflict'&&f.replacement!==null);
        if(!findings.length)throw new Problem(422,'VALIDATION_FAILED','此文件没有可自动更新的冲突；待确认事项请补充材料或人工处理。');
        for(const f of findings){await readProjectFileAsset(c,user,original.asset);if(!f.source_span_id||!f.source_quote)throw conflict('INPUT_REVISION_CONFLICT','缺少可核验依据。');}
        items.push({manifest:{version:'project-file-operation-v1',operation:'patch',source:check.manifest.source,check_run_id:checkId,check_sha256:check.result_hash.trim(),
          file_id:original.file_id,file_version_id:original.file_version_id,expected_current_version_id:current,filename:original.filename,asset:original.asset,findings,
          manual_findings:result.findings.filter((f:ProjectFileFinding)=>f.kind==='manual')},
          issue_ids:findings.map(f=>f.id),run_id:null,error:null,attempt:1});
      }
      await requireFileUpdateCredits(c,user,total);
      const batchId=uid();await c.query(`INSERT INTO bb_project_file_update_batches(id,owner_user_id,project_id,check_run_id,request_id,request_hash,items,state)
        VALUES($1,$2,$3,$4,$5,$6,$7,'queued')`,[batchId,user,id,checkId,b.request_id,hash,JSON.stringify(items)]);
      await event(c,user,id,'project.file_updates_accepted',{batch_id:batchId,check_run_id:checkId,files:b.files});return {batch_id:batchId};
    });
  });
  app.get(base+'/updates',async r=>{const user=await owner(r),id=params(r).project_id;await project(db(),user,id);
    const batches=(await db().query('SELECT id,state,items FROM bb_project_file_update_batches WHERE owner_user_id=$1 AND project_id=$2 ORDER BY created_at DESC LIMIT 30',[user,id])).rows;
    return {batches:batches.map(b=>({batch_id:b.id,state:b.state,items:b.items.map((i:UpdateItem)=>({file_version_id:i.manifest.file_version_id,filename:i.manifest.filename,run_id:i.run_id,error:i.error}))}))};
  });
  app.post(base+'/updates/:run_id/retry',async r=>{const user=await owner(r),{project_id:id,run_id:batchId}=params(r);
    await transaction(db(),async c=>{
      await project(c,user,id,true);
      const b=(await c.query('SELECT * FROM bb_project_file_update_batches WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE',[user,id,batchId])).rows[0];
      if(!b)throw missing();if(b.state!=='paused')throw conflict('INPUT_REVISION_CONFLICT','文件包状态已变化，请刷新。');
      const items=b.items as UpdateItem[];let remaining=0;
      for(const item of items){
        if(item.run_id){
          const run=(await c.query('SELECT state FROM bb_runs WHERE owner_user_id=$1 AND id=$2',[user,item.run_id])).rows[0];
          if(!run||!terminal.includes(run.state))throw conflict('PROJECT_RUN_ACTIVE','请先继续或结束当前任务。');
          if(run.state==='succeeded')continue;
          item.run_id=null;item.attempt=(item.attempt??1)+1;
        }
        await currentSource(c,user,id,item.manifest.source);
        const latest=(await c.query('SELECT latest_version_id FROM bb_project_files WHERE owner_user_id=$1 AND id=$2',[user,item.manifest.file_id])).rows[0];
        if(latest?.latest_version_id!==item.manifest.expected_current_version_id)throw conflict('INPUT_REVISION_CONFLICT','文件已有新版本，请重新检查。');
        item.error=null;remaining++;
      }
      await requireFileUpdateCredits(c,user,remaining*PROJECT_FILE_UPDATE_PRICE.points);
      await c.query("UPDATE bb_project_file_update_batches SET state='queued',items=$2,updated_at=now() WHERE id=$1",[batchId,JSON.stringify(items)]);
      await event(c,user,id,'project.file_updates_retried',{batch_id:batchId});
    });return {ok:true};
  });
  app.post(base+'/updates/:run_id/cancel',async r=>{const user=await owner(r),{project_id:id,run_id:batchId}=params(r);
    await transaction(db(),async c=>{await project(c,user,id,true);const b=(await c.query('SELECT * FROM bb_project_file_update_batches WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE',[user,id,batchId])).rows[0];if(!b)throw missing();
      await c.query("UPDATE bb_project_file_update_batches SET state='cancelled',updated_at=now() WHERE id=$1",[batchId]);
      await event(c,user,id,'project.file_updates_stopped',{batch_id:batchId});});return {ok:true};
  });
}

