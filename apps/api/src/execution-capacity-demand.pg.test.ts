import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {WORKPAPER_PRICE,billingWireRoute,encodeBillingDto,type WorkpaperBatch} from '@bondbuddy/contracts';
import {createServer} from './server.js';
import {digest,transaction,type PrivateBlobs} from './data.js';
import {grantCredits} from './billing.js';
import {inputManifestHash} from './production-rule-pin.js';
import {makeSyntheticDocxFixture} from './docx-fixtures.js';
import {headerlessCatalogueXlsx} from './workpaper-catalogue-fixture.js';
import {advanceWorkpaperBatch} from './workpapers.js';
import {executionCapacitySnapshot} from './execution-capacity.js';
import {isolatedTestDatabase} from './test-database.js';
const connection=await isolatedTestDatabase(undefined,'execution-demand');
// Real API-frozen 250-item catalogue, real admission and PG metrics. Blob bytes
// are task-local synthetic memory fixtures; no supplier or cloud API is called.
test('frozen 250-entry batch exposes only its runnable authors and four-item window',{skip:!connection,timeout:30000},async t=>{
 const pool=new Pool({connectionString:connection}),owner=randomUUID(),origin='http://bondbuddy.test';
 const objects=new Map<string,Buffer>();const blobs:PrivateBlobs={put:async(k,b)=>{objects.set(k,Buffer.from(b));},get:async k=>objects.get(k)!,getIfExists:async k=>objects.get(k)??null,getIfExistsBounded:async(k,max)=>{const b=objects.get(k);return b&&b.length<=max?b:null;},exists:async k=>objects.has(k),delete:async k=>{objects.delete(k);}};
 const app=createServer({pool,blobs,historicalBillingFixture:true,enableRunRuntime:true,allowedOrigin:origin,principal:async()=>({userId:owner,csrfVerified:true})});
 t.after(async()=>{await app.close();await pool.end();});
 const send=async(method:string,path:string,body?:unknown)=>{const family=billingWireRoute(method,path);return app.inject({method:method as any,url:path,payload:(family?.request&&body!==undefined?encodeBillingDto(family.request,body):body) as any,headers:{origin,...(Buffer.isBuffer(body)?{'content-type':'application/octet-stream'}:{})}});};
 const ok=async(method:string,path:string,body?:unknown)=>{const r=await send(method,path,body);assert.ok(r.statusCode<300,`${r.statusCode}: ${r.body}`);return r.json();};
 await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,'demand_'+owner.slice(0,8)]);
 await transaction(pool,c=>grantCredits(c,{owner,source:'purchase',key:randomUUID(),points:10000000,expiresAt:null,actor:'synthetic',reason:'isolated capacity admission test'}));
 const project=(await ok('POST','/api/v1/projects',{kind:'generation',name:'Synthetic demand',issuer_name:'Synthetic issuer',market:'sse',offering:'private'})).project_id,path='/api/v1/projects/'+project,base=path+'/workpapers';
 const upload=async(filename:string,bytes:Buffer,media_type:string,role='other')=>{const declared={byte_size:bytes.length,sha256:digest(bytes)},u=await ok('POST',path+'/materials/uploads',{...declared,filename,media_type,role});assert.equal((await send('PUT',u.upload_url,bytes)).statusCode,204);const m=await ok('POST',path+`/materials/uploads/${u.upload_id}/complete`,declared);return {source_project_id:project,material_id:m.material_id,material_version:m.material_version,sha256:m.sha256};};
 await upload('source.docx',makeSyntheticDocxFixture({text:'合成募集书：总资产100万元。'}),'application/vnd.openxmlformats-officedocument.wordprocessingml.document','historical');
 const versions=await ok('GET',path+'/prospectus-versions'),selection=await ok('POST',path+'/prospectus-versions/current',{request_id:randomUUID(),expected_selection_revision:0,version_id:versions.versions[0].version_id});
 const rows=[['编号','文件名称','分类'],...Array.from({length:250},(_,i)=>['x'+i,'合成核查'+i,'本册'])];
 const material=await upload('catalogue.xlsx',await headerlessCatalogueXlsx(rows),'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),cat=await ok('POST',base+'/catalogues',{request_id:randomUUID(),material});
 const request={request_id:randomUUID(),start_mode:'direct',catalogue_id:cat.catalogue_id,catalogue_sha256:cat.sha256,item_ids:cat.entries.filter((e:any)=>e.kind==='file').map((e:any)=>e.id),source_version_id:selection.current_version_id,source_selection_revision:selection.selection_revision,requirements:'保留全量证据。',expected_points:250*WORKPAPER_PRICE.points,price_version:WORKPAPER_PRICE.version};
 const batch=await ok('POST',base+'/batches',request) as WorkpaperBatch;assert.equal(batch.items.length,250);
 for(let n=0;n<4;n++)await advanceWorkpaperBatch(pool);
 assert.equal((await pool.query('SELECT count(*)::int n FROM bb_workpaper_items WHERE batch_id=$1 AND run_id IS NOT NULL',[batch.batch_id])).rows[0].n,4);
 const cold=await executionCapacitySnapshot(pool);assert.equal(cold.effective_queued_work,1);assert.equal(cold.excluded.shared_plan_waiter,3);assert.equal(cold.oldest_wait_seconds,0);
 const items=(await pool.query('SELECT * FROM bb_workpaper_items WHERE batch_id=$1 ORDER BY ordinal',[batch.batch_id])).rows;
 const source={synthetic:true},sourceHash=inputManifestHash(source),batchHash=inputManifestHash({version:'workpaper-shared-v1',manifests:items.map(i=>i.manifest)});
 await pool.query('INSERT INTO bb_workpaper_shared_sources(owner_user_id,batch_id,input_hash,snapshot,snapshot_hash) VALUES($1,$2,$3,$4,$5)',[owner,batch.batch_id,batchHash,source,sourceHash]);
 const grouped=await executionCapacitySnapshot(pool);assert.equal(grouped.effective_queued_work,4);assert.equal(grouped.groups.find(g=>g.capability==='authoring')?.effective_queued_work,4);assert.equal(grouped.excluded.shared_plan_waiter,0);
 assert.equal((await pool.query('SELECT count(*)::int n FROM bb_execution_work_readiness')).rows[0].n,4);
 // Submission age is not hardware wait. A business pause removes observations;
 // reopening starts a fresh eligibility observation instead of a 100-day wait.
 const runId=items.find(i=>i.run_id)!.run_id;
 await pool.query("UPDATE bb_jobs SET state='paused' WHERE run_id=$1",[runId]);
 const paused=await executionCapacitySnapshot(pool);assert.equal(paused.effective_queued_work,3);assert.equal(paused.excluded.paused,1);
 await pool.query("UPDATE bb_jobs SET state='queued',created_at=now()-interval '100 days' WHERE run_id=$1",[runId]);
 const reopened=await executionCapacitySnapshot(pool);assert.equal(reopened.effective_queued_work,4);assert.ok((reopened.oldest_wait_seconds??0)<5);
 const attempt=randomUUID();await pool.query("INSERT INTO bb_model_call_attempts(id,owner_user_id,job_id,logical_call_id,attempt_no,status) SELECT $1,owner_user_id,id,'synthetic-unknown',1,'pending_reconcile' FROM bb_jobs WHERE run_id=$2",[attempt,runId]);
 const unknown=await executionCapacitySnapshot(pool);assert.equal(unknown.effective_queued_work,3);assert.equal(unknown.excluded.unknown_call,1);
 await pool.query("UPDATE bb_workpaper_batches SET state='paused',progressive_phase=NULL WHERE id=$1",[batch.batch_id]);
 assert.equal((await executionCapacitySnapshot(pool)).effective_queued_work,0);
 // Snapshot did not add runs or mutate frozen membership.
 assert.equal((await pool.query('SELECT count(*)::int n FROM bb_workpaper_items WHERE batch_id=$1 AND run_id IS NOT NULL',[batch.batch_id])).rows[0].n,4);
 assert.equal(inputManifestHash((await pool.query('SELECT manifest FROM bb_workpaper_items WHERE batch_id=$1 ORDER BY ordinal',[batch.batch_id])).rows.map(i=>i.manifest)),inputManifestHash(items.map(i=>i.manifest)));
});
