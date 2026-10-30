// Synthetic proposals, actual Word extraction/delivery, real HTTP/PG admission.
// No model supplier or payment channel is called.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Pool} from 'pg';
import {createServer} from '@bondbuddy/api';
import {BILLING_WIRE_HEADER,BILLING_WIRE_VERSION,AUTOMATIC_TASK_TARIFF,type FileCheckBatch,type FileCheckBatchCreate,type FileCheckBatchRetry} from '@bondbuddy/contracts';
import {digest,transaction,type PrivateBlobs} from '@bondbuddy/api/data';
import {creditBalanceExact,grantCredits} from '../../api/dist/billing.js';
import {makeSyntheticDocxFixture} from '../../api/dist/docx-fixtures.js';
import {isolatedTestDatabase} from './test-database.js';
import {inputLockStage,materialsReadyStage,runPipelineOnce,type codexModelStage} from './run-pipeline.js';
import {projectFileModelStage,projectFileDeliveryStage} from './project-file-stage.js';

const database=await isolatedTestDatabase(undefined,'ordinary-file-check-batches');
test('ordinary file batches settle independent outputs, retain original price on failed-only retries and isolate requests',{skip:!database,timeout:180000},async t=>{
  const pool=new Pool({connectionString:database}),owner=randomUUID(),outsider=randomUUID(),origin='https://synthetic-file-batches.invalid',store=new Map<string,Buffer>();let currentUser=owner;
  const blobs:PrivateBlobs={put:async(k,b)=>{store.set(k,Buffer.from(b));},get:async k=>{const b=store.get(k);assert.ok(b);return b;},getIfExists:async k=>store.get(k)??null,
    getIfExistsBounded:async(k,n)=>{const b=store.get(k);if(b&&b.length>n)throw Error('too large');return b??null;},exists:async k=>store.has(k),delete:async k=>{store.delete(k);}};
  const app=createServer({pool,blobs,allowedOrigin:origin,enableRunRuntime:true,enableSubscriptionBilling:true,enableOutcomePricing:true,principal:async()=>({userId:currentUser,csrfVerified:true})});
  const send=(method:string,url:string,payload?:any,headers:Record<string,string>={})=>app.inject({method:method as any,url,payload,headers:{origin,...headers,...(Buffer.isBuffer(payload)?{'content-type':'application/octet-stream'}:{})}});
  const ok=async(method:string,url:string,payload?:any)=>{const r=await send(method,url,payload);assert.ok(r.statusCode<300,`${r.statusCode} ${r.body}`);return r.json();};
  const docx='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  const upload=async(base:string,project:string,name:string,text:string,role='other')=>{
    const bytes=makeSyntheticDocxFixture({text}),declaration={byte_size:bytes.length,sha256:digest(bytes)},u=await ok('POST',base+'/materials/uploads',{...declaration,filename:name,media_type:docx,role});
    assert.equal((await send('PUT',u.upload_url,bytes)).statusCode,204);const m=await ok('POST',base+'/materials/uploads/'+u.upload_id+'/complete',declaration);
    return {source_project_id:project,material_id:m.material_id,material_version:m.material_version,sha256:m.sha256};
  };
  const fund=(points:number)=>transaction(pool,c=>grantCredits(c,{owner,source:'purchase',key:randomUUID(),points,expiresAt:null,actor:'synthetic',reason:'Synthetic batch verification'}));
  let failSecond=true;const calls=new Map<string,number>();
  const model:typeof codexModelStage=options=>({name:options.name,run:async()=>{
    const version=options.logicalCallId.slice('file-check-'.length);calls.set(version,(calls.get(version)??0)+1);
    const dir=await mkdtemp(join(tmpdir(),'bb-synthetic-ordinary-batch-'));
    try{await options.fileWorkspace!.prepare(dir);const source=JSON.parse(await readFile(join(dir,'source-spans.json'),'utf8')),target=JSON.parse(await readFile(join(dir,'target-spans.json'),'utf8'));
      const sp=source.spans.find((p:any)=>p.text.includes('合成发行人')),tp=target.spans.find((p:any)=>p.text.includes('合成发行人'));
      if(failSecond&&tp.text.includes('文件二'))return{kind:'fail',code:'FILE_CHECK_INCOMPLETE'};
      await writeFile(join(dir,'output/check.json'),JSON.stringify({coverage:'Synthetic complete whole-file coverage',checked_span_ids:target.spans.filter((p:any)=>p.text.trim()).map((p:any)=>p.id),findings:[],links:[{source_span_id:sp.id,source_quote:'合成发行人',target_span_id:tp.id,target_quote:'合成发行人',field:'主体',period:'',unit:''}]}));
      return{kind:'done',value:await options.fileWorkspace!.collect(dir,{} as any,{text:'Synthetic proposal, no supplier'})};
    }finally{await rm(dir,{recursive:true,force:true});}
  }});
  const execute=()=>runPipelineOnce({pool,blobs,runKinds:['generation'],leaseSeconds:120,stages:[inputLockStage,materialsReadyStage,projectFileModelStage({model}),projectFileDeliveryStage()],onUnexpectedError:e=>assert.fail(JSON.stringify(e))});
  try{
    for(const id of [owner,outsider])await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[id,'file_batch_'+id.slice(0,8)]);
    const p=await ok('POST','/api/v1/projects',{kind:'generation',name:'Synthetic independent file batch',issuer_name:'Synthetic issuer',market:'sse',offering:'private'}),base='/api/v1/projects/'+p.project_id,files=base+'/project-files',url=files+'/check-batches';
    await upload(base,p.project_id,'source.docx','合成发行人总资产100万元。','historical');
    const versions=await ok('GET',base+'/prospectus-versions'),source=await ok('POST',base+'/prospectus-versions/current',{request_id:randomUUID(),expected_selection_revision:0,version_id:versions.versions[0].version_id});
    const ids:string[]=[];
    for(const [type,name] of [['init','文件一'],['application','文件二']]){const material=await upload(base,p.project_id,name+'.docx','合成发行人总资产100万元。'+name);const imported=await ok('POST',files+'/imports',{request_id:randomUUID(),document_type:type,material,expected_latest_version_id:null});ids.push(imported.files.find((f:any)=>f.latest&&f.document_type===type).version_id);}
    const selection={request_id:randomUUID(),expected_source_version_id:source.current_version_id,expected_source_selection_revision:source.selection_revision,file_version_ids:ids};
    const quote=await ok('POST',url+'/quote',selection),each=AUTOMATIC_TASK_TARIFF.check.points,total=2*each;
    assert.equal(quote.points,String(total));assert.deepEqual(quote.items.map((i:any)=>i.points),[String(each),String(each)]);
    assert.deepEqual(quote.price_versions,[...new Set(quote.items.map((i:any)=>i.price_version))]);assert.equal(quote.price_version,quote.items[0].price_version);
    const request:FileCheckBatchCreate={...selection,expected_points:quote.points,price_version:quote.price_version,scopes:quote.items.map((i:any)=>({file_version_id:i.file_version_id,scope_quote_id:i.scope_quote_id}))};
    let batch:FileCheckBatch;
    await t.test('native strings are required before AJV coercion and insufficient total funds leave no children or holds',async()=>{
      for(const headers of [{},{[BILLING_WIRE_HEADER]:BILLING_WIRE_VERSION}] as Record<string,string>[])assert.equal((await send('POST',url,{...request,expected_points:total},headers)).statusCode,422);
      assert.equal((await send('POST',url,request,{[BILLING_WIRE_HEADER]:'number-v1'})).statusCode,422);
      const oversized=Array.from({length:101},(_,i)=>'oversized-'+i);
      assert.equal((await send('POST',url+'/quote',{...selection,file_version_ids:oversized})).statusCode,422);
      assert.equal((await send('POST',url,{...request,file_version_ids:oversized,scopes:oversized.map(file_version_id=>({file_version_id,scope_quote_id:null}))})).statusCode,422);
      await fund(total-1);assert.equal((await send('POST',url,request)).statusCode,402);
      for(const table of ['bb_project_file_check_batches','bb_project_file_check_attempts','bb_credit_reservations'])assert.equal((await pool.query(`SELECT count(*)::int n FROM ${table} WHERE owner_user_id=$1`,[owner])).rows[0].n,0);
      assert.deepEqual(await creditBalanceExact(pool,owner),{available:BigInt(total-1),frozen:0n});
    });
    await t.test('concurrent original requests freeze the full obligation once in independent children',async()=>{
      await fund(1);const [a,b]=await Promise.all([ok('POST',url,request),ok('POST',url,request)]);assert.deepEqual(a,b);batch=a;
      assert.equal(batch.items.length,2);assert.equal(new Set(batch.items.map(i=>i.run_id)).size,2);assert.deepEqual(await creditBalanceExact(pool,owner),{available:0n,frozen:BigInt(total)});
      assert.deepEqual(batch.items.map(i=>i.price_version),quote.items.map((i:any)=>i.price_version));assert.deepEqual(batch.price_versions,quote.price_versions);
      assert.equal((await send('POST',url,{...request,file_version_ids:[ids[0]]})).statusCode,409);
      await assert.rejects(pool.query('UPDATE bb_project_file_check_batch_items SET points=points+1 WHERE batch_id=$1',[batch.batch_id]),/immutable|change|snapshot/i);
    });
    await t.test('one successful Word is delivered and billed even when another file fails',async()=>{
      assert.equal(await execute(),'succeeded');assert.equal(await execute(),'failed');batch=await ok('GET',url+'/'+batch.batch_id);
      assert.equal(batch.state,'partial');assert.equal(batch.charged_points,String(each));assert.equal(batch.items[0].charged_points,String(each));assert.equal(batch.items[1].charged_points,'0');
      assert.deepEqual(await creditBalanceExact(pool,owner),{available:BigInt(each),frozen:0n});
      const run=await ok('GET','/api/v1/runs/'+batch.items[0].run_id),artifact=await ok('GET','/api/v1/artifacts/'+run.artifact_id);assert.equal((await send('GET',artifact.download_url)).statusCode,200);
      const failed=(await pool.query('SELECT state,charged_points FROM bb_credit_reservations WHERE run_id=$1',[batch.items[1].run_id])).rows[0];assert.deepEqual(failed,{state:'released',charged_points:'0'});
      assert.equal(calls.get(ids[0]),1);assert.equal(calls.get(ids[1]),1);
    });
    await t.test('failed-only retry and same-owner second-project create share safe lock order; original successful work is never rerun',async()=>{
      currentUser=outsider;assert.equal((await send('GET',url+'/'+batch.batch_id)).statusCode,404);currentUser=owner;
      const first=batch.items[0].run_id,failed=batch.items[1].run_id;
      const retry:FileCheckBatchRetry={request_id:randomUUID(),price_version:batch.price_version,expected_points:String(each),expected_attempts:[{file_version_id:ids[1],run_id:failed}]};
      assert.equal((await send('POST',url+'/'+batch.batch_id+'/retry',{...retry,expected_attempts:[{file_version_id:ids[0],run_id:first}]})).statusCode,409);
      await pool.query("UPDATE bb_scope_quotations SET status='expired',closed_at=clock_timestamp(),closure_reason='Synthetic closure after original acceptance' WHERE id=ANY($1::text[])",[batch.items.map(i=>i.scope_quote_id)]);
      const other=await ok('POST','/api/v1/projects',{kind:'generation',name:'Synthetic parallel project',issuer_name:'Synthetic issuer',market:'sse',offering:'private'}),otherBase='/api/v1/projects/'+other.project_id,otherFiles=otherBase+'/project-files',otherUrl=otherFiles+'/check-batches';
      await upload(otherBase,other.project_id,'parallel-source.docx','合成发行人总资产100万元。','historical');
      const otherVersions=await ok('GET',otherBase+'/prospectus-versions'),otherSource=await ok('POST',otherBase+'/prospectus-versions/current',{request_id:randomUUID(),expected_selection_revision:0,version_id:otherVersions.versions[0].version_id});
      const material=await upload(otherBase,other.project_id,'文件三.docx','合成发行人总资产100万元。文件三'),imported=await ok('POST',otherFiles+'/imports',{request_id:randomUUID(),document_type:'init',material,expected_latest_version_id:null}),otherId=imported.files.find((f:any)=>f.latest&&f.document_type==='init').version_id;
      const otherSelection={request_id:randomUUID(),expected_source_version_id:otherSource.current_version_id,expected_source_selection_revision:otherSource.selection_revision,file_version_ids:[otherId]},otherQuote=await ok('POST',otherUrl+'/quote',otherSelection);
      const otherRequest:FileCheckBatchCreate={...otherSelection,expected_points:otherQuote.points,price_version:otherQuote.price_version,scopes:otherQuote.items.map((i:any)=>({file_version_id:i.file_version_id,scope_quote_id:i.scope_quote_id}))};
      await fund(each);
      const [a,b,otherBatch]=await Promise.all([ok('POST',url+'/'+batch.batch_id+'/retry',retry),ok('POST',url+'/'+batch.batch_id+'/retry',retry),ok('POST',otherUrl,otherRequest)]);assert.deepEqual(a,b);batch=a;
      assert.equal(batch.items[0].run_id,first);assert.equal(batch.items[0].attempt,1);assert.notEqual(batch.items[1].run_id,failed);assert.equal(batch.items[1].attempt,2);
      assert.deepEqual(await creditBalanceExact(pool,owner),{available:0n,frozen:BigInt(total)});
      failSecond=false;assert.equal(await execute(),'succeeded');assert.equal(await execute(),'succeeded');batch=await ok('GET',url+'/'+batch.batch_id);assert.equal(batch.state,'complete');assert.equal(batch.charged_points,String(total));
      assert.equal((await ok('GET',otherUrl+'/'+otherBatch.batch_id)).state,'complete');assert.equal(calls.get(otherId),1);assert.deepEqual(batch.price_versions,quote.price_versions);
      assert.equal(calls.get(ids[0]),1);assert.equal(calls.get(ids[1]),2);assert.equal((await ok('POST',url+'/'+batch.batch_id+'/retry',retry)).items[1].run_id,batch.items[1].run_id);
      assert.deepEqual(await creditBalanceExact(pool,owner),{available:0n,frozen:0n});
    });
    await t.test('new zero-price batches reuse exact succeeded outputs without model calls, child attempts or holds',async()=>{
      const oldRuns=batch.items.map(i=>i.run_id),beforeCalls=[...calls],beforeReservations=(await pool.query('SELECT count(*)::int n FROM bb_credit_reservations WHERE owner_user_id=$1',[owner])).rows[0].n;
      for(let repeat=0;repeat<2;repeat++){
        const again={...selection,request_id:randomUUID()},q=await ok('POST',url+'/quote',again);
        assert.equal(q.points,'0');assert.deepEqual(q.items.map((i:any)=>i.reused_run_id),oldRuns);
        const body:FileCheckBatchCreate={...again,expected_points:q.points,price_version:q.price_version,scopes:q.items.map((i:any)=>({file_version_id:i.file_version_id,scope_quote_id:i.scope_quote_id}))};
        const result:FileCheckBatch=await ok('POST',url,body);assert.equal(result.state,'complete');assert.equal(result.charged_points,'0');assert.deepEqual(result.items.map(i=>i.run_id),oldRuns);assert.ok(result.items.every(i=>i.attempt===0&&i.charged_points==='0'&&i.reused_run_id===i.run_id));
        assert.equal((await pool.query('SELECT count(*)::int n FROM bb_project_file_check_attempts WHERE batch_id=$1',[result.batch_id])).rows[0].n,0);
        await assert.rejects(pool.query('INSERT INTO bb_project_file_check_attempts(owner_user_id,batch_id,ordinal,attempt,run_id) VALUES($1,$2,0,1,$3)',[owner,result.batch_id,randomUUID()]),/reused zero-price.*model attempt/i);
        assert.equal(await execute(),'idle');
      }
      assert.deepEqual([...calls],beforeCalls);assert.equal((await pool.query('SELECT count(*)::int n FROM bb_credit_reservations WHERE owner_user_id=$1',[owner])).rows[0].n,beforeReservations);assert.deepEqual(await creditBalanceExact(pool,owner),{available:0n,frozen:0n});
    });
    await t.test('a mixed existing-plus-new batch runs and settles only its new file',async()=>{
      const material=await upload(base,p.project_id,'文件四.docx','合成发行人总资产100万元。文件四'),imported=await ok('POST',files+'/imports',{request_id:randomUUID(),document_type:'issuer',material,expected_latest_version_id:null}),newId=imported.files.find((f:any)=>f.latest&&f.document_type==='issuer').version_id;
      const selectionMixed={...selection,request_id:randomUUID(),file_version_ids:[...ids,newId]},q=await ok('POST',url+'/quote',selectionMixed);
      assert.equal(q.points,String(each));assert.deepEqual(q.items.map((i:any)=>i.points),['0','0',String(each)]);assert.deepEqual(q.items.map((i:any)=>i.reused_run_id),[...batch.items.map(i=>i.run_id),null]);
      await fund(each);const body:FileCheckBatchCreate={...selectionMixed,expected_points:q.points,price_version:q.price_version,scopes:q.items.map((i:any)=>({file_version_id:i.file_version_id,scope_quote_id:i.scope_quote_id}))};
      let result:FileCheckBatch=await ok('POST',url,body);assert.equal(result.state,'running');assert.equal(result.charged_points,'0');assert.equal((await pool.query('SELECT count(*)::int n FROM bb_project_file_check_attempts WHERE batch_id=$1',[result.batch_id])).rows[0].n,1);assert.deepEqual(await creditBalanceExact(pool,owner),{available:0n,frozen:BigInt(each)});
      assert.equal(await execute(),'succeeded');assert.equal(await execute(),'idle');result=await ok('GET',url+'/'+result.batch_id);assert.equal(result.state,'complete');assert.equal(result.charged_points,String(each));assert.deepEqual(result.items.map(i=>i.charged_points),['0','0',String(each)]);assert.equal(calls.get(ids[0]),1);assert.equal(calls.get(ids[1]),2);assert.equal(calls.get(newId),1);assert.deepEqual(await creditBalanceExact(pool,owner),{available:0n,frozen:0n});
    });
    await t.test('zero-price scope without an available exact original output is rejected instead of running free',async()=>{
      const before=(await pool.query('SELECT count(*)::int n FROM bb_project_file_check_batches WHERE owner_user_id=$1',[owner])).rows[0].n;
      await pool.query("UPDATE bb_artifact_versions SET delivery_status='revoked' WHERE owner_user_id=$1 AND run_id=$2",[owner,batch.items[0].run_id]);
      const response=await send('POST',url+'/quote',{...selection,request_id:randomUUID()});assert.equal(response.statusCode,409);assert.equal(response.json().code,'INPUT_REVISION_CONFLICT');assert.equal((await pool.query('SELECT count(*)::int n FROM bb_project_file_check_batches WHERE owner_user_id=$1',[owner])).rows[0].n,before);assert.equal(await execute(),'idle');
    });
  }finally{await app.close();await pool.end();}
});
