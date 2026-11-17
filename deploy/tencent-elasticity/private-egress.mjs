import {requireThat} from './policy.mjs';

export const EXECUTION_NO_PROXY='localhost,127.0.0.1,169.254.0.23,metadata.tencentyun.com,172.28.61.1,10.2.0.5';
// Separate from the model proxy: terminate at the existing official-only egress.
export const INTEGRITY_TRANSPORT_SECTION='\n[execution-integrity]\nclient = yes\naccept = 172.28.61.1:15435\nconnect = 10.2.0.5:15435\nverifyChain = yes\ncheckHost = proxy-execution.internal\nsni = proxy-execution.internal\nCAfile = /etc/bondbuddy/transport/ca.pem\ncert = /etc/bondbuddy/transport/client.pem\nkey = /etc/bondbuddy/transport/client.key\n';
export function renderPrivateTransportConfig(config){
  const pg=config.private_pg,proxy=config.private_proxy;
  requireThat(pg?.local_host==='172.28.61.1'&&pg.local_port===15433&&pg.remote_host==='10.2.0.5'&&pg.remote_port===15432&&
    pg.sni==='pg-execution.internal'&&pg.ca_file==='/etc/bondbuddy/transport/ca.pem'&&
    pg.cert_file==='/etc/bondbuddy/transport/client.pem'&&pg.key_file==='/etc/bondbuddy/transport/client.key','NODE_PG_NETWORK_SCOPE');
  requireThat(proxy?.local_host===pg.local_host&&proxy.local_port===15434&&proxy.remote_host===pg.remote_host&&
    proxy.remote_port===15434&&proxy.sni==='proxy-execution.internal','NODE_PROXY_NETWORK_SCOPE');
  const section=(name,host,port,remote,rport,sni)=>`[${name}]\nclient = yes\naccept = ${host}:${port}\nconnect = ${remote}:${rport}\nverifyChain = yes\ncheckHost = ${sni}\nsni = ${sni}\nCAfile = ${pg.ca_file}\ncert = ${pg.cert_file}\nkey = ${pg.key_file}\n`;
  return 'foreground = yes\npid =\ndebug = notice\noutput = /dev/null\n'+
    section('execution-pg',pg.local_host,pg.local_port,pg.remote_host,pg.remote_port,pg.sni)+'\n'+
    section('execution-proxy',proxy.local_host,proxy.local_port,proxy.remote_host,proxy.remote_port,proxy.sni)+INTEGRITY_TRANSPORT_SECTION;
}
