import {randomUUID} from 'node:crypto';
import {ExecutionPoolController} from './controller.mjs';
import {TencentCvm, TencentTransport, runParameters} from './tencent-cvm.mjs';
import {readPrivateJson, observationArchive} from './private-files.mjs';
import {bootstrapUserData} from './bootstrap.mjs';
import {canonical, sha256, validateConfig} from './policy.mjs';
import {issueNodeEnrollment} from './enrollment.mjs';
import {produceExpenseSnapshot, costAdmission} from './costcap.mjs';
import {validateTransportIssuer} from './transport-issuer.mjs';

/** Called by the already-existing ops scheduler tick, also on startup/restart.
 * No new timer. Cloud dependencies can be injected for isolated fault tests. */
export function createExecutionPoolOpsHandler({control, configPath, log = () => {}, enrollmentBinder, expenseLedger, dependencies = {}}) {
  let busy = false;
  const readConfig = dependencies.readConfig ?? readPrivateJson;
  const clientToken=dependencies.clientToken ?? (async id=>{
    const {executionCloudClientToken}=await import('@bondbuddy/api/execution-capacity');return executionCloudClientToken(id);
  });
  return {async tick() {
    if (busy || !configPath) return;
    busy = true;
    try {
      const config = validateConfig(await readConfig(configPath));
      const pending = await control.listPendingOperations();
      if (!config.enabled && !pending.length) return;
      const cloud = dependencies.cloud ?? new TencentCvm({config,
        transport: new TencentTransport({region: config.region, credentials: () => readPrivateJson(config.control_credentials_file)}),
        archive: observationArchive(config.observation_directory)});
      const costSnapshot = dependencies.costSnapshot ?? (async inventory => {
        if(!expenseLedger)throw Error('PG_EXPENSE_LEDGER_REQUIRED');
        return produceExpenseSnapshot({ledger:await expenseLedger(),inventory,
          quote:await readConfig(config.cloud_quote_file),config});
      });
      const controller = new ExecutionPoolController({control, cloud, config,costSnapshot});
      const enroll = async op => {
        if (!['run', 'start'].includes(op?.action) || op.state !== 'completed') return;
        if (!enrollmentBinder) throw Error('CONTROLLED_ENROLLMENT_BINDER_REQUIRED');
        const observed = await cloud.describe(op.identity.instance_id);
        const slot = config.role_names.indexOf(observed.role_name);
        await issueNodeEnrollment({operation: op, slot, config, transport: cloud.transport, bind: enrollmentBinder,
          serviceTemplate: await readPrivateJson(config.node_secrets[slot].service_template_file)});
      };
      // A missing or exhausted bound closes PG admission, while recovery and
      // graceful drain keep progressing on the existing scheduler's ticks.
      let inventory, snapshot;
      const syncBudget=async()=>{
        snapshot=await control.snapshot();
        let admission={allowed:false,reason:'expense_producer_unavailable'};
        try{
          inventory=await cloud.inventory();admission=costAdmission(await costSnapshot(inventory),inventory,config);
          if(admission.allowed&&!dependencies.cloud){
            if(config.node_secrets?.length!==2)throw Error('PG_DYNAMIC_ISSUER_REQUIRED');
            for(const descriptor of config.node_secrets)await validateTransportIssuer(descriptor.pg_issuer);
          }
        }catch{admission={allowed:false,reason:'expense_or_issuer_unavailable'};}
        if(snapshot.policy.managed_nodes && admission.allowed!==snapshot.policy.budget_available) {
          const approved=config.expense_policy_sha256;
          // Enabling requires the same reviewed PG expense policy. Tightening
          // also works when a new quote/config fails validation.
          const hash=/^[a-f0-9]{64}$/.test(approved??'')?approved:sha256(canonical(config));
          if(!admission.allowed || snapshot.policy.expense_policy_sha256===hash)
            await control.setAdmissionBudget(snapshot.policy.revision,admission.allowed,hash);
          snapshot=await control.snapshot();
        }
        if(!admission.allowed)log({event:'execution_pool_cost_admission_closed',reason:admission.reason});
      };
      if (pending.length) {
        const op = pending[0];
        if (op.state === 'intent') {if(op.action!=='stop')await syncBudget();await controller.resumeIntent(op);}
        else {try{await syncBudget();}catch{}await enroll(await controller.recover(op.operation_id));}
        return;
      }
      await syncBudget();
      const starting = snapshot.nodes.find(n => n.state === 'starting');
      if (starting) {
        if (starting.cloud_start_operation_id) await enroll(await control.loadOperation(starting.cloud_start_operation_id));
        return; // no capacity from booting nodes and no new instance while boot is unfinished
      }
      const ongoing = snapshot.nodes.find(n => ['draining', 'drained'].includes(n.state));
      if (ongoing) {
        // The drain operation ID is durable in PG and exported with the node.
        if (ongoing.drain_operation_id) await controller.drain(ongoing.identity, ongoing.drain_operation_id, ongoing.revision);
        return;
      }
      const plan = await controller.plan(inventory);
      if (plan.kind === 'drain') {
        await controller.drain(plan.identity, randomUUID(), plan.revision);
      } else if (['run', 'start'].includes(plan.kind)) {
        validateConfig(config, {apply: true});
        // The real automatic entry must have a usable operation-aware issuer
        // before reserving or spending on a node. Synthetic cloud fixtures do
        // not claim to provide production certificates.
        if(!dependencies.cloud)for(const descriptor of config.node_secrets??[])await validateTransportIssuer(descriptor.pg_issuer);
        if(!dependencies.cloud&&config.node_secrets?.length!==2)throw Error('PG_DYNAMIC_ISSUER_REQUIRED');
        const operationId = randomUUID();
        const request = {account_id: config.account_id, region: config.region, instance_id: plan.instance_id,
          instance_count: 1, epoch: randomUUID(), source_sha256: config.source_sha256, image_sha256: config.image_sha256,
          capabilities: [...new Set(config.services.flatMap(s => s.capabilities))], services: config.services};
        if (plan.kind === 'run') {
          const slot = config.role_names.findIndex(role => !inventory.some(i => i.role_name === role));
          request.launch_manifest_sha256 = sha256(canonical(runParameters(config, request, await clientToken(operationId), bootstrapUserData(config, request), slot, operationId)));
        } else {
          const node = snapshot.nodes.find(n => n.state === 'stopped' && n.identity.instance_id === plan.instance_id);
          if (!node || node.source_sha256 !== config.source_sha256 || node.image_sha256 !== config.image_sha256 ||
            canonical(node.expected_services) !== canonical(config.services)) throw Error('WARM_START_SOURCE_DRIFT');
          request.launch_manifest_sha256 = node.launch_manifest_sha256;
          request.capabilities = node.capabilities;
          request.services = node.expected_services;
        }
        await controller.start(request, operationId);
      }
    } catch {
      log({event: 'execution_pool_reconcile_failed_closed'}); // no vendor messages, inputs or credentials
    } finally { busy = false; }
  }};
}
