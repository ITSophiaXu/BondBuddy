import {readPrivateJson, observationArchive} from './private-files.mjs';
import {ExecutionPoolController} from './controller.mjs';
import {TencentCvm, TencentTransport} from './tencent-cvm.mjs';
import {validateConfig, requireThat} from './policy.mjs';

// Explicit invocation inside the existing ops service. No background scheduling.
const [action, configPath, requestPath, opId] = process.argv.slice(2);
let pool;
try {
  requireThat(['plan', 'start', 'drain', 'recover'].includes(action), 'ACTION_REQUIRED');
  const config = validateConfig(await readPrivateJson(configPath), {apply: action !== 'plan'});
  const {Pool} = await import('pg');
  const {executionCapacityControl} = await import('@bondbuddy/api/execution-capacity');
  pool = new Pool({connectionString: process.env.DATABASE_URL, max: 2, connectionTimeoutMillis: 5000, query_timeout: 10000});
  const control = executionCapacityControl(pool);
  const transport = new TencentTransport({region: config.region,
    credentials: () => readPrivateJson(config.control_credentials_file)});
  const cloud = new TencentCvm({transport, config, archive: observationArchive(config.observation_directory)});
  const controller = new ExecutionPoolController({control, cloud, config, costSnapshot: () => readPrivateJson(config.expense_snapshot_file)});
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
} finally { if (pool) await pool.end(); }
