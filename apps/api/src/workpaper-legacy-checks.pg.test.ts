import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {AUTOMATIC_PRICE_VERSION,AUTOMATIC_TASK_TARIFF,LEGACY_OUTCOME_PRICE_VERSION,type ProjectFileOperation,type WorkpaperEntry} from '@bondbuddy/contracts';
import {createServer} from './server.js';
import {isolatedTestDatabase} from './test-database.js';
import {grantCredits,creditBalance,lockCreditAccount} from './billing.js';
import {transaction,type PrivateBlobs} from './data.js';
import {auditCredits} from './billing-ops.js';
import {fileCheckFingerprint} from './project-file-billing.js';
import {projectFileSource} from './project-file-storage.js';
import {inputManifestHash} from './production-rule-pin.js';
import {enqueue,claim,promoteWordArtifact,finish} from './queue.js';
import {makeSyntheticDocxFixture} from './docx-fixtures.js';

const database=await isolatedTestDatabase(undefined,'workpaper-legacy-checks'),sha='a'.repeat(64);
const media='application/vnd.openxmlformats-officedocument.wordprocessingml.document',origin='https://synthetic-legacy-check.invalid';

/** Historical material metadata fixture; no claimed model execution or Word quality evidence. */
async function material(pool:Pool,owner:string,project:string,name:string){
  const id=randomUUID(),upload=randomUUID();
  await pool.query("INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state) VALUES($1,$2,$3,$4,$5,1,$6,'other',$1,now()+interval '1 day','completed')",[upload,owner,project,name,media,sha]);
  await pool.query("INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state) VALUES($1,1,$2,$3,$4,'other',$5,$6,1,$7,$1,'persisted')",[id,owner,project,upload,name,media,sha]);
  return {kind:'material' as const,pin:{source_project_id:project,material_id:id,material_version:1,sha256:sha}};
}

