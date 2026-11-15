import {createHmac} from 'node:crypto';
import {canonical, sha256, requireThat, validateConfig, retainedNodePin, nodeLaunchConfig, requireRetainedRequest} from './policy.mjs';
import {bootstrapUserData} from './bootstrap.mjs';
import {executionInstanceLaunchBinding,executionRunAcceptanceMatches,executionSlotReadTag,executionStopAuthorizationMatches} from '@bondbuddy/contracts';

const apiVersion = {cvm: '2017-03-12', sts: '2018-08-13', ssm: '2019-09-23', lighthouse: '2020-03-24'};
const allowedActions = {cvm: new Set(['RunInstances', 'StartInstances', 'StopInstances', 'DescribeInstances','DescribeInstancesStatus']),
  sts: new Set(['GetCallerIdentity']), ssm: new Set(['GetSecretValue', 'PutSecretValue','ListSecretVersionIds','DeleteSecretVersion']),
  lighthouse: new Set(['DescribeInstances','DescribeInstancesTrafficPackages'])};
const hmac = (key, value, encoding) => createHmac('sha256', key).update(value).digest(encoding);

/** Extract only identifiers already present in the request and fixed wildcard
 * resource classes. Free vendor text and arbitrary identifier-shaped secrets
 * are never retained. This projection cannot authorize a terminal transition. */
export function safeDenialDiagnostic(service,action,payload,message,{accountId,region}={}) {
  const actions=[`name/${service}:${action}`];
  const allowed=new Set([payload?.ImageId,...(payload?.SecurityGroupIds??[]),payload?.VirtualPrivateCloud?.VpcId,payload?.VirtualPrivateCloud?.SubnetId]);
  const resources=[];
  if(/^[0-9]{1,20}$/.test(accountId??'')&&region==='ap-beijing'&&typeof message==='string'&&message.length<=8192) {
    for(const match of message.matchAll(/qcs:([a-z]+\/[0-9]+)?:([a-z]+):([a-z0-9-]+):uin\/([0-9]+):(instance|systemdisk|datadisk|image|sg|vpc|subnet)\/([A-Za-z0-9_*.-]+)/g)) {
      const [,project,resourceService,resourceRegion,resourceAccount,kind,resourceId]=match;
      if(![undefined,'id/0'].includes(project)||resourceRegion!==region||resourceAccount!==accountId)continue;
      const value=`qcs:${project??''}:${resourceService}:${region}:uin/${accountId}:${kind}/${resourceId}`;
      if(value.length<=512&&['cvm','vpc'].includes(resourceService)&&(allowed.has(resourceId)||['instance','systemdisk','datadisk'].includes(kind)&&resourceId==='*')&&!resources.includes(value))resources.push(value);
      if(resources.length===8)break;
    }
  }
  return {actions,resources};
}

