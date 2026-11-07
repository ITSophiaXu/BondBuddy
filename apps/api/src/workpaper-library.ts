import type {Pool,PoolClient} from 'pg';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {Static} from '@sinclair/typebox';
import {generationBatchActive,WorkpaperCheckRequestSchema,workpaperDownloadFilename,WORKPAPER_CHECK_UNAVAILABLE,type WorkpaperCheck,type WorkpaperLibrary,type WorkpaperLibraryItem,type WorkpaperChangeInput} from '@bondbuddy/contracts';
import {project,transaction,uid,conflict,missing,Problem,date,assertCanonicalBusinessRunIdle} from './data.js';
import {inputManifestHash} from './production-rule-pin.js';
import {projectFileSource,readProjectFileAsset,workpaperFileVersions} from './project-file-storage.js';
import {enqueue} from './queue.js';
import {automaticBillingEnabled} from './automatic-billing-context.js';
import {registerWorkpaperPaidChecks,readWorkpaperPaidChecks} from './workpaper-paid-checks.js';
type Db=Pool|PoolClient;
export async function readWorkpaperChecks(db:Db,owner:string,id:string):Promise<WorkpaperCheck[]>{
  await project(db,owner,id);const source=await projectFileSource(db,owner,id);
  const rows=(await db.query(`SELECT c.*,r.state FROM bb_workpaper_checks c JOIN bb_runs r ON r.owner_user_id=c.owner_user_id AND r.id=c.run_id
    WHERE c.owner_user_id=$1 AND c.project_id=$2 ORDER BY c.created_at DESC,c.run_id DESC`,[owner,id])).rows;
  return rows.map(r=>{
    if(r.result&&inputManifestHash(r.result)!==r.result_hash.trim())throw new Problem(503,'DATA_UNAVAILABLE','检查记录暂不可核验。');
    return {run_id:r.run_id,batch_id:r.batch_id,state:r.state,source:r.manifest.source,baseline:r.manifest.baseline,created_at:date(r.created_at),
      stale:source?.version_id!==r.manifest.source.version_id||source?.selection_revision!==r.manifest.source.selection_revision,result:r.state==='succeeded'?r.result:null};
  });
}
/** Page across ALL batches, not just the ten most recent tasks. Group by original
 * catalogue identity, never by a shortened filename that might collide. */
