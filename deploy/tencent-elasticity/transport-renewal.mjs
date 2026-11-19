import {enrollmentVersionMatches} from './enrollment-version.mjs';
import {X509Certificate,randomUUID} from 'node:crypto';
import {open,mkdir,rename,unlink} from 'node:fs/promises';
import {constants} from 'node:fs';
import {spawn} from 'node:child_process';
import {canonical,sha256,requireThat} from './policy.mjs';
import {readPrivateJson} from './private-files.mjs';
import {issueTransportCredentials} from './transport-issuer.mjs';
import {executionCloudCompletionMatches} from '@bondbuddy/contracts';
import {validateTransportCredentials} from './private-transport.mjs';

export const TRANSPORT_REFRESH_VERSION='execution-transport-refresh-v1';
export const TRANSPORT_RENEW_BEFORE_MS=6*60*60*1000;
export const TRANSPORT_ADMISSION_MARGIN_MS=2*60*60*1000;
export const transportExpiry=c=>Date.parse(new X509Certificate(c.cert_pem).validTo);
export function validateTransportRefreshResponse(request,response,now=Date.now()){
  requireThat(request?.version===TRANSPORT_REFRESH_VERSION&&response?.version===TRANSPORT_REFRESH_VERSION&&
    canonical(request.context?.identity)===canonical(response.identity)&&
    ['current','refreshed','blocked'].includes(response.status)&&typeof response.admission_allowed==='boolean'&&
    Object.keys(response).every(k=>['version','identity','status','not_after','admission_allowed','evidence_sha256'].includes(k)),
    'TRANSPORT_REFRESH_RESPONSE_INVALID');
  const expiresAt=response.not_after===null?null:Date.parse(response.not_after);
  requireThat(expiresAt===null||(Number.isFinite(expiresAt)&&expiresAt<=now+86400000),'TRANSPORT_REFRESH_EXPIRY_INVALID');
  const admissionAllowed=response.status!=='blocked'&&response.admission_allowed===true&&
    expiresAt>now+TRANSPORT_ADMISSION_MARGIN_MS&&/^[a-f0-9]{64}$/.test(response.evidence_sha256??'');
  return {admissionAllowed,expiresAt};
}
export async function replacePrivateJson(path,value){
  const tmp=`${path}.${randomUUID()}`;let f;
  try{f=await open(tmp,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);await f.writeFile(canonical(value));await f.sync();await f.close();f=null;await rename(tmp,path);}
  finally{if(f)await f.close();await unlink(tmp).catch(e=>{if(e.code!=='ENOENT')throw e;});}
}

