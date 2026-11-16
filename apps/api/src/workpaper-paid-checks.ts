import type {Pool,PoolClient} from 'pg';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {WorkpaperPaidCheckRequestSchema,type WorkpaperPaidCheckRequest,type WorkpaperPaidCheckQuote,type WorkpaperPaidCheckBatch,type ProjectFileOperation} from '@bondbuddy/contracts';
import {project,transaction,uid,conflict,missing,Problem,date,assertCanonicalBusinessRunIdle} from './data.js';
import {inputManifestHash} from './production-rule-pin.js';
import {projectFileSource,workpaperFileVersions,readProjectFileAsset} from './project-file-storage.js';
import {fileCheckPrice,requireFileUpdateCredits} from './project-file-billing.js';
import {createBatchedFileCheck} from './project-file-consistency.js';
import {assertScopeQuote} from './scope-quotations.js';
import {automaticBillingEnabled} from './automatic-billing-context.js';
import {resolveAutomaticTaskPriceVersion} from './automatic-price-versions.js';
type Db=Pool|PoolClient;
const terminal=['succeeded','failed','cancelled','rejected','test_completed'];
type Check=Extract<ProjectFileOperation,{operation:'check'}>;

async function prepare(c:PoolClient,owner:string,id:string,b:WorkpaperPaidCheckRequest){
  if(!automaticBillingEnabled(c))throw new Problem(409,'BILLING_NOT_READY','逐份计费检查尚未启用。');
  const p=await project(c,owner,id,true);if(p.archived_at)throw conflict('INPUT_REVISION_CONFLICT','请先恢复项目。');
  const batch=(await c.query('SELECT * FROM bb_workpaper_batches WHERE owner_user_id=$1 AND project_id=$2 AND id=$3',[owner,id,b.workpaper_batch_id])).rows[0];if(!batch)throw missing();
  const source=await projectFileSource(c,owner,id);
  if(!source||source.version_id!==b.source_version_id||source.selection_revision!==b.source_selection_revision)throw conflict('INPUT_REVISION_CONFLICT','募集说明书已变化，请刷新检查范围。');
  const versions=await workpaperFileVersions(c,owner,id),rows=(await c.query('SELECT item_id,manifest FROM bb_workpaper_items WHERE owner_user_id=$1 AND batch_id=$2 ORDER BY ordinal',[owner,b.workpaper_batch_id])).rows;
  const items:{item_id:string;manifest:Check;price:Awaited<ReturnType<typeof fileCheckPrice>>}[]=[],excluded:WorkpaperPaidCheckQuote['excluded']=[];
  for(const row of rows){
    const file=versions.get(b.workpaper_batch_id+':'+row.item_id)?.current;
    if(!file||!file.latest){excluded.push({item_id:row.item_id,filename:row.manifest.input.workpaper.entry.path.split('/').at(-1),reason:file?'已有其他批次新版本，请在最新底稿中检查。':'尚无可独立检查的已交付 Word 版本。'});continue;}
    if(b.file_version_ids&&!b.file_version_ids.includes(file.version_id))continue;
    await readProjectFileAsset(c,owner,file.asset);
    const manifest:Check={version:'project-file-operation-v1',operation:'check',source,files:[{file_id:file.file_id,file_version_id:file.version_id,filename:file.filename,sequence:file.sequence,asset:file.asset,links:file.links}]};
    items.push({item_id:row.item_id,manifest,price:await fileCheckPrice(c,owner,manifest,id)});
  }
  if(b.file_version_ids&&(items.length!==b.file_version_ids.length||new Set(b.file_version_ids).size!==b.file_version_ids.length))throw conflict('INPUT_REVISION_CONFLICT','所选底稿已换版或无法独立交付，请重新查看范围。');
  if(!items.length)throw new Problem(422,'INPUT_REQUIRED','本次没有可独立检查的已交付底稿 Word 文件。');
  // The parent is a new automatic instruction; a zero-cost legacy child still
  // preserves its historical terms instead of blocking unrelated new children.
  const points=items.reduce((n,i)=>n+i.price.points,0),version=await resolveAutomaticTaskPriceVersion(c,owner);
  return {p,source,items,excluded,points,version};
}
export async function readWorkpaperPaidChecks(db:Db,owner:string,id:string,batchId?:string):Promise<WorkpaperPaidCheckBatch[]>{
  await project(db,owner,id);
  const rows=(await db.query(`SELECT * FROM bb_workpaper_paid_check_batches WHERE owner_user_id=$1 AND project_id=$2
    AND ($3::text IS NULL OR id=$3) ORDER BY created_at DESC,id DESC LIMIT 30`,[owner,id,batchId??null])).rows;
  const items=(await db.query(`SELECT i.*,r.state,v.filename,res.charged_points,res.state AS reservation_state FROM bb_workpaper_paid_check_items i
    JOIN bb_runs r ON r.owner_user_id=i.owner_user_id AND r.id=i.run_id
    JOIN bb_project_file_versions v ON v.owner_user_id=i.owner_user_id AND v.id=i.file_version_id
    LEFT JOIN bb_credit_reservations res ON res.owner_user_id=i.owner_user_id AND res.run_id=i.run_id
    WHERE i.owner_user_id=$1 AND i.batch_id=ANY($2::text[]) ORDER BY i.ordinal`,[owner,rows.map(r=>r.id)])).rows;
  return rows.map(b=>{
    const list=items.filter(i=>i.batch_id===b.id),done=list.every(i=>terminal.includes(i.state)),succeeded=list.filter(i=>i.state==='succeeded').length;
    return {batch_id:b.id,workpaper_batch_id:b.workpaper_batch_id,created_at:date(b.created_at),source:b.source,points:Number(b.points),state:done?succeeded===list.length?'complete':succeeded?'partial':'failed':list.every(i=>i.state==='queued')?'queued':'running',
      items:list.map(i=>({item_id:i.item_id,file_version_id:i.file_version_id,filename:i.filename,run_id:i.run_id,state:i.state,points:Number(i.points),charged_points:i.reservation_state==='settled'?Number(i.charged_points??0):0,scope_quote_id:i.scope_quote_id}))};
  });
}
export function registerWorkpaperPaidChecks(app:FastifyInstance,db:()=>Pool,owner:(r:FastifyRequest)=>Promise<string>){
  const base='/api/v1/projects/:project_id/workpapers/check-batches';
  const projectId=(r:FastifyRequest)=>(r.params as {project_id:string}).project_id;
  app.post(base+'/quote',{schema:{body:WorkpaperPaidCheckRequestSchema}},async r=>transaction(db(),async c=>{
    const prepared=await prepare(c,await owner(r),projectId(r),r.body as WorkpaperPaidCheckRequest);
    return {points:prepared.points,price_version:prepared.version,auto_charge:true,source:prepared.source,excluded:prepared.excluded,items:prepared.items.map(i=>({item_id:i.item_id,file_version_id:i.manifest.files[0].file_version_id,filename:i.manifest.files[0].filename,...i.price,auto_charge:true}))} satisfies WorkpaperPaidCheckQuote;
  }));
  app.post(base,{schema:{body:WorkpaperPaidCheckRequestSchema}},async r=>{
    const user=await owner(r),id=projectId(r),b=r.body as WorkpaperPaidCheckRequest;
    const batch=await transaction(db(),async c=>{
      await project(c,user,id,true);const hash=inputManifestHash({project_id:id,...b});
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[user+':workpaper-paid-check:'+b.request_id]);
      const old=(await c.query('SELECT * FROM bb_workpaper_paid_check_batches WHERE owner_user_id=$1 AND request_id=$2',[user,b.request_id])).rows[0];
      if(old){if(old.request_hash.trim()!==hash)throw conflict('IDEMPOTENCY_CONFLICT','此检查请求已用于其他范围。');return old.id;}
      const prepared=await prepare(c,user,id,b);
      if(!b.file_version_ids||b.expected_points!==prepared.points||b.price_version!==prepared.version)throw conflict('QUOTE_CHANGED','检查范围和价格已变化，请刷新。');
      for(const item of prepared.items)if(item.price.scope_quote_id)await assertScopeQuote(c,b.scopes?.find(s=>s.file_version_id===item.manifest.files[0].file_version_id)?.scope_quote_id,user,id,'project_file_check',item.price.scope_hash,item.price.points);
      await assertCanonicalBusinessRunIdle(c,user,prepared.p);
      if((await c.query('SELECT 1 FROM bb_runs WHERE owner_user_id=$1 AND project_id=$2 AND task_kind<>\'qa\' AND NOT(state=ANY($3::text[])) AND NOT bb_is_integrity_input(owner_user_id,project_id,input_revision)',[user,id,terminal])).rowCount)throw conflict('PROJECT_RUN_ACTIVE','项目仍有任务执行中，请完成后再检查。');
      // Check the exact entire obligation before creating any child or freezing a lot.
      await requireFileUpdateCredits(c,user,prepared.points,true);
      const batchId=uid();await c.query(`INSERT INTO bb_workpaper_paid_check_batches(id,owner_user_id,project_id,workpaper_batch_id,request_id,request_hash,source,points) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[batchId,user,id,b.workpaper_batch_id,b.request_id,hash,prepared.source,prepared.points]);
      for(const [ordinal,item] of prepared.items.entries()){
        const runId=uid();await c.query(`INSERT INTO bb_workpaper_paid_check_items(owner_user_id,batch_id,ordinal,item_id,file_version_id,run_id,scope_quote_id,points) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[user,batchId,ordinal,item.item_id,item.manifest.files[0].file_version_id,runId,item.price.scope_quote_id??null,item.price.points]);
        await createBatchedFileCheck(c,user,id,runId,item.manifest);
      }
      return batchId;
    });return (await readWorkpaperPaidChecks(db(),user,id,batch))[0];
  });
  app.get(base,async r=>({batches:await readWorkpaperPaidChecks(db(),await owner(r),projectId(r))}));
  app.get(base+'/:batch_id',async r=>{const rows=await readWorkpaperPaidChecks(db(),await owner(r),projectId(r),(r.params as {batch_id:string}).batch_id);if(!rows.length)throw missing();return rows[0];});
}
