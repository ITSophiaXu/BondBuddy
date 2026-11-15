import {createHmac} from 'node:crypto';
import {canonical, sha256, requireThat, validateConfig} from './policy.mjs';
import {bootstrapUserData} from './bootstrap.mjs';

const apiVersion = {cvm: '2017-03-12', sts: '2018-08-13', ssm: '2019-09-23', tag: '2018-08-13'};
const allowedActions = {cvm: new Set(['RunInstances', 'StartInstances', 'StopInstances', 'DescribeInstances']),
  sts: new Set(['GetCallerIdentity']), ssm: new Set(['GetSecretValue', 'PutSecretValue','ListSecretVersionIds','DeleteSecretVersion']), tag: new Set(['ModifyResourceTags'])};
const hmac = (key, value, encoding) => createHmac('sha256', key).update(value).digest(encoding);

/** Official TC3 signature; credentials are refreshed in memory by the existing ops/role source. */
export class TencentTransport {
  constructor({credentials, region, fetchImpl = fetch, now = Date.now, timeoutMs = 15000, purpose = 'role', assumeRoleArn}) {
    requireThat(region === 'ap-beijing' && timeoutMs > 0 && timeoutMs <= 20000, 'TRANSPORT_SCOPE');
    requireThat(['role','control-source'].includes(purpose) && (purpose!=='control-source' ||
      /^qcs::cam::uin\/\d{1,20}:roleName\/bondbuddy-execution-control$/.test(assumeRoleArn??'')), 'SOURCE_ROLE_SCOPE');
    Object.assign(this, {credentials, region, fetchImpl, now, timeoutMs, purpose, assumeRoleArn});
  }
  async call(service, action, payload) {
    const source=this.purpose==='control-source';
    requireThat(source ? service==='sts' && action==='AssumeRole' && payload?.RoleArn===this.assumeRoleArn &&
      Object.keys(payload).every(k=>['RoleArn','RoleSessionName','DurationSeconds'].includes(k)) &&
      /^[A-Za-z0-9+=,.@_-]{2,128}$/.test(payload.RoleSessionName??'') &&
      Number.isInteger(payload.DurationSeconds) && payload.DurationSeconds>=900 && payload.DurationSeconds<=7200 :
      allowedActions[service]?.has(action), 'ACTION_NOT_ALLOWED');
    const c = await this.credentials();
    requireThat(typeof c.secretId==='string' && c.secretId && typeof c.secretKey==='string' && c.secretKey &&
      (source ? !c.token : c.token && Number(c.expiresAt) > this.now() + 60000), 'SHORT_CREDENTIAL_REQUIRED');
    const body = canonical(payload), host = `${service}.tencentcloudapi.com`;
    const timestamp = Math.floor(this.now() / 1000), date = new Date(timestamp * 1000).toISOString().slice(0, 10);
    const headers = `content-type:application/json; charset=utf-8\nhost:${host}\n`;
    const request = `POST\n/\n\n${headers}\ncontent-type;host\n${sha256(body)}`;
    const scope = `${date}/${service}/tc3_request`;
    const key = hmac(hmac(hmac(`TC3${c.secretKey}`, date), service), 'tc3_request');
    const signature = hmac(key, `TC3-HMAC-SHA256\n${timestamp}\n${scope}\n${sha256(request)}`, 'hex');
    const response = await this.fetchImpl(`https://${host}/`, {method: 'POST', redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs), body,
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
      const error = new Error('CLOUD_API_ERROR');
      error.code = /^[A-Za-z0-9.]{1,100}$/.test(data.Error.Code) ? data.Error.Code : 'Unknown';
      error.requestId = data.RequestId;
      throw error; // Never include vendor messages or credentials in logs.
    }
    return data;
  }
}

export function runParameters(config, request, clientToken, userData, slot, opId) {
  validateConfig(config, {apply: true,expenditure:false});
  requireThat(/^[a-f0-9]{64}$/.test(clientToken), 'CLIENT_TOKEN_BOUND');
  requireThat(request.account_id === config.account_id && request.region === config.region && request.instance_id === null &&
    request.instance_count === 1 && request.source_sha256 === config.source_sha256 && request.image_sha256 === config.image_sha256, 'LAUNCH_BINDING');
  requireThat(Number.isInteger(slot) && slot >= 0 && slot < 2, 'INVENTORY_SLOT');
  requireThat(Buffer.byteLength(userData) <= 16384, 'USER_DATA_BOUND');
  return {InstanceChargeType: 'POSTPAID_BY_HOUR', InstanceCount: 1, ClientToken: clientToken,
    Placement: {Zone: config.zone}, InstanceType: config.instance_type, ImageId: config.image_id,
    SystemDisk: {DiskType: 'CLOUD_PREMIUM', DiskSize: 40}, DataDisks: [{DiskType: 'CLOUD_PREMIUM', DiskSize: 80, DeleteWithInstance: true}],
    VirtualPrivateCloud: {VpcId: config.vpc_id, SubnetId: config.subnet_id}, SecurityGroupIds: [config.security_group_id],
    InternetAccessible: {PublicIpAssigned: false, InternetMaxBandwidthOut: 0}, CamRoleName: config.role_names[slot],
    UserData: Buffer.from(userData).toString('base64'),
    TagSpecification: [{ResourceType: 'instance', Tags: [{Key: 'bondbuddy-pool', Value: config.pool_tag}, {Key: 'bondbuddy-create-op', Value: opId}]}]};
}

