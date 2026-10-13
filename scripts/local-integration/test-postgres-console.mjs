import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {Client} from 'pg';
import {runtime,databaseURL} from './config.mjs';
import {consoleState,withLifecycleLock} from './processes.mjs';

// Uses only a newly created, disposable database. Observe windows while backends live.
await withLifecycleLock(runtime,async()=>{
  const state=JSON.parse(readFileSync(join(runtime,'services.json'),'utf8'));
  assert.equal(state.schemaVersion,2);
  const root=state.processes.postgres;
  const admin=new Client({connectionString:databaseURL,connectionTimeoutMillis:10000});
  const name=`bb_console_probe_${Date.now()}`,evidence={checkedAt:new Date().toISOString(),database:name,batches:[]};
  const sample=()=>{
    const snapshot=consoleState(root);
    assert.equal(snapshot.windows.filter(w=>w.visible).length,0,'No owned window may be visible');
    assert.equal(snapshot.processes.filter(p=>p.name.toLowerCase()==='conhost.exe').length,1,'Backends must inherit one hidden console');
    return snapshot;
  };
  let created=false;
  try{
    await admin.connect();
    evidence.counts=(await admin.query(`SELECT (SELECT count(*)::int FROM bb_projects) projects,
      (SELECT count(*)::int FROM bb_material_versions) materials,(SELECT count(*)::int FROM bb_runs) runs`)).rows[0];
    evidence.jobs=(await admin.query('SELECT state,count(*)::int AS count FROM bb_jobs GROUP BY state')).rows;
    evidence.before=sample();
    await admin.query(`CREATE DATABASE ${name}`);created=true;
    for(let batch=0;batch<5;batch++){
      const clients=Array.from({length:10},()=>new Client({connectionString:databaseURL.replace(/\/[^/]+$/,'/'+name),connectionTimeoutMillis:10000}));
      try{
        await Promise.all(clients.map(c=>c.connect()));
        const pids=await Promise.all(clients.map(async c=>(await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid));
        const during=sample();
        for(const pid of pids)assert.ok(during.processes.some(p=>p.pid===pid),'Each live backend must be in the observed tree');
        evidence.batches.push({batch,pids,snapshot:during});
      }finally{await Promise.all(clients.map(c=>c.end()));}
      sample();
    }
    evidence.after=sample();evidence.passed=true;
  }finally{
    if(created)await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
    writeFileSync(join(runtime,'console-postgres-proof.json'),JSON.stringify(evidence,null,2));
  }
  console.log(JSON.stringify({passed:evidence.passed,connections:50,conhosts:1,visibleOwnedWindows:0,counts:evidence.counts,jobs:evidence.jobs}));
});
