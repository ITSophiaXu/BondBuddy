import net from 'node:net';
import {lstat} from 'node:fs/promises';
import {canonical,requireThat} from './policy.mjs';

/** Only the reviewed local authority socket; no remote URL or credential file.
 * Results stay in memory and never enter a model, CLI output or vendor log. */
export async function privateControlRequest(path,request,{timeoutMs=20000}={}) {
  requireThat(path==='/run/bondbuddy/elastic-control/issuer.sock'&&timeoutMs>0&&timeoutMs<=20000,'CONTROL_SOCKET_SCOPE');
  const parent=await lstat('/run/bondbuddy/elastic-control'),socket=await lstat(path);
  requireThat(parent.isDirectory()&&!parent.isSymbolicLink()&&parent.uid===0&&parent.gid===1000&&(parent.mode&0o777)===0o750&&
    socket.isSocket()&&socket.uid===0&&socket.gid===1000&&(socket.mode&0o777)===0o660,'CONTROL_SOCKET_PERMISSIONS');
  const input=canonical(request);requireThat(Buffer.byteLength(input)<=8192,'CONTROL_REQUEST_BOUND');
  return new Promise((resolve,reject)=>{
    const c=net.connect(path);let bytes=0,text='',done=false;
    const finish=(error,value)=>{if(done)return;done=true;c.destroy();error?reject(Error('CONTROL_AUTHORITY_UNAVAILABLE')):resolve(value);};
    c.setTimeout(timeoutMs,()=>finish(true));c.once('error',()=>finish(true));c.once('connect',()=>c.write(input+'\n'));
    c.on('data',chunk=>{bytes+=chunk.length;if(bytes>65536)return finish(true);text+=chunk.toString();
      if(text.endsWith('\n'))try{const value=JSON.parse(text);requireThat(value?.status!=='blocked','CONTROL_AUTHORITY_BLOCKED');finish(false,value);}catch{finish(true);}
    });c.once('end',()=>{if(!done)finish(true);});
  });
}

export function createSocketCredentialProvider(config){
  return {async get(){
    const result=await privateControlRequest(config.socket,{version:'execution-control-credentials-v1',account_id:config.accountId,role_id:config.roleId});
    requireThat(result?.version==='execution-control-credentials-v1'&&result.account_id===config.accountId&&result.role_id===config.roleId&&
      result.credentials?.token&&result.credentials.expiresAt>Date.now()+60000,'CONTROL_SHORT_CREDENTIAL_REQUIRED');
    return result.credentials;
  }};
}