export class TencentCvm {
  constructor({transport, config, archive, now = Date.now}) { Object.assign(this, {transport, config, archive, now}); }
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
    await this.assertAccount();
    const data = await this.transport.call('cvm', 'DescribeInstances', {InstanceIds: [instanceId]});
    const instances = data.InstanceSet;
    requireThat(instances?.length === 1 && instances[0].InstanceId === instanceId, 'EXACT_INSTANCE_UNOBSERVED');
    const i = instances[0], tags = new Map((i.Tags ?? []).map(x => [x.Key, x.Value]));
    requireThat(tags.get('bondbuddy-pool') === this.config.pool_tag && i.Placement?.Zone === this.config.zone &&
      i.InstanceType === this.config.instance_type && i.InstanceChargeType === 'POSTPAID_BY_HOUR' &&
      i.VirtualPrivateCloud?.VpcId === this.config.vpc_id && i.VirtualPrivateCloud?.SubnetId === this.config.subnet_id &&
      this.config.role_names.includes(i.CamRoleName), 'CLOUD_OWNERSHIP_DRIFT');
    requireThat(i.ImageId === this.config.image_id && i.SecurityGroupIds?.length === 1 && i.SecurityGroupIds[0] === this.config.security_group_id &&
      i.SystemDisk?.DiskSize === 40 && i.SystemDisk.DiskType === 'CLOUD_PREMIUM' &&
      i.DataDisks?.length === 1 && i.DataDisks[0].DiskSize === 80 && i.DataDisks[0].DiskType === 'CLOUD_PREMIUM' &&
      !i.PublicIpAddresses?.length, 'CLOUD_LAUNCH_DRIFT');
    const safe = {account_id: this.config.account_id, region: this.config.region, instance_id: instanceId, role_name: i.CamRoleName,
      instance_state: i.InstanceState, latest_operation: i.LatestOperation, latest_operation_state: i.LatestOperationState,
      latest_operation_request_id: i.LatestOperationRequestId ?? null, create_operation_id: tags.get('bondbuddy-create-op') ?? null,
      stop_charging_mode: i.StopChargingMode ?? null,
      observed_at: new Date(this.now()).toISOString(), request_id: data.RequestId};
    const bytes = canonical(safe), evidence = await this.archive(bytes);
    requireThat(evidence.sha256 === sha256(bytes) && evidence.ref, 'CLOUD_EVIDENCE_NOT_DURABLE');
    return {...safe, evidence_ref: evidence.ref, evidence_sha256: evidence.sha256};
  }
  async execute(operation, {userData, slot} = {}) {
    validateConfig(this.config, {apply: true, expenditure: operation.action !== 'stop'});
    await this.assertAccount();
    if (operation.action === 'run') {
      const params = runParameters(this.config, operation.request, operation.client_token, userData, slot, operation.operation_id);
      requireThat(sha256(canonical(params)) === operation.request.launch_manifest_sha256, 'LAUNCH_MANIFEST_MISMATCH');
      try {return await this.transport.call('cvm', 'RunInstances', params);} catch(error) {
        if(error.code && typeof error.requestId==='string') {
          const bytes=canonical({service:'cvm',action:'RunInstances',instance_count:1,operation_id:operation.operation_id,
            client_token_sha256:sha256(operation.client_token),code:error.code,request_id:error.requestId});
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
      const {executionCloudClientToken}=await import('@bondbuddy/api/execution-capacity');
      const oldParams=runParameters(this.config,oldRequest,executionCloudClientToken(i.create_operation_id),bootstrapUserData(this.config,oldRequest),
        this.config.role_names.indexOf(i.role_name),i.create_operation_id);
      requireThat(sha256(canonical(oldParams))===operation.request.launch_manifest_sha256,'WARM_START_CLOUD_MANIFEST_DRIFT');
      return this.transport.call('cvm', 'StartInstances', {InstanceIds: [i.instance_id]});
    }
    requireThat(operation.action === 'stop' && operation.proof_sha256, 'STOP_PROOF_REQUIRED');
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
