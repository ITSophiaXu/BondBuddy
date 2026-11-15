import {EventEmitter} from 'node:events';
import {requireThat} from './policy.mjs';

/** Observe the native process acknowledgement, never raw vendor log content.
 * A successful configuration reload preserves established streams. */
export function createStunnelReloadController(child,{timeoutMs=5000}={}) {
  requireThat(child.stderr && timeoutMs>0 && timeoutMs<=10000,'STUNNEL_ACK_REQUIRED');
  const events=new EventEmitter();let generation=0,text='',busy=false;
  child.stderr.on('data',chunk=>{
    text+=chunk.toString();if(text.length>16384)text=text.slice(-16384);
    let end;while((end=text.indexOf('\n'))>=0){const line=text.slice(0,end);text=text.slice(end+1);
      if(/LOG5\[[^\]]+\]: Configuration successful\s*$/.test(line)){generation++;events.emit('configured');}
    }
  });
  function waitAfter(previous){
    return new Promise((resolve,reject)=>{
      const finish=error=>{clearTimeout(timer);events.off('configured',configured);child.off('close',closed);child.off('error',closed);error?reject(error):resolve();};
      const configured=()=>{if(generation>previous)finish();},closed=()=>finish(Error('STUNNEL_EXITED'));
      const timer=setTimeout(()=>finish(Error('STUNNEL_RELOAD_TIMEOUT')),timeoutMs);
      events.on('configured',configured);child.once('close',closed);child.once('error',closed);configured();
    });
  }
  return {
    ready:()=>waitAfter(0),
    async reload(cert_sha256){
      requireThat(!busy&&child.exitCode===null&&/^[a-f0-9]{64}$/.test(cert_sha256),'TRANSPORT_RELOAD_FAILED');
      busy=true;try{
        const previous=generation,pending=waitAfter(previous);
        if(!child.kill('SIGHUP'))events.emit('configured');
        await pending;return {cert_sha256};
      }finally{busy=false;}
    }
  };
}
