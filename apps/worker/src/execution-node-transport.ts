import {createConnection,type Socket} from 'node:net';
import {isAbsolute} from 'node:path';
import {Value} from '@sinclair/typebox/value';
import {ExecutionNodeContextSchema,type ExecutionNodeContext} from '@bondbuddy/contracts';

export interface ExecutionTransportHealth {
  refresh():Promise<void>;
  ready():boolean;
  close():void;
}
export type ExecutionTransportProtocol = {
  TRANSPORT_REFRESH_VERSION:string;
  TRANSPORT_ADMISSION_MARGIN_MS:number;
  validateTransportRefreshResponse(request:unknown,response:unknown,now:number):{admissionAllowed:boolean;expiresAt:number|null};
};
const failed=()=>new Error('EXECUTION_TRANSPORT_REFRESH_FAILED');

/** The private protocol/response validator is supplied by the transport module.
 * Only non-secret context is sent; certificate and credential bytes never enter
 * this process or its model invocation. */
export function createExecutionTransportClient({socketPath,context,serviceId,protocol,timeoutMs=20000,now=Date.now}:{
  socketPath:string;context:ExecutionNodeContext;serviceId:string;protocol:ExecutionTransportProtocol;timeoutMs?:number;now?:()=>number;
}):ExecutionTransportHealth {
  if(!isAbsolute(socketPath)||!Value.Check(ExecutionNodeContextSchema,context)||!/^[A-Za-z0-9_-]{1,64}$/.test(serviceId)
   ||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>20000||typeof protocol.TRANSPORT_REFRESH_VERSION!=='string'
   ||typeof protocol.validateTransportRefreshResponse!=='function'||!Number.isSafeInteger(protocol.TRANSPORT_ADMISSION_MARGIN_MS)
   ||protocol.TRANSPORT_ADMISSION_MARGIN_MS<1)throw Error('EXECUTION_TRANSPORT_CONFIG_INVALID');
  const request={version:protocol.TRANSPORT_REFRESH_VERSION,context:JSON.parse(JSON.stringify(context)),service_id:serviceId};
  const bytes=Buffer.from(JSON.stringify(request)+'\n');if(bytes.length>4096)throw Error('EXECUTION_TRANSPORT_CONFIG_INVALID');
  let closed=false,flight:Promise<void>|null=null,active:Socket|null=null,decision:{admissionAllowed:boolean;expiresAt:number|null}|null=null;
  const exchange=()=>new Promise<unknown>((resolve,reject)=>{
    const socket=createConnection(socketPath);active=socket;
    const chunks:Buffer[]=[];let length=0,settled=false;
    const finish=(error?:Error,value?:unknown)=>{
      if(settled)return;settled=true;clearTimeout(timer);if(active===socket)active=null;socket.destroy();
      if(error)reject(failed());else resolve(value);
    };
    // Absolute request deadline, not an inactivity timeout that a trickling
    // response could extend. The existing runtime heartbeat never awaits it.
    const timer=setTimeout(()=>finish(failed()),timeoutMs);
    socket.once('connect',()=>socket.write(bytes));
    socket.on('data',chunk=>{length+=chunk.length;if(length>4096)finish(failed());else chunks.push(chunk);});
    socket.once('end',()=>{try{const text=Buffer.concat(chunks).toString('utf8');if(!text.endsWith('\n'))throw failed();finish(undefined,JSON.parse(text.slice(0,-1)));}catch{finish(failed());}});
    socket.once('error',()=>finish(failed()));socket.once('close',()=>{if(!settled)finish(failed());});
  });
  return {
    refresh(){
      if(closed)return Promise.resolve();if(flight)return flight;
      // Occupy before any socket/validator await, so independent callers share
      // exactly one request and cannot race a blocked response against a success.
      const work=Promise.resolve().then(async()=>{
        try{const response=await exchange();const validated=protocol.validateTransportRefreshResponse(request,response,now());
          if(closed)return;decision={...validated};
        }catch{decision=null;throw failed();}
      });
      flight=work;void work.finally(()=>{if(flight===work)flight=null;}).catch(()=>{});return work;
    },
    ready(){const at=now();return !closed&&Number.isSafeInteger(at)&&!!decision?.admissionAllowed
      &&decision.expiresAt!==null&&Number.isSafeInteger(decision.expiresAt)&&decision.expiresAt>at+protocol.TRANSPORT_ADMISSION_MARGIN_MS;},
    close(){closed=true;decision=null;active?.destroy(failed());},
  };
}

/** Legacy processes have no enrollment or transport socket. Managed entrypoints
 * must configure the exact private socket; missing material fails at startup. */
export async function executionTransportFromEnv(enrollment:{context:ExecutionNodeContext;service_id:string}|undefined,
  env:NodeJS.ProcessEnv=process.env):Promise<ExecutionTransportHealth|undefined>{
  const socketPath=env.BB_EXECUTION_TRANSPORT_SOCKET;
  if(!enrollment){if(socketPath)throw Error('EXECUTION_TRANSPORT_ENROLLMENT_REQUIRED');return;}
  if(socketPath!=='/run/bondbuddy/service/transport.sock')throw Error('EXECUTION_TRANSPORT_SOCKET_REQUIRED');
  const moduleUrl=new URL('../../../deploy/tencent-elasticity/transport-renewal.mjs',import.meta.url).href;
  let protocol:ExecutionTransportProtocol;
  try{protocol=await import(moduleUrl) as ExecutionTransportProtocol;}catch{throw Error('EXECUTION_TRANSPORT_PROTOCOL_UNAVAILABLE');}
  return createExecutionTransportClient({socketPath,context:enrollment.context,serviceId:enrollment.service_id,protocol});
}
