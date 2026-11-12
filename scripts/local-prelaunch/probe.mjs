// Read-only evidence from the actual local production API container.
import {Pool} from 'pg';
import {readdir,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const mode=process.argv[2]??'status',instanceId=process.env.BB_LOCAL_PRELAUNCH_INSTANCE,database=process.env.BB_LOCAL_PRELAUNCH_DATABASE;
const target=new URL(process.env.DATABASE_URL);
if(process.env.BB_DEPLOYMENT_TIER!=='local'||target.hostname!=='postgres'||target.pathname!=='/'+database||!/^bb_billing_functional_[a-f0-9]{16}$/.test(database??''))throw Error('Local read-only probe identity mismatch');
const pool=new Pool({connectionString:target.href,max:1,connectionTimeoutMillis:10000,statement_timeout:10000,options:'-c default_transaction_read_only=on'});
try {
  const actual=(await pool.query('SELECT current_database() database')).rows[0].database;
  const markers=(await pool.query('SELECT instance_id FROM bb_local_billing_instance')).rows;
  if(actual!==database||markers.length!==1||markers[0].instance_id!==instanceId)throw Error('Database marker mismatch');
  const jobs=Number((await pool.query("SELECT count(*) n FROM bb_jobs WHERE state IN ('queued','running')")).rows[0].n);
  const messages=Number((await pool.query('SELECT count(*) n FROM bb_review_messages WHERE lease_token IS NOT NULL')).rows[0].n);
  const leasedJobs=Number((await pool.query('SELECT count(*) n FROM bb_jobs WHERE lease_token IS NOT NULL')).rows[0].n);
  const activeRuns=Number((await pool.query("SELECT count(*) n FROM bb_runs WHERE state IN ('preparing','queued','running','validating','delivering')")).rows[0].n);
  // Post-delivery diagnostics run outside the ordinary job lease. Retain the
  // same idle boundary used by authoring-only maintenance for full upgrades.
  const pendingFormatDiagnostics=Number((await pool.query(`SELECT count(*) n FROM bb_jobs j JOIN bb_runs r ON r.id=j.run_id
    WHERE r.task_kind IN ('update','generation','qa') AND r.state IN ('succeeded','test_completed') AND j.state IN ('succeeded','test_completed')
    AND (j.checkpoint #>> '{stages,word_delivery_pair,format_diagnostic,status}'='pending'
      OR (j.checkpoint #> '{stages,word_delivery_pair,format_diagnostic}') ? 'pending_report')`)).rows[0].n);
  if(mode==='authoring-idle') {
    // Authoring is restricted to update/generation/qa. Parsing may continue in its
    // separate service; even expired authoring leases block recreation.
    const authoringJobs=(await pool.query(`SELECT j.id,j.run_id,j.job_type,j.subtype,j.state,(j.lease_token IS NOT NULL) has_lease,j.lease_until
      FROM bb_jobs j LEFT JOIN bb_runs r ON r.id=j.run_id
      WHERE (r.task_kind IN ('update','generation','qa') OR (r.id IS NULL AND j.job_type<>'parse'))
      AND (j.state IN ('queued','running') OR j.lease_token IS NOT NULL) ORDER BY j.created_at`)).rows;
    const authoringRuns=(await pool.query("SELECT id,task_kind,state,input_revision,input_hash FROM bb_runs WHERE task_kind IN ('update','generation','qa') AND state IN ('preparing','queued','running','validating','delivering') ORDER BY created_at")).rows;
    const formatDiagnostics=(await pool.query(`SELECT j.id,j.run_id FROM bb_jobs j JOIN bb_runs r ON r.id=j.run_id
      WHERE r.task_kind IN ('update','generation','qa') AND r.state IN ('succeeded','test_completed') AND j.state IN ('succeeded','test_completed')
      AND (j.checkpoint #>> '{stages,word_delivery_pair,format_diagnostic,status}'='pending'
        OR (j.checkpoint #> '{stages,word_delivery_pair,format_diagnostic}') ? 'pending_report')`)).rows;
    const idle=authoringJobs.length===0&&authoringRuns.length===0&&formatDiagnostics.length===0;
    console.log(JSON.stringify({identity:true,authoringJobs,authoringRuns,formatDiagnostics,idle,
      parallelWorkload:{queuedOrRunningJobs:jobs,leasedJobs,leasedMessages:messages,activeRuns,pendingFormatDiagnostics}}));
    if(!idle)process.exitCode=76;
  }else if(mode==='idle') {
    const jobStates=(await pool.query('SELECT id,run_id,job_type,subtype,state,(lease_token IS NOT NULL) has_lease,lease_until,attempts FROM bb_jobs ORDER BY created_at')).rows;
    const runStates=(await pool.query('SELECT id,task_kind,state,input_revision,input_hash FROM bb_runs ORDER BY created_at')).rows;
    console.log(JSON.stringify({identity:true,queuedOrRunningJobs:jobs,leasedJobs,leasedMessages:messages,activeRuns,pendingFormatDiagnostics,jobStates,runStates,
      idle:jobs===0&&messages===0&&leasedJobs===0&&activeRuns===0&&pendingFormatDiagnostics===0}));
    if(jobs||messages||leasedJobs||activeRuns||pendingFormatDiagnostics)process.exitCode=76;
  }else if(mode==='status') {
    const applied=new Set((await pool.query('SELECT filename FROM bb_schema_migrations')).rows.map(row=>row.filename));
    const expected=(await readdir('/app/db/migrations')).filter(name=>/^\d+.*\.sql$/.test(name));
    const missing=expected.filter(name=>!applied.has(name));
    const workers=(await pool.query("SELECT split_part(worker_id,'_',1) worker_group,max(last_seen_at) last_seen_at,count(*)::int processes FROM bb_worker_heartbeats WHERE stopped_at IS NULL AND last_seen_at>now()-interval '90 seconds' GROUP BY 1 ORDER BY 1")).rows;
    const [ready,local]=await Promise.all([fetch('http://127.0.0.1:3000/api/v1/ready'),fetch('http://127.0.0.1:3000/__prelaunch/status')]);
    const readiness=await ready.json(),localStatus=await local.json();
    const diskBootHashes=Object.fromEntries(await Promise.all(['api-entry.mjs','../billing-functional/provider.mjs','../billing-functional/payment-controls.mjs'].map(async name=>
      [name,createHash('sha256').update(await readFile(new URL(name,import.meta.url))).digest('hex')])));
    const bootMatches=Object.entries(diskBootHashes).every(([name,hash])=>localStatus.loaded_boot_hashes?.[name]===hash);
    const good=bootMatches&&missing.length===0&&['authoring','review','parse'].every(group=>workers.some(row=>row.worker_group===group))&&ready.ok&&local.ok&&localStatus.instance_id===instanceId;
    console.log(JSON.stringify({ready:good,identity:true,bootMatches,diskBootHashes,schema:{expected:expected.length,applied:applied.size,missing},workers,readiness,localStatus,workload:{queuedOrRunningJobs:jobs,leasedJobs,leasedMessages:messages,activeRuns,pendingFormatDiagnostics}}));
    if(!good)process.exitCode=75;
  }else throw Error('Probe mode');
}catch(error) {console.error(JSON.stringify({probe_failed:true,error_code:error.code??null,connection_details_withheld:true}));process.exitCode=77;}
finally{await pool.end();}
