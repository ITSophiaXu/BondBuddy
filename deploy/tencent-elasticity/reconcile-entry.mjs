import {readPrivateJson, observationArchive} from './private-files.mjs';
import {ExecutionPoolController} from './controller.mjs';
import {TencentCvm, TencentTransport} from './tencent-cvm.mjs';
import {validateConfig, requireThat} from './policy.mjs';
import {produceExpenseSnapshot, costAdmission} from './costcap.mjs';
import {createSocketCredentialProvider} from './control-socket.mjs';
import {acquireControlTick} from './control-tick-bound.mjs';
import {refreshCloudQuote} from './cloud-quote-refresh.mjs';

// Explicit invocation inside the existing ops service. No background scheduling.
const [action, configPath, requestPath, opId] = process.argv.slice(2);
let pool,releaseTick;
try {
  requireThat(['plan', 'start', 'drain', 'recover'].includes(action), 'ACTION_REQUIRED');
  const baseConfig = validateConfig(await readPrivateJson(configPath), {apply: action !== 'plan',expenditure:action==='start'});
  let config=structuredClone(baseConfig);
  releaseTick=await acquireControlTick(config.registration_directory);requireThat(releaseTick,'CONTROL_TICK_BUSY');
  const {Pool} = await import('pg');
  const {executionCapacityControl,executionCloudExpenseLedger} = await import('@bondbuddy/api/execution-capacity');
  pool = new Pool({connectionString: process.env.DATABASE_URL, max: 2, connectionTimeoutMillis: 5000, query_timeout: 10000});
  const control = executionCapacityControl(pool);
  const credentialsProvider=createSocketCredentialProvider(config.control_credential_provider);
  const transport = new TencentTransport({region: config.region,credentials: () => credentialsProvider.get()});
  const cloud = new TencentCvm({transport, config, archive: observationArchive(config.observation_directory)});
  const costSnapshot=async inventory=>{
    const ledger=await executionCloudExpenseLedger(pool),fresh=await refreshCloudQuote({configPath,config:baseConfig,transport,capturedAt:ledger.captured_at});
    config=fresh.config;controller.config=config;cloud.config=config;
    return produceExpenseSnapshot({ledger,inventory,quote:fresh.quote,config});
  };
  const controller = new ExecutionPoolController({control, cloud, config, costSnapshot});
  const syncBudget=async()=>{
    let admission={allowed:false};
    try{const inventory=await cloud.inventory();admission=costAdmission(await costSnapshot(inventory),inventory,config);}catch{}
    const snapshot=await control.snapshot();
    if(snapshot.policy.managed_nodes&&snapshot.policy.budget_available!==admission.allowed&&
      (!admission.allowed||snapshot.policy.expense_policy_sha256===config.expense_policy_sha256))
      await control.setAdmissionBudget(snapshot.policy.revision,admission.allowed,config.expense_policy_sha256);
  };
  if(['plan','start'].includes(action))await syncBudget();
  else try{await syncBudget();}catch{} // Budget/quote outages cannot suppress positive drain or recovery.
  let result;
  if (action === 'plan') result = await controller.plan(await cloud.inventory());
  if (action === 'start') result = await controller.start(await readPrivateJson(requestPath), opId);
  if (action === 'drain') { const r = await readPrivateJson(requestPath); result = await controller.drain(r.identity, opId, r.revision); }
  if (action === 'recover') result = await controller.recover(opId);
  // Operation output contains no tokens or full launch request. Detailed safe
  // observations are archived separately for exact cloud completion evidence.
  process.stdout.write(JSON.stringify({action, kind: result.kind, reason: result.reason,
    operation_id: result.operation_id, state: result.state, revision: result.revision}) + '\n');
} catch {
  process.stderr.write('Execution pool reconciliation failed closed; inspect the durable operation and safe observations.\n');
  process.exitCode = 1;
} finally {try{if (pool) await pool.end();}finally{await releaseTick?.();} }