/** Official TC3 signature; credentials are refreshed in memory by the existing ops/role source. */
export class TencentTransport {
  constructor({credentials, region, fetchImpl = fetch, now = Date.now, timeoutMs = 15000, purpose = 'role', assumeRoleArn}) {
    requireThat(region === 'ap-beijing' && timeoutMs > 0 && timeoutMs <= 20000, 'TRANSPORT_SCOPE');
    requireThat(['role','control-source'].includes(purpose) && (purpose!=='control-source' ||
      /^qcs::cam::uin\/\d{1,20}:roleName\/bondbuddy-execution-control$/.test(assumeRoleArn??'')), 'SOURCE_ROLE_SCOPE');
    Object.assign(this, {credentials, region, fetchImpl, now, timeoutMs, purpose, assumeRoleArn});
  }
  async call(service, action, payload, {signal}={}) {
    signal?.throwIfAborted();
    const source=this.purpose==='control-source';
    requireThat(source ? service==='sts' && action==='AssumeRole' && payload?.RoleArn===this.assumeRoleArn &&
      Object.keys(payload).every(k=>['RoleArn','RoleSessionName','DurationSeconds'].includes(k)) &&
      /^[A-Za-z0-9+=,.@_-]{2,128}$/.test(payload.RoleSessionName??'') &&
      Number.isInteger(payload.DurationSeconds) && payload.DurationSeconds>=900 && payload.DurationSeconds<=7200 :
      allowedActions[service]?.has(action), 'ACTION_NOT_ALLOWED');
    if(service==='lighthouse')requireThat(payload?.InstanceIds?.length===1&&payload.InstanceIds[0]==='lhins-4i18xeto'&&
      payload.Offset===0&&payload.Limit===1&&Object.keys(payload).every(k=>['InstanceIds','Offset','Limit'].includes(k)), 'LIGHTHOUSE_EXACT_SCOPE');
    const c = await this.credentials();
    signal?.throwIfAborted();
    requireThat(typeof c.secretId==='string' && c.secretId && typeof c.secretKey==='string' && c.secretKey &&
      (source ? !c.token : c.token && Number(c.expiresAt) > this.now() + 60000), 'SHORT_CREDENTIAL_REQUIRED');
    const body = canonical(payload), host = `${service}.tencentcloudapi.com`;
    const timestamp = Math.floor(this.now() / 1000), date = new Date(timestamp * 1000).toISOString().slice(0, 10);
    const headers = `content-type:application/json; charset=utf-8\nhost:${host}\n`;
    const request = `POST\n/\n\n${headers}\ncontent-type;host\n${sha256(body)}`;
    const scope = `${date}/${service}/tc3_request`;
    const key = hmac(hmac(hmac(`TC3${c.secretKey}`, date), service), 'tc3_request');
    const signature = hmac(key, `TC3-HMAC-SHA256\n${timestamp}\n${scope}\n${sha256(request)}`, 'hex');
    const timeout=AbortSignal.timeout(this.timeoutMs);
    const response = await this.fetchImpl(`https://${host}/`, {method: 'POST', redirect: 'error', signal: signal?AbortSignal.any([timeout,signal]):timeout, body,
      headers: {'Content-Type': 'application/json; charset=utf-8', 'X-TC-Action': action, 'X-TC-Version': apiVersion[service],
        'X-TC-Region': this.region, 'X-TC-Timestamp': String(timestamp), ...(source?{}:{'X-TC-Token': c.token}),
        Authorization: `TC3-HMAC-SHA256 Credential=${c.secretId}/${scope}, SignedHeaders=content-type;host, Signature=${signature}`}});
    requireThat(response.ok, 'CLOUD_HTTP_UNCERTAIN');
    let length = 0;
    const chunks = [];
    for await (const chunk of response.body) {
      length += chunk.length;
      requireThat(length <= 131072, 'CLOUD_RESPONSE_BOUND');
      chunks.push(chunk);
    }
    const data = JSON.parse(Buffer.concat(chunks).toString()).Response;
    requireThat(data && typeof data.RequestId === 'string', 'CLOUD_RESPONSE_UNCERTAIN');
    if (data.Error) {
      requireThat(!Object.hasOwn(data,'InstanceIdSet'),'CLOUD_RESPONSE_UNCERTAIN'); // Contradictory ACK cannot prove no creation.
      const error = new Error('CLOUD_API_ERROR');
      error.code = /^[A-Za-z0-9.]{1,100}$/.test(data.Error.Code) ? data.Error.Code : 'Unknown';
      error.requestId = data.RequestId;
      if(service==='cvm'&&action==='RunInstances')error.denialDiagnostic=safeDenialDiagnostic(service,action,payload,data.Error.Message,{accountId:this.diagnosticAccountId,region:this.region});
      throw error; // Never include vendor messages or credentials in logs.
    }
    if(service==='sts'&&action==='GetCallerIdentity'&&/^[0-9]{1,20}$/.test(String(data.AccountId)))this.diagnosticAccountId=String(data.AccountId);
    return data;
  }
}

