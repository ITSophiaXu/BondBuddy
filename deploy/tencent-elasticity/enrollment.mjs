import {randomBytes} from 'node:crypto';
import {open, mkdir} from 'node:fs/promises';
import {constants} from 'node:fs';
import {TencentTransport} from './tencent-cvm.mjs';
import {readRoleCredentials} from './bootstrap.mjs';
import {canonical, requireThat, sha256} from './policy.mjs';
import {readPrivateJson} from './private-files.mjs';
import {issueTransportCredentials} from './transport-issuer.mjs';
import {executionCloudCompletionMatches,executionInstanceLaunchBinding} from '@bondbuddy/contracts';

/** The exclusive secret carries the original durable acceptance and action.
 * Fresh own-instance readback must still match that immutable launch binding. */
export function nodeCloudCompletionMatches(envelope,instance) {
  const op={operation_id:envelope.operation_id,action:envelope.operation_action,identity:envelope.identity,
    provider_request_id:envelope.provider_request_id,client_token:sha256(canonical(envelope.operation_id)),
    request:{launch_manifest_sha256:envelope.launch_manifest_sha256},run_acceptance:envelope.run_acceptance};
  const observed={instance_state:instance.InstanceState,latest_operation:instance.LatestOperation??null,latest_operation_state:instance.LatestOperationState??null,
    latest_operation_request_id:instance.LatestOperationRequestId??null,stop_charging_mode:instance.StopChargingMode??null,
    observed_at:new Date().toISOString(),evidence_ref:'exclusive-enrollment/readback',evidence_sha256:sha256(canonical(executionInstanceLaunchBinding(instance)))};
  if(op.action==='run'){
    if(instance.Tags?.filter(t=>t.Key==='bondbuddy-create-op'&&t.Value===op.operation_id).length!==1||
      sha256(canonical(executionInstanceLaunchBinding(instance)))!==op.run_acceptance?.launch_binding_sha256)return false;
    observed.run_creation=envelope.run_creation;
  }
  return executionCloudCompletionMatches(op,observed);
}

/** Node-exclusive role/secret. The image contains only the public name/version;
 * CAM enforces a different secret resource for each inventory slot. */
export function createSsmEnrollmentBroker({config, transport, now = Date.now, wait = ms => new Promise(resolve=>setTimeout(resolve,ms)), attempts=24}) {
  transport ??= new TencentTransport({region: config.region, credentials: () => readRoleCredentials(config.role_name)});
  const read=async(service,action,payload)=>{
    try{return await transport.call(service,action,payload);}catch(error){
      // First-boot exact-instance CAM attachment may still be propagating.
      // Only explicit denial on these read-only calls can wait within the boot
      // bound; identity errors, unknown transport failures and mutations cannot.
      if(['DescribeInstances','GetSecretValue'].includes(action)&&error.code==='UnauthorizedOperation'&&
        typeof error.requestId==='string'&&error.requestId.length>0)throw Error('NODE_ENROLLMENT_PENDING');
      throw error;
    }
  };
  const once=async metadata => {
    const caller = await transport.call('sts', 'GetCallerIdentity', {});
    requireThat(String(caller.AccountId) === config.account_id && String(caller.UserId).startsWith(`${config.role_id}:`), 'NODE_ROLE_MISMATCH');
    // A controlled public tag selects the explicit immutable secret version on
    // warm boots. StartInstances does not update old UserData. The node role can
    // Describe only its own instance; it cannot modify this tag or any secret.
    const description = await read('cvm', 'DescribeInstances', {InstanceIds: [metadata.instance_id]});
    requireThat(description.InstanceSet?.length === 1 && description.InstanceSet[0].InstanceId === metadata.instance_id &&
      description.InstanceSet[0].CamRoleName === config.role_name, 'NODE_INSTANCE_SCOPE');
    const version = description.InstanceSet[0].Tags?.find(t => t.Key === 'bondbuddy-enrollment-version')?.Value;
    requireThat(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(version??''), 'NODE_ENROLLMENT_PENDING');
    const result = await read('ssm', 'GetSecretValue', {SecretName: config.secret_name, VersionId: version});
    requireThat(result.SecretName === config.secret_name && result.VersionId === version &&
      typeof result.SecretString === 'string' && !result.SecretBinary, 'NODE_SECRET_VERSION_MISMATCH');
    const envelope = JSON.parse(result.SecretString);
    requireThat(nodeCloudCompletionMatches(envelope,description.InstanceSet[0]),'NODE_ENROLLMENT_PENDING');
    requireThat(envelope.identity?.account_id === config.account_id && envelope.identity.region === config.region &&
      envelope.identity.instance_id === metadata.instance_id && envelope.role_id === config.role_id &&
      envelope.expires_at > now() + 60000 && envelope.expires_at <= now() + 900000 &&
      envelope.operation_completed === true && envelope.operation_id === version, 'NODE_SECRET_BINDING');
    // This assertion is supported by exclusive SSM authorization and a PG-bound
    // unpredictable token. Metadata alone cannot manufacture a valid envelope.
    return {...envelope, verified: true};
  };
  return {async enroll(metadata){
    requireThat(Number.isInteger(attempts)&&attempts>0&&attempts<=24,'ENROLLMENT_WAIT_BOUND');
    for(let i=0;i<attempts;i++)try{return await once(metadata);}catch(error){
      if(error.message!=='NODE_ENROLLMENT_PENDING'||i===attempts-1)throw error;
      await wait(5000); // bounded boot handshake, not an independent scheduler
    }
  }};
}