// Reuse the issuer's private vault. A lost Delete acknowledgement authorizes
// only readback of this exact immutable version, never a second Delete.
async function deleteExactVersion({secretName,versionId,value,transport,registrationDirectory}){
  requireThat(registrationDirectory?.startsWith('/'),'SECRET_DELETE_VAULT_REQUIRED');
  await mkdir(registrationDirectory,{recursive:true,mode:0o700});
  const marker={secret_name:secretName,version_id:versionId,value_sha256:sha256(value)};
  const path=`${registrationDirectory}/ssm-delete-${sha256(canonical({secretName,versionId}))}.json`;
  let dispatched=false;
  try{const f=await open(path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
    try{await f.writeFile(canonical(marker));await f.sync();dispatched=true;}finally{await f.close();}
  }catch(error){if(error.code!=='EEXIST')throw error;
    requireThat(canonical(await readPrivateJson(path))===canonical(marker),'SECRET_DELETE_VAULT_DRIFT');}
  if(dispatched)try{await transport.call('ssm','DeleteSecretVersion',{SecretName:secretName,VersionId:versionId});}catch{}
  let absent=false;
  try{const r=await transport.call('ssm','GetSecretValue',{SecretName:secretName,VersionId:versionId});
    requireThat(r.SecretName===secretName&&r.VersionId===versionId&&r.SecretString===value,'SECRET_DELETE_READBACK_DRIFT');
  }catch(error){if(error.code==='ResourceNotFound'||error.code?.startsWith('ResourceNotFound.'))absent=true;else throw error;}
  requireThat(absent,'TLS_VERSION_DELETE_UNCONFIRMED');
}

/** New enrollment can retire a still-valid leaf only after an authoritative
 * old-epoch Stop, with no live/unknown reference. TTL alone is never authority.
 * One List + <=10*(Get, Delete, confirmation Get) stays within 31 SSM calls. */
export async function pruneRetiredNodeVersions({secretName,keep,scope,operations=[],nodes=[],transport,registrationDirectory,caSha256,now=Date.now}){
  const list=await transport.call('ssm','ListSecretVersionIds',{SecretName:secretName});
  requireThat(list.SecretName===secretName&&Array.isArray(list.Versions)&&list.Versions.length<=10&&
    list.Versions.every(v=>/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(v.VersionId??''))&&
    new Set(list.Versions.map(v=>v.VersionId)).size===list.Versions.length,'TLS_VERSION_INVENTORY');
  let remaining=list.Versions.length;
  for(const {VersionId:versionId} of list.Versions){
    if(keep.includes(versionId))continue;
    const r=await transport.call('ssm','GetSecretValue',{SecretName:secretName,VersionId:versionId});
    requireThat(r.SecretName===secretName&&r.VersionId===versionId&&typeof r.SecretString==='string'&&!r.SecretBinary,'TLS_VERSION_READBACK');
    let value;try{value=JSON.parse(r.SecretString);}catch{continue;}
    const identity=value?.identity;
    if(!identity||identity.account_id!==scope.account_id||identity.region!==scope.region||
      canonical(identity)===canonical(scope)||!identity.epoch)continue;
    // Recognize only versions bound to a recorded completed creation/start.
    // Unparseable, foreign and otherwise opaque secret values remain intact.
    const issued=operations.find(op=>['run','start'].includes(op.action)&&op.state==='completed'&&
      op.operation_id===value.operation_id&&canonical(op.identity)===canonical(identity)&&
      op.provider_request_id&&op.provider_request_id===value.provider_request_id&&
      op.request?.source_sha256===value.source_sha256&&op.request?.image_sha256===value.image_sha256&&
      op.request?.launch_manifest_sha256===value.launch_manifest_sha256);
    if(!issued||!(value.version==='execution-transport-envelope-v1'&&value.transport_credentials||
      value.version!=='execution-transport-envelope-v1'&&value.operation_completed===true&&value.operation_action===issued.action&&
      enrollmentVersionMatches(value,versionId)&&typeof value.registration_token==='string'&&
      Number.isFinite(value.expires_at)&&canonical(value.services)===canonical(issued.request.services)))continue;
    if(value.transport_credentials)try{validateTransportCredentials(value.transport_credentials,
      {...identity,operation_id:issued.operation_id,provider_request_id:issued.provider_request_id,ca_sha256:caSha256},
      {now,allowExpired:true});}catch{continue;}
    if(nodes.some(n=>n.state!=='stopped'&&canonical(n.identity)===canonical(identity))||
      operations.some(op=>['intent','submitted','unknown'].includes(op.state)&&
        op.identity?.account_id===identity.account_id&&op.identity?.region===identity.region&&
        op.identity?.instance_id===identity.instance_id))continue;
    const stopped=operations.some(op=>op.action==='stop'&&op.state==='completed'&&
      canonical(op.identity)===canonical(identity)&&op.provider_request_id&&
      executionCloudCompletionMatches(op,op.cloud_observation));
    if(!stopped)continue;
    await deleteExactVersion({secretName,versionId,value:r.SecretString,transport,registrationDirectory});
    remaining--;
  }
  requireThat(remaining<10,'SECRET_VERSION_CAPACITY');
}

/** Called by the existing ops tick. This is a credential vault, not a queue.
 * A published renewal is immutable and remains bound to the same cloud epoch. */
export async function pruneExpiredTransportVersions({secretName,keep,scope,stoppedIdentities=[],transport,registrationDirectory,now=Date.now}){
  const list=await transport.call('ssm','ListSecretVersionIds',{SecretName:secretName});
  requireThat(list.SecretName===secretName&&Array.isArray(list.Versions)&&list.Versions.length<=10,'TLS_VERSION_INVENTORY');
  for(const v of list.Versions){
    if(keep.includes(v.VersionId))continue;
    const r=await transport.call('ssm','GetSecretValue',{SecretName:secretName,VersionId:v.VersionId});
    requireThat(r.SecretName===secretName&&r.VersionId===v.VersionId&&typeof r.SecretString==='string','TLS_VERSION_READBACK');
    let value;try{value=JSON.parse(r.SecretString);}catch{continue;}
    if(value.identity?.account_id!==scope.account_id||value.identity?.region!==scope.region||!value.transport_credentials)continue;
    if(transportExpiry(value.transport_credentials)>=now())continue;
    // Expired TLS-only versions no longer authorize any fresh handshake and
    // deleting SSM bytes does not disturb established streams. Full enrollment
    // secrets additionally require the authoritative exact old-epoch Stop.
    if(value.version!=='execution-transport-envelope-v1'&&
      !(value.expires_at<now()&&stoppedIdentities.some(i=>canonical(i)===canonical(value.identity))))continue;
    await deleteExactVersion({secretName,versionId:v.VersionId,value:r.SecretString,transport,registrationDirectory});
  }
}
export async function renewNodeTransport({node,operation,slot,config,transport,stoppedIdentities=[],now=Date.now}){
  await mkdir(config.registration_directory,{recursive:true,mode:0o700});
  const path=`${config.registration_directory}/tls-${sha256(canonical(node.identity))}.lock`;
  const f=await open(path,constants.O_CREAT|constants.O_RDWR|constants.O_NOFOLLOW,0o600);
  try{
    const s=await f.stat();requireThat(s.isFile()&&s.uid===process.getuid()&&(s.mode&0o777)===0o600,'TLS_RENEWAL_LOCK_MODE');
    // flock is attached to the inherited open file description, retained by
    // this parent FD. Process exit releases it; no TTL or stale lock recovery.
    const code=await new Promise((resolve,reject)=>{const p=spawn('/usr/bin/flock',['--nonblock','3'],{stdio:['ignore','ignore','ignore',f.fd]});p.once('error',reject);p.once('close',resolve);});
    if(code===1)return false;requireThat(code===0,'TLS_RENEWAL_LOCK_FAILED');
    return await renewUnlocked({node,operation,slot,config,transport,stoppedIdentities,now});
  }finally{await f.close();}
}
async function renewUnlocked({node,operation,slot,config,transport,stoppedIdentities,now}){
  requireThat(['starting','ready','draining'].includes(node.state)&&operation.state==='completed'&&
    ['run','start'].includes(operation.action)&&canonical(operation.identity)===canonical(node.identity),'TLS_RENEWAL_SCOPE');
  const descriptor=config.node_secrets[slot];requireThat(descriptor?.pg_issuer,'TLS_RENEWAL_ISSUER_REQUIRED');
  const initial=await readPrivateJson(`${config.registration_directory}/${sha256(operation.operation_id)}.json`);
  requireThat(canonical(initial.identity)===canonical(node.identity)&&initial.provider_request_id===operation.provider_request_id,'TLS_RENEWAL_VAULT_SCOPE');
  const statePath=`${config.registration_directory}/tls-${sha256(canonical(node.identity))}.json`;
  let state;try{state=await readPrivateJson(statePath);}catch(e){if(e.code!=='ENOENT')throw e;}
  let active=state?.published?state.envelope.transport_credentials:initial.transport_credentials;
  requireThat(active,'TLS_RENEWAL_INITIAL_MISSING');
  if(!state||state.published){
    if(transportExpiry(active)-now()>TRANSPORT_RENEW_BEFORE_MS)return false;
    const version=`tls-${sha256(canonical(node.identity)).slice(0,24)}-${randomUUID().slice(0,8)}`;
    const proposed={version,dispatched:false,published:false,envelope:{version:'execution-transport-envelope-v1',
      identity:node.identity,source_sha256:operation.request.source_sha256,image_sha256:operation.request.image_sha256,
      launch_manifest_sha256:operation.request.launch_manifest_sha256,provider_request_id:operation.provider_request_id,operation_id:operation.operation_id,
      transport_credentials:await issueTransportCredentials(node.identity,descriptor.pg_issuer,{now,operation})}};
    await mkdir(config.registration_directory,{recursive:true,mode:0o700});
    // Concurrent issuers use the same durable version/payload winner.
    if(state)await replacePrivateJson(statePath,proposed);
    else{
      let f;try{f=await open(statePath,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);await f.writeFile(canonical(proposed));await f.sync();}
      catch(e){if(e.code!=='EEXIST')throw e;}finally{if(f)await f.close();}
    }
    state=await readPrivateJson(statePath);
  }
  requireThat(canonical(state.envelope.identity)===canonical(node.identity)&&state.envelope.provider_request_id===operation.provider_request_id,'TLS_RENEWAL_IDENTITY_DRIFT');
  const get=()=>transport.call('ssm','GetSecretValue',{SecretName:descriptor.secret_name,VersionId:state.version});
  const matches=r=>r.SecretName===descriptor.secret_name&&r.VersionId===state.version&&r.SecretString&&sha256(r.SecretString)===sha256(canonical(state.envelope));
  let found;try{found=await get();}catch(e){if(e.code!=='ResourceNotFound'&&!e.code?.startsWith('ResourceNotFound.'))throw e;}
  if(!found&&!state.dispatched){
    await pruneExpiredTransportVersions({secretName:descriptor.secret_name,keep:[operation.operation_id,state.version],scope:node.identity,stoppedIdentities,transport,registrationDirectory:config.registration_directory,now});
    state.dispatched=true;await replacePrivateJson(statePath,state); // fence before the uncertain publish
    try{await transport.call('ssm','PutSecretValue',{SecretName:descriptor.secret_name,VersionId:state.version,SecretString:canonical(state.envelope)});}catch{}
    found=await get();
  }
  requireThat(found&&matches(found),'TLS_RENEWAL_PUBLISH_UNKNOWN'); // no repeat Put after dispatch uncertainty
  state.published=true;await replacePrivateJson(statePath,state);return true;
}
