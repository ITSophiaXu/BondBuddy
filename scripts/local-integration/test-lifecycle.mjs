import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createServer} from 'node:net';
import {Pool} from 'pg';
import {startServices,stopServices} from './lifecycle.mjs';
import {identity,sameIdentity,terminate,inspect,consoleState,withLifecycleLock} from './processes.mjs';
import {runtime,repo,databaseURL,ports,environment} from './config.mjs';

if(process.argv.includes('--hold-lock')){
  await withLifecycleLock(runtime,async()=>{
    console.log('LOCKED');await new Promise(()=>{setInterval(()=>{},1000);});
  });
}else{
  const file=join(runtime,'services.json'),read=()=>JSON.parse(readFileSync(file,'utf8'));
  const proof={checkedAt:new Date().toISOString(),checks:[]};
  const check=name=>{proof.checks.push(name);console.log('PASS '+name);};
  const counts=async()=>{
    const pool=new Pool({connectionString:databaseURL});
    try{return(await pool.query(`SELECT (SELECT count(*)::int FROM bb_projects) projects,
      (SELECT count(*)::int FROM bb_material_versions) materials,(SELECT count(*)::int FROM bb_runs) runs`)).rows[0];}
    finally{await pool.end();}
  };
  try{
    const baseline=read();assert.equal(baseline.phase,'database-only','Run first with --database-only and no acceptance users active');
    proof.before=await counts();
    await withLifecycleLock(runtime,async()=>{
      const before=readFileSync(file,'utf8');
      await assert.rejects(startServices(),/Another local lifecycle operation/);
      assert.equal(readFileSync(file,'utf8'),before);
    });check('concurrent start refused without changing state');

    const child=spawn(process.execPath,[join(repo,'scripts/local-integration/test-lifecycle.mjs'),'--hold-lock'],
      {cwd:repo,env:environment(),windowsHide:true,stdio:['ignore','pipe','pipe']});
    const closed=once(child,'close');
    const childRef=identity(child.pid);
    try{
      await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(Error('Crash probe lock timed out')),10000);
        child.once('error',reject);child.once('exit',()=>reject(Error('Crash probe exited early')));
        child.stdout.on('data',data=>{if(String(data).includes('LOCKED')){clearTimeout(timer);resolve();}});
      });
      terminate(childRef);await closed;
      // Pipe closure releases the helper mutex after an abrupt parent exit.
      let released=false;
      for(let attempt=0;attempt<20&&!released;attempt++){
        try{await withLifecycleLock(runtime,async()=>{});released=true;}
        catch(error){if(!/Another local lifecycle/.test(String(error)))throw error;await new Promise(r=>setTimeout(r,100));}
      }
      assert.ok(released);check('mutex recovers after launcher crash');
    }finally{const remaining=identity(child.pid);if(remaining&&sameIdentity(remaining,childRef))terminate(childRef);}

    const server=createServer();server.listen(ports.web,'127.0.0.1');await once(server,'listening');
    try{
      const before=readFileSync(file,'utf8');
      await assert.rejects(startServices(),/occupied by unowned PID/);
      assert.equal(readFileSync(file,'utf8'),before);assert.ok(server.listening);
    }finally{await new Promise(r=>server.close(r));}
    check('occupied port preserves foreign listener and existing state');

    const original=read(),bad=structuredClone(original);bad.processes.postgres.createdTicks='0';
    writeFileSync(file,JSON.stringify(bad));
    try{
      await assert.rejects(stopServices(),/different process generation/);
      assert.ok(sameIdentity(identity(original.processes.postgres.pid),original.processes.postgres));
    }finally{writeFileSync(file,JSON.stringify(original,null,2));}
    check('mismatched process generation refuses stop');

    let failedBlob;
    await assert.rejects(startServices({afterStart:async(name,state)=>{
      if(name==='blob'){failedBlob=state.processes.blob;throw Error('injected partial start failure');}
    }}),/injected partial start failure/);
    assert.equal(identity(failedBlob.pid),null);assert.deepEqual(Object.keys(read().processes),['postgres']);
    assert.ok(sameIdentity(read().processes.postgres,original.processes.postgres));
    check('partial startup rollback removes only newly started service');

    // A receipt captured from the actual terminated service models stale state after a crash.
    const stale=read();stale.processes.blob=failedBlob;writeFileSync(file,JSON.stringify(stale,null,2));
    const full=await startServices();assert.equal(full.ready,true);
    assert.ok(!sameIdentity(full.processes.blob,failedBlob));
    check('dead process receipt is reconciled and missing services start');

    const reused=await startServices();
    for(const [name,ref] of Object.entries(full.processes))assert.ok(sameIdentity(reused.processes[name],ref));
    check('repeated startup reuses every process fingerprint');
    proof.running=Object.fromEntries(Object.entries(reused.processes).map(([name,ref])=>[name,consoleState(ref)]));
    for(const snapshot of Object.values(proof.running))assert.equal(snapshot.windows.filter(w=>w.visible).length,0);
    check('all five service trees have zero visible windows');

    await stopServices();assert.deepEqual(read().processes,{});
    assert.equal(inspect([]).listeners.filter(l=>Object.values(ports).includes(l.port)).length,0);
    await stopServices();assert.deepEqual(read().processes,{});
    check('ordered stop and repeated stop clear owned processes and listeners');

    const restored=await startServices();assert.equal(restored.ready,true);
    proof.after=await counts();assert.deepEqual(proof.after,proof.before);
    proof.restored=Object.fromEntries(Object.entries(restored.processes).map(([name,ref])=>[name,consoleState(ref)]));
    for(const snapshot of Object.values(proof.restored))assert.equal(snapshot.windows.filter(w=>w.visible).length,0);
    check('restart retains all project/material/run counts with no visible windows');
    proof.passed=true;
  }finally{writeFileSync(join(runtime,'lifecycle-console-proof.json'),JSON.stringify(proof,null,2));}
}
