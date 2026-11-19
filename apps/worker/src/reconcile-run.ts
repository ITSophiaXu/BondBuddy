import {seedFileAuthoringRun} from './file-authoring-seed.js';
import { Pool } from 'pg';
import { listOperatorReconciliations, resolveOperatorReconciliation, repairUnifiedTimeoutRetry, requeueGeneratedWordDelivery, requeueFailedReviewAssembly, type OperatorReconcileDecision } from '@bondbuddy/api/queue';
import { azureBlobs, type PrivateBlobs } from '@bondbuddy/api/data';

const usage = 'usage: reconcile-run seed-authoring-new-run <source_run_id> <target_run_id> <budget_minutes:1..90> | list | resolve <run_id> <attempt_id> <retry_unknown_usage|fail_run> <reason_code> | repair-timeout-retry <run_id> <attempt_id> | deliver-generated-pair <run_id> | reassemble-review <run_id> <attempt_id> <result_sha256>';

export async function runReconcileCommand(pool:Pool,args:string[],actor:string,blobs?:PrivateBlobs) {
  if(args.length===4 && args[0]==='seed-authoring-new-run'){
    if(!blobs||!/^([1-9]|[1-8][0-9]|90)$/.test(args[3]!))throw new Error(usage);
    return seedFileAuthoringRun(pool,blobs,{sourceRunId:args[1]!,targetRunId:args[2]!,budgetMs:Number(args[3])*60000,actor});
  }
  if(args.length===1 && args[0]==='list')return listOperatorReconciliations(pool);
  if(args.length===2 && args[0]==='deliver-generated-pair')return requeueGeneratedWordDelivery(pool,{runId:args[1]!,actor});
  if(args.length===3 && args[0]==='repair-timeout-retry')return repairUnifiedTimeoutRetry(pool,{runId:args[1]!,attemptId:args[2]!,actor});
  if(args.length===4 && args[0]==='reassemble-review'){
    if(!blobs)throw new Error('Review reassembly requires private Blob evidence');
    return requeueFailedReviewAssembly(pool,blobs,{runId:args[1]!,attemptId:args[2]!,resultSha256:args[3]!,actor});
  }
  if(args.length===5 && args[0]==='resolve') {
    const [,runId,attemptId,decision,reasonCode]=args;
    return resolveOperatorReconciliation(pool,{runId:runId!,attemptId:attemptId!,decision:decision as OperatorReconcileDecision,reasonCode:reasonCode!,actor});
  }
  throw new Error(usage);
}

if(process.argv[1]?.endsWith('/reconcile-run.js')){
  const pool=new Pool({connectionString:process.env.DATABASE_URL});
  const blobs=['reassemble-review','seed-authoring-new-run'].includes(process.argv[2]??'')&&process.env.AZURE_STORAGE_CONNECTION_STRING?azureBlobs(process.env.AZURE_STORAGE_CONNECTION_STRING):undefined;
  runReconcileCommand(pool,process.argv.slice(2),process.env.BB_RECONCILE_ACTOR??'',blobs).then(result=>{
    process.stdout.write(JSON.stringify(result)+'\n');
  }).catch(error=>{process.stderr.write(`${error instanceof Error?error.message:'reconciliation failed'}\n`);process.exitCode=1;})
    .finally(()=>pool.end());
}
