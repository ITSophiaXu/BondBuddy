import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {emptyUpdateDetails, AUDIT_REPORT_REQUIRED_FIELD_ERROR, INITIAL_FIXED_PRICES} from '@bondbuddy/contracts';
import {createServer} from './server.js';
import {isolatedTestDatabase} from './test-database.js';
import {uploadSyntheticReference} from './test-authoring-source.js';
import {digest, transaction, type PrivateBlobs} from './data.js';
import {inputManifestHash} from './production-rule-pin.js';
import {grantCredits,publishPrices} from './billing.js';

const connection=await isolatedTestDatabase(undefined,'required-audit');
test('audit required across real upload, lock, legacy quotation/submission and replay', {skip:!connection,timeout:120000},async()=>{
  const pool=new Pool({connectionString:connection}),owner=randomUUID(),origin='http://bondbuddy.test',bytes=new Map<string,Buffer>();
  const blobs:PrivateBlobs={put:async(k,b)=>{bytes.set(k,Buffer.from(b));},get:async k=>{const b=bytes.get(k);assert.ok(b);return b;},
    getIfExists:async k=>bytes.get(k)??null,getIfExistsBounded:async(k,n)=>{const b=bytes.get(k);if(b&&b.length>n)throw Error('bound');return b??null;},exists:async k=>bytes.has(k),delete:async k=>{bytes.delete(k);}};
  const app=createServer({pool,blobs,historicalBillingFixture:true,enablePaidAuthoring:true,enableSyntheticQueue:true,allowedOrigin:origin,principal:async()=>({userId:owner,csrfVerified:true})});
  const send=(method:string,url:string,payload?:any,headers:Record<string,string>={})=>app.inject({method:method as any,url,payload,headers:{origin,...headers}});
  const reject=(r:Awaited<ReturnType<typeof send>>)=>{assert.equal(r.statusCode,422,r.body);assert.deepEqual(r.json().field_errors,[AUDIT_REPORT_REQUIRED_FIELD_ERROR]);};
  try{
    await publishPrices(pool,{id:'synthetic-audit-v1',prices:INITIAL_FIXED_PRICES,effectiveAt:'2026-01-01T00:00:00Z',actor:'synthetic',reason:'test only'});
    await pool.query('INSERT INTO bb_users(id,phone_e164) VALUES($1,$2)',[owner,'+8613999911017']);
    await transaction(pool,c=>grantCredits(c,{owner,points:100000,key:randomUUID(),source:'purchase',expiresAt:null,actor:'synthetic',reason:'test only'}));
    const created=await send('POST','/api/v1/projects',{name:'Synthetic required audit',kind:'update',issuer_name:'Synthetic issuer',market:'sse',offering:'private',update_details:{...emptyUpdateDetails(),authoring_mode:'unified_v1',reporting_cutoff:'2026-09-30'}});
    assert.equal(created.statusCode,201,created.body);const id=created.json().project_id,path='/api/v1/projects/'+id;
    const base=await uploadSyntheticReference(app,id);
    const upload=async(role:string,complete=true)=>{
      const content=Buffer.from('Synthetic '+role+' material'),d={byte_size:content.length,sha256:digest(content)};
      const started=await send('POST',path+'/materials/uploads',{...d,filename:role+'.txt',media_type:'text/plain',role});assert.equal(started.statusCode,201,started.body);
      assert.equal((await send('PUT',started.json().upload_url,content,{'content-type':'application/octet-stream'})).statusCode,204);
      if(!complete)return undefined;
      const finished=await send('POST',path+'/materials/uploads/'+started.json().upload_id+'/complete',d);assert.equal(finished.statusCode,200,finished.body);
      return {material_id:finished.json().material_id,material_version:finished.json().material_version};
    };
    const refs=[...base.material_versions];
    const lock=async()=>{
      const current=await send('GET',path);return send('POST',path+'/input-revisions',{...base,draft_revision:current.json().draft_revision,material_versions:refs});
    };
    reject(await lock());
    for(const role of ['financial','interimFinancial','notes']){refs.push((await upload(role))!);reject(await lock());}
    await upload('audit',false);reject(await lock());
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_input_revisions WHERE project_id=$1',[id])).rows[0].n,0);
    const audit=(await upload('audit'))!;reject(await lock());refs.push(audit);
    const locked=await lock();assert.equal(locked.statusCode,201,locked.body);const input=locked.json();
    const quote=await send('POST',path+'/credit-quote',{input_revision:input.input_revision,input_hash:input.input_hash});assert.equal(quote.statusCode,200,quote.body);
    const request={execution_request_id:randomUUID(),project_id:id,input_revision:input.input_revision,input_hash:input.input_hash,task_kind:'update',input_manifest_ref:input.input_hash,storage_origin:'cloud',workspace_id:id,quote_id:quote.json().quote.quote_id};
    const run=await send('POST','/api/v1/runs/execute',request);assert.equal(run.statusCode,202,run.body);
    assert.equal((await send('POST','/api/v1/runs/execute',request)).json().run_id,run.json().run_id,'exact replay retains the same task');
    // Synthetic pre-rule snapshots exercise the admission gate independently of new input locking.
    const original=(await pool.query('SELECT * FROM bb_input_revisions WHERE project_id=$1 AND revision=$2',[id,input.input_revision])).rows[0];
    const snapshot=structuredClone(original.manifest);snapshot.materials=snapshot.materials.filter((m:any)=>m.role!=='audit');
    const oldRefs=snapshot.materials.map((m:any)=>({material_id:m.material_id,material_version:m.material_version})),hash=inputManifestHash(snapshot),revision=input.input_revision+1;
    await pool.query("UPDATE bb_runs SET state='cancelled' WHERE id=$1",[run.json().run_id]);
    await pool.query("INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids) VALUES($1,$2,$3,$4,$5,$6,$7,'[]')",[id,revision,owner,snapshot.draft_revision,hash,snapshot,JSON.stringify(oldRefs)]);
    await pool.query('UPDATE bb_projects SET latest_input_revision=$2 WHERE id=$1',[id,revision]);
    const counts=async()=>Promise.all(['bb_runs','bb_credit_reservations','bb_credit_quotes'].map(async table=>(await pool.query('SELECT count(*)::int n FROM '+table+' WHERE owner_user_id=$1',[owner])).rows[0].n));
    const before=await counts();
    reject(await send('POST',path+'/credit-quote',{input_revision:revision,input_hash:hash}));
    reject(await send('POST','/api/v1/runs/execute',{...request,execution_request_id:randomUUID(),input_revision:revision,input_hash:hash,input_manifest_ref:hash}));
    assert.deepEqual(await counts(),before,'missing audit creates no task, reservation or quotation');
    assert.equal((await send('POST','/api/v1/runs/execute',request)).json().run_id,run.json().run_id,'original replay still succeeds after project input changes');
  }finally{await app.close();await pool.end();}
});
