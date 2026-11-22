// Isolated Linux/PG/Azurite verification. Never uses the application's environment or production URLs.
import {spawn,spawnSync} from 'node:child_process';
import {readFileSync,readdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createInterface} from 'node:readline';
import {randomBytes,createHash} from 'node:crypto';
import assert from 'node:assert/strict';

const directory=dirname(fileURLToPath(import.meta.url));
const repository=resolve(directory,'../..');
const docker=process.env.BB_DIAG_DOCKER ?? 'docker';
const instance='bb-diag-test-'+randomBytes(6).toString('hex');
const pg=instance+'-pg', blob=instance+'-blob', network=instance+'-net';
const mount=`type=bind,source=${directory},target=/code,readonly`;
const containers=[];let createdNetwork=false;const checks=[];
function run(args,{input,allowFailure=false,timeout=120000}={}) {
  const result=spawnSync(docker,args,{input,encoding:'utf8',timeout,maxBuffer:40*1024*1024});
  if(result.error)throw result.error;
  if(result.status!==0&&!allowFailure)throw Error(`Docker test operation ${args[0]} failed: ${result.stderr.slice(-5000)}`);
  return result;
}
function sql(query,{role='postgres',allowFailure=false}={}) {
  return run(['exec','-i',pg,'psql','-X','-v','ON_ERROR_STOP=1','-Atq','-U',role,'-d','bondbuddy'],{input:query,allowFailure});
}
const pause=ms=>new Promise(r=>setTimeout(r,ms));
function pass(name){checks.push(name);console.log('PASS '+name);}
try {
  const subnet=process.env.BB_DIAG_TEST_SUBNET??`10.246.${randomBytes(1)[0]}.0/28`;
  run(['network','create','--internal','--subnet',subnet,'--label',`io.bondbuddy.diagnostics-test=${instance}`,network]);createdNetwork=true;
  run(['run','-d','--name',pg,'--label',`io.bondbuddy.diagnostics-test=${instance}`,'--network',network,'--network-alias','postgres',
    '--tmpfs','/var/lib/postgresql/data:rw','-e','POSTGRES_DB=bondbuddy','-e','POSTGRES_PASSWORD=synthetic-local-test-only','postgres:16-alpine']);containers.push(pg);
  let ready=false;
  for(let i=0;i<30;i++){
    if(run(['exec',pg,'pg_isready','-U','postgres','-d','bondbuddy'],{allowFailure:true}).status===0){ready=true;break;}
    await pause(500);
  }
  assert(ready,'isolated PostgreSQL must become ready');
  const migrations=readdirSync(resolve(repository,'db/migrations')).filter(f=>/^\d+.*\.sql$/.test(f)).sort();
  // Git's Windows checkout uses CRLF. Linux deployments use LF; function-definition
  // migrations compare exact newline markers, so send the canonical Linux text.
  const migrationSql=migrations.map(file=>`\\echo ${file}\nBEGIN;\n`+readFileSync(resolve(repository,'db/migrations',file),'utf8').replace(/\r\n/g,'\n')+'\nCOMMIT;').join('\n');
  const migrated=sql(migrationSql,{allowFailure:true});
  if(migrated.status!==0)throw Error(`Migration failed after ${migrated.stdout.slice(-300)}: ${migrated.stderr.slice(-3000)}`);
  pass(`${migrations.length} current application migrations on isolated PG16`);
  const install=run(['run','--rm','--network','none','--mount',mount,'-w','/code','python:3.11-slim','python','-B','database.py']).stdout;
  sql(install);sql(install);pass('diagnostic views install and repeat installation');
  for(const [kind,view,table] of [
    ['execution-configs','execution_configs','bb_model_attempt_execution_configs'],
    ['result-failures','result_failures','bb_model_result_failure_diagnostics']]){
    assert.equal(sql(`SELECT available FROM bb_diagnostics.availability WHERE kind='${kind}'`,{role:'bb_diagnostics_reader'}).stdout.trim(),'t');
    assert.equal(sql(`SELECT count(*) FROM bb_diagnostics.${view}`,{role:'bb_diagnostics_reader'}).stdout.trim(),'0');
    assert.notEqual(sql(`SELECT count(*) FROM public.${table}`,{role:'bb_diagnostics_reader',allowFailure:true}).status,0);
  }
  pass('model diagnostic views are readable while raw evidence tables remain denied');
  const performanceAvailable=sql("SELECT available FROM bb_diagnostics.availability WHERE kind='performance-spans'",{role:'bb_diagnostics_reader'}).stdout.trim()==='t';
  if(performanceAvailable){
    assert.equal(sql('SELECT count(*) FROM bb_diagnostics.performance_sessions, bb_diagnostics.performance_spans',{role:'bb_diagnostics_reader'}).stdout.trim(),'0');
    assert.notEqual(sql('SELECT count(*) FROM public.bb_performance_spans',{role:'bb_diagnostics_reader',allowFailure:true}).status,0);
    pass('performance views readable while raw performance tables remain denied');
  }else{
    assert.equal(sql("SELECT to_regclass('bb_diagnostics.performance_spans') IS NULL",{role:'bb_diagnostics_reader'}).stdout.trim(),'t');
    pass('pre-performance baseline reports unavailable views without exposing raw tables');
  }
  sql(`INSERT INTO bb_users(id,phone_e164,created_at) SELECT 'diag-user-'||lpad(i::text,3,'0'),'+199900'||lpad(i::text,5,'0'),'2026-01-01T00:00:00Z' FROM generate_series(1,125) i;`);
  sql(`INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES('diag-project','diag-user-001','Synthetic diagnostic fixture','bond');
    INSERT INTO bb_snapshot_refs(id,owner_user_id,project_id,snapshot_kind,version,object_key,content_sha256,redaction_version)
    VALUES('diag-snapshot','diag-user-001','diag-project','model_request',1,'users/diag-user-001/projects/diag-project/snapshots/diag-snapshot',repeat('a',64),'synthetic');`);
  assert.equal(sql("SELECT count(*) FROM bb_diagnostics.content_refs WHERE key='diag-snapshot'",{role:'bb_diagnostics_reader'}).stdout.trim(),'1');
  sql("UPDATE bb_users SET status='disabled' WHERE id='diag-user-001'");
  assert.equal(sql("SELECT count(*) FROM bb_diagnostics.content_refs WHERE key='diag-snapshot'",{role:'bb_diagnostics_reader'}).stdout.trim(),'0');
  sql("UPDATE bb_users SET status='active' WHERE id='diag-user-001'; INSERT INTO bb_log_content_tombstones(id,owner_user_id,content_kind,content_id,object_key,reason,policy_version) VALUES('diag-tombstone','diag-user-001','prompt_snapshot','diag-snapshot','users/diag-user-001/projects/diag-project/snapshots/diag-snapshot','retention_expired','synthetic')");
  assert.equal(sql("SELECT count(*) FROM bb_diagnostics.content_refs WHERE key='diag-snapshot'",{role:'bb_diagnostics_reader'}).stdout.trim(),'0');
  sql("INSERT INTO bb_snapshot_refs(id,owner_user_id,project_id,snapshot_kind,version,object_key,content_sha256,redaction_version) VALUES('diag-snapshot-2','diag-user-001','diag-project','model_request',2,'users/diag-user-001/projects/diag-project/snapshots/diag-snapshot-2',repeat('b',64),'synthetic')");
  assert.equal(sql("SELECT count(*) FROM bb_diagnostics.content_refs WHERE key='diag-snapshot-2'",{role:'bb_diagnostics_reader'}).stdout.trim(),'1');
  sql("UPDATE bb_projects SET deleted_at=now() WHERE id='diag-project'");
  assert.equal(sql("SELECT count(*) FROM bb_diagnostics.content_refs WHERE key='diag-snapshot-2'",{role:'bb_diagnostics_reader'}).stdout.trim(),'0');
  assert.equal(sql("SELECT count(*) FROM bb_diagnostics.content_refs WHERE key='diag-snapshot'",{role:'bb_diagnostics_reader'}).stdout.trim(),'0');
  pass('private content respects disabled owners, deleted projects and retention tombstones');
  assert.equal(sql('SHOW default_transaction_read_only',{role:'bb_diagnostics_reader'}).stdout.trim(),'on');
  for(const statement of ['SELECT * FROM bb_users LIMIT 1',"UPDATE bb_jobs SET state='failed'",'DELETE FROM bb_runs',"CREATE TABLE public.diag_escape(id int)"]){
    assert.notEqual(sql('SET default_transaction_read_only=off; '+statement,{role:'bb_diagnostics_reader',allowFailure:true}).status,0,statement);
  }
  pass('read-only database role cannot read identities directly, update, delete or create tables even after disabling transaction guard');
  // A large excluded payload must not be serialized just to sort diagnostic metadata.
  sql(`INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload,created_at)
    SELECT 'diag-outbox-'||lpad(i::text,5,'0'),'diag-user-001','upload','synthetic-upload','upload_complete',
      jsonb_build_object('excluded',repeat('synthetic-large-payload-',2000)), '2026-01-01T00:00:00Z'::timestamptz
    FROM generate_series(1,20000) i; ANALYZE bb_outbox;`);
  const largePage=sql("BEGIN READ ONLY; SET LOCAL statement_timeout='2s'; SELECT key FROM bb_diagnostics.outbox ORDER BY at,key LIMIT 10; COMMIT;",{role:'bb_diagnostics_reader'});
  assert.equal(largePage.stdout.trim().split(/\r?\n/).length,10);
  pass('20,000 large-payload outbox rows remain pageable within bounded query time');
  const client=spawn(docker,['run','--rm','-i','--network','none','--mount',mount,'-w','/code','python:3.11-slim','python','-B','-u','test_pg_client.py'],{stdio:['pipe','pipe','pipe']});
  let clientError='',done=false;
  client.stderr.on('data',c=>{clientError+=c;});
  const completion=new Promise(resolve=>client.on('close',code=>resolve(code)));
  for await(const line of createInterface({input:client.stdout})){
    const message=JSON.parse(line);
    if(message.sql){
      const result=sql("BEGIN READ ONLY; SET LOCAL statement_timeout='10s'; "+message.sql+'; COMMIT;',{role:'bb_diagnostics_reader',allowFailure:true});
      client.stdin.write(JSON.stringify(result.status===0?{result:JSON.parse(result.stdout.trim())}:{error:result.stderr})+'\n');
    }else if(message.done){done=true;client.stdin.end();}
  }
  assert.equal(await completion,0,clientError);assert(done);
  pass('all available diagnostic projections and multi-page real PostgreSQL reads');
  const images=run(['image','ls','--format','{{.Repository}}:{{.Tag}}']).stdout.split(/\r?\n/);
  const azurite=images.find(x=>x.startsWith('mcr.microsoft.com/azure-storage/azurite:')&&!x.endsWith(':<none>'));
  assert(azurite,'a local Azurite image is required');
  const api=process.env.BB_DIAG_API_TEST_IMAGE??'bondbuddy-quality-capacity-api:f029721966a7';
  const key=randomBytes(32).toString('base64');
  run(['run','-d','--name',blob,'--label',`io.bondbuddy.diagnostics-test=${instance}`,'--network',network,'--network-alias','blob','-e',`AZURITE_ACCOUNTS=diag:${key}`,azurite,'azurite-blob','--blobHost','0.0.0.0','--skipApiVersionCheck']);containers.push(blob);
  const connection=`DefaultEndpointsProtocol=http;AccountName=diag;AccountKey=${key};BlobEndpoint=http://blob:10000/diag;`;
  const secret='synthetic-provider-secret-12345';
  function node(program,args=[],allowFailure=false){return run(['run','--rm','-i','--network',network,'--mount',mount,'--entrypoint','node','-e',`AZURE_STORAGE_CONNECTION_STRING=${connection}`,'-e',`API_KEY=${secret}`,api,'--input-type=module','-',...args],{input:program,allowFailure});}
  const seed=`import{createRequire}from'node:module';const r=createRequire('/app/apps/api/package.json');const{BlobServiceClient}=r('@azure/storage-blob');const b=BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING).getContainerClient('bondbuddy-private');await b.createIfNotExists();const a=JSON.parse(process.argv[2]);await b.getBlockBlobClient(a.key).uploadData(Buffer.from(a.text));console.log('seeded');`;
  const helper=readFileSync(resolve(directory,'read-content.mjs'),'utf8');
  for(const kind of ['prompt','result','exec']){
    const text=`synthetic ${kind} 中文 ${secret}`;const sha=createHash('sha256').update(text).digest('hex');
    const suffix=kind==='prompt'?'snapshots/test-prompt':kind==='result'?`provider-results/attempt-${sha}.json`:'runs/run/attempts/attempt/exec.log';
    const ref={kind,key:'test',owner_user_id:'owner',project_id:'project',run_id:'run',attempt_id:'attempt',object_key:'users/owner/projects/project/'+suffix,sha256:sha,byte_size:Buffer.byteLength(text)};
    let seeded=false;
    for(let i=0;i<8;i++){const result=node(seed,[JSON.stringify({key:ref.object_key,text})],true);if(result.status===0){seeded=true;break;}await pause(500);}
    assert(seeded,'Azurite fixture upload');
    const result=node(helper,[JSON.stringify(ref)]);assert.equal(result.stdout,text.replace(secret,'[redacted]'));
    for(const bad of [{...ref,sha256:'0'.repeat(64)},{...ref,object_key:'users/other/private'},{...ref,byte_size:ref.byte_size+1}])assert.notEqual(node(helper,[JSON.stringify(bad)],true).status,0);
  }
  pass('private prompt/result/exec reads against real Azurite: SHA256, scope, size and credential redaction');
  console.log(JSON.stringify({passed:true,checks,model:'none; synthetic diagnostic fixtures',productionChanged:false},null,2));
} finally {
  for(const name of containers.reverse()){
    const label=run(['inspect','--format','{{index .Config.Labels "io.bondbuddy.diagnostics-test"}}',name],{allowFailure:true}).stdout.trim();
    if(label===instance)run(['rm','-f','-v',name],{allowFailure:true});
  }
  if(createdNetwork){
    const label=run(['network','inspect','--format','{{index .Labels "io.bondbuddy.diagnostics-test"}}',network],{allowFailure:true}).stdout.trim();
    if(label===instance)run(['network','rm',network],{allowFailure:true});
  }
}