test('mixed workpaper batch retains settled v1 check rights at zero and reserves only the new automatic check',
 {skip:!database,timeout:120000},async()=>{
  const pool=new Pool({connectionString:database}),owner=randomUUID();
  const app=createServer({pool,enableSubscriptionBilling:true,enableOutcomePricing:true,paymentProviders:[],allowedOrigin:origin,principal:async()=>({userId:owner,csrfVerified:true})});
  const send=(method:'GET'|'POST',url:string,payload?:any)=>app.inject({method,url,payload,headers:{origin}});
  const ok=async(method:'GET'|'POST',url:string,payload?:any)=>{const r=await send(method,url,payload);assert.ok(r.statusCode<300,r.body);return r.json();};
  try{
    await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,'synthetic_legacy_check_'+owner.slice(0,8)]);
    const project=(await ok('POST','/api/v1/projects',{name:'Synthetic mixed legacy rights',kind:'generation',issuer_name:'Synthetic issuer',market:'sse',offering:'private'})).project_id;
    const topic=(await ok('POST','/api/v1/m4/topics',{creation_request_id:randomUUID(),name:'Synthetic historical workpapers',source_project_id:project})).topic;
    const sourceAsset=await material(pool,owner,project,'Synthetic prospectus.docx'),sourceVersion=randomUUID();
    await pool.query("INSERT INTO bb_prospectus_versions(id,owner_user_id,project_id,sequence,origin,filename,sha256,material_id,material_version) VALUES($1,$2,$3,1,'upload','Synthetic prospectus.docx',$4,$5,1)",[sourceVersion,owner,project,sha,sourceAsset.pin.material_id]);
    await pool.query('INSERT INTO bb_prospectus_selection(owner_user_id,project_id,version_id,revision) VALUES($1,$2,$3,1)',[owner,project,sourceVersion]);
    const source=await projectFileSource(pool,owner,project);assert.ok(source);
    const entries:WorkpaperEntry[]=[0,1].map(n=>({id:'synthetic-item-'+n,code:'1.'+n,title:'Synthetic workpaper '+n,folder:'Synthetic',kind:'file',sheet:'Synthetic',row:n+1,instructions:'Synthetic historical receipt fixture',path:'Synthetic '+n+'.docx'}));
    const catalogue=randomUUID(),batch=randomUUID();
    await pool.query("INSERT INTO bb_workpaper_catalogues(id,owner_user_id,project_id,request_id,request_hash,material,filename,entries,warnings,sha256) VALUES($1,$2,$3,$1,$4,$5,'Synthetic.xlsx',$6,'[]',$4)",[catalogue,owner,project,sha,sourceAsset.pin,JSON.stringify(entries)]);
    await pool.query("INSERT INTO bb_workpaper_batches(id,owner_user_id,project_id,topic_id,catalogue_id,request_id,request_hash,source,state,total_points,price_version,start_mode) VALUES($1,$2,$3,$4,$5,$1,$6,$7,'complete',0,'synthetic-retained-batch','direct')",[batch,owner,project,topic.topic_id,catalogue,sha,source]);
    const files:{file_id:string;file_version_id:string;filename:string;sequence:number;asset:Awaited<ReturnType<typeof material>>;links:[]}[]=[];
    for(const [index,entry] of entries.entries()){
      const asset=await material(pool,owner,project,entry.path),file=randomUUID(),version=randomUUID();
      await pool.query("INSERT INTO bb_workpaper_items(owner_user_id,batch_id,item_id,ordinal,manifest,state) VALUES($1,$2,$3,$4,$5,'succeeded')",[owner,batch,entry.id,index,{input:{document_type:'workpaper',workpaper:{batch_id:batch,catalogue_id:catalogue,entry,mode:'direct'}}}]);
      await pool.query("INSERT INTO bb_project_files(id,owner_user_id,project_id,document_type,identity_key) VALUES($1,$2,$3,'workpaper',$4)",[file,owner,project,'synthetic-retained:'+entry.id]);
      await pool.query('INSERT INTO bb_project_file_versions(id,owner_user_id,file_id,sequence,filename,asset,source_version_id) VALUES($1,$2,$3,1,$4,$5,$6)',[version,owner,file,entry.path,asset,sourceVersion]);
      await pool.query('UPDATE bb_project_files SET latest_version_id=$2 WHERE id=$1',[file,version]);
      await pool.query('INSERT INTO bb_workpaper_file_bindings(owner_user_id,batch_id,item_id,file_id,original_version_id) VALUES($1,$2,$3,$4,$5)',[owner,batch,entry.id,file,version]);
      files.push({file_id:file,file_version_id:version,filename:entry.path,sequence:1,asset,links:[]});
    }
    const newPoints=AUTOMATIC_TASK_TARIFF.check.points,oldPoints=990;
    const lot=await transaction(pool,c=>grantCredits(c,{owner,source:'purchase',key:'synthetic-history-'+batch,points:oldPoints+newPoints,expiresAt:null,actor:'synthetic-fixture',reason:'Synthetic retained v1 payment allocation'}));
    // Explicitly synthetic historical receipt. The original v1 scope is a
    // fixture, but the reservation and Word report use real delivery settlement.
    const manifest:Extract<ProjectFileOperation,{operation:'check'}>={version:'project-file-operation-v1',operation:'check',source,files:[files[0]]};
    const inputHash=inputManifestHash(manifest),snapshot={manifest,charged_file_versions:[files[0].file_version_id],paid_checks:[]},workHash=inputManifestHash(snapshot);
    const run=randomUUID(),scope=randomUUID(),quote=randomUUID(),reservation=randomUUID();
    const lines=[{key:'legacy-check',label:'Synthetic retained v1 check',quantity:1,unit:'file',unit_price_fen:990,amount_fen:990,evidence:['Synthetic historical receipt with settled original credit allocation']}];
    await transaction(pool,async c=>{
      await lockCreditAccount(c,owner);
      await c.query("INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids) VALUES($1,1,$2,1,$3,$4,'[]','[]')",[project,owner,inputHash,manifest]);
      const task=(await c.query("INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state) VALUES($1,$2,$3,1,$4,$1,'generation',$4,'queued') RETURNING *",[run,owner,project,inputHash])).rows[0];
      await c.query("INSERT INTO bb_project_file_operations(run_id,owner_user_id,project_id,operation,manifest,input_hash) VALUES($1,$2,$3,'check',$4,$5)",[run,owner,project,manifest,inputHash]);
      await c.query(`INSERT INTO bb_scope_quotations(id,owner_user_id,project_id,action,input_hash,snapshot,status,lines,amount_fen,approved_by,reason,published_at,expires_at,price_version)
        VALUES($1,$2,$3,'project_file_check',$4,$5,'quoted',$6,990,'synthetic-history','Synthetic immutable retained v1 receipt',now(),now()+interval '1 day',$7)`,[scope,owner,project,workHash,snapshot,JSON.stringify(lines),LEGACY_OUTCOME_PRICE_VERSION]);
      await c.query(`INSERT INTO bb_project_file_check_quotes(id,owner_user_id,project_id,run_id,input_hash,source_fingerprint,file_versions,charged_file_versions,points,price_version,scope_quote_id,scope_lines,scope_work_hash)
        VALUES($1,$2,$3,$4,$5,$6,$7,$7,990,$8,$9,$10,$11)`,[quote,owner,project,run,inputHash,fileCheckFingerprint(manifest),JSON.stringify([files[0].file_version_id]),LEGACY_OUTCOME_PRICE_VERSION,scope,JSON.stringify(lines),workHash]);
      await c.query("INSERT INTO bb_credit_reservations(id,owner_user_id,run_id,quote_id,points,state,billing_policy) VALUES($1,$2,$3,$4,990,'held','on_delivery')",[reservation,owner,run,quote]);
      await c.query('INSERT INTO bb_credit_allocations(reservation_id,lot_id,points) VALUES($1,$2,990)',[reservation,lot]);
      await c.query('UPDATE bb_credit_lots SET frozen=frozen+990 WHERE id=$1',[lot]);
      await c.query(`INSERT INTO bb_credit_events(id,owner_user_id,event_key,kind,points,lot_id,reservation_id,run_id,actor,reason)
        VALUES($1,$2,$3,'reserve',990,$4,$5,$6,'synthetic-history','Synthetic retained v1 receipt')`,[randomUUID(),owner,'reserve:'+reservation,lot,reservation,run]);
      await c.query("UPDATE bb_runs SET billing_mode='fixed_credits',reservation_id=$2 WHERE id=$1",[run,reservation]);
      await enqueue(c,task,'project_file_v1');
    });
    // Synthetic prior check evidence is a declared fixture, not a model-quality
    // result. The database still requires its exact source/target/input binding.
    const result={version:'project-file-check-v1',files:[{file_version_id:files[0].file_version_id,status:'consistent',coverage:'Synthetic historical receipt',findings:[],links:[]}]};
    await pool.query('UPDATE bb_project_file_operations SET result=$2,result_hash=$3 WHERE run_id=$1',[run,result,inputManifestHash(result)]);
    await pool.query(`INSERT INTO bb_workpaper_check_evidence(owner_user_id,run_id,file_version_id,input_hash,source_sha256,target_sha256,checked_spans,total_spans)
      VALUES($1,$2,$3,$4,$5,$6,1,1)`,[owner,run,files[0].file_version_id,inputHash,source.asset.pin.sha256,files[0].asset.pin.sha256]);
    const objects=new Map<string,Buffer>(),blobs:PrivateBlobs={put:async(k,b)=>{objects.set(k,Buffer.from(b));},get:async k=>Buffer.from(objects.get(k)!),getIfExists:async k=>objects.get(k)??null,
      getIfExistsBounded:async(k,max)=>{const b=objects.get(k);if(b&&b.length>max)throw Error('Synthetic artifact bound exceeded');return b??null;},exists:async k=>objects.has(k),delete:async k=>{objects.delete(k);}};
    const lease=await claim(pool);assert.ok(lease);assert.equal(lease.runId,run);
    const reportArtifact=await promoteWordArtifact(pool,lease,makeSyntheticDocxFixture({text:'Synthetic retained v1 check report'}),blobs,'generated_review_v1');
    await finish(pool,lease,'succeeded',{artifactId:reportArtifact.artifactId,artifactVersion:1,blobs});
    assert.deepEqual(await creditBalance(pool,owner),{available:newPoints,frozen:0});
    const original=(await pool.query('SELECT * FROM bb_project_file_check_quotes WHERE id=$1',[quote])).rows[0];
    const path=`/api/v1/projects/${project}/workpapers/check-batches`,request={request_id:randomUUID(),workpaper_batch_id:batch,source_version_id:sourceVersion,source_selection_revision:1};
    const priced=await ok('POST',path+'/quote',request);
    assert.equal(priced.price_version,AUTOMATIC_PRICE_VERSION);assert.equal(priced.points,newPoints);assert.equal(priced.items.length,2);
    const legacy=priced.items.find((i:any)=>i.file_version_id===files[0].file_version_id),fresh=priced.items.find((i:any)=>i.file_version_id===files[1].file_version_id);
    assert.equal(legacy.points,0);assert.equal(legacy.price_version,LEGACY_OUTCOME_PRICE_VERSION);assert.equal(legacy.scope_quote_id,undefined);
    assert.equal(fresh.points,newPoints);assert.equal(fresh.price_version,AUTOMATIC_PRICE_VERSION);assert.ok(fresh.scope_quote_id);
    const start={...request,file_version_ids:files.map(f=>f.file_version_id),price_version:priced.price_version,expected_points:priced.points,
      scopes:priced.items.filter((i:any)=>i.scope_quote_id).map((i:any)=>({file_version_id:i.file_version_id,scope_quote_id:i.scope_quote_id}))};
    const accepted=await ok('POST',path,start),replay=await ok('POST',path,start);assert.equal(replay.batch_id,accepted.batch_id);
    assert.deepEqual(await creditBalance(pool,owner),{available:0,frozen:newPoints});
    const children=(await pool.query(`SELECT q.file_versions,q.points,q.price_version,r.id AS reservation FROM bb_project_file_check_quotes q
      LEFT JOIN bb_credit_reservations r ON r.quote_id=q.id AND r.owner_user_id=q.owner_user_id WHERE q.run_id=ANY($1::text[]) ORDER BY q.points`,[accepted.items.map((i:any)=>i.run_id)])).rows;
    assert.equal(children.length,2);assert.equal(children[0].points,'0');assert.equal(children[0].price_version,LEGACY_OUTCOME_PRICE_VERSION);assert.equal(children[0].reservation,null);
    assert.equal(children[1].points,String(newPoints));assert.ok(children[1].reservation);assert.equal(children[1].price_version,AUTOMATIC_PRICE_VERSION);
    assert.deepEqual((await pool.query('SELECT * FROM bb_project_file_check_quotes WHERE id=$1',[quote])).rows[0],original,'Original paid v1 quote remains unchanged');
    const report=await auditCredits(pool);assert.equal(report.consistent,true,JSON.stringify(report));
  }finally{await app.close();await pool.end();}
});
