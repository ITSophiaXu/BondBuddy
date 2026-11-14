// Opt-in real Docker namespace/crash recovery. Model subprocesses are explicit
// Node stand-ins; this is failure-safety evidence, not real supplier capacity.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
const enabled=process.env.BB_TEST_MODEL_CAPACITY_DOCKER==='1';
const root=resolve(import.meta.dirname,'../../..');
const docker=(...args)=>execFileSync('docker',args,{encoding:'utf8'}).trim();
const until=async check=>{for(let i=0;i<200;i++){if(await check())return;await delay(50);}throw Error('Owned lifecycle fixture did not settle');};
const image='mcr.microsoft.com/azure-storage/azurite:3.35.0';
test('inspect and query timeouts retain holders and release both deployment locks',()=>{
 const proof=execFileSync('python3',['-c',String.raw`
import fcntl, importlib.util, json, os, pathlib, subprocess, sys, tempfile
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('reconcile',sys.argv[1])
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
proof=[]
for failure in ['inspect','exec']:
    with tempfile.TemporaryDirectory() as folder:
        state=pathlib.Path(folder)
        for name in ['config.lock','deploy.lock']: (state/name).touch()
        calls=[]
        def checked(args,**kwargs):
            calls.append((args,kwargs))
            if args[1]=='inspect':
                assert kwargs['timeout']==10
                if failure=='inspect': raise subprocess.TimeoutExpired(args,10)
                return json.dumps([{'Id':'owned-fixture','State':{'Running':True},'Config':{'Labels':{'com.docker.compose.project':'bb-execution','com.docker.compose.service':'worker'}}}]).encode()
            assert args[1]=='exec' and kwargs['timeout']==20
            assert all(item in args[-1] for item in ['connectionTimeoutMillis:5000','query_timeout:10000','statement_timeout:10000'])
            assert json.loads(kwargs['input'])['sql'].startswith('SELECT ')
            raise subprocess.TimeoutExpired(args,20)
        with patch.object(sys,'argv',['reconcile','--apply','--query-container','fixture','--locked-state',folder]),patch.object(module.subprocess,'check_output',checked):
            try: module.main()
            except subprocess.TimeoutExpired: pass
            else: raise AssertionError('timeout must fail, not report successful reclaim')
        for name in ['config.lock','deploy.lock']:
            with open(state/name,'w') as lock: fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        assert not any(b'DELETE ' in kwargs.get('input',b'') for _,kwargs in calls)
        proof.append({'failure':failure,'delete_sent':False,'both_locks_released':True})
print(json.dumps(proof))
 `,resolve(root,'deploy/m1/scripts/model-capacity-reconcile.py')],{encoding:'utf8',timeout:10000});
 assert.deepEqual(JSON.parse(proof),['inspect','exec'].map(failure=>({failure,delete_sent:false,both_locks_released:true})));
});
test('live namespace retains all four permits; SIGKILL/recreate proves exit and restores capacity',{skip:!enabled,timeout:60000},async t=>{
 const url=new URL(process.env.BB_TEST_DATABASE_URL);
 assert.equal(url.hostname,'127.0.0.1');assert.match(url.pathname,/^\/bb1348/);
 const database=`bb1348_lifecycle_${process.pid}`,maintenance=new URL(url);maintenance.pathname='/postgres';
 const admin=new Pool({connectionString:maintenance.toString()});
 await admin.query(`CREATE DATABASE "${database}"`);
 const local=new URL(url);local.pathname=`/${database}`;
 const pool=new Pool({connectionString:local.toString()});
 await pool.query(readFileSync(resolve(root,'db/migrations/0179_model_call_capacity.sql'),'utf8'));
 const hostIdentity=createHash('sha256').update(readFileSync('/etc/machine-id')).digest('hex');
 const control=`bb1348-recovery-control-${process.pid}`,name=`bb1348-recovery-holder-${process.pid}`;
 const inside=`postgresql://postgres@bb1348-budget-pg:5432/${database}`;
 const base=['run','-d','--pull=never','--label','bondbuddy.test=1348','--network','bb1348-budget-test','--cpus','.25','--memory','384m','--memory-swap','384m','-v',`${root}:/test:ro`,'-w','/test','-e',`DATABASE_URL=${inside}`,'-e',`BB_MODEL_EXECUTION_HOST_ID=${hostIdentity}`,'--entrypoint','node'];
 const script=`import {Pool} from 'pg';import {spawn} from 'node:child_process';import {PgModelCallBudget} from './apps/worker/dist/model-call-budget.js';const p=new Pool({connectionString:process.env.DATABASE_URL});const b=new PgModelCallBudget(p);for(let i=0;i<Number(process.env.SLOTS);i++){const permit=await b.acquire(undefined,'container:'+i);const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore',env:{...process.env,CODEX_HOME:'/tmp/synthetic-'+i}});await permit.bindProcess(child.pid,'/tmp/synthetic-'+i);}console.log('synthetic-permits-ready');setInterval(()=>{},1000);`;
 const start=n=>docker(...base,'--name',name,'-e',`SLOTS=${n}`,image,'--input-type=module','-e',script);
 const reconcile=apply=>JSON.parse(execFileSync('sudo',['python3',resolve(root,'deploy/m1/scripts/model-capacity-reconcile.py'),'--synthetic','--query-container',control,...(apply?['--apply']:[])],{encoding:'utf8'}));
 t.after(async()=>{
  for(const c of [name,control]) {try{docker('stop','--time','2',c);docker('rm',c);}catch{}}
  await pool.end();await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);await admin.end();
 });
 docker(...base,'--name',control,image,'-e','setInterval(()=>{},1000)');
 const old=start(4);await until(async()=>(await pool.query('SELECT count(*)::integer n FROM bb_model_capacity_holders WHERE child_pid IS NOT NULL')).rows[0].n===4);
 const retained=reconcile(true);assert.equal(retained.holders.length,4);assert.ok(retained.holders.every(h=>!h.released&&h.reason==='retain_live_namespace'));
 const prior=(await pool.query('SELECT host_id,pid_namespace,namespace_init_start FROM bb_model_capacity_holders LIMIT 1')).rows[0];
 docker('kill','--signal','KILL',name);assert.equal(JSON.parse(docker('inspect',name))[0].State.Running,false);docker('rm',name);
 const replacement=start(1);assert.notEqual(replacement,old);
 await until(async()=>(await pool.query('SELECT count(*)::integer n FROM bb_model_capacity_waiters')).rows[0].n===1);
 assert.equal((await pool.query('SELECT count(*)::integer n FROM bb_model_capacity_holders')).rows[0].n,4,'recreate cannot use new namespace proc numbers as exit evidence');
 const recovered=reconcile(true);t.diagnostic(JSON.stringify({recovery:recovered,old_namespace:prior,new_container:JSON.parse(docker('inspect',name))[0].State.Pid}));assert.equal(recovered.holders.filter(h=>h.released).length,4);assert.ok(recovered.holders.every(h=>['namespace_absence_proves_exit','namespace_replacement_proves_exit'].includes(h.reason)));
 await until(async()=>(await pool.query('SELECT count(*)::integer n FROM bb_model_capacity_holders WHERE child_pid IS NOT NULL')).rows[0].n===1);
 const current=(await pool.query('SELECT host_id,pid_namespace,namespace_init_start FROM bb_model_capacity_holders')).rows[0];assert.notEqual(current.host_id,prior.host_id);assert.ok(current.pid_namespace!==prior.pid_namespace || current.namespace_init_start!==prior.namespace_init_start,'namespace generation must differ even if kernel recycles its inode');
 const stillLive=reconcile(true);assert.equal(stillLive.holders.length,1);assert.equal(stillLive.holders[0].released,false);
 t.diagnostic(JSON.stringify({old_id:old,new_id:replacement,retained:retained.holders.map(h=>({token:h.token,reason:h.reason})),recovered:recovered.holders.map(h=>({token:h.token,reason:h.reason,released:h.released})),new_namespace:current.pid_namespace}));
});
