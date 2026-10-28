import assert from 'node:assert/strict';
import {test} from 'node:test';
import Fastify from 'fastify';
import type {Pool} from 'pg';
import {Value} from '@sinclair/typebox/value';
import {ProjectFileCheckSchema,projectFileOpenApiPaths,type ProjectFileCheck} from '@bondbuddy/contracts';
import {Problem,publicProblem} from './data.js';
import {inputManifestHash} from './production-rule-pin.js';
import {registerProjectFileConsistency} from './project-file-consistency.js';

// The real registered handler and DTO mapper run against a strict synthetic SQL
// pool. There is no PostgreSQL, worker, model, storage write or actual ledger.
const owner='synthetic-update-owner',projectId='synthetic-update-project',otherProject='synthetic-other-project';
const oldCheck='synthetic-check-beyond-thirty',oldRun='synthetic-old-patch',retryRun='synthetic-later-retry';
const now='2026-10-26T03:00:00Z',sha='a'.repeat(64);
const source={project_id:projectId,version_id:'synthetic-source-v1',selection_revision:1,sequence:1,
  filename:'Synthetic original prospectus.docx',asset:{kind:'material' as const,pin:{source_project_id:projectId,
    material_id:'synthetic-source-material',material_version:1,sha256:sha}}};
const files=[1,2].map(n=>({file_id:'synthetic-family-'+n,file_version_id:'synthetic-original-'+n,
  filename:'Synthetic original '+n+'.docx',sequence:1}));
const finding={id:'synthetic-conflict',kind:'conflict' as const,target_span_id:'synthetic-target',original:'100',replacement:'120',
  source_span_id:'synthetic-source',source_quote:'120',source_location:'Synthetic source page 1',target_location:'Synthetic target page 2',
  reason:'Synthetic difference',field:'Synthetic amount',period:'2025',unit:'CNY'};
const result={version:'project-file-check-v1' as const,files:files.map(file=>({file_version_id:file.file_version_id,
  status:'conflict' as const,coverage:'Synthetic coverage',findings:[finding],links:[]}))};
const checkHash=inputManifestHash(result);
type Fault='no-acceptance'|'other-owner'|'other-project'|'run-project'|'not-patch'|'duplicate-acceptance'|
  'manifest-check'|'manifest-file'|'manifest-family'|'manifest-sha'|'manifest-source'|'malformed-manifest'|
  'missing-check'|'duplicate-update'|'wrong-projected-file'|'duplicate-file';
type Options={fault?:Fault;state?:string;deleted?:boolean;unauthorized?:boolean};
type Call={sql:string;values:unknown[]};

