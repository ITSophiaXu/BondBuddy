import {canonical,sha256,requireThat} from './policy.mjs';
import {validateTransportCredentials} from './private-transport.mjs';
import {TRANSPORT_REFRESH_VERSION,TRANSPORT_RENEW_BEFORE_MS,TRANSPORT_ADMISSION_MARGIN_MS,transportExpiry} from './transport-renewal.mjs';

export function validateTransportLifecycleProof(proof,config){
  const checks=['same_epoch_tls_reload','old_session_continues','fresh_pg_identity','runtime_failed_refresh_fences_claims','model_socket_denied'];
  requireThat(proof?.version==='execution-transport-renewal-proof-v1'&&proof.verdict==='pass'&&
    proof.source_sha256===config.source_sha256&&proof.image_sha256===config.image_sha256&&
    checks.every(k=>/^[a-f0-9]{64}$/.test(proof.checks?.[k]??'')),'TRANSPORT_RENEWAL_PROOF_REQUIRED');
}

/** Valid overlapping renewals use the unique greatest signed expiry. Array
 * order and SSM CreateTime are not authority; equal winners fail closed. */
export function selectTransportRenewalVersion(versions,state,config,active,{now=Date.now}={}) {
  const expected={...state.identity,operation_id:state.operation_id,provider_request_id:state.provider_request_id,ca_sha256:config.private_pg.ca_sha256};
  validateTransportCredentials(active,expected,{now,allowExpired:true});
  const expiry=transportExpiry(active),candidates=[];
  for(const {value:next} of versions){
    if(next?.version!=='execution-transport-envelope-v1'||canonical(next.identity)!==canonical(state.identity)||
      next.operation_id!==state.operation_id||next.provider_request_id!==state.provider_request_id||
      next.source_sha256!==state.source_sha256||next.image_sha256!==state.image_sha256||next.launch_manifest_sha256!==state.launch_manifest_sha256)continue;
    try{validateTransportCredentials(next.transport_credentials,expected,{now,allowExpired:true});}catch{continue;}
    const notAfter=transportExpiry(next.transport_credentials);
    if(notAfter>expiry&&notAfter>now()+60000)candidates.push({next,notAfter});
  }
  requireThat(candidates.length>0,'TRANSPORT_RENEWAL_PENDING');
  const greatest=Math.max(...candidates.map(c=>c.notAfter)),winners=candidates.filter(c=>c.notAfter===greatest);
  requireThat(winners.length===1,'TRANSPORT_RENEWAL_AMBIGUOUS');
  return winners[0].next;
}

/** Driven only by the runtime's existing heartbeat. No renewal timer or queue.
 * reload must preserve established streams; probe verifies fresh PG sessions. */
export function createTransportRefresher({config,state,readActive,broker,install,reload,probe,reserveBroker=async()=>()=>{},now=Date.now}) {
  let busy=false,retryAt=0,lastFailed=false,verifiedHash;
  const answer=(status,expiry,allowed,evidence=null)=>({version:TRANSPORT_REFRESH_VERSION,identity:state.identity,
    status,not_after:Number.isFinite(expiry)?new Date(expiry).toISOString():null,admission_allowed:allowed,evidence_sha256:evidence});
  return {async refresh(request){
    requireThat(request?.version===TRANSPORT_REFRESH_VERSION&&canonical(request.context?.identity)===canonical(state.identity)&&
      /^[a-f0-9-]{36}$/.test(request.context?.session_id??'')&&config.services.some(s=>s.service_id===request.service_id),'TRANSPORT_REQUEST_SCOPE');
    if(busy)return answer('blocked',NaN,false);
    busy=true; // acquire before the first await, including the active-file read
    let expiry=NaN;
    try{
      const old=await readActive();expiry=transportExpiry(old);
      const expected={...state.identity,operation_id:state.operation_id,provider_request_id:state.provider_request_id,ca_sha256:config.private_pg.ca_sha256};
      // Old expiry fences admission, but cannot prevent retrieval of a valid
      // replacement after an outage. Identity/signature/key pins still hold.
      validateTransportCredentials(old,expected,{now,allowExpired:true});
      const activeHash=sha256(old.cert_pem);
      // Never infer the in-memory leaf from the disk. After a failed reload or
      // process restart, confirm the native configuration reload and then PG.
      if(activeHash!==verifiedHash&&expiry>now()+60000){
        if(now()<retryAt)return answer('blocked',expiry,false);
        try {
          const receipt=await reload(activeHash);
          requireThat(receipt?.cert_sha256===activeHash,'TRANSPORT_RELOAD_UNCONFIRMED');
          await probe();verifiedHash=activeHash;lastFailed=false;
        } catch(error){retryAt=now()+60000;throw error;}
      }
      if(expiry-now()>TRANSPORT_RENEW_BEFORE_MS)return answer('current',expiry,true,activeHash);
      if(now()<retryAt)return answer(lastFailed?'blocked':'current',expiry,!lastFailed&&activeHash===verifiedHash&&expiry-now()>TRANSPORT_ADMISSION_MARGIN_MS,activeHash);
      retryAt=now()+60000;
      const releaseBroker=await reserveBroker();
      if(!releaseBroker)return answer('blocked',expiry,false);
      let next;try{next=await broker();}finally{await releaseBroker();}
      requireThat(next?.version==='execution-transport-envelope-v1'&&canonical(next.identity)===canonical(state.identity)&&
        next.provider_request_id===state.provider_request_id&&next.source_sha256===state.source_sha256&&
        next.image_sha256===state.image_sha256&&next.launch_manifest_sha256===state.launch_manifest_sha256&&
        (!state.operation_id||next.operation_id===state.operation_id),'TRANSPORT_RENEWAL_BINDING');
      const c=next.transport_credentials;
      validateTransportCredentials(c,expected,{now});requireThat(transportExpiry(c)>expiry,'TRANSPORT_RENEWAL_NOT_NEWER');
      await install(c);const nextHash=sha256(c.cert_pem),receipt=await reload(nextHash);
      requireThat(receipt?.cert_sha256===nextHash,'TRANSPORT_RELOAD_UNCONFIRMED');await probe();
      lastFailed=false;verifiedHash=nextHash;return answer('refreshed',transportExpiry(c),transportExpiry(c)-now()>TRANSPORT_ADMISSION_MARGIN_MS,verifiedHash);
    }catch{
      lastFailed=true;return answer('blocked',expiry,false); // never kill holders or restart consumers
    }finally{busy=false;}
  }};
}
