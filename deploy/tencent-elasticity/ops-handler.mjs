import {readExpenseHistory} from './expense-history.mjs';
import {randomUUID} from 'node:crypto';
import {ExecutionPoolController} from './controller.mjs';
import {TencentCvm, TencentTransport, runParameters} from './tencent-cvm.mjs';
import {readPrivateJson, observationArchive} from './private-files.mjs';
import {bootstrapUserData} from './bootstrap.mjs';
import {canonical, sha256, validateConfig, nodeLaunchConfig, requireRetainedRequest} from './policy.mjs';
import {issueNodeEnrollment} from './enrollment.mjs';
import {produceExpenseSnapshot, costAdmission} from './costcap.mjs';
import {validateTransportIssuer} from './transport-issuer.mjs';
import {renewNodeTransport} from './transport-renewal.mjs';
import {validateTransportLifecycleProof} from './transport-refresher.mjs';
import {createSocketCredentialProvider} from './control-socket.mjs';
import {acquireControlTick} from './control-tick-bound.mjs';
import {refreshCloudQuote} from './cloud-quote-refresh.mjs';

// Public guard/transport codes only. Never serialize an Error, stack, config,
// provider message or arbitrary identifier-shaped value into operational logs.
const diagnosticCodes=new Set(`SECRET_VERSION_CAPACITY ENROLLMENT_RECOVERY_EXHAUSTED ENOENT EACCES EPERM ECONNREFUSED ECONNRESET ETIMEDOUT ENOSPC EIO 42501 EXECUTION_CAPACITY_CAS_CONFLICT EXECUTION_NODE_EPOCH_MISMATCH
CONFIG_VERSION RESOURCE_SCOPE OWNERSHIP_SCOPE POOL_BOUND PHASE_REQUIRED CAPACITY_BOUND COMPUTE_QUOTE COOLDOWN_BOUND
PRIVATE_PATH_REQUIRED PRIVATE_FILE_BOUND PRIVATE_FILE_PERMISSIONS OBSERVATION_BOUND OBSERVATION_COLLISION
CONTROL_RATE_DIRECTORY CONTROL_RATE_LOCK CONTROL_RATE_CLOCK CONTROL_RATE_CLOCK_ROLLBACK CONTROL_RATE_STATE
CONTROL_AUTHORITY_BLOCKED CONTROL_AUTHORITY_UNAVAILABLE CONTROL_REQUEST_BOUND CONTROL_SHORT_CREDENTIAL_REQUIRED CONTROL_SOCKET_PERMISSIONS CONTROL_SOCKET_SCOPE
PG_EXPENSE_LEDGER_REQUIRED PG_DYNAMIC_ISSUER_REQUIRED PG_AUTHORITY_NOT_READY PG_AUTHORITY_BINDING PG_ISSUER_PRIVATE_PATH PG_ISSUER_PRIVATE_MODE PG_ISSUER_CA_PIN PG_ISSUER_CA_INVALID PG_LEAF_ISSUANCE_FAILED
CONTROLLED_ENROLLMENT_BINDER_REQUIRED ENROLLMENT_VAULT_CONFLICT ENROLLMENT_DISPATCH_DRIFT ISSUER_SCOPE START_COMPLETION_REQUIRED SECRET_VERSION_BOUND SECRET_VERSION_CONFLICT SECRET_PUBLISH_UNCONFIRMED SECRET_RETIREMENT_PROOF_REQUIRED
EXPENSE_HISTORY_ARCHIVE_NOT_CLOSED EXPENSE_HISTORY_CARRY_BOUND EXPENSE_HISTORY_CONFLICT EXPENSE_HISTORY_COVERAGE EXPENSE_HISTORY_DIRECTORY EXPENSE_HISTORY_EXTERNAL_BOUND EXPENSE_HISTORY_EXTERNAL_OVERLAP EXPENSE_HISTORY_EXTERNAL_REQUIRED EXPENSE_HISTORY_HASH EXPENSE_HISTORY_PATH EXPENSE_HISTORY_PIN_REQUIRED EXPENSE_HISTORY_ROLLOVER_POLICY EXPENSE_HISTORY_ROW_ID EXPENSE_HISTORY_ROWS EXPENSE_HISTORY_SOURCE EXPENSE_HISTORY_STALE EXPENSE_HISTORY_TIME EXPENSE_HISTORY_UNPINNED
QUOTE_CONFIG_DRIFT QUOTE_PUBLICATION_DRIFT QUOTE_REFRESH_DEADLINE QUOTE_REFRESH_SCOPE QUOTE_RATE_CAP QUOTE_RATE_EVIDENCE QUOTE_TARIFF_EXPIRED
WARM_START_SOURCE_DRIFT WARM_START_CLOUD_MANIFEST_DRIFT WARM_START_CREATION_UNPROVEN WARM_BOOTSTRAP_BINDING
RETAINED_NODE_MANIFEST_DRIFT START_REQUIRES_STOPPED CLOUD_HTTP_UNCERTAIN CLOUD_RESPONSE_BOUND CLOUD_RESPONSE_UNCERTAIN SHORT_CREDENTIAL_REQUIRED
UnauthorizedOperation AuthFailure AuthFailure.SecretIdNotFound AuthFailure.SignatureFailure FailedOperation InternalError RequestLimitExceeded ResourceNotFound ResourceNotFound.SecretNotFound`.split(/\s+/));
const diagnosticUuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
function diagnosticError(error){
  const code=error?.message==='CLOUD_API_ERROR'?error?.code:diagnosticCodes.has(error?.code)?error.code:error?.message;
  return {error_code:diagnosticCodes.has(code)?code:'UNCLASSIFIED_ERROR',
    error_name:['Error','TypeError','SyntaxError','RangeError','AbortError','TimeoutError'].includes(error?.name)?error.name:'Error',
    ...(diagnosticUuid(error?.requestId)?{provider_request_id:error.requestId}:{})};
}