function harness(options:Options={}){
  const calls:Call[]=[],patch={owner_user_id:owner,project_id:projectId,run_project_id:projectId,operation:'patch',
    manifest:{version:'project-file-operation-v1',operation:'patch',source:structuredClone(source),check_run_id:oldCheck,
      check_sha256:checkHash,file_id:files[0].file_id,file_version_id:files[0].file_version_id,expected_current_version_id:files[0].file_version_id,
      filename:files[0].filename,asset:source.asset,findings:[finding]}};
  if(options.fault==='other-owner')patch.owner_user_id='synthetic-other-owner';
  if(options.fault==='other-project')patch.project_id=otherProject;
  if(options.fault==='run-project')patch.run_project_id=otherProject;
  if(options.fault==='not-patch')patch.operation='check';
  if(options.fault==='manifest-check')patch.manifest.check_run_id='synthetic-wrong-check';
  if(options.fault==='manifest-file')patch.manifest.file_version_id='synthetic-wrong-version';
  if(options.fault==='manifest-family')patch.manifest.file_id='synthetic-wrong-family';
  if(options.fault==='manifest-sha')patch.manifest.check_sha256='b'.repeat(64);
  if(options.fault==='manifest-source')patch.manifest.source.selection_revision++;
  if(options.fault==='malformed-manifest')delete (patch.manifest as Partial<typeof patch.manifest>).source;
  const operation=(run_id:string)=>({run_id,owner_user_id:owner,project_id:projectId,operation:'check',state:'succeeded',stage:'complete',
    created_at:now,result_hash:checkHash+'  ',manifest:{source,files:structuredClone(files)},result:structuredClone(result)});
  const operations=[...Array.from({length:30},(_,i)=>operation('synthetic-recent-'+i)),operation(oldCheck)];
  if(options.fault==='missing-check')operations.pop();
  if(options.fault==='duplicate-file')operations.at(-1)!.manifest.files.push(structuredClone(files[0]));
  const projectedUpdates=[{check_run_id:oldCheck,file_version_id:files[0].file_version_id,issue_ids:[finding.id],
    run_id:oldRun,state:options.state??'succeeded',new_version_id:options.state&&options.state!=='succeeded'?null:'synthetic-delivered-v2'},
    {check_run_id:oldCheck,file_version_id:files[0].file_version_id,issue_ids:[finding.id],run_id:retryRun,state:'succeeded',new_version_id:'synthetic-later-v3'}];
  if(options.fault==='duplicate-update')projectedUpdates.push(structuredClone(projectedUpdates[0]));
  if(options.fault==='wrong-projected-file')projectedUpdates[0].file_version_id=files[1].file_version_id;
  const rows=(value:unknown[]=[])=>({rows:value,rowCount:value.length});
  const query=async(rawSql:string,values:unknown[]=[])=>{
    const sql=rawSql.replace(/\s+/g,' ').trim();calls.push({sql,values});
    assert.ok(sql.startsWith('SELECT '),'History lookup cannot write or begin a transaction: '+sql);
    if(sql.startsWith('SELECT p.*,i.input_hash')){
      assert.ok(sql.includes('p.owner_user_id=$1 AND p.id=$2 AND p.deleted_at IS NULL'));
      return rows(!options.deleted&&values[0]===owner&&[projectId,otherProject].includes(String(values[1]))?[{id:values[1]}]:[]);
    }
    if(sql.startsWith('SELECT a.check_run_id,a.file_version_id,o.manifest FROM bb_project_file_acceptances a')){
      assert.ok(sql.includes('o.owner_user_id=a.owner_user_id AND o.run_id=a.run_id'));
      assert.ok(sql.includes('r.owner_user_id=o.owner_user_id AND r.project_id=o.project_id AND r.id=o.run_id'));
      assert.ok(sql.endsWith("WHERE a.owner_user_id=$1 AND o.project_id=$2 AND a.run_id=$3 AND o.operation='patch'"));
      if(options.fault==='no-acceptance'||values[0]!==patch.owner_user_id||values[1]!==patch.project_id||values[2]!==oldRun||patch.operation!=='patch'||patch.run_project_id!==patch.project_id)return rows();
      const accepted={check_run_id:oldCheck,file_version_id:files[0].file_version_id,manifest:structuredClone(patch.manifest)};
      return rows(options.fault==='duplicate-acceptance'?[accepted,accepted]:[accepted]);
    }
    if(sql==='SELECT update_project_id FROM bb_update_workspaces WHERE owner_user_id=$1 AND source_project_id=$2')return rows();
    if(sql.startsWith('SELECT v.*,s.revision AS selection_revision FROM bb_prospectus_versions v'))return rows([
      {id:'synthetic-current-source-v2',project_id:projectId,selection_revision:2,sequence:2,filename:'Synthetic current prospectus.docx',
        sha256:sha,material_id:'synthetic-current-source-material',material_version:2}]);
    if(sql==='SELECT * FROM bb_material_versions WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND version=$4 AND deleted_at IS NULL'){
      assert.deepEqual(values,[owner,projectId,'synthetic-current-source-material',2]);return rows([{sha256:sha}]);
    }
    if(sql.startsWith('SELECT o.*,r.state,r.stage,')&&sql.includes('FROM bb_project_file_operations o JOIN bb_runs r')){
      assert.ok(sql.includes('r.owner_user_id=o.owner_user_id AND r.project_id=o.project_id AND r.id=o.run_id'));
      assert.ok(sql.includes("WHERE o.owner_user_id=$1 AND o.project_id=$2 AND o.operation='check'"));
      const selected=operations.filter(operation=>operation.owner_user_id===values[0]&&operation.project_id===values[1]);
      if(values.length===3){assert.ok(sql.endsWith('AND o.run_id=$3'));return rows(selected.filter(operation=>operation.run_id===values[2]));}
      assert.ok(sql.endsWith('ORDER BY o.created_at DESC LIMIT 30'));return rows(selected.slice(0,30));
    }
    if(sql.startsWith('SELECT a.*,r.state,v.id AS new_version_id FROM bb_project_file_acceptances a')){
      assert.ok(sql.includes('a.owner_user_id=$1 AND a.check_run_id=ANY($2::text[])'));assert.equal(values[0],owner);
      return rows((values[1] as string[]).includes(oldCheck)?projectedUpdates:[]);
    }
    if(sql==="SELECT * FROM bb_project_file_update_batches WHERE owner_user_id=$1 AND project_id=$2 AND state IN ('queued','running','paused')"){
      assert.deepEqual(values,[owner,projectId]);return rows();
    }
    throw Error('Unexpected SQL: '+sql);
  };
  const pool={query} as unknown as Pool,app=Fastify();
  app.setErrorHandler((error,request,reply)=>error instanceof Problem?reply.code(error.status).send(publicProblem(error,request.id)):
    reply.code(500).send({message:error instanceof Error?error.message:String(error)}));
  registerProjectFileConsistency(app,()=>pool,async()=>{
    if(options.unauthorized)throw new Problem(401,'UNAUTHENTICATED','Synthetic expired session');return owner;
  });
  const read=(run=oldRun,project=projectId)=>app.inject({method:'GET',url:`/api/v1/projects/${project}/project-files/updates/${run}/check`});
  return {app,calls,read};
}

