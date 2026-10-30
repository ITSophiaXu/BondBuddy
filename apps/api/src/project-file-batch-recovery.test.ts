import assert from 'node:assert/strict';
import {test} from 'node:test';
import Fastify from 'fastify';
import type {Pool} from 'pg';
import {ERROR_CODES,type ProjectFileBatch} from '@bondbuddy/contracts';
import {Problem,publicProblem} from './data.js';
import {emptyM4Draft} from './m4-workspace.js';
import {inputManifestHash} from './production-rule-pin.js';
import {registerProjectFileWorkspace} from './project-file-workspace.js';

// Real route/transaction/receipt/source resolution over a strict synthetic SQL fixture.
// app.inject does not open a socket, connect to PostgreSQL or start a worker/model.
const owner='synthetic-owner',projectId='synthetic-project',topicId='synthetic-topic';
const expired='PROJECT_FILE_BATCH_INPUT_EXPIRED',now='2026-10-25T08:00:00Z',sha='a'.repeat(64);
const body={request_id:'synthetic-request',source_version_id:'source-v1',expected_selection_revision:4,
  documents:[{document_type:'issuer' as const,draft_version:2}]};
type Options={receipt?:'accepted'|'other-input';archived?:boolean;sourceId?:string;sourceRevision?:number;
  draftVersion?:number;active?:boolean;missingSource?:boolean;unauthorized?:boolean};
type Call={sql:string;values:unknown[]};

function harness(options:Options={}){
  const calls:Call[]=[];
  const rows=(value:unknown[]=[])=>({rows:value,rowCount:value.length});
  const query=async(sql:string,values:unknown[]=[])=>{
    sql=sql.replace(/\s+/g,' ').trim();calls.push({sql,values});
    if(['BEGIN','COMMIT','ROLLBACK'].includes(sql))return rows();
    if(sql.startsWith('SELECT p.*,i.input_hash')){
      assert.deepEqual(values,[owner,projectId]);
      return rows([{id:projectId,owner_user_id:owner,name:'Synthetic project',kind:'generation',market:'sse',offering:'private',
        issuer_name:'Synthetic issuer',archived_at:options.archived?now:null,execution_scope_project_id:null}]);
    }
    if(sql.startsWith('SELECT t.* FROM bb_project_file_workspaces w JOIN bb_m4_topics t')){
      assert.deepEqual(values,[owner,projectId]);
      return rows([{id:topicId,owner_user_id:owner,project_id:'synthetic-generation-child',source_project_id:projectId}]);
    }
    if(sql==='SELECT * FROM bb_project_file_batches WHERE owner_user_id=$1 AND request_id=$2'){
      assert.deepEqual(values,[owner,body.request_id]);
      return rows(options.receipt?[{id:'accepted-batch',owner_user_id:owner,project_id:projectId,topic_id:topicId,state:'queued',
        request_hash:options.receipt==='accepted'?inputManifestHash({project_id:projectId,...body}):'b'.repeat(64),
        items:[{manifest:{input:{document_type:'issuer'}},run_id:null,attempt:1,error:null}]}]:[]);
    }
    if(sql==='SELECT id,state FROM bb_runs WHERE owner_user_id=$1 AND id=ANY($2::text[])'){
      assert.deepEqual(values,[owner,[]]);return rows();
    }
    if(options.receipt)throw Error('An existing receipt must precede any current source/draft inspection: '+sql);
    if(sql==='SELECT update_project_id FROM bb_update_workspaces WHERE owner_user_id=$1 AND source_project_id=$2'){
      assert.deepEqual(values,[owner,projectId]);return rows();
    }
    if(sql.startsWith('SELECT v.*,s.revision AS selection_revision FROM bb_prospectus_versions v')){
      assert.deepEqual(values,[owner,[projectId],null]);
      return rows(options.missingSource?[]:[{id:options.sourceId??body.source_version_id,project_id:projectId,
        selection_revision:options.sourceRevision??body.expected_selection_revision,sequence:1,filename:'Synthetic prospectus.docx',
        sha256:sha,material_id:'synthetic-source-material',material_version:1}]);
    }
    if(sql==='SELECT * FROM bb_material_versions WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND version=$4 AND deleted_at IS NULL AND NOT internal_template'){
      assert.deepEqual(values,[owner,projectId,'synthetic-source-material',1]);return rows([{sha256:sha}]);
    }
    if(sql==="SELECT 1 FROM bb_project_file_batches WHERE owner_user_id=$1 AND project_id=$2 AND state IN ('queued','running','paused')"){
      assert.deepEqual(values,[owner,projectId]);return rows(options.active?[{}]:[]);
    }
    if(sql==='SELECT version FROM bb_m4_drafts WHERE owner_user_id=$1 AND topic_id=$2 AND document_type=$3'){
      assert.deepEqual(values,[owner,topicId,'issuer']);return rows([{version:options.draftVersion??body.documents[0].draft_version}]);
    }
    if(sql==='SELECT * FROM bb_m4_drafts WHERE owner_user_id=$1 AND topic_id=$2 AND document_type=$3'){
      assert.deepEqual(values,[owner,topicId,'issuer']);return rows([{version:options.draftVersion??body.documents[0].draft_version,
        input:emptyM4Draft('issuer'),sha256:sha,updated_at:now}]);
    }
    throw Error('Unexpected SQL: '+sql);
  };
  const pool={query,connect:async()=>({query,release(){}})} as unknown as Pool;
  const app=Fastify({ajv:{customOptions:{removeAdditional:false,coerceTypes:false}}});
  app.setErrorHandler((error,request,reply)=>{
    if(error instanceof Problem)return reply.code(error.status).send(publicProblem(error,request.id));
    return reply.code(500).send({code:'UNEXPECTED_FIXTURE_ERROR',message:error instanceof Error?error.message:String(error)});
  });
  registerProjectFileWorkspace(app,()=>pool,async()=>{
    if(options.unauthorized)throw new Problem(401,'UNAUTHENTICATED','Synthetic session expired');return owner;
  },()=>{throw Error('This route must not read or write blob storage');});
  const send=()=>app.inject({method:'POST',url:`/api/v1/projects/${projectId}/project-files/batches`,payload:body});
  const assertNoBatchWrite=()=>assert.equal(calls.some(c=>c.sql.startsWith('INSERT INTO bb_project_file_batches')),false);
  return {app,calls,send,assertNoBatchWrite};
}