export function runParameters(config, request, clientToken, userData, slot, opId) {
  validateConfig(config, {apply: true,expenditure:false});
  requireThat(/^[a-f0-9]{64}$/.test(clientToken), 'CLIENT_TOKEN_BOUND');
  requireThat(request.account_id === config.account_id && request.region === config.region && request.instance_id === null &&
    request.instance_count === 1 && request.source_sha256 === config.source_sha256 && request.image_sha256 === config.image_sha256, 'LAUNCH_BINDING');
  requireThat(Number.isInteger(slot) && slot >= 0 && slot < 2, 'INVENTORY_SLOT');
  requireThat(userData===bootstrapUserData(config,request,slot),'BOOTSTRAP_SLOT_MANIFEST_DRIFT');
  requireThat(Buffer.byteLength(userData) <= 16384, 'USER_DATA_BOUND');
  return {InstanceChargeType: 'POSTPAID_BY_HOUR', InstanceCount: 1, ClientToken: clientToken,
    Placement: {Zone: config.zone}, InstanceType: config.instance_type, ImageId: config.image_id,
    SystemDisk: {DiskType: 'CLOUD_PREMIUM', DiskSize: 40}, DataDisks: [{DiskType: 'CLOUD_PREMIUM', DiskSize: 80, DeleteWithInstance: true}],
    VirtualPrivateCloud: {VpcId: config.vpc_id, SubnetId: config.subnet_id}, SecurityGroupIds: [config.security_group_id],
    InternetAccessible: {PublicIpAssigned: false, InternetMaxBandwidthOut: 0}, CamRoleName: config.role_names[slot],
    UserData: Buffer.from(userData).toString('base64'),
    TagSpecification: [{ResourceType: 'instance', Tags: [{Key: 'bondbuddy-pool', Value: config.pool_tag}, {Key: 'bondbuddy-create-op', Value: opId},executionSlotReadTag(config.pool_tag,config.role_names[slot])]}]};
}

