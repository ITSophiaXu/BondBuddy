import {canonical, planCapacity, requireThat, sha256, validateConfig, requireRetainedRequest} from './policy.mjs';
import {bootstrapUserData} from './bootstrap.mjs';
import {costAdmission} from './costcap.mjs';
import {runParameters} from './tencent-cvm.mjs';
import {executionCloudCompletionMatches,executionRunAcceptanceMatches,executionStopAuthorizationMatches} from '@bondbuddy/contracts';

/** @typedef {import('@bondbuddy/contracts').ExecutionCapacityControl} ExecutionCapacityControl */
/** One existing ops invocation. No polling service, timer or independent task store. */
export class ExecutionPoolController {
  /** @param {{control: ExecutionCapacityControl, cloud: object, config: object}} options */
  constructor({control, cloud, config, costSnapshot, readInventory, assessExpense}) {
    Object.assign(this, {control, cloud, config});
    this.readInventory = readInventory ?? (() => cloud.inventory());
    this.assessExpense = assessExpense ?? (async inventory => costAdmission(await costSnapshot(inventory),inventory,this.config));
  }
  async plan(inventory) { return planCapacity(await this.control.snapshot(), inventory, this.config); }
  async start(request, opId, material) {
    validateConfig(this.config, {apply: true});
    requireRetainedRequest(this.config,request.instance_id,request);
    const snapshot = await this.control.snapshot();
    const inventory = await this.readInventory();
    requireThat((await this.assessExpense(inventory)).allowed, 'CLOUD_COSTCAP_REJECTED');
    const plan = planCapacity(snapshot, inventory, this.config);
    requireThat(['start', 'run'].includes(plan.kind) && plan.instance_id === request.instance_id &&
      plan.capabilities.every(cap => request.capabilities.includes(cap)), 'FRESH_EXPANSION_GATE');
    const start=request.instance_id?await this.cloud.prepareStart?.({identity:request,request}):undefined;
    const operation = await this.control.reserveStart(request, opId, snapshot.policy.revision);
    requireThat(canonical(operation.request) === canonical(request), 'RESERVED_REQUEST_MISMATCH');
    const slot = this.config.role_names.findIndex(role => !inventory.some(i => i.role_name === role));
    requireThat(request.instance_id || slot >= 0, 'ROLE_SLOT_EXHAUSTED');
    return this.dispatch(operation, {slot,start});
  }
  async resumeIntent(operation) {
    validateConfig(this.config, {apply: true, expenditure: false});
    if (operation.action === 'stop') return this.dispatch(operation);
    requireRetainedRequest(this.config,operation.request.instance_id,operation.request);
    const inventory = await this.readInventory();
    let admission={allowed:false};
    try{admission=await this.assessExpense(inventory);}catch{}
    const snapshot=await this.control.snapshot();
    requireThat(snapshot.pending_cloud_reservations===1,'INTENT_PENDING_SCOPE');
    // The sole never-dispatched intent is its own reservation, not additional
    // demand. PG reauthorizes the SAME operation only after these fresh checks.
    const plan=planCapacity({...snapshot,pending_cloud_reservations:0},inventory,this.config);
    if(!admission.allowed || plan.kind!==operation.action || plan.instance_id!==operation.request.instance_id ||
      !plan.capabilities.every(c=>operation.request.capabilities.includes(c))) {
      // PG accepts cancellation only before ANY dispatch/ACK. Warm cancellation
      // restores the exact prior stopped-node image, retaining audit and token.
      return this.control.cancelUndispatchedCloudIntent(operation.operation_id,operation.revision,snapshot.policy.revision);
    }
    validateConfig(this.config,{apply:true});
    let slot = 0;
    if (operation.action === 'run') {
      slot = this.config.role_names.findIndex((_, index) => sha256(canonical(runParameters(this.config, operation.request,
        operation.client_token, bootstrapUserData(this.config, operation.request, index), index, operation.operation_id))) === operation.request.launch_manifest_sha256);
      requireThat(slot >= 0 && !inventory.some(i => i.role_name === this.config.role_names[slot]), 'PERSISTED_LAUNCH_SLOT_CHANGED');
    }
    const current=await this.control.reauthorizeCloudIntent(operation.operation_id,operation.revision,snapshot.policy.revision);
    requireThat(current.operation_id===operation.operation_id && current.client_token===operation.client_token &&
      canonical(current.request)===canonical(operation.request),'INTENT_REAUTHORIZATION_DRIFT');
    return this.dispatch(current, {slot});
  }
  async drain(identity, opId, revision) {
    validateConfig(this.config, {apply: true, expenditure: false});
    const snapshot = await this.control.snapshot();
    const current = snapshot.nodes.find(n => canonical(n.identity) === canonical(identity));
    if (!['draining', 'drained'].includes(current?.state)) {
      const plan = planCapacity(snapshot, await this.readInventory(), this.config);
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
    requireThat(operation.action !== 'destroy', 'EXECUTION_DESTROY_UNSUPPORTED');
    if (operation.state !== 'intent') return operation;
    if(operation.action==='stop')requireThat(executionStopAuthorizationMatches(operation,v=>sha256(canonical(v))),'STOP_PROOF_REQUIRED');
    const start=operation.action==='start'?(material?.start??await this.cloud.prepareStart?.(operation)):undefined;
    // Unique CAS winner marks uncertainty BEFORE the request. Crashes and client
    // timeouts never imply no cloud effect. Losing dispatchers cannot call SDK.
    const claimed = await this.control.claimCloudDispatch(operation.operation_id, operation.revision);
    let result;
    try {
      const response = start?await start():await this.cloud.execute(claimed, claimed.action === 'run' ?
        {slot: material.slot, userData: bootstrapUserData(this.config, claimed.request, material.slot)} : undefined);
      let identity = claimed.identity;
      if (claimed.action === 'run') {
        requireThat(response.InstanceIdSet?.length === 1, 'EXACT_RUN_RESULT_REQUIRED');
        identity = {...claimed.request, instance_id: response.InstanceIdSet[0]};
        identity = {account_id: identity.account_id, region: identity.region, instance_id: identity.instance_id, epoch: identity.epoch};
      }
      result = {state: 'submitted', provider_request_id: response.RequestId, identity, observation: null};
      if(claimed.action==='run'){
        requireThat(executionRunAcceptanceMatches({...claimed,identity,provider_request_id:response.RequestId},response.run_acceptance),'RUN_ACCEPTANCE_UNPROVEN');
        result.run_acceptance=response.run_acceptance;
      }
    } catch (error) {
      const rejection = claimed.action === 'run' && claimed.identity === null && claimed.request?.instance_count === 1
        ? await this.cloud.capacityRejection?.(error) : null;
      result = rejection ? {state:'rejected',provider_request_id:rejection.request_id,identity:null,observation:null,
        rejection_evidence:{code:rejection.code,evidence_ref:rejection.evidence_ref,evidence_sha256:rejection.evidence_sha256,
          retry_after:new Date(Date.now()+this.config.failure_cooldown_seconds*1000).toISOString()}}
        : {state: 'unknown', provider_request_id: null, identity: claimed.identity, observation: null};
    }
    return this.control.recordCloudResult(claimed.operation_id, claimed.revision, result);
  }
  /** Explicit reconciliation of an existing durable denial, never another Run. */
  async resolveRunAuthorizationDenial(opId,revision,evidence,paymentAudit) {
    const op=await this.control.loadOperation(opId);
    requireThat(op?.action==='run'&&op.request&&op.identity===null,'RUN_DENIAL_SCOPE');
    const slot=this.config.role_names.findIndex((_,i)=>sha256(canonical(runParameters(this.config,op.request,op.client_token,
      bootstrapUserData(this.config,op.request,i),i,opId)))===op.request.launch_manifest_sha256);
    requireThat(slot>=0,'RUN_DENIAL_MANIFEST_DRIFT');
    return this.control.finalizeRunAuthorizationDenial(opId,revision,{evidence,payment_audit:paymentAudit,launch_parameters:runParameters(this.config,op.request,
      op.client_token,bootstrapUserData(this.config,op.request,slot),slot,opId)});
  }
  async recover(opId) {
    const op = await this.control.loadOperation(opId);
    requireThat(op, 'OPERATION_NOT_FOUND');
    if (!['submitted', 'unknown'].includes(op.state)) return op;
    if (!op.identity) {
      requireThat(op.action === 'run', 'UNBOUND_OPERATION');
      const inventory = await this.readInventory();
      const candidates = inventory.filter(i => i.create_operation_id === op.operation_id);
      requireThat(candidates.length <= 1, 'UNKNOWN_RUN_INVENTORY_AMBIGUOUS');
      if (!candidates.length) return op; // absence is not proof of rejected Run
      const i=candidates[0], slot=this.config.role_names.indexOf(i.role_name);
      requireThat(slot>=0 && sha256(canonical(runParameters(this.config,op.request,op.client_token,
        bootstrapUserData(this.config,op.request,slot),slot,op.operation_id)))===op.request.launch_manifest_sha256, 'UNKNOWN_RUN_MANIFEST_DRIFT');
      // Bind capacity/cost ownership, but an absent ACK still cannot authorize
      // completion or a second launch. The original operation/token is retained.
      return this.control.recordCloudResult(opId,op.revision,{state:'unknown',provider_request_id:null,
        identity:{account_id:op.request.account_id,region:op.request.region,instance_id:i.instance_id,epoch:op.request.epoch},observation:null});
    }
    if(!op.provider_request_id)return op;
    if(op.action!=='stop')requireRetainedRequest(this.config,op.identity.instance_id,op.request);
    const observation=op.action==='run'?await this.cloud.describeRun(op):await this.cloud.describe(op.identity.instance_id);
    if(!executionCloudCompletionMatches(op,observation))return op;
    return this.control.recordCloudResult(opId, op.revision, {state: 'completed', provider_request_id: op.provider_request_id,
      identity: op.identity, observation: {instance_state: observation.instance_state, latest_operation: observation.latest_operation,
        latest_operation_state: observation.latest_operation_state, observed_at: observation.observed_at,
        latest_operation_request_id: observation.latest_operation_request_id, stop_charging_mode: observation.stop_charging_mode,
        evidence_ref: observation.evidence_ref, evidence_sha256: observation.evidence_sha256,
        ...(observation.run_creation?{run_creation:observation.run_creation}:{})}});
  }
}
