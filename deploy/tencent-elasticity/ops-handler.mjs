import {randomUUID} from 'node:crypto';
import {ExecutionPoolController} from './controller.mjs';
import {TencentCvm, TencentTransport, runParameters} from './tencent-cvm.mjs';
import {readPrivateJson, observationArchive} from './private-files.mjs';
import {bootstrapUserData} from './bootstrap.mjs';
import {canonical, sha256, validateConfig} from './policy.mjs';

/** Called by the already-existing ops scheduler tick, also on startup/restart.
 * No new timer. Cloud dependencies can be injected for isolated fault tests. */
export function createExecutionPoolOpsHandler({control, configPath, log = () => {}, dependencies = {}}) {
  let busy = false;
  const readConfig = dependencies.readConfig ?? readPrivateJson;
  return {async tick() {
    if (busy || !configPath) return;
    busy = true;
    try {
      const config = validateConfig(await readConfig(configPath));
      if (!config.enabled) return;
      const cloud = dependencies.cloud ?? new TencentCvm({config,
        transport: new TencentTransport({region: config.region, credentials: () => readPrivateJson(config.control_credentials_file)}),
        archive: observationArchive(config.observation_directory)});
      const controller = new ExecutionPoolController({control, cloud, config,
        costSnapshot: dependencies.costSnapshot ?? (() => readPrivateJson(config.expense_snapshot_file))});
      const pending = await control.listPendingOperations();
      if (pending.length) {
        const op = pending[0];
        if (op.state === 'intent') await controller.resumeIntent(op);
        else await controller.recover(op.operation_id);
        return;
      }
      const inventory = await cloud.inventory(), snapshot = await control.snapshot();
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
        const operationId = randomUUID();
        const request = {account_id: config.account_id, region: config.region, instance_id: plan.instance_id,
          epoch: randomUUID(), source_sha256: config.source_sha256, image_sha256: config.image_sha256,
          capabilities: ['authoring', 'review', 'assistant', 'probe'], services: config.services};
        if (plan.kind === 'run') {
          const slot = config.role_names.findIndex(role => !inventory.some(i => i.role_name === role));
          request.launch_manifest_sha256 = sha256(canonical(runParameters(config, request, sha256(operationId), bootstrapUserData(config, request), slot, operationId)));
        } else request.launch_manifest_sha256 = config.launch_manifest_sha256;
        await controller.start(request, operationId);
      }
    } catch {
      log({event: 'execution_pool_reconcile_failed_closed'}); // no vendor messages, inputs or credentials
    } finally { busy = false; }
  }};
}
