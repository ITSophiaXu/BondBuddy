import {enrollmentVersionId,ENROLLMENT_RECOVERY_GENERATIONS} from './enrollment-version.mjs';
import {randomBytes} from 'node:crypto';
import {open, mkdir} from 'node:fs/promises';
import {constants} from 'node:fs';
import {TencentTransport} from './tencent-cvm.mjs';
import {readRoleCredentials} from './bootstrap.mjs';
import {canonical, requireThat, sha256} from './policy.mjs';
import {readPrivateJson} from './private-files.mjs';
import {issueTransportCredentials} from './transport-issuer.mjs';
import {pruneRetiredNodeVersions} from './transport-renewal.mjs';
import {executionCloudCompletionMatches,executionInstanceLaunchBinding,executionSlotReadTag} from '@bondbuddy/contracts';

/** CAM isolates a slot, not a dynamic self ARN. Refuse duplicate slot inventory
 * before enrollment or refresh, then verify the exact local instance again. */
export async function readNodeSlotInstance(config,instanceId,read) {
  const tag=executionSlotReadTag(config.pool_tag,config.role_name);
  const peers=await read('cvm','DescribeInstances',{Filters:[{Name:`tag:${tag.Key}`,Values:[tag.Value]}],Limit:3});
  requireThat(peers.TotalCount===1&&peers.InstanceSet?.length===1&&peers.InstanceSet[0].InstanceId===instanceId,'NODE_SLOT_NOT_UNIQUE');
  const description=await read('cvm','DescribeInstances',{InstanceIds:[instanceId]});
  const i=description.InstanceSet?.[0];
  requireThat(description.InstanceSet?.length===1&&i.InstanceId===instanceId&&i.CamRoleName===config.role_name&&
    i.Tags?.filter(t=>t.Key==='bondbuddy-pool').length===1&&i.Tags.find(t=>t.Key==='bondbuddy-pool').Value===config.pool_tag&&
    i.Tags.filter(t=>t.Key===tag.Key).length===1&&i.Tags.find(t=>t.Key===tag.Key).Value===tag.Value,'NODE_INSTANCE_SCOPE');
  return i;
}

export const NODE_SECRET_VERSION_LIMIT=10;
export const NODE_SECRET_SCAN_CALL_BOUND=11;
export const NODE_ENROLLMENT_ATTEMPT_BOUND=6;
export const NODE_ENROLLMENT_DEADLINE_MS=180000;
/** No mutable tag pointer: enumerate only the role's exclusive Secret. */
export async function readNodeSecretVersions(config,read) {
  const list=await read('ssm','ListSecretVersionIds',{SecretName:config.secret_name});
  requireThat(list.SecretName===config.secret_name&&Array.isArray(list.Versions)&&list.Versions.length<=NODE_SECRET_VERSION_LIMIT&&
    list.Versions.every(v=>/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(v.VersionId??''))&&
    new Set(list.Versions.map(v=>v.VersionId)).size===list.Versions.length,'NODE_SECRET_VERSION_INVENTORY');
  const values=[];
  for(const v of list.Versions){
    const r=await read('ssm','GetSecretValue',{SecretName:config.secret_name,VersionId:v.VersionId});
    requireThat(r.SecretName===config.secret_name&&r.VersionId===v.VersionId&&typeof r.SecretString==='string'&&!r.SecretBinary,'NODE_SECRET_VERSION_MISMATCH');
    try{values.push({version_id:v.VersionId,value:JSON.parse(r.SecretString)});}catch{} // bootstrap-pending is not an enrollment
  }
  return values;
}

/** The exclusive secret carries the original durable acceptance and action.
 * Fresh own-instance readback must still match that immutable launch binding. */