/** Called by the already-existing ops scheduler tick, also on startup/restart.
 * No new timer. Cloud dependencies can be injected for isolated fault tests. */
export function createExecutionPoolOpsHandler({control, configPath, log = () => {}, enrollmentBinder, expenseLedger, dependencies = {}}) {
  let busy = false;
  const readConfig = dependencies.readConfig ?? readPrivateJson;
  const clientToken=dependencies.clientToken ?? (async id=>{
    const {executionCloudClientToken}=await import('@bondbuddy/api/execution-capacity');return executionCloudClientToken(id);
  });
  const providers=new Map();
  return {async tick() {
    if (busy || !configPath) return;
    busy = true;
    let releaseTick;
    let admissionVerified=false;
    const tickId=randomUUID(),startedAt=performance.now();
    let stage='config_read',operationContext;
    const failure=error=>({tick_id:tickId,stage,elapsed_ms:Math.max(0,Math.round(performance.now()-startedAt)),...diagnosticError(error),
      ...(diagnosticUuid(operationContext?.operation_id)?{operation_id:operationContext.operation_id}:{}),
      ...(/^ins-[a-z0-9]+$/.test(operationContext?.identity?.instance_id??'')?{instance_id:operationContext.identity.instance_id}:{}),
      ...(diagnosticUuid(operationContext?.identity?.epoch)?{epoch:operationContext.identity.epoch}:{})});
    const diagnosticLog=value=>{try{log(value);}catch{ /* Logging must not alter recovery or cloud dispatch. */ }};
    const fenceAdmission=async()=>{
      const failedStage=stage;
      stage='failure_admission_fence';
      try{
        const {policy}=await control.snapshot();
        if(policy.managed_nodes&&policy.budget_available)
          await control.setAdmissionBudget(policy.revision,false,policy.expense_policy_sha256);
      }catch(error){diagnosticLog({event:'execution_pool_admission_fence_failed',...failure(error)});}
      finally{stage=failedStage;}
    };
    try {
      const rawConfig=await readConfig(configPath);stage='config_validate';
      const baseConfig = validateConfig(rawConfig);
      let config=structuredClone(baseConfig);
      stage='pending_operations_read';
      const pending = await control.listPendingOperations();
      if (!config.enabled && !pending.length) return;
      stage='control_tick_acquire';
      if(!dependencies.cloud||config.cloud_quote_refresh){releaseTick=await acquireControlTick(config.registration_directory,{now:dependencies.now??Date.now});if(!releaseTick)return;}
      stage='credential_provider_create';
      let credentialsProvider=dependencies.credentialsProvider;
      if(!credentialsProvider&&!dependencies.cloud){
        const key=canonical(config.control_credential_provider);
        if(!providers.has(key))providers.set(key,createSocketCredentialProvider(config.control_credential_provider));
        credentialsProvider=providers.get(key);
      }
      const cloud = dependencies.cloud ?? new TencentCvm({config,control,
        transport: new TencentTransport({region: config.region, credentials: () => credentialsProvider.get(),
          ...(dependencies.transportOptions??{})}),
        archive: observationArchive(config.observation_directory)});
      const costSnapshot = dependencies.costSnapshot ?? (async inventory => {
        if(!expenseLedger)throw Error('PG_EXPENSE_LEDGER_REQUIRED');
        const ledger=await expenseLedger();
        const fresh=await refreshCloudQuote({configPath,config:baseConfig,transport:cloud.transport,
          capturedAt:ledger.captured_at,readConfig,now:dependencies.now??Date.now,fetchImpl:dependencies.tariffFetch??fetch});
        config=fresh.config;controller.config=config;cloud.config=config;
        return produceExpenseSnapshot({ledger,inventory,quote:fresh.quote,config,history:await readExpenseHistory(config)});
      });
      const readInventory=async()=>{
        try{return await cloud.inventory();}
        catch(error){admissionVerified=false;throw error;}
      };
      const assessExpense=async inventory=>{
        try{
          const admission=costAdmission(await costSnapshot(inventory),inventory,config);
          if(!admission.allowed)admissionVerified=false;
          return admission;
        }catch(error){admissionVerified=false;throw error;}
      };
      const controller = new ExecutionPoolController({control, cloud, config,readInventory,assessExpense});
      const enroll = async op => {
        if (!['run', 'start'].includes(op?.action) || op.state !== 'completed') return;
        operationContext=op;stage='enrollment_prepare';
        if (!enrollmentBinder) throw Error('CONTROLLED_ENROLLMENT_BINDER_REQUIRED');
        stage='enrollment_cloud_describe';
        const observed = await cloud.describe(op.identity.instance_id);
        const slot = config.role_names.indexOf(observed.role_name);
        stage='enrollment_template_read';
        const serviceTemplate=await readPrivateJson(config.node_secrets[slot].service_template_file);
        stage='enrollment_issue';
        return await issueNodeEnrollment({operation: op, slot, config, transport: cloud.transport, bind: enrollmentBinder, now:dependencies.now??Date.now,
          retirement:async()=>{if(!expenseLedger)throw Error('PG_EXPENSE_LEDGER_REQUIRED');
            return {operations:(await expenseLedger()).operations,nodes:(await control.snapshot()).nodes};},
          serviceTemplate});
      };
      // A missing or exhausted bound closes PG admission, while recovery and
      // graceful drain keep progressing on the existing scheduler's ticks.
      let inventory, snapshot;
      const syncBudget=async()=>{
        admissionVerified=false;
        inventory=undefined;
        stage='budget_snapshot';
        snapshot=await control.snapshot();
        let admission={allowed:false,reason:'expense_producer_unavailable'};
        let admissionFailure;
        try{
          stage='cloud_inventory';inventory=await readInventory();
          stage='cost_snapshot';admission=await assessExpense(inventory);
          if(admission.allowed&&!dependencies.cloud){
            stage='transport_issuer_validate';
            if(config.node_secrets?.length!==2)throw Error('PG_DYNAMIC_ISSUER_REQUIRED');
            for(const descriptor of config.node_secrets)await validateTransportIssuer(descriptor.pg_issuer);
            stage='transport_lifecycle_validate';
            if(config.phase==='automatic')validateTransportLifecycleProof(await readConfig(config.transport_renewal_evidence_file),config);
          }
        }catch(error){admissionFailure=failure(error);admission={allowed:false,reason:'expense_or_issuer_unavailable'};diagnosticLog({event:'execution_pool_cost_evaluation_failed',...admissionFailure});}
        const approved=config.expense_policy_sha256;
        const hash=/^[a-f0-9]{64}$/.test(approved??'')?approved:sha256(canonical(config));
        if(admission.allowed&&snapshot.policy.managed_nodes&&snapshot.policy.expense_policy_sha256!==hash)
          admission={allowed:false,reason:'expense_policy_mismatch'};
        if(snapshot.policy.managed_nodes && admission.allowed!==snapshot.policy.budget_available) {
          stage='budget_admission_write';
          await control.setAdmissionBudget(snapshot.policy.revision,admission.allowed,hash);
          stage='budget_snapshot';snapshot=await control.snapshot();
        }
        admissionVerified=admission.allowed&&snapshot.policy.budget_available&&snapshot.policy.expense_policy_sha256===hash;
        if(!admission.allowed)diagnosticLog({event:'execution_pool_cost_admission_closed',reason:admission.reason,...admissionFailure});
      };
      const syncBeforeRecovery=async()=>{
        try{await syncBudget();}
        catch(error){
          diagnosticLog({event:'execution_pool_cost_sync_failed',...failure(error)});
          await fenceAdmission();
        }
      };
      if (pending.length) {
        const op = pending[0];
        operationContext=op;
        if (op.state === 'intent') {
          if(op.action==='stop')await syncBeforeRecovery();
          else await syncBudget();
          stage='operation_resume';
          const wasVerified=admissionVerified;
          await controller.resumeIntent(op);
          if(wasVerified&&!admissionVerified)await fenceAdmission();
        }
        else {await syncBeforeRecovery();
          stage='operation_recover';await enroll(await controller.recover(op.operation_id));}
        return;
      }
      await syncBudget();
      // Advance contraction before any potentially slow credential issuance.
      // A draining task without a positive finish receipt still gets renewal.
      let drainAttempted=false,plan;
      const ongoing=snapshot.nodes.find(n=>['draining','drained'].includes(n.state));
      if(ongoing?.drain_operation_id){
        operationContext={operation_id:ongoing.drain_operation_id,identity:ongoing.identity};stage='node_drain';
        const result=await controller.drain(ongoing.identity,ongoing.drain_operation_id,ongoing.revision);
        if(result.state!=='draining')return;
        drainAttempted=true;stage='drain_snapshot';snapshot=await control.snapshot();
      }else if(inventory&&!snapshot.nodes.some(n=>n.state==='starting')){
        stage='capacity_plan';
        plan=await controller.plan(inventory);
        if(plan.kind==='drain'){
          const operationId=randomUUID();
          operationContext={operation_id:operationId,identity:plan.identity};stage='node_drain';
          const result=await controller.drain(plan.identity,operationId,plan.revision);
          if(result.state!=='draining')return;
          drainAttempted=true;stage='drain_snapshot';snapshot=await control.snapshot();
        }
      }
      let renewalBlocked=false,renewalIssued=false;
      if(!dependencies.cloud)try{
        stage='transport_renewal_ledger';
        const stoppedIdentities=(await expenseLedger()).operations.filter(op=>op.action==='stop'&&op.state==='completed').map(op=>op.identity);
        for(const node of snapshot.nodes.filter(n=>['ready','draining'].includes(n.state)&&n.cloud_start_operation_id)){
          operationContext={operation_id:node.cloud_start_operation_id,identity:node.identity};stage='transport_renewal_prepare';
          const op=await control.loadOperation(node.cloud_start_operation_id),observed=await cloud.describe(node.identity.instance_id);
          const slot=config.role_names.indexOf(observed.role_name);
          stage='transport_renewal_issue';
          if(await renewNodeTransport({node,operation:op,slot,config,transport:cloud.transport,stoppedIdentities})){renewalIssued=true;break;}
        }
      }catch(error){
        const renewalFailure=failure(error);
        renewalBlocked=true;
        if(stage==='transport_renewal_ledger'){
          admissionVerified=false;
          await fenceAdmission();
        }
        diagnosticLog({event:'execution_pool_transport_renewal_failed',...renewalFailure});
      }
      if(drainAttempted)return;
      let initialEnrollmentPending=false;
      for(const starting of snapshot.nodes.filter(n=>n.state==='starting')){
        if(!starting.cloud_start_operation_id){initialEnrollmentPending=true;continue;}
        operationContext={operation_id:starting.cloud_start_operation_id,identity:starting.identity};stage='starting_operation_read';
        let delayed=false;
        try {
          const enrollment=await enroll(await control.loadOperation(starting.cloud_start_operation_id));
          delayed=(enrollment?.recovery_generation??0)>0;
        } catch(error) {
          if(error.message!=='ENROLLMENT_RECOVERY_EXHAUSTED')throw error;
          delayed=true;
          log({event:'execution_pool_enrollment_exhausted',instance_id:starting.identity.instance_id});
        }
        if(!delayed){initialEnrollmentPending=true;continue;}
        // The slow node remains in inventory, cost accounting and PG admission.
        // A spare may serve demand within the SAME two-node/global/budget caps.
        // Never stop the delayed node or replay any workload as a timeout action.
        log({event:'execution_pool_boot_delayed',instance_id:starting.identity.instance_id});
      }
      if(initialEnrollmentPending||!inventory)return;
      stage='capacity_plan';
      plan??=await controller.plan(inventory);
      if (plan.kind === 'drain') {
        const operationId=randomUUID();
        operationContext={operation_id:operationId,identity:plan.identity};stage='node_drain';
        await controller.drain(plan.identity, operationId, plan.revision);
      } else if (['run', 'start'].includes(plan.kind)) {
        if(!admissionVerified||renewalBlocked||renewalIssued)return;
        stage='launch_validate';validateConfig(config, {apply: true});
        // The real automatic entry must have a usable operation-aware issuer
        // before reserving or spending on a node. Synthetic cloud fixtures do
        // not claim to provide production certificates.
        if(!dependencies.cloud)for(const descriptor of config.node_secrets??[])await validateTransportIssuer(descriptor.pg_issuer);
        if(!dependencies.cloud&&config.node_secrets?.length!==2)throw Error('PG_DYNAMIC_ISSUER_REQUIRED');
        const operationId = randomUUID();
        operationContext={operation_id:operationId};stage='launch_prepare';
        const request = {account_id: config.account_id, region: config.region, instance_id: plan.instance_id,
          instance_count: 1, epoch: randomUUID(), source_sha256: config.source_sha256, image_sha256: config.image_sha256,
          capabilities: [...new Set(config.services.flatMap(s => s.capabilities))], services: config.services};
        if (plan.kind === 'run') {
          const slot = config.role_names.findIndex(role => !inventory.some(i => i.role_name === role));
          request.launch_manifest_sha256 = sha256(canonical(runParameters(config, request, await clientToken(operationId), bootstrapUserData(config, request, slot), slot, operationId)));
        } else {
          const node = snapshot.nodes.find(n => n.state === 'stopped' && n.identity.instance_id === plan.instance_id);
          const launchConfig=nodeLaunchConfig(config,plan.instance_id);
          if (!node || node.source_sha256 !== launchConfig.source_sha256 || node.image_sha256 !== launchConfig.image_sha256 ||
            canonical(node.expected_services) !== canonical(config.services)) throw Error('WARM_START_SOURCE_DRIFT');
          request.source_sha256=node.source_sha256;
          request.image_sha256=node.image_sha256;
          request.launch_manifest_sha256 = node.launch_manifest_sha256;
          request.capabilities = node.capabilities;
          request.services = node.expected_services;
          requireRetainedRequest(config,plan.instance_id,request);
        }
        operationContext={operation_id:operationId,identity:request};stage='operation_start';
        await controller.start(request, operationId);
      }
    } catch(error) {
      const reconcileFailure=failure(error);
      // Only a tick with newly proven pool-wide admission can isolate a later
      // failure. The failed operation ends here; healthy services keep claiming.
      if(!admissionVerified)await fenceAdmission();
      diagnosticLog({event:admissionVerified?'execution_pool_reconcile_local_failure':'execution_pool_reconcile_failed_closed',
        reason:['ENROLLMENT_VAULT_CONFLICT','SECRET_PUBLISH_UNCONFIRMED','SECRET_VERSION_CONFLICT','SECRET_VERSION_CAPACITY'].includes(error?.message)?error.message:'RECONCILE_UNAVAILABLE',...reconcileFailure});
    } finally { try{await releaseTick?.();}catch(error){stage='control_tick_release';diagnosticLog({event:'execution_pool_tick_release_failed',...failure(error)});throw error;}finally{busy = false;} }
  }};
}