test('accepted old update reads its exact original check outside the unchanged recent thirty and retains V2 separately from a later V3 retry',async t=>{
  const h=harness();t.after(()=>h.app.close());
  const recent=await h.app.inject({method:'GET',url:`/api/v1/projects/${projectId}/project-files/checks`});
  assert.equal(recent.statusCode,200,recent.body);assert.equal(recent.json().checks.length,30);
  assert.equal(recent.json().checks.some((check:ProjectFileCheck)=>check.run_id===oldCheck),false);
  const response=await h.read();assert.equal(response.statusCode,200,response.body);
  const {check}=response.json<{check:ProjectFileCheck}>();assert.ok(Value.Check(ProjectFileCheckSchema,check));
  assert.equal(check.run_id,oldCheck);assert.equal(check.sha256,checkHash);assert.equal(check.stale,true);
  assert.deepEqual(check.source,source);assert.deepEqual(check.files,files);assert.deepEqual(check.result,result);
  assert.equal(check.updates.find(update=>update.run_id===oldRun)?.new_version_id,'synthetic-delivered-v2');
  assert.equal(check.updates.find(update=>update.run_id===retryRun)?.new_version_id,'synthetic-later-v3');
  assert.ok(h.calls.every(call=>call.sql.startsWith('SELECT ')));
});

for(const state of ['running','paused','failed','cancelled'])test('an original '+state+' update remains distinct from its successful retry and has no invented delivery',async t=>{
  const h=harness({state});t.after(()=>h.app.close());const response=await h.read();assert.equal(response.statusCode,200,response.body);
  const check=response.json<{check:ProjectFileCheck}>().check,original=check.updates.find(update=>update.run_id===oldRun)!;
  assert.equal(original.state,state);assert.equal(original.new_version_id,null);
  assert.equal(check.updates.find(update=>update.run_id===retryRun)?.state,'succeeded');
  assert.equal(check.updates.find(update=>update.run_id===retryRun)?.new_version_id,'synthetic-later-v3');
});

for(const fault of ['no-acceptance','other-owner','other-project','run-project','not-patch','duplicate-acceptance',
  'manifest-check','manifest-file','manifest-family','manifest-sha','manifest-source','malformed-manifest',
  'missing-check','duplicate-update','wrong-projected-file','duplicate-file'] as Fault[])test('accepted-update history rejects '+fault+' with the same safe 404',async t=>{
  const h=harness({fault});t.after(()=>h.app.close());const response=await h.read();
  assert.equal(response.statusCode,404,response.body);assert.equal(response.json().code,'NOT_FOUND');
  assert.equal(response.json().message,'Resource does not exist');assert.equal('check' in response.json(),false);
});

for(const [label,run,project] of [['missing patch','synthetic-missing-patch',projectId],['check used as patch',oldCheck,projectId],
  ['different owned project',oldRun,otherProject],['foreign project',oldRun,'synthetic-foreign-project']] as const)test('accepted-update history refuses '+label,async t=>{
  const h=harness();t.after(()=>h.app.close());const response=await h.read(run,project);
  assert.equal(response.statusCode,404,response.body);assert.equal('check' in response.json(),false);
});

test('deleted project and unauthenticated session are rejected before reading update or check records',async t=>{
  const deleted=harness({deleted:true}),unauthorized=harness({unauthorized:true});t.after(()=>Promise.all([deleted.app.close(),unauthorized.app.close()]));
  assert.equal((await deleted.read()).statusCode,404);assert.equal(deleted.calls.length,1);
  assert.equal((await unauthorized.read()).statusCode,401);assert.deepEqual(unauthorized.calls,[]);
});

test('accepted-update history OpenAPI reuses the public check DTO and owned GET path parameters',()=>{
  const path=projectFileOpenApiPaths()['/api/v1/projects/{project_id}/project-files/updates/{run_id}/check'].get;
  assert.deepEqual(path.parameters.map(parameter=>parameter.name),['project_id','run_id']);
  assert.deepEqual(path.security,[{sessionCookie:[]}]);assert.equal('requestBody' in path,false);
  const schema=path.responses[200].content!['application/json'].schema as {properties:{check:unknown}};
  assert.deepEqual(schema.properties.check,ProjectFileCheckSchema);
});