export function nodeCloudCompletionMatches(envelope,instance) {
  if(envelope.operation_action==='run'&&
    !(instance.LatestOperation==null&&instance.LatestOperationState==null&&instance.LatestOperationRequestId==null||
      instance.LatestOperation==='RunInstances'&&instance.LatestOperationState==='SUCCESS'&&instance.LatestOperationRequestId===envelope.provider_request_id))return false;
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
export function createSsmEnrollmentBroker({config, transport, now = Date.now, wait = ms => new Promise(resolve=>setTimeout(resolve,ms)), attempts=NODE_ENROLLMENT_ATTEMPT_BOUND}) {
  transport ??= new TencentTransport({region: config.region, credentials: () => readRoleCredentials(config.role_name)});
  let deadline,signal,enrolling=false;
  const read=async(service,action,payload)=>{
    requireThat(now()<deadline&&!signal.aborted,'NODE_ENROLLMENT_DEADLINE');
    try{const result=await transport.call(service,action,payload,{signal});
      requireThat(now()<deadline&&!signal.aborted,'NODE_ENROLLMENT_DEADLINE');return result;}catch(error){
      // The preinstalled slot read policy may still be propagating.
      // Only explicit denial on these read-only calls can wait within the boot
      // bound; identity errors, unknown transport failures and mutations cannot.
      if(['DescribeInstances','GetSecretValue','ListSecretVersionIds'].includes(action)&&error.code==='UnauthorizedOperation'&&
        typeof error.requestId==='string'&&error.requestId.length>0)throw Error('NODE_ENROLLMENT_PENDING');
      throw error;
    }
  };
  const once=async metadata => {
    const caller = await read('sts', 'GetCallerIdentity', {});
    requireThat(String(caller.AccountId) === config.account_id && String(caller.UserId).startsWith(`${config.role_id}:`), 'NODE_ROLE_MISMATCH');
    // Creation tags stay fixed. The role cannot mutate tags or secrets, and
    // warm boots select only the version proven by the current cloud action.
    const instance=await readNodeSlotInstance(config,metadata.instance_id,read);
    const candidates=[];
    for(const {version_id,value:envelope} of await readNodeSecretVersions(config,read)){
      if(!envelope||!['run','start'].includes(envelope.operation_action)||!envelope.identity||
        !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(envelope.operation_id??'')||!envelope.provider_request_id||
        envelope.version==='execution-transport-envelope-v1'||
        !nodeCloudCompletionMatches(envelope,instance)||envelope.expires_at<=now()+60000)continue;
      requireThat(envelope.identity?.account_id===config.account_id&&envelope.identity.region===config.region&&
        envelope.identity.instance_id===metadata.instance_id&&envelope.role_id===config.role_id&&
        /^[a-f0-9-]{36}$/.test(envelope.identity.epoch??'')&&envelope.expires_at<=now()+900000&&
        envelope.operation_completed===true&&enrollmentVersionId(envelope.operation_id,envelope.enrollment_generation??0)===version_id&&
        envelope.source_sha256===config.source_sha256&&envelope.image_sha256===config.image_sha256&&
        canonical(envelope.services)===canonical(config.services),'NODE_SECRET_BINDING');
      candidates.push(envelope);
    }
    requireThat(candidates.length<=1,'NODE_SECRET_AMBIGUOUS');
    requireThat(candidates.length===1,'NODE_ENROLLMENT_PENDING');
    const envelope=candidates[0];
    requireThat(nodeCloudCompletionMatches(envelope,await readNodeSlotInstance(config,metadata.instance_id,read)),'NODE_ENROLLMENT_PENDING');
    // This assertion is supported by exclusive SSM authorization and a PG-bound
    // unpredictable token. Metadata alone cannot manufacture a valid envelope.
    return {...envelope, verified: true};
  };
  return {async enroll(metadata){
    requireThat(Number.isInteger(attempts)&&attempts>0&&attempts<=NODE_ENROLLMENT_ATTEMPT_BOUND,'ENROLLMENT_WAIT_BOUND');
    requireThat(!enrolling,'NODE_ENROLLMENT_BUSY');enrolling=true;
    try{
      deadline=now()+NODE_ENROLLMENT_DEADLINE_MS;signal=AbortSignal.timeout(NODE_ENROLLMENT_DEADLINE_MS);
      for(let i=0;i<attempts;i++)try{return await once(metadata);}catch(error){
        if(error.message!=='NODE_ENROLLMENT_PENDING'||i===attempts-1)throw error;
        requireThat(now()+30000<deadline&&!signal.aborted,'NODE_ENROLLMENT_DEADLINE');
        await wait(30000); // six scans include windows after the next control tick
      }
    }finally{enrolling=false;}
  }};
}

/** Runs only after exact cloud start completion. The private service template
 * holds newly issued service credentials, never copied personal login state. */
export async function issueNodeEnrollment({operation, slot, config, transport, bind, serviceTemplate, retirement = async()=>({operations:[],nodes:[]}), now = Date.now}) {
  requireThat(operation.state === 'completed' && ['run', 'start'].includes(operation.action) && operation.identity,
    'START_COMPLETION_REQUIRED');
  requireThat(executionCloudCompletionMatches(operation,operation.cloud_observation),'START_COMPLETION_REQUIRED');
  const descriptor = config.node_secrets[slot];
  requireThat(descriptor && descriptor.role_name===config.role_names[slot] &&
    operation.provider_request_id && operation.identity.account_id === config.account_id && operation.identity.region === config.region,
    'ISSUER_SCOPE');
  requireThat(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(operation.operation_id), 'SECRET_VERSION_BOUND');
  await mkdir(config.registration_directory, {recursive: true, mode: 0o700});
  const originalPath = `${config.registration_directory}/${sha256(operation.operation_id)}.json`;
  let payload, vaultPath, versionId, previous;
  for(let generation=0;generation<=ENROLLMENT_RECOVERY_GENERATIONS;generation++) {
    versionId=enrollmentVersionId(operation.operation_id,generation);
    vaultPath=generation===0?originalPath:`${originalPath}.enrollment-${generation}`;
    try { payload=await readPrivateJson(vaultPath); }
    catch(error) {
      if(error.code!=='ENOENT')throw error;
      const transportCredentials=descriptor.pg_issuer?await issueTransportCredentials(operation.identity,descriptor.pg_issuer,{now,operation}):serviceTemplate.transport_credentials;
      const proposed = {...serviceTemplate,...(transportCredentials?{transport_credentials:transportCredentials}:{}), identity: operation.identity, role_id: descriptor.role_id,
        services: operation.request.services, source_sha256: operation.request.source_sha256,
        image_sha256: operation.request.image_sha256, launch_manifest_sha256: operation.request.launch_manifest_sha256,
        registration_token: previous?.registration_token??randomBytes(32).toString('base64url'), expires_at: now() + 600000,
        operation_id: operation.operation_id, provider_request_id:operation.provider_request_id, operation_completed: true,
        ...(generation?{enrollment_generation:generation}:{}),
        operation_action:operation.action,...(operation.action==='run'?{run_acceptance:operation.run_acceptance,run_creation:operation.cloud_observation?.run_creation}:{})};
      try {
        const f=await open(vaultPath,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
        try {await f.writeFile(canonical(proposed));await f.sync();}finally{await f.close();}
        payload=proposed;
      } catch(error) {if(error.code!=='EEXIST')throw error;payload=await readPrivateJson(vaultPath);}
    }
    requireThat(payload.operation_id===operation.operation_id && canonical(payload.identity)===canonical(operation.identity) &&
      payload.provider_request_id===operation.provider_request_id && Number.isFinite(payload.expires_at) &&
      (payload.enrollment_generation??0)===generation &&
      (!previous||payload.registration_token===previous.registration_token) &&
      payload.source_sha256===operation.request.source_sha256&&payload.image_sha256===operation.request.image_sha256&&
      payload.launch_manifest_sha256===operation.request.launch_manifest_sha256&&canonical(payload.services)===canonical(operation.request.services),
      'ENROLLMENT_VAULT_CONFLICT');
    if(payload.expires_at>now()+60000)break;
    // Resolve the previous exact immutable publication before issuing another.
    // A lost ACK with absent/different readback cannot be bypassed by expiry.
    const confirmed=await transport.call('ssm','GetSecretValue',{SecretName:descriptor.secret_name,VersionId:versionId});
    requireThat(confirmed.SecretName===descriptor.secret_name&&confirmed.VersionId===versionId&&
      confirmed.SecretString===canonical(payload),'SECRET_PUBLISH_UNCONFIRMED');
    requireThat(generation<ENROLLMENT_RECOVERY_GENERATIONS,'ENROLLMENT_RECOVERY_EXHAUSTED');
    previous=payload;
  }
  await bind(operation.identity, operation.operation_id, payload.registration_token);
  const get = () => transport.call('ssm', 'GetSecretValue', {SecretName: descriptor.secret_name, VersionId: versionId});
  const matches = r => r.SecretName === descriptor.secret_name && r.VersionId === versionId &&
    r.SecretString && sha256(r.SecretString) === sha256(canonical(payload));
  let existing;
  try {existing = await get();} catch (e) {if (e.code !== 'ResourceNotFound' && !e.code?.startsWith('ResourceNotFound.')) throw e;}
  if (existing) requireThat(matches(existing), 'SECRET_VERSION_CONFLICT');
  else {
    let dispatched=false;
    // A previously dispatched Put only reads its original immutable version.
    // Prune and capacity checks run before the first dispatch, in the same
    // persisted control tick. For generation k, keep its k confirmed predecessors: k readbacks +
    // <=1+3*(10-k) prune calls + Get/Put/Get <=34. The original fee bound holds.
    try{const marker=await readPrivateJson(`${vaultPath}.dispatched`);
      requireThat(marker.operation_id===operation.operation_id&&marker.payload_sha256===sha256(canonical(payload)),'ENROLLMENT_DISPATCH_DRIFT');
      requireThat(matches(await get()),'SECRET_PUBLISH_UNCONFIRMED');
      return {instance_id:operation.identity.instance_id,epoch:operation.identity.epoch,expires_at:payload.expires_at,recovery_generation:payload.enrollment_generation??0};
    }catch(error){if(error.code!=='ENOENT')throw error;}
    const history=await retirement();
    requireThat(Array.isArray(history?.operations)&&Array.isArray(history.nodes),'SECRET_RETIREMENT_PROOF_REQUIRED');
    await pruneRetiredNodeVersions({secretName:descriptor.secret_name,keep:Array.from({length:(payload.enrollment_generation??0)+1},(_,g)=>enrollmentVersionId(operation.operation_id,g)),scope:operation.identity,
      operations:history.operations,nodes:history.nodes,transport,registrationDirectory:config.registration_directory,
      caSha256:descriptor.pg_issuer?.ca_sha256,now});
    try{const f=await open(`${vaultPath}.dispatched`,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
      try{await f.writeFile(canonical({operation_id:operation.operation_id,payload_sha256:sha256(canonical(payload))}));await f.sync();dispatched=true;}finally{await f.close();}
    }catch(error){if(error.code!=='EEXIST')throw error;const marker=await readPrivateJson(`${vaultPath}.dispatched`);
      requireThat(marker.operation_id===operation.operation_id&&marker.payload_sha256===sha256(canonical(payload)),'ENROLLMENT_DISPATCH_DRIFT');}
    if(dispatched)try {await transport.call('ssm', 'PutSecretValue', {SecretName: descriptor.secret_name,
      VersionId: versionId, SecretString: canonical(payload)});} catch { /* exact readback resolves unknown */ }
    requireThat(matches(await get()), 'SECRET_PUBLISH_UNCONFIRMED');
  }
  return {instance_id: operation.identity.instance_id, epoch: operation.identity.epoch, expires_at: payload.expires_at,recovery_generation:payload.enrollment_generation??0};
}
