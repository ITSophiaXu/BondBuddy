// Synthetic PostgreSQL regression for OCR purpose/execution settlement boundaries.
// Real queue claims and OCR batch APIs; no Blob bytes, OCR process or supplier calls.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {Pool} from 'pg';
import type {OcrBatchRequestV2,OcrDocumentIdentityV2} from '@bondbuddy/contracts';
import {digest,transaction} from './data.js';
import {enqueueMaterialParse} from './material-jobs.js';
import {authorizeOcrV2,beginOcrV2Batch,settleInterruptedOcrV2,type OcrV2Scope} from './ocr-v2.js';
import {action,claim,type Lease} from './queue.js';
import {isolatedTestDatabase} from './test-database.js';

const connection=await isolatedTestDatabase(undefined,'ocr-execution-boundary');
type FullScope=Extract<OcrV2Scope,{purpose:'full_ocr'}>;
type Row=Record<string,any>;
type Snapshot=Record<string,Row[]>;
type Execution={lease:Lease;scope:FullScope;batches:OcrBatchRequestV2[]};
type Fixture={owner:string;projectId:string;materialId:string;parseJobId:string;
  document:OcrDocumentIdentityV2;preflight:OcrV2Scope;previous:Execution;current:Execution};

test('OCR interrupted settlement is isolated by purpose and exact execution identity',
  {skip:!connection,timeout:60000},async t=>{
  const pool=new Pool({connectionString:connection,max:4});

  async function startBatch(scope:OcrV2Scope,document:OcrDocumentIdentityV2,page=1){
    const {context}=await authorizeOcrV2(pool,scope,document);
    const request:OcrBatchRequestV2={schema_version:'ocr-request-v2',request_id:randomUUID(),document,context,pages:[page],reuse:[]};
    await beginOcrV2Batch(pool,scope,request);
    return request;
  }

  async function fixture():Promise<Fixture>{
    const owner=randomUUID(),projectId=randomUUID(),materialId=randomUUID(),uploadId=randomUUID();
    const sourceHash=digest('synthetic OCR source identity; no document bytes'),inputHash=digest(`synthetic OCR input ${projectId}`);
    const objectKey=`users/${owner}/projects/${projectId}/materials/${materialId}`;
    await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,`ocr_boundary_${randomUUID().replaceAll('-','').slice(0,16)}`]);
    await pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic OCR execution isolation','update')",[projectId,owner]);
    await pool.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
      VALUES($1,$2,$3,'synthetic.pdf','application/pdf',42,$4,'audit',$5,now()+interval '1 hour','completed')`,
    [uploadId,owner,projectId,sourceHash,objectKey]);
    await pool.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
      VALUES($1,1,$2,$3,$4,'audit','synthetic.pdf','application/pdf',42,$5,$6,'persisted')`,
    [materialId,owner,projectId,uploadId,sourceHash,objectKey]);
    const {jobId:parseJobId}=await transaction(pool,client=>enqueueMaterialParse(client,
      {owner,projectId,materialId,materialVersion:1,sha256:sourceHash,traceId:randomUUID()}));
    // A completed parse job still authorizes an independent, bounded source preflight.
    await pool.query(`UPDATE bb_jobs SET state='succeeded',stage='parsed',result=$2 WHERE id=$1`,
      [parseJobId,{outcome:'parsed',parse_status:'parsed',profile_version:null,pending_capabilities:[]}]);
    await pool.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
      VALUES($1,1,$2,1,$3,'{}',$4,'[]')`,[projectId,owner,inputHash,JSON.stringify([{material_id:materialId,material_version:1}])]);
    const document:OcrDocumentIdentityV2={owner_user_id:owner,project_id:projectId,page_count:3,processor_version:'bondbuddy-ocr-2.0.1',
      material:{material_id:materialId,material_version:1,media_type:'application/pdf',sha256:sourceHash},
      engine:{name:'tesseract',version:'synthetic-only',language:'eng',language_data_sha256:{eng:'a'.repeat(64)},parameters_sha256:'b'.repeat(64)},
      rendering:{renderer:'pdfium',renderer_version:'synthetic-only',dpi:250,max_page_pixels:20_000_000,parameters_sha256:'c'.repeat(64)}};
    const preflight:OcrV2Scope={owner,projectId,materialId,version:1,purpose:'source_preflight'};
    assert.equal((await authorizeOcrV2(pool,preflight,document)).jobId,parseJobId);

    async function execution(pages:number[]):Promise<Execution>{
      const runId=randomUUID(),jobId=randomUUID();
      await pool.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state,stage)
        VALUES($1,$2,$3,1,$4,$5,'update',$6,'queued','queued')`,[runId,owner,projectId,inputHash,randomUUID(),digest(runId)]);
      await pool.query(`INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state,stage)
        VALUES($1,$2,$3,'update','historical_revision','queued','queued')`,[jobId,owner,runId]);
      const lease=await claim(pool,600,{runKinds:['update']});
      assert.ok(lease);assert.equal(lease.runId,runId);assert.equal(lease.jobId,jobId);
      assert.deepEqual({executionVersion:lease.executionVersion,inputRevision:lease.inputRevision,inputHash:lease.inputHash},
        {executionVersion:1,inputRevision:1,inputHash});
      const scope:FullScope={owner,projectId,materialId,version:1,purpose:'full_ocr',runId,leaseToken:lease.token,executionIdentity:lease};
      const batches:OcrBatchRequestV2[]=[];
      for(const page of pages)batches.push(await startBatch(scope,document,page));
      return {lease,scope,batches};
    }
    const previous=await execution([1]);
    // Simulate a durable started batch left by an old worker, then a normal cancellation.
    // The later source-preflight worker has no authority over that cancelled run.
    await action(pool,owner,previous.lease.runId,'cancel');
    const current=await execution([2,3]);
    return {owner,projectId,materialId,parseJobId,document,preflight,previous,current};
  }

  async function snapshot(f:Fixture):Promise<Snapshot>{
    const result:Snapshot={};
    for(const [name,sql] of [
      ['batches','SELECT * FROM bb_ocr_v2_batches WHERE owner_user_id=$1 ORDER BY id'],
      ['pages','SELECT * FROM bb_ocr_v2_pages WHERE owner_user_id=$1 ORDER BY identity_sha256'],
      ['outbox','SELECT * FROM bb_outbox WHERE owner_user_id=$1 ORDER BY id'],
      ['projects','SELECT * FROM bb_projects WHERE owner_user_id=$1 ORDER BY id'],
      ['uploads','SELECT * FROM bb_uploads WHERE owner_user_id=$1 ORDER BY id'],
      ['materials','SELECT * FROM bb_material_versions WHERE owner_user_id=$1 ORDER BY id,version'],
      ['inputs','SELECT * FROM bb_input_revisions WHERE owner_user_id=$1 ORDER BY project_id,revision'],
      ['executions','SELECT * FROM bb_run_execution_versions WHERE owner_user_id=$1 ORDER BY run_id,execution_version'],
      ['runs','SELECT * FROM bb_runs WHERE owner_user_id=$1 ORDER BY id'],
      ['jobs','SELECT * FROM bb_jobs WHERE owner_user_id=$1 ORDER BY id'],
      ['events','SELECT * FROM bb_run_events WHERE owner_user_id=$1 ORDER BY run_id,seq'],
      ['progress','SELECT * FROM bb_authoring_progress WHERE owner_user_id=$1 ORDER BY run_id'],
      ['creditAccounts','SELECT * FROM bb_credit_accounts WHERE owner_user_id=$1'],
      ['creditLots','SELECT * FROM bb_credit_lots WHERE owner_user_id=$1 ORDER BY id'],
      ['creditReservations','SELECT * FROM bb_credit_reservations WHERE owner_user_id=$1 ORDER BY id'],
      ['creditEvents','SELECT * FROM bb_credit_events WHERE owner_user_id=$1 ORDER BY id'],
    ])result[name!]=(await pool.query(sql!,[f.owner])).rows;
    return result;
  }

  function assertOnlySettled(f:Fixture,before:Snapshot,after:Snapshot,requests:OcrBatchRequestV2[],jobId:string,aggregateType:string,aggregateId:string){
    for(const name of Object.keys(before))if(!['batches','outbox'].includes(name))assert.deepEqual(after[name],before[name],`${name} remains exact`);
    const ids=new Set(requests.map(request=>request.request_id));
    assert.equal(after.batches!.length,before.batches!.length);
    for(const row of after.batches!){
      const original=before.batches!.find(batch=>batch.id===row.id);assert.ok(original);
      if(!ids.has(row.id)){assert.deepEqual(row,original,'Every other purpose/run batch remains byte-for-byte exact');continue;}
      assert.equal(original.state,'started');assert.ok(row.finished_at instanceof Date);
      assert.deepEqual(row,{...original,state:'interrupted',finished_at:row.finished_at});
    }
    const oldIds=new Set(before.outbox!.map(row=>row.id));
    assert.deepEqual(after.outbox!.filter(row=>oldIds.has(row.id)),before.outbox!,'Settlement cannot change existing outbox history');
    const added=after.outbox!.filter(row=>!oldIds.has(row.id));
    assert.equal(added.length,requests.length,'Only one failed/unknown platform cost event is appended per selected batch');
    assert.deepEqual(added.map(row=>row.payload.attempt).sort((a,b)=>a-b),requests.map((_,index)=>1001+index));
    for(const cost of added){
      assert.equal(cost.owner_user_id,f.owner);assert.equal(cost.aggregate_type,aggregateType);assert.equal(cost.aggregate_id,aggregateId);
      assert.equal(cost.event_type,'platform.processing_cost');assert.ok(cost.payload.processing_ms>=1);
      assert.deepEqual(cost.payload,{job_id:jobId,material_id:f.materialId,material_version:1,stage:'ocr',attempt:cost.payload.attempt,
        unit:'ocr_page',quantity:null,processing_ms:cost.payload.processing_ms,billable:false,cost_payer:'platform',pricing_status:'unknown',
        unit_price_ref:null,outcome:'failed',ocr_pages:null,ocr_engine:'tesseract',ocr_engine_version:'synthetic-only'});
    }
  }

  try{
    await t.test('source preflight never settles live or cancelled full OCR batches and only settles its own purpose',async()=>{
      const f=await fixture(),before=await snapshot(f);
      assert.equal(before.batches!.length,3);assert.ok(before.batches!.every(row=>row.purpose==='full_ocr'&&row.state==='started'));
      assert.equal(before.outbox!.filter(row=>row.event_type==='platform.processing_cost').length,0);
      await settleInterruptedOcrV2(pool,f.preflight);
      assert.deepEqual(await snapshot(f),before,'A legitimate source-preflight scope cannot mutate any full OCR batch or append a run cost');

      const request=await startBatch(f.preflight,f.document),withPreflight=await snapshot(f);
      await settleInterruptedOcrV2(pool,f.preflight);
      const after=await snapshot(f);
      assertOnlySettled(f,withPreflight,after,[request],f.parseJobId,'material_parse_job',f.parseJobId);
      await settleInterruptedOcrV2(pool,f.preflight);
      assert.deepEqual(await snapshot(f),after,'Repeated preflight settlement appends no duplicate cost or other outbox event');
    });

    await t.test('wrong full OCR identity under the same token is a no-op; valid current identity settles only its own run',async()=>{
      const f=await fixture();await startBatch(f.preflight,f.document);
      const before=await snapshot(f),identity=f.current.scope.executionIdentity;
      const variants:FullScope[]=[
        {...f.current.scope,executionIdentity:{...identity,executionVersion:2}},
        {...f.current.scope,executionIdentity:{...identity,inputRevision:2}},
        {...f.current.scope,executionIdentity:{...identity,inputHash:'d'.repeat(64)}},
        {...f.current.scope,executionIdentity:undefined as unknown as FullScope['executionIdentity']},
      ];
      for(const scope of variants){
        assert.equal(scope.leaseToken,f.current.lease.token,'The live token is unchanged; only execution identity is invalid');
        await assert.rejects(settleInterruptedOcrV2(pool,scope),{status:409,code:'INPUT_REVISION_CONFLICT'});
        assert.deepEqual(await snapshot(f),before,'Rejected identity cannot settle either run or append costs/outbox history');
      }
      await settleInterruptedOcrV2(pool,f.current.scope);
      const after=await snapshot(f);
      assertOnlySettled(f,before,after,f.current.batches,f.current.lease.jobId,'run',f.current.lease.runId);
      const prior=after.batches!.find(row=>row.id===f.previous.batches[0]!.request_id)!;
      assert.equal(prior.state,'started','The old cancelled run batch is not reconciled on behalf of the current run');
      assert.ok(after.batches!.filter(row=>row.purpose==='source_preflight').every(row=>row.state==='started'));
      await settleInterruptedOcrV2(pool,f.current.scope);
      assert.deepEqual(await snapshot(f),after,'Repeated current-run settlement is idempotent and leaves every other batch untouched');
    });
  }finally{await pool.end();}
});
