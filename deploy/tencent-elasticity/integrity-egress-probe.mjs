import {connect} from 'node:net';

// One connection, one absolute deadline, bounded header. Never log proxy bodies,
// credentials or issuer queries. CONNECT proves transport only, not a site query.
export function probeSocket({host,port,request=null,timeoutMs=4000,maxHeaderBytes=8192}) {
  return new Promise(resolve=>{
    const started=performance.now();let socket,timer,done=false,header=Buffer.alloc(0);
    const finish=(status,extra={})=>{
      if(done)return;done=true;clearTimeout(timer);socket?.destroy();
      resolve({status,...extra,elapsed_ms:Math.round(performance.now()-started)});
    };
    timer=setTimeout(()=>finish('timeout'),timeoutMs);
    try {
      socket=connect({host,port});
      socket.once('connect',()=>{if(request===null)finish('connected');else socket.write(request);});
      socket.on('data',chunk=>{
        const remaining=maxHeaderBytes-header.length;
        header=Buffer.concat([header,chunk.subarray(0,remaining)]);
        const end=header.indexOf('\r\n\r\n');
        if(end<0){if(chunk.length>=remaining)finish('header_too_large');return;}
        const match=/^HTTP\/1\.[01] ([0-9]{3})(?: [^\r\n]*)?\r\n/.exec(header.toString('latin1'));
        if(!match){finish('invalid_proxy_response');return;}
        const http_status=Number(match[1]);
        finish(http_status===200?'tunnel_established':'proxy_rejected',{http_status});
      });
      socket.once('error',error=>finish('connection_error',{code:/^[A-Z0-9_]+$/.test(error.code??'')?error.code:'UNKNOWN'}));
      socket.once('end',()=>finish('closed_without_response'));
      socket.once('close',()=>finish('closed_without_response'));
    }catch{finish('connection_error',{code:'INVALID_ENDPOINT'});}
  });
}

export async function inspectIntegrityEgress({probe=probeSocket,now=()=>new Date().toISOString()}={}) {
  const paths=[['database_transport',15432],['model_transport',15434],['integrity_transport',15435]];
  const transport=await Promise.all(paths.map(async([name,port])=>({name,host:'10.2.0.5',port,
    ...await probe({host:'10.2.0.5',port})})));
  const proxy={host:'172.28.61.1',port:15435,target:'www.sse.com.cn:443',
    ...await probe({host:'172.28.61.1',port:15435,
      request:'CONNECT www.sse.com.cn:443 HTTP/1.1\r\nHost: www.sse.com.cn:443\r\n\r\n'})};
  const reachable=transport.find(p=>p.name==='integrity_transport').status==='connected';
  return {version:'integrity-egress-diagnostic-v1',observed_at:now(),transport,proxy,
    transport_ready:reachable&&proxy.status==='tunnel_established',official_query_performed:false,
    fault_boundary:!reachable?'node_to_main_transport':proxy.status!=='tunnel_established'?'mtls_or_official_proxy':'not_observed',
    // TCP cannot identify whether a security group, NACL, firewall or listener caused failure.
    specific_network_rule_verified:false};
}

if(process.argv.includes('--run')) {
  const result=await inspectIntegrityEgress();console.log(JSON.stringify(result));
  if(!result.transport_ready)process.exitCode=1;
}