export async function readWorkpaperLibrary(db:Db,owner:string,id:string,q:{offset:number;limit:number;search:string;category:string;status:string;history:boolean}):Promise<WorkpaperLibrary>{
  await project(db,owner,id);const source=await projectFileSource(db,owner,id),checks=await readWorkpaperChecks(db,owner,id);
  const automatic=automaticBillingEnabled(db);
  const rows=(await db.query(`WITH ranked AS (
    SELECT i.*,b.project_id,b.created_at,b.source,b.catalogue_id,b.state AS batch_state,w.decision AS output_decision,coalesce(i.explanation,w.explanation) AS delivered_explanation,
      row_number() OVER(PARTITION BY i.manifest->'input'->'workpaper'->'entry'->>'sheet',
        i.manifest->'input'->'workpaper'->'entry'->>'title',i.manifest->'input'->'workpaper'->'entry'->>'path',
        coalesce(nullif(i.manifest->'input'->'workpaper'->'entry'->>'code',''),i.manifest->'input'->'workpaper'->'entry'->>'title') ORDER BY b.created_at DESC,b.id DESC) AS position,
      count(*) OVER(PARTITION BY i.manifest->'input'->'workpaper'->'entry'->>'sheet',
        i.manifest->'input'->'workpaper'->'entry'->>'title',i.manifest->'input'->'workpaper'->'entry'->>'path',
        coalesce(nullif(i.manifest->'input'->'workpaper'->'entry'->>'code',''),i.manifest->'input'->'workpaper'->'entry'->>'title'))::int AS version_count
    FROM bb_workpaper_items i JOIN bb_workpaper_batches b ON b.owner_user_id=i.owner_user_id AND b.id=i.batch_id
    LEFT JOIN bb_runs r ON r.owner_user_id=i.owner_user_id AND r.id=i.run_id
    LEFT JOIN bb_workpaper_item_results w ON w.owner_user_id=i.owner_user_id AND w.run_id=i.run_id AND r.state='succeeded'
    WHERE b.owner_user_id=$1 AND b.project_id=$2
  ) SELECT owner_user_id,batch_id,item_id,ordinal,run_id,attempt,error,state,batch_state,delivered_explanation AS explanation,output_decision,created_at,source,catalogue_id,position,version_count,manifest->'input'->'workpaper' AS task FROM ranked WHERE ($3 OR position=1)
    AND ($4='' OR strpos(lower((manifest->'input'->'workpaper'->'entry')::text),lower($4))>0)
    AND ($5='all' OR ($5='explanation')=(delivered_explanation IS NOT NULL)) ORDER BY created_at DESC,batch_id DESC,ordinal`,[owner,id,q.history,q.search,q.category])).rows;
  // Fetch status/link metadata once. Bytes and complete batch summaries are never
  // loaded for listing. The browser only receives the requested page.
  const runIds=rows.map(r=>r.run_id).filter(Boolean);
  const runRows=(await db.query('SELECT id,state,stage FROM bb_runs WHERE owner_user_id=$1 AND id=ANY($2::text[])',[owner,runIds])).rows;
  const runs=new Map(runRows.map(r=>[r.id,r]));
  const metadata=(await db.query("SELECT run_id,jsonb_array_length(result->'links') AS count FROM bb_project_file_generation_links WHERE owner_user_id=$1 AND run_id=ANY($2::text[])",[owner,runIds])).rows;
  const links=new Map(metadata.map(r=>[r.run_id,Number(r.count)]));
  const fileVersions=await workpaperFileVersions(db,owner,id,false);
  const latestChecks=new Map<string,WorkpaperCheck>();for(const check of checks)if(!latestChecks.has(check.batch_id))latestChecks.set(check.batch_id,check);
  const all:WorkpaperLibraryItem[]=rows.map(r=>{
    const check=latestChecks.get(r.batch_id),run=runs.get(r.run_id),task=r.task,file=fileVersions.get(r.batch_id+':'+r.item_id);
    return {entry:task.entry,decision:r.output_decision??task.decision,...(r.explanation?{explanation:{filename:workpaperDownloadFilename(task.entry,{explanation:true}),sha256:r.explanation.sha256}}:{}),
      run_id:r.run_id,state:run?.state??r.state,stage:run?.stage??null,attempt:r.attempt,error:r.error,artifacts:[],batch_id:r.batch_id,catalogue_id:r.catalogue_id,created_at:date(r.created_at),source:r.source,
      ...(file?{file}:{}),latest:Number(r.position)===1,version_count:r.version_count,links_count:links.get(r.run_id)??0,
      impact:check?.result?.items.find(i=>i.item_id===r.item_id)??null,check_stale:automatic&&file?file.current.consistency.status==='stale':check?check.stale:source?.version_id!==r.source.version_id||source?.selection_revision!==r.source.selection_revision};
  });
  const filtered=all.filter(i=>q.status==='all'||q.status==='stale'&&i.check_stale||q.status==='needs_update'&&!i.check_stale&&(automatic&&i.file?i.file.current.consistency.status==='conflict':i.impact?.status==='needs_update')||q.status==='manual'&&!i.check_stale&&(automatic&&i.file?i.file.current.consistency.status==='manual':i.impact?.status==='manual')||q.status===i.state);
  const items=filtered.slice(q.offset,q.offset+q.limit);
  const counts=items.some(i=>i.file)?(await db.query('SELECT id,jsonb_array_length(links) AS count FROM bb_project_file_versions WHERE owner_user_id=$1 AND id=ANY($2::text[])',[owner,items.flatMap(i=>i.file?[i.file.current.version_id]:[])])).rows:[];
  for(const item of items)if(item.file)item.links_count=Number(counts.find(c=>c.id===item.file!.current.version_id)?.count??0);
  const artifacts=(await db.query(`SELECT a.*,v.sha256,r.project_id FROM bb_m4_artifacts a JOIN bb_runs r ON r.owner_user_id=a.owner_user_id AND r.id=a.run_id AND r.state='succeeded'
    JOIN bb_artifact_versions v ON v.owner_user_id=a.owner_user_id AND v.id=a.artifact_id AND v.version=a.artifact_version
    WHERE a.owner_user_id=$1 AND a.run_id=ANY($2::text[]) AND a.kind='document' AND v.delivery_status='available' AND v.quality_status='passed'`,[owner,items.map(i=>i.run_id).filter(Boolean)])).rows;
  for(const item of items){const current=item.file?.current;item.artifacts=current?.asset.kind==='artifact'?[{kind:'document',filename:workpaperDownloadFilename(item.entry),pin:current.asset.pin}]:artifacts.filter(a=>a.run_id===item.run_id&&!item.explanation).map(a=>({kind:'document',filename:workpaperDownloadFilename(item.entry),pin:{source_project_id:a.project_id,artifact_id:a.artifact_id,artifact_version:a.artifact_version,sha256:a.sha256.trim()}}));}
  const paid_checks=await readWorkpaperPaidChecks(db,owner,id);
  const active=rows.some(r=>['queued','running'].includes(r.batch_state))||generationBatchActive({state:'paused',items:[...runRows.map(r=>({state:r.state,run_id:r.id})),...checks]})||paid_checks.some(generationBatchActive);
  return {items,total:filtered.length,offset:q.offset,limit:q.limit,source,active,checks:checks.slice(0,30).map(c=>({...c,result:null})),paid_checks,check_capability:{enabled:true,reason:'',mode:automatic?'per_file':'legacy'}};
}
export function registerWorkpaperLibrary(app:FastifyInstance,db:()=>Pool,owner:(r:FastifyRequest)=>Promise<string>){
  registerWorkpaperPaidChecks(app,db,owner);
  const base='/api/v1/projects/:project_id/workpapers';
  app.get(base+'/library',async r=>{
    const user=await owner(r),id=(r.params as {project_id:string}).project_id,q=r.query as Record<string,string>;
    const offset=Number(q.offset??0),limit=Number(q.limit??50);
    if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>100||(q.search?.length??0)>300
      ||q.category&&!['all','generated','explanation'].includes(q.category)||q.status&&!['all','stale','manual','needs_update','succeeded','failed','queued','running'].includes(q.status)
      ||q.history&&!['true','false'].includes(q.history))throw new Problem(422,'VALIDATION_FAILED','文件筛选条件无效。');
    return readWorkpaperLibrary(db(),user,id,{offset,limit,search:q.search??'',category:q.category??'all',status:q.status??'all',history:q.history==='true'});
  });
  app.get(base+'/checks',async r=>({checks:await readWorkpaperChecks(db(),await owner(r),(r.params as {project_id:string}).project_id)}));
  app.post(base+'/batches/:batch_id/checks',{schema:{body:WorkpaperCheckRequestSchema}},async r=>{
    const user=await owner(r),{project_id:id,batch_id:batch} =r.params as {project_id:string;batch_id:string},b=r.body as Static<typeof WorkpaperCheckRequestSchema>;
    const requestHash=inputManifestHash({id,batch,...b});
    const runId=await transaction(db(),async c=>{
      const p=await project(c,user,id,true),key='workpaper-change:'+b.request_id;
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[user+':'+key]);
      const old=(await c.query('SELECT id,request_hash FROM bb_runs WHERE owner_user_id=$1 AND execution_request_id=$2',[user,key])).rows[0];
      if(old){if(old.request_hash.trim()!==requestHash)throw conflict('IDEMPOTENCY_CONFLICT','此检查请求已使用。');return old.id;}
      // The old source-diff report has no per-file delivery or paid-scope coverage
      // receipts. Do not silently run it free or charge a full check SKU for it.
      if(automaticBillingEnabled(c))throw new Problem(409,'BILLING_NOT_READY',WORKPAPER_CHECK_UNAVAILABLE);
      if(p.archived_at)throw conflict('INPUT_REVISION_CONFLICT','请先恢复项目。');
      await assertCanonicalBusinessRunIdle(c,user,p);
      const row=(await c.query('SELECT * FROM bb_workpaper_batches WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 FOR UPDATE',[user,id,batch])).rows[0];
      if(!row)throw missing();
      if(!['complete','partial','cancelled'].includes(row.state))throw conflict('PROJECT_RUN_ACTIVE','请待本批底稿完成后检查。');
      if((await c.query(`SELECT 1 FROM bb_workpaper_items i JOIN bb_runs r ON r.id=i.run_id AND r.owner_user_id=i.owner_user_id WHERE i.batch_id=$1 AND r.state NOT IN ('succeeded','failed','cancelled','rejected','test_completed')`,[batch])).rowCount)throw conflict('PROJECT_RUN_ACTIVE','本批仍有文件正在生成。');
      const source=await projectFileSource(c,user,id);
      if(!source||source.version_id!==b.source_version_id||source.selection_revision!==b.source_selection_revision)throw conflict('INPUT_REVISION_CONFLICT','募集说明书已变化，请刷新后检查。');
      await readProjectFileAsset(c,user,row.source.asset);
      const manifest:WorkpaperChangeInput={version:'workpaper-change-v1',batch_id:batch,baseline:row.source,source},hash=inputManifestHash(manifest),run=uid();
      const revision=Number((await c.query('SELECT COALESCE(max(revision),0)+1 n FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2',[user,id])).rows[0].n);
      await c.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids) VALUES($1,$2,$3,$4,$5,$6,'[]','[]')`,[id,revision,user,p.draft_revision,hash,manifest]);
      const runRow=(await c.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state) VALUES($1,$2,$3,$4,$5,$6,'generation',$7,'queued') RETURNING *`,[run,user,id,revision,hash,key,requestHash])).rows[0];
      await c.query('INSERT INTO bb_workpaper_checks(run_id,owner_user_id,project_id,batch_id,manifest,input_hash) VALUES($1,$2,$3,$4,$5,$6)',[run,user,id,batch,manifest,hash]);
      await c.query('UPDATE bb_projects SET latest_input_revision=$3,updated_at=now() WHERE owner_user_id=$1 AND id=$2',[user,id,revision]);
      await enqueue(c,runRow,'workpaper_change_v1');
      await c.query("INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload) VALUES($1,$2,'project',$3,'workpaper.check_started',$4)",[uid(),user,id,{run_id:run,batch_id:batch}]);
      return run;
    });return {run_id:runId};
  });
}
