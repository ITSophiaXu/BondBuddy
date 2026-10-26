import {createServer,request as httpRequest} from 'node:http';
import {connect,isIP,type Socket} from 'node:net';
import {lookup} from 'node:dns/promises';
import type {IntegritySite} from '@bondbuddy/contracts';

// Both local and upstream proxies must outlive the browser's 90-second response wait.
export const INTEGRITY_NETWORK_IDLE_MS=120000;
const searchProviderHost=(site:IntegritySite,host:string)=>['transport','agriculture','official-directory'].includes(site.id)&&['p.so-gov.cn','file.so-gov.cn','api.so-gov.cn'].includes(host);
const providerTenant=(site:IntegritySite,path:string)=>{
 const mot=/^\/custom\/(?:bm19000004_zck|BM19000004)\//.test(path)||path==='/cps/pro/bm19000004/css/govSearchPc.css';
 const moa=/^\/custom\/(?:bm21000007|bm21000007zw)\//.test(path)||/^\/cps\/pro\/(?:bgt_moa|bm21000007)\//.test(path);
 return site.id==='transport'?mot:site.id==='agriculture'?moa:site.id==='official-directory'&&(mot||moa);
};

// Pin the validated public IPv4 address at the TCP connection, including CONNECT.
// A request interceptor alone cannot prevent DNS rebinding between validation and Chromium DNS.
export function publicIntegrityAddress(ip:string){
 if(isIP(ip)!==4)return false;
 const [a,b,c]=ip.split('.').map(Number);
 return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&(b===168||b===0||b===2)||a===100&&b>=64&&b<=127||a===198&&(b===18||b===19||b===51&&c===100)||a===203&&b===0&&c===113);
}
export function integrityBrowserUrlAllowed(site:IntegritySite,value:string){
 try{
  const u=new URL(value);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.port||isIP(u.hostname))return false;
  // MOT/MOA official search pages use these observed provider resources. Restrict
  // them to this site and exact API/tenant paths; no assistant or feedback APIs.
  if(searchProviderHost(site,u.hostname)&&u.protocol==='https:'){
   if(u.hostname==='p.so-gov.cn'&&(/^\/web\//.test(u.pathname)||providerTenant(site,u.pathname)||['/common/js/ieTips.js','/pc/js/marked.min.js'].includes(u.pathname))&&/\.(?:js|css|woff2?|png|jpe?g|svg)$/.test(u.pathname))return true;
   if(u.hostname==='file.so-gov.cn'&&providerTenant(site,u.pathname)&&/\.(?:css|png|jpe?g|svg)$/.test(u.pathname))return true;
   if(u.hostname==='api.so-gov.cn'&&u.pathname==='/query/s')return true;
  }
  return site.links.some(l=>{const host=new URL(l.url).hostname.toLowerCase(),root=host.replace(/^www\./,'');return u.hostname===host||u.hostname===root||u.hostname.endsWith('.'+root);});
 }catch{return false;}
}
export async function integrityProxy(site:IntegritySite,options:{upstreamUrl?:string;host?:string;port?:number}={}){
 const upstreamProxy=options.upstreamUrl?new URL(options.upstreamUrl):undefined;
 if(upstreamProxy&&(upstreamProxy.protocol!=='http:'||upstreamProxy.username||upstreamProxy.password||upstreamProxy.pathname!=='/'||upstreamProxy.search||upstreamProxy.hash))throw Error('INVALID_INTEGRITY_EGRESS_PROXY');
 const sockets=new Set<Socket>();
 const watch=(socket:Socket)=>{if(sockets.has(socket))return socket;sockets.add(socket);socket.once('close',()=>sockets.delete(socket));socket.on('error',()=>{});socket.setTimeout(INTEGRITY_NETWORK_IDLE_MS,()=>socket.destroy());return socket;};
 async function target(value:string,staticTunnel=false){
  if(!integrityBrowserUrlAllowed(site,value)&&!(staticTunnel&&searchProviderHost(site,new URL(value).hostname)))throw Error('OFFICIAL_HOST_REQUIRED');
  const url=new URL(value),answers=await lookup(url.hostname,{family:4,all:true});
  if(!answers.length||answers.some(a=>!publicIntegrityAddress(a.address)))throw Error('PUBLIC_ADDRESS_REQUIRED');
  return {url,address:answers[0].address};
 }
 const server=createServer((req,res)=>{void (async()=>{
  if(!integrityBrowserUrlAllowed(site,req.url??''))throw Error('OFFICIAL_HOST_REQUIRED');
  const {url,address}=upstreamProxy?{url:new URL(req.url!),address:upstreamProxy.hostname}:await target(req.url??'');if(url.protocol!=='http:')throw Error('INVALID_PROXY_REQUEST');
  const headers:import('node:http').OutgoingHttpHeaders={...req.headers,host:url.host};delete headers['proxy-authorization'];delete headers['proxy-connection'];
  const upstream=httpRequest({host:address,port:upstreamProxy?Number(upstreamProxy.port||80):80,method:req.method,path:upstreamProxy?url.href:url.pathname+url.search,headers,timeout:INTEGRITY_NETWORK_IDLE_MS},r=>{res.writeHead(r.statusCode??502,r.headers);r.pipe(res);});
  upstream.on('socket',s=>watch(s));upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});upstream.on('timeout',()=>upstream.destroy());req.pipe(upstream);
 })().catch(()=>{res.writeHead(403);res.end('Official website request unavailable');});});
 server.on('connection',watch);
 server.on('connect',(req,client,head)=>{void (async()=>{
  if(!req.url?.endsWith(':443'))throw Error('HTTPS_REQUIRED');
  const tunnelUrl='https://'+req.url.slice(0,-4)+'/',staticAsset=searchProviderHost(site,new URL(tunnelUrl).hostname);
  if(!integrityBrowserUrlAllowed(site,tunnelUrl)&&!staticAsset)throw Error('OFFICIAL_HOST_REQUIRED');
  // Both layers recognize these dependencies. Keep all requests on the configured
  // upstream; a private-network worker must never attempt a direct fallback.
  // The browser interceptor restricts encrypted provider requests to paths above.
  if(upstreamProxy){
   const request=httpRequest({host:upstreamProxy.hostname,port:Number(upstreamProxy.port||80),method:'CONNECT',path:req.url,headers:{host:req.url},timeout:INTEGRITY_NETWORK_IDLE_MS});
   request.on('connect',(response,socket,buffer)=>{watch(socket);if(response.statusCode!==200){socket.destroy();client.end('HTTP/1.1 403 Forbidden\r\n\r\n');return;}client.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(buffer.length)client.write(buffer);if(head.length)socket.write(head);client.pipe(socket);socket.pipe(client);client.on('close',()=>socket.destroy());});
   request.on('error',()=>client.destroy());request.on('timeout',()=>request.destroy());request.end();return;
  }
  const {address}=await target(tunnelUrl,staticAsset);
  const upstream=watch(connect(443,address));
  upstream.once('connect',()=>{client.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);client.pipe(upstream);upstream.pipe(client);});
  upstream.on('error',()=>client.destroy());client.on('close',()=>upstream.destroy());
 })().catch(()=>client.end('HTTP/1.1 403 Forbidden\r\n\r\n'));});
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(options.port??0,options.host??'127.0.0.1',resolve);});
 const port=(server.address() as {port:number}).port;
 return {server:`http://127.0.0.1:${port}`,close:async()=>{sockets.forEach(s=>s.destroy());await new Promise<void>(resolve=>server.close(()=>resolve()));}};
}
