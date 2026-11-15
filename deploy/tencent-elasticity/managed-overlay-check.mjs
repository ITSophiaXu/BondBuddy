// One isolated verification pass over the two materialized component trees.
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,unlinkSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const [, ,authoring,review]=process.argv;
if(!authoring||!review||!process.env.BB_TEST_DATABASE_URL)throw Error('Usage: BB_TEST_DATABASE_URL=isolated-template node managed-overlay-check.mjs AUTHORING REVIEW');
const lock=JSON.parse(readFileSync(join(root,'deploy/tencent-elasticity/managed-overlay.lock.json')));
const names=process.argv.includes('--capacity-only')?['execution-node-capacity.pg.test']:['execution-node-capacity.pg.test','execution-node-multiprocess.pg.test','execution-node-drain-runtime.pg.test'];
const temporary=[];
try{
  for(const name of names){
    let source=execFileSync('git',['-C',root,'show',`${lock.infrastructure_sha}:apps/worker/src/${name}.ts`]).toString();
    // These capacity fixtures predate 0183. Supply its synthetic singleton ACK;
    // never remove the production acceptance check or change any tested behavior.
    const acknowledgements={
      'execution-node-capacity.pg.test':["state:'submitted',identity:i,provider_request_id:requestId,observation:null","state:'submitted',identity:i,provider_request_id:requestId,observation:null,...(op.action==='run'?{run_acceptance:overlayAcceptance(op,i,requestId)}:{})"],
      'execution-node-multiprocess.pg.test':["state:'submitted',provider_request_id:'native-ack',identity,observation:null","state:'submitted',provider_request_id:'native-ack',identity,observation:null,run_acceptance:overlayAcceptance(op,identity,'native-ack')"],
      'execution-node-drain-runtime.pg.test':["state:'submitted',identity,provider_request_id:'runtime-ack',observation:null","state:'submitted',identity,provider_request_id:'runtime-ack',observation:null,run_acceptance:overlayAcceptance(op,identity,'runtime-ack')"],
    };
    const [before,after]=acknowledgements[name];
    if(source.split(before).length!==2)throw Error('OVERLAY_TEST_FIXTURE_CHANGED');
    source=source.replace(before,after)+`\nfunction overlayAcceptance(op:any,identity:any,ack:string){return {operation_id:op.operation_id,identity,provider_request_id:ack,instance_ids:[identity.instance_id],client_token:op.client_token,launch_manifest_sha256:op.request.launch_manifest_sha256,launch_binding_sha256:op.request.launch_manifest_sha256,evidence_ref:'synthetic-overlay-acceptance',evidence_sha256:op.request.launch_manifest_sha256};}\n`;
    const completions={
      'execution-node-capacity.pg.test':["observation:observation(op.action,requestId)","observation:{...observation(op.action,requestId),...(op.action==='run'?{run_creation:overlayCreation(op,i)}:{})}"],
      'execution-node-multiprocess.pg.test':["evidence_ref:'synthetic-native-describe.json',evidence_sha256:hash}","evidence_ref:'synthetic-native-describe.json',evidence_sha256:hash,run_creation:overlayCreation(op,identity)}"],
      'execution-node-drain-runtime.pg.test':["evidence_ref:'synthetic-runtime-describe.json',evidence_sha256:hash}","evidence_ref:'synthetic-runtime-describe.json',evidence_sha256:hash,run_creation:overlayCreation(op,identity)}"],
    };
    const [original,completed]=completions[name];if(source.split(original).length!==2)throw Error('OVERLAY_COMPLETION_FIXTURE_CHANGED');
    source=source.replace(original,completed)+`\nfunction overlayCreation(op:any,identity:any){return {operation_id:op.operation_id,identity,launch_manifest_sha256:op.request.launch_manifest_sha256,launch_binding_sha256:op.request.launch_manifest_sha256,created_at:new Date().toISOString(),instance_status:'RUNNING',status_request_id:'synthetic-describe'};}\n`;
    if(name==='execution-node-capacity.pg.test'){
      const fifth="assert.equal((await pool.query('SELECT count(*)::int n FROM bb_model_capacity_holders')).rows[0].n,5);";
      if(source.split(fifth).length!==2)throw Error('OVERLAY_EIGHT_SLOT_FIXTURE_CHANGED');
      source=source.replace(fifth,fifth+`\n  const extraJobs:string[]=[],extraPermits:ModelCallPermit[]=[];
  for(let index=0;index<3;index++){const job=await claimJob(b1,await addJob());extraJobs.push(job.id);const permit=await budgetB.acquire(undefined,'b:eight:'+index,job);extraPermits.push(permit);permits.push(permit);}
  assert.equal((await pool.query('SELECT count(*)::int n FROM bb_model_capacity_holders')).rows[0].n,8);
  const ninthCancel=new AbortController();let ninthGranted=false;
  const ninth=budgetA2.acquire(ninthCancel.signal,'ninth:bounded',leasesA[1]).then(async permit=>{ninthGranted=true;await permit.release();},()=>{});
  await until(async()=>!!(await pool.query("SELECT 1 FROM bb_model_capacity_waiters WHERE scope='ninth:bounded'")).rowCount);await delay(100);assert.equal(ninthGranted,false);ninthCancel.abort();await ninth;
  await Promise.all(extraPermits.map(permit=>permit.release()));await pool.query("UPDATE bb_jobs SET state='cancelled',lease_token=NULL,lease_until=NULL WHERE id=ANY($1::text[])",[extraJobs]);
`);
    }
    const emitted=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
    const path=join(resolve(authoring),'apps/worker/dist',`${name}.js`);
    writeFileSync(path,emitted,{flag:'wx'});temporary.push(path);
  }
  execFileSync(process.execPath,['--test','--test-concurrency=1',...temporary],{cwd:resolve(authoring),env:process.env,stdio:'inherit'});
  if(!process.argv.includes('--capacity-only'))execFileSync(process.execPath,['--test',join(root,'deploy/tencent-elasticity/managed-overlay.pg.test.mjs')],{cwd:root,env:{...process.env,BB_MANAGED_AUTHORING_SOURCE:resolve(authoring),BB_MANAGED_REVIEW_SOURCE:resolve(review)},stdio:'inherit'});
}finally{for(const path of temporary)unlinkSync(path);}
