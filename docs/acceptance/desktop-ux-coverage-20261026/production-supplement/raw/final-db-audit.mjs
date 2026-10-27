import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {spawnSync} from 'node:child_process';
import net from 'node:net';
const root=process.cwd(),out=resolve(root,'.local/production-supplement-20261027/final-db');
await mkdir(out,{recursive:true});
const data=resolve(root,'.local/test-successor-postgres/data');
const expectedExe='C:/Users/lezhai/Downloads/Bondbuddy/.m3-test-tools/node_modules/@embedded-postgres/windows-x64/native/bin/postgres.exe';
const ctl=expectedExe.replace(/postgres\.exe$/,'pg_ctl.exe');
const norm=p=>p.replaceAll('\\','/').toLowerCase();
const ps='C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const identity=()=>spawnSync(ps,['-NoProfile','-NonInteractive','-Command','Get-Process -Id 17984 -ErrorAction Stop | Select-Object Id,Path,StartTime | ConvertTo-Json -Depth 3'],{encoding:'utf8',windowsHide:true});
const proc=identity();await writeFile(join(out,'process-before.json'),JSON.stringify(proc,null,2));
assert.equal(proc.status,0,proc.stderr);const p=JSON.parse(proc.stdout);assert.equal(p.Id,17984);assert.equal(norm(p.Path),norm(expectedExe));
assert.equal(Number(p.StartTime.match(/Date\((\d+)\)/)[1]),1793065351991);
const pidText=await readFile(join(data,'postmaster.pid'),'utf8');await writeFile(join(out,'postmaster-pid.txt'),pidText);assert.equal(Number(pidText.split(/\r?\n/)[0]),17984);
const pool=new Pool({connectionString:'postgresql://bb_successor_test@127.0.0.1:15542/postgres',max:1});
let audit;
try {
 const settings=(await pool.query("SELECT current_setting('data_directory') AS data_directory,current_setting('port') AS port,pg_postmaster_start_time() AS postmaster_start_time")).rows[0];
 assert.equal(norm(settings.data_directory),norm(data));assert.equal(settings.port,'15542');
 const databases=(await pool.query('SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname')).rows;
 const clients=(await pool.query("SELECT pid,datname,usename,application_name,state,backend_start FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND datname IS NOT NULL AND backend_type='client backend' ORDER BY pid")).rows;
 const templates=[];
 for(const name of ['bb_prod_supplement01_20261027','bb_prod_supplement02_20261027','bb_segments_final02_20261027']) {
  if(!databases.some(d=>d.datname===name))continue;
  const part=new Pool({connectionString:'postgresql://bb_successor_test@127.0.0.1:15542/'+name,max:1});
  try {const counts=(await part.query('SELECT (SELECT count(*)::int FROM bb_runs) AS runs,(SELECT count(*)::int FROM bb_jobs) AS jobs,(SELECT count(*)::int FROM bb_run_supplement_quotes) AS supplement_quotes')).rows[0];templates.push({name,counts,preserved:true});}finally{await part.end();}
 }
 const clones=databases.filter(d=>/^bb_prod_supplement02_20261027_t\d+_[a-f0-9]{8}$/.test(d.datname));
 audit={auditedAt:new Date().toISOString(),settings,databases,clients,ownedClonesRemaining:clones,templates,databasesDropped:[]};
 await writeFile(join(out,'database-audit.json'),JSON.stringify(audit,null,2));
 assert.equal(clones.length,0,'Owned production supplement test clones remain');assert.equal(clients.length,0,'Other clients still connected');
} finally {await pool.end();}
if(!process.argv.includes('--stop')){console.log(JSON.stringify({audited:true,stopped:false}));process.exit(0);}
// All identities above are exact; stop only this task-owned service, preserving all data.
const last=identity();assert.equal(last.status,0);assert.deepEqual(JSON.parse(last.stdout),p);
const stopped=spawnSync(ctl,['-D',data,'stop','-m','fast','-w','-t','30'],{encoding:'utf8',windowsHide:true});
await writeFile(join(out,'shutdown-result.json'),JSON.stringify({stoppedAt:new Date().toISOString(),status:stopped.status,signal:stopped.signal,stdout:stopped.stdout,stderr:stopped.stderr},null,2));
assert.equal(stopped.status,0,stopped.stderr);
const after=identity();await writeFile(join(out,'process-after.json'),JSON.stringify(after,null,2));assert.notEqual(after.status,0,'Owned PID remains');
const listening=await new Promise(resolve=>{const s=net.connect({host:'127.0.0.1',port:15542});s.once('connect',()=>{s.destroy();resolve(true)});s.once('error',()=>resolve(false));s.setTimeout(3000,()=>{s.destroy();resolve(true)});});
assert.equal(listening,false);await writeFile(join(out,'summary.json'),JSON.stringify({audited:true,exactIdentityVerified:true,postmasterPid:17984,port:15542,stopped:true,portListening:listening,allDatabasesPreserved:true},null,2));
console.log(JSON.stringify({audited:true,stopped:true,portListening:listening}));