test('batch recovery code is part of the public error contract',()=>{
  assert.ok((ERROR_CODES as readonly string[]).includes(expired));
});

test('an accepted receipt is returned before inspecting a changed current source or draft',async t=>{
  const h=harness({receipt:'accepted',sourceId:'source-v2',sourceRevision:5,draftVersion:3});t.after(()=>h.app.close());
  const response=await h.send();assert.equal(response.statusCode,200,response.body);
  const batch=response.json<ProjectFileBatch>();assert.equal(batch.batch_id,'accepted-batch');assert.equal(batch.state,'queued');
  assert.deepEqual(batch.items,[{document_type:'issuer',run_id:null,state:'queued',error:null}]);
  const lock=h.calls.findIndex(c=>c.sql.startsWith('SELECT p.*,i.input_hash')&&c.sql.endsWith('FOR UPDATE OF p'));
  const receipt=h.calls.findIndex(c=>c.sql.includes('FROM bb_project_file_batches WHERE owner_user_id=$1 AND request_id=$2'));
  assert.ok(lock>=0&&receipt>lock);assert.ok(h.calls.some(c=>c.sql==='COMMIT'));h.assertNoBatchWrite();
});

test('a missing receipt and advanced source selection return a trusted expired rejection',async t=>{
  const h=harness({sourceId:'source-v2',sourceRevision:5});t.after(()=>h.app.close());
  const response=await h.send();assert.equal(response.statusCode,409,response.body);assert.equal(response.json().code,expired);
  assert.ok(h.calls.some(c=>c.sql==='ROLLBACK'));assert.equal(h.calls.some(c=>c.sql.includes('FROM bb_m4_drafts')),false);h.assertNoBatchWrite();
});

test('re-adopting the same source still expires the old selection revision without a receipt',async t=>{
  const h=harness({sourceRevision:6});t.after(()=>h.app.close());
  const response=await h.send();assert.equal(response.statusCode,409,response.body);assert.equal(response.json().code,expired);h.assertNoBatchWrite();
});

test('an early archived-project conflict never becomes proof that an old receipt is missing',async t=>{
  const h=harness({receipt:'accepted',archived:true});t.after(()=>h.app.close());
  const response=await h.send();assert.equal(response.statusCode,409,response.body);assert.equal(response.json().code,'INPUT_REVISION_CONFLICT');
  assert.equal(h.calls.some(c=>c.sql.includes('FROM bb_project_file_batches')),false);assert.ok(h.calls.some(c=>c.sql==='ROLLBACK'));h.assertNoBatchWrite();
});

test('a missing receipt and advanced persisted draft return the trusted expired code',async t=>{
  const h=harness({draftVersion:3});t.after(()=>h.app.close());
  const response=await h.send();assert.equal(response.statusCode,409,response.body);assert.equal(response.json().code,expired);
  assert.ok(h.calls.some(c=>c.sql.startsWith('SELECT version FROM bb_m4_drafts')));
  assert.equal(h.calls.some(c=>c.sql.startsWith('SELECT * FROM bb_m4_drafts')),false);assert.ok(h.calls.some(c=>c.sql==='ROLLBACK'));h.assertNoBatchWrite();
});

test('idempotency and active-batch conflicts retain their original public codes',async t=>{
  for(const [options,expected] of [[{receipt:'other-input'},'IDEMPOTENCY_CONFLICT'],[{active:true},'PROJECT_RUN_ACTIVE']] as const){
    const h=harness(options);t.after(()=>h.app.close());
    const response=await h.send();assert.equal(response.statusCode,409,response.body);assert.equal(response.json().code,expected);h.assertNoBatchWrite();
  }
});

test('unavailable sources and future input versions do not claim irreversible expiry',async t=>{
  for(const options of [{missingSource:true},{sourceRevision:3},{draftVersion:1}]){
    const h=harness(options);t.after(()=>h.app.close());
    const response=await h.send();assert.equal(response.statusCode,409,response.body);assert.equal(response.json().code,'INPUT_REVISION_CONFLICT');h.assertNoBatchWrite();
  }
});

test('authorization failure never becomes an expired-input receipt',async t=>{
  const h=harness({unauthorized:true});t.after(()=>h.app.close());
  const response=await h.send();assert.equal(response.statusCode,401,response.body);assert.equal(response.json().code,'UNAUTHENTICATED');assert.deepEqual(h.calls,[]);
});
