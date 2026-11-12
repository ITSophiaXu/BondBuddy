// Run before session-based acceptance. It refuses active work through stop.mjs.
import {fileURLToPath} from 'node:url';
import {delegate,readConfig} from './config.mjs';
import {command,docker,sql,writeReceipt} from './runtime.mjs';
import {inspectStatus} from './status.mjs';
delegate(fileURLToPath(import.meta.url));
const config=readConfig();
async function volumes() {
  const names=(await docker(['volume','ls','--filter',`label=com.docker.compose.project=${config.projectName}`,'--format','{{.Name}}'])).stdout.trim().split(/\s+/).filter(Boolean);
  return JSON.parse((await docker(['volume','inspect',...names])).stdout).map(volume=>({name:volume.Name,createdAt:volume.CreatedAt,instance:volume.Labels['io.bondbuddy.local-prelaunch.instance']})).sort((a,b)=>a.name.localeCompare(b.name));
}
const databaseSnapshot=()=>sql(config,"SELECT json_build_object('database',current_database(),'instance',(SELECT instance_id FROM bb_local_billing_instance),'schema',(SELECT count(*) FROM bb_schema_migrations),'users',(SELECT count(*) FROM bb_users),'projects',(SELECT count(*) FROM bb_projects),'runs',(SELECT count(*) FROM bb_runs),'jobs',(SELECT count(*) FROM bb_jobs))::text;");
let initial;
for(let attempt=0;attempt<30;attempt++) {
  initial=await inspectStatus(config);
  if(initial.ready)break;
  if(attempt%5===0)console.log('Waiting for local host/container readiness before lifecycle smoke.');
  await new Promise(resolve=>setTimeout(resolve,2000));
}
if(!initial.ready||initial.checks.workload.queuedOrRunningJobs||initial.checks.workload.leasedMessages||initial.checks.workload.leasedJobs||initial.checks.workload.activeRuns)throw Error('Lifecycle smoke requires a ready idle local environment.');
const beforeVolumes=await volumes(),beforeDatabase=await databaseSnapshot(),beforeContainers=initial.services.map(service=>service.id).sort();
console.log('Checking repeated start preserves current container identities.');
await command('node',['scripts/local-prelaunch/start.mjs']);
const repeated=await inspectStatus(config);
const repeatedStart=JSON.stringify(repeated.services.map(service=>service.id).sort())===JSON.stringify(beforeContainers);
console.log('Checking graceful idle stop preserves every named volume.');
await command('node',['scripts/local-prelaunch/stop.mjs']);
const stoppedVolumes=await volumes(),stopPreservesVolumes=JSON.stringify(beforeVolumes)===JSON.stringify(stoppedVolumes);
console.log('Checking restart retains the database marker and data counts.');
await command('node',['scripts/local-prelaunch/start.mjs']);
const restarted=await inspectStatus(config),afterDatabase=await databaseSnapshot();
const restartPreservesData=restarted.ready&&beforeDatabase===afterDatabase&&JSON.stringify(beforeVolumes)===JSON.stringify(await volumes());
const receipt={instanceId:config.instanceId,checkedAt:new Date().toISOString(),beforeVolumes,beforeDatabase:JSON.parse(beforeDatabase),afterDatabase:JSON.parse(afterDatabase),checks:{repeatedStart,stopPreservesVolumes,restartPreservesData},passed:[repeatedStart,stopPreservesVolumes,restartPreservesData].filter(Boolean).length,total:3,syntheticInput:true,realModelCalls:0};
writeReceipt('lifecycle',receipt);
console.log(JSON.stringify({lifecycle:receipt.checks,passed:receipt.passed,total:3,origin:config.origin}));
if(receipt.passed!==3)process.exitCode=1;
