import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const [source,grantFile,url,output,migrationFile]=process.argv.slice(2), parsed=new URL(url);
assert.equal(parsed.protocol,'postgresql:'); assert.equal(parsed.hostname,'127.0.0.1'); assert.equal(parsed.username,'bondbuddy'); assert.equal(parsed.search,''); assert.equal(parsed.hash,''); assert.match(parsed.pathname,/^\/bb_1420_acl_[a-z0-9_]+$/);
const {Client}=createRequire(source+'/package.json')('pg');
const {persistPerformanceBatch}=await import(pathToFileURL(source+'/apps/api/dist/performance-store.js'));
const roles=['bb1361_formal_n1_author_v1','bb1361_formal_n1_review_v1','bb1361_formal_n2_author_v1','bb1361_formal_n2_review_v1'];
const db=new Client({connectionString:url}); await db.connect();
const results=[];
const sha=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
const check=async(name,fn)=>{await fn();results.push({name,status:'passed'});};
const denied=async(c,sql)=>assert.rejects(c.query(sql),e=>e.code==='42501');
async function write(c,s,p){await c.query('BEGIN');try{await persistPerformanceBatch(c,[s],[p]);await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}}
function records(i){
 const s={session_id:'session-'+i,owner_user_id:'synthetic-owner',project_id:'synthetic-project',run_id:'synthetic-run',job_id:'synthetic-job',trace_id:'synthetic-run',run_execution_id:'synthetic-exec-'+i,task_kind:'update',service_role:'synthetic-acl-test',worker_instance_id:'local-only',release_sha:'synthetic-1420',started_at:'2026-01-01T00:00:00.000Z',ended_at:null,last_flush_at:'2026-01-01T00:00:00.000Z',closed:false,generated:1,acknowledged:1,dropped:0,invalid_attributes:0,flush_errors:0,last_sequence:1,complete:false};
 const p={span_id:'span-'+i,owner_user_id:s.owner_user_id,run_id:s.run_id,session_id:s.session_id,run_execution_id:s.run_execution_id,trace_id:s.trace_id,job_id:s.job_id,parent_span_id:null,stage:'generation',step_key:'synthetic.permission',step_version:1,status:'running',started_at:s.started_at,ended_at:null,duration_ms:null,last_activity_at:s.started_at,clock_source:'monotonic',attributes:{},span_links:[],sequence:1};
 return [s,p];
}
try{
 await db.query(`CREATE TABLE bb_projects(owner_user_id text,id text,UNIQUE(owner_user_id,id));
 CREATE TABLE bb_runs(owner_user_id text,id text,project_id text,task_kind text,UNIQUE(owner_user_id,id));
 CREATE TABLE bb_jobs(id text,run_id text,owner_user_id text);
 CREATE TABLE synthetic_business_balance(id text,balance int);
 INSERT INTO bb_projects VALUES('synthetic-owner','synthetic-project');
 INSERT INTO bb_runs VALUES('synthetic-owner','synthetic-run','synthetic-project','update');
 INSERT INTO bb_jobs VALUES('synthetic-job','synthetic-run','synthetic-owner');
 INSERT INTO synthetic_business_balance VALUES('sentinel',42);`);
 await db.query(readFileSync(migrationFile,'utf8'));
 for(const role of roles)await db.query(`CREATE ROLE ${role} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE;
 GRANT USAGE ON SCHEMA public TO ${role};
 GRANT SELECT(id,owner_user_id,project_id,task_kind) ON bb_runs TO ${role};
 GRANT SELECT(id,run_id,owner_user_id) ON bb_jobs TO ${role};`);
 for(const [i,role] of roles.entries()){
  const u=new URL(url);u.username=role;const c=new Client({connectionString:u.href});await c.connect();
  try{await check(role+': writer denied before grant',()=>assert.rejects(write(c,...records(i)),e=>e.code==='42501'));}finally{await c.end();}
 }
 await db.query(readFileSync(grantFile,'utf8'));
 await check('grant is idempotent',()=>db.query(readFileSync(grantFile,'utf8')));
 for(const [i,role] of roles.entries()){
  const u=new URL(url);u.username=role;const c=new Client({connectionString:u.href});await c.connect();
  try{
   const [s,p]=records(i);
   await check(role+': actual writer inserts running session/span',()=>write(c,s,p));
   Object.assign(s,{closed:true,ended_at:'2026-01-01T00:00:01.000Z',last_flush_at:'2026-01-01T00:00:01.000Z',last_sequence:2,complete:true});
   Object.assign(p,{status:'succeeded',ended_at:s.ended_at,duration_ms:1000,last_activity_at:s.ended_at,sequence:2});
   await check(role+': actual writer updates and finalizes',async()=>{await write(c,s,p);const v=(await db.query('SELECT s.complete,p.status,p.duration_ms FROM bb_performance_sessions s JOIN bb_performance_spans p USING(session_id) WHERE s.session_id=$1',[s.session_id])).rows[0];assert.deepEqual(v,{complete:true,status:'succeeded',duration_ms:1000});});
   await check(role+': actual writer idempotent replay',()=>write(c,s,p));
   await check(role+': writer rejects invalid run owner',()=>assert.rejects(write(c,{...s,owner_user_id:'foreign'},p),/SCOPE_MISMATCH/));
   for(const [name,sql] of [
    ['session delete','DELETE FROM bb_performance_sessions'],['span delete','DELETE FROM bb_performance_spans'],
    ['truncate','TRUNCATE bb_performance_spans'],['session owner mutation',"UPDATE bb_performance_sessions SET owner_user_id='foreign'"],
    ['session run mutation',"UPDATE bb_performance_sessions SET run_id='foreign'"],['session purge',"UPDATE bb_performance_sessions SET purged_at=now()"],
    ['span owner mutation',"UPDATE bb_performance_spans SET owner_user_id='foreign'"],['span session mutation',"UPDATE bb_performance_spans SET session_id='foreign'"],
    ['recorded timestamp mutation','UPDATE bb_performance_spans SET recorded_at=now()'],
    ['recorded transaction insert',"INSERT INTO bb_performance_spans(recorded_xid) VALUES(pg_current_xact_id())"],
    ['business balance update','UPDATE synthetic_business_balance SET balance=0'],
   ])await check(role+': denies '+name,()=>denied(c,sql));
   await check(role+': no table-level insert/update or delete privilege',async()=>{const v=(await db.query("SELECT bool_or(has_table_privilege($1,t,p)) AS broad FROM unnest(ARRAY['bb_performance_sessions','bb_performance_spans']) t CROSS JOIN unnest(ARRAY['INSERT','UPDATE','DELETE','TRUNCATE']) p",[role])).rows[0];assert.equal(v.broad,false);});
  }finally{await c.end();}
 }
 await check('owner retains logs/purge access and balances unchanged',async()=>{assert.equal((await db.query('SELECT count(*)::int n FROM bb_performance_spans')).rows[0].n,4);assert.equal((await db.query('SELECT balance FROM synthetic_business_balance')).rows[0].balance,42);await db.query('DELETE FROM bb_performance_spans');});
 writeFileSync(output,JSON.stringify({status:'passed',local_only:true,synthetic:true,production_contacted:false,real_model_called:false,node:process.version,platform:process.platform,postgres:(await db.query('SELECT version()')).rows[0].version,writer_sha256:sha(source+'/apps/api/dist/performance-store.js'),migration_sha256:sha(migrationFile),grant_sha256:sha(grantFile),tests:results,passed:results.length,failed:0,skipped:0},null,2)+'\n');
 console.log(JSON.stringify({passed:results.length,failed:0,skipped:0,output}));
}finally{await db.end();}
