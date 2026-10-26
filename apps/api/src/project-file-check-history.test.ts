import assert from 'node:assert/strict';
import {test} from 'node:test';
import Fastify from 'fastify';
import type {Pool} from 'pg';
import {Value} from '@sinclair/typebox/value';
import {ProjectFileCheckSchema,type ProjectFileCheck} from '@bondbuddy/contracts';
import {Problem,publicProblem} from './data.js';
import {registerProjectFileConsistency} from './project-file-consistency.js';

// Synthetic SQL fixtures execute the real registered GET handlers and DTO mapper.
// No PostgreSQL, worker, model, storage writes or actual charges are involved.
const owner='synthetic-owner',projectId='synthetic-project',otherProject='synthetic-other-project';
const oldRun='synthetic-check-31',now='2026-10-26T01:00:00Z',sha='a'.repeat(64);
const source={project_id:projectId,version_id:'synthetic-source-v1',selection_revision:1,sequence:1,
  filename:'Synthetic prospectus.docx',asset:{kind:'material' as const,pin:{source_project_id:projectId,
    material_id:'synthetic-source-material',material_version:1,sha256:sha}}};
const inputs=[1,2].map(n=>({file_id:'synthetic-file-'+n,file_version_id:'synthetic-file-v'+n,
  filename:'Synthetic file '+n+'.docx',sequence:n}));
type Options={unauthorized?:boolean;deleted?:boolean;missingSource?:boolean;currentRevision?:number;state?:string};
type Call={sql:string;values:unknown[]};

function harness(options:Options={}){
  const calls:Call[]=[];
  const operation=(run_id:string,owned=owner,project=projectId,kind='check')=>({run_id,owner_user_id:owned,project_id:project,operation:kind,
    state:options.state??'succeeded',stage:'complete',created_at:now,result_hash:sha+'   ',
    manifest:{source,files:inputs},result:{version:'project-file-check-v1',files:inputs.map(f=>({file_version_id:f.file_version_id,
      status:'consistent',coverage:'Synthetic coverage',findings:[],links:[]}))}});
  const operations=[...Array.from({length:30},(_,i)=>operation('synthetic-check-'+(i+1))),operation(oldRun),
    operation('synthetic-foreign-check','synthetic-other-owner'),operation('synthetic-other-project-check',owner,otherProject),
    operation('synthetic-patch',owner,projectId,'patch')];
  const rows=(value:unknown[]=[])=>({rows:value,rowCount:value.length});
  const query=async(sql:string,values:unknown[]=[])=>{
    sql=sql.replace(/\s+/g,' ').trim();calls.push({sql,values});
    assert.ok(sql.startsWith('SELECT '),'History reads must never write or open transactions: '+sql);
    if(sql.startsWith('SELECT p.*,i.input_hash')){
      assert.ok(sql.includes('p.owner_user_id=$1 AND p.id=$2 AND p.deleted_at IS NULL'));
      return rows(!options.deleted&&values[0]===owner&&[projectId,otherProject].includes(String(values[1]))?[{id:values[1]}]:[]);
    }
    if(sql==='SELECT update_project_id FROM bb_update_workspaces WHERE owner_user_id=$1 AND source_project_id=$2')return rows();
    if(sql.startsWith('SELECT v.*,s.revision AS selection_revision FROM bb_prospectus_versions v')){
      return rows(options.missingSource?[]:[{id:source.version_id,project_id:projectId,selection_revision:options.currentRevision??1,
        sequence:1,filename:source.filename,sha256:sha,material_id:'synthetic-source-material',material_version:1}]);
    }
    if(sql==='SELECT * FROM bb_material_versions WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND version=$4 AND deleted_at IS NULL'){
      assert.deepEqual(values,[owner,projectId,'synthetic-source-material',1]);return rows([{sha256:sha}]);
    }
    if(sql.startsWith('SELECT o.*,r.state,r.stage FROM bb_project_file_operations o JOIN bb_runs r')){
      assert.ok(sql.includes('r.owner_user_id=o.owner_user_id AND r.project_id=o.project_id AND r.id=o.run_id'));
      assert.ok(sql.includes("o.owner_user_id=$1 AND o.project_id=$2 AND o.operation='check'"));
      const filtered=operations.filter(o=>o.owner_user_id===values[0]&&o.project_id===values[1]&&o.operation==='check');
      if(values.length===3){assert.ok(sql.endsWith('AND o.run_id=$3'));return rows(filtered.filter(o=>o.run_id===values[2]));}
      assert.ok(sql.endsWith('ORDER BY o.created_at DESC LIMIT 30'));return rows(filtered.slice(0,30));
    }
    if(sql.startsWith('SELECT a.*,r.state,v.id AS new_version_id FROM bb_project_file_acceptances a')){
      assert.ok(sql.includes('a.owner_user_id=$1 AND a.check_run_id=ANY($2::text[])'));
      assert.equal(values[0],owner);
      return rows((values[1] as string[]).includes(oldRun)?[{check_run_id:oldRun,file_version_id:inputs[0].file_version_id,
        issue_ids:['synthetic-issue'],run_id:'synthetic-completed-patch',state:'succeeded',new_version_id:'synthetic-new-version'}]:[]);
    }
    if(sql==="SELECT * FROM bb_project_file_update_batches WHERE owner_user_id=$1 AND project_id=$2 AND state IN ('queued','running','paused')"){
      assert.deepEqual(values,[owner,values[1]]);
      return rows([{check_run_id:oldRun,state:'paused',items:[{manifest:{file_version_id:inputs[1].file_version_id},
        issue_ids:[],run_id:null},{manifest:{file_version_id:inputs[0].file_version_id},issue_ids:[],run_id:'synthetic-completed-patch'}]}]);
    }
    throw Error('Unexpected SQL: '+sql);
  };
  const pool={query} as unknown as Pool;
  const app=Fastify();
  app.setErrorHandler((error,request,reply)=>{
    if(error instanceof Problem)return reply.code(error.status).send(publicProblem(error,request.id));
    return reply.code(500).send({message:error instanceof Error?error.message:String(error)});
  });
  registerProjectFileConsistency(app,()=>pool,async()=>{
    if(options.unauthorized)throw new Problem(401,'UNAUTHENTICATED','Synthetic expired session');return owner;
  });
  const read=(run=oldRun,project=projectId)=>app.inject({method:'GET',url:`/api/v1/projects/${project}/project-files/checks/${run}`});
  return {app,calls,read};
}