export class TencentCvm {
  constructor({transport, config, archive, control, now = Date.now}) { Object.assign(this, {transport, config, archive, control, now}); }
  async verifyRetainedNode(instanceId) {
    const p=retainedNodePin(this.config,instanceId);
    if(!p)return;
    requireThat(this.control?.snapshot&&this.control?.loadOperation,'RETAINED_NODE_REGISTRY_REQUIRED');
    const snapshot=await this.control.snapshot();
    const matches=snapshot.nodes.filter(n=>n.identity.account_id===this.config.account_id&&n.identity.region===this.config.region&&n.identity.instance_id===instanceId);
    const n=matches[0];
    requireThat(matches.length===1&&n.state!=='destroyed'&&!n.destroyed_at&&n.source_sha256===p.source_sha256&&
      n.image_sha256===p.image_sha256&&n.launch_manifest_sha256===p.launch_manifest_sha256&&
      canonical(n.expected_services)===canonical(this.config.services),'RETAINED_NODE_REGISTRY_DRIFT');
    // A warm epoch changes cloud_start_operation_id. Load the original Run by
    // its trusted pin, preserving both original acceptance and current node.
    const original=await this.control.loadOperation(p.create_operation_id);
    requireThat(original?.operation_id===p.create_operation_id&&original.state==='completed'&&original.identity?.account_id===this.config.account_id&&
      original.identity.region===this.config.region&&original.identity.instance_id===instanceId&&executionRunAcceptanceMatches(original,original.run_acceptance)&&
      original.run_acceptance.launch_binding_sha256===p.launch_binding_sha256,'RETAINED_NODE_CREATION_DRIFT');
    requireRetainedRequest(this.config,instanceId,original.request);
    const c=nodeLaunchConfig(this.config,instanceId),slot=c.role_names.indexOf(p.role_name);
    requireThat(sha256(canonical(runParameters(c,original.request,original.client_token,bootstrapUserData(c,original.request,slot),slot,original.operation_id)))===p.launch_manifest_sha256,
      'RETAINED_NODE_MANIFEST_DRIFT');
  }
  async assertAccount() {
    const data = await this.transport.call('sts', 'GetCallerIdentity', {});
    requireThat(String(data.AccountId) === this.config.account_id, 'CLOUD_ACCOUNT_MISMATCH');
  }
  async inventory() {
    await this.assertAccount();
    const data = await this.transport.call('cvm', 'DescribeInstances', {Filters: [{Name: 'tag:bondbuddy-pool', Values: [this.config.pool_tag]}], Limit: 100});
    requireThat(Number(data.TotalCount) === data.InstanceSet?.length && data.InstanceSet.length <= 2, 'INVENTORY_DRIFT');
    const result = [];
    for (const i of data.InstanceSet) result.push(await this.describe(i.InstanceId));
    requireThat(new Set(result.map(i => i.role_name)).size === result.length, 'ROLE_SLOT_DUPLICATED');
    return result;
  }
  async describe(instanceId) {
    requireThat(/^ins-[a-z0-9]+$/.test(instanceId), 'INSTANCE_ID');
    await this.verifyRetainedNode(instanceId);
    const pin=retainedNodePin(this.config,instanceId),config=nodeLaunchConfig(this.config,instanceId);
    await this.assertAccount();
    const data = await this.transport.call('cvm', 'DescribeInstances', {InstanceIds: [instanceId]});
    const instances = data.InstanceSet;
    requireThat(instances?.length === 1 && instances[0].InstanceId === instanceId, 'EXACT_INSTANCE_UNOBSERVED');
    const i = instances[0], tags = new Map((i.Tags ?? []).map(x => [x.Key, x.Value]));
    requireThat(tags.get('bondbuddy-pool') === this.config.pool_tag && i.Placement?.Zone === this.config.zone &&
      i.InstanceType === this.config.instance_type && i.InstanceChargeType === 'POSTPAID_BY_HOUR' &&
      i.VirtualPrivateCloud?.VpcId === this.config.vpc_id && i.VirtualPrivateCloud?.SubnetId === this.config.subnet_id &&
      this.config.role_names.includes(i.CamRoleName), 'CLOUD_OWNERSHIP_DRIFT');
    requireThat(i.ImageId === config.image_id && i.SecurityGroupIds?.length === 1 && i.SecurityGroupIds[0] === this.config.security_group_id &&
      i.SystemDisk?.DiskSize === 40 && i.SystemDisk.DiskType === 'CLOUD_PREMIUM' &&
      i.DataDisks?.length === 1 && i.DataDisks[0].DiskSize === 80 && i.DataDisks[0].DiskType === 'CLOUD_PREMIUM' &&
      !i.PublicIpAddresses?.length, 'CLOUD_LAUNCH_DRIFT');
    if(pin)requireThat(i.CamRoleName===pin.role_name&&i.Tags?.filter(t=>t.Key==='bondbuddy-create-op').length===1&&
      tags.get('bondbuddy-create-op')===pin.create_operation_id&&sha256(canonical(executionInstanceLaunchBinding(i)))===pin.launch_binding_sha256,'RETAINED_NODE_CLOUD_DRIFT');
    const slot=this.config.role_names.indexOf(i.CamRoleName),tag=executionSlotReadTag(this.config.pool_tag,this.config.role_names[slot]);
    requireThat(i.Tags?.filter(t=>t.Key===tag.Key).length===1&&tags.get(tag.Key)===tag.Value,'CLOUD_SLOT_TAG_DRIFT');
    const peers=await this.transport.call('cvm','DescribeInstances',{Filters:[{Name:`tag:${tag.Key}`,Values:[tag.Value]}],Limit:3});
    requireThat(peers.TotalCount===1&&peers.InstanceSet?.length===1&&peers.InstanceSet[0].InstanceId===instanceId,'CLOUD_SLOT_NOT_UNIQUE');
    const safe = {account_id: this.config.account_id, region: this.config.region, instance_id: instanceId, role_name: i.CamRoleName,
      instance_state: i.InstanceState, latest_operation: i.LatestOperation??null, latest_operation_state: i.LatestOperationState??null,
      latest_operation_request_id: i.LatestOperationRequestId ?? null, create_operation_id: tags.get('bondbuddy-create-op') ?? null,
      stop_charging_mode: i.StopChargingMode ?? null,
      created_at:i.CreatedTime??null,launch_binding_sha256:sha256(canonical(executionInstanceLaunchBinding(i))),
      observed_at: new Date(this.now()).toISOString(), request_id: data.RequestId};
    const bytes = canonical(safe), evidence = await this.archive(bytes);
    requireThat(evidence.sha256 === sha256(bytes) && evidence.ref, 'CLOUD_EVIDENCE_NOT_DURABLE');
    return {...safe, evidence_ref: evidence.ref, evidence_sha256: evidence.sha256};
  }
  async describeRun(operation) {
    requireThat(executionRunAcceptanceMatches(operation,operation.run_acceptance),'RUN_ACCEPTANCE_UNPROVEN');
    const i=await this.describe(operation.identity.instance_id),slot=this.config.role_names.indexOf(i.role_name);
    requireRetainedRequest(this.config,i.instance_id,operation.request);
    const config=nodeLaunchConfig(this.config,i.instance_id);
    requireThat(slot>=0&&i.create_operation_id===operation.operation_id&&i.launch_binding_sha256===operation.run_acceptance.launch_binding_sha256&&
      sha256(canonical(runParameters(config,operation.request,operation.client_token,bootstrapUserData(config,operation.request,slot),slot,operation.operation_id)))===operation.request.launch_manifest_sha256,'RUN_CREATION_SCOPE');
    const status=await this.transport.call('cvm','DescribeInstancesStatus',{InstanceIds:[operation.identity.instance_id]});
    requireThat(status.InstanceStatusSet?.length===1&&status.InstanceStatusSet[0].InstanceId===operation.identity.instance_id,'RUN_STATUS_SCOPE');
    const safe={instance_state:i.instance_state,latest_operation:i.latest_operation,latest_operation_state:i.latest_operation_state,
      latest_operation_request_id:i.latest_operation_request_id,stop_charging_mode:i.stop_charging_mode,observed_at:new Date(this.now()).toISOString(),
      run_creation:{operation_id:operation.operation_id,identity:operation.identity,launch_manifest_sha256:operation.request.launch_manifest_sha256,
        launch_binding_sha256:i.launch_binding_sha256,created_at:i.created_at,instance_status:status.InstanceStatusSet[0].InstanceState,status_request_id:status.RequestId}};
    const evidence=await this.archive(canonical(safe));requireThat(evidence.sha256===sha256(canonical(safe))&&evidence.ref,'RUN_CREATION_EVIDENCE');
    return {...safe,evidence_ref:evidence.ref,evidence_sha256:evidence.sha256};
  }
  async execute(operation, {userData, slot} = {}) {
    requireThat(operation.action!=='destroy','EXECUTION_DESTROY_UNSUPPORTED');
    if(operation.action==='stop')requireThat(executionStopAuthorizationMatches(operation,v=>sha256(canonical(v))),'STOP_PROOF_REQUIRED');
    validateConfig(this.config, {apply: true, expenditure: operation.action !== 'stop'});
    await this.assertAccount();
    if (operation.action === 'run') {
      const params = runParameters(this.config, operation.request, operation.client_token, userData, slot, operation.operation_id);
      requireThat(sha256(canonical(params)) === operation.request.launch_manifest_sha256, 'LAUNCH_MANIFEST_MISMATCH');
      try {
        const result=await this.transport.call('cvm', 'RunInstances', params);
        requireThat(result.RequestId&&result.InstanceIdSet?.length===1&&/^ins-[a-z0-9]+$/.test(result.InstanceIdSet[0]),'EXACT_RUN_RESULT_REQUIRED');
        const accepted={operation_id:operation.operation_id,identity:{account_id:operation.request.account_id,region:operation.request.region,instance_id:result.InstanceIdSet[0],epoch:operation.request.epoch},
          provider_request_id:result.RequestId,instance_ids:result.InstanceIdSet,client_token:operation.client_token,launch_manifest_sha256:operation.request.launch_manifest_sha256,
          launch_binding_sha256:sha256(canonical(executionInstanceLaunchBinding({...params,Tags:params.TagSpecification[0].Tags,PublicIpAddresses:[]})))};
        const evidence=await this.archive(canonical(accepted));requireThat(evidence.sha256===sha256(canonical(accepted))&&evidence.ref,'RUN_ACCEPTANCE_EVIDENCE');
        return {...result,run_acceptance:{...accepted,evidence_ref:evidence.ref,evidence_sha256:evidence.sha256}};
      } catch(error) {
        if(error.code && typeof error.requestId==='string') {
          const bytes=canonical({version:'execution-run-denial-v1',service:'cvm',action:'RunInstances',instance_count:1,operation_id:operation.operation_id,
            account_id:operation.request.account_id,region:operation.request.region,launch_manifest_sha256:operation.request.launch_manifest_sha256,
            client_token_sha256:sha256(operation.client_token),code:error.code,request_id:error.requestId,
            ...(error.denialDiagnostic?{diagnostic:{actions:['name/cvm:RunInstances'],resources:error.denialDiagnostic.resources.filter(v=>v.length<=512&&v.includes(`:ap-beijing:uin/${this.config.account_id}:`)&&/^(qcs::|qcs:id\/0:)/.test(v))}}:{})});
          const evidence=await this.archive(bytes);
          requireThat(evidence.sha256===sha256(bytes)&&evidence.ref,'REJECTION_EVIDENCE_REQUIRED');
          error.capacityEvidence={code:error.code,request_id:error.requestId,evidence_ref:evidence.ref,evidence_sha256:evidence.sha256};
        }
        throw error;
      }
    }
    requireThat(operation.identity?.account_id === this.config.account_id && operation.identity.region === this.config.region, 'OPERATION_SCOPE');
    const i = await this.describe(operation.identity.instance_id);
    if (operation.action === 'start') {
      requireThat(i.instance_state === 'STOPPED', 'START_REQUIRES_STOPPED');
      requireThat(i.create_operation_id,'WARM_START_CREATION_UNPROVEN');
      const oldRequest={...operation.request,instance_id:null};
      requireRetainedRequest(this.config,i.instance_id,operation.request);
      const config=nodeLaunchConfig(this.config,i.instance_id);
      const {executionCloudClientToken}=await import('@bondbuddy/api/execution-capacity');
      const oldParams=runParameters(config,oldRequest,executionCloudClientToken(i.create_operation_id),bootstrapUserData(config,oldRequest,this.config.role_names.indexOf(i.role_name)),
        this.config.role_names.indexOf(i.role_name),i.create_operation_id);
      requireThat(sha256(canonical(oldParams))===operation.request.launch_manifest_sha256,'WARM_START_CLOUD_MANIFEST_DRIFT');
      return this.transport.call('cvm', 'StartInstances', {InstanceIds: [i.instance_id]});
    }
    requireThat(operation.action === 'stop' && executionStopAuthorizationMatches(operation,v=>sha256(canonical(v))), 'STOP_PROOF_REQUIRED');
    requireThat(i.instance_state === 'RUNNING', 'STOP_REQUIRES_RUNNING');
    return this.transport.call('cvm', 'StopInstances', {InstanceIds: [i.instance_id], StopType: 'SOFT', StoppedMode: 'STOP_CHARGING'});
  }
  async capacityRejection(error) {
    const evidence=error.capacityEvidence;
    if(!evidence)return null;
    const {EXECUTION_RUN_CAPACITY_REJECTIONS}=await import('@bondbuddy/contracts');
    return EXECUTION_RUN_CAPACITY_REJECTIONS.includes(evidence.code)?evidence:null;
  }
}