/** Runs only after exact cloud start completion. The private service template
 * holds newly issued service credentials, never copied personal login state. */
export async function issueNodeEnrollment({operation, slot, config, transport, bind, serviceTemplate, now = Date.now}) {
  requireThat(operation.state === 'completed' && ['run', 'start'].includes(operation.action) && operation.identity,
    'START_COMPLETION_REQUIRED');
  requireThat(executionCloudCompletionMatches(operation,operation.cloud_observation),'START_COMPLETION_REQUIRED');
  const descriptor = config.node_secrets[slot];
  requireThat(descriptor && descriptor.role_name===config.role_names[slot] &&
    operation.provider_request_id && operation.identity.account_id === config.account_id && operation.identity.region === config.region,
    'ISSUER_SCOPE');
  requireThat(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(operation.operation_id), 'SECRET_VERSION_BOUND');
  const transportCredentials=descriptor.pg_issuer?await issueTransportCredentials(operation.identity,descriptor.pg_issuer,{now,operation}):serviceTemplate.transport_credentials;
  const proposed = {...serviceTemplate,...(transportCredentials?{transport_credentials:transportCredentials}:{}), identity: operation.identity, role_id: descriptor.role_id,
    services: operation.request.services, source_sha256: operation.request.source_sha256,
    image_sha256: operation.request.image_sha256, launch_manifest_sha256: operation.request.launch_manifest_sha256,
    registration_token: randomBytes(32).toString('base64url'), expires_at: now() + 600000,
    operation_id: operation.operation_id, provider_request_id:operation.provider_request_id, operation_completed: true,
    operation_action:operation.action,...(operation.action==='run'?{run_acceptance:operation.run_acceptance,run_creation:operation.cloud_observation?.run_creation}:{})};
  // Own credential vault persists the SAME token/payload across PG bind or SSM
  // publish timeouts. This is not an independent operation queue.
  await mkdir(config.registration_directory, {recursive: true, mode: 0o700});
  const vaultPath = `${config.registration_directory}/${sha256(operation.operation_id)}.json`;
  let payload;
  try {
    const f = await open(vaultPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try {await f.writeFile(canonical(proposed)); await f.sync();} finally {await f.close();}
    payload = proposed;
  } catch (e) {if (e.code !== 'EEXIST') throw e; payload = await readPrivateJson(vaultPath);}
  requireThat(payload.operation_id === operation.operation_id && canonical(payload.identity) === canonical(operation.identity) &&
    payload.provider_request_id===operation.provider_request_id && payload.expires_at > now() + 60000 &&
    payload.launch_manifest_sha256 === operation.request.launch_manifest_sha256 && canonical(payload.services)===canonical(operation.request.services),
    'ENROLLMENT_VAULT_CONFLICT');
  await bind(operation.identity, operation.operation_id, payload.registration_token);
  const get = () => transport.call('ssm', 'GetSecretValue', {SecretName: descriptor.secret_name, VersionId: operation.operation_id});
  const matches = r => r.SecretName === descriptor.secret_name && r.VersionId === operation.operation_id &&
    r.SecretString && sha256(r.SecretString) === sha256(canonical(payload));
  let existing;
  try {existing = await get();} catch (e) {if (e.code !== 'ResourceNotFound' && !e.code?.startsWith('ResourceNotFound.')) throw e;}
  if (existing) requireThat(matches(existing), 'SECRET_VERSION_CONFLICT');
  else {
    let dispatched=false;
    try{const f=await open(`${vaultPath}.dispatched`,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
      try{await f.writeFile(canonical({operation_id:operation.operation_id,payload_sha256:sha256(canonical(payload))}));await f.sync();dispatched=true;}finally{await f.close();}
    }catch(error){if(error.code!=='EEXIST')throw error;const marker=await readPrivateJson(`${vaultPath}.dispatched`);
      requireThat(marker.operation_id===operation.operation_id&&marker.payload_sha256===sha256(canonical(payload)),'ENROLLMENT_DISPATCH_DRIFT');}
    if(dispatched)try {await transport.call('ssm', 'PutSecretValue', {SecretName: descriptor.secret_name,
      VersionId: operation.operation_id, SecretString: canonical(payload)});} catch { /* exact readback resolves unknown */ }
    requireThat(matches(await get()), 'SECRET_PUBLISH_UNCONFIRMED');
  }
  await transport.call('tag', 'ModifyResourceTags', {Resource: `qcs::cvm:${config.region}:uin/${config.account_id}:instance/${operation.identity.instance_id}`,
    ReplaceTags: [{TagKey: 'bondbuddy-enrollment-version', TagValue: operation.operation_id}]});
  return {instance_id: operation.identity.instance_id, epoch: operation.identity.epoch, expires_at: payload.expires_at};
}