test('old exact check is readable outside the unchanged recent 30 and retains original pins and all updates',async t=>{
  const h=harness();t.after(()=>h.app.close());
  const recent=await h.app.inject({method:'GET',url:`/api/v1/projects/${projectId}/project-files/checks`});
  assert.equal(recent.statusCode,200,recent.body);assert.equal(recent.json().checks.length,30);
  assert.equal(recent.json().checks.some((c:ProjectFileCheck)=>c.run_id===oldRun),false);
  const response=await h.read();assert.equal(response.statusCode,200,response.body);
  const {check}=response.json<{check:ProjectFileCheck}>();assert.ok(Value.Check(ProjectFileCheckSchema,check));
  assert.equal(check.run_id,oldRun);assert.deepEqual(check.source,source);assert.deepEqual(check.files,inputs);
  assert.equal(check.sha256,sha);assert.equal(check.stale,false);assert.equal(check.result?.files.length,2);
  assert.deepEqual(check.updates,[{file_version_id:inputs[0].file_version_id,issue_ids:['synthetic-issue'],
    run_id:'synthetic-completed-patch',state:'succeeded',new_version_id:'synthetic-new-version'},
  {file_version_id:inputs[1].file_version_id,issue_ids:[],run_id:null,state:'paused',new_version_id:null}]);
  assert.ok(h.calls.every(c=>c.sql.startsWith('SELECT ')));
});

test('old check marks a changed source adoption as stale without replacing its fixed source',async t=>{
  const h=harness({currentRevision:2});t.after(()=>h.app.close());const response=await h.read();
  assert.equal(response.statusCode,200,response.body);assert.equal(response.json().check.stale,true);
  assert.deepEqual(response.json().check.source,source);
});

test('old running check does not expose a stored result as completed',async t=>{
  const h=harness({state:'running',missingSource:true});t.after(()=>h.app.close());const response=await h.read();
  assert.equal(response.statusCode,200,response.body);assert.equal(response.json().check.result,null);
  assert.equal(response.json().check.stale,true);assert.equal(response.json().check.state,'running');
});

for(const [label,run,project] of [
  ['missing','synthetic-missing-check',projectId],['other owner','synthetic-foreign-check',projectId],
  ['other project','synthetic-other-project-check',projectId],['mismatched project',oldRun,otherProject],
  ['patch operation','synthetic-patch',projectId],['foreign project',oldRun,'synthetic-foreign-project'],
] as const)test('exact check returns the same safe 404 for '+label,async t=>{
  const h=harness();t.after(()=>h.app.close());const response=await h.read(run,project);
  assert.equal(response.statusCode,404,response.body);assert.equal(response.json().code,'NOT_FOUND');
  assert.equal(response.json().message,'Resource does not exist');assert.equal('check' in response.json(),false);
});

test('deleted project is rejected before reading any source or operation',async t=>{
  const h=harness({deleted:true});t.after(()=>h.app.close());const response=await h.read();
  assert.equal(response.statusCode,404,response.body);assert.equal(h.calls.length,1);
});

test('unauthenticated exact read never queries the database',async t=>{
  const h=harness({unauthorized:true});t.after(()=>h.app.close());const response=await h.read();
  assert.equal(response.statusCode,401,response.body);assert.deepEqual(h.calls,[]);
});
