import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {probeSocket,inspectIntegrityEgress} from './integrity-egress-probe.mjs';

async function server(t,handler){
  const sockets=new Set();const s=createServer(c=>{sockets.add(c);c.on('error',()=>{});c.once('close',()=>sockets.delete(c));handler(c);});
  await new Promise(resolve=>s.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{for(const c of sockets)c.destroy();await new Promise(resolve=>s.close(resolve));});
  return {host:'127.0.0.1',port:s.address().port};
}
const request='CONNECT www.sse.com.cn:443 HTTP/1.1\r\nHost: www.sse.com.cn:443\r\n\r\n';

test('CONNECT handles split headers, closes the tunnel and never emits response body',async t=>{
  const endpoint=await server(t,c=>c.once('data',bytes=>{
    assert.equal(bytes.toString(),request);c.write('HTTP/1.1 200 Con');
    setImmediate(()=>c.end('nection established\r\n\r\nprivate-response-body'));
  }));
  const r=await probeSocket({...endpoint,request});assert.equal(r.status,'tunnel_established');
  assert.equal(r.http_status,200);assert.ok(!JSON.stringify(r).includes('private-response-body'));
});
test('502 is a proxy failure even though TCP connected',async t=>{
  const endpoint=await server(t,c=>c.once('data',()=>c.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')));
  assert.equal((await probeSocket(endpoint)).status,'connected');
  const r=await probeSocket({...endpoint,request});assert.equal(r.status,'proxy_rejected');assert.equal(r.http_status,502);
});
test('silent accepted connections have an absolute deadline',async t=>{
  const endpoint=await server(t,()=>{});const r=await probeSocket({...endpoint,request,timeoutMs:100});
  assert.equal(r.status,'timeout');assert.ok(r.elapsed_ms<2000);
});
test('unbounded/malformed/early-close proxy replies fail closed',async t=>{
  for(const [reply,status] of [['x'.repeat(100),'header_too_large'],['garbage\r\n\r\n','invalid_proxy_response'],['','closed_without_response']]){
    const endpoint=await server(t,c=>c.once('data',()=>c.end(reply)));
    assert.equal((await probeSocket({...endpoint,request,maxHeaderBytes:64})).status,status);
  }
});
test('a closed port reports a bounded transport error',async t=>{
  const s=createServer();await new Promise(resolve=>s.listen(0,'127.0.0.1',resolve));const port=s.address().port;
  await new Promise(resolve=>s.close(resolve));
  assert.equal((await probeSocket({host:'127.0.0.1',port})).status,'connection_error');
});
test('host: 15432/15434 success cannot mask 15435 timeout or assert a security group root cause',async()=>{
  const calls=[];const r=await inspectIntegrityEgress({scope:'host',probe:async o=>{calls.push(o);return {status:o.port===15435?'timeout':'connected'};}});
  assert.equal(r.network_scope,'host');assert.equal(r.transport_ready,false);assert.equal(r.fault_boundary,'node_to_main_transport');
  assert.equal(r.specific_network_rule_verified,false);assert.equal(r.official_query_performed,false);assert.equal(r.proxy,null);
  assert.deepEqual(calls.map(c=>[c.host,c.port]),[['10.2.0.5',15432],['10.2.0.5',15434],['10.2.0.5',15435]]);
});
test('host transport success does not claim container proxy or website acceptance',async()=>{
  const r=await inspectIntegrityEgress({scope:'host',probe:async o=>{assert.equal(o.request,undefined);return {status:'connected'};}});
  assert.equal(r.transport_ready,true);assert.equal(r.proxy,null);assert.equal(r.official_query_performed,false);
});
test('isolated container uses only the bridge proxy and does not require a forbidden direct route',async()=>{
  const calls=[];const r=await inspectIntegrityEgress({probe:async o=>{calls.push(o);
    return {status:o.host==='172.28.61.1'?'tunnel_established':'connection_error',code:'ENETUNREACH'};}});
  assert.equal(r.network_scope,'container');assert.deepEqual(r.transport,[]);assert.equal(r.transport_ready,true);
  assert.equal(r.official_query_performed,false);assert.equal(r.specific_network_rule_verified,false);
  assert.deepEqual(calls.map(c=>[c.host,c.port,c.request]),[['172.28.61.1',15435,request]]);
});
test('container proxy timeout or rejection stays a failure without guessing the underlying layer',async()=>{
  for(const status of ['timeout','proxy_rejected']){
    const r=await inspectIntegrityEgress({scope:'container',probe:async()=>({status})});
    assert.equal(r.transport_ready,false);assert.equal(r.fault_boundary,'container_to_official_proxy');
  }
});
test('unknown network scope is rejected before making any connections',async()=>{
  await assert.rejects(inspectIntegrityEgress({scope:'both',probe:async()=>assert.fail('unexpected connection')}),/INVALID_NETWORK_SCOPE/);
});
