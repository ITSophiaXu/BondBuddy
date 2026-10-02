import { Pool } from 'pg';
import { listOperatorReconciliations, resolveOperatorReconciliation, repairUnifiedTimeoutRetry, requeueGeneratedWordDelivery, type OperatorReconcileDecision } from '@bondbuddy/api/queue';

const usage = 'usage: reconcile-run list | resolve <run_id> <attempt_id> <retry_unknown_usage|fail_run> <reason_code> | repair-timeout-retry <run_id> <attempt_id> | deliver-generated-pair <run_id>';

export async function runReconcileCommand(pool:Pool,args:string[],actor:string) {
  if(args.length===1 && args[0]==='list')return listOperatorReconciliations(pool);
  if(args.length===2 && args[0]==='deliver-generated-pair')return requeueGeneratedWordDelivery(pool,{runId:args[1]!,actor});
  if(args.length===3 && args[0]==='repair-timeout-retry')return repairUnifiedTimeoutRetry(pool,{runId:args[1]!,attemptId:args[2]!,actor});
  if(args.length===5 && args[0]==='resolve') {
    const [,runId,attemptId,decision,reasonCode]=args;
    return resolveOperatorReconciliation(pool,{runId:runId!,attemptId:attemptId!,decision:decision as OperatorReconcileDecision,reasonCode:reasonCode!,actor});
  }
  throw new Error(usage);
}

if(process.argv[1]?.endsWith('/reconcile-run.js')){
  const pool=new Pool({connectionString:process.env.DATABASE_URL});
  runReconcileCommand(pool,process.argv.slice(2),process.env.BB_RECONCILE_ACTOR??'').then(result=>{
    process.stdout.write(JSON.stringify(result)+'\n');
  }).catch(error=>{process.stderr.write(`${error instanceof Error?error.message:'reconciliation failed'}\n`);process.exitCode=1;})
    .finally(()=>pool.end());
}
