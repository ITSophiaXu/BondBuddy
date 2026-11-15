import {canonical, planCapacity, requireThat, sha256, validateConfig} from './policy.mjs';
import {bootstrapUserData} from './bootstrap.mjs';
import {requireCostAdmission} from './costcap.mjs';
import {runParameters} from './tencent-cvm.mjs';

/** @typedef {import('@bondbuddy/contracts').ExecutionCapacityControl} ExecutionCapacityControl */
/** One existing ops invocation. No polling service, timer or independent task store. */
export class ExecutionPoolController {
  /** @param {{control: ExecutionCapacityControl, cloud: object, config: object}} options */
  constructor({control, cloud, config, costSnapshot}) { Object.assign(this, {control, cloud, config, costSnapshot}); }
  async plan(inventory) { return planCapacity(await this.control.snapshot(), inventory, this.config); }
  async start(request, opId, material) {
    validateConfig(this.config, {apply: true});
    const snapshot = await this.control.snapshot();
    const inventory = await this.cloud.inventory();
    requireCostAdmission(await this.costSnapshot(), inventory, this.config);
    const plan = planCapacity(snapshot, inventory, this.config);
    requireThat(['start', 'run'].includes(plan.kind) && plan.instance_id === request.instance_id &&
      plan.capabilities.every(cap => request.capabilities.includes(cap)), 'FRESH_EXPANSION_GATE');
    const operation = await this.control.reserveStart(request, opId, snapshot.policy.revision);
    requireThat(canonical(operation.request) === canonical(request), 'RESERVED_REQUEST_MISMATCH');
    const slot = this.config.role_names.findIndex(role => !inventory.some(i => i.role_name === role));
    requireThat(request.instance_id || slot >= 0, 'ROLE_SLOT_EXHAUSTED');
    return this.dispatch(operation, {slot});
  }
  async resumeIntent(operation) {
    validateConfig(this.config, {apply: true});
    if (operation.action === 'stop') return this.dispatch(operation);
    const inventory = await this.cloud.inventory();
    requireCostAdmission(await this.costSnapshot(), inventory, this.config);
    let slot = 0;
    if (operation.action === 'run') {
      slot = this.config.role_names.findIndex((_, index) => sha256(canonical(runParameters(this.config, operation.request,
        operation.client_token, bootstrapUserData(this.config, operation.request), index, operation.operation_id))) === operation.request.launch_manifest_sha256);
      requireThat(slot >= 0 && !inventory.some(i => i.role_name === this.config.role_names[slot]), 'PERSISTED_LAUNCH_SLOT_CHANGED');
    }
    return this.dispatch(operation, {slot});
  }
  async drain(identity, opId, revision) {
    validateConfig(this.config, {apply: true});
    const snapshot = await this.control.snapshot();
    const current = snapshot.nodes.find(n => canonical(n.identity) === canonical(identity));
    if (!['draining', 'drained'].includes(current?.state)) {
      const plan = planCapacity(snapshot, await this.cloud.inventory(), this.config);
      requireThat(plan.kind === 'drain' && canonical(plan.identity) === canonical(identity) && plan.revision === revision, 'FRESH_DRAIN_GATE');
    }
    const node = await this.control.beginDrain(identity, opId, revision);
    const proof = await this.control.drainProof(identity, opId);
    if (!proof) return {state: 'draining', node};
    requireThat(proof.identity.epoch === identity.epoch && proof.active_leases === 0 && proof.active_model_calls === 0 &&
      proof.native_processes === 0 && proof.unpersisted_results === 0 && proof.positive_session_receipts > 0, 'DRAIN_NOT_PROVEN');
    const operation = await this.control.submitStop(proof, 'stop');
    return this.dispatch(operation);
  }
  async dispatch(operation, material) {
    if (operation.state !== 'intent') return operation;
    // Unique CAS winner marks uncertainty BEFORE the request. Crashes and client
    // timeouts never imply no cloud effect. Losing dispatchers cannot call SDK.
    const claimed = await this.control.claimCloudDispatch(operation.operation_id, operation.revision);
    let result;
    try {
      const response = await this.cloud.execute(claimed, claimed.action === 'run' ?
        {slot: material.slot, userData: bootstrapUserData(this.config, claimed.request)} : undefined);
      let identity = claimed.identity;
      if (claimed.action === 'run') {
        requireThat(response.InstanceIdSet?.length === 1, 'EXACT_RUN_RESULT_REQUIRED');
        identity = {...claimed.request, instance_id: response.InstanceIdSet[0]};
        identity = {account_id: identity.account_id, region: identity.region, instance_id: identity.instance_id, epoch: identity.epoch};
      }
      result = {state: 'submitted', provider_request_id: response.RequestId, identity, observation: null};
    } catch {
      // Definitive errors may be classified by a separately reviewed recovery;
      // initial controller retains the inventory reservation/fence on ALL failures.
      result = {state: 'unknown', provider_request_id: null, identity: claimed.identity, observation: null};
    }
    return this.control.recordCloudResult(claimed.operation_id, claimed.revision, result);
  }
  async recover(opId) {
    const op = await this.control.loadOperation(opId);
    requireThat(op, 'OPERATION_NOT_FOUND');
    if (!['submitted', 'unknown'].includes(op.state) || !op.identity) return op;
    const observation = await this.cloud.describe(op.identity.instance_id);
    const action = {run: 'RunInstances', start: 'StartInstances', stop: 'StopInstances'}[op.action];
    const state = op.action === 'stop' ? 'STOPPED' : 'RUNNING';
    // Describe latest request must bind the ACK; timeout without an ACK stays
    // unknown for explicit recovery. Never treat a foreign stop as our completion.
    if (!op.provider_request_id || observation.latest_operation_request_id !== op.provider_request_id ||
        observation.latest_operation !== action || observation.latest_operation_state !== 'SUCCESS' ||
        observation.instance_state !== state || (op.action === 'stop' && observation.stop_charging_mode !== 'STOP_CHARGING')) return op;
    return this.control.recordCloudResult(opId, op.revision, {state: 'completed', provider_request_id: op.provider_request_id,
      identity: op.identity, observation: {instance_state: observation.instance_state, latest_operation: observation.latest_operation,
        latest_operation_state: observation.latest_operation_state, observed_at: observation.observed_at,
        latest_operation_request_id: observation.latest_operation_request_id, stop_charging_mode: observation.stop_charging_mode,
        evidence_ref: observation.evidence_ref, evidence_sha256: observation.evidence_sha256}});
  }
}
