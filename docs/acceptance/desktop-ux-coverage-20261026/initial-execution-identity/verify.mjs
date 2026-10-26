import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {resolve,relative,join} from 'node:path';
import {Pool} from 'pg';

const root=process.cwd(),local=resolve(root,'.local/initial-execution');
const template='postgresql://bb_g03_test@127.0.0.1:15526/bb_g03_template_20261026';
mkdirSync(local,{recursive:true});
const env={...process.env};
for(const name of Object.keys(env))if(/^(BB_|DATABASE_URL$|AZURE_|DEEPSEEK_|OPENAI_|CODEX_HOME$)/i.test(name))delete env[name];
Object.assign(env,{BB_TEST_DATABASE_URL:template,BB_RUN_RUNTIME_ENABLED:'1',BB_E2E_BASE_URL:'http://127.0.0.1:5198',BB_E2E_BROWSER_CHANNEL:'msedge'});
const python='C:/Users/lezhai/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
env.BONDBUDDY_TEST_PYTHON=python;env.BONDBUDDY_WORD_PYTHON=python;
const mode=process.argv[2];
const apiTests=['run-execution.pg.integration.test','prompt-execution-boundary.pg.integration.test','ocr-execution-boundary.pg.integration.test','provider-runtime-locks.pg.integration.test','queue.test','run-origin-immutability.pg.test','run-supplement-draft.pg.test','review-action-events.pg.integration.test'];
const workerTests=['run-execution-consumers.pg.test','review-web-search-locks.pg.integration.test','review-word-registration.pg.integration.test','authoring-pause.pg.test','worker-runtime-pipeline-seams.pg.integration.test','m4-pipeline.pg.test','m4-stages.test','unified-model-stage.test','ocr-v2.test','run-pipeline-error.test'];
const migration='0119_initial_run_execution_identity.sql';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const log=(name,body)=>{writeFileSync(join(local,name),typeof body==='string'?body:JSON.stringify(body,null,2)+'\n');};
const quote=name=>'"'+name.replaceAll('"','""')+'"';
if(['api-build','worker-build','web-tsc','api-test','worker-test','inflight-test','regression-test'].includes(mode)){
  let suffix=0;while(true){try{readFileSync(join(local,`${mode}${suffix?'-'+suffix:''}.log`));suffix++;}catch{break;}}
  let args,cwd=root;
  if(mode.endsWith('build'))args=[resolve(root,'node_modules/typescript/bin/tsc'),'-p',`apps/${mode.split('-')[0]}/tsconfig.json`];
  else if(mode==='web-tsc')args=[resolve(root,'node_modules/typescript/bin/tsc'),'--noEmit','-p','apps/web/tsconfig.json'];
  else if(mode==='api-test'||mode==='worker-test')args=['--test','--test-concurrency=1',...(mode==='api-test'?apiTests:workerTests).map(name=>`apps/${mode.split('-')[0]}/dist/${name}.js`)];
  else{
    cwd=resolve(root,'apps/web');const label=mode==='inflight-test'?'inflight':'regression';
    const round=suffix?'-'+suffix:'';
    env.BB_SUPPLEMENT_REAL_EVIDENCE_DIR=join(local,`${label}-evidence${round}`);
    env.PLAYWRIGHT_JSON_OUTPUT_FILE=join(local,`${label}-report${round}.json`);
    args=[resolve(root,'node_modules/@playwright/test/cli.js'),'test','--config','playwright.config.ts',mode==='inflight-test'?'run-supplement-inflight-main.spec.ts':'run-supplement-real-main.spec.ts','--workers','1','--output',join(local,`${label}-results${round}`),'--reporter=line,json'];
  }
  const started=new Date().toISOString(),result=spawnSync(process.execPath,args,{cwd,env,encoding:'utf8',windowsHide:true,maxBuffer:64*1024*1024});
  const output=(result.stdout??'')+(result.stderr??'');
  log(`${mode}${suffix?'-'+suffix:''}.log`,output);log(`${mode}-last.json`,{started,finished:new Date().toISOString(),args,cwd,status:result.status,signal:result.signal,error:result.error?.message});
  process.stdout.write(output);if(result.error)throw result.error;process.exitCode=result.status??1;
}else if(mode==='migration-backfill'){
  const maintenance=new Pool({connectionString:template.replace(/\/bb_g03_template_20261026$/,'/postgres')});
  const clone=`bb_g03_backfill_${randomUUID().replaceAll('-','').slice(0,10)}`;let db;
  try{
    await maintenance.query(`CREATE DATABASE ${quote(clone)} TEMPLATE bb_g03_template_20261026`);
    db=new Pool({connectionString:template.replace(/\/bb_g03_template_20261026$/,'/'+clone)});
    assert.equal((await db.query('SELECT 1 FROM bb_schema_migrations WHERE filename=$1',[migration])).rowCount,0);
    const owner='synthetic-execution-backfill',project=randomUUID(),hash=sha('{}');
    await db.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic migration history','update')",[project,owner]);
    await db.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
      VALUES($1,1,$2,1,$3,'{}','[]','[]')`,[project,owner,hash]);
    for(const [index,state] of ['queued','running','paused','failed','cancelled','legacy-hash-mismatch'].entries()){
      const run=randomUUID(),job=randomUUID(),runHash=state==='legacy-hash-mismatch'?'a'.repeat(64):hash,actualState=state==='legacy-hash-mismatch'?'paused':state;
      await db.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state,stage,created_at)
        VALUES($1,$2,$3,1,$4,$5,'update',$6,$7,'synthetic_history','2026-10-01T01:02:03Z')`,[run,owner,project,runHash,randomUUID(),sha(run),actualState]);
      await db.query(`INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state,stage,checkpoint)
        VALUES($1,$2,$3,'update','default',$4,'synthetic_history',$5)`,[job,owner,run,actualState,{saved_work:`synthetic ${index}`}]);
      await db.query(`INSERT INTO bb_run_events(id,owner_user_id,run_id,seq,trace_id,type,state,stage,payload)
        VALUES($1,$2,$3,1,$3,'run.state_changed',$4,'synthetic_history',$5)`,[randomUUID(),owner,run,actualState,{synthetic:true,index}]);
      await db.query(`INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload)
        VALUES($1,$2,'run',$3,'run.state_changed',$4)`,[randomUUID(),owner,run,{synthetic:true,index}]);
      const snapshot=randomUUID();
      await db.query(`INSERT INTO bb_snapshot_refs(id,owner_user_id,project_id,run_id,snapshot_kind,version,object_key,content_sha256,redaction_version,input_revision,input_hash)
        VALUES($1,$2,$3,$4,'model_request',$8,$5,$6,'synthetic',1,$7)`,[snapshot,owner,project,run,`users/${owner}/projects/${project}/snapshots/${snapshot}`,sha('synthetic prompt'),runHash,index+1]);
      await db.query(`INSERT INTO bb_model_call_attempts(id,owner_user_id,job_id,logical_call_id,attempt_no,status,prompt_snapshot_id)
        VALUES($1,$2,$3,'synthetic_history',1,'confirmed_not_sent',$4)`,[randomUUID(),owner,job,snapshot]);
    }
    const tables=['bb_projects','bb_input_revisions','bb_runs','bb_jobs','bb_run_events','bb_outbox','bb_snapshot_refs','bb_model_call_attempts','bb_credit_events'];
    const snapshot=async()=>Object.fromEntries(await Promise.all(tables.map(async table=>[table,(await db.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows.map(r=>r.row)])));
    const before=await snapshot();log('backfill-before.json',before);
    const client=await db.connect();try{await client.query('BEGIN');await client.query(readFileSync(resolve(root,'db/migrations',migration),'utf8'));await client.query('INSERT INTO bb_schema_migrations(filename) VALUES($1)',[migration]);await client.query('COMMIT');}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    const after=await snapshot();assert.deepEqual(after,before);log('backfill-after.json',after);
    const identities=(await db.query(`SELECT e.*,r.input_revision AS original_revision,r.input_hash AS original_hash,r.created_at AS original_created_at
      FROM bb_run_execution_versions e JOIN bb_runs r ON r.id=e.run_id ORDER BY e.run_id`)).rows;
    assert.equal(identities.length,6);for(const row of identities){assert.equal(row.execution_version,1);assert.equal(row.input_revision,row.original_revision);assert.equal(row.input_hash,row.original_hash);assert.equal(row.created_at.toISOString(),row.original_created_at.toISOString());}
    log('backfill-result.json',{synthetic:true,legacy_hash_mismatch_preserved:true,existing_rows_exactly_unchanged:true,tables:tables.map(table=>({table,rows:before[table].length})),identities});console.log('0119 backfill: 6 historical runs, jobs, immutable inputs, prompts, calls, events and outbox preserved exactly, including original legacy hash mismatch.');
  }finally{await db?.end();await maintenance.query(`DROP DATABASE IF EXISTS ${quote(clone)} WITH (FORCE)`);await maintenance.end();}
}else if(mode==='migrate'){
  const pool=new Pool({connectionString:template});
  try{
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_runs')).rows[0].n,0);
    const before=(await pool.query('SELECT filename FROM bb_schema_migrations ORDER BY filename DESC LIMIT 2')).rows;
    assert.equal(before[0].filename,'0118_run_supplement_drafts.sql');
    const client=await pool.connect();try{await client.query('BEGIN');await client.query(readFileSync(resolve(root,'db/migrations',migration),'utf8'));await client.query('INSERT INTO bb_schema_migrations(filename) VALUES($1)',[migration]);await client.query('COMMIT');}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    const after=(await pool.query('SELECT filename FROM bb_schema_migrations ORDER BY filename DESC LIMIT 2')).rows;
    log('migration-template.json',{before,after,migration_sha256:sha(readFileSync(resolve(root,'db/migrations',migration)))});console.log('Isolated empty test template migrated once to 0119.');
  }finally{await pool.end();}
}else if(mode==='snapshot'){
  const pool=new Pool({connectionString:template});try{
    const evidence={server_version:(await pool.query('SHOW server_version')).rows[0].server_version,schema:(await pool.query('SELECT filename FROM bb_schema_migrations ORDER BY filename DESC LIMIT 2')).rows,
      template_run_count:(await pool.query('SELECT count(*)::int n FROM bb_runs')).rows[0].n,template_execution_count:(await pool.query('SELECT count(*)::int n FROM bb_run_execution_versions')).rows[0].n,
      remaining_clones:(await pool.query("SELECT datname FROM pg_database WHERE datname LIKE 'bb_g03_template_20261026_t%' OR datname LIKE 'bb_g03_backfill_%' OR datname LIKE 'bb_g03_migration_lock_%' ORDER BY datname")).rows};
    log('database-final.json',evidence);console.log(JSON.stringify(evidence,null,2));assert.equal(evidence.template_run_count,0);assert.equal(evidence.template_execution_count,0);assert.equal(evidence.remaining_clones.length,0);
  }finally{await pool.end();}
}else if(mode==='source-before'||mode==='source-after'){
  const files=[];const walk=dir=>{for(const e of readdirSync(dir,{withFileTypes:true})){const file=join(dir,e.name);if(e.isDirectory())walk(file);else if(e.isFile())files.push(file);}};
  for(const dir of ['apps/web/src','apps/web/dist','apps/web/tests','apps/api/src','apps/api/dist','apps/worker/src','apps/worker/dist','packages/contracts/src','packages/contracts/dist','db/migrations'])walk(resolve(root,dir));
  const entries=files.sort().map(file=>({path:relative(root,file).replaceAll('\\','/'),sha256:sha(readFileSync(file))}));
  if(mode==='source-before'){try{const previous=readFileSync(join(local,'source-before.json'));let index=1;while(true){try{readFileSync(join(local,`source-before-${index}.json`));index++;}catch{break;}}writeFileSync(join(local,`source-before-${index}.json`),previous);}catch{}}
  log(`${mode}.json`,entries);console.log(`${mode}: ${entries.length} source/build files hashed`);
  if(mode==='source-after')assert.deepEqual(entries,JSON.parse(readFileSync(join(local,'source-before.json'),'utf8')),'Production source/build changed during verification');
}else throw new Error('Unknown verification mode');
